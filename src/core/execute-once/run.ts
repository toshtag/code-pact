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
  getExecutionGitSnapshot,
  isOnlyWorktreeModifyOf,
  snapshotHeadChanged,
  snapshotIndexChanged,
  snapshotIsClean,
  type GitSnapshot,
  type GitSnapshotError,
  type GitSnapshotProvider,
} from "./git-status.ts";
import { parseOneShotExecutorOutput } from "./output-schema.ts";
import {
  MAX_EXECUTOR_FAILED_REASON_BYTES,
  MAX_EXECUTOR_INPUT_BYTES,
  MAX_SOURCE_BYTES,
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
  /** Internal test hook. Not exposed through the CLI or executor contract. */
  gitSnapshotProvider?: GitSnapshotProvider;
};

const MAX_PATH_SAMPLE_COUNT = 20;
const MAX_PATH_SAMPLE_BYTES = 4096;

type RollbackResult = {
  rollback: "complete" | "incomplete" | "stale";
  head_changed: boolean;
  index_changed: boolean;
  finalSnapshot: GitSnapshot;
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

function truncateReason(text: string): string {
  return truncateExecuteReason(text, MAX_EXECUTOR_FAILED_REASON_BYTES);
}

async function assertAppliedSourceUnchanged(
  cwd: string,
  sourcePath: string,
  appliedContent: string,
): Promise<void> {
  const readPath = await resolveExecuteSourceReadPath(cwd, sourcePath);
  let currentContent: string;
  try {
    currentContent = await readOwnedTextBounded(readPath, MAX_SOURCE_BYTES);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message =
      code === "ENOTFILE" || code === "ELOOP"
        ? "source is not a regular file"
        : code === "OWNED_TEXT_TOO_LARGE"
          ? "source exceeds maximum size"
          : code === "OWNED_TEXT_INVALID_UTF8"
            ? "source is not valid UTF-8"
            : `source read failed: ${(error as Error).message}`;
    const err = new Error(message) as NodeJS.ErrnoException;
    err.code = "EXECUTION_SCOPE_VIOLATION";
    (
      err as NodeJS.ErrnoException & { source_content_drift?: boolean }
    ).source_content_drift = true;
    throw err;
  }

  if (sha256(currentContent) !== sha256(appliedContent)) {
    const err = new Error(
      "source content does not match the applied edit",
    ) as NodeJS.ErrnoException;
    err.code = "EXECUTION_SCOPE_VIOLATION";
    (
      err as NodeJS.ErrnoException & { source_content_drift?: boolean }
    ).source_content_drift = true;
    throw err;
  }
}

type SnapshotGetter = (cwd: string) => Promise<GitSnapshot | GitSnapshotError>;

type KnownEditRollbackResult = {
  sourceRollback: "complete" | "stale" | "failed";
  finalSnapshot: GitSnapshot | GitSnapshotError | null;
  restoreResult: RestoreResult;
};

function gitStateUnavailableResult(
  reason: string,
  source_rollback: "complete" | "stale" | "failed" | "not_needed",
): Extract<TaskExecuteOnceResult, { kind: "git_state_unavailable" }> {
  return {
    kind: "git_state_unavailable",
    reason: truncateReason(reason),
    source_rollback,
  };
}

/** Rollback a known Code Pact edit using the captured applied content as the
 * CAS expected-current value. Always attempts the file restore; git state is
 * captured afterward if possible but a snapshot failure is reported to the
 * caller instead of being swallowed.
 */
async function rollbackKnownEdit(
  cwd: string,
  sourcePath: string,
  originalContent: string,
  appliedContent: string,
  getSnapshot: SnapshotGetter,
): Promise<KnownEditRollbackResult> {
  const restoreResult = await restoreOriginalFile(
    cwd,
    sourcePath,
    originalContent,
    appliedContent,
  );
  const finalSnapshot = await getSnapshot(cwd);
  const sourceRollback: KnownEditRollbackResult["sourceRollback"] =
    restoreResult.kind === "ok"
      ? "complete"
      : restoreResult.kind === "stale"
        ? "stale"
        : "failed";
  return { sourceRollback, finalSnapshot, restoreResult };
}

function toRollbackResult(
  before: GitSnapshot,
  restoreResult: RestoreResult,
  finalSnapshot: GitSnapshot,
): RollbackResult {
  if (snapshotHeadChanged(before, finalSnapshot)) {
    return {
      rollback: "incomplete",
      head_changed: true,
      index_changed: snapshotIndexChanged(finalSnapshot),
      finalSnapshot,
      rollbackReason: truncateReason("HEAD changed during rollback"),
    };
  }

  if (restoreResult.kind === "stale") {
    return {
      rollback: "stale",
      head_changed: false,
      index_changed: snapshotIndexChanged(finalSnapshot),
      finalSnapshot,
      rollbackReason: truncateReason(restoreResult.reason),
    };
  }

  if (restoreResult.kind === "failed") {
    return {
      rollback: "incomplete",
      head_changed: false,
      index_changed: snapshotIndexChanged(finalSnapshot),
      finalSnapshot,
      rollbackReason: truncateReason(restoreResult.reason),
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
    rollbackReason: truncateReason(
      "extra worktree changes remain after rollback",
    ),
  };
}

function buildMutationResult(
  before: GitSnapshot,
  after: GitSnapshot,
): Extract<TaskExecuteOnceResult, { kind: "executor_mutated_worktree" }> {
  return {
    kind: "executor_mutated_worktree",
    paths: boundedPathSummary(changedPaths(after)),
    rollback: "not_attempted",
    rollback_reason: "mutation provenance cannot be proven",
    head_changed: snapshotHeadChanged(before, after),
    index_changed: snapshotIndexChanged(after),
  };
}

function buildScopeViolationResult(
  before: GitSnapshot,
  rollback: RollbackResult,
): Extract<TaskExecuteOnceResult, { kind: "execution_scope_violation" }> {
  const final = rollback.finalSnapshot ?? before;
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
  const getSnapshot: SnapshotGetter =
    opts.gitSnapshotProvider ?? getExecutionGitSnapshot;

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

  const snapshotBefore = await getSnapshot(cwd);
  if (snapshotBefore.kind === "git_error") {
    return gitStateUnavailableResult(snapshotBefore.reason, "not_needed");
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

  const snapshotAfterExecutor = await getSnapshot(cwd);
  if (snapshotAfterExecutor.kind === "git_error") {
    return gitStateUnavailableResult(
      snapshotAfterExecutor.reason,
      "not_needed",
    );
  }

  if (
    !snapshotIsClean(snapshotAfterExecutor) ||
    snapshotHeadChanged(snapshotBefore, snapshotAfterExecutor)
  ) {
    return buildMutationResult(snapshotBefore, snapshotAfterExecutor);
  }

  let output;
  try {
    output = parseOneShotExecutorOutput(rawOutput);
  } catch (error) {
    const code =
      (error as NodeJS.ErrnoException).code ?? "EXECUTOR_SCHEMA_MISMATCH";
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

  const snapshotAfterEdit = await getSnapshot(cwd);
  if (snapshotAfterEdit.kind === "git_error") {
    const rollback = await rollbackKnownEdit(
      cwd,
      sourcePath,
      applyResult.originalContent,
      applyResult.appliedContent,
      getSnapshot,
    );
    return gitStateUnavailableResult(
      snapshotAfterEdit.reason,
      rollback.sourceRollback,
    );
  }

  if (!isOnlyWorktreeModifyOf(snapshotAfterEdit, sourcePath)) {
    const rollback = await rollbackKnownEdit(
      cwd,
      sourcePath,
      applyResult.originalContent,
      applyResult.appliedContent,
      getSnapshot,
    );
    if (
      rollback.finalSnapshot === null ||
      rollback.finalSnapshot.kind === "git_error"
    ) {
      return gitStateUnavailableResult(
        rollback.finalSnapshot?.reason ??
          "git status unavailable after rollback",
        rollback.sourceRollback,
      );
    }
    const rb = toRollbackResult(
      snapshotBefore,
      rollback.restoreResult,
      rollback.finalSnapshot,
    );
    return buildScopeViolationResult(snapshotBefore, rb);
  }

  let completionResult;
  try {
    // Verify the applied edit is still intact before we let verification run.
    await assertAppliedSourceUnchanged(
      cwd,
      sourcePath,
      applyResult.appliedContent,
    );

    completionResult = await runTaskComplete({
      cwd,
      taskId,
      agent: agentName,
      timeoutMs: opts.timeoutMs,
      signal,
      skipLoopMemory: true,
      beforeRecordDone: async () => {
        const snapshot = await getSnapshot(cwd);
        if (snapshot.kind === "git_error") {
          const err = new Error(
            `git status failed before recording done: ${snapshot.reason}`,
          ) as NodeJS.ErrnoException;
          err.code = "GIT_STATE_UNAVAILABLE";
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
          (err as NodeJS.ErrnoException & { snapshot?: GitSnapshot }).snapshot =
            snapshot;
          throw err;
        }

        if (!isOnlyWorktreeModifyOf(snapshot, sourcePath)) {
          const err = new Error(
            "working tree changed outside the target source file",
          ) as NodeJS.ErrnoException;
          err.code = "EXECUTION_SCOPE_VIOLATION";
          (
            err as NodeJS.ErrnoException & { changed_paths?: string[] }
          ).changed_paths = changedPaths(snapshot).filter(
            p => p !== sourcePath,
          );
          (
            err as NodeJS.ErrnoException & { index_changed?: boolean }
          ).index_changed = snapshotIndexChanged(snapshot);
          throw err;
        }

        await assertAppliedSourceUnchanged(
          cwd,
          sourcePath,
          applyResult.appliedContent,
        );
      },
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "AGENT_NOT_FOUND" || code === "AGENT_NOT_ENABLED") {
      throw error;
    }

    const rollback = await rollbackKnownEdit(
      cwd,
      sourcePath,
      applyResult.originalContent,
      applyResult.appliedContent,
      getSnapshot,
    );

    if (code === "GIT_STATE_UNAVAILABLE") {
      return gitStateUnavailableResult(
        (error as Error).message,
        rollback.sourceRollback,
      );
    }

    if (
      rollback.finalSnapshot === null ||
      rollback.finalSnapshot.kind === "git_error"
    ) {
      return gitStateUnavailableResult(
        rollback.finalSnapshot?.reason ??
          "git status unavailable after rollback",
        rollback.sourceRollback,
      );
    }

    const rb = toRollbackResult(
      snapshotBefore,
      rollback.restoreResult,
      rollback.finalSnapshot,
    );

    if (code === "EXECUTION_SCOPE_VIOLATION") {
      return buildScopeViolationResult(snapshotBefore, rb);
    }

    if (code === "VERIFICATION_FAILED") {
      const checks =
        (error as NodeJS.ErrnoException & { checks?: CheckResult[] }).checks ??
        [];
      const verifyResult: VerifyResult = { ok: false, checks };
      const { failure } = await projectVerifyForAgent(cwd, verifyResult, {
        skipEvidenceStore: true,
      });

      // If verification failed and left the repository different from the
      // pre-edit state (source content, index, or HEAD), report it as a scope
      // violation. Only a clean rollback with unchanged HEAD is reported as a
      // plain verification failure.
      if (
        rb.rollback !== "complete" ||
        !snapshotIsClean(rb.finalSnapshot) ||
        snapshotHeadChanged(snapshotBefore, rb.finalSnapshot)
      ) {
        return buildScopeViolationResult(snapshotBefore, rb);
      }

      return {
        kind: "verification_failed",
        rolled_back: true,
        failure,
      };
    }

    if (rb.rollback === "stale") {
      return {
        kind: "rollback_stale_file",
        reason: rb.rollbackReason ?? "source changed during rollback",
        applied_sha: sha256(applyResult.appliedContent),
      };
    }

    if (rb.rollback !== "complete") {
      return {
        kind: "rollback_failed",
        reason: rb.rollbackReason ?? "rollback failed",
      };
    }

    if (
      !snapshotIsClean(rb.finalSnapshot) ||
      snapshotHeadChanged(snapshotBefore, rb.finalSnapshot)
    ) {
      return {
        kind: "rollback_incomplete",
        paths: boundedPathSummary(changedPaths(rb.finalSnapshot)),
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
    const rollback = await rollbackKnownEdit(
      cwd,
      sourcePath,
      applyResult.originalContent,
      applyResult.appliedContent,
      getSnapshot,
    );
    if (
      rollback.finalSnapshot === null ||
      rollback.finalSnapshot.kind === "git_error"
    ) {
      return gitStateUnavailableResult(
        rollback.finalSnapshot?.reason ??
          "git status unavailable after rollback",
        rollback.sourceRollback,
      );
    }
    const rb = toRollbackResult(
      snapshotBefore,
      rollback.restoreResult,
      rollback.finalSnapshot,
    );

    if (rb.rollback === "stale") {
      return {
        kind: "rollback_stale_file",
        reason: rb.rollbackReason ?? "source changed during rollback",
        applied_sha: sha256(applyResult.appliedContent),
      };
    }

    if (rb.rollback !== "complete") {
      return {
        kind: "rollback_failed",
        reason: rb.rollbackReason ?? "rollback failed",
      };
    }

    if (
      !snapshotIsClean(rb.finalSnapshot) ||
      snapshotHeadChanged(snapshotBefore, rb.finalSnapshot)
    ) {
      return {
        kind: "rollback_incomplete",
        paths: boundedPathSummary(changedPaths(rb.finalSnapshot)),
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
