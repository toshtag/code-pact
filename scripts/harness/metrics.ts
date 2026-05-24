import { deriveTaskState } from "../../src/core/progress/task-state.ts";
import type { ProgressEvent } from "../../src/core/schemas/progress-event.ts";
import type { Phase } from "../../src/core/schemas/phase.ts";
import type { PlanIssue } from "../../src/core/plan/shared.ts";
import type { AdapterDoctorIssue } from "../../src/commands/adapter-doctor.ts";

// ---------------------------------------------------------------------------
// Evidence harness — pure metric computation.
//
// Internal-only maintainer tool (P20). NOT a product feature; never
// invoked through the public CLI. Each function below is a pure
// transformation from in-memory corpus state to a row set ready for
// CSV serialisation. The harness orchestrator (run.ts) handles I/O,
// argv parsing, and the actual CSV writing.
// ---------------------------------------------------------------------------

export interface PackSizeRow {
  phase_id: string;
  task_id: string;
  pack_bytes: number;
  pack_lines: number;
  pack_sections: number;
  reads_glob_count: number;
  writes_glob_count: number;
  decision_refs_count: number;
  acceptance_refs_count: number;
}

export interface VerifySuccessRow {
  phase_id: string;
  task_id: string;
  first_pass: boolean;
  retries: number;
  verify_runs_total: number;
}

export interface EventDensityRow {
  phase_id: string;
  task_id: string;
  started: number;
  blocked: number;
  resumed: number;
  done: number;
  failed: number;
  total_events: number;
  event_span_days: number;
}

export interface LintIssueRow {
  phase_id: string;
  code: string;
  severity: string;
  count: number;
}

export function buildPackSizeRow(
  phase: Phase,
  task: Phase["tasks"] extends ReadonlyArray<infer T> | undefined ? NonNullable<T> : never,
  packContent: string,
): PackSizeRow {
  const sectionCount = (packContent.match(/^## /gm) ?? []).length;
  return {
    phase_id: phase.id,
    task_id: task.id,
    // P28: the column is named *_bytes and the project locks
    // Buffer.byteLength(..., "utf8") as the byte measurement everywhere
    // (core pack rendering already does). String.length is a UTF-16 code
    // unit count that diverges for any non-ASCII pack content.
    pack_bytes: Buffer.byteLength(packContent, "utf8"),
    pack_lines: packContent.split("\n").length,
    pack_sections: sectionCount,
    reads_glob_count: task.reads?.length ?? 0,
    writes_glob_count: task.writes?.length ?? 0,
    decision_refs_count: task.decision_refs?.length ?? 0,
    acceptance_refs_count: task.acceptance_refs?.length ?? 0,
  };
}

export function buildVerifySuccessRow(
  phaseId: string,
  taskId: string,
  events: readonly ProgressEvent[],
): VerifySuccessRow | null {
  const taskEvents = events.filter((e) => e.task_id === taskId);
  const hasDone = taskEvents.some((e) => e.status === "done");
  if (!hasDone) return null;
  const failedCount = taskEvents.filter((e) => e.status === "failed").length;
  const resumedCount = taskEvents.filter((e) => e.status === "resumed").length;
  const retries = failedCount + resumedCount;
  return {
    phase_id: phaseId,
    task_id: taskId,
    first_pass: retries === 0,
    retries,
    verify_runs_total: retries + 1,
  };
}

export function buildEventDensityRow(
  phaseId: string,
  taskId: string,
  events: readonly ProgressEvent[],
): EventDensityRow {
  const taskEvents = events.filter((e) => e.task_id === taskId);
  const counts = {
    started: 0,
    blocked: 0,
    resumed: 0,
    done: 0,
    failed: 0,
  };
  for (const ev of taskEvents) {
    if (ev.status in counts) {
      (counts as Record<string, number>)[ev.status]!++;
    }
  }
  let spanDays = 0;
  if (taskEvents.length >= 2) {
    const timestamps = taskEvents
      .map((e) => Date.parse(e.at))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
    if (timestamps.length >= 2) {
      const first = timestamps[0]!;
      const last = timestamps[timestamps.length - 1]!;
      spanDays = Math.round(((last - first) / (1000 * 60 * 60 * 24)) * 10) / 10;
    }
  }
  // Mark task state to ensure deriveTaskState symbol stays imported (used
  // by integration tests that exercise the same computation path).
  void deriveTaskState;
  return {
    phase_id: phaseId,
    task_id: taskId,
    started: counts.started,
    blocked: counts.blocked,
    resumed: counts.resumed,
    done: counts.done,
    failed: counts.failed,
    total_events: taskEvents.length,
    event_span_days: spanDays,
  };
}

export function buildLintHistogram(issues: readonly PlanIssue[]): LintIssueRow[] {
  const counter = new Map<string, { phaseId: string; code: string; severity: string; count: number }>();
  for (const issue of issues) {
    const phaseId = issue.phase_id ?? "_global";
    const key = `${phaseId}\x00${issue.code}`;
    const existing = counter.get(key);
    if (existing) {
      existing.count++;
    } else {
      counter.set(key, {
        phaseId,
        code: issue.code,
        severity: issue.severity,
        count: 1,
      });
    }
  }
  return Array.from(counter.values())
    .map((entry) => ({
      phase_id: entry.phaseId,
      code: entry.code,
      severity: entry.severity,
      count: entry.count,
    }))
    .sort((a, b) => {
      const phaseCmp = a.phase_id.localeCompare(b.phase_id);
      if (phaseCmp !== 0) return phaseCmp;
      return a.code.localeCompare(b.code);
    });
}

// ---------------------------------------------------------------------------
// Evidence Harness v2 (P26) — new metric rows.
// Additive only; v1 row shapes above are unchanged.
// ---------------------------------------------------------------------------

export interface LifecycleAdherenceRow {
  phase_id: string;
  task_id: string;
  started_before_done: boolean;
  had_retry: boolean;
  had_block: boolean;
  legacy_planned_to_done_shortcut: boolean;
  event_count: number;
}

/** Returns null when the task has zero events (not yet attempted). */
export function buildLifecycleAdherenceRow(
  phaseId: string,
  taskId: string,
  events: readonly ProgressEvent[],
): LifecycleAdherenceRow | null {
  const taskEvents = events.filter((e) => e.task_id === taskId);
  if (taskEvents.length === 0) return null;

  let startedCount = 0;
  let doneCount = 0;
  let failedCount = 0;
  let blockedCount = 0;
  let firstStartedAt: number | null = null;
  let firstDoneAt: number | null = null;

  for (const ev of taskEvents) {
    const ts = Date.parse(ev.at);
    if (ev.status === "started") {
      startedCount++;
      if (!Number.isNaN(ts) && (firstStartedAt === null || ts < firstStartedAt)) {
        firstStartedAt = ts;
      }
    } else if (ev.status === "done") {
      doneCount++;
      if (!Number.isNaN(ts) && (firstDoneAt === null || ts < firstDoneAt)) {
        firstDoneAt = ts;
      }
    } else if (ev.status === "failed") {
      failedCount++;
    } else if (ev.status === "blocked") {
      blockedCount++;
    }
  }

  // started_before_done: at least one started event AND the earliest
  // started precedes the earliest done. If the task has no done event,
  // we cannot judge the order — count as `false` only when there is a
  // done event but no started ordered before it.
  let startedBeforeDone: boolean;
  if (doneCount === 0) {
    startedBeforeDone = startedCount > 0;
  } else if (startedCount === 0) {
    startedBeforeDone = false;
  } else if (firstStartedAt !== null && firstDoneAt !== null) {
    startedBeforeDone = firstStartedAt < firstDoneAt;
  } else {
    // Timestamps unparseable on both sides — fall back to count-only.
    startedBeforeDone = startedCount > 0;
  }

  return {
    phase_id: phaseId,
    task_id: taskId,
    started_before_done: startedBeforeDone,
    had_retry: failedCount >= 1,
    had_block: blockedCount >= 1,
    legacy_planned_to_done_shortcut: startedCount === 0 && doneCount >= 1,
    event_count: taskEvents.length,
  };
}

export interface AdapterDriftRow {
  agent: string;
  doctor_ok: boolean;
  issue_count: number;
  manifest_missing: number;
  manifest_invalid: number;
  generator_stale: number;
  schema_drift: number;
  profile_drift: number;
  file_missing: number;
  file_drift: number;
  desired_stale: number;
  contract_drift: number;
  unmanaged_file: number;
}

// Map ADAPTER_* issue codes to AdapterDriftRow column names. New codes
// land here without touching the CSV column order (the column list is
// frozen in the RFC; unmapped codes get counted into the catch-all
// `unmanaged_file` is reserved for ADAPTER_UNMANAGED_FILE specifically,
// so unrecognised codes go into none and only affect issue_count).
const ADAPTER_CODE_COLUMNS: Readonly<Record<string, keyof AdapterDriftRow>> = {
  ADAPTER_MANIFEST_MISSING: "manifest_missing",
  ADAPTER_MANIFEST_INVALID: "manifest_invalid",
  ADAPTER_GENERATOR_STALE: "generator_stale",
  ADAPTER_SCHEMA_DRIFT: "schema_drift",
  ADAPTER_PROFILE_DRIFT: "profile_drift",
  ADAPTER_FILE_MISSING: "file_missing",
  ADAPTER_FILE_DRIFT: "file_drift",
  ADAPTER_DESIRED_STALE: "desired_stale",
  ADAPTER_CONTRACT_DRIFT: "contract_drift",
  ADAPTER_UNMANAGED_FILE: "unmanaged_file",
};

export function buildAdapterDriftRow(
  agent: string,
  agentIssues: readonly AdapterDoctorIssue[],
): AdapterDriftRow {
  const row: AdapterDriftRow = {
    agent,
    doctor_ok: true,
    issue_count: agentIssues.length,
    manifest_missing: 0,
    manifest_invalid: 0,
    generator_stale: 0,
    schema_drift: 0,
    profile_drift: 0,
    file_missing: 0,
    file_drift: 0,
    desired_stale: 0,
    contract_drift: 0,
    unmanaged_file: 0,
  };
  for (const issue of agentIssues) {
    if (issue.severity === "error") {
      row.doctor_ok = false;
    }
    const col = ADAPTER_CODE_COLUMNS[issue.code];
    if (col !== undefined) {
      (row as unknown as Record<string, number>)[col] =
        ((row as unknown as Record<string, number>)[col] ?? 0) + 1;
    }
  }
  return row;
}

// ---------------------------------------------------------------------------
// Aggregate summary computation (P26-T1).
// Pure helpers: lower-percentile (no average), one-decimal rate rounding.
// ---------------------------------------------------------------------------

/**
 * Lower-percentile of a sorted ascending integer array. Returns the
 * `Math.ceil(p/100 * n)`-th element (1-indexed) clamped to [1, n].
 * Designed so p50 of an even-length array picks the lower middle
 * element, preserving integer byte values without rounding.
 *
 * For n=0 returns 0.
 */
export function lowerPercentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (p <= 0) return sorted[0]!;
  if (p >= 100) return sorted[sorted.length - 1]!;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[idx]!;
}

/** Round to one decimal place. 0/0 returns 0.0 (safe denominator). */
export function ratePercent(numerator: number, denominator: number): number {
  if (denominator === 0) return 0.0;
  return Math.round((100 * numerator) / denominator * 10) / 10;
}

export interface SummaryMetrics {
  pack_size_p50_bytes: number;
  pack_size_p90_bytes: number;
  pack_size_max_bytes: number;
  first_pass_verify_rate_percent: number;
  lifecycle_adherence_rate_percent: number;
  adapter_drift_rate_percent: number;
  undeclared_write_rate_status: "deferred";
  undeclared_write_rate_note: string;
}

export interface SummaryDenominators {
  tasks_done: number;
  tasks_total: number;
  agents_enabled: number;
}

export interface Summary {
  harness_version: string;
  summary_schema_version: number;
  input_git_sha: string;
  code_pact_cli_version: string;
  generated_at: string;
  metrics: SummaryMetrics;
  denominators: SummaryDenominators;
}

const UNDECLARED_WRITE_RATE_NOTE =
  "Computing this metric requires attributing git commits to tasks. The project does not enforce a formal commit → task link, so a historical retrofit would either over-claim or require new lifecycle instrumentation. Tracked under evidence-harness-v2-rfc.md Non-goals.";

export interface BuildSummaryInput {
  harnessVersion: string;
  summarySchemaVersion: number;
  inputGitSha: string;
  codePactCliVersion: string;
  generatedAt: string;
  packSizeRows: readonly PackSizeRow[];
  verifySuccessRows: readonly VerifySuccessRow[];
  lifecycleAdherenceRows: readonly LifecycleAdherenceRow[];
  adapterDriftRows: readonly AdapterDriftRow[];
  tasksTotal: number;
}

export function buildSummary(input: BuildSummaryInput): Summary {
  const packBytesSorted = input.packSizeRows
    .map((r) => r.pack_bytes)
    .sort((a, b) => a - b);

  const firstPassNum = input.verifySuccessRows.filter((r) => r.first_pass).length;
  const firstPassDen = input.verifySuccessRows.length;

  const adherenceCandidates = input.lifecycleAdherenceRows.filter(
    (r) => r.event_count > 0,
  );
  const adherenceNum = adherenceCandidates.filter(
    (r) => r.started_before_done && !r.legacy_planned_to_done_shortcut,
  ).length;
  const adherenceDen = adherenceCandidates.length;

  const driftDen = input.adapterDriftRows.length;
  const driftNum = input.adapterDriftRows.filter((r) => !r.doctor_ok).length;

  return {
    harness_version: input.harnessVersion,
    summary_schema_version: input.summarySchemaVersion,
    input_git_sha: input.inputGitSha,
    code_pact_cli_version: input.codePactCliVersion,
    generated_at: input.generatedAt,
    metrics: {
      pack_size_p50_bytes: lowerPercentile(packBytesSorted, 50),
      pack_size_p90_bytes: lowerPercentile(packBytesSorted, 90),
      pack_size_max_bytes: packBytesSorted[packBytesSorted.length - 1] ?? 0,
      first_pass_verify_rate_percent: ratePercent(firstPassNum, firstPassDen),
      lifecycle_adherence_rate_percent: ratePercent(adherenceNum, adherenceDen),
      adapter_drift_rate_percent: ratePercent(driftNum, driftDen),
      undeclared_write_rate_status: "deferred",
      undeclared_write_rate_note: UNDECLARED_WRITE_RATE_NOTE,
    },
    denominators: {
      tasks_done: input.verifySuccessRows.length,
      tasks_total: input.tasksTotal,
      agents_enabled: input.adapterDriftRows.length,
    },
  };
}

export function rowsToCsv<T extends Record<string, string | number | boolean>>(
  rows: T[],
  columns: ReadonlyArray<keyof T & string>,
): string {
  const header = columns.join(",");
  const body = rows.map((row) =>
    columns
      .map((col) => {
        const v = row[col];
        if (typeof v === "string" && (v.includes(",") || v.includes("\""))) {
          return `"${v.replace(/"/g, '""')}"`;
        }
        return String(v);
      })
      .join(","),
  );
  return [header, ...body].join("\n") + (body.length > 0 ? "\n" : "");
}
