import type { ProgressEvent } from "../schemas/progress-event.ts";

/**
 * Derived current state of a task. `planned` is the implicit state for a
 * task that has no events yet. Other values mirror EventStatus.
 */
export type TaskCurrentState =
  | "planned"
  | "started"
  | "blocked"
  | "resumed"
  | "done"
  | "failed";

/** Transitions accepted by assertTransition. */
export type TaskTransition = "started" | "blocked" | "resumed" | "done" | "failed";

export type DerivedTaskState = {
  task_id: string;
  current: TaskCurrentState;
  last_event?: ProgressEvent;
  history: ProgressEvent[];
};

/**
 * Derive the current state of a task from the append-only event log.
 * The latest event in chronological order determines `current`. With no
 * events, the task is considered `planned`.
 */
export function deriveTaskState(
  events: readonly ProgressEvent[],
  taskId: string,
): DerivedTaskState {
  const history = events.filter((e) => e.task_id === taskId);
  const last = history[history.length - 1];
  if (!last) {
    return { task_id: taskId, current: "planned", history: [] };
  }
  return {
    task_id: taskId,
    current: last.status,
    last_event: last,
    history,
  };
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<TaskCurrentState, ReadonlyArray<TaskTransition>>
> = {
  planned: ["started"],
  started: ["blocked", "done", "failed"],
  blocked: ["resumed", "failed"],
  resumed: ["blocked", "done", "failed"],
  done: [],
  failed: ["started"],
};

/**
 * Throw INVALID_TASK_TRANSITION if the proposed transition is not in the
 * allowed-transitions table for the given current state.
 *
 * Note: `planned → done` is intentionally NOT allowed here. `task complete`
 * permits that path at the command layer as a legacy-compat shortcut, but
 * the deterministic state machine rejects it.
 */
export function assertTransition(
  current: TaskCurrentState,
  next: TaskTransition,
): void {
  const allowed = ALLOWED_TRANSITIONS[current];
  if (allowed.includes(next)) return;
  const err = new Error(
    `Invalid task state transition: ${current} → ${next}.`,
  );
  (err as NodeJS.ErrnoException).code = "INVALID_TASK_TRANSITION";
  (err as NodeJS.ErrnoException & {
    current?: TaskCurrentState;
    next?: TaskTransition;
  }).current = current;
  (err as NodeJS.ErrnoException & {
    current?: TaskCurrentState;
    next?: TaskTransition;
  }).next = next;
  throw err;
}
