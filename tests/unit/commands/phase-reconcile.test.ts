import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runPhaseReconcile } from "../../../src/commands/phase-reconcile.ts";
import { Phase } from "../../../src/core/schemas/phase.ts";

// ---------------------------------------------------------------------------
// Fixture builder. Sets up a tmp project with one phase (P1) and the
// caller-supplied task statuses + progress events.
// ---------------------------------------------------------------------------

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-phase-reconcile-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

type TaskSpec = {
  id: string;
  /** Initial design status in the phase YAML. */
  designStatus: "planned" | "in_progress" | "done" | "cancelled";
  /**
   * Pre-recorded progress events for the task. Use "done" to record a
   * started -> done pair; "started" for just a started event; "blocked"
   * for started -> blocked; "failed" for started -> failed; "none" for no
   * events at all.
   */
  derive?: "none" | "started" | "blocked" | "failed" | "done";
};

async function setupPhase(specs: TaskSpec[]): Promise<void> {
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });

  await writeFile(
    join(cwd, "design", "roadmap.yaml"),
    `phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 10\n`,
    "utf8",
  );

  const taskBlocks = specs
    .map(s =>
      [
        `  - id: ${s.id}`,
        `    type: feature`,
        `    ambiguity: low`,
        `    risk: low`,
        `    context_size: small`,
        `    write_surface: low`,
        `    verification_strength: medium`,
        `    expected_duration: short`,
        `    status: ${s.designStatus}`,
      ].join("\n"),
    )
    .join("\n");

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
      taskBlocks,
      "",
    ].join("\n"),
    "utf8",
  );

  // Build progress.yaml from the specs.
  const events: string[] = [];
  let ts = Date.parse("2026-05-19T10:00:00.000Z");
  for (const s of specs) {
    const derive = s.derive ?? "none";
    if (derive === "none") continue;
    events.push(
      [
        `  - task_id: ${s.id}`,
        `    status: started`,
        `    at: "${new Date(ts).toISOString()}"`,
        `    actor: agent`,
        `    agent: claude-code`,
      ].join("\n"),
    );
    ts += 60_000;
    if (derive === "done") {
      events.push(
        [
          `  - task_id: ${s.id}`,
          `    status: done`,
          `    at: "${new Date(ts).toISOString()}"`,
          `    actor: agent`,
          `    agent: claude-code`,
          `    evidence:`,
          `      - commands`,
        ].join("\n"),
      );
      ts += 60_000;
    } else if (derive === "blocked") {
      events.push(
        [
          `  - task_id: ${s.id}`,
          `    status: blocked`,
          `    at: "${new Date(ts).toISOString()}"`,
          `    actor: agent`,
          `    agent: claude-code`,
          `    reason: Test`,
        ].join("\n"),
      );
      ts += 60_000;
    } else if (derive === "failed") {
      events.push(
        [
          `  - task_id: ${s.id}`,
          `    status: failed`,
          `    at: "${new Date(ts).toISOString()}"`,
          `    actor: agent`,
          `    agent: claude-code`,
        ].join("\n"),
      );
      ts += 60_000;
    }
    // started: no further event needed.
  }

  await writeFile(
    join(cwd, ".code-pact", "state", "progress.yaml"),
    events.length === 0 ? "events: []\n" : `events:\n${events.join("\n")}\n`,
    "utf8",
  );
}

async function readPhase(): Promise<Phase> {
  const raw = await readFile(
    join(cwd, "design", "phases", "P1-foundation.yaml"),
    "utf8",
  );
  return Phase.parse(parseYaml(raw) as unknown);
}

// ---------------------------------------------------------------------------
// no_eligible_tasks
// ---------------------------------------------------------------------------

describe("runPhaseReconcile — no_eligible_tasks", () => {
  it("returns kind 'no_eligible_tasks' when no task has a done event", async () => {
    await setupPhase([
      { id: "P1-T1", designStatus: "planned", derive: "none" },
      { id: "P1-T2", designStatus: "planned", derive: "started" },
    ]);
    const result = await runPhaseReconcile({ cwd, phaseId: "P1" });
    expect(result.kind).toBe("no_eligible_tasks");
  });

  it("returns kind 'no_eligible_tasks' when all tasks are already design=done", async () => {
    await setupPhase([
      { id: "P1-T1", designStatus: "done", derive: "done" },
      { id: "P1-T2", designStatus: "done", derive: "done" },
    ]);
    const result = await runPhaseReconcile({ cwd, phaseId: "P1" });
    expect(result.kind).toBe("no_eligible_tasks");
  });

  it("includes the verdict list and phase_status_candidate even when no_eligible_tasks", async () => {
    await setupPhase([{ id: "P1-T1", designStatus: "done", derive: "done" }]);
    const result = await runPhaseReconcile({ cwd, phaseId: "P1" });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.action).toBe("skip");
    expect(result.phase_status_candidate).toBe("done");
    expect(result.phase_status_note).toContain("phase status is never written");
  });
});

// ---------------------------------------------------------------------------
// would_reconcile (dry-run)
// ---------------------------------------------------------------------------

describe("runPhaseReconcile — would_reconcile (dry-run)", () => {
  it("returns planned_writes for each task that needs flipping", async () => {
    await setupPhase([
      { id: "P1-T1", designStatus: "planned", derive: "done" },
      { id: "P1-T2", designStatus: "planned", derive: "done" },
      { id: "P1-T3", designStatus: "done", derive: "done" }, // already done -> skip
      { id: "P1-T4", designStatus: "planned", derive: "none" }, // not yet done -> skip
    ]);
    const result = await runPhaseReconcile({ cwd, phaseId: "P1" });
    expect(result.kind).toBe("would_reconcile");
    if (result.kind !== "would_reconcile") return;
    expect(result.planned_writes).toHaveLength(2);
    const flippedIds = result.planned_writes.map(w => w.task_id).sort();
    expect(flippedIds).toEqual(["P1-T1", "P1-T2"]);
    expect(result.tasks).toHaveLength(4);
  });

  it("does NOT mutate the phase YAML in dry-run", async () => {
    await setupPhase([
      { id: "P1-T1", designStatus: "planned", derive: "done" },
    ]);
    await runPhaseReconcile({ cwd, phaseId: "P1" });
    const phase = await readPhase();
    expect(phase.tasks?.find(t => t.id === "P1-T1")?.status).toBe("planned");
  });

  it("includes verdict action and reason per task", async () => {
    await setupPhase([
      { id: "P1-T1", designStatus: "planned", derive: "done" },
      { id: "P1-T2", designStatus: "planned", derive: "blocked" },
    ]);
    const result = await runPhaseReconcile({ cwd, phaseId: "P1" });
    const t1 = result.tasks.find(t => t.task_id === "P1-T1");
    expect(t1?.action).toBe("flip");
    expect(t1?.derived_state).toBe("done");
    const t2 = result.tasks.find(t => t.task_id === "P1-T2");
    expect(t2?.action).toBe("manual_review");
    expect(t2?.derived_state).toBe("blocked");
    expect(t2?.reason).toMatch(/blocked/);
  });
});

// ---------------------------------------------------------------------------
// reconciled (--write)
// ---------------------------------------------------------------------------

describe("runPhaseReconcile — reconciled (--write)", () => {
  it("flips the design status of every eligible task", async () => {
    await setupPhase([
      { id: "P1-T1", designStatus: "planned", derive: "done" },
      { id: "P1-T2", designStatus: "planned", derive: "done" },
    ]);
    const result = await runPhaseReconcile({
      cwd,
      phaseId: "P1",
      write: true,
    });
    expect(result.kind).toBe("reconciled");
    if (result.kind !== "reconciled") return;
    expect(result.applied_writes).toHaveLength(2);
    expect(result.skipped_writes).toEqual([]);

    const phase = await readPhase();
    expect(phase.tasks?.find(t => t.id === "P1-T1")?.status).toBe("done");
    expect(phase.tasks?.find(t => t.id === "P1-T2")?.status).toBe("done");
  });

  it("does NOT touch tasks whose action was skip", async () => {
    await setupPhase([
      { id: "P1-T1", designStatus: "planned", derive: "done" }, // flip
      { id: "P1-T2", designStatus: "planned", derive: "none" }, // skip (not yet done)
    ]);
    await runPhaseReconcile({ cwd, phaseId: "P1", write: true });
    const phase = await readPhase();
    expect(phase.tasks?.find(t => t.id === "P1-T1")?.status).toBe("done");
    expect(phase.tasks?.find(t => t.id === "P1-T2")?.status).toBe("planned");
  });

  it("does NOT change the phase's own status field", async () => {
    await setupPhase([
      { id: "P1-T1", designStatus: "planned", derive: "done" },
    ]);
    await runPhaseReconcile({ cwd, phaseId: "P1", write: true });
    const phase = await readPhase();
    // The v1.2 contract: phase status is never written by phase reconcile.
    expect(phase.status).toBe("planned");
  });

  it("phase_status_candidate is 'done' when every task ends up done", async () => {
    await setupPhase([
      { id: "P1-T1", designStatus: "planned", derive: "done" },
      { id: "P1-T2", designStatus: "done", derive: "done" },
    ]);
    const result = await runPhaseReconcile({
      cwd,
      phaseId: "P1",
      write: true,
    });
    expect(result.phase_status_candidate).toBe("done");
  });

  it("phase_status_candidate stays 'in_progress' when any task is still started/blocked", async () => {
    await setupPhase([
      { id: "P1-T1", designStatus: "planned", derive: "done" }, // flip to done
      { id: "P1-T2", designStatus: "planned", derive: "started" }, // still in progress
    ]);
    const result = await runPhaseReconcile({
      cwd,
      phaseId: "P1",
      write: true,
    });
    expect(result.phase_status_candidate).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// PHASE_NOT_FOUND
// ---------------------------------------------------------------------------

describe("runPhaseReconcile — PHASE_NOT_FOUND", () => {
  it("raises PHASE_NOT_FOUND for an unknown phase id", async () => {
    await setupPhase([
      { id: "P1-T1", designStatus: "planned", derive: "done" },
    ]);
    await expect(
      runPhaseReconcile({ cwd, phaseId: "P99" }),
    ).rejects.toMatchObject({ code: "PHASE_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// Classification edge cases
// ---------------------------------------------------------------------------

describe("runPhaseReconcile — classification", () => {
  it("classifies derived=started as skip (work in progress)", async () => {
    await setupPhase([
      { id: "P1-T1", designStatus: "planned", derive: "started" },
    ]);
    const result = await runPhaseReconcile({ cwd, phaseId: "P1" });
    expect(result.tasks[0]?.action).toBe("skip");
    expect(result.tasks[0]?.reason).toMatch(/work in progress/);
  });

  it("classifies derived=blocked as manual_review", async () => {
    await setupPhase([
      { id: "P1-T1", designStatus: "planned", derive: "blocked" },
    ]);
    const result = await runPhaseReconcile({ cwd, phaseId: "P1" });
    expect(result.tasks[0]?.action).toBe("manual_review");
  });

  it("classifies design=done already as skip (idempotent)", async () => {
    await setupPhase([{ id: "P1-T1", designStatus: "done", derive: "done" }]);
    const result = await runPhaseReconcile({ cwd, phaseId: "P1" });
    expect(result.tasks[0]?.action).toBe("skip");
    expect(result.tasks[0]?.reason).toMatch(/already done/);
  });
});

describe("runPhaseReconcile — cancelled task terminality", () => {
  it("skips cancelled failed sibling and reports phase_status_candidate done", async () => {
    await setupPhase([
      { id: "P1-T1", designStatus: "cancelled", derive: "failed" },
      { id: "P1-T2", designStatus: "planned", derive: "done" },
    ]);
    const result = await runPhaseReconcile({ cwd, phaseId: "P1", write: true });
    expect(result.phase_status_candidate).toBe("done");

    const t1 = result.tasks.find(t => t.task_id === "P1-T1");
    expect(t1?.action).toBe("skip");
    expect(t1?.reason).toMatch(/cancelled/);

    const t2 = result.tasks.find(t => t.task_id === "P1-T2");
    expect(t2?.action).toBe("flip");

    const phase = await readPhase();
    expect(phase.tasks?.find(t => t.id === "P1-T1")?.status).toBe("cancelled");
    expect(phase.tasks?.find(t => t.id === "P1-T2")?.status).toBe("done");
  });
});
