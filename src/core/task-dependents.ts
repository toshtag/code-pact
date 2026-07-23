import type { Phase } from "./schemas/phase.ts";
import type { PhaseStatus } from "./schemas/phase.ts";

/**
 * A direct dependent of a target task. The dependent task lists the target
 * in its `depends_on` array.
 */
export type DirectDependent = {
  phase_id: string;
  task_id: string;
  design_status: PhaseStatus;
};

/**
 * Return every task across `phases` that directly depends on `targetTaskId`.
 * Ordering follows the phase order in `phases` and the task order within each
 * phase. The result is empty when the target has no direct dependents.
 */
export function directTaskDependents(
  phases: readonly Phase[],
  targetTaskId: string,
): DirectDependent[] {
  const dependents: DirectDependent[] = [];
  for (const phase of phases) {
    for (const task of phase.tasks ?? []) {
      if ((task.depends_on ?? []).includes(targetTaskId)) {
        dependents.push({
          phase_id: phase.id,
          task_id: task.id,
          design_status: task.status,
        });
      }
    }
  }
  return dependents;
}
