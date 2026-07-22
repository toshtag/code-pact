import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTaskStart } from "../../../src/commands/task-progress.ts";
import { loadMergedProgress } from "../../../src/core/progress/io.ts";

const ROADMAP_YAML = `phases:
  - id: P1
    path: design/phases/P1-foundation.yaml
    weight: 12
`;

const PROJECT_YAML = (defaultAgent = "claude-code", agents = ["claude-code"]) =>
  [
    "name: project-test",
    "version: 0.1.0",
    "locale: en-US",
    `default_agent: ${defaultAgent}`,
    "agents:",
    ...agents.flatMap(a => [
      `  - name: ${a}`,
      `    profile: agent-profiles/${a}.yaml`,
      `    enabled: true`,
    ]),
  ].join("\n") + "\n";

const PROJECT_YAML_DISABLED = `name: project-test
version: 0.1.0
locale: en-US
default_agent: claude-code
agents:
  - name: claude-code
    profile: agent-profiles/claude-code.yaml
    enabled: true
  - name: codex
    profile: agent-profiles/codex.yaml
    enabled: false
`;

const PHASE_YAML = `id: P1
name: Foundation
weight: 12
confidence: high
risk: low
status: planned
objective: test phase
definition_of_done:
  - tests pass
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
`;

async function setupProject(
  dir: string,
  opts: {
    projectYaml?: string;
    progressYaml?: string;
    phaseYaml?: string;
  } = {},
): Promise<void> {
  await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
  await mkdir(join(dir, "design", "phases"), { recursive: true });
  await writeFile(
    join(dir, ".code-pact", "project.yaml"),
    opts.projectYaml ?? PROJECT_YAML(),
    "utf8",
  );
  await writeFile(
    join(dir, ".code-pact", "state", "progress.yaml"),
    opts.progressYaml ?? "events: []\n",
    "utf8",
  );
  await writeFile(join(dir, "design", "roadmap.yaml"), ROADMAP_YAML, "utf8");
  await writeFile(
    join(dir, "design", "phases", "P1-foundation.yaml"),
    opts.phaseYaml ?? PHASE_YAML,
    "utf8",
  );

  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["init", "--quiet"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
    cwd: dir,
  });
  spawnSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "initial",
    ],
    { cwd: dir },
  );
}

async function readProgress(dir: string) {
  // Merged view (legacy progress.yaml + per-event files) — events written by
  // the flipped writers land in `.code-pact/state/events/`, not progress.yaml.
  const { raw, log } = await loadMergedProgress(dir);
  return { raw, log };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-task-start-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("runTaskStart — happy path", () => {
  it("appends a started event from planned state", async () => {
    await setupProject(dir);
    const fakeNow = () => new Date("2026-05-18T09:00:00+00:00");
    const result = await runTaskStart({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      now: fakeNow,
    });
    expect(result.kind).toBe("started");
    if (result.kind !== "started") throw new Error("type narrow");
    expect(result.task_id).toBe("P1-T1");
    expect(result.phase_id).toBe("P1");
    expect(result.event.status).toBe("started");
    expect(result.event.actor).toBe("agent");
    expect(result.event.agent).toBe("claude-code");

    const { log } = await readProgress(dir);
    expect(log.events).toHaveLength(1);
  });

  it("uses default_agent when --agent is omitted", async () => {
    await setupProject(dir);
    const result = await runTaskStart({ cwd: dir, taskId: "P1-T1" });
    if (result.kind !== "started") throw new Error("type narrow");
    expect(result.agent).toBe("claude-code");
    expect(result.event.agent).toBe("claude-code");
  });
});

describe("runTaskStart — idempotency", () => {
  it("returns kind=already_started on second call, byte-identical YAML", async () => {
    await setupProject(dir);
    await runTaskStart({ cwd: dir, taskId: "P1-T1", agent: "claude-code" });
    const before = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );

    const second = await runTaskStart({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    expect(second.kind).toBe("already_started");

    const after = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });
});

describe("runTaskStart — invalid transitions", () => {
  const blockedYaml = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-18T09:00:00+00:00"
    actor: agent
    agent: claude-code
  - task_id: P1-T1
    status: blocked
    at: "2026-05-18T10:00:00+00:00"
    actor: agent
    agent: claude-code
    reason: waiting
`;

  const resumedYaml =
    blockedYaml +
    `  - task_id: P1-T1
    status: resumed
    at: "2026-05-18T11:00:00+00:00"
    actor: agent
    agent: claude-code
`;

  const doneYaml = `events:
  - task_id: P1-T1
    status: done
    at: "2026-05-18T11:00:00+00:00"
    actor: agent
    agent: claude-code
`;

  it("blocked → start fails with INVALID_TASK_TRANSITION", async () => {
    await setupProject(dir, { progressYaml: blockedYaml });
    await expect(
      runTaskStart({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "INVALID_TASK_TRANSITION" });
  });

  it("resumed → start fails with INVALID_TASK_TRANSITION", async () => {
    await setupProject(dir, { progressYaml: resumedYaml });
    await expect(
      runTaskStart({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "INVALID_TASK_TRANSITION" });
  });

  it("done → start fails with INVALID_TASK_TRANSITION", async () => {
    await setupProject(dir, { progressYaml: doneYaml });
    await expect(
      runTaskStart({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "INVALID_TASK_TRANSITION" });
  });

  it("failed → start succeeds (internal retry path)", async () => {
    const failedYaml = `events:
  - task_id: P1-T1
    status: failed
    at: "2026-05-18T09:00:00+00:00"
    actor: agent
    agent: claude-code
`;
    await setupProject(dir, { progressYaml: failedYaml });
    const result = await runTaskStart({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    expect(result.kind).toBe("started");
  });
});

describe("runTaskStart — error codes", () => {
  it("TASK_NOT_FOUND when no phase has the task", async () => {
    await setupProject(dir);
    await expect(
      runTaskStart({ cwd: dir, taskId: "NOPE-T9", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("AGENT_NOT_FOUND for an unknown agent", async () => {
    await setupProject(dir);
    await expect(
      runTaskStart({ cwd: dir, taskId: "P1-T1", agent: "missing" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("AGENT_NOT_ENABLED for a disabled agent", async () => {
    await setupProject(dir, { projectYaml: PROJECT_YAML_DISABLED });
    await expect(
      runTaskStart({ cwd: dir, taskId: "P1-T1", agent: "codex" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_ENABLED" });
  });
});

describe("runTaskStart — author attribution (Collaboration UX RFC D1)", () => {
  // Use CODE_PACT_AUTHOR for determinism (no dependence on the machine's git
  // identity); the full resolver precedence is unit-tested in author.test.ts.
  let savedAuthor: string | undefined;
  beforeEach(() => {
    savedAuthor = process.env.CODE_PACT_AUTHOR;
    process.env.CODE_PACT_AUTHOR = "Ada Lovelace";
  });
  afterEach(() => {
    if (savedAuthor === undefined) delete process.env.CODE_PACT_AUTHOR;
    else process.env.CODE_PACT_AUTHOR = savedAuthor;
  });

  it("stamps the recorded event with author", async () => {
    await setupProject(dir);
    const result = await runTaskStart({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    if (result.kind !== "started") throw new Error("type narrow");
    expect(result.event.author).toBe("Ada Lovelace");
    // and it is persisted to the event file (round-trips through the ledger)
    const { log } = await readProgress(dir);
    expect(log.events[0]?.author).toBe("Ada Lovelace");
  });

  it("omits author when collaboration.author: off (off beats CODE_PACT_AUTHOR)", async () => {
    await setupProject(dir, {
      projectYaml: PROJECT_YAML() + "collaboration:\n  author: off\n",
    });
    const result = await runTaskStart({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    if (result.kind !== "started") throw new Error("type narrow");
    expect(result.event.author).toBeUndefined();
    const { log } = await readProgress(dir);
    expect(log.events[0]?.author).toBeUndefined();
  });
});

describe("runTaskStart — dependency gate", () => {
  const DEPENDENT_PHASE_YAML = `${PHASE_YAML}  - id: P1-T2
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
`;

  it("rejects start when a declared dependency is not done", async () => {
    await setupProject(dir, { phaseYaml: DEPENDENT_PHASE_YAML });
    await expect(
      runTaskStart({ cwd: dir, taskId: "P1-T2", agent: "claude-code" }),
    ).rejects.toMatchObject({
      code: "TASK_DEPENDENCY_INCOMPLETE",
      deps: ["P1-T1"],
    });
  });

  it("allows start when every declared dependency is done", async () => {
    await setupProject(dir, {
      phaseYaml: DEPENDENT_PHASE_YAML,
      progressYaml: `events:
  - task_id: P1-T1
    status: done
    at: "2026-05-18T09:00:00+00:00"
    actor: agent
    agent: claude-code
`,
    });
    const result = await runTaskStart({
      cwd: dir,
      taskId: "P1-T2",
      agent: "claude-code",
    });
    expect(result.kind).toBe("started");
  });

  it("does not write a contract lock or progress event when rejected", async () => {
    await setupProject(dir, { phaseYaml: DEPENDENT_PHASE_YAML });
    const lockPath = join(dir, ".code-pact", "state", "locks", "P1-T2.yaml");
    const { log: logBefore } = await readProgress(dir);
    await expect(
      runTaskStart({ cwd: dir, taskId: "P1-T2", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "TASK_DEPENDENCY_INCOMPLETE" });

    const lockExists = await readFile(lockPath, "utf8").then(
      () => true,
      () => false,
    );
    expect(lockExists).toBe(false);
    const { log: logAfter } = await readProgress(dir);
    expect(logAfter.events).toHaveLength(logBefore.events.length);
  });
});
