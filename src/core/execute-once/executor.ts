import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
  createOutputCapture,
  terminateProcessTree,
} from "../process/bounded-command.ts";
import {
  DEFAULT_EXECUTOR_TIMEOUT_MS,
  MAX_EXECUTOR_FAILED_REASON_BYTES,
  MAX_EXECUTOR_OUTPUT_BYTES,
  MAX_REASON_BYTES,
  type OneShotExecutor,
  type OneShotExecutorInput,
  type OneShotExecutorOutput,
} from "./types.ts";

export type ExternalOneShotExecutorOptions = {
  executablePath: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
};

export class ExecutorError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(truncateExecutorReason(`${code}: ${message}`));
    this.name = "ExecutorError";
  }
}

export class ExternalProcessOneShotExecutor implements OneShotExecutor {
  constructor(private readonly opts: ExternalOneShotExecutorOptions) {}

  async invoke(input: OneShotExecutorInput): Promise<OneShotExecutorOutput> {
    const maxOutputBytes =
      this.opts.maxOutputBytes ?? MAX_EXECUTOR_OUTPUT_BYTES;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS;
    const inputJson = JSON.stringify(input);

    const proc = spawn(this.opts.executablePath, [], {
      cwd: this.opts.cwd ?? tmpdir(),
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
        `executor stdin error: ${stdinError.message}`,
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
      const errorOutput = truncateExecutorReason(stderr.value());
      const reason = truncateExecutorReason(
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

    return validateOneShotExecutorOutput(parsed);
  }
}

function validateOneShotExecutorOutput(value: unknown): OneShotExecutorOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExecutorError(
      "executor output is not a JSON object",
      "EXECUTOR_SCHEMA_MISMATCH",
    );
  }

  const output = value as Record<string, unknown>;
  if (output.kind !== "replace_exact" && output.kind !== "blocked") {
    throw new ExecutorError(
      `executor output kind "${String(output.kind)}" is not allowed`,
      "EXECUTOR_SCHEMA_MISMATCH",
    );
  }

  if (output.kind === "blocked") {
    const reason = output.reason;
    if (typeof reason !== "string" || reason.length === 0) {
      throw new ExecutorError(
        "blocked output requires a non-empty string reason",
        "EXECUTOR_SCHEMA_MISMATCH",
      );
    }
    if (Buffer.byteLength(reason, "utf8") > MAX_REASON_BYTES) {
      throw new ExecutorError(
        "blocked reason exceeds 512 bytes",
        "EXECUTOR_SCHEMA_MISMATCH",
      );
    }
    return { kind: "blocked", reason };
  }

  const expected_file_sha256 = output.expected_file_sha256;
  const old_text = output.old_text;
  const new_text = output.new_text;
  if (
    typeof expected_file_sha256 !== "string" ||
    typeof old_text !== "string" ||
    typeof new_text !== "string"
  ) {
    throw new ExecutorError(
      "replace_exact output requires expected_file_sha256, old_text, and new_text strings",
      "EXECUTOR_SCHEMA_MISMATCH",
    );
  }

  if (expected_file_sha256.length === 0 || old_text.length === 0) {
    throw new ExecutorError(
      "replace_exact fields must be non-empty strings",
      "EXECUTOR_SCHEMA_MISMATCH",
    );
  }

  return {
    kind: "replace_exact",
    expected_file_sha256,
    old_text,
    new_text,
  };
}

export function truncateExecutorReason(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_EXECUTOR_FAILED_REASON_BYTES) {
    return text;
  }
  const prefix = "[truncated] ";
  const max =
    MAX_EXECUTOR_FAILED_REASON_BYTES - Buffer.byteLength(prefix, "utf8");
  let cut = Math.max(0, max);
  // Walk back to avoid splitting a multi-byte UTF-8 sequence.
  const buffer = Buffer.from(text, "utf8");
  while (cut > 0 && (buffer[cut]! & 0b1100_0000) === 0b1000_0000) {
    cut -= 1;
  }
  return prefix + buffer.subarray(0, cut).toString("utf8");
}
