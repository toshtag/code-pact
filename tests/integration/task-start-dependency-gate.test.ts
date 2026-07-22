// P82-T1 integration: task start rejects incomplete declared dependencies
// before any progress event or contract lock, then succeeds once the
// dependency is recorded as done.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  createTempProject,
  ensureCliBuilt,
  expectJsonErr,
  expectJsonOk,
} from "../helpers/cli.ts";

type Project = Awaited<ReturnType<typeof createTempProject>>;

let cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

afterEach(async () => {
  await Promise.all(cleanups.map(c => c()));
  cleanups = [];
});

async function projectWithDependentTask(prefix: string): Promise<Project> {
  const p = await createTempProject({
    prefix: `code-pact-task-start-dep-gate-${prefix}-`,
    init: [
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--sample-phase",
      "--json",
    ],
  });
  cleanups.push(p.cleanup);

  // Add P1-T1 (dependency) and P1-T2 (depends on P1-T1) to the sample phase.
  const phasePath = join(
    p.dir,
    "design",
    "phases",
    "TUTORIAL-walkthrough.yaml",
  );
  const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<
    string,
    unknown
  >;
  const baseTask = {
    type: "feature",
    ambiguity: "low",
    risk: "low",
    context_size: "small",
    write_surface: "low",
    verification_strength: "weak",
    expected_duration: "short",
    status: "planned",
  };
  (doc as { tasks: unknown[] }).tasks = [
    {
      id: "P1-T1",
      ...baseTask,
      description: "dependency task",
    },
    {
      id: "P1-T2",
      ...baseTask,
      description: "dependent task",
      depends_on: ["P1-T1"],
    },
  ];
  await writeFile(phasePath, stringifyYaml(doc), "utf8");

  // The tasks are new, so no lock exists yet. Re-run plan normalize/adopt
  // is unnecessary for this test; we just need the phase on disk.
  // Commit the edited phase so task start does not fail on a dirty tree.
  execSync("git init", { cwd: p.dir, stdio: "ignore" });
  execSync("git config user.email test@example.com", {
    cwd: p.dir,
    stdio: "ignore",
  });
  execSync("git config user.name Test", { cwd: p.dir, stdio: "ignore" });
  execSync("git add .", { cwd: p.dir, stdio: "ignore" });
  execSync("git commit -m add-tasks", { cwd: p.dir, stdio: "ignore" });
  return p;
}

function lockPath(p: Project, taskId: string): string {
  return join(p.dir, ".code-pact", "state", "locks", `${taskId}.yaml`);
}

async function pathExists(path: string): Promise<boolean> {
  return readFile(path, "utf8").then(
    () => true,
    () => false,
  );
}

async function listEventFiles(dir: string): Promise<string[]> {
  const eventsDir = join(dir, ".code-pact", "state", "events");
  try {
    return (await readdir(eventsDir)).sort();
  } catch {
    return [];
  }
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function gitStatus(cwd: string): string {
  return execSync("git status --porcelain=v1 -z", {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

type ProjectState = {
  eventFiles: string[];
  progressYaml: string;
  phaseYaml: string;
  gitStatus: string;
  lockExists: boolean;
};

async function captureProjectState(p: Project): Promise<ProjectState> {
  const phasePath = join(
    p.dir,
    "design",
    "phases",
    "TUTORIAL-walkthrough.yaml",
  );
  return {
    eventFiles: await listEventFiles(p.dir),
    progressYaml: await readFileOrEmpty(
      join(p.dir, ".code-pact", "state", "progress.yaml"),
    ),
    phaseYaml: await readFileOrEmpty(phasePath),
    gitStatus: gitStatus(p.dir),
    lockExists: await pathExists(lockPath(p, "P1-T2")),
  };
}

describe("task start dependency gate", () => {
  it("rejects start when a declared dependency is not done", async () => {
    const p = await projectWithDependentTask("reject");
    const before = await captureProjectState(p);

    const res = p.run([
      "task",
      "start",
      "P1-T2",
      "--agent",
      "claude-code",
      "--json",
    ]);
    const after = await captureProjectState(p);

    expect(res.code).toBe(2);
    expect(res.stderr).toBe("");
    const parsed = expectJsonErr(res, "TASK_DEPENDENCY_INCOMPLETE");
    expect((parsed.data as { deps?: string[] }).deps).toEqual(["P1-T1"]);
    expect(parsed.error.message).toContain(
      "No contract lock or progress event was recorded.",
    );
    expect(after.lockExists).toBe(false);
    expect(after.eventFiles).toEqual(before.eventFiles);
    expect(after.progressYaml).toBe(before.progressYaml);
    expect(after.phaseYaml).toBe(before.phaseYaml);
    expect(after.gitStatus).toBe(before.gitStatus);
  });

  it("writes no contract lock on rejection", async () => {
    const p = await projectWithDependentTask("no-side-effects");
    p.run(["task", "start", "P1-T2", "--agent", "claude-code", "--json"]);

    expect(await pathExists(lockPath(p, "P1-T2"))).toBe(false);
  });

  it("allows start on the first attempt after the dependency is done (replay)", async () => {
    const p = await projectWithDependentTask("replay");

    const first = p.run([
      "task",
      "start",
      "P1-T2",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(first.code).toBe(2);
    expectJsonErr(first, "TASK_DEPENDENCY_INCOMPLETE");

    const depStart = p.run([
      "task",
      "start",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(depStart.code).toBe(0);
    expectJsonOk(depStart);

    const record = p.run([
      "task",
      "record-done",
      "P1-T1",
      "--evidence",
      "dependency completed",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(record.code).toBe(0);
    expectJsonOk(record);

    // Progress events are written as untracked files; commit them so the
    // contract-lock check for the dependent task sees a clean tree.
    execSync("git add .", { cwd: p.dir, stdio: "ignore" });
    execSync("git commit -m done", { cwd: p.dir, stdio: "ignore" });

    const second = p.run([
      "task",
      "start",
      "P1-T2",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(second.code).toBe(0);
    const parsed = expectJsonOk<{ event: { task_id: string; status: string } }>(
      second,
    );
    expect(parsed.data.event.task_id).toBe("P1-T2");
    expect(parsed.data.event.status).toBe("started");
  });

  it("human mode emits the side-effect-free message to stderr and exits 2", async () => {
    const p = await projectWithDependentTask("human");
    const res = p.run(["task", "start", "P1-T2", "--agent", "claude-code"]);
    expect(res.code).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(
      'Task "P1-T2" cannot be started: dependencies are not done: P1-T1.',
    );
    expect(res.stderr).toContain(
      "No contract lock or progress event was recorded.",
    );
    expect(res.stderr).not.toContain(" at ");
    expect(res.stderr).not.toContain("Error:");
  });

  it("prepare and start derive the same incomplete dependency list in order", async () => {
    const p = await projectWithDependentTask("parity");
    const phasePath = join(
      p.dir,
      "design",
      "phases",
      "TUTORIAL-walkthrough.yaml",
    );
    const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<
      string,
      unknown
    >;
    const baseTask = {
      type: "feature",
      ambiguity: "low",
      risk: "low",
      context_size: "small",
      write_surface: "low",
      verification_strength: "weak",
      expected_duration: "short",
      status: "planned",
    };
    (doc as { tasks: unknown[] }).tasks = [
      {
        id: "P1-T1",
        ...baseTask,
        description: "done dependency",
        status: "planned",
      },
      {
        id: "P1-T2",
        ...baseTask,
        description: "started dependency",
      },
      {
        id: "P1-T3",
        ...baseTask,
        description: "planned dependency",
      },
      {
        id: "P1-T4",
        ...baseTask,
        description: "dependent task",
        depends_on: ["P1-T1", "P1-T2", "P1-T3"],
      },
    ];
    await writeFile(phasePath, stringifyYaml(doc), "utf8");
    execSync("git add .", { cwd: p.dir, stdio: "ignore" });
    execSync("git commit -m parity", { cwd: p.dir, stdio: "ignore" });

    // Mark P1-T1 done and start P1-T2.
    const startP1T1 = p.runJson([
      "task",
      "start",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(startP1T1.ok).toBe(true);
    execSync("git add .", { cwd: p.dir, stdio: "ignore" });
    execSync("git commit -m start-p1t1", { cwd: p.dir, stdio: "ignore" });

    const doneRes = p.runJson([
      "task",
      "record-done",
      "P1-T1",
      "--evidence",
      "done",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(doneRes.ok).toBe(true);
    execSync("git add .", { cwd: p.dir, stdio: "ignore" });
    execSync("git commit -m done", { cwd: p.dir, stdio: "ignore" });

    const startP1T2 = p.runJson([
      "task",
      "start",
      "P1-T2",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(startP1T2.ok).toBe(true);
    execSync("git add .", { cwd: p.dir, stdio: "ignore" });
    execSync("git commit -m start-p1t2", { cwd: p.dir, stdio: "ignore" });

    const prepare = p.runJson([
      "task",
      "prepare",
      "P1-T4",
      "--agent",
      "claude-code",
      "--json",
    ]) as { ok: true; data: { blocked_by?: string[] } };
    expect(prepare.data.blocked_by).toEqual(["P1-T2", "P1-T3"]);

    const start = p.run([
      "task",
      "start",
      "P1-T4",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(start.code).toBe(2);
    const parsed = expectJsonErr(start, "TASK_DEPENDENCY_INCOMPLETE");
    expect((parsed.data as { deps?: string[] }).deps).toEqual([
      "P1-T2",
      "P1-T3",
    ]);
  });

  it("cross-phase dependency rejects and accepts start correctly", async () => {
    const p = await projectWithDependentTask("cross-phase");
    const roadmapPath = join(p.dir, "design", "roadmap.yaml");
    const roadmap = parseYaml(await readFile(roadmapPath, "utf8")) as Record<
      string,
      unknown
    >;
    // Replace the sample tutorial phase with P1 and add P2.
    (roadmap.phases as unknown[]) = [
      { id: "P1", path: "design/phases/P1-foundation.yaml", weight: 1 },
      { id: "P2", path: "design/phases/P2-extension.yaml", weight: 1 },
    ];
    await writeFile(roadmapPath, stringifyYaml(roadmap), "utf8");

    const phase1 = `id: P1
name: Foundation
weight: 1
confidence: high
risk: low
status: planned
objective: base phase
definition_of_done:
  - done
verification:
  commands:
    - echo ok
tasks:
  - id: P1-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: weak
    expected_duration: short
    status: planned
    description: cross-phase dependency
`;
    const phase2 = `id: P2
name: Extension
weight: 1
confidence: high
risk: low
status: planned
objective: extension phase
definition_of_done:
  - done
verification:
  commands:
    - echo ok
tasks:
  - id: P2-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: weak
    expected_duration: short
    status: planned
    depends_on:
      - P1-T1
    description: cross-phase dependent
`;
    const phasesDir = join(p.dir, "design", "phases");
    await rm(join(phasesDir, "TUTORIAL-walkthrough.yaml"), { force: true });
    await writeFile(join(phasesDir, "P1-foundation.yaml"), phase1, "utf8");
    await writeFile(join(phasesDir, "P2-extension.yaml"), phase2, "utf8");
    execSync("git add .", { cwd: p.dir, stdio: "ignore" });
    execSync("git commit -m cross-phase", { cwd: p.dir, stdio: "ignore" });

    const reject = p.run([
      "task",
      "start",
      "P2-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(reject.code).toBe(2);
    const parsed = expectJsonErr(reject, "TASK_DEPENDENCY_INCOMPLETE");
    expect((parsed.data as { deps?: string[] }).deps).toEqual(["P1-T1"]);
    expect(await pathExists(lockPath(p, "P2-T1"))).toBe(false);

    const startDep = p.runJson([
      "task",
      "start",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(startDep.ok).toBe(true);
    execSync("git add .", { cwd: p.dir, stdio: "ignore" });
    execSync("git commit -m start-dep", { cwd: p.dir, stdio: "ignore" });

    const recordDep = p.runJson([
      "task",
      "record-done",
      "P1-T1",
      "--evidence",
      "done",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(recordDep.ok).toBe(true);
    execSync("git add .", { cwd: p.dir, stdio: "ignore" });
    execSync("git commit -m done-dep", { cwd: p.dir, stdio: "ignore" });

    const accept = p.run([
      "task",
      "start",
      "P2-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(accept.code).toBe(0);
    const ok = expectJsonOk<{ event: { task_id: string; status: string } }>(
      accept,
    );
    expect(ok.data.event.task_id).toBe("P2-T1");
    expect(ok.data.event.status).toBe("started");
    expect(await pathExists(lockPath(p, "P2-T1"))).toBe(true);
  });
});
