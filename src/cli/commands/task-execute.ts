import { resolve } from "node:path";
import { RelativePosixPath } from "../../core/schemas/relative-path.ts";
import { strictParse } from "../../lib/argv.ts";
import { toParseOptions } from "../spec/render.ts";
import { TASK_SPECS } from "../spec/task.ts";
import { messages, type Locale } from "../../i18n/index.ts";
import {
  withWriteLock,
  emitOk,
  emitError,
  createCliAbortSignal,
  parseTimeoutArg,
} from "../util.ts";
import { ConfigError } from "../../lib/argv.ts";
import { runTaskExecuteOnce } from "../../core/execute-once/run.ts";
import { ExternalProcessOneShotExecutor } from "../../core/execute-once/executor.ts";
import {
  truncateExecuteReason,
  type TaskExecuteOnceResult,
} from "../../core/execute-once/types.ts";
import {
  lstatExplicitUser,
  resolveExplicitUserReadPath,
} from "../../core/project-fs/index.ts";

export async function cmdTaskExecute(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "task execute",
      argv,
      toParseOptions(TASK_SPECS.execute!),
      { allowPositionals: true },
    ));
  } catch (err) {
    return emitParseConfigError(err, argv, globalJson);
  }

  function emitParseConfigError(
    err: unknown,
    rawArgs: string[],
    useGlobalJson: boolean,
  ): number {
    if (!(err instanceof ConfigError)) throw err;
    emitError(
      useGlobalJson || rawArgs.includes("--json"),
      "CONFIG_ERROR",
      err.message,
    );
    return 2;
  }

  const json = globalJson || values.json === true;
  const taskId = positionals[0];
  if (!taskId) {
    emitError(json, "CONFIG_ERROR", m.task.execute.missingTaskId);
    return 2;
  }

  const executorFile = values["executor-file"];
  if (typeof executorFile !== "string" || executorFile.length === 0) {
    emitError(json, "CONFIG_ERROR", m.task.execute.missingExecutorFile);
    return 2;
  }

  const agent = values.agent !== undefined ? String(values.agent) : undefined;

  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const parsed = parseTimeoutArg(String(values.timeout), json);
    if (!parsed.ok) return parsed.exitCode;
    timeoutMs = parsed.value;
  }

  const cwd = process.cwd();
  const validated = await validateExecutorFile(cwd, executorFile);
  if (!validated.ok) {
    emitError(
      json,
      "CONFIG_ERROR",
      truncateExecuteReason(validated.reason, 1024),
    );
    return 2;
  }
  const { executablePath } = validated;

  const { signal, cleanup } = createCliAbortSignal();

  try {
    return await withWriteLock(
      cwd,
      `task execute ${taskId}`,
      json,
      async (): Promise<number> => {
        const result = await runTaskExecuteOnce({
          cwd,
          taskId,
          agent,
          executor: new ExternalProcessOneShotExecutor({
            executablePath,
            timeoutMs,
            signal,
          }),
        });
        return emitExecuteResult(result, json, taskId, m);
      },
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = err instanceof Error ? err.message : String(err);
    switch (code) {
      case "TASK_NOT_FOUND":
        emitError(json, "TASK_NOT_FOUND", message);
        return 2;
      case "AMBIGUOUS_TASK_ID": {
        const phases =
          (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [];
        emitError(json, "AMBIGUOUS_TASK_ID", message, { data: { phases } });
        return 2;
      }
      case "AGENT_NOT_FOUND":
      case "AGENT_NOT_ENABLED":
      case "CONFIG_ERROR":
        emitError(json, code, message);
        return 2;
      case "LOCK_HELD":
        return 2;
      default:
        throw err;
    }
  } finally {
    cleanup();
  }
}

type LocaleMessages = (typeof messages)[Locale];

function emitExecuteResult(
  result: TaskExecuteOnceResult,
  json: boolean,
  taskId: string,
  m: LocaleMessages,
): number {
  switch (result.kind) {
    case "done":
      if (json) {
        emitOk({
          kind: "done",
          task_id: result.task_id,
          changed_file: result.changed_file,
          verification: result.verification,
        });
      } else {
        process.stderr.write(
          `${m.task.execute.done(result.task_id, result.changed_file)}\n`,
        );
      }
      return 0;
    case "ineligible":
      if (json) {
        emitError(
          json,
          "EXECUTION_INELIGIBLE",
          "Task is not eligible for one-shot execution",
          { data: { reasons: result.reasons } },
        );
      } else {
        process.stderr.write(
          `${m.task.execute.ineligible(taskId, result.reasons)}\n`,
        );
      }
      return 1;
    case "worktree_not_clean":
      if (json) {
        emitError(
          json,
          "WORKTREE_NOT_CLEAN",
          "working tree is not clean before one-shot execution",
          { data: { paths: result.paths } },
        );
      } else {
        process.stderr.write(
          `${m.task.execute.worktreeNotClean(result.paths)}\n`,
        );
      }
      return 1;
    case "blocked":
      if (json) {
        emitError(json, "EXECUTION_BLOCKED", result.reason, {
          data: { reason: result.reason },
        });
      } else {
        process.stderr.write(
          `${m.task.execute.blocked(taskId, result.reason)}\n`,
        );
      }
      return 1;
    case "executor_failed":
      if (json) {
        emitError(json, "EXECUTOR_FAILED", result.reason, {
          data: { reason: result.reason },
        });
      } else {
        process.stderr.write(
          `${m.task.execute.executorFailed(taskId, result.reason)}\n`,
        );
      }
      return 1;
    case "edit_rejected":
      if (json) {
        emitError(json, "EDIT_REJECTED", result.reason, {
          data: { reason: result.reason },
        });
      } else {
        process.stderr.write(
          `${m.task.execute.editRejected(taskId, result.reason)}\n`,
        );
      }
      return 1;
    case "verification_failed":
      if (json) {
        emitError(
          json,
          "VERIFICATION_FAILED",
          "Verification failed; file rolled back",
          {
            data: {
              rolled_back: result.rolled_back,
              failure: result.failure,
            },
          },
        );
      } else {
        process.stderr.write(`${m.task.execute.verificationFailed(taskId)}\n`);
      }
      return 1;
    case "rollback_failed":
      if (json) {
        emitError(json, "ROLLBACK_FAILED", result.reason, {
          ...(result.failure !== undefined
            ? { data: { failure: result.failure } }
            : {}),
        });
      } else {
        process.stderr.write(
          `${m.task.execute.rollbackFailed(taskId, result.reason)}\n`,
        );
      }
      return 1;
    case "rollback_stale_file":
      if (json) {
        emitError(json, "ROLLBACK_STALE_FILE", result.reason, {
          ...(result.applied_sha !== undefined
            ? { data: { applied_sha: result.applied_sha } }
            : {}),
        });
      } else {
        process.stderr.write(
          `${m.task.execute.rollbackStaleFile(taskId, result.reason)}\n`,
        );
      }
      return 1;
    case "rollback_incomplete":
      if (json) {
        emitError(
          json,
          "ROLLBACK_INCOMPLETE",
          "rollback completed but extra changes remain",
          {
            data: {
              paths: result.paths,
              ...(result.failure !== undefined
                ? { failure: result.failure }
                : {}),
            },
          },
        );
      } else {
        process.stderr.write(
          `${m.task.execute.rollbackIncomplete(result.paths)}\n`,
        );
      }
      return 1;
    case "executor_mutated_worktree":
      if (json) {
        emitError(
          json,
          "EXECUTOR_MUTATED_WORKTREE",
          "executor modified repository state before returning",
          {
            data: {
              paths: result.paths,
              rollback: result.rollback,
              rollback_reason: result.rollback_reason,
              head_changed: result.head_changed,
              index_changed: result.index_changed,
            },
          },
        );
      } else {
        process.stderr.write(
          `${m.task.execute.executorMutatedWorktree(result.paths, result.rollback, result.head_changed, result.index_changed)}\n`,
        );
      }
      return 1;
    case "git_state_unavailable":
      if (json) {
        emitError(json, "GIT_STATE_UNAVAILABLE", result.reason, {
          data: { source_rollback: result.source_rollback },
        });
      } else {
        process.stderr.write(
          `${m.task.execute.gitStateUnavailable(result.reason, result.source_rollback)}\n`,
        );
      }
      return 1;
    case "execution_scope_violation":
      if (json) {
        emitError(
          json,
          "EXECUTION_SCOPE_VIOLATION",
          "verification scope changed outside the source file",
          {
            data: {
              paths: result.paths,
              rollback: result.rollback,
              head_changed: result.head_changed,
              index_changed: result.index_changed,
            },
          },
        );
      } else {
        process.stderr.write(
          `${m.task.execute.executionScopeViolation(result.paths, result.rollback, result.head_changed, result.index_changed)}\n`,
        );
      }
      return 1;
    default:
      throw new Error(m.task.execute.unknownResult(JSON.stringify(result)));
  }
}

type ExecutorPathValidation =
  | { ok: true; relPath: string; executablePath: string }
  | { ok: false; reason: string };

async function validateExecutorFile(
  cwd: string,
  executorFile: string,
): Promise<ExecutorPathValidation> {
  const parsed = RelativePosixPath.safeParse(executorFile);
  if (!parsed.success) {
    return {
      ok: false,
      reason:
        "executor file must be a project-relative POSIX path (no leading /, no .., no . segments, no \\, no empty segments)",
    };
  }
  const relPath = parsed.data;

  let explicitPath;
  try {
    explicitPath = await resolveExplicitUserReadPath(cwd, relPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "PATH_NOT_OWNED") {
      return { ok: false, reason: "executor file is a symlink" };
    }
    if (code === "PATH_OUTSIDE_PROJECT") {
      return { ok: false, reason: "executor file must be inside the project" };
    }
    return {
      ok: false,
      reason: truncateExecuteReason(
        `executor file must be a safe path inside the project: ${(error as Error).message}`,
        1024,
      ),
    };
  }

  try {
    const stats = await lstatExplicitUser(explicitPath);
    if (!stats.isFile()) {
      return { ok: false, reason: "executor file is not a regular file" };
    }
    if (process.platform !== "win32" && (stats.mode & 0o111) === 0) {
      return { ok: false, reason: "executor file is not executable" };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "executor file does not exist" };
    }
    return {
      ok: false,
      reason: truncateExecuteReason(
        `executor file validation failed: ${(error as Error).message}`,
        1024,
      ),
    };
  }

  return { ok: true, relPath, executablePath: resolve(cwd, relPath) };
}
