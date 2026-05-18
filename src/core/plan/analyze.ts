import { detectOrphanProgressEvents } from "./checks.ts";
import { loadPlanState, type PlanState } from "./state.ts";
import type { PlanIssue } from "./shared.ts";
import {
  deriveTaskState,
  type TaskCurrentState,
} from "../progress/task-state.ts";
import type { Task } from "../schemas/task.ts";

export type AnalyzeOptions = {
  cwd: string;
};

export type AnalyzeResult = {
  state: PlanState;
  issues: PlanIssue[];
};

type DriftClassification = {
  kind: string;
  severity: "error" | "warning";
  hidden_by_default?: boolean;
  affects_exit?: boolean;
};

/**
 * Top-down exclusive evaluation. The order matters: a single task must
 * never produce two `STATUS_DRIFT` issues. For example a design=done
 * task whose derived state is `blocked` matches the first rule, and
 * the `done-with-incomplete-events` rule below must not fire for the
 * same task. Returns null when design and progress agree.
 */
function classifyTaskDrift(
  designStatus: Task["status"],
  derivedCurrent: TaskCurrentState,
  hasEvents: boolean,
): DriftClassification | null {
  if (designStatus === "done") {
    if (derivedCurrent === "blocked") {
      return { kind: "done-blocked-conflict", severity: "error" };
    }
    if (
      hasEvents &&
      (derivedCurrent === "started" ||
        derivedCurrent === "resumed" ||
        derivedCurrent === "failed")
    ) {
      return { kind: "done-with-incomplete-events", severity: "error" };
    }
    if (!hasEvents) {
      // Historical done: completed before progress tracking existed.
      // Visible only with --include-historical; never affects exit
      // code, even under --strict.
      return {
        kind: "done-historical",
        severity: "warning",
        hidden_by_default: true,
        affects_exit: false,
      };
    }
    return null; // design=done && derived=done && hasEvents=true → consistent
  }

  if (
    derivedCurrent === "done" &&
    (designStatus === "planned" || designStatus === "in_progress")
  ) {
    return { kind: "done-but-design-not-done", severity: "warning" };
  }

  if (designStatus === "in_progress" && !hasEvents) {
    return { kind: "in-progress-no-events", severity: "warning" };
  }

  return null;
}

function driftMessage(
  taskId: string,
  kind: string,
  designStatus: string,
  derived: string,
): string {
  switch (kind) {
    case "done-blocked-conflict":
      return `Task "${taskId}" is marked done in design but the progress log derives state "${derived}".`;
    case "done-with-incomplete-events":
      return `Task "${taskId}" is marked done in design but the progress log shows "${derived}" — events exist without a done event.`;
    case "done-historical":
      return `Task "${taskId}" is marked done in design but has no progress events (likely completed before progress tracking was introduced).`;
    case "done-but-design-not-done":
      return `Task "${taskId}" is done in the progress log but design status is "${designStatus}".`;
    case "in-progress-no-events":
      return `Task "${taskId}" is "in_progress" in design but has no progress events — likely a missing task start.`;
    default:
      return `Task "${taskId}" has a status drift of kind "${kind}".`;
  }
}

/**
 * Cross-artifact integrity analyzer. Reads `design/` and the progress
 * log via the strict loader (any schema/parse failure throws) and
 * compares design intent against derived progress state.
 *
 * Three families of issue:
 *   1. STATUS_DRIFT (per task) — exclusive top-down classification
 *      avoids duplicate issues for the same task.
 *   2. PHASE_DONE_WITH_OPEN_TASKS — a phase marked done with at least
 *      one non-done task.
 *   3. ORPHAN_PROGRESS_EVENT — events for task ids no longer in any
 *      phase. The detector lives in checks.ts and is shared with
 *      doctor.
 */
export async function runAnalyze(
  opts: AnalyzeOptions,
): Promise<AnalyzeResult> {
  const state = await loadPlanState(opts.cwd);
  const events = state.progress?.events ?? [];
  const issues: PlanIssue[] = [];

  for (const entry of state.phases) {
    for (const task of entry.phase.tasks ?? []) {
      const derived = deriveTaskState(events, task.id);
      const hasEvents = derived.history.length > 0;
      const cls = classifyTaskDrift(task.status, derived.current, hasEvents);
      if (cls === null) continue;
      issues.push({
        code: "STATUS_DRIFT",
        severity: cls.severity,
        message: driftMessage(task.id, cls.kind, task.status, derived.current),
        phase_id: entry.phase.id,
        task_id: task.id,
        file: entry.ref.path,
        details: {
          kind: cls.kind,
          design_status: task.status,
          derived_state: derived.current,
        },
        ...(cls.hidden_by_default ? { hidden_by_default: true } : {}),
        ...(cls.affects_exit === false ? { affects_exit: false } : {}),
      });
    }
  }

  for (const entry of state.phases) {
    if (entry.phase.status !== "done") continue;
    const open = (entry.phase.tasks ?? []).filter((t) => t.status !== "done");
    if (open.length === 0) continue;
    issues.push({
      code: "PHASE_DONE_WITH_OPEN_TASKS",
      severity: "error",
      message: `Phase "${entry.phase.id}" is marked done but ${open.length} task(s) are not done: ${open.map((t) => t.id).join(", ")}`,
      phase_id: entry.phase.id,
      file: entry.ref.path,
      details: { open_task_ids: open.map((t) => t.id) },
    });
  }

  if (events.length > 0) {
    issues.push(...detectOrphanProgressEvents(events, state.taskIndex));
  }

  return { state, issues };
}
