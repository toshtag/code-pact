import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runTaskComplete } from "../../commands/task-complete.ts";
import { atomicReplaceExistingText } from "../../io/atomic-text.ts";
import { ExecutorError, truncateExecutorReason } from "./executor.ts";
import { loadPhase } from "../plan/load-phase.ts";
import { resolveTaskInRoadmap } from "../plan/resolve-task.ts";
import { loadProgressLog } from "../progress/io.ts";
import {
  readOwnedTextBounded,
  resolveExecuteSourceReadPath,
  resolveExecuteSourceWritePath,
} from "../project-fs/index.ts";
import { applyExactReplacement } from "./exact-replacement.ts";
import { resolveOneShotEligibility } from "./eligibility.ts";
import {
  MAX_EXECUTOR_INPUT_BYTES,
  MAX_SOURCE_BYTES,
  type BoundedFailureCapsule,
  type OneShotExecutor,
  type OneShotExecutorInput,
  type TaskExecuteOnceResult,
} from "./types.ts";

export type RunTaskExecuteOnceOptions = {
  cwd: string;
  taskId: string;
  agent?: string;
  executor: OneShotExecutor;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const execFileAsync = promisify(execFile);

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

function onlyPathChanged(status: WorktreeChanges, path: string): boolean {
  if (status.clean) return false;
  return status.paths.every(p => p === path || p.startsWith(`${path}/`));
}

function extraPaths(status: WorktreeChanges, path: string): string[] {
  if (status.clean) return [];
  return status.paths.filter(p => p !== path && !p.startsWith(`${path}/`));
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
    return { kind: "worktree_not_clean", paths: worktreeBefore.paths };
  }

  let sourceContent: string;
  try {
    const readPath = await resolveExecuteSourceReadPath(cwd, sourcePath);
    sourceContent = await readOwnedTextBounded(readPath, MAX_SOURCE_BYTES);
  } catch (error) {
    return {
      kind: "executor_failed",
      reason: `source read failed: ${(error as Error).message}`,
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
      reason: `executor input exceeds ${MAX_EXECUTOR_INPUT_BYTES} bytes`,
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
      reason: truncateExecutorReason(message),
    };
  }

  const worktreeAfterExecutor = await getWorktreeChanges(cwd);
  if (!worktreeAfterExecutor.clean) {
    return {
      kind: "executor_mutated_worktree",
      changed_paths: worktreeAfterExecutor.paths,
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
      return { kind: "rollback_stale_file", reason: restore.reason };
    }
    if (restore.kind === "failed") {
      return { kind: "rollback_failed", reason: restore.reason };
    }
    return {
      kind: "execution_scope_violation",
      changed_paths: extras,
    };
  }

  let completionResult;
  try {
    completionResult = await runTaskComplete({
      cwd,
      taskId,
      agent: opts.agent,
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
    const failure =
      code === "VERIFICATION_FAILED" ? buildFailureCapsule(error) : undefined;

    const restore = await restoreOriginalFile(
      cwd,
      sourcePath,
      applyResult.originalContent,
      applyResult.appliedContent,
    );
    if (restore.kind === "stale") {
      return { kind: "rollback_stale_file", reason: restore.reason };
    }
    if (restore.kind === "failed") {
      return {
        kind: "rollback_failed",
        reason: restore.reason,
        failure,
      };
    }

    const worktreeAfterRollback = await getWorktreeChanges(cwd);
    if (!worktreeAfterRollback.clean) {
      return {
        kind: "rollback_incomplete",
        changed_paths: worktreeAfterRollback.paths,
        failure,
      };
    }

    if (code === "EXECUTION_SCOPE_VIOLATION") {
      const changed_paths =
        (error as NodeJS.ErrnoException & { changed_paths?: string[] })
          .changed_paths ?? [];
      return { kind: "execution_scope_violation", changed_paths };
    }

    if (code === "AGENT_NOT_FOUND" || code === "AGENT_NOT_ENABLED") {
      throw error;
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
      reason:
        typeof code === "string" && code.length > 0
          ? `${code}: ${(error as Error).message}`
          : (error as Error).message,
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
      return { kind: "rollback_stale_file", reason: restore.reason };
    }
    if (restore.kind === "failed") {
      return {
        kind: "rollback_failed",
        reason: restore.reason,
      };
    }
    return {
      kind: "executor_failed",
      reason: `task complete returned unexpected kind: ${completionResult.kind}`,
    };
  }

  return {
    kind: "done",
    task_id: taskId,
    changed_file: sourcePath,
    verification: "passed",
  };
}

function buildFailureCapsule(error: unknown): BoundedFailureCapsule {
  const checks = (error as NodeJS.ErrnoException & { checks?: unknown }).checks;
  const checkArray = Array.isArray(checks) ? checks : [];
  const firstFailure = checkArray.find(
    (c: unknown) =>
      typeof c === "object" &&
      c !== null &&
      (c as { ok?: boolean }).ok === false,
  );
  const failedCheck =
    firstFailure && typeof firstFailure === "object" && firstFailure !== null
      ? (firstFailure as { name?: string; reason?: string })
      : undefined;
  return {
    schema_version: 1,
    kind: failedCheck?.name ? "command_failed" : "unknown",
    check: failedCheck?.name ?? "verification",
    ...(failedCheck?.reason ? { reason: failedCheck.reason } : {}),
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
      reason: `ROLLBACK_FAILED: ${(error as Error).message}`,
    };
  }
}
