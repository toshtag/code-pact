import type { Project, ReviewContractPolicy } from "./schemas/project.ts";
import type { Task } from "./schemas/task.ts";

// ---------------------------------------------------------------------------
// Review contract rollout policy (P90)
//
// The project-level switch that decides whether a task may be locked WITHOUT a
// review contract. It exists so activating the refusal does not make every
// already-planned task in an existing project unlockable the moment the field
// ships: absence reads as `advisory`, which is exactly today's behavior.
//
// Deliberately separate from `src/core/review-contract.ts`. That module answers
// "does this SUPPLIED contract hold?" from the task alone and is pure. This one
// answers "is a contract required here at all?", which is a property of the
// PROJECT, not of the task. Keeping them apart is what lets a supplied-but-
// invalid contract keep raising `TASK_REVIEW_CONTRACT_INVALID` under either
// policy, while the missing-contract refusal is gated on the opt-in.
// ---------------------------------------------------------------------------

/**
 * The policy in force for `project`.
 *
 * An absent field resolves to `advisory`, the backward-compatible reading. An
 * out-of-enum value never reaches here: the project schema rejects it, so
 * `loadProject` fails with `CONFIG_ERROR` rather than degrading to advisory —
 * a typo must not silently disable the gate the maintainer asked for.
 */
export function effectiveReviewContractPolicy(
  project: Project,
): ReviewContractPolicy {
  return project.review_contract_policy ?? "advisory";
}

export type ReviewContractRequiredError = NodeJS.ErrnoException & {
  task_id: string;
  review_contract_policy: ReviewContractPolicy;
};

/**
 * Refuse a task that declares NO review contract when the project requires one.
 *
 * Called from the single point every new lock passes through, so explicit
 * `task lock` and the `task start` auto-lock cannot drift apart. It runs AFTER
 * the supplied-contract validation and BEFORE any git work or file write, which
 * fixes two things at once: a contract that is present but wrong keeps its more
 * specific `TASK_REVIEW_CONTRACT_INVALID` code, and a refusal leaves behind
 * neither a lock file nor a progress event.
 *
 * Under `advisory` this is a no-op — the gap stays a plan-lint advisory.
 */
export function assertReviewContractPolicySatisfied(
  task: Task,
  policy: ReviewContractPolicy,
): void {
  if (policy !== "required") return;
  if (task.review_contract !== undefined) return;

  const err = new Error(
    `Task "${task.id}" declares no review_contract, and this project sets review_contract_policy: required, so it cannot be locked. Declare the task's review boundary in its phase YAML — a boundary contract covering producer, consumer, runner, os, and security, or a minimal contract if this is genuinely low-risk docs or mechanical_refactor work.`,
  ) as ReviewContractRequiredError;
  err.code = "TASK_REVIEW_CONTRACT_REQUIRED";
  err.task_id = task.id;
  err.review_contract_policy = policy;
  throw err;
}
