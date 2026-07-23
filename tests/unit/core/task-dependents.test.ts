import { describe, expect, it } from "vitest";
import { directTaskDependents } from "../../../src/core/task-dependents.ts";
import type { Phase } from "../../../src/core/schemas/phase.ts";
import type { Task } from "../../../src/core/schemas/task.ts";

const makePhase = (id: string, tasks: Task[]): Phase => ({
  id,
  name: id,
  weight: 1,
  confidence: "high",
  risk: "low",
  status: "planned",
  objective: `objective ${id}`,
  definition_of_done: ["done"],
  verification: { commands: [] },
  tasks,
});

const makeTask = (
  id: string,
  status: Task["status"],
  deps: string[] = [],
): Task => ({
  id,
  type: "feature",
  ambiguity: "low",
  risk: "low",
  context_size: "small",
  write_surface: "low",
  verification_strength: "weak",
  expected_duration: "short",
  status,
  depends_on: deps,
});

describe("directTaskDependents", () => {
  it("returns an empty array when there are no dependents", () => {
    const phase = makePhase("P1", [makeTask("P1-T1", "planned")]);
    expect(directTaskDependents([phase], "P1-T2")).toEqual([]);
  });

  it("returns direct dependents in declaration order", () => {
    const phase = makePhase("P1", [
      makeTask("P1-T1", "planned"),
      makeTask("P1-T2", "planned", ["P1-T1"]),
      makeTask("P1-T3", "planned", ["P1-T1"]),
    ]);
    expect(directTaskDependents([phase], "P1-T1")).toEqual([
      { phase_id: "P1", task_id: "P1-T2", design_status: "planned" },
      { phase_id: "P1", task_id: "P1-T3", design_status: "planned" },
    ]);
  });

  it("includes cancelled dependents too", () => {
    const phase = makePhase("P1", [
      makeTask("P1-T1", "planned"),
      makeTask("P1-T2", "cancelled", ["P1-T1"]),
      makeTask("P1-T3", "planned", ["P1-T1"]),
    ]);
    const dependents = directTaskDependents([phase], "P1-T1");
    expect(dependents.map(d => d.task_id)).toEqual(["P1-T2", "P1-T3"]);
    expect(dependents.map(d => d.design_status)).toEqual([
      "cancelled",
      "planned",
    ]);
  });

  it("collects dependents across phases", () => {
    const p1 = makePhase("P1", [makeTask("P1-T1", "planned")]);
    const p2 = makePhase("P2", [makeTask("P2-T1", "planned", ["P1-T1"])]);
    expect(directTaskDependents([p1, p2], "P1-T1")).toEqual([
      { phase_id: "P2", task_id: "P2-T1", design_status: "planned" },
    ]);
  });
});
