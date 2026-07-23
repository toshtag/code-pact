import type { TaskCurrentState } from "./progress/task-state.ts";

/**
 * The two lifecycle inputs that determine whether a task is terminal for
 * phase-level aggregation.
 */
export type PhaseLifecycleTaskState = {
  design_status: "planned" | "in_progress" | "done" | "cancelled";
  derived_state: TaskCurrentState;
};

/**
 * A task is terminal for phase closure when either:
 *   - the design explicitly marks it as `cancelled` (human decision), or
 *   - the progress ledger derives it as `done`.
 *
 * Cancelled tasks keep their historical progress events; cancellation is a
 * terminal status, not a deletion.
 */
export function isTaskTerminalForPhase(
  state: PhaseLifecycleTaskState,
): boolean {
  if (state.design_status === "cancelled") return true;
  if (state.derived_state === "done") return true;
  return false;
}

/**
 * Derive the aggregate phase lifecycle status from a list of task states.
 *
 * Rules (in order):
 *   - no tasks → planned
 *   - every task terminal (done or cancelled) → done
 *   - a non-cancelled task is started / blocked / resumed / failed → in_progress
 *   - a non-terminal task is marked in_progress in design → in_progress
 *   - some terminal tasks and remaining planned tasks → in_progress
 *   - otherwise → planned
 *
 * The input array and task objects are not mutated.
 */
export function derivePhaseLifecycleStatus(
  states: readonly PhaseLifecycleTaskState[],
): "planned" | "in_progress" | "done" {
  if (states.length === 0) return "planned";

  if (states.every(s => isTaskTerminalForPhase(s))) return "done";

  const hasActiveNonTerminal = states.some(
    s =>
      !isTaskTerminalForPhase(s) &&
      (s.derived_state === "started" ||
        s.derived_state === "blocked" ||
        s.derived_state === "resumed" ||
        s.derived_state === "failed"),
  );
  if (hasActiveNonTerminal) return "in_progress";

  const hasDesignInProgress = states.some(
    s => !isTaskTerminalForPhase(s) && s.design_status === "in_progress",
  );
  if (hasDesignInProgress) return "in_progress";

  // A derived-done task plus a remaining planned task means work has started
  // but is not finished, so the phase is in_progress. An explicitly cancelled
  // task is a design-level terminal decision, so a cancelled + planned phase
  // stays planned until the planned task actually starts.
  const hasDoneAndRemainingPlanned =
    states.some(s => s.derived_state === "done") &&
    states.some(
      s => !isTaskTerminalForPhase(s) && s.design_status === "planned",
    );
  if (hasDoneAndRemainingPlanned) return "in_progress";

  return "planned";
}
