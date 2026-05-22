import { describe, expect, it } from "vitest";

import {
  buildEventDensityRow,
  buildLintHistogram,
  buildPackSizeRow,
  buildVerifySuccessRow,
  rowsToCsv,
} from "../../../../scripts/harness/metrics.ts";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import type { Phase } from "../../../../src/core/schemas/phase.ts";
import type { PlanIssue } from "../../../../src/core/plan/shared.ts";

function ev(
  task_id: string,
  status: ProgressEvent["status"],
  at = "2026-05-20T00:00:00+00:00",
): ProgressEvent {
  return {
    task_id,
    status,
    at,
    actor: "agent",
    ...(status === "blocked" ? { reason: "test blocker" } : {}),
  } as ProgressEvent;
}

function makeTask(overrides: Partial<Phase["tasks"] extends ReadonlyArray<infer T> | undefined ? NonNullable<T> : never> = {}): NonNullable<Phase["tasks"]>[number] {
  return {
    id: "PA-T1",
    type: "feature",
    ambiguity: "medium",
    risk: "medium",
    context_size: "medium",
    write_surface: "medium",
    verification_strength: "medium",
    expected_duration: "medium",
    status: "planned",
    description: "test",
    ...overrides,
  };
}

const phase: Phase = {
  id: "PA",
  name: "PA",
  weight: 10,
  confidence: "medium",
  risk: "medium",
  status: "planned",
  objective: "test",
  definition_of_done: ["x"],
  verification: { commands: ["pnpm test"] },
};

describe("buildPackSizeRow", () => {
  it("computes byte / line / section counts from pack content", () => {
    const content = "# header\n\n## section one\nbody\n## section two\nbody\n";
    const row = buildPackSizeRow(phase, makeTask(), content);
    expect(row.pack_bytes).toBe(content.length);
    expect(row.pack_lines).toBe(content.split("\n").length);
    expect(row.pack_sections).toBe(2);
  });

  it("captures cardinality of task array fields", () => {
    const task = makeTask({
      reads: ["a", "b", "c"],
      writes: ["x"],
      decision_refs: ["d1"],
      acceptance_refs: ["a1", "a2"],
    });
    const row = buildPackSizeRow(phase, task, "## one\n");
    expect(row.reads_glob_count).toBe(3);
    expect(row.writes_glob_count).toBe(1);
    expect(row.decision_refs_count).toBe(1);
    expect(row.acceptance_refs_count).toBe(2);
  });

  it("treats missing fields as zero", () => {
    const row = buildPackSizeRow(phase, makeTask(), "");
    expect(row.reads_glob_count).toBe(0);
    expect(row.writes_glob_count).toBe(0);
    expect(row.decision_refs_count).toBe(0);
    expect(row.acceptance_refs_count).toBe(0);
  });
});

describe("buildVerifySuccessRow", () => {
  it("returns null when task has no done event", () => {
    expect(buildVerifySuccessRow("PA", "PA-T1", [ev("PA-T1", "started")])).toBeNull();
  });

  it("first_pass=true when done has no retries", () => {
    const row = buildVerifySuccessRow("PA", "PA-T1", [
      ev("PA-T1", "started"),
      ev("PA-T1", "done"),
    ]);
    expect(row).toEqual({
      phase_id: "PA",
      task_id: "PA-T1",
      first_pass: true,
      retries: 0,
      verify_runs_total: 1,
    });
  });

  it("counts failed + resumed as retries", () => {
    const row = buildVerifySuccessRow("PA", "PA-T1", [
      ev("PA-T1", "started"),
      ev("PA-T1", "failed"),
      ev("PA-T1", "resumed"),
      ev("PA-T1", "done"),
    ]);
    expect(row?.first_pass).toBe(false);
    expect(row?.retries).toBe(2);
    expect(row?.verify_runs_total).toBe(3);
  });

  it("excludes events from other tasks", () => {
    const row = buildVerifySuccessRow("PA", "PA-T1", [
      ev("PA-T1", "started"),
      ev("PA-T2", "failed"),
      ev("PA-T1", "done"),
    ]);
    expect(row?.retries).toBe(0);
  });
});

describe("buildEventDensityRow", () => {
  it("histograms events by status", () => {
    const row = buildEventDensityRow("PA", "PA-T1", [
      ev("PA-T1", "started", "2026-05-01T00:00:00+00:00"),
      ev("PA-T1", "blocked", "2026-05-02T00:00:00+00:00"),
      ev("PA-T1", "resumed", "2026-05-03T00:00:00+00:00"),
      ev("PA-T1", "done", "2026-05-05T00:00:00+00:00"),
    ]);
    expect(row.started).toBe(1);
    expect(row.blocked).toBe(1);
    expect(row.resumed).toBe(1);
    expect(row.done).toBe(1);
    expect(row.failed).toBe(0);
    expect(row.total_events).toBe(4);
    expect(row.event_span_days).toBe(4);
  });

  it("event_span_days is 0 for single event", () => {
    const row = buildEventDensityRow("PA", "PA-T1", [
      ev("PA-T1", "started"),
    ]);
    expect(row.event_span_days).toBe(0);
  });

  it("returns zero counts when task has no events", () => {
    const row = buildEventDensityRow("PA", "PA-T1", []);
    expect(row.total_events).toBe(0);
    expect(row.started).toBe(0);
  });
});

describe("buildLintHistogram", () => {
  it("buckets issues by (phase, code)", () => {
    const issues: PlanIssue[] = [
      { code: "X", severity: "warning", message: "", phase_id: "PA" },
      { code: "X", severity: "warning", message: "", phase_id: "PA" },
      { code: "Y", severity: "error", message: "", phase_id: "PA" },
      { code: "X", severity: "warning", message: "", phase_id: "PB" },
    ];
    const rows = buildLintHistogram(issues);
    expect(rows).toEqual([
      { phase_id: "PA", code: "X", severity: "warning", count: 2 },
      { phase_id: "PA", code: "Y", severity: "error", count: 1 },
      { phase_id: "PB", code: "X", severity: "warning", count: 1 },
    ]);
  });

  it("uses _global sentinel when phase_id missing", () => {
    const issues: PlanIssue[] = [
      { code: "X", severity: "warning", message: "" },
    ];
    const rows = buildLintHistogram(issues);
    expect(rows[0]?.phase_id).toBe("_global");
  });

  it("returns empty array for no issues", () => {
    expect(buildLintHistogram([])).toEqual([]);
  });

  it("sorts rows deterministically", () => {
    const issues: PlanIssue[] = [
      { code: "Z", severity: "warning", message: "", phase_id: "PB" },
      { code: "A", severity: "warning", message: "", phase_id: "PA" },
      { code: "B", severity: "warning", message: "", phase_id: "PA" },
    ];
    const rows = buildLintHistogram(issues);
    expect(rows.map((r) => `${r.phase_id}/${r.code}`)).toEqual([
      "PA/A",
      "PA/B",
      "PB/Z",
    ]);
  });
});

describe("rowsToCsv", () => {
  it("emits header + rows", () => {
    const csv = rowsToCsv(
      [
        { a: 1, b: "x" },
        { a: 2, b: "y" },
      ],
      ["a", "b"],
    );
    expect(csv).toBe("a,b\n1,x\n2,y\n");
  });

  it("emits header only when no rows", () => {
    const csv = rowsToCsv<{ a: number }>([], ["a"]);
    expect(csv).toBe("a");
  });

  it("escapes embedded commas in strings", () => {
    const csv = rowsToCsv([{ a: "x,y" }], ["a"]);
    expect(csv).toBe('a\n"x,y"\n');
  });

  it("escapes embedded quotes in strings", () => {
    const csv = rowsToCsv([{ a: 'say "hi"' }], ["a"]);
    expect(csv).toBe('a\n"say ""hi"""\n');
  });
});
