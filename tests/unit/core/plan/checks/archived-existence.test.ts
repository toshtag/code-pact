import { describe, expect, it } from "vitest";
import { detectTaskDependsOnUnresolved } from "../../../../../src/core/plan/checks/dependencies.ts";
import { detectOrphanProgressEvents } from "../../../../../src/core/plan/checks/progress-events.ts";
import type { PhaseEntry } from "../../../../../src/core/plan/state.ts";
import type { ProgressEvent } from "../../../../../src/core/schemas/progress-event.ts";

// Step 4a (F + G): archived task ids count as KNOWN for the existence detectors,
// so a cross-phase depends_on into / a ledger event for a hand-deleted COMPLETED
// phase's task is not falsely flagged. The archived set is collision-checked
// upstream, so this is pure existence.

function phaseEntry(id: string, tasks: { id: string; depends_on?: string[] }[]): PhaseEntry {
  return {
    ref: { id, path: `design/phases/${id}.yaml`, weight: 1 },
    absPath: `/x/design/phases/${id}.yaml`,
    phase: {
      id,
      name: id,
      weight: 1,
      tasks: tasks.map((t) => ({
        id: t.id,
        type: "feature",
        ambiguity: "low",
        risk: "low",
        context_size: "small",
        write_surface: "low",
        verification_strength: "medium",
        expected_duration: "short",
        status: "in_progress",
        ...(t.depends_on ? { depends_on: t.depends_on } : {}),
      })),
    } as PhaseEntry["phase"],
  };
}

describe("detectTaskDependsOnUnresolved — archived known ids (F)", () => {
  const phases = [phaseEntry("P2", [{ id: "P2-T1", depends_on: ["P1-T1"] }])];

  it("a dep into an ARCHIVED id is NOT reported", () => {
    const issues = detectTaskDependsOnUnresolved(phases, new Set(["P1-T1"]));
    expect(issues).toEqual([]);
  });

  it("with an EMPTY archived set it still reports (back-compat)", () => {
    const issues = detectTaskDependsOnUnresolved(phases);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("TASK_DEPENDS_ON_UNRESOLVED");
  });

  it("a dep into a genuinely unknown id is still reported even with an archived set", () => {
    const issues = detectTaskDependsOnUnresolved(phases, new Set(["P9-T9"]));
    expect(issues).toHaveLength(1);
  });
});

describe("detectOrphanProgressEvents — archived known ids (G)", () => {
  const event = (task_id: string): ProgressEvent =>
    ({ task_id, status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }) as ProgressEvent;
  const liveOnly = new Set<string>(["P2-T1"]);

  it("an event for an ARCHIVED-known id is NOT flagged orphan", () => {
    const known = { has: (id: string) => liveOnly.has(id) || id === "P1-T1" };
    expect(detectOrphanProgressEvents([event("P1-T1")], known)).toEqual([]);
  });

  it("an event for a genuinely unknown id is still flagged", () => {
    const known = { has: (id: string) => liveOnly.has(id) };
    const issues = detectOrphanProgressEvents([event("GONE-T1")], known);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("ORPHAN_PROGRESS_EVENT");
  });
});
