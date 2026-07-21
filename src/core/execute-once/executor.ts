import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
  createOutputCapture,
  terminateProcessTree,
} from "../process/bounded-command.ts";
import {
  DEFAULT_EXECUTOR_TIMEOUT_MS,
  MAX_EXECUTOR_OUTPUT_BYTES,
  truncateExecuteReason,
  type OneShotExecutor,
  type OneShotExecutorInput,
} from "./types.ts";

export type ExternalOneShotExecutorOptions = {
  executablePath: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
};

const REPOSITORY_PATH_ENV_KEYS = [
  "PWD",
  "OLDPWD",
  "INIT_CWD",
  "npm_config_local_prefix",
  "npm_package_json",
  "npm_package_name",
];

function sanitizedProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of REPOSITORY_PATH_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

export class ExecutorError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(truncateExecuteReason(`${code}: ${message}`));
    this.name = "ExecutorError";
  }
}

export class ExternalProcessOneShotExecutor implements OneShotExecutor {
  constructor(private readonly opts: ExternalOneShotExecutorOptions) {}

  async invoke(input: OneShotExecutorInput): Promise<unknown> {
    const maxOutputBytes =
      this.opts.maxOutputBytes ?? MAX_EXECUTOR_OUTPUT_BYTES;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS;
    const inputJson = JSON.stringify(input);

    const proc = spawn(this.opts.executablePath, [], {
      cwd: tmpdir(),
      env: sanitizedProcessEnv(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdinError: Error | undefined;
    proc.stdin?.once("error", (error: Error) => {
      stdinError = error;
    });
    proc.stdin?.write(inputJson, "utf8", err => {
      if (err && !stdinError) stdinError = err;
      proc.stdin?.end();
    });

    let closeSettled = false;
    let resolveClose!: (result: { exitCode: number | null }) => void;
    const closePromise = new Promise<{ exitCode: number | null }>(resolve => {
      resolveClose = resolve;
    });
    proc.once("close", code => {
      if (closeSettled) return;
      closeSettled = true;
      resolveClose({ exitCode: code });
    });
    proc.once("error", (error: Error) => {
      if (closeSettled) return;
      closeSettled = true;
      if (!stdinError) stdinError = error;
      resolveClose({ exitCode: null });
    });

    const stdout = createOutputCapture(maxOutputBytes);
    const stderr = createOutputCapture(maxOutputBytes);
    proc.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

    let timedOut = false;
    let aborted = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(proc);
    }, timeoutMs);

    let abortHandler: (() => void) | undefined;
    if (this.opts.signal) {
      abortHandler = () => {
        aborted = true;
        void terminateProcessTree(proc);
      };
      this.opts.signal.addEventListener("abort", abortHandler, { once: true });
      if (this.opts.signal.aborted) {
        abortHandler();
      }
    }

    try {
      const closeDeadline = new Promise<void>(resolve => {
        const deadline = setTimeout(() => resolve(), timeoutMs + 5_000);
        void closePromise.finally(() => clearTimeout(deadline));
      });
      await Promise.race([closePromise, closeDeadline]);
    } finally {
      clearTimeout(timeoutHandle);
      if (this.opts.signal && abortHandler) {
        this.opts.signal.removeEventListener("abort", abortHandler);
      }
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.stdin?.destroy();
      proc.removeAllListeners();
      proc.unref();
    }

    if (stdinError) {
      throw new ExecutorError(
        truncateExecuteReason(`executor stdin error: ${stdinError.message}`),
        "EXECUTOR_START_FAILED",
      );
    }

    if (aborted) {
      throw new ExecutorError("executor aborted", "EXECUTOR_ABORTED");
    }

    if (timedOut) {
      throw new ExecutorError(
        `executor timed out after ${timeoutMs} ms`,
        "EXECUTOR_TIMEOUT",
      );
    }

    const output = stdout.value();

    if (stdout.truncated()) {
      throw new ExecutorError(
        `executor stdout exceeded ${maxOutputBytes} bytes`,
        "EXECUTOR_OUTPUT_TOO_LARGE",
      );
    }

    const exitCode = closeSettled ? (await closePromise).exitCode : null;
    if (exitCode !== 0) {
      const errorOutput = truncateExecuteReason(stderr.value());
      const reason = truncateExecuteReason(
        `executor exited with code ${exitCode}${errorOutput ? `: ${errorOutput}` : ""}`,
      );
      throw new ExecutorError(reason, "EXECUTOR_NON_ZERO_EXIT");
    }

    if (output.trim().length === 0) {
      throw new ExecutorError(
        "executor produced no output",
        "EXECUTOR_INVALID_JSON",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(output.trim());
    } catch (error) {
      throw new ExecutorError(
        `executor output is not valid JSON: ${(error as Error).message}`,
        "EXECUTOR_INVALID_JSON",
      );
    }

    return parsed;
  }
}

export { truncateExecuteReason as truncateExecutorReason } from "./types.ts";
