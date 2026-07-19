import { relative, resolve } from "node:path";
import { strictParse } from "../../lib/argv.ts";
import { toParseOptions } from "../spec/render.ts";
import { TASK_SPECS } from "../spec/task.ts";
import type { Locale } from "../../i18n/index.ts";
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
import type { TaskExecuteOnceResult } from "../../core/execute-once/types.ts";
import {
  lstatExplicitUser,
  resolveExplicitUserReadPath,
} from "../../core/project-fs/index.ts";

export async function cmdTaskExecute(
  argv: string[],
  _locale: Locale,
  globalJson: boolean,
): Promise<number> {
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
    emitError(json, "CONFIG_ERROR", "task execute requires a task id.");
    return 2;
  }

  const executorFile = values["executor-file"];
  if (typeof executorFile !== "string" || executorFile.length === 0) {
    emitError(
      json,
      "CONFIG_ERROR",
      "task execute requires --executor-file <path>.",
    );
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
  const executablePath = resolve(cwd, executorFile);
  const validationError = await validateExecutorFile(cwd, executablePath);
  if (validationError !== undefined) {
    emitError(json, "CONFIG_ERROR", validationError);
    return 2;
  }

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
        return emitExecuteResult(result, json, taskId);
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

function emitExecuteResult(
  result: TaskExecuteOnceResult,
  json: boolean,
  taskId: string,
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
          `Task ${result.task_id} done: ${result.changed_file}\n`,
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
        process.stderr.write(`Task ${taskId} is not eligible:\n`);
        for (const reason of result.reasons) {
          process.stderr.write(`  - ${reason}\n`);
        }
      }
      return 1;
    case "blocked":
      if (json) {
        emitError(json, "EXECUTION_BLOCKED", result.reason, {
          data: { reason: result.reason },
        });
      } else {
        process.stderr.write(`Task ${taskId} blocked: ${result.reason}\n`);
      }
      return 1;
    case "executor_failed":
      if (json) {
        emitError(json, "EXECUTOR_FAILED", result.reason);
      } else {
        process.stderr.write(`Executor failed: ${result.reason}\n`);
      }
      return 1;
    case "edit_rejected":
      if (json) {
        emitError(json, "EDIT_REJECTED", result.reason);
      } else {
        process.stderr.write(`Edit rejected: ${result.reason}\n`);
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
        process.stderr.write(
          `Verification failed (rolled_back=${result.rolled_back})\n`,
        );
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
        process.stderr.write(`Rollback failed: ${result.reason}\n`);
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
        process.stderr.write(`Rollback stale: ${result.reason}\n`);
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
              changed_paths: result.changed_paths,
              ...(result.failure !== undefined
                ? { failure: result.failure }
                : {}),
            },
          },
        );
      } else {
        process.stderr.write(
          `Rollback incomplete: ${result.changed_paths.join(", ")}\n`,
        );
      }
      return 1;
    case "worktree_not_clean":
      if (json) {
        emitError(
          json,
          "WORKTREE_NOT_CLEAN",
          "working tree is not clean before one-shot execution",
          {
            data: { paths: result.paths },
          },
        );
      } else {
        process.stderr.write(`Working tree is not clean before execution.\n`);
      }
      return 1;
    case "executor_mutated_worktree":
      if (json) {
        emitError(
          json,
          "EXECUTOR_MUTATED_WORKTREE",
          "executor modified files outside the source file",
          {
            data: { changed_paths: result.changed_paths },
          },
        );
      } else {
        process.stderr.write(
          `Executor mutated working tree: ${result.changed_paths.join(", ")}\n`,
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
            data: { changed_paths: result.changed_paths },
          },
        );
      } else {
        process.stderr.write(
          `Execution scope violation: ${result.changed_paths.join(", ")}\n`,
        );
      }
      return 1;
    default:
      throw new Error(`Unknown execute result kind: ${JSON.stringify(result)}`);
  }
}

async function validateExecutorFile(
  cwd: string,
  executablePath: string,
): Promise<string | undefined> {
  // Resolve user input to a project-relative path so symlink detection runs on
  // the exact supplied path instead of its real target.
  const relPath = relative(cwd, executablePath);
  if (relPath === "" || relPath.startsWith(".")) {
    return "executor file must be inside the project";
  }

  let explicitPath;
  try {
    explicitPath = await resolveExplicitUserReadPath(cwd, relPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "PATH_NOT_OWNED") return "executor file is a symlink";
    if (code === "PATH_OUTSIDE_PROJECT") {
      return "executor file must be inside the project";
    }
    return `executor file must be a safe path inside the project: ${(error as Error).message}`;
  }

  try {
    const stats = await lstatExplicitUser(explicitPath);
    if (!stats.isFile()) {
      return "executor file is not a regular file";
    }
    if (process.platform !== "win32" && (stats.mode & 0o111) === 0) {
      return "executor file is not executable";
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "executor file does not exist";
    return `executor file validation failed: ${(error as Error).message}`;
  }
  return undefined;
}
