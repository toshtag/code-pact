import { deriveTaskState } from "../progress/task-state.ts";
import type { ProgressEvent } from "../schemas/progress-event.ts";
import type { Task } from "../schemas/task.ts";
import type { DependsOnEntry } from "./types.ts";

// ---------------------------------------------------------------------------
// depends-on resolver.
//
// Builds a per-dependency state snapshot from already-loaded progress
// events so `task runbook` and any other consumer share one resolver
// instead of inlining the pattern. Pure function; no I/O.
//
// An optional `taskPhaseIndex` lets the resolver mark cross-phase
// dependencies. The map shape is `Map<task_id, phase_id>` (where
// phase_id is the phase that DECLARES the task). When a dep id is found
// in the map and the declaring phase differs from `ownPhaseId`, the
// resulting DependsOnEntry carries `phase_id: <declaring-phase-id>`.
// Same-phase deps and unresolved deps omit the field to preserve the
// stable additive surface.
// ---------------------------------------------------------------------------

export interface ResolveDependsOnOptions {
  /** Phase id of the task whose depends_on we are resolving. */
  ownPhaseId?: string;
  /** Map of task_id → declaring phase_id, covering every phase in the project. */
  taskPhaseIndex?: ReadonlyMap<string, string>;
}

/**
 * Resolves the derived state of each entry in `task.depends_on`, returning
 * one DependsOnEntry per dependency. `satisfied` is true iff the dependency's
 * current derived state is `"done"`.
 *
 * Tasks with no `depends_on` field produce an empty array.
 *
 * When `options.taskPhaseIndex` is supplied, cross-phase references (a dep
 * that resolves to a task declared in a different phase from `options.
 * ownPhaseId`) gain an additive `phase_id` field on the returned entry.
 */
export function resolveDependsOnStates(
  events: readonly ProgressEvent[],
  task: Task,
  options?: ResolveDependsOnOptions,
): DependsOnEntry[] {
  const deps = task.depends_on ?? [];
  const index = options?.taskPhaseIndex;
  const ownPhaseId = options?.ownPhaseId;
  return deps.map((depId) => {
    const state = deriveTaskState(events, depId);
    const entry: DependsOnEntry = {
      task_id: depId,
      current: state.current,
      satisfied: state.current === "done",
    };
    if (index && ownPhaseId) {
      const declaringPhase = index.get(depId);
      if (declaringPhase && declaringPhase !== ownPhaseId) {
        entry.phase_id = declaringPhase;
      }
    }
    return entry;
  });
}

/**
 * Builds the task_id → phase_id index used by the cross-phase resolver.
 * Duplicate ids across phases pick the first occurrence in iteration
 * order; the duplicate-id diagnostic (TASK_DUPLICATE_ID_GLOBAL) is what
 * alerts the user, so the resolver does not re-warn here.
 */
export function buildTaskPhaseIndex(
  phases: ReadonlyArray<{ id: string; tasks?: ReadonlyArray<{ id: string }> }>,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const phase of phases) {
    for (const task of phase.tasks ?? []) {
      if (!index.has(task.id)) {
        index.set(task.id, phase.id);
      }
    }
  }
  return index;
}
