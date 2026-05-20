import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPhaseRunbook } from "../../../src/commands/phase-runbook.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-phase-runbook-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

type TaskSpec = {
  id: string;
  designStatus?: "planned" | "in_progress" | "done";
  /** Recorded progress event sequence. */
  derive?: "none" | "started" | "blocked" | "done" | "failed";
};

async function setupPhase(specs: TaskSpec[], phaseStatus: "planned" | "in_progress" | "done" = "planned"): Promise<void> {
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });

  await writeFile(
    join(cwd, "design", "roadmap.yaml"),
    `phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 10\n`,
    "utf8",
  );

  const taskBlocks: string[] = [];
  for (const spec of specs) {
    taskBlocks.push(
      `  - id: ${spec.id}`,
      "    type: feature",
      "    ambiguity: low",
      "    risk: low",
      "    context_size: small",
      "    write_surface: low",
      "    verification_strength: medium",
      "    expected_duration: short",
      `    status: ${spec.designStatus ?? "planned"}`,
    );
  }

  await writeFile(
    join(cwd, "design", "phases", "P1-foundation.yaml"),
    [
      "id: P1",
      "name: Foundation",
      "weight: 10",
      "confidence: medium",
      "risk: low",
      `status: ${phaseStatus}`,
      "objective: Establish the project foundation",
      "definition_of_done:",
      "  - All tasks done",
      "verification:",
      "  commands:",
      "    - node --version",
      "tasks:",
      ...taskBlocks,
      "",
    ].join("\n"),
    "utf8",
  );

  // Compose progress.yaml events for each task based on `derive`.
  const events: string[] = [];
  let t = 0;
  for (const spec of specs) {
    const derive = spec.derive ?? "none";
    const baseT = `2026-05-19T${String(10 + t).padStart(2, "0")}:00:00.000Z`;
    t += 1;
    if (derive === "started") {
      events.push(
        `  - task_id: ${spec.id}`,
        `    status: started`,
        `    at: "${baseT}"`,
        `    actor: agent`,
        `    agent: claude-code`,
      );
    } else if (derive === "blocked") {
      events.push(
        `  - task_id: ${spec.id}`,
        `    status: started`,
        `    at: "${baseT}"`,
        `    actor: agent`,
        `    agent: claude-code`,
        `  - task_id: ${spec.id}`,
        `    status: blocked`,
        `    at: "${baseT}"`,
        `    actor: agent`,
        `    agent: claude-code`,
        `    reason: Test blocker`,
      );
    } else if (derive === "done") {
      events.push(
        `  - task_id: ${spec.id}`,
        `    status: started`,
        `    at: "${baseT}"`,
        `    actor: agent`,
        `    agent: claude-code`,
        `  - task_id: ${spec.id}`,
        `    status: done`,
        `    at: "${baseT}"`,
        `    actor: agent`,
        `    agent: claude-code`,
        `    evidence:`,
        `      - commands`,
      );
    } else if (derive === "failed") {
      events.push(
        `  - task_id: ${spec.id}`,
        `    status: started`,
        `    at: "${baseT}"`,
        `    actor: agent`,
        `    agent: claude-code`,
        `  - task_id: ${spec.id}`,
        `    status: failed`,
        `    at: "${baseT}"`,
        `    actor: agent`,
        `    agent: claude-code`,
      );
    }
  }

  const progressYaml = events.length > 0 ? `events:\n${events.join("\n")}\n` : "events: []\n";
  await writeFile(join(cwd, ".code-pact", "state", "progress.yaml"), progressYaml, "utf8");
}

// ---------------------------------------------------------------------------
// JSON envelope
// ---------------------------------------------------------------------------

describe("runPhaseRunbook — JSON envelope", () => {
  it("returns kind: 'runbook' + phase_summary + next_steps", async () => {
    await setupPhase([{ id: "P1-T1" }]);
    const result = await runPhaseRunbook({ cwd, phaseId: "P1" });
    expect(result.kind).toBe("runbook");
    expect(result.phase_id).toBe("P1");
    expect(result.phase_summary).toBeDefined();
    expect(Array.isArray(result.next_steps)).toBe(true);
  });

  it("every step has field-presence-fixed shape (all 6 fields present)", async () => {
    await setupPhase([
      { id: "P1-T1", derive: "blocked" },
      { id: "P1-T2", derive: "done" },
    ]);
    const result = await runPhaseRunbook({ cwd, phaseId: "P1" });
    expect(result.next_steps.length).toBeGreaterThan(0);
    for (const step of result.next_steps) {
      expect(step).toHaveProperty("command");
      expect(step).toHaveProperty("manual_action");
      expect(step).toHaveProperty("reason");
      expect(step).toHaveProperty("blocking");
      expect(step).toHaveProperty("safety_note");
      expect(step).toHaveProperty("expected_result");
      const hasCommand = step.command !== null;
      const hasManual = step.manual_action !== null;
      expect(hasCommand).not.toBe(hasManual);
    }
  });
});

// ---------------------------------------------------------------------------
// Step generation smoke (full coverage lives in build-phase-runbook.test.ts)
// ---------------------------------------------------------------------------

describe("runPhaseRunbook — step generation (smoke)", () => {
  it("reconcile batch step consolidates multiple done-but-design-not-done tasks", async () => {
    await setupPhase([
      { id: "P1-T1", derive: "done" },
      { id: "P1-T2", derive: "done" },
      { id: "P1-T3", derive: "done" },
    ]);
    const result = await runPhaseRunbook({ cwd, phaseId: "P1" });
    const reconcile = result.next_steps.filter((s) =>
      s.command?.includes("phase reconcile"),
    );
    expect(reconcile.length).toBe(1);
    expect(reconcile[0]!.command).toBe("code-pact phase reconcile P1 --write");
  });

  it("blocked task → resume guidance steps first (blocking)", async () => {
    await setupPhase([{ id: "P1-T1", derive: "blocked" }]);
    const result = await runPhaseRunbook({ cwd, phaseId: "P1" });
    expect(result.next_steps[0]!.manual_action).toContain("Resolve");
    expect(result.next_steps[0]!.blocking).toBe(true);
    expect(result.next_steps[1]!.command).toContain("task resume P1-T1");
  });

  it("ready planned task → primary loop (task start → context → implement → complete)", async () => {
    await setupPhase([{ id: "P1-T1", derive: "none" }]);
    const result = await runPhaseRunbook({ cwd, phaseId: "P1" });
    const startStep = result.next_steps.find(
      (s) => s.command === "code-pact task start P1-T1",
    );
    expect(startStep).toBeDefined();
    const contextStep = result.next_steps.find(
      (s) => s.command === "code-pact task context P1-T1",
    );
    expect(contextStep).toBeDefined();
    // Primary loop in phase runbook also avoids embedding agent name.
    expect(contextStep!.command).not.toContain("--agent");
  });

  it("started task → emits task runbook hint (non-blocking)", async () => {
    await setupPhase([{ id: "P1-T1", derive: "started" }]);
    const result = await runPhaseRunbook({ cwd, phaseId: "P1" });
    const hint = result.next_steps.find((s) =>
      s.command?.includes("task runbook P1-T1"),
    );
    expect(hint).toBeDefined();
    expect(hint!.blocking).toBe(false);
  });

  it("phase status advisory emitted when all tasks would be done and phase status isn't done", async () => {
    await setupPhase(
      [
        { id: "P1-T1", designStatus: "done", derive: "done" },
        { id: "P1-T2", designStatus: "done", derive: "done" },
      ],
      "planned",
    );
    const result = await runPhaseRunbook({ cwd, phaseId: "P1" });
    const advisory = result.next_steps[result.next_steps.length - 1]!;
    expect(advisory.manual_action).toContain("Flip the phase");
  });

  it("empty phase (no tasks) → empty next_steps + planned candidate", async () => {
    await mkdir(join(cwd, "design", "phases"), { recursive: true });
    await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
    await writeFile(
      join(cwd, "design", "roadmap.yaml"),
      `phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 10\n`,
      "utf8",
    );
    await writeFile(
      join(cwd, "design", "phases", "P1-foundation.yaml"),
      [
        "id: P1",
        "name: Foundation",
        "weight: 10",
        "confidence: medium",
        "risk: low",
        "status: planned",
        "objective: Empty phase",
        "definition_of_done:",
        "  - placeholder",
        "verification:",
        "  commands:",
        "    - node --version",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(cwd, ".code-pact", "state", "progress.yaml"),
      "events: []\n",
      "utf8",
    );
    const result = await runPhaseRunbook({ cwd, phaseId: "P1" });
    expect(result.next_steps).toEqual([]);
    expect(result.phase_summary.phase_status_candidate).toBe("planned");
  });
});

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

describe("runPhaseRunbook — error codes", () => {
  it("raises PHASE_NOT_FOUND when phase id is absent", async () => {
    await setupPhase([{ id: "P1-T1" }]);
    await expect(
      runPhaseRunbook({ cwd, phaseId: "P99" }),
    ).rejects.toMatchObject({
      code: "PHASE_NOT_FOUND",
    });
  });

  it("does NOT introduce new error codes — only reuses PHASE_NOT_FOUND", async () => {
    await setupPhase([{ id: "P1-T1" }]);
    try {
      await runPhaseRunbook({ cwd, phaseId: "P99" });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      expect(code).toBe("PHASE_NOT_FOUND");
    }
  });
});
