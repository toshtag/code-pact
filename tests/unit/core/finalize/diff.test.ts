import { describe, expect, it } from "vitest";
import {
  computeTaskStatusDiff,
  formatTaskStatusDiff,
  type TaskStatusDiff,
} from "../../../../src/core/finalize/diff.ts";
import type { Phase } from "../../../../src/core/schemas/phase.ts";
import type { Task } from "../../../../src/core/schemas/task.ts";

function task(id: string, status: Task["status"] = "planned"): Task {
  return {
    id,
    type: "feature",
    ambiguity: "low",
    risk: "low",
    context_size: "small",
    write_surface: "low",
    verification_strength: "medium",
    expected_duration: "short",
    status,
  };
}

function phase(tasks: Task[] = []): Phase {
  return {
    id: "P1",
    name: "Foundation",
    weight: 10,
    confidence: "medium",
    risk: "low",
    status: "planned",
    objective: "Test objective long enough",
    definition_of_done: ["does the thing"],
    verification: { commands: ["pnpm test"] },
    tasks,
  };
}

describe("computeTaskStatusDiff", () => {
  it("returns the diff when the task is found and status differs", () => {
    const result = computeTaskStatusDiff({
      file: "design/phases/P1-foundation.yaml",
      phase: phase([task("P1-T1", "planned")]),
      taskId: "P1-T1",
      targetStatus: "done",
    });
    expect(result).toEqual({
      file: "design/phases/P1-foundation.yaml",
      task_id: "P1-T1",
      before: "planned",
      after: "done",
    });
  });

  it("returns null when the task is already at the target status (idempotent)", () => {
    const result = computeTaskStatusDiff({
      file: "design/phases/P1-foundation.yaml",
      phase: phase([task("P1-T1", "done")]),
      taskId: "P1-T1",
      targetStatus: "done",
    });
    expect(result).toBeNull();
  });

  it("returns null when the task is not in the phase", () => {
    const result = computeTaskStatusDiff({
      file: "design/phases/P1-foundation.yaml",
      phase: phase([task("P1-T1", "planned")]),
      taskId: "P1-T99",
      targetStatus: "done",
    });
    expect(result).toBeNull();
  });

  it("returns null when phase has no tasks", () => {
    const result = computeTaskStatusDiff({
      file: "design/phases/P1-foundation.yaml",
      phase: phase([]),
      taskId: "P1-T1",
      targetStatus: "done",
    });
    expect(result).toBeNull();
  });

  it("handles transitions other than planned -> done (the helper is general)", () => {
    const result = computeTaskStatusDiff({
      file: "design/phases/P1-foundation.yaml",
      phase: phase([task("P1-T1", "in_progress")]),
      taskId: "P1-T1",
      targetStatus: "done",
    });
    expect(result?.before).toBe("in_progress");
    expect(result?.after).toBe("done");
  });
});

describe("formatTaskStatusDiff", () => {
  it("renders the canonical one-line form", () => {
    const diff: TaskStatusDiff = {
      file: "design/phases/P1-foundation.yaml",
      task_id: "P1-T1",
      before: "planned",
      after: "done",
    };
    expect(formatTaskStatusDiff(diff)).toBe(
      "design/phases/P1-foundation.yaml: P1-T1 planned -> done",
    );
  });
});
