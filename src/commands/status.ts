// `code-pact status` — read-only team activity overview (Collaboration UX RFC,
// D2). Aggregates derived task state across the plan and answers the sit-down
// questions: what is in flight (by whom), what is blocked (why/by whom), what is
// free to pick up — and, for what isn't, why.
//
// Pure read (no agent config, no writes, no lock), reusing the existing
// `deriveTaskState` + `depends_on` + the shared decision-gate resolver. It is an
// ACTIVITY view, not a structural-diagnostics aggregator: `DUPLICATE_*` /
// `PHASE_ID_MISMATCH` stay the responsibility of `doctor` / `plan lint`.
//
// Explicitly NOT a lock: it surfaces overlap so humans coordinate; two people can
// still pick the same in-flight task — they will now see it first, and if both
// proceed `PROGRESS_EVENT_CONFLICT` catches it.

import { loadPlanState } from "../core/plan/state.ts";
import { findUniquePhaseInPlanState } from "../core/plan/resolve-phase.ts";
import { deriveTaskState, type TaskCurrentState } from "../core/progress/task-state.ts";
import { makeDecisionResolver, isDecisionRequiredForTask } from "../core/decisions/adr.ts";
import { isAuthorCaptureDisabled, resolveEventAuthor } from "../core/progress/author.ts";
import {
  detectProgressEventConflicts,
  type ConflictEventEntry,
} from "../core/plan/checks.ts";

export type StatusOptions = {
  cwd: string;
  /** Filter to the resolved author identity's active work (in-flight + blocked). */
  mine?: boolean;
  /** Restrict to one phase id. */
  phase?: string;
};

/** Why `--mine` could not be applied (mirrors the resolver's two no-identity cases). */
export type MineUnsupportedReason = "AUTHOR_CAPTURE_DISABLED" | "AUTHOR_UNAVAILABLE";

export type StatusFilter =
  | { mine: false }
  | { mine: true; supported: true; author: string }
  | { mine: true; supported: false; reason: MineUnsupportedReason };

export type InFlightEntry = {
  task_id: string;
  phase_id: string;
  since?: string;
  author?: string;
};
export type BlockedEntry = {
  task_id: string;
  phase_id: string;
  reason?: string;
  author?: string;
  since?: string;
};
export type AvailableEntry = { task_id: string; phase_id: string };
export type WaitingReason =
  | { code: "WAITING_FOR_DEPENDENCY"; task_id: string }
  | { code: "MISSING_DECISION"; decision_ref?: string };
export type WaitingEntry = {
  task_id: string;
  phase_id: string;
  reasons: WaitingReason[];
};
/**
 * A detected `PROGRESS_EVENT_CONFLICT` for a task in scope (Collaboration UX
 * RFC, D3). `details.events[]` names the conflicting side(s) — usually two (the
 * establishing event and the offender), one when the first event is itself
 * invalid — the same structured shape the `plan analyze` / `doctor` surfaces
 * carry, so an agent reads *who* collided without parsing prose. Structural id
 * conflicts (`DUPLICATE_*` / `PHASE_ID_MISMATCH`) are NOT here — they stay with
 * `doctor` / `plan lint`.
 */
export type ConflictEntry = {
  task_id: string;
  code: "PROGRESS_EVENT_CONFLICT";
  details: { events: ConflictEventEntry[] };
};

export type StatusResult = {
  filter: StatusFilter;
  in_flight: InFlightEntry[];
  blocked: BlockedEntry[];
  available: AvailableEntry[];
  waiting: WaitingEntry[];
  conflicts: ConflictEntry[];
  totals: { tasks: number; by_state: Record<TaskCurrentState, number> };
};

function phaseNotFound(phaseId: string): NodeJS.ErrnoException {
  const err = new Error(`Phase "${phaseId}" not found in roadmap.yaml.`);
  (err as NodeJS.ErrnoException).code = "PHASE_NOT_FOUND";
  return err as NodeJS.ErrnoException;
}

export async function runStatus(opts: StatusOptions): Promise<StatusResult> {
  const { cwd } = opts;
  const state = await loadPlanState(cwd);
  const events = state.progress?.events ?? [];

  // --mine identity resolution (data.filter). Distinguish "capture disabled"
  // from "no identity" so an agent can tell "nothing is mine" from "can't tell".
  let filter: StatusFilter = { mine: false };
  let mineAuthor: string | undefined;
  if (opts.mine === true) {
    if (await isAuthorCaptureDisabled(cwd)) {
      filter = { mine: true, supported: false, reason: "AUTHOR_CAPTURE_DISABLED" };
    } else {
      const a = await resolveEventAuthor(cwd);
      if (a === undefined) {
        filter = { mine: true, supported: false, reason: "AUTHOR_UNAVAILABLE" };
      } else {
        filter = { mine: true, supported: true, author: a };
        mineAuthor = a;
      }
    }
  }

  // --phase resolution goes through the shared resolver so it FAILS CLOSED on a
  // duplicate phase id (AMBIGUOUS_PHASE_ID, PR1a) and matches on the file's inner
  // `phase.id` — consistent with every other command that takes a phase id.
  let entries: typeof state.phases = state.phases;
  if (opts.phase !== undefined) {
    const entry = findUniquePhaseInPlanState(state, opts.phase); // throws AMBIGUOUS_PHASE_ID on >1
    if (entry === undefined) throw phaseNotFound(opts.phase);
    entries = [entry];
  }

  const in_flight: InFlightEntry[] = [];
  const blocked: BlockedEntry[] = [];
  const available: AvailableEntry[] = [];
  const waiting: WaitingEntry[] = [];
  const by_state: Record<TaskCurrentState, number> = {
    planned: 0,
    started: 0,
    resumed: 0,
    blocked: 0,
    done: 0,
    failed: 0,
  };
  let tasks = 0;

  const resolver = await makeDecisionResolver(cwd);
  // Derived state by task id across the WHOLE plan (deps may live in any phase).
  const derivedFor = (taskId: string) => deriveTaskState(events, taskId);

  // Tasks in scope (the whole plan, or just the --phase one) — used to scope
  // conflicts[] to the same view the buckets present.
  const selectedTaskIds = new Set<string>();

  for (const entry of entries) {
    const phaseId = entry.phase.id;
    for (const task of entry.phase.tasks ?? []) {
      selectedTaskIds.add(task.id);
      tasks += 1;
      const derived = derivedFor(task.id);
      by_state[derived.current] += 1;
      const last = derived.last_event;

      if (derived.current === "started" || derived.current === "resumed") {
        in_flight.push({
          task_id: task.id,
          phase_id: phaseId,
          ...(last?.at !== undefined ? { since: last.at } : {}),
          ...(last?.author !== undefined ? { author: last.author } : {}),
        });
      } else if (derived.current === "blocked") {
        blocked.push({
          task_id: task.id,
          phase_id: phaseId,
          ...(last?.reason !== undefined ? { reason: last.reason } : {}),
          ...(last?.author !== undefined ? { author: last.author } : {}),
          ...(last?.at !== undefined ? { since: last.at } : {}),
        });
      } else if (derived.current === "planned") {
        // available vs waiting: ready = deps all done + no missing decision.
        const reasons: WaitingReason[] = [];
        for (const dep of task.depends_on ?? []) {
          if (derivedFor(dep).current !== "done") {
            reasons.push({ code: "WAITING_FOR_DEPENDENCY", task_id: dep });
          }
        }
        if (isDecisionRequiredForTask(entry.phase, task)) {
          const res = await resolver.resolve(task.id, task.decision_refs);
          if (!res.resolved) {
            // Point at the ADR that actually blocks — `decision_refs` is
            // all-must-be-accepted, so the first ref may be accepted while a
            // later one is the blocker. Omit the path for a structurally-invalid
            // (`unsafe_path`) entry: `status` is an activity view, not a
            // structural diagnostic — don't present a dangerous path as "the ADR
            // to fix" (run doctor / plan lint / verify for that). When nothing
            // is considered (filename-scan with no matching ADR), omit the path.
            const failing = res.considered.find((c) => !c.accepted);
            const ref =
              failing !== undefined && failing.acceptance !== "unsafe_path"
                ? failing.path
                : undefined;
            reasons.push({
              code: "MISSING_DECISION",
              ...(ref !== undefined ? { decision_ref: ref } : {}),
            });
          }
        }
        if (reasons.length > 0) {
          waiting.push({ task_id: task.id, phase_id: phaseId, reasons });
        } else {
          available.push({ task_id: task.id, phase_id: phaseId });
        }
      }
      // `done` / `failed` are terminal-ish — counted in totals only.
    }
  }

  // conflicts[] (D3): PROGRESS_EVENT_CONFLICT only, scoped to the tasks in view
  // (the whole plan, or just the --phase one). Reported at scope level like
  // `totals` and NOT narrowed by `--mine`: a conflict is inherently multi-author
  // and is a safety signal, so hiding one you are a party to would be unsafe —
  // `--mine` narrows *your activity buckets*, not the project's conflicts.
  // Structural id conflicts stay with `doctor` / `plan lint` (this is the
  // activity view), so only the event-lifecycle conflict surfaces here. A
  // conflict on an ORPHAN task (an event whose task_id is in no phase) is not in
  // `selectedTaskIds`, so it is excluded here by design — orphan events remain a
  // `plan analyze` / `doctor` (`detectOrphanProgressEvents`) concern, not activity.
  const conflicts: ConflictEntry[] = [];
  for (const issue of detectProgressEventConflicts(events)) {
    const taskId = issue.task_id;
    if (taskId === undefined || !selectedTaskIds.has(taskId)) continue;
    // The sole producer (`detectProgressEventConflicts`) always attaches a
    // non-empty `details.events[]`; read it through a typed guard rather than a
    // bare cast. If it is ever absent we still surface the conflict (never drop a
    // safety signal) but with empty sides — attribution degrades, the signal does
    // not. `event_id`/`status`/`author?`/`at` shape is owned by the producer.
    const sides =
      (issue.details as { events?: ConflictEventEntry[] } | undefined)?.events ?? [];
    conflicts.push({
      task_id: taskId,
      code: "PROGRESS_EVENT_CONFLICT",
      details: { events: sides },
    });
  }

  // --mine: keep only MY active work (in-flight + blocked authored by me).
  // `available` / `waiting` are unauthored project suggestions — not "mine".
  // When the filter is unsupported, return empty buckets (can't filter ≠ no work).
  if (filter.mine === true) {
    if (filter.supported === true && mineAuthor !== undefined) {
      return {
        filter,
        in_flight: in_flight.filter((e) => e.author === mineAuthor),
        blocked: blocked.filter((e) => e.author === mineAuthor),
        available: [],
        waiting: [],
        conflicts,
        totals: { tasks, by_state },
      };
    }
    return {
      filter,
      in_flight: [],
      blocked: [],
      available: [],
      waiting: [],
      conflicts,
      totals: { tasks, by_state },
    };
  }

  return {
    filter,
    in_flight,
    blocked,
    available,
    waiting,
    conflicts,
    totals: { tasks, by_state },
  };
}
