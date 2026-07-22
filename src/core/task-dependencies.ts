import { deriveTaskState } from "./progress/task-state.ts";
import type { ProgressEvent } from "./schemas/progress-event.ts";
import type { Task } from "./schemas/task.ts";

// -----------------------------------------------------------------------------
// Task dependency state resolver.
//
// A single pure helper shared by every task-lifecycle command so that
// `task prepare`, `task start`, `task complete`, `task record-done`,
// `task finalize`, and `execute` all derive the same `incomplete` list from
// the same events and task declaration. No I/O, no mutation.
// -----------------------------------------------------------------------------

export type TaskDependencyState = {
  task_id: string;
  current:
    | "planned"
    | "started"
    | "blocked"
    | "resumed"
    | "done"
    | "failed";
  satisfied: boolean;
};

/**
 * Derive the current state of every task declared in `task.depends_on`.
 * Returns one entry per dependency, in the same order as the declaration.
 */
export function resolveTaskDependencyStates(
  events: readonly ProgressEvent[],
  task: Task,
): TaskDependencyState[] {
  const deps = task.depends_on ?? [];
  return deps.map((depId) => {
    const state = deriveTaskState(events, depId);
    return {
      task_id: depId,
      current: state.current,
      satisfied: state.current === "done",
    };
  });
}

/**
 * Return the ids of all declared dependencies whose current state is not
 * `"done"`, preserving declaration order. Empty when the task is unblocked.
 */
export function incompleteTaskDependencyIds(
  events: readonly ProgressEvent[],
  task: Task,
): string[] {
  return resolveTaskDependencyStates(events, task)
    .filter((dep) => !dep.satisfied)
    .map((dep) => dep.task_id);
}
