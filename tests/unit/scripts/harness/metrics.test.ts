import { describe, expect, it } from "vitest";

import {
  buildAdapterDriftRow,
  buildEventDensityRow,
  buildLifecycleAdherenceRow,
  buildLintHistogram,
  buildPackSizeRow,
  buildSummary,
  buildVerifySuccessRow,
  lowerPercentile,
  ratePercent,
  rowsToCsv,
} from "../../../../scripts/harness/metrics.ts";
import type { AdapterDoctorIssue } from "../../../../src/commands/adapter-doctor.ts";
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

  it("counts UTF-8 bytes, not UTF-16 code units, for non-ASCII content (P28)", () => {
    // Japanese + emoji: String.length (code units) is strictly less than
    // the UTF-8 byte length. The column is named *_bytes, so it must
    // report Buffer.byteLength, not content.length.
    const content = "## 設計ノート\n日本語の本文と絵文字 🎯\n";
    const row = buildPackSizeRow(phase, makeTask(), content);
    expect(row.pack_bytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(row.pack_bytes).toBeGreaterThan(content.length);
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

// ---------------------------------------------------------------------------
// Evidence Harness v2 (P26-T1) — new metric helpers
// ---------------------------------------------------------------------------

describe("buildLifecycleAdherenceRow", () => {
  it("returns null when the task has zero events", () => {
    const row = buildLifecycleAdherenceRow("PA", "PA-T1", []);
    expect(row).toBeNull();
  });

  it("flags started_before_done=true for a clean start→done sequence", () => {
    const events: ProgressEvent[] = [
      ev("PA-T1", "started", "2026-05-20T09:00:00+00:00"),
      ev("PA-T1", "done", "2026-05-20T10:00:00+00:00"),
    ];
    const row = buildLifecycleAdherenceRow("PA", "PA-T1", events);
    expect(row).not.toBeNull();
    expect(row!.started_before_done).toBe(true);
    expect(row!.legacy_planned_to_done_shortcut).toBe(false);
    expect(row!.had_retry).toBe(false);
    expect(row!.had_block).toBe(false);
    expect(row!.event_count).toBe(2);
  });

  it("flags legacy_planned_to_done_shortcut=true when there is a done without a prior started", () => {
    const events: ProgressEvent[] = [
      ev("PA-T1", "done", "2026-05-20T10:00:00+00:00"),
    ];
    const row = buildLifecycleAdherenceRow("PA", "PA-T1", events)!;
    expect(row.started_before_done).toBe(false);
    expect(row.legacy_planned_to_done_shortcut).toBe(true);
  });

  it("flags had_retry=true when a failed event is present", () => {
    const events: ProgressEvent[] = [
      ev("PA-T1", "started", "2026-05-20T09:00:00+00:00"),
      ev("PA-T1", "failed", "2026-05-20T09:30:00+00:00"),
      ev("PA-T1", "started", "2026-05-20T10:00:00+00:00"),
      ev("PA-T1", "done", "2026-05-20T11:00:00+00:00"),
    ];
    const row = buildLifecycleAdherenceRow("PA", "PA-T1", events)!;
    expect(row.had_retry).toBe(true);
    expect(row.started_before_done).toBe(true);
  });

  it("flags had_block=true when a blocked event is present", () => {
    const events: ProgressEvent[] = [
      ev("PA-T1", "started", "2026-05-20T09:00:00+00:00"),
      ev("PA-T1", "blocked", "2026-05-20T09:30:00+00:00"),
      ev("PA-T1", "resumed", "2026-05-20T10:00:00+00:00"),
      ev("PA-T1", "done", "2026-05-20T11:00:00+00:00"),
    ];
    const row = buildLifecycleAdherenceRow("PA", "PA-T1", events)!;
    expect(row.had_block).toBe(true);
  });

  it("filters out events from other tasks", () => {
    const events: ProgressEvent[] = [
      ev("PA-T2", "started"),
      ev("PA-T2", "done"),
    ];
    const row = buildLifecycleAdherenceRow("PA", "PA-T1", events);
    expect(row).toBeNull();
  });
});

describe("buildAdapterDriftRow", () => {
  const issue = (code: string, severity: "error" | "warning" = "warning"): AdapterDoctorIssue => ({
    code,
    severity,
    message: `mock ${code}`,
    agent: "claude-code" as const,
  });

  it("returns doctor_ok=true with all-zero counts when there are no issues", () => {
    const row = buildAdapterDriftRow("claude-code", []);
    expect(row.agent).toBe("claude-code");
    expect(row.doctor_ok).toBe(true);
    expect(row.issue_count).toBe(0);
    expect(row.manifest_missing).toBe(0);
    expect(row.contract_drift).toBe(0);
  });

  it("counts per-code issues into the corresponding column", () => {
    const row = buildAdapterDriftRow("claude-code", [
      issue("ADAPTER_GENERATOR_STALE"),
      issue("ADAPTER_CONTRACT_DRIFT"),
      issue("ADAPTER_CONTRACT_DRIFT"),
    ]);
    expect(row.issue_count).toBe(3);
    expect(row.generator_stale).toBe(1);
    expect(row.contract_drift).toBe(2);
  });

  it("flips doctor_ok to false when any error-severity issue is present", () => {
    const row = buildAdapterDriftRow("claude-code", [
      issue("ADAPTER_MANIFEST_INVALID", "error"),
    ]);
    expect(row.doctor_ok).toBe(false);
  });

  it("keeps doctor_ok=true when all issues are warning-severity", () => {
    const row = buildAdapterDriftRow("claude-code", [
      issue("ADAPTER_GENERATOR_STALE", "warning"),
      issue("ADAPTER_FILE_DRIFT", "warning"),
    ]);
    expect(row.doctor_ok).toBe(true);
  });
});

describe("lowerPercentile", () => {
  it("returns 0 for an empty array", () => {
    expect(lowerPercentile([], 50)).toBe(0);
  });

  it("returns the lower median for an even-length array (no average)", () => {
    // [10, 20, 30, 40] — p50 should be 20 (the lower middle), NOT 25.
    expect(lowerPercentile([10, 20, 30, 40], 50)).toBe(20);
  });

  it("returns the exact middle for an odd-length array", () => {
    expect(lowerPercentile([10, 20, 30], 50)).toBe(20);
  });

  it("computes p90 with ceil-based rank", () => {
    // n=10, ceil(0.9 * 10) = 9, so the 9th element (1-indexed) = idx 8.
    expect(
      lowerPercentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90),
    ).toBe(9);
  });

  it("clamps p=100 to the last element", () => {
    expect(lowerPercentile([10, 20, 30], 100)).toBe(30);
  });
});

describe("ratePercent", () => {
  it("returns 0 for zero denominator (safe divide)", () => {
    expect(ratePercent(0, 0)).toBe(0);
    expect(ratePercent(5, 0)).toBe(0);
  });

  it("rounds to one decimal place", () => {
    expect(ratePercent(1, 3)).toBe(33.3);
    expect(ratePercent(2, 3)).toBe(66.7);
    expect(ratePercent(1, 8)).toBe(12.5);
  });

  it("returns 100.0 for full coverage", () => {
    expect(ratePercent(10, 10)).toBe(100);
  });
});

describe("buildSummary", () => {
  it("computes every metric and never emits budget_reserved_for_later", () => {
    const summary = buildSummary({
      harnessVersion: "0.2.0",
      summarySchemaVersion: 1,
      inputGitSha: "abc123",
      codePactCliVersion: "1.12.0",
      generatedAt: "2026-05-23",
      packSizeRows: [
        { phase_id: "PA", task_id: "T1", pack_bytes: 100, pack_lines: 5, pack_sections: 1, reads_glob_count: 0, writes_glob_count: 0, decision_refs_count: 0, acceptance_refs_count: 0 },
        { phase_id: "PA", task_id: "T2", pack_bytes: 200, pack_lines: 8, pack_sections: 2, reads_glob_count: 0, writes_glob_count: 0, decision_refs_count: 0, acceptance_refs_count: 0 },
        { phase_id: "PA", task_id: "T3", pack_bytes: 300, pack_lines: 10, pack_sections: 3, reads_glob_count: 0, writes_glob_count: 0, decision_refs_count: 0, acceptance_refs_count: 0 },
      ],
      verifySuccessRows: [
        { phase_id: "PA", task_id: "T1", first_pass: true, retries: 0, verify_runs_total: 1 },
        { phase_id: "PA", task_id: "T2", first_pass: false, retries: 1, verify_runs_total: 2 },
      ],
      lifecycleAdherenceRows: [
        { phase_id: "PA", task_id: "T1", started_before_done: true, had_retry: false, had_block: false, legacy_planned_to_done_shortcut: false, event_count: 2 },
        { phase_id: "PA", task_id: "T2", started_before_done: false, had_retry: false, had_block: false, legacy_planned_to_done_shortcut: true, event_count: 1 },
      ],
      adapterDriftRows: [
        { agent: "claude-code", doctor_ok: true, issue_count: 0, manifest_missing: 0, manifest_invalid: 0, generator_stale: 0, schema_drift: 0, profile_drift: 0, file_missing: 0, file_drift: 0, desired_stale: 0, contract_drift: 0, unmanaged_file: 0 },
      ],
      tasksTotal: 3,
    });

    expect(summary.harness_version).toBe("0.2.0");
    expect(summary.summary_schema_version).toBe(1);
    expect(summary.metrics.pack_size_p50_bytes).toBe(200); // lower median of [100, 200, 300] → idx 1 → 200
    expect(summary.metrics.pack_size_max_bytes).toBe(300);
    expect(summary.metrics.first_pass_verify_rate_percent).toBe(50);
    expect(summary.metrics.lifecycle_adherence_rate_percent).toBe(50);
    expect(summary.metrics.adapter_drift_rate_percent).toBe(0);
    expect(summary.metrics.undeclared_write_rate_status).toBe("deferred");
    expect(summary.metrics.undeclared_write_rate_note.length).toBeGreaterThan(
      0,
    );
    // A non-empty live corpus is "measured" with no disambiguating note.
    expect(summary.corpus_status).toBe("measured");
    expect(summary.corpus_note).toBe("");
    expect(summary.denominators).toEqual({
      tasks_done: 2,
      tasks_total: 3,
      agents_enabled: 1,
    });
  });

  it("flags an empty live corpus as no_live_tasks (0s are 'nothing measured', not a measured failure)", () => {
    const summary = buildSummary({
      harnessVersion: "0.2.0",
      summarySchemaVersion: 2,
      inputGitSha: "abc123-dirty",
      codePactCliVersion: "2.0.0",
      generatedAt: "2026-06-18",
      packSizeRows: [],
      verifySuccessRows: [],
      lifecycleAdherenceRows: [],
      adapterDriftRows: [],
      tasksTotal: 0,
    });
    expect(summary.corpus_status).toBe("no_live_tasks");
    expect(summary.corpus_note).toMatch(/archived under \.code-pact\/state\/archive/);
    // The numeric metrics are still 0 — but now disambiguated by corpus_status.
    expect(summary.metrics.first_pass_verify_rate_percent).toBe(0);
    expect(summary.metrics.lifecycle_adherence_rate_percent).toBe(0);
    expect(summary.denominators.tasks_total).toBe(0);
  });

  it("excludes legacy_planned_to_done_shortcut tasks from the adherence numerator but keeps them in the denominator", () => {
    const summary = buildSummary({
      harnessVersion: "0.2.0",
      summarySchemaVersion: 1,
      inputGitSha: "x",
      codePactCliVersion: "1.12.0",
      generatedAt: "2026-05-23",
      packSizeRows: [],
      verifySuccessRows: [],
      lifecycleAdherenceRows: [
        { phase_id: "PA", task_id: "T1", started_before_done: true, had_retry: false, had_block: false, legacy_planned_to_done_shortcut: false, event_count: 2 },
        { phase_id: "PA", task_id: "T2", started_before_done: true, had_retry: false, had_block: false, legacy_planned_to_done_shortcut: false, event_count: 2 },
        { phase_id: "PA", task_id: "T3", started_before_done: false, had_retry: false, had_block: false, legacy_planned_to_done_shortcut: true, event_count: 1 },
        { phase_id: "PA", task_id: "T4", started_before_done: false, had_retry: false, had_block: false, legacy_planned_to_done_shortcut: true, event_count: 1 },
      ],
      adapterDriftRows: [],
      tasksTotal: 4,
    });
    // 2 of 4 candidates adhere → 50.0
    expect(summary.metrics.lifecycle_adherence_rate_percent).toBe(50);
  });
});
