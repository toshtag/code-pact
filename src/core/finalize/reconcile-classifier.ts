import type { PhaseStatus } from "../schemas/phase.ts";
import type { TaskCurrentState } from "../progress/task-state.ts";

// ---------------------------------------------------------------------------
// Reconcile classifier — lives under `src/core/` so `src/core/runbook/` can
// reuse it without inverting the dependency direction (core must not import
// from the command layer).
//
// Pure function: given a task's design status and derived progress state,
// returns the reconcile action and a reason string. No I/O, no schema
// loading, no command-layer concerns. Both `phase reconcile` (the command)
// and the runbook builders import from here.
// ---------------------------------------------------------------------------

export type ReconcileAction = "flip" | "skip" | "manual_review";

export type ReconcileClassification = {
  action: ReconcileAction;
  reason: string | null;
};

/**
 * Classifies a single task's reconciliation action. Per the P11 RFC
 * § Reconciliation model:
 *
 *   - flip:          derived === "done" AND design ≠ "done"
 *   - skip:          design === "done" already, OR derived === "planned"
 *                    (no events, no drift)
 *   - manual_review: derived ∈ {blocked, failed} (states reconcile cannot
 *                    resolve)
 *
 * `started` / `resumed` are treated as skip — work in progress, no drift
 * to fix.
 */
export function classifyReconcile(
  designStatus: PhaseStatus,
  derivedState: TaskCurrentState,
): ReconcileClassification {
  if (derivedState === "done" && designStatus !== "done") {
    return { action: "flip", reason: null };
  }
  if (designStatus === "done") {
    return { action: "skip", reason: "design status already done" };
  }
  if (derivedState === "planned") {
    return { action: "skip", reason: "not yet done (no events recorded)" };
  }
  if (derivedState === "started" || derivedState === "resumed") {
    return {
      action: "skip",
      reason: `work in progress (derived state: ${derivedState})`,
    };
  }
  // blocked / failed: reconcile cannot resolve; surface for human attention.
  return {
    action: "manual_review",
    reason: `derived state is ${derivedState}; reconcile cannot resolve this — run plan analyze for diagnosis`,
  };
}
