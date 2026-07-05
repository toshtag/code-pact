import { describe, expect, it } from "vitest";
import {
  assertTransition,
  deriveTaskState,
} from "../../../../src/core/progress/task-state.ts";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";

function ev(
  task_id: string,
  status: ProgressEvent["status"],
  extras: Partial<ProgressEvent> = {},
): ProgressEvent {
  return {
    task_id,
    status,
    at: "2026-05-18T09:00:00+00:00",
    actor: "agent",
    ...extras,
  };
}

describe("deriveTaskState", () => {
  it("returns planned for a task with no events", () => {
    const s = deriveTaskState([], "P1-T1");
    expect(s.current).toBe("planned");
    expect(s.history).toEqual([]);
    expect(s.last_event).toBeUndefined();
  });

  it("derives started after a single started event", () => {
    const events = [ev("P1-T1", "started")];
    const s = deriveTaskState(events, "P1-T1");
    expect(s.current).toBe("started");
    expect(s.history).toHaveLength(1);
  });

  it("derives blocked after started → blocked", () => {
    const events = [
      ev("P1-T1", "started"),
      ev("P1-T1", "blocked", { reason: "review" }),
    ];
    expect(deriveTaskState(events, "P1-T1").current).toBe("blocked");
  });

  it("derives resumed after started → blocked → resumed", () => {
    const events = [
      ev("P1-T1", "started"),
      ev("P1-T1", "blocked", { reason: "review" }),
      ev("P1-T1", "resumed"),
    ];
    expect(deriveTaskState(events, "P1-T1").current).toBe("resumed");
  });

  it("derives done after started → done", () => {
    const events = [ev("P1-T1", "started"), ev("P1-T1", "done")];
    const s = deriveTaskState(events, "P1-T1");
    expect(s.current).toBe("done");
    expect(s.last_event?.status).toBe("done");
  });

  it("filters out events for other task ids", () => {
    const events = [
      ev("P1-T2", "started"),
      ev("P1-T2", "done"),
      ev("P1-T1", "started"),
    ];
    const s = deriveTaskState(events, "P1-T1");
    expect(s.current).toBe("started");
    expect(s.history).toHaveLength(1);
  });
});

describe("assertTransition", () => {
  it("allows planned → started", () => {
    expect(() => assertTransition("planned", "started")).not.toThrow();
  });

  it("allows started → done", () => {
    expect(() => assertTransition("started", "done")).not.toThrow();
  });

  it("allows started → blocked", () => {
    expect(() => assertTransition("started", "blocked")).not.toThrow();
  });

  it("allows blocked → resumed", () => {
    expect(() => assertTransition("blocked", "resumed")).not.toThrow();
  });

  it("allows resumed → done", () => {
    expect(() => assertTransition("resumed", "done")).not.toThrow();
  });

  it("allows resumed → blocked", () => {
    expect(() => assertTransition("resumed", "blocked")).not.toThrow();
  });

  it("allows failed → started (retry path)", () => {
    expect(() => assertTransition("failed", "started")).not.toThrow();
  });

  it("rejects blocked → done with INVALID_TASK_TRANSITION", () => {
    try {
      assertTransition("blocked", "done");
      expect.fail("expected throw");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe(
        "INVALID_TASK_TRANSITION",
      );
    }
  });

  it("rejects planned → done (must go through started)", () => {
    try {
      assertTransition("planned", "done");
      expect.fail("expected throw");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe(
        "INVALID_TASK_TRANSITION",
      );
    }
  });

  it("rejects done → started (terminal)", () => {
    expect(() => assertTransition("done", "started")).toThrow();
  });

  it("rejects started → resumed (must go through blocked)", () => {
    expect(() => assertTransition("started", "resumed")).toThrow();
  });

  it("rejects done → done", () => {
    expect(() => assertTransition("done", "done" as never)).toThrow();
  });
});
