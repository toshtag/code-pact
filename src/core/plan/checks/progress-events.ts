import type { PlanIssue } from "../shared.ts";
import type { ProgressEvent } from "../../schemas/progress-event.ts";
import {
  assertTransition,
  type TaskCurrentState,
  type TaskTransition,
} from "../../progress/task-state.ts";
import { computeEventId } from "../../progress/event-id.ts";

/**
 * Progress events whose `task_id` does not correspond to any task in
 * any phase. Almost always indicates a renamed/deleted task whose
 * historical events were left behind.
 *
 * `plan lint` does NOT call this — orphan event detection compares
 * progress against the task index and therefore belongs in
 * `plan analyze`. `doctor` keeps calling it to preserve historical
 * behavior for users who run `doctor` as their single health gate.
 */
export function detectOrphanProgressEvents(
  events: ProgressEvent[],
  taskIndex: Map<string, unknown>,
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (taskIndex.has(event.task_id)) continue;
    if (seen.has(event.task_id)) continue;
    seen.add(event.task_id);
    issues.push({
      code: "ORPHAN_PROGRESS_EVENT",
      severity: "warning",
      message: `the progress ledger references task "${event.task_id}" which does not exist in any phase`,
      task_id: event.task_id,
    });
  }
  return issues;
}

// `planned -> done` is the v0.5 legacy command-layer shortcut (task complete on
// a never-started task), so it is acceptable, not a conflict.
function isAcceptableTransition(
  current: TaskCurrentState,
  next: TaskTransition,
): boolean {
  if (current === "planned" && next === "done") return true;
  try {
    assertTransition(current, next);
    return true;
  } catch {
    return false;
  }
}

/**
 * One side of a `PROGRESS_EVENT_CONFLICT` — the structured `details.events[]`
 * shape (Collaboration UX RFC, D3). Lets an agent read *who* produced each side
 * of a conflict without parsing the human `message`. `author` is omitted for
 * legacy / capture-off (anonymous) events, exactly as on the event itself.
 * `event_id` is the content id (`computeEventId`) — the *suffix* of a per-event
 * filename `<at-compact>-<event_id>.yaml` (NOT the whole name; locate the file
 * with `.code-pact/state/events/*-<event_id>.yaml`). An event that lives only in
 * a legacy `.code-pact/state/progress.yaml` has no per-event file — reconcile the
 * matching `progress.yaml` entry (or migrate it) in that case.
 */
export type ConflictEventEntry = {
  event_id: string;
  status: ProgressEvent["status"];
  author?: string;
  at: string;
};

/** Project an event onto its `details.events[]` entry (D3). Key order matches the
 *  RFC-pinned shape (`event_id, status, author?, at`); `author` omitted when absent. */
function toConflictEventEntry(e: ProgressEvent): ConflictEventEntry {
  return {
    event_id: computeEventId(e),
    status: e.status,
    ...(e.author !== undefined ? { author: e.author } : {}),
    at: e.at,
  };
}

/** Human rendering of one side, naming the author when present (D3). */
function describeSide(e: ProgressEvent): string {
  return e.author !== undefined ? `"${e.status}" (by ${e.author})` : `"${e.status}"`;
}

/**
 * Detect conflicting progress events for a task (collaboration-safe-state RFC,
 * B6). With the per-event ledger, two contributors/branches can produce events
 * that, once merged, form a sequence no single writer would: a second `started`
 * while already started, a `done` after `done`, a `blocked`/`started` after a
 * terminal `done`, etc. Folding each task's merged events through the lifecycle
 * state machine surfaces these as `PROGRESS_EVENT_CONFLICT` (warning) instead of
 * letting the reducer silently pick a last-writer winner.
 *
 * `deriveTaskState` is intentionally NOT made conflict-aware — it stays total;
 * this is the detection surface. One conflict is reported per task (the first),
 * to avoid cascading noise from a single divergence.
 *
 * D3 (Collaboration UX RFC) enriches each issue with a structured
 * `details.events[]` naming the conflicting side(s) — the event that established
 * the current state (when present) and the offending event; usually two, but one
 * when the very first event for a task is itself an invalid transition — so an
 * agent (and `code-pact status`) reads *who* collided without parsing the
 * message. Pure read-side enrichment: the same detection, same one-per-task rule,
 * same `warning` severity.
 */
export function detectProgressEventConflicts(
  events: readonly ProgressEvent[],
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const byTask = new Map<string, ProgressEvent[]>();
  for (const e of events) {
    const list = byTask.get(e.task_id);
    if (list) list.push(e);
    else byTask.set(e.task_id, [e]);
  }
  for (const [taskId, taskEvents] of byTask) {
    let current: TaskCurrentState = "planned";
    let prev: ProgressEvent | undefined;
    for (const e of taskEvents) {
      const next = e.status as TaskTransition;
      if (!isAcceptableTransition(current, next)) {
        // Name the conflicting side(s): the event that put the task into
        // `current` (when present) and the offending event. On the first-event
        // case (no prior accepted event) there is only the one side to name.
        const sides = prev !== undefined ? [prev, e] : [e];
        const who =
          prev !== undefined
            ? `${describeSide(prev)} → ${describeSide(e)}`
            : describeSide(e);
        issues.push({
          code: "PROGRESS_EVENT_CONFLICT",
          severity: "warning",
          message: `Task "${taskId}" has conflicting progress events: ${who} is not a valid lifecycle transition (incompatible or concurrent events from different sources). Inspect details.events[] and reconcile the corresponding progress event — its per-event ledger file, or the legacy .code-pact/state/progress.yaml entry.`,
          task_id: taskId,
          details: { events: sides.map(toConflictEventEntry) },
        });
        break;
      }
      current = next;
      prev = e;
    }
  }
  return issues;
}
