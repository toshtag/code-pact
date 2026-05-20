import { describe, expect, it } from "vitest";
import { buildPhaseRunbook } from "../../../../src/core/runbook/build-phase-runbook.ts";
import type { Phase } from "../../../../src/core/schemas/phase.ts";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import type { Task } from "../../../../src/core/schemas/task.ts";

function task(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? "P1-T1",
    type: "feature",
    ambiguity: "low",
    risk: "low",
    context_size: "small",
    write_surface: "low",
    verification_strength: "medium",
    expected_duration: "short",
    status: "planned",
    ...overrides,
  };
}

function phase(tasks: Task[], phaseStatus: Phase["status"] = "planned"): Phase {
  return {
    id: "P1",
    name: "Test Phase",
    weight: 10,
    confidence: "medium",
    risk: "low",
    status: phaseStatus,
    objective: "Test phase for runbook builder",
    definition_of_done: ["all task tests pass"],
    verification: { commands: ["echo ok"] },
    tasks,
  };
}

function ev(task_id: string, status: ProgressEvent["status"]): ProgressEvent {
  return {
    task_id,
    status,
    at: "2026-05-20T00:00:00+00:00",
    actor: "agent",
    ...(status === "blocked" ? { reason: "test blocker" } : {}),
  } as ProgressEvent;
}

describe("buildPhaseRunbook", () => {
  describe("step shape invariants", () => {
    it("every step has exactly one of command / manual_action non-null", () => {
      const result = buildPhaseRunbook({
        phase: phase([
          task({ id: "P1-T1" }),
          task({ id: "P1-T2", status: "planned" }),
        ]),
        events: [
          ev("P1-T1", "started"),
          ev("P1-T1", "done"),
          ev("P1-T2", "started"),
          ev("P1-T2", "blocked"),
        ],
      });
      for (const step of result.next_steps) {
        const hasCommand = step.command !== null;
        const hasManual = step.manual_action !== null;
        expect(hasCommand).not.toBe(hasManual);
      }
    });
  });

  describe("histograms", () => {
    it("computes task_histogram across all derived states", () => {
      const result = buildPhaseRunbook({
        phase: phase([
          task({ id: "P1-T1" }),
          task({ id: "P1-T2" }),
          task({ id: "P1-T3" }),
          task({ id: "P1-T4" }),
        ]),
        events: [
          ev("P1-T2", "started"),
          ev("P1-T3", "started"),
          ev("P1-T3", "done"),
          ev("P1-T4", "started"),
          ev("P1-T4", "blocked"),
        ],
      });
      expect(result.phase_summary.task_histogram).toEqual({
        planned: 1,
        started: 1,
        blocked: 1,
        resumed: 0,
        done: 1,
        failed: 0,
      });
    });

    it("counts done-but-design-not-done into drift_histogram", () => {
      const result = buildPhaseRunbook({
        phase: phase([task({ id: "P1-T1" }), task({ id: "P1-T2" })]),
        events: [
          ev("P1-T1", "started"),
          ev("P1-T1", "done"),
          ev("P1-T2", "started"),
          ev("P1-T2", "done"),
        ],
      });
      expect(result.phase_summary.drift_histogram["done-but-design-not-done"]).toBe(2);
      expect(result.phase_summary.drift_histogram.manual_review).toBe(0);
      expect(result.phase_summary.drift_histogram.consistent).toBe(0);
    });

    it("counts blocked + failed into manual_review in drift_histogram", () => {
      const result = buildPhaseRunbook({
        phase: phase([task({ id: "P1-T1" }), task({ id: "P1-T2" })]),
        events: [
          ev("P1-T1", "started"),
          ev("P1-T1", "blocked"),
          ev("P1-T2", "started"),
          ev("P1-T2", "failed"),
        ],
      });
      expect(result.phase_summary.drift_histogram.manual_review).toBe(2);
    });
  });

  describe("priority order", () => {
    it("blocked tasks come first (resume guidance, blocking)", () => {
      const result = buildPhaseRunbook({
        phase: phase([
          task({ id: "P1-T1" }), // planned
          task({ id: "P1-T2" }), // blocked
        ]),
        events: [ev("P1-T2", "started"), ev("P1-T2", "blocked")],
      });
      // First two steps: blocked manual_action + task resume.
      expect(result.next_steps[0]!.manual_action).toContain("P1-T2");
      expect(result.next_steps[0]!.blocking).toBe(true);
      expect(result.next_steps[1]!.command).toContain("task resume P1-T2");
      expect(result.next_steps[1]!.blocking).toBe(true);
    });

    it("failed / complex-drift tasks come second (manual_review, blocking)", () => {
      const result = buildPhaseRunbook({
        phase: phase([
          task({ id: "P1-T1", status: "done" }),
          task({ id: "P1-T2" }),
        ]),
        // P1-T1: design done + derived blocked → done-blocked-conflict drift
        // P1-T2: planned + no events
        events: [ev("P1-T1", "started"), ev("P1-T1", "blocked")],
      });
      // The drift task gets a manual_review step.
      const manualReview = result.next_steps.find((s) =>
        s.manual_action?.includes("plan analyze"),
      );
      expect(manualReview).toBeDefined();
      expect(manualReview!.blocking).toBe(true);
    });

    it("eligible reconcile batch emits ONE step covering every flip candidate", () => {
      const result = buildPhaseRunbook({
        phase: phase([
          task({ id: "P1-T1" }),
          task({ id: "P1-T2" }),
          task({ id: "P1-T3" }),
        ]),
        events: [
          ev("P1-T1", "started"),
          ev("P1-T1", "done"),
          ev("P1-T2", "started"),
          ev("P1-T2", "done"),
          ev("P1-T3", "started"),
          ev("P1-T3", "done"),
        ],
      });
      const reconcileSteps = result.next_steps.filter((s) =>
        s.command?.includes("phase reconcile"),
      );
      expect(reconcileSteps.length).toBe(1);
      expect(reconcileSteps[0]!.command).toBe(
        "code-pact phase reconcile P1 --write",
      );
      expect(reconcileSteps[0]!.reason).toContain("P1-T1");
      expect(reconcileSteps[0]!.reason).toContain("P1-T3");
      expect(reconcileSteps[0]!.safety_note).toContain("dry-run");
    });

    it("in-progress tasks emit task runbook hints (non-blocking)", () => {
      const result = buildPhaseRunbook({
        phase: phase([task({ id: "P1-T1" })]),
        events: [ev("P1-T1", "started")],
      });
      const hint = result.next_steps.find((s) =>
        s.command?.includes("task runbook P1-T1"),
      );
      expect(hint).toBeDefined();
      expect(hint!.blocking).toBe(false);
    });

    it("untouched ready tasks emit primary loop only when depends_on is satisfied", () => {
      const result = buildPhaseRunbook({
        phase: phase([
          task({ id: "P1-T1" }),
          task({ id: "P1-T2", depends_on: ["P1-T1"] }),
        ]),
        events: [],
      });
      // P1-T1 has no deps, gets primary loop.
      const startT1 = result.next_steps.find(
        (s) => s.command === "code-pact task start P1-T1",
      );
      expect(startT1).toBeDefined();
      // P1-T2 depends on planned P1-T1 → no primary loop emitted.
      const startT2 = result.next_steps.find(
        (s) => s.command === "code-pact task start P1-T2",
      );
      expect(startT2).toBeUndefined();
    });

    it("phase-status advisory step appears last when phase candidate is done", () => {
      const result = buildPhaseRunbook({
        phase: phase(
          [
            task({ id: "P1-T1", status: "done" }),
            task({ id: "P1-T2", status: "done" }),
          ],
          "planned", // phase itself still planned
        ),
        events: [
          ev("P1-T1", "started"),
          ev("P1-T1", "done"),
          ev("P1-T2", "started"),
          ev("P1-T2", "done"),
        ],
      });
      const advisory = result.next_steps[result.next_steps.length - 1]!;
      expect(advisory.manual_action).toContain("Flip the phase");
      expect(advisory.manual_action).toContain("P1");
      expect(advisory.blocking).toBe(false);
    });

    it("phase-status advisory NOT emitted when phase is already done", () => {
      const result = buildPhaseRunbook({
        phase: phase(
          [
            task({ id: "P1-T1", status: "done" }),
            task({ id: "P1-T2", status: "done" }),
          ],
          "done",
        ),
        events: [
          ev("P1-T1", "started"),
          ev("P1-T1", "done"),
          ev("P1-T2", "started"),
          ev("P1-T2", "done"),
        ],
      });
      const advisory = result.next_steps.find((s) =>
        s.manual_action?.includes("Flip the phase"),
      );
      expect(advisory).toBeUndefined();
    });
  });

  describe("phase_status_candidate", () => {
    it("returns done when every task would be done post-reconcile", () => {
      const result = buildPhaseRunbook({
        phase: phase([task({ id: "P1-T1" }), task({ id: "P1-T2" })]),
        events: [
          ev("P1-T1", "started"),
          ev("P1-T1", "done"),
          ev("P1-T2", "started"),
          ev("P1-T2", "done"),
        ],
      });
      expect(result.phase_summary.phase_status_candidate).toBe("done");
    });

    it("returns in_progress when any task is started", () => {
      const result = buildPhaseRunbook({
        phase: phase([task({ id: "P1-T1" }), task({ id: "P1-T2" })]),
        events: [ev("P1-T1", "started")],
      });
      expect(result.phase_summary.phase_status_candidate).toBe("in_progress");
    });

    it("returns planned when nothing has started", () => {
      const result = buildPhaseRunbook({
        phase: phase([task({ id: "P1-T1" })]),
        events: [],
      });
      expect(result.phase_summary.phase_status_candidate).toBe("planned");
    });
  });

  it("empty phase (no tasks) → no steps, candidate planned", () => {
    const result = buildPhaseRunbook({
      phase: phase([]),
      events: [],
    });
    expect(result.next_steps).toEqual([]);
    expect(result.phase_summary.phase_status_candidate).toBe("planned");
    expect(result.phase_summary.task_histogram).toEqual({
      planned: 0,
      started: 0,
      blocked: 0,
      resumed: 0,
      done: 0,
      failed: 0,
    });
  });

  it("phase_status_note carries the advisory text", () => {
    const result = buildPhaseRunbook({
      phase: phase([task({ id: "P1-T1" })]),
      events: [],
    });
    expect(result.phase_summary.phase_status_note).toContain("advisory");
    expect(result.phase_summary.phase_status_note).toContain("never written");
  });
});
