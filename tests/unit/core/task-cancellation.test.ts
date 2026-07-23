import { describe, expect, it } from "vitest";
import {
  assertTaskLifecycleNotCancelled,
  assertTaskCancelEligibility,
  assertNoNonCancelledTaskDependents,
  TASK_CANCELLED_CODE,
  TASK_CANCEL_NOT_ALLOWED_CODE,
  TASK_CANCEL_DEPENDENTS_EXIST_CODE,
} from "../../../src/core/task-cancellation.ts";
import type { DirectDependent } from "../../../src/core/task-dependents.ts";

describe("assertTaskLifecycleNotCancelled", () => {
  it("throws TASK_CANCELLED when design status is cancelled", () => {
    expect(() =>
      assertTaskLifecycleNotCancelled("P1-T1", "cancelled", "planned"),
    ).toThrow(
      expect.objectContaining({
        code: TASK_CANCELLED_CODE,
        task_id: "P1-T1",
      }),
    );
  });

  it("does not throw for non-cancelled design statuses", () => {
    expect(() =>
      assertTaskLifecycleNotCancelled("P1-T1", "planned", "planned"),
    ).not.toThrow();
    expect(() =>
      assertTaskLifecycleNotCancelled("P1-T1", "done", "done"),
    ).not.toThrow();
  });

  it("includes derived state in the error", () => {
    let caught: unknown;
    try {
      assertTaskLifecycleNotCancelled("P1-T1", "cancelled", "started");
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      code: TASK_CANCELLED_CODE,
      derived_state: "started",
    });
  });
});

describe("assertTaskCancelEligibility", () => {
  it("throws TASK_CANCEL_NOT_ALLOWED when design status is done", () => {
    expect(() =>
      assertTaskCancelEligibility("P1-T1", "done", "planned"),
    ).toThrow(
      expect.objectContaining({
        code: TASK_CANCEL_NOT_ALLOWED_CODE,
      }),
    );
  });

  it("throws TASK_CANCEL_NOT_ALLOWED when derived state is done", () => {
    expect(() =>
      assertTaskCancelEligibility("P1-T1", "planned", "done"),
    ).toThrow(
      expect.objectContaining({
        code: TASK_CANCEL_NOT_ALLOWED_CODE,
      }),
    );
  });

  it("does not throw for non-terminal states", () => {
    expect(() =>
      assertTaskCancelEligibility("P1-T1", "planned", "planned"),
    ).not.toThrow();
    expect(() =>
      assertTaskCancelEligibility("P1-T1", "planned", "started"),
    ).not.toThrow();
    expect(() =>
      assertTaskCancelEligibility("P1-T1", "planned", "blocked"),
    ).not.toThrow();
  });
});

describe("assertNoNonCancelledTaskDependents", () => {
  it("throws TASK_CANCEL_DEPENDENTS_EXIST for non-cancelled dependents", () => {
    const dependents: DirectDependent[] = [
      { phase_id: "P1", task_id: "P1-T2", design_status: "planned" },
    ];
    expect(() =>
      assertNoNonCancelledTaskDependents("P1-T1", dependents),
    ).toThrow(
      expect.objectContaining({
        code: TASK_CANCEL_DEPENDENTS_EXIST_CODE,
        task_id: "P1-T1",
      }),
    );
  });

  it("does not throw when all dependents are cancelled", () => {
    const dependents: DirectDependent[] = [
      { phase_id: "P1", task_id: "P1-T2", design_status: "cancelled" },
    ];
    expect(() =>
      assertNoNonCancelledTaskDependents("P1-T1", dependents),
    ).not.toThrow();
  });

  it("does not throw when there are no dependents", () => {
    expect(() =>
      assertNoNonCancelledTaskDependents("P1-T1", []),
    ).not.toThrow();
  });
});
