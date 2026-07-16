import { describe, expect, it } from "vitest";
// @ts-expect-error The checker is a Node-executed .mjs script; this test imports
// its exported pure evaluation helpers directly to avoid subprocess fixtures.
import { evaluateDevelopmentEfficiency, isDesignOnlyTask } from "../../../scripts/check-development-efficiency.mjs";

const baseline = { task_id: "P72-T4", at: "2026-07-16T00:00:00.000Z", file: "baseline" };
const designTask = { writes: ["design/phases/P1.yaml", "docs/example.md"] };
const runtimeTask = { writes: ["src/core/example.ts", "tests/unit/example.test.ts"] };

function events(taskIds: string[]) {
  return [
    baseline,
    ...taskIds.map((task_id, index) => ({
      task_id,
      at: `2026-07-16T00:00:0${index + 1}.000Z`,
      file: `${index}.yaml`,
    })),
  ];
}

function tasks() {
  return new Map<string, unknown>([
    ["D1", designTask],
    ["D2", designTask],
    ["D3", designTask],
    ["R1", runtimeTask],
  ]);
}

describe("check-development-efficiency", () => {
  it("classifies design-only and implementation tasks", () => {
    expect(isDesignOnlyTask(designTask)).toBe(true);
    expect(isDesignOnlyTask(runtimeTask)).toBe(false);
    expect(isDesignOnlyTask({ writes: ["scripts/check.mjs"] })).toBe(false);
    expect(isDesignOnlyTask({ writes: [] })).toBe(true);
  });

  it("allows one completed design-only task", () => {
    expect(
      evaluateDevelopmentEfficiency({ doneEvents: events(["D1"]), tasks: tasks() }),
    ).toMatchObject({
      consecutive_design_only_tasks: 1,
      max_consecutive_design_only_tasks: 1,
      status: "pass",
    });
  });

  it("fails on two current consecutive design-only tasks", () => {
    expect(
      evaluateDevelopmentEfficiency({ doneEvents: events(["D1", "D2"]), tasks: tasks() }),
    ).toMatchObject({
      consecutive_design_only_tasks: 2,
      max_consecutive_design_only_tasks: 2,
      status: "fail",
      code: "DEVELOPMENT_DESIGN_LOOP_EXCEEDED",
    });
  });

  it("recovers after a runtime task while preserving historical maximum", () => {
    expect(
      evaluateDevelopmentEfficiency({
        doneEvents: events(["D1", "D2", "R1"]),
        tasks: tasks(),
      }),
    ).toMatchObject({
      consecutive_design_only_tasks: 0,
      max_consecutive_design_only_tasks: 2,
      status: "pass",
    });
  });

  it("fails prospectively when the next task would create a design loop", () => {
    expect(
      evaluateDevelopmentEfficiency({
        doneEvents: events(["D1"]),
        tasks: tasks(),
        nextTask: "D2",
      }),
    ).toMatchObject({
      next_task: "D2",
      next_task_design_only: true,
      prospective_consecutive_design_only_tasks: 2,
      status: "fail",
      code: "DEVELOPMENT_DESIGN_LOOP_EXCEEDED",
    });
  });

  it("passes prospectively for a runtime next task after design-only work", () => {
    expect(
      evaluateDevelopmentEfficiency({
        doneEvents: events(["D1"]),
        tasks: tasks(),
        nextTask: "R1",
      }),
    ).toMatchObject({
      next_task_design_only: false,
      prospective_consecutive_design_only_tasks: 0,
      status: "pass",
    });
  });

  it("passes prospectively for a design next task after runtime work", () => {
    expect(
      evaluateDevelopmentEfficiency({
        doneEvents: events(["R1"]),
        tasks: tasks(),
        nextTask: "D1",
      }),
    ).toMatchObject({
      consecutive_design_only_tasks: 0,
      prospective_consecutive_design_only_tasks: 1,
      status: "pass",
    });
  });

  it("treats unknown next task as configuration failure", () => {
    expect(
      evaluateDevelopmentEfficiency({
        doneEvents: events(["R1"]),
        tasks: tasks(),
        nextTask: "NOPE",
      }),
    ).toMatchObject({
      status: "fail",
      code: "CONFIG_ERROR",
      next_task: "NOPE",
    });
  });
});
