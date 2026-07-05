import { describe, expect, it } from "vitest";
import {
  buildTaskPhaseIndex,
  resolveDependsOnStates,
} from "../../../../src/core/runbook/depends-on.ts";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import type { Task } from "../../../../src/core/schemas/task.ts";

const baseTask: Task = {
  id: "P1-T1",
  type: "feature",
  ambiguity: "low",
  risk: "low",
  context_size: "small",
  write_surface: "low",
  verification_strength: "medium",
  expected_duration: "short",
  status: "planned",
};

function ev(task_id: string, status: ProgressEvent["status"]): ProgressEvent {
  return {
    task_id,
    status,
    at: "2026-05-20T00:00:00+00:00",
    actor: "agent",
    ...(status === "blocked" ? { reason: "test blocker" } : {}),
  } as ProgressEvent;
}

describe("resolveDependsOnStates", () => {
  it("returns empty array when depends_on is undefined", () => {
    expect(resolveDependsOnStates([], baseTask)).toEqual([]);
  });

  it("returns empty array when depends_on is an empty array", () => {
    expect(
      resolveDependsOnStates([], { ...baseTask, depends_on: [] }),
    ).toEqual([]);
  });

  it("marks a dependency satisfied when its derived state is done", () => {
    const events: ProgressEvent[] = [
      ev("P1-T0", "started"),
      ev("P1-T0", "done"),
    ];
    const result = resolveDependsOnStates(events, {
      ...baseTask,
      depends_on: ["P1-T0"],
    });
    expect(result).toEqual([
      { task_id: "P1-T0", current: "done", satisfied: true },
    ]);
  });

  it("marks a dependency unsatisfied when its derived state is started", () => {
    const events: ProgressEvent[] = [ev("P1-T0", "started")];
    const result = resolveDependsOnStates(events, {
      ...baseTask,
      depends_on: ["P1-T0"],
    });
    expect(result).toEqual([
      { task_id: "P1-T0", current: "started", satisfied: false },
    ]);
  });

  it("marks a dependency unsatisfied when no events exist for it (planned)", () => {
    const result = resolveDependsOnStates([], {
      ...baseTask,
      depends_on: ["P1-T0"],
    });
    expect(result).toEqual([
      { task_id: "P1-T0", current: "planned", satisfied: false },
    ]);
  });

  it("resolves multiple dependencies independently", () => {
    const events: ProgressEvent[] = [
      ev("P1-T0", "done"),
      ev("P1-T1", "started"),
    ];
    const result = resolveDependsOnStates(events, {
      ...baseTask,
      id: "P1-T2",
      depends_on: ["P1-T0", "P1-T1", "P1-T99"],
    });
    expect(result).toEqual([
      { task_id: "P1-T0", current: "done", satisfied: true },
      { task_id: "P1-T1", current: "started", satisfied: false },
      { task_id: "P1-T99", current: "planned", satisfied: false },
    ]);
  });
});

describe("resolveDependsOnStates (v1.9 cross-phase)", () => {
  const index = buildTaskPhaseIndex([
    { id: "P1", tasks: [{ id: "P1-T1" }, { id: "P1-T2" }] },
    { id: "P2", tasks: [{ id: "P2-T1" }] },
  ]);

  it("omits phase_id for same-phase resolution", () => {
    const result = resolveDependsOnStates(
      [],
      { ...baseTask, id: "P1-T2", depends_on: ["P1-T1"] },
      { ownPhaseId: "P1", taskPhaseIndex: index },
    );
    expect(result).toEqual([
      { task_id: "P1-T1", current: "planned", satisfied: false },
    ]);
    expect(result[0]).not.toHaveProperty("phase_id");
  });

  it("populates phase_id for cross-phase resolution", () => {
    const result = resolveDependsOnStates(
      [],
      { ...baseTask, id: "P1-T2", depends_on: ["P2-T1"] },
      { ownPhaseId: "P1", taskPhaseIndex: index },
    );
    expect(result[0]).toEqual({
      task_id: "P2-T1",
      current: "planned",
      satisfied: false,
      phase_id: "P2",
    });
  });

  it("mixed same-phase + cross-phase deps in one resolve call", () => {
    const result = resolveDependsOnStates(
      [],
      { ...baseTask, id: "P1-T2", depends_on: ["P1-T1", "P2-T1"] },
      { ownPhaseId: "P1", taskPhaseIndex: index },
    );
    expect(result).toHaveLength(2);
    expect(result[0]).not.toHaveProperty("phase_id");
    expect(result[1]?.phase_id).toBe("P2");
  });

  it("missing index keeps legacy behaviour (no phase_id field)", () => {
    const result = resolveDependsOnStates(
      [],
      { ...baseTask, id: "P1-T2", depends_on: ["P2-T1"] },
    );
    expect(result[0]).not.toHaveProperty("phase_id");
  });

  it("buildTaskPhaseIndex picks first occurrence on duplicate id", () => {
    const dupIndex = buildTaskPhaseIndex([
      { id: "PA", tasks: [{ id: "T-shared" }] },
      { id: "PB", tasks: [{ id: "T-shared" }] },
    ]);
    expect(dupIndex.get("T-shared")).toBe("PA");
  });
});
