import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runTaskFinalize } from "../../../src/commands/task-finalize.ts";
import { Phase } from "../../../src/core/schemas/phase.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-task-finalize-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

type SetupOpts = {
  /** Pre-task-complete event status for P1-T1 (controls eligibility). */
  taskState?:
    | "no_events"
    | "started"
    | "done"
    | "blocked";
  /** Initial design status for P1-T1 inside the phase YAML. */
  designStatus?: "planned" | "in_progress" | "done";
  /** P10 fields for P1-T1. */
  acceptanceRefs?: string[];
  writes?: string[];
  dependsOn?: string[];
  /** Optional acceptance_refs file bodies to write to disk. */
  acceptanceRefFiles?: Record<string, string>;
};

async function setupProject(opts: SetupOpts = {}): Promise<void> {
  const taskState = opts.taskState ?? "done";
  const designStatus = opts.designStatus ?? "planned";

  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });

  await writeFile(
    join(cwd, "design", "roadmap.yaml"),
    `phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 10\n`,
    "utf8",
  );

  const taskBlock: string[] = [
    "  - id: P1-T1",
    "    type: feature",
    "    ambiguity: low",
    "    risk: low",
    "    context_size: small",
    "    write_surface: low",
    "    verification_strength: medium",
    "    expected_duration: short",
    `    status: ${designStatus}`,
  ];
  if (opts.acceptanceRefs && opts.acceptanceRefs.length > 0) {
    taskBlock.push("    acceptance_refs:");
    for (const r of opts.acceptanceRefs) taskBlock.push(`      - ${r}`);
  }
  if (opts.writes && opts.writes.length > 0) {
    taskBlock.push("    writes:");
    for (const w of opts.writes) taskBlock.push(`      - ${w}`);
  }
  if (opts.dependsOn && opts.dependsOn.length > 0) {
    taskBlock.push("    depends_on:");
    for (const d of opts.dependsOn) taskBlock.push(`      - ${d}`);
  }

  const otherTasks: string[] = [
    "  - id: P1-T2",
    "    type: docs",
    "    ambiguity: low",
    "    risk: low",
    "    context_size: small",
    "    write_surface: low",
    "    verification_strength: weak",
    "    expected_duration: short",
    "    status: done",
  ];

  await writeFile(
    join(cwd, "design", "phases", "P1-foundation.yaml"),
    [
      "id: P1",
      "name: Foundation",
      "weight: 10",
      "confidence: medium",
      "risk: low",
      "status: planned",
      "objective: Establish the project foundation",
      "definition_of_done:",
      "  - All tasks done",
      "verification:",
      "  commands:",
      "    - node --version",
      "tasks:",
      ...taskBlock,
      ...otherTasks,
      "",
    ].join("\n"),
    "utf8",
  );

  // Compose progress.yaml content based on the requested state.
  let progressYaml = "events: []\n";
  if (taskState === "started") {
    progressYaml = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-19T10:00:00.000Z"
    actor: agent
    agent: claude-code
`;
  } else if (taskState === "done") {
    progressYaml = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-19T10:00:00.000Z"
    actor: agent
    agent: claude-code
  - task_id: P1-T1
    status: done
    at: "2026-05-19T11:00:00.000Z"
    actor: agent
    agent: claude-code
    evidence:
      - commands
`;
  } else if (taskState === "blocked") {
    progressYaml = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-19T10:00:00.000Z"
    actor: agent
    agent: claude-code
  - task_id: P1-T1
    status: blocked
    at: "2026-05-19T10:30:00.000Z"
    actor: agent
    agent: claude-code
    reason: Test
`;
  }
  await writeFile(
    join(cwd, ".code-pact", "state", "progress.yaml"),
    progressYaml,
    "utf8",
  );

  for (const [relPath, body] of Object.entries(opts.acceptanceRefFiles ?? {})) {
    const abs = join(cwd, relPath);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body, "utf8");
  }
}

async function readPhase(): Promise<Phase> {
  const raw = await readFile(
    join(cwd, "design", "phases", "P1-foundation.yaml"),
    "utf8",
  );
  return Phase.parse(parseYaml(raw) as unknown);
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("runTaskFinalize — dry-run (default)", () => {
  it("returns kind 'would_finalize' when task is done in progress and planned in design", async () => {
    await setupProject({ taskState: "done", designStatus: "planned" });
    const result = await runTaskFinalize({ cwd, taskId: "P1-T1" });
    expect(result.kind).toBe("would_finalize");
    if (result.kind !== "would_finalize") return;
    expect(result.task_id).toBe("P1-T1");
    expect(result.phase_id).toBe("P1");
    expect(result.file).toBe("design/phases/P1-foundation.yaml");
    expect(result.current_status).toBe("planned");
    expect(result.target_status).toBe("done");
    expect(result.planned_writes).toHaveLength(1);
    expect(result.planned_writes[0]).toEqual({
      file: "design/phases/P1-foundation.yaml",
      task_id: "P1-T1",
      before: "planned",
      after: "done",
    });
  });

  it("does NOT mutate the phase YAML in dry-run", async () => {
    await setupProject({ taskState: "done", designStatus: "planned" });
    await runTaskFinalize({ cwd, taskId: "P1-T1" });
    const phase = await readPhase();
    const t1 = phase.tasks?.find((t) => t.id === "P1-T1");
    expect(t1?.status).toBe("planned");
  });
});

describe("runTaskFinalize — --write", () => {
  it("returns kind 'finalized' and flips the task status in design YAML", async () => {
    await setupProject({ taskState: "done", designStatus: "planned" });
    const result = await runTaskFinalize({
      cwd,
      taskId: "P1-T1",
      write: true,
    });
    expect(result.kind).toBe("finalized");
    if (result.kind !== "finalized") return;
    expect(result.applied_writes).toHaveLength(1);
    expect(result.applied_writes[0]?.after).toBe("done");
    expect(result.skipped_writes).toEqual([]);

    const phase = await readPhase();
    const t1 = phase.tasks?.find((t) => t.id === "P1-T1");
    expect(t1?.status).toBe("done");
  });

  it("does NOT touch other tasks in the same phase", async () => {
    await setupProject({ taskState: "done", designStatus: "planned" });
    await runTaskFinalize({ cwd, taskId: "P1-T1", write: true });
    const phase = await readPhase();
    const t2 = phase.tasks?.find((t) => t.id === "P1-T2");
    // T2 was already done in the fixture; must remain done untouched.
    expect(t2?.status).toBe("done");
  });

  it("does NOT change the phase's own status field", async () => {
    await setupProject({ taskState: "done", designStatus: "planned" });
    await runTaskFinalize({ cwd, taskId: "P1-T1", write: true });
    const phase = await readPhase();
    // phase.status remained `planned` per the v1.2 contract.
    expect(phase.status).toBe("planned");
  });
});

describe("runTaskFinalize — already_finalized (idempotent)", () => {
  it("returns kind 'already_finalized' when design status is already done", async () => {
    await setupProject({ taskState: "done", designStatus: "done" });
    const result = await runTaskFinalize({ cwd, taskId: "P1-T1" });
    expect(result.kind).toBe("already_finalized");
    if (result.kind !== "already_finalized") return;
    expect(result.current_status).toBe("done");
  });

  it("returns kind 'already_finalized' under --write (no write needed)", async () => {
    await setupProject({ taskState: "done", designStatus: "done" });
    const result = await runTaskFinalize({
      cwd,
      taskId: "P1-T1",
      write: true,
    });
    expect(result.kind).toBe("already_finalized");
  });
});

// ---------------------------------------------------------------------------
// Eligibility (TASK_FINALIZE_NOT_ELIGIBLE) — same in dry-run AND --write
// ---------------------------------------------------------------------------

describe("runTaskFinalize — TASK_FINALIZE_NOT_ELIGIBLE", () => {
  it("raises NOT_ELIGIBLE in dry-run when the task has no events (planned)", async () => {
    await setupProject({ taskState: "no_events" });
    await expect(
      runTaskFinalize({ cwd, taskId: "P1-T1" }),
    ).rejects.toMatchObject({ code: "TASK_FINALIZE_NOT_ELIGIBLE" });
  });

  it("raises NOT_ELIGIBLE in --write when the task has no events", async () => {
    await setupProject({ taskState: "no_events" });
    await expect(
      runTaskFinalize({ cwd, taskId: "P1-T1", write: true }),
    ).rejects.toMatchObject({ code: "TASK_FINALIZE_NOT_ELIGIBLE" });
  });

  it("raises NOT_ELIGIBLE when the derived state is started", async () => {
    await setupProject({ taskState: "started" });
    await expect(
      runTaskFinalize({ cwd, taskId: "P1-T1" }),
    ).rejects.toMatchObject({ code: "TASK_FINALIZE_NOT_ELIGIBLE" });
  });

  it("raises NOT_ELIGIBLE when the derived state is blocked", async () => {
    await setupProject({ taskState: "blocked" });
    await expect(
      runTaskFinalize({ cwd, taskId: "P1-T1" }),
    ).rejects.toMatchObject({ code: "TASK_FINALIZE_NOT_ELIGIBLE" });
  });
});

// ---------------------------------------------------------------------------
// Resolve errors
// ---------------------------------------------------------------------------

describe("runTaskFinalize — task resolution", () => {
  it("raises TASK_NOT_FOUND when the task id is not in any phase", async () => {
    await setupProject({ taskState: "done" });
    await expect(
      runTaskFinalize({ cwd, taskId: "P9-T99" }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// P10 field surfacing in the result
// ---------------------------------------------------------------------------

describe("runTaskFinalize — P10 field surfacing", () => {
  it("populates acceptance_refs_check with existence flags", async () => {
    await setupProject({
      taskState: "done",
      acceptanceRefs: ["docs/cli-contract.md", "docs/missing.md"],
      acceptanceRefFiles: { "docs/cli-contract.md": "stub" },
    });
    const result = await runTaskFinalize({ cwd, taskId: "P1-T1" });
    expect(result.acceptance_refs_check).toEqual([
      { path: "docs/cli-contract.md", exists: true },
      { path: "docs/missing.md", exists: false },
    ]);
  });

  it("populates declared_writes from task.writes verbatim", async () => {
    await setupProject({
      taskState: "done",
      writes: ["src/commands/foo.ts", "src/commands/bar.ts"],
    });
    const result = await runTaskFinalize({ cwd, taskId: "P1-T1" });
    expect(result.declared_writes).toEqual([
      "src/commands/foo.ts",
      "src/commands/bar.ts",
    ]);
  });

  it("populates depends_on_check with derived state per dependency", async () => {
    await setupProject({
      taskState: "done",
      dependsOn: ["P1-T2"],
    });
    const result = await runTaskFinalize({ cwd, taskId: "P1-T1" });
    expect(result.depends_on_check).toHaveLength(1);
    expect(result.depends_on_check[0]?.task_id).toBe("P1-T2");
    // P1-T2 has no events in the fixture progress.yaml (only P1-T1 events).
    expect(result.depends_on_check[0]?.current).toBe("planned");
    expect(result.depends_on_check[0]?.satisfied).toBe(false);
  });

  it("returns empty arrays for all P10 fields when none declared", async () => {
    await setupProject({ taskState: "done" });
    const result = await runTaskFinalize({ cwd, taskId: "P1-T1" });
    expect(result.acceptance_refs_check).toEqual([]);
    expect(result.declared_writes).toEqual([]);
    expect(result.depends_on_check).toEqual([]);
  });
});
