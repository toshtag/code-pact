import { isDecisionRequiredForTask } from "../decisions/adr.ts";
import type { LifecycleMode } from "../schemas/recommend-result.ts";
import type { Task } from "../schemas/task.ts";

/** Decision context the lifecycle decision needs from outside the task itself. */
export type DecisionContext = { phaseRequiresDecision: boolean };

/**
 * Recommends which lifecycle an agent should run for a task. Conservative and
 * deterministic — a finite switch on task attributes, never free-form.
 *
 * Advisory only: code-pact's own `task complete` / `task record-done` behavior
 * is unchanged. See design/decisions/lightweight-lane-rfc.md.
 *
 *   1. requires a decision (task or phase)            → "decision_loop"
 *   2. NOT a decision task, and a small strongly-      → "record_only"
 *      verified docs/test change
 *   3. everything else                                → "full_loop"
 *
 * The `record_only` branch checks `requiresDecision === false` explicitly (not
 * just switch order) so a future reorder can never drop a decision task into
 * the light lane. `architecture` is NOT auto-`decision_loop` — only an explicit
 * `requires_decision` triggers it.
 */
export function recommendLifecycleMode(
  task: Task,
  decisionContext: DecisionContext,
): LifecycleMode {
  const requiresDecision = isDecisionRequiredForTask(
    { requires_decision: decisionContext.phaseRequiresDecision },
    task,
  );

  if (requiresDecision === true) {
    return "decision_loop";
  }

  if (
    requiresDecision === false &&
    (task.type === "docs" || task.type === "test") &&
    task.ambiguity === "low" &&
    task.risk === "low" &&
    task.verification_strength === "strong"
  ) {
    return "record_only";
  }

  return "full_loop";
}
