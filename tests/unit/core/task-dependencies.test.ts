import { describe, expect, it } from "vitest";
import {
  incompleteTaskDependencyIds,
  resolveTaskDependencyStates,
} from "../../../src/core/task-dependencies.ts";
import type { Task } from "../../../src/core/schemas/task.ts";
import type { ProgressEvent } from "../../../src/core/schemas/progress-event.ts";

const baseTask: Task = {
  id: "P1-T2",
  type: "feature",
  ambiguity: "low",
  risk: "low",
  context_size: "small",
  write_surface: "low",
  verification_strength: "weak",
  expected_duration: "short",
  status: "planned",
};

function event(
  taskId: string,
  status: ProgressEvent["status"],
  at = "2026-05-18T09:00:00.000Z",
): ProgressEvent {
  return {
    task_id: taskId,
    status,
    at,
    actor: "agent",
    agent: "claude-code",
  };
}

describe("resolveTaskDependencyStates", () => {
  it("returns an empty array when the task has no depends_on", () => {
    const task: Task = { ...baseTask };
    expect(resolveTaskDependencyStates([], task)).toEqual([]);
  });

  it("marks a done dependency as satisfied", () => {
    const task: Task = { ...baseTask, depends_on: ["P1-T1"] };
    const events: ProgressEvent[] = [event("P1-T1", "done")];
    expect(resolveTaskDependencyStates(events, task)).toEqual([
      { task_id: "P1-T1", current: "done", satisfied: true },
    ]);
  });

  it("marks a planned dependency as unsatisfied", () => {
    const task: Task = { ...baseTask, depends_on: ["P1-T1"] };
    expect(resolveTaskDependencyStates([], task)).toEqual([
      { task_id: "P1-T1", current: "planned", satisfied: false },
    ]);
  });

  it("preserves declaration order", () => {
    const task: Task = { ...baseTask, depends_on: ["P1-T1", "P1-T2"] };
    const events: ProgressEvent[] = [
      event("P1-T1", "started"),
      event("P1-T2", "done"),
    ];
    const result = resolveTaskDependencyStates(events, task);
    expect(result).toEqual([
      { task_id: "P1-T1", current: "started", satisfied: false },
      { task_id: "P1-T2", current: "done", satisfied: true },
    ]);
    expect(result.map(r => r.task_id)).toEqual(["P1-T1", "P1-T2"]);
  });
});

describe("incompleteTaskDependencyIds", () => {
  it("returns empty when the task has no dependencies", () => {
    expect(incompleteTaskDependencyIds([], baseTask)).toEqual([]);
  });

  it("returns empty when every dependency is done", () => {
    const task: Task = { ...baseTask, depends_on: ["P1-T1", "P1-T2"] };
    const events: ProgressEvent[] = [
      event("P1-T1", "done"),
      event("P1-T2", "done"),
    ];
    expect(incompleteTaskDependencyIds(events, task)).toEqual([]);
  });

  it("returns all ids whose current state is not done, in order", () => {
    const task: Task = { ...baseTask, depends_on: ["P1-T1", "P1-T2", "P1-T3"] };
    const events: ProgressEvent[] = [
      event("P1-T1", "done"),
      event("P1-T2", "started"),
    ];
    expect(incompleteTaskDependencyIds(events, task)).toEqual([
      "P1-T2",
      "P1-T3",
    ]);
  });
});
