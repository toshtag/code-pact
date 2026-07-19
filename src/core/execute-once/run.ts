import { createHash } from "node:crypto";
import { runTaskComplete } from "../../commands/task-complete.ts";
import { atomicReplaceExistingText } from "../../io/atomic-text.ts";
import { projectVerifyForAgent } from "../evidence/failure-capsule.ts";
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
  executor: OneShotExecutor;
  timeoutMs?: number;
  signal?: AbortSignal;
};

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
    const code = (error as NodeJS.ErrnoException).code;
    return {
      kind: "executor_failed",
      reason:
        typeof code === "string" && code.length > 0
          ? `${code}: ${(error as Error).message}`
          : (error as Error).message,
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

  const applyResult = await applyExactReplacement(
    cwd,
    replacement,
    sourcePath,
  );
  if (applyResult.kind === "rejected") {
    return { kind: "edit_rejected", reason: applyResult.reason };
  }

  let completionResult;
  try {
    completionResult = await runTaskComplete({
      cwd,
      taskId,
      timeoutMs: opts.timeoutMs,
      signal,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const failure =
      code === "VERIFICATION_FAILED"
        ? await buildFailureCapsule(cwd, error)
        : undefined;

    const restoreResult = await restoreOriginalFile(
      cwd,
      sourcePath,
      applyResult.originalContent,
    );
    if (restoreResult.kind === "failed") {
      return {
        kind: "rollback_failed",
        reason: restoreResult.reason,
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
      reason:
        typeof code === "string" && code.length > 0
          ? `${code}: ${(error as Error).message}`
          : (error as Error).message,
    };
  }

  if (completionResult.kind !== "done") {
    const restoreResult = await restoreOriginalFile(
      cwd,
      sourcePath,
      applyResult.originalContent,
    );
    if (restoreResult.kind === "failed") {
      return {
        kind: "rollback_failed",
        reason: restoreResult.reason,
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

async function buildFailureCapsule(
  cwd: string,
  error: unknown,
): Promise<BoundedFailureCapsule> {
  const checks = (error as NodeJS.ErrnoException & { checks?: unknown }).checks;
  const projection = await projectVerifyForAgent(cwd, {
    ok: false,
    checks: Array.isArray(checks) ? checks : [],
  });
  return projection.failure;
}

type RestoreResult = { kind: "ok" } | { kind: "failed"; reason: string };

async function restoreOriginalFile(
  cwd: string,
  sourcePath: string,
  originalContent: string,
): Promise<RestoreResult> {
  try {
    const writePath = await resolveExecuteSourceWritePath(cwd, sourcePath);
    await atomicReplaceExistingText(writePath, originalContent);
    return { kind: "ok" };
  } catch (error) {
    return {
      kind: "failed",
      reason: `ROLLBACK_FAILED: ${(error as Error).message}`,
    };
  }
}
