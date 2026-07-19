import { resolve } from "node:path";
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

  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const parsed = parseTimeoutArg(String(values.timeout), json);
    if (!parsed.ok) return parsed.exitCode;
    timeoutMs = parsed.value;
  }

  const cwd = process.cwd();
  const executablePath = resolve(cwd, executorFile);
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
          executor: new ExternalProcessOneShotExecutor({
            executablePath,
            cwd,
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
    default:
      throw new Error(`Unknown execute result kind: ${JSON.stringify(result)}`);
  }
}
