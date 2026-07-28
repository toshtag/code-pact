import type { PhaseEntry } from "../state.ts";
import type { PlanIssue } from "../shared.ts";
import { validateReviewContractForTask } from "../../review-contract.ts";

// ---------------------------------------------------------------------------
// Review contract detectors (P90-T0)
//
// Two diagnostics with deliberately different weights:
//
//   TASK_REVIEW_CONTRACT_MISSING — a not-yet-finished task declares no review
//     contract at all. ADVISORY (`affects_exit: false`). It does NOT yet block
//     `task lock`: the refusal ships with the enforcement stage and its rollout
//     policy, so an existing plan full of pre-contract tasks keeps working
//     across the upgrade. Making this exit-relevant would break those plans
//     today, and that is a migration problem, not a defect.
//
//   TASK_REVIEW_CONTRACT_INVALID — the contract parsed but contradicts the task
//     it belongs to. ERROR: this one cannot be a migration artifact, because a
//     contract only exists if someone wrote it after the field did.
//
// Both delegate to the same `validateReviewContractForTask` that `task add` and
// the lock path use, so lint can never accept a contract those refuse.
// ---------------------------------------------------------------------------

/** Tasks whose review boundary is still a live requirement. A `done` or
 *  `cancelled` task's contract can no longer change what gets reviewed, so a
 *  missing one there is history, not a gap to close. */
function reviewBoundaryIsLive(status: string): boolean {
  return status === "planned" || status === "in_progress";
}

/** An active task that declares no review contract at all. Advisory. */
export function detectTaskReviewContractMissing(
  phases: PhaseEntry[],
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      if (!reviewBoundaryIsLive(task.status)) continue;
      if (task.review_contract !== undefined) continue;
      issues.push({
        code: "TASK_REVIEW_CONTRACT_MISSING",
        severity: "warning",
        affects_exit: false,
        message: `Task "${task.id}" declares no review_contract, so its review boundary is undeclared. Add a boundary contract (producer, consumer, runner, OS, security, the platform matrix, and the planned evidence), or a minimal contract if this is genuinely low-risk docs or mechanical_refactor work. Locking still works today; declaring it now is what keeps the task lockable once the contract becomes required.`,
        file: ref.path,
        phase_id: phase.id,
        task_id: task.id,
        path: "review_contract",
        recovery: {
          manual_action:
            "Add a review_contract block to the task in its phase YAML.",
          confirm: "code-pact plan lint --include-quality --json",
          reference: "docs/review-contract.md",
        },
      });
    }
  }
  return issues;
}

/** A declared review contract that contradicts its task. Error. */
export function detectTaskReviewContractInvalid(
  phases: PhaseEntry[],
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      for (const problem of validateReviewContractForTask(task)) {
        issues.push({
          code: "TASK_REVIEW_CONTRACT_INVALID",
          severity: "error",
          message: problem.message,
          file: ref.path,
          phase_id: phase.id,
          task_id: task.id,
          path: problem.path,
          details: problem.details,
        });
      }
    }
  }
  return issues;
}
