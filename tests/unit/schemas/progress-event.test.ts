import { describe, it, expect } from "vitest";
import { ProgressEvent, ProgressLog } from "../../../src/core/schemas/progress-event.ts";

const VALID_EVENT = {
  task_id: "P1-T1",
  status: "done",
  at: "2026-05-15T10:00:00+09:00",
  actor: "human",
  evidence: ["pnpm test"],
};

describe("ProgressEvent", () => {
  it("accepts a valid done event", () => {
    const e = ProgressEvent.parse(VALID_EVENT);
    expect(e.task_id).toBe("P1-T1");
    expect(e.status).toBe("done");
  });

  it("accepts an event without evidence", () => {
    const { evidence: _, ...rest } = VALID_EVENT as Record<string, unknown>;
    const e = ProgressEvent.parse(rest);
    expect(e.evidence).toBeUndefined();
  });

  it("rejects an invalid datetime", () => {
    expect(() => ProgressEvent.parse({ ...VALID_EVENT, at: "not-a-date" })).toThrow();
  });

  it("rejects an invalid status", () => {
    expect(() => ProgressEvent.parse({ ...VALID_EVENT, status: "wip" })).toThrow();
  });

  it("rejects missing task_id", () => {
    const { task_id: _, ...rest } = VALID_EVENT as Record<string, unknown>;
    expect(() => ProgressEvent.parse(rest)).toThrow();
  });

  it("accepts an event with agent (v0.2+)", () => {
    const e = ProgressEvent.parse({ ...VALID_EVENT, agent: "claude-code" });
    expect(e.agent).toBe("claude-code");
  });

  it("accepts an event without agent (v0.1 backward compatibility)", () => {
    const e = ProgressEvent.parse(VALID_EVENT);
    expect(e.agent).toBeUndefined();
  });

  it("rejects empty agent string", () => {
    expect(() => ProgressEvent.parse({ ...VALID_EVENT, agent: "" })).toThrow();
  });
});

describe("ProgressLog", () => {
  it("accepts an empty events array", () => {
    const log = ProgressLog.parse({ events: [] });
    expect(log.events).toHaveLength(0);
  });

  it("accepts multiple events", () => {
    const log = ProgressLog.parse({
      events: [
        VALID_EVENT,
        { ...VALID_EVENT, task_id: "P1-T2", status: "started" },
      ],
    });
    expect(log.events).toHaveLength(2);
  });
});
