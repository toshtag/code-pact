import { createHash } from "node:crypto";
import { runTaskComplete } from "../../commands/task-complete.ts";
import { atomicReplaceExistingText } from "../../io/atomic-text.ts";
import { ExecutorError } from "./executor.ts";
import { truncateExecuteReason } from "./types.ts";
import { loadPhase } from "../plan/load-phase.ts";
import { resolveTaskInRoadmap } from "../plan/resolve-task.ts";
import { loadProgressLog } from "../progress/io.ts";
import { loadProject, resolveEnabledAgent } from "../project.ts";
import {
  readOwnedTextBounded,
  resolveExecuteSourceReadPath,
  resolveExecuteSourceWritePath,
} from "../project-fs/index.ts";
import { applyExactReplacement } from "./exact-replacement.ts";
import { resolveOneShotEligibility } from "./eligibility.ts";
import { projectVerifyForAgent } from "../evidence/failure-capsule.ts";
import {
  changedPaths,
  findStatusEntry,
  getExecutionGitSnapshot,
  isOnlyWorktreeModifyOf,
  snapshotHeadChanged,
  snapshotIndexChanged,
  snapshotIsClean,
  type GitSnapshot,
} from "./git-status.ts";
import { parseOneShotExecutorOutput } from "./output-schema.ts";
import {
  MAX_EXECUTOR_INPUT_BYTES,
  MAX_SOURCE_BYTES,
  type BoundedFailureCapsule,
  type BoundedPathSummary,
  type OneShotExecutor,
  type OneShotExecutorInput,
  type TaskExecuteOnceResult,
} from "./types.ts";
import type { CheckResult, VerifyResult } from "../../commands/verify.ts";

export type RunTaskExecuteOnceOptions = {
  cwd: string;
  taskId: string;
  agent?: string;
  executor: OneShotExecutor;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const MAX_PATH_SAMPLE_COUNT = 20;
const MAX_PATH_SAMPLE_BYTES = 4096;

type RollbackResult = {
  rollback: "complete" | "incomplete" | "stale";
  head_changed: boolean;
  index_changed: boolean;
  finalSnapshot: GitSnapshot | null;
  rollbackReason?: string;
};

export function boundedPathSummary(paths: string[]): BoundedPathSummary {
  const unique = [...new Set(paths)].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const sample: string[] = [];
  let bytes = 0;
  for (const p of unique) {
    const pBytes = Buffer.byteLength(p, "utf8");
    if (pBytes > MAX_PATH_SAMPLE_BYTES) {
      continue;
    }
    if (
      sample.length >= MAX_PATH_SAMPLE_COUNT ||
      bytes + pBytes > MAX_PATH_SAMPLE_BYTES
    ) {
      continue;
    }
    sample.push(p);
    bytes += pBytes;
  }
  return {
    changed_path_count: unique.length,
    changed_paths: sample,
    paths_truncated: sample.length < unique.length,
  };
}

function sha256(content: string): string {
  return createHash("sha256")
    .update(Buffer.from(content, "utf8"))
    .digest("hex");
}

function gitErrorResult(reason: string): TaskExecuteOnceResult {
  return {
    kind: "executor_failed",
    reason: truncateExecuteReason(`git state read failed: ${reason}`),
  };
}

/** Best-effort rollback of the source file to `originalContent`.
 *
 * Returns `complete` only when:
 *   - HEAD did not change,
 *   - the source was the only worktree modification (` M sourcePath`),
 *   - the source could be re-read as bounded text,
 *   - compare-and-swap restored the original, and
 *   - the post-rollback snapshot is clean.
 *
 * Anything else (staged change, deletion, directory/symlink replacement,
 * HEAD commit, concurrent drift, or extra changed files) yields
 * `incomplete` or `stale`. HEAD is never reset.
 */
async function rollbackSourceIfSafe(
  cwd: string,
  sourcePath: string,
  originalContent: string,
  before: GitSnapshot,
  after: GitSnapshot,
): Promise<RollbackResult> {
  const head_changed = snapshotHeadChanged(before, after);
  const index_changed = snapshotIndexChanged(after);

  if (head_changed) {
    return {
      rollback: "incomplete",
      head_changed,
      index_changed,
      finalSnapshot: after,
      rollbackReason: "HEAD changed; refusing to reset",
    };
  }

  const entry = findStatusEntry(after, sourcePath);
  if (!entry) {
    return {
      rollback: "incomplete",
      head_changed,
      index_changed,
      finalSnapshot: after,
      rollbackReason: "source was not modified",
    };
  }

  if (entry.index !== " " || entry.worktree !== "M") {
    return {
      rollback: "incomplete",
      head_changed,
      index_changed,
      finalSnapshot: after,
      rollbackReason: `source status is ${entry.index}${entry.worktree}`,
    };
  }

  try {
    const readPath = await resolveExecuteSourceReadPath(cwd, sourcePath);
    const currentContent = await readOwnedTextBounded(
      readPath,
      MAX_SOURCE_BYTES,
    );
    await restoreOriginalFile(cwd, sourcePath, originalContent, currentContent);
  } catch (error) {
    if ((error as Error).message === "destination changed before write") {
      return {
        rollback: "stale",
        head_changed,
        index_changed,
        finalSnapshot: after,
        rollbackReason: "source changed during rollback",
      };
    }
    return {
      rollback: "incomplete",
      head_changed,
      index_changed,
      finalSnapshot: after,
      rollbackReason: `rollback failed: ${(error as Error).message}`,
    };
  }

  const finalSnapshot = await getExecutionGitSnapshot(cwd);
  if (finalSnapshot.kind === "git_error") {
    return {
      rollback: "incomplete",
      head_changed,
      index_changed,
      finalSnapshot: after,
      rollbackReason: `git status failed after rollback: ${finalSnapshot.reason}`,
    };
  }

  if (snapshotHeadChanged(before, finalSnapshot)) {
    return {
      rollback: "incomplete",
      head_changed: true,
      index_changed: snapshotIndexChanged(finalSnapshot),
      finalSnapshot,
      rollbackReason: "HEAD changed during rollback",
    };
  }

  if (snapshotIsClean(finalSnapshot)) {
    return {
      rollback: "complete",
      head_changed: false,
      index_changed: false,
      finalSnapshot,
    };
  }

  return {
    rollback: "incomplete",
    head_changed: false,
    index_changed: snapshotIndexChanged(finalSnapshot),
    finalSnapshot,
    rollbackReason: "extra worktree changes remain after rollback",
  };
}

function buildMutationResult(
  before: GitSnapshot,
  after: GitSnapshot,
  rollback: RollbackResult,
): Extract<TaskExecuteOnceResult, { kind: "executor_mutated_worktree" }> {
  return {
    kind: "executor_mutated_worktree",
    paths: boundedPathSummary(changedPaths(after)),
    rollback: rollback.rollback,
    head_changed: snapshotHeadChanged(before, after),
    index_changed: snapshotIndexChanged(after),
  };
}

function buildScopeViolationResult(
  before: GitSnapshot,
  after: GitSnapshot,
  rollback: RollbackResult,
): Extract<TaskExecuteOnceResult, { kind: "execution_scope_violation" }> {
  const final = rollback.finalSnapshot ?? after;
  return {
    kind: "execution_scope_violation",
    paths: boundedPathSummary(changedPaths(final)),
    rollback: rollback.rollback,
    head_changed: snapshotHeadChanged(before, final),
    index_changed: snapshotIndexChanged(final),
  };
}

export async function runTaskExecuteOnce(
  opts: RunTaskExecuteOnceOptions,
): Promise<TaskExecuteOnceResult> {
  const { cwd, taskId, executor, signal } = opts;

  const { phasePath } = await resolveTaskInRoadmap(cwd, taskId);
  const phase = await loadPhase(cwd, phasePath);
  const task = phase.tasks?.find(candidate => candidate.id === taskId);
  if (!task) {
    const error = new Error(`Task "${taskId}" not found in phase.`);
    (error as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw error;
  }

  const { log } = await loadProgressLog(cwd);

  const eligibility = await resolveOneShotEligibility({
    cwd,
    phase,
    task,
    events: log.events,
  });
  if (!eligibility.eligible) {
    return { kind: "ineligible", reasons: eligibility.reasons };
  }

  const sourcePath = eligibility.sourcePath;

  const snapshotBefore = await getExecutionGitSnapshot(cwd);
  if (snapshotBefore.kind === "git_error") {
    return gitErrorResult(snapshotBefore.reason);
  }
  if (!snapshotIsClean(snapshotBefore)) {
    return {
      kind: "worktree_not_clean",
      paths: boundedPathSummary(changedPaths(snapshotBefore)),
    };
  }

  const project = await loadProject(cwd);
  const agentName = resolveEnabledAgent(project, opts.agent);

  let sourceContent: string;
  try {
    const readPath = await resolveExecuteSourceReadPath(cwd, sourcePath);
    sourceContent = await readOwnedTextBounded(readPath, MAX_SOURCE_BYTES);
  } catch (error) {
    return {
      kind: "executor_failed",
      reason: truncateExecuteReason(
        `source read failed: ${(error as Error).message}`,
      ),
    };
  }

  const input: OneShotExecutorInput = {
    schema_version: 1,
    task: {
      id: taskId,
      goal: (task.description ?? phase.objective ?? "").trim(),
      source_path: sourcePath,
      done_when: phase.definition_of_done ?? [],
      verification_command: eligibility.verificationCommand,
    },
    source: {
      content: sourceContent,
      sha256: sha256(sourceContent),
    },
    response_contract: {
      allowed_kinds: ["replace_exact", "blocked"],
    },
  };

  const inputJson = JSON.stringify(input);
  if (Buffer.byteLength(inputJson, "utf8") > MAX_EXECUTOR_INPUT_BYTES) {
    return {
      kind: "executor_failed",
      reason: truncateExecuteReason(
        `executor input exceeds ${MAX_EXECUTOR_INPUT_BYTES} bytes`,
      ),
    };
  }

  let rawOutput: unknown;
  try {
    rawOutput = await executor.invoke(input);
  } catch (error) {
    const message =
      error instanceof ExecutorError
        ? (error as Error).message
        : `${(error as NodeJS.ErrnoException).code ?? "EXECUTOR_FAILED"}: ${(error as Error).message}`;
    return {
      kind: "executor_failed",
      reason: truncateExecuteReason(message),
    };
  }

  const snapshotAfterExecutor = await getExecutionGitSnapshot(cwd);
  if (snapshotAfterExecutor.kind === "git_error") {
    return gitErrorResult(snapshotAfterExecutor.reason);
  }

  if (
    !snapshotIsClean(snapshotAfterExecutor) ||
    snapshotHeadChanged(snapshotBefore, snapshotAfterExecutor)
  ) {
    const rollback = await rollbackSourceIfSafe(
      cwd,
      sourcePath,
      sourceContent,
      snapshotBefore,
      snapshotAfterExecutor,
    );
    return buildMutationResult(
      snapshotBefore,
      snapshotAfterExecutor,
      rollback,
    );
  }

  let output;
  try {
    output = parseOneShotExecutorOutput(rawOutput);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "EXECUTOR_SCHEMA_MISMATCH";
    return {
      kind: "executor_failed",
      reason: truncateExecuteReason(`${code}: ${(error as Error).message}`),
    };
  }

  if (output.kind === "blocked") {
    return { kind: "blocked", reason: output.reason };
  }

  const replacement = {
    path: sourcePath,
    expected_file_sha256: output.expected_file_sha256,
    old_text: output.old_text,
    new_text: output.new_text,
  };

  const applyResult = await applyExactReplacement(cwd, replacement, sourcePath);
  if (applyResult.kind === "rejected") {
    return { kind: "edit_rejected", reason: applyResult.reason };
  }

  const snapshotAfterEdit = await getExecutionGitSnapshot(cwd);
  if (snapshotAfterEdit.kind === "git_error") {
    return gitErrorResult(snapshotAfterEdit.reason);
  }

  if (!isOnlyWorktreeModifyOf(snapshotAfterEdit, sourcePath)) {
    const rollback = await rollbackSourceIfSafe(
      cwd,
      sourcePath,
      applyResult.originalContent,
      snapshotBefore,
      snapshotAfterEdit,
    );
    return buildScopeViolationResult(
      snapshotBefore,
      snapshotAfterEdit,
      rollback,
    );
  }

  let completionResult;
  try {
    completionResult = await runTaskComplete({
      cwd,
      taskId,
      agent: agentName,
      timeoutMs: opts.timeoutMs,
      signal,
      skipLoopMemory: true,
      beforeRecordDone: async () => {
        const snapshot = await getExecutionGitSnapshot(cwd);
        if (snapshot.kind === "git_error") {
          const err = new Error(
            `git status failed before recording done: ${snapshot.reason}`,
          ) as NodeJS.ErrnoException;
          err.code = "EXECUTION_SCOPE_VIOLATION";
          throw err;
        }

        if (snapshotHeadChanged(snapshotBefore, snapshot)) {
          const err = new Error(
            "HEAD changed during verification",
          ) as NodeJS.ErrnoException;
          err.code = "EXECUTION_SCOPE_VIOLATION";
          (
            err as NodeJS.ErrnoException & { head_changed?: boolean }
          ).head_changed = true;
          (
            err as NodeJS.ErrnoException & { snapshot?: GitSnapshot }
          ).snapshot = snapshot;
          throw err;
        }

        if (!isOnlyWorktreeModifyOf(snapshot, sourcePath)) {
          const err = new Error(
            "working tree changed outside the target source file",
          ) as NodeJS.ErrnoException;
          err.code = "EXECUTION_SCOPE_VIOLATION";
          (
            err as NodeJS.ErrnoException & { changed_paths?: string[] }
          ).changed_paths = changedPaths(snapshot).filter(p => p !== sourcePath);
          (
            err as NodeJS.ErrnoException & { index_changed?: boolean }
          ).index_changed = snapshotIndexChanged(snapshot);
          throw err;
        }
      },
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "AGENT_NOT_FOUND" || code === "AGENT_NOT_ENABLED") {
      throw error;
    }

    const snapshotAfterError = await getExecutionGitSnapshot(cwd);
    if (snapshotAfterError.kind === "git_error") {
      return gitErrorResult(snapshotAfterError.reason);
    }

    if (code === "EXECUTION_SCOPE_VIOLATION") {
      const errorWithData = error as NodeJS.ErrnoException & {
        changed_paths?: string[];
        index_changed?: boolean;
        head_changed?: boolean;
        snapshot?: GitSnapshot;
      };
      const headChanged =
        errorWithData.head_changed ??
        snapshotHeadChanged(snapshotBefore, errorWithData.snapshot ?? snapshotAfterError);
      let rollback: RollbackResult;
      if (headChanged) {
        rollback = {
          rollback: "incomplete",
          head_changed: true,
          index_changed:
            errorWithData.index_changed ??
            snapshotIndexChanged(errorWithData.snapshot ?? snapshotAfterError),
          finalSnapshot: errorWithData.snapshot ?? snapshotAfterError,
          rollbackReason: "HEAD changed; refusing to reset",
        };
      } else {
        rollback = await rollbackSourceIfSafe(
          cwd,
          sourcePath,
          applyResult.originalContent,
          snapshotBefore,
          snapshotAfterError,
        );
      }
      return buildScopeViolationResult(
        snapshotBefore,
        snapshotAfterError,
        rollback,
      );
    }

    let failure: BoundedFailureCapsule | undefined;
    if (code === "VERIFICATION_FAILED") {
      const checks =
        (error as NodeJS.ErrnoException & { checks?: CheckResult[] }).checks ??
        [];
      const verifyResult: VerifyResult = { ok: false, checks };
      failure = (
        await projectVerifyForAgent(cwd, verifyResult, {
          skipEvidenceStore: true,
        })
      ).failure;
    }

    const rollback = await rollbackSourceIfSafe(
      cwd,
      sourcePath,
      applyResult.originalContent,
      snapshotBefore,
      snapshotAfterError,
    );
    const finalSnapshot = rollback.finalSnapshot ?? snapshotAfterError;

    if (rollback.rollback === "stale") {
      return {
        kind: "rollback_stale_file",
        reason: rollback.rollbackReason ?? "source changed during rollback",
        applied_sha: sha256(applyResult.appliedContent),
      };
    }

    if (rollback.rollback !== "complete") {
      return {
        kind: "rollback_failed",
        reason: rollback.rollbackReason ?? "rollback failed",
        failure,
      };
    }

    if (
      !snapshotIsClean(finalSnapshot) ||
      snapshotHeadChanged(snapshotBefore, finalSnapshot)
    ) {
      return {
        kind: "rollback_incomplete",
        paths: boundedPathSummary(changedPaths(finalSnapshot)),
        failure,
      };
    }

    if (code === "VERIFICATION_FAILED" && failure !== undefined) {
      return {
        kind: "verification_failed",
        rolled_back: true,
        failure,
      };
    }

    return {
      kind: "executor_failed",
      reason: truncateExecuteReason(
        typeof code === "string" && code.length > 0
          ? `${code}: ${(error as Error).message}`
          : (error as Error).message,
      ),
    };
  }

  if (completionResult.kind !== "done") {
    const rollback = await rollbackSourceIfSafe(
      cwd,
      sourcePath,
      applyResult.originalContent,
      snapshotBefore,
      snapshotAfterEdit,
    );
    const finalSnapshot = rollback.finalSnapshot ?? snapshotAfterEdit;

    if (rollback.rollback === "stale") {
      return {
        kind: "rollback_stale_file",
        reason: rollback.rollbackReason ?? "source changed during rollback",
        applied_sha: sha256(applyResult.appliedContent),
      };
    }

    if (rollback.rollback !== "complete") {
      return {
        kind: "rollback_failed",
        reason: rollback.rollbackReason ?? "rollback failed",
      };
    }

    if (
      !snapshotIsClean(finalSnapshot) ||
      snapshotHeadChanged(snapshotBefore, finalSnapshot)
    ) {
      return {
        kind: "rollback_incomplete",
        paths: boundedPathSummary(changedPaths(finalSnapshot)),
      };
    }

    return {
      kind: "executor_failed",
      reason: truncateExecuteReason(
        `task complete returned unexpected kind: ${completionResult.kind}`,
      ),
    };
  }

  return {
    kind: "done",
    task_id: taskId,
    changed_file: sourcePath,
    verification: "passed",
  };
}

type RestoreResult =
  | { kind: "ok" }
  | { kind: "stale"; reason: string; applied_sha: string }
  | { kind: "failed"; reason: string };

async function restoreOriginalFile(
  cwd: string,
  sourcePath: string,
  originalContent: string,
  appliedContent: string,
): Promise<RestoreResult> {
  try {
    const writePath = await resolveExecuteSourceWritePath(cwd, sourcePath);
    await atomicReplaceExistingText(writePath, originalContent, appliedContent);
    return { kind: "ok" };
  } catch (error) {
    if ((error as Error).message === "destination changed before write") {
      return {
        kind: "stale",
        reason:
          "source file changed after edit; rollback refused to overwrite concurrent update",
        applied_sha: sha256(appliedContent),
      };
    }
    return {
      kind: "failed",
      reason: truncateExecuteReason(
        `ROLLBACK_FAILED: ${(error as Error).message}`,
      ),
    };
  }
}
