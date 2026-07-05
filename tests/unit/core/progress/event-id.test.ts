import { describe, expect, it } from "vitest";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import {
  atCompact,
  canonicalizeEvent,
  computeEventId,
  eventFileName,
  normalizeAt,
} from "../../../../src/core/progress/event-id.ts";

const base: ProgressEvent = {
  task_id: "P5-T2",
  status: "done",
  at: "2026-05-18T12:38:10.594Z",
  actor: "agent",
  agent: "claude-code",
  evidence: ["commands", "decision"],
  source: "loop",
};

describe("event-id — content-derived identity (B5)", () => {
  it("is a full 64-char sha256 hex digest", () => {
    expect(computeEventId(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across timezone offset vs Z for the same instant", () => {
    // 12:38:10.594Z === 21:38:10.594+09:00
    const offset: ProgressEvent = { ...base, at: "2026-05-18T21:38:10.594+09:00" };
    expect(computeEventId(offset)).toBe(computeEventId(base));
  });

  it("is independent of object key order (canonical sort)", () => {
    const reordered = {
      source: "loop",
      evidence: ["commands", "decision"],
      agent: "claude-code",
      actor: "agent",
      at: "2026-05-18T12:38:10.594Z",
      status: "done",
      task_id: "P5-T2",
    } as ProgressEvent;
    expect(computeEventId(reordered)).toBe(computeEventId(base));
  });

  it("treats an absent optional the same as an explicit undefined", () => {
    const explicitUndef = { ...base, notes: undefined } as ProgressEvent;
    expect(computeEventId(explicitUndef)).toBe(computeEventId(base));
  });

  it("preserves array element order (evidence order is significant)", () => {
    const swapped: ProgressEvent = { ...base, evidence: ["decision", "commands"] };
    expect(computeEventId(swapped)).not.toBe(computeEventId(base));
  });

  it("distinguishes events that differ in any persisted field", () => {
    expect(computeEventId({ ...base, status: "started", source: undefined } as ProgressEvent))
      .not.toBe(computeEventId(base));
    expect(computeEventId({ ...base, task_id: "P5-T3" })).not.toBe(computeEventId(base));
    expect(computeEventId({ ...base, at: "2026-05-18T12:38:10.595Z" })).not.toBe(
      computeEventId(base),
    );
  });

  it("normalizeAt collapses offset forms to UTC ms", () => {
    expect(normalizeAt("2026-05-18T21:38:10.594+09:00")).toBe("2026-05-18T12:38:10.594Z");
  });
});

describe("event-id — author attribution (Collaboration UX RFC D1)", () => {
  it("an author-less event's id is byte-stable across the D1 change (no id churn)", () => {
    // `base` carries no `author`. The new optional field must leave both the
    // canonical JSON and the sha256 of every pre-D1 event byte-for-byte
    // identical. These golden values are the regression lock: if a future change
    // to the canonicalizer or optional-field handling alters them, every existing
    // ledger's derived state would silently change — fail loudly here instead.
    expect(canonicalizeEvent(base)).toBe(
      '{"actor":"agent","agent":"claude-code","at":"2026-05-18T12:38:10.594Z",' +
        '"evidence":["commands","decision"],"source":"loop","status":"done","task_id":"P5-T2"}',
    );
    expect(canonicalizeEvent(base)).not.toContain("author");
    expect(computeEventId(base)).toBe(
      "0dd6124e065b82afe74a4afe7cfba953f437148fc27b0e102893a6b7ded86673",
    );
  });

  it("author is part of the content id — distinct authors → distinct ids", () => {
    const ada = { ...base, author: "Ada" } as ProgressEvent;
    const bo = { ...base, author: "Bo" } as ProgressEvent;
    expect(computeEventId(ada)).not.toBe(computeEventId(base)); // present vs absent
    expect(computeEventId(ada)).not.toBe(computeEventId(bo)); // Ada vs Bo
  });

  it("author sorts into the canonical JSON when present", () => {
    expect(canonicalizeEvent({ ...base, author: "Ada" } as ProgressEvent)).toContain(
      '"author":"Ada"',
    );
  });
});

describe("event-id — filename (B5)", () => {
  it("is <at-compact>-<full-id>.yaml with the full digest", () => {
    const name = eventFileName(base);
    expect(name).toBe(`${atCompact(base.at)}-${computeEventId(base)}.yaml`);
    expect(name).toMatch(/^\d{8}T\d{9}Z-[0-9a-f]{64}\.yaml$/);
  });

  it("atCompact renders the normalized UTC instant compactly", () => {
    expect(atCompact("2026-05-18T21:38:10.594+09:00")).toBe("20260518T123810594Z");
  });

  it("canonicalizeEvent is deterministic JSON (sorted keys, normalized at)", () => {
    expect(canonicalizeEvent(base)).toBe(
      '{"actor":"agent","agent":"claude-code","at":"2026-05-18T12:38:10.594Z",' +
        '"evidence":["commands","decision"],"source":"loop","status":"done","task_id":"P5-T2"}',
    );
  });
});
