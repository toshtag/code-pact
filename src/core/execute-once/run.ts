import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);
const MAX_PATH_SAMPLE_COUNT = 20;
const MAX_PATH_SAMPLE_BYTES = 4096;

type WorktreeChanges = { clean: true } | { clean: false; paths: string[] };

async function getWorktreeChanges(cwd: string): Promise<WorktreeChanges> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain",
        "--no-renames",
        "-uall",
      ],
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
    );
    const lines = stdout.split("\n").filter(line => line.length > 0);
    if (lines.length === 0) return { clean: true };
    const paths = lines.map(line => line.slice(3).trim());
    return { clean: false, paths };
  } catch {
    return { clean: false, paths: [] };
  }
}

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

function onlyPathChanged(status: WorktreeChanges, path: string): boolean {
  if (status.clean) return false;
  return status.paths.length === 1 && status.paths[0] === path;
}

function extraPaths(status: WorktreeChanges, path: string): string[] {
  if (status.clean) return [];
  return status.paths.filter(p => p !== path);
}

function sha256(content: string): string {
  return createHash("sha256")
    .update(Buffer.from(content, "utf8"))
    .digest("hex");
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

  const worktreeBefore = await getWorktreeChanges(cwd);
  if (!worktreeBefore.clean) {
    return {
      kind: "worktree_not_clean",
      paths: boundedPathSummary(worktreeBefore.paths),
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

  let output;
  try {
    output = await executor.invoke(input);
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

  const worktreeAfterExecutor = await getWorktreeChanges(cwd);
  if (!worktreeAfterExecutor.clean) {
    // The executor is not allowed to touch the working tree before returning.
    // If it mutated the source file, try to restore the original content.
    if (
      !worktreeAfterExecutor.clean &&
      worktreeAfterExecutor.paths.includes(sourcePath)
    ) {
      try {
        const readPath = await resolveExecuteSourceReadPath(cwd, sourcePath);
        const mutatedContent = await readOwnedTextBounded(
          readPath,
          MAX_SOURCE_BYTES,
        );
        await restoreOriginalFile(
          cwd,
          sourcePath,
          sourceContent,
          mutatedContent,
        );
      } catch {
        // Best-effort restore; if it fails we still report the mutation.
      }
    }
    return {
      kind: "executor_mutated_worktree",
      paths: boundedPathSummary(worktreeAfterExecutor.paths),
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

  const worktreeAfterEdit = await getWorktreeChanges(cwd);
  if (!onlyPathChanged(worktreeAfterEdit, sourcePath)) {
    const extras = extraPaths(worktreeAfterEdit, sourcePath);
    const restore = await restoreOriginalFile(
      cwd,
      sourcePath,
      applyResult.originalContent,
      applyResult.appliedContent,
    );
    if (restore.kind === "stale") {
      return {
        kind: "execution_scope_violation",
        paths: boundedPathSummary(extras),
        rollback: "stale",
      };
    }
    if (restore.kind === "failed") {
      return {
        kind: "execution_scope_violation",
        paths: boundedPathSummary(extras),
        rollback: "incomplete",
      };
    }
    return {
      kind: "execution_scope_violation",
      paths: boundedPathSummary(extras),
      rollback: "complete",
    };
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
        const status = await getWorktreeChanges(cwd);
        if (!onlyPathChanged(status, sourcePath)) {
          const error = new Error(
            "working tree changed outside the target source file",
          ) as NodeJS.ErrnoException;
          error.code = "EXECUTION_SCOPE_VIOLATION";
          (
            error as NodeJS.ErrnoException & { changed_paths?: string[] }
          ).changed_paths = extraPaths(status, sourcePath);
          throw error;
        }
      },
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
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

    const restore = await restoreOriginalFile(
      cwd,
      sourcePath,
      applyResult.originalContent,
      applyResult.appliedContent,
    );

    const worktreeAfterRollback = await getWorktreeChanges(cwd);

    if (code === "EXECUTION_SCOPE_VIOLATION") {
      const extras =
        (error as NodeJS.ErrnoException & { changed_paths?: string[] })
          .changed_paths ??
        (worktreeAfterRollback.clean ? [] : worktreeAfterRollback.paths);
      let rollback: "complete" | "incomplete" | "stale";
      if (restore.kind === "stale") {
        rollback = "stale";
      } else if (restore.kind === "failed") {
        rollback = "incomplete";
      } else if (!worktreeAfterRollback.clean) {
        rollback = "incomplete";
      } else {
        rollback = "complete";
      }
      return {
        kind: "execution_scope_violation",
        paths: boundedPathSummary(extras),
        rollback,
      };
    }

    if (restore.kind === "stale") {
      return {
        kind: "rollback_stale_file",
        reason: restore.reason,
        applied_sha: restore.applied_sha,
      };
    }
    if (restore.kind === "failed") {
      return {
        kind: "rollback_failed",
        reason: restore.reason,
        failure,
      };
    }

    if (code === "AGENT_NOT_FOUND" || code === "AGENT_NOT_ENABLED") {
      throw error;
    }

    if (!worktreeAfterRollback.clean) {
      return {
        kind: "rollback_incomplete",
        paths: boundedPathSummary(worktreeAfterRollback.paths),
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
    const restore = await restoreOriginalFile(
      cwd,
      sourcePath,
      applyResult.originalContent,
      applyResult.appliedContent,
    );
    if (restore.kind === "stale") {
      return {
        kind: "rollback_stale_file",
        reason: restore.reason,
        applied_sha: restore.applied_sha,
      };
    }
    if (restore.kind === "failed") {
      return {
        kind: "rollback_failed",
        reason: restore.reason,
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
