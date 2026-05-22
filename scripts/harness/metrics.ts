import { deriveTaskState } from "../../src/core/progress/task-state.ts";
import type { ProgressEvent } from "../../src/core/schemas/progress-event.ts";
import type { Phase } from "../../src/core/schemas/phase.ts";
import type { PlanIssue } from "../../src/core/plan/shared.ts";

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
    pack_bytes: packContent.length,
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
