import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskRunbook } from "../../../src/commands/task-runbook.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-task-runbook-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

type SetupOpts = {
  designStatus?: "planned" | "in_progress" | "done";
  /** Recorded progress event sequence for P1-T1. */
  taskState?: "no_events" | "started" | "done" | "blocked";
  /** Second phase carrying the same task id (used to test AMBIGUOUS_TASK_ID). */
  duplicatePhase?: boolean;
};

async function setupProject(opts: SetupOpts = {}): Promise<void> {
  const designStatus = opts.designStatus ?? "planned";
  const taskState = opts.taskState ?? "no_events";

  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });

  let roadmap = `phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 10\n`;
  if (opts.duplicatePhase) {
    roadmap += `  - id: P2\n    path: design/phases/P2-other.yaml\n    weight: 10\n`;
  }
  await writeFile(join(cwd, "design", "roadmap.yaml"), roadmap, "utf8");

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
      "  - id: P1-T1",
      "    type: feature",
      "    ambiguity: low",
      "    risk: low",
      "    context_size: small",
      "    write_surface: low",
      "    verification_strength: medium",
      "    expected_duration: short",
      `    status: ${designStatus}`,
      "",
    ].join("\n"),
    "utf8",
  );

  if (opts.duplicatePhase) {
    await writeFile(
      join(cwd, "design", "phases", "P2-other.yaml"),
      [
        "id: P2",
        "name: Other",
        "weight: 10",
        "confidence: medium",
        "risk: low",
        "status: planned",
        "objective: Duplicate-id collision",
        "definition_of_done:",
        "  - none",
        "verification:",
        "  commands:",
        "    - node --version",
        "tasks:",
        "  - id: P1-T1",
        "    type: feature",
        "    ambiguity: low",
        "    risk: low",
        "    context_size: small",
        "    write_surface: low",
        "    verification_strength: medium",
        "    expected_duration: short",
        "    status: planned",
        "",
      ].join("\n"),
      "utf8",
    );
  }

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
}

// ---------------------------------------------------------------------------
// JSON envelope shape
// ---------------------------------------------------------------------------

describe("runTaskRunbook — JSON envelope", () => {
  it("returns kind: 'runbook' + state_summary + next_steps", async () => {
    await setupProject({ taskState: "done" });
    const result = await runTaskRunbook({ cwd, taskId: "P1-T1" });
    expect(result.kind).toBe("runbook");
    expect(result.task_id).toBe("P1-T1");
    expect(result.phase_id).toBe("P1");
    expect(result.state_summary).toBeDefined();
    expect(Array.isArray(result.next_steps)).toBe(true);
  });

  it("every step has field-presence-fixed shape (all 6 fields present)", async () => {
    await setupProject({ taskState: "blocked" });
    const result = await runTaskRunbook({ cwd, taskId: "P1-T1" });
    expect(result.next_steps.length).toBeGreaterThan(0);
    for (const step of result.next_steps) {
      expect(step).toHaveProperty("command");
      expect(step).toHaveProperty("manual_action");
      expect(step).toHaveProperty("reason");
      expect(step).toHaveProperty("blocking");
      expect(step).toHaveProperty("safety_note");
      expect(step).toHaveProperty("expected_result");
      // Exactly one of command / manual_action non-null.
      const hasCommand = step.command !== null;
      const hasManual = step.manual_action !== null;
      expect(hasCommand).not.toBe(hasManual);
    }
  });
});

// ---------------------------------------------------------------------------
// Lifecycle states (smoke tests; full coverage in build-task-runbook.test.ts)
// ---------------------------------------------------------------------------

describe("runTaskRunbook — lifecycle states (smoke)", () => {
  it("planned + no events → primary loop with task start at head", async () => {
    await setupProject({ taskState: "no_events" });
    const result = await runTaskRunbook({ cwd, taskId: "P1-T1" });
    expect(result.next_steps[0]!.command).toBe("code-pact task start P1-T1");
  });

  it("done + design planned → task finalize --write step", async () => {
    await setupProject({ taskState: "done", designStatus: "planned" });
    const result = await runTaskRunbook({ cwd, taskId: "P1-T1" });
    expect(result.state_summary.drift_kind).toBe("done-but-design-not-done");
    expect(result.next_steps.length).toBe(1);
    expect(result.next_steps[0]!.command).toBe(
      "code-pact task finalize P1-T1 --write",
    );
  });

  it("done + design done → empty next_steps + drift null", async () => {
    await setupProject({ taskState: "done", designStatus: "done" });
    const result = await runTaskRunbook({ cwd, taskId: "P1-T1" });
    expect(result.state_summary.drift_kind).toBeNull();
    expect(result.next_steps).toEqual([]);
  });

  it("blocked → resume guidance (blocking)", async () => {
    await setupProject({ taskState: "blocked" });
    const result = await runTaskRunbook({ cwd, taskId: "P1-T1" });
    expect(result.state_summary.derived_state).toBe("blocked");
    expect(result.next_steps[0]!.blocking).toBe(true);
    expect(result.next_steps[1]!.command).toContain("task resume P1-T1");
  });
});

// ---------------------------------------------------------------------------
// Error code surface (reused, no new codes)
// ---------------------------------------------------------------------------

describe("runTaskRunbook — error handling", () => {
  it("raises TASK_NOT_FOUND when task id is absent", async () => {
    await setupProject();
    await expect(
      runTaskRunbook({ cwd, taskId: "P99-T99" }),
    ).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
    });
  });

  it("raises AMBIGUOUS_TASK_ID when task id exists in multiple phases", async () => {
    await setupProject({ duplicatePhase: true });
    await expect(
      runTaskRunbook({ cwd, taskId: "P1-T1" }),
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_TASK_ID",
      phases: ["P1", "P2"],
    });
  });

  it("does NOT introduce new error codes — only reuses TASK_NOT_FOUND / AMBIGUOUS_TASK_ID", async () => {
    // This is a contract guard. If a future change adds a new code, this
    // test should fail and the developer must update KNOWN_CODES.public
    // intentionally (per the P12 RFC § Error / diagnostic taxonomy).
    await setupProject();
    try {
      await runTaskRunbook({ cwd, taskId: "missing" });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      expect(["TASK_NOT_FOUND", "AMBIGUOUS_TASK_ID"]).toContain(code);
    }
  });
});
