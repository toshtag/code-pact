import { describe, expect, it } from "vitest";

import {
  detectTaskDependsOnCycle,
  detectTaskDependsOnUnresolved,
} from "../../../../src/core/plan/checks.ts";
import type { PhaseEntry } from "../../../../src/core/plan/state.ts";
import type { Phase } from "../../../../src/core/schemas/phase.ts";

function makeEntry(phase: Phase, path = `design/phases/${phase.id}.yaml`): PhaseEntry {
  return {
    ref: { id: phase.id, path, weight: phase.weight },
    absPath: `/abs/${path}`,
    phase,
  };
}

function makePhase(id: string, tasks: Array<{ id: string; depends_on?: string[] }>): Phase {
  return {
    id,
    name: id,
    weight: 10,
    confidence: "medium",
    risk: "medium",
    status: "planned",
    objective: `objective for ${id}`,
    definition_of_done: ["x"],
    verification: { commands: ["pnpm test"] },
    tasks: tasks.map((t) => ({
      id: t.id,
      type: "feature",
      ambiguity: "medium",
      risk: "medium",
      context_size: "medium",
      write_surface: "medium",
      verification_strength: "medium",
      expected_duration: "medium",
      status: "planned",
      description: t.id,
      depends_on: t.depends_on,
    })),
  };
}

describe("detectTaskDependsOnUnresolved (v1.9 cross-phase)", () => {
  it("treats cross-phase reference as resolved (no warning)", () => {
    const phases = [
      makeEntry(makePhase("PA", [{ id: "PA-T1", depends_on: ["PB-T1"] }])),
      makeEntry(makePhase("PB", [{ id: "PB-T1" }])),
    ];
    expect(detectTaskDependsOnUnresolved(phases)).toEqual([]);
  });

  it("typo still surfaces UNRESOLVED", () => {
    const phases = [
      makeEntry(makePhase("PA", [{ id: "PA-T1", depends_on: ["PB-Txx"] }])),
      makeEntry(makePhase("PB", [{ id: "PB-T1" }])),
    ];
    const issues = detectTaskDependsOnUnresolved(phases);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_DEPENDS_ON_UNRESOLVED");
    expect(issues[0]?.details).toEqual({ value: "PB-Txx" });
  });

  it("same-phase reference still resolves (no false positive)", () => {
    const phases = [
      makeEntry(makePhase("PA", [
        { id: "PA-T1" },
        { id: "PA-T2", depends_on: ["PA-T1"] },
      ])),
    ];
    expect(detectTaskDependsOnUnresolved(phases)).toEqual([]);
  });
});

describe("detectTaskDependsOnCycle", () => {
  it("returns empty for empty graph", () => {
    expect(detectTaskDependsOnCycle([])).toEqual([]);
  });

  it("returns empty for acyclic graph", () => {
    const phases = [
      makeEntry(makePhase("PA", [
        { id: "PA-T1" },
        { id: "PA-T2", depends_on: ["PA-T1"] },
        { id: "PA-T3", depends_on: ["PA-T2"] },
      ])),
    ];
    expect(detectTaskDependsOnCycle(phases)).toEqual([]);
  });

  it("ignores self-cycles (left to SELF_REFERENCE)", () => {
    const phases = [
      makeEntry(makePhase("PA", [{ id: "PA-T1", depends_on: ["PA-T1"] }])),
    ];
    expect(detectTaskDependsOnCycle(phases)).toEqual([]);
  });

  it("detects 2-node cycle", () => {
    const phases = [
      makeEntry(makePhase("PA", [
        { id: "PA-T1", depends_on: ["PA-T2"] },
        { id: "PA-T2", depends_on: ["PA-T1"] },
      ])),
    ];
    const issues = detectTaskDependsOnCycle(phases);
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.code === "TASK_DEPENDS_ON_CYCLE")).toBe(true);
    expect(issues[0]?.details).toEqual({ cycle: ["PA-T1", "PA-T2"] });
    expect(issues[1]?.details).toEqual({ cycle: ["PA-T1", "PA-T2"] });
  });

  it("detects 3-node cycle", () => {
    const phases = [
      makeEntry(makePhase("PA", [
        { id: "PA-T1", depends_on: ["PA-T2"] },
        { id: "PA-T2", depends_on: ["PA-T3"] },
        { id: "PA-T3", depends_on: ["PA-T1"] },
      ])),
    ];
    const issues = detectTaskDependsOnCycle(phases);
    expect(issues).toHaveLength(3);
    expect(issues[0]?.details).toEqual({ cycle: ["PA-T1", "PA-T2", "PA-T3"] });
  });

  it("detects cross-phase 2-node cycle", () => {
    const phases = [
      makeEntry(makePhase("PA", [{ id: "PA-T1", depends_on: ["PB-T1"] }])),
      makeEntry(makePhase("PB", [{ id: "PB-T1", depends_on: ["PA-T1"] }])),
    ];
    const issues = detectTaskDependsOnCycle(phases);
    expect(issues).toHaveLength(2);
    const taskIds = issues.map((i) => i.task_id).sort();
    expect(taskIds).toEqual(["PA-T1", "PB-T1"]);
  });

  it("4-node cycle with extra dependent outside the cycle", () => {
    const phases = [
      makeEntry(makePhase("PA", [
        { id: "PA-T1", depends_on: ["PA-T2"] },
        { id: "PA-T2", depends_on: ["PA-T3"] },
        { id: "PA-T3", depends_on: ["PA-T4"] },
        { id: "PA-T4", depends_on: ["PA-T1"] },
        { id: "PA-T5", depends_on: ["PA-T1"] },
      ])),
    ];
    const issues = detectTaskDependsOnCycle(phases);
    expect(issues).toHaveLength(4);
    const taskIds = issues.map((i) => i.task_id).sort();
    expect(taskIds).toEqual(["PA-T1", "PA-T2", "PA-T3", "PA-T4"]);
  });

  it("multiple disjoint cycles in the same graph", () => {
    const phases = [
      makeEntry(makePhase("PA", [
        { id: "PA-T1", depends_on: ["PA-T2"] },
        { id: "PA-T2", depends_on: ["PA-T1"] },
      ])),
      makeEntry(makePhase("PB", [
        { id: "PB-T1", depends_on: ["PB-T2"] },
        { id: "PB-T2", depends_on: ["PB-T1"] },
      ])),
    ];
    const issues = detectTaskDependsOnCycle(phases);
    expect(issues).toHaveLength(4);
  });

  it("does not false-positive on deep linear chain", () => {
    const tasks = Array.from({ length: 50 }, (_, i) => ({
      id: `PA-T${i + 1}`,
      depends_on: i === 0 ? undefined : [`PA-T${i}`],
    }));
    const phases = [makeEntry(makePhase("PA", tasks))];
    expect(detectTaskDependsOnCycle(phases)).toEqual([]);
  });

  it("cycle through cross-phase + self-cycle on one node (only multi-node reported)", () => {
    const phases = [
      makeEntry(makePhase("PA", [
        { id: "PA-T1", depends_on: ["PA-T1", "PB-T1"] },
      ])),
      makeEntry(makePhase("PB", [
        { id: "PB-T1", depends_on: ["PA-T1"] },
      ])),
    ];
    const issues = detectTaskDependsOnCycle(phases);
    expect(issues).toHaveLength(2);
    const cycle = issues[0]?.details?.cycle as string[];
    expect(cycle.sort()).toEqual(["PA-T1", "PB-T1"]);
  });

  it("severity is error", () => {
    const phases = [
      makeEntry(makePhase("PA", [
        { id: "PA-T1", depends_on: ["PA-T2"] },
        { id: "PA-T2", depends_on: ["PA-T1"] },
      ])),
    ];
    const issues = detectTaskDependsOnCycle(phases);
    expect(issues[0]?.severity).toBe("error");
  });
});
