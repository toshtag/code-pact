import type { PhaseStatus } from "./schemas/phase.ts";
import type { TaskCurrentState } from "./progress/task-state.ts";
import type { DirectDependent } from "./task-dependents.ts";

/**
 * Error code for any lifecycle operation attempted on a cancelled task.
 */
export const TASK_CANCELLED_CODE = "TASK_CANCELLED";

/**
 * Error code for `task cancel` when the target task is ineligible for
 * cancellation (already done, derived done, etc.).
 */
export const TASK_CANCEL_NOT_ALLOWED_CODE = "TASK_CANCEL_NOT_ALLOWED";

/**
 * Error code for `task cancel` when non-cancelled direct dependents would
 * be orphaned by the cancellation.
 */
export const TASK_CANCEL_DEPENDENTS_EXIST_CODE =
  "TASK_CANCEL_DEPENDENTS_EXIST";

/**
 * Throw `TASK_CANCELLED` when a task's design status is `cancelled`.
 * Lifecycle commands call this before any side effect so cancelled tasks
 * are terminal by construction.
 */
export function assertTaskLifecycleNotCancelled(
  taskId: string,
  designStatus: PhaseStatus,
  derivedState?: TaskCurrentState,
): void {
  if (designStatus === "cancelled") {
    const err = new Error(
      `Task "${taskId}" is cancelled. No further lifecycle operations are allowed.`,
    ) as NodeJS.ErrnoException & {
      task_id?: string;
      design_status?: PhaseStatus;
      derived_state?: TaskCurrentState;
    };
    err.code = TASK_CANCELLED_CODE;
    err.task_id = taskId;
    err.design_status = designStatus;
    if (derivedState !== undefined) err.derived_state = derivedState;
    throw err;
  }
}

/**
 * Assert a target task may be cancelled. Rejects already-terminal tasks:
 *   - design_status is `done`, or
 *   - derived progress state is `done`.
 */
export function assertTaskCancelEligibility(
  taskId: string,
  designStatus: PhaseStatus,
  derivedState: TaskCurrentState,
): void {
  if (designStatus === "done" || derivedState === "done") {
    const err = new Error(
      `Task "${taskId}" cannot be cancelled: it is already done.`,
    ) as NodeJS.ErrnoException & {
      task_id?: string;
      design_status?: PhaseStatus;
      derived_state?: TaskCurrentState;
    };
    err.code = TASK_CANCEL_NOT_ALLOWED_CODE;
    err.task_id = taskId;
    err.design_status = designStatus;
    err.derived_state = derivedState;
    throw err;
  }
}

/**
 * Assert `task cancel` has no non-cancelled direct dependents. A dependent
 * whose design status is `cancelled` is ignored, matching the terminal
 * lifecycle semantics of cancellation.
 */
export function assertNoNonCancelledTaskDependents(
  taskId: string,
  dependents: readonly DirectDependent[],
): void {
  const blocking = dependents.filter((d) => d.design_status !== "cancelled");
  if (blocking.length > 0) {
    const err = new Error(
      `Task "${taskId}" cannot be cancelled: it has non-cancelled direct dependents: ${blocking
        .map((d) => `${d.task_id} (phase ${d.phase_id})`)
        .join(", ")}. Cancel or complete them first.`,
    ) as NodeJS.ErrnoException & {
      task_id?: string;
      dependents?: { task_id: string; phase_id: string; design_status: PhaseStatus }[];
    };
    err.code = TASK_CANCEL_DEPENDENTS_EXIST_CODE;
    err.task_id = taskId;
    err.dependents = blocking.map((d) => ({
      task_id: d.task_id,
      phase_id: d.phase_id,
      design_status: d.design_status,
    }));
    throw err;
  }
}
