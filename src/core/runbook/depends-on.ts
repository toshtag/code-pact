import { deriveTaskState } from "../progress/task-state.ts";
import type { ProgressEvent } from "../schemas/progress-event.ts";
import type { Task } from "../schemas/task.ts";
import type { DependsOnEntry } from "./types.ts";

// ---------------------------------------------------------------------------
// depends-on resolver — v1.3 P12-T2.
//
// Extracted from src/commands/task-finalize.ts's inline pattern so both
// `task runbook` and any future consumer can build a per-dependency state
// snapshot from already-loaded progress events. Pure function; no I/O.
// ---------------------------------------------------------------------------

/**
 * Resolves the derived state of each entry in `task.depends_on`, returning
 * one DependsOnEntry per dependency. `satisfied` is true iff the dependency's
 * current derived state is `"done"`.
 *
 * Tasks with no `depends_on` field produce an empty array.
 */
export function resolveDependsOnStates(
  events: readonly ProgressEvent[],
  task: Task,
): DependsOnEntry[] {
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
