// P82-T1 integration: task start rejects incomplete declared dependencies
// before any progress event or contract lock, then succeeds once the
// dependency is recorded as done.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
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

describe("task start dependency gate", () => {
  it("rejects start when a declared dependency is not done", async () => {
    const p = await projectWithDependentTask("reject");
    const res = p.run([
      "task",
      "start",
      "P1-T2",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(res.code).toBe(1);
    const parsed = expectJsonErr(res, "TASK_DEPENDENCY_INCOMPLETE");
    expect((parsed.data as { deps?: string[] }).deps).toEqual(["P1-T1"]);
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
    expect(first.code).toBe(1);
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
});
