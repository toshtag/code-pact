import type { Phase, PhaseStatus } from "../schemas/phase.ts";

// ---------------------------------------------------------------------------
// Task status diff
//
// The minimum data the v1.2 P11 commands need to describe a planned or
// applied write to a single task's `status` field inside a phase YAML.
// `task finalize` emits one diff (or zero, when already at target);
// `phase reconcile` emits zero or more, one per task it wants to flip.
//
// Pure data — no fs, no yaml, no zod. fs / yaml lives in safe-write.ts.
// ---------------------------------------------------------------------------

export type TaskStatusDiff = {
  /** Repo-root-relative POSIX path to the phase YAML. */
  file: string;
  /** Task id whose status is being flipped. */
  task_id: string;
  /** Status before the proposed flip. */
  before: PhaseStatus;
  /** Status after the proposed flip. */
  after: PhaseStatus;
};

/**
 * Computes the diff for flipping a single task's status.
 * Returns `null` when no change is needed (idempotent path):
 *   - the task does not exist in the phase, OR
 *   - the task's current status already equals `targetStatus`.
 *
 * The caller is expected to have validated task existence before
 * calling this; `null` for missing task is a safety net, not a
 * supported branch. Use `safe-write.ts` `classifyWriteRequest` if
 * you need the missing-task case distinguished from no-op.
 */
export function computeTaskStatusDiff(opts: {
  file: string;
  phase: Phase;
  taskId: string;
  targetStatus: PhaseStatus;
}): TaskStatusDiff | null {
  const task = (opts.phase.tasks ?? []).find((t) => t.id === opts.taskId);
  if (!task) return null;
  if (task.status === opts.targetStatus) return null;
  return {
    file: opts.file,
    task_id: opts.taskId,
    before: task.status,
    after: opts.targetStatus,
  };
}

/**
 * One-line human-readable rendering of a diff. Used by command-layer
 * logging (the JSON envelope serializes the structured diff directly).
 *
 * Example: `design/phases/P1-foundation.yaml: P1-T1 planned -> done`
 */
export function formatTaskStatusDiff(diff: TaskStatusDiff): string {
  return `${diff.file}: ${diff.task_id} ${diff.before} -> ${diff.after}`;
}
