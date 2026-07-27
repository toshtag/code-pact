import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export type ProcessTerminationResult = {
  attempted: boolean;
  completed: boolean;
  strategy: "process-group" | "taskkill" | "direct-kill";
  elapsedMs: number;
  /** Whether Node observed the spawned shell's close event before the deadline. */
  closeObserved?: boolean;
  error?: string;
};

export type CommandExecutionResult = {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  termination?: ProcessTerminationResult;
};

export type BoundedCommandResult = Omit<CommandExecutionResult, "command" | "ok">;

export const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const TERMINATION_WAIT_MS = 2_000;
const TASKKILL_TIMEOUT_MS = 5_000;
const CLOSE_DEADLINE_MS = 3_000;

type CloseResult = { exitCode: number | null };
type TerminationCause = "timeout" | "abort";
type TaskkillResult = { code: number | null; error?: string };
type KillProcess = (pid: number, signal?: NodeJS.Signals | number) => boolean;

export type ProcessTerminationDependencies = {
  platform?: NodeJS.Platform;
  killProcess?: KillProcess;
  waitForTargetExit?: (target: number, timeoutMs: number) => Promise<boolean>;
  runTaskkill?: (pid: number) => Promise<TaskkillResult>;
};

function truncatedOutputMessage(maxBytes: number): string {
  return `\n[code-pact: output truncated after ${maxBytes} bytes]\n`;
}

export function createOutputCapture(maxBytes = MAX_COMMAND_OUTPUT_BYTES): {
  append: (chunk: Buffer) => void;
  value: () => string;
  truncated: () => boolean;
} {
  let text = "";
  let bytes = 0;
  let truncated = false;
  let finalized = false;
  let decoder = new StringDecoder("utf8");

  return {
    append(chunk: Buffer): void {
      if (truncated) return;
      const remaining = maxBytes - bytes;
      if (chunk.byteLength <= remaining) {
        text += decoder.write(chunk);
        bytes += chunk.byteLength;
        return;
      }
      if (remaining > 0) text += decoder.write(chunk.subarray(0, remaining));
      // If the byte cap cuts through a multibyte sequence, StringDecoder keeps
      // the incomplete bytes buffered. Do not flush them as U+FFFD; the raw
      // byte cap has intentionally truncated that character.
      decoder = new StringDecoder("utf8");
      text += truncatedOutputMessage(maxBytes);
      bytes = maxBytes;
      truncated = true;
    },
    value: () => {
      if (!finalized && !truncated) {
        text += decoder.end();
        finalized = true;
      }
      return text;
    },
    truncated: () => truncated,
  };
}

function elapsedSince(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}

function processTargetExists(target: number, killProcess: KillProcess): boolean {
  try {
    killProcess(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function waitForTargetExit(
  target: number,
  timeoutMs: number,
  killProcess: KillProcess,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!processTargetExists(target, killProcess)) return true;
    await delay(40);
  }
  return !processTargetExists(target, killProcess);
}

async function runTaskkill(pid: number): Promise<TaskkillResult> {
  const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    shell: false,
  });

  return await new Promise(resolve => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let forceCloseHandle: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { code: number | null; error?: string }): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceCloseHandle) clearTimeout(forceCloseHandle);
      taskkill.removeAllListeners();
      resolve(result);
    };
    const finishTimedOut = (): void => {
      // A pathological helper must not keep the caller's event loop alive.
      taskkill.unref();
      finish({ code: null, error: "taskkill timed out" });
    };

    timeoutHandle = setTimeout(() => {
      try {
        taskkill.kill("SIGKILL");
      } catch {
        // The helper already exited.
      }
      // Give Windows a bounded opportunity to report `close` after the kill;
      // if it never does, detach the helper and return an explicit failure.
      forceCloseHandle = setTimeout(finishTimedOut, 500);
    }, TASKKILL_TIMEOUT_MS);
    taskkill.once("close", code => finish({ code }));
    taskkill.once("error", error => finish({ code: null, error: error.message }));
  });
}

export async function terminateProcessTree(
  proc: Pick<ChildProcess, "pid" | "kill">,
  deps: ProcessTerminationDependencies = {},
): Promise<ProcessTerminationResult> {
  const started = performance.now();
  const pid = proc.pid;
  const platform = deps.platform ?? process.platform;
  const killProcess = deps.killProcess ?? (process.kill.bind(process) as KillProcess);
  const waitExit =
    deps.waitForTargetExit ??
    ((target: number, timeoutMs: number) => waitForTargetExit(target, timeoutMs, killProcess));
  const taskkill = deps.runTaskkill ?? runTaskkill;
  if (pid === undefined) {
    return {
      attempted: false,
      completed: false,
      strategy: "direct-kill",
      elapsedMs: elapsedSince(started),
      error: "process has no PID",
    };
  }

  if (platform !== "win32") {
    try {
      killProcess(-pid, "SIGKILL");
      const completed = await waitExit(-pid, TERMINATION_WAIT_MS);
      return {
        attempted: true,
        completed,
        strategy: "process-group",
        elapsedMs: elapsedSince(started),
        ...(completed ? {} : { error: "process group did not exit" }),
      };
    } catch (groupError) {
      let error = `process-group kill failed: ${(groupError as Error).message}`;
      try {
        proc.kill("SIGKILL");
      } catch (directError) {
        error += `; direct kill failed: ${(directError as Error).message}`;
      }
      await waitExit(pid, TERMINATION_WAIT_MS);
      // A direct root-process kill cannot prove that descendants are gone.
      return {
        attempted: true,
        completed: false,
        strategy: "direct-kill",
        elapsedMs: elapsedSince(started),
        error: `${error}; descendant cleanup could not be confirmed`,
      };
    }
  }

  const taskkillResult = await taskkill(pid);
  if (taskkillResult.code === 0) {
    const completed = await waitExit(pid, TERMINATION_WAIT_MS);
    return {
      attempted: true,
      completed,
      strategy: "taskkill",
      elapsedMs: elapsedSince(started),
      ...(completed ? {} : { error: "taskkill completed but the root process remained" }),
    };
  }

  let error = taskkillResult.error ?? `taskkill exited with code ${String(taskkillResult.code)}`;
  if (taskkillResult.error && taskkillResult.code !== null) {
    error += `; taskkill exited with code ${String(taskkillResult.code)}`;
  }
  try {
    proc.kill("SIGKILL");
  } catch (directError) {
    error += `; direct kill failed: ${(directError as Error).message}`;
  }
  await waitExit(pid, TERMINATION_WAIT_MS);
  // taskkill is the only built-in primitive here that can confirm a Windows
  // descendant-tree kill. Direct fallback bounds the root process but cannot
  // honestly claim that every descendant was removed.
  return {
    attempted: true,
    completed: false,
    strategy: "direct-kill",
    elapsedMs: elapsedSince(started),
    error: `${error}; descendant cleanup could not be confirmed`,
  };
}

function cleanupChildHandles(proc: ChildProcess): void {
  proc.stdout?.destroy();
  proc.stderr?.destroy();
  proc.stdin?.destroy();
  proc.removeAllListeners();
  proc.unref();
}

function refusedBeforeStart(stderr: string): BoundedCommandResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    elapsedMs: 0,
  };
}

function abortedBeforeStart(): BoundedCommandResult {
  return {
    exitCode: null,
    stdout: "",
    stderr: "aborted before start",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: true,
    elapsedMs: 0,
  };
}

/**
 * Run a trusted project shell command with bounded output, timeout, external
 * cancellation, and descendant-tree termination diagnostics.
 *
 * The command string is handed to a shell, so every argument in it is subject
 * to expansion. Callers that already hold the argv — the verification
 * classifier does — must use {@link runBoundedArgv} instead: there is no
 * portable way to render an argv into a shell line without changing its
 * meaning.
 */
export async function runBoundedCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BoundedCommandResult> {
  const shellCommand = command.trim();
  if (!shellCommand) return refusedBeforeStart("empty verification command");
  return superviseBoundedProcess(
    () =>
      spawn(shellCommand, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
        detached: process.platform !== "win32",
      }),
    timeoutMs,
    signal,
  );
}

/**
 * Run a command from its canonical argv with the same bounded-output, timeout,
 * cancellation, and process-tree guarantees as {@link runBoundedCommand}, but
 * WITHOUT a shell.
 *
 * `spawn(program, args, { shell: false })` passes each element through as one
 * argument, so a changed-file path or an argument containing `$(...)`, `;`,
 * `*`, a quote, or whitespace reaches the child exactly as written. Rendering
 * the same argv into a shell line and running that is not equivalent: JSON
 * quoting is not shell quoting, and a double-quoted `$(...)` is still expanded.
 */
export async function runBoundedArgv(
  program: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BoundedCommandResult> {
  if (!program) return refusedBeforeStart("empty verification command program");
  return superviseBoundedProcess(
    () =>
      spawn(program, [...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
      }),
    timeoutMs,
    signal,
  );
}

/**
 * Owns everything a bounded run needs once a child exists: output caps, the
 * timeout and abort races, process-tree termination, and the close deadline.
 * The caller supplies only how the child is spawned, so the shell and argv
 * entry points cannot drift apart in any of those guarantees.
 */
async function superviseBoundedProcess(
  spawnChild: () => ChildProcess,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BoundedCommandResult> {
  if (signal?.aborted) return abortedBeforeStart();

  const started = performance.now();
  const stdout = createOutputCapture();
  const stderr = createOutputCapture();
  const proc = spawnChild();

  proc.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
  proc.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

  let closeSettled = false;
  let resolveClose!: (result: CloseResult) => void;
  const closePromise = new Promise<CloseResult>(resolve => {
    resolveClose = resolve;
  });
  const settleClose = (result: CloseResult): void => {
    if (closeSettled) return;
    closeSettled = true;
    resolveClose(result);
  };
  proc.once("close", code => settleClose({ exitCode: code }));
  proc.once("error", error => {
    stderr.append(Buffer.from(error.message));
    settleClose({ exitCode: null });
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ kind: "terminate"; cause: "timeout" }>(resolve => {
    timeoutHandle = setTimeout(
      () => resolve({ kind: "terminate", cause: "timeout" }),
      timeoutMs,
    );
  });

  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<{ kind: "terminate"; cause: "abort" }>(resolve => {
    if (!signal) return;
    let delivered = false;
    abortHandler = () => {
      if (delivered) return;
      delivered = true;
      resolve({ kind: "terminate", cause: "abort" });
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    // AbortSignal does not replay events. Re-check after registration to close
    // the state-check/listener-registration race.
    if (signal.aborted) abortHandler();
  });

  const closeOutcome = closePromise.then(result => ({ kind: "close" as const, result }));
  const outcome = await Promise.race([closeOutcome, timeoutPromise, abortPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);

  if (outcome.kind === "close") {
    return {
      exitCode: outcome.result.exitCode,
      stdout: stdout.value(),
      stderr: stderr.value(),
      stdoutTruncated: stdout.truncated(),
      stderrTruncated: stderr.truncated(),
      timedOut: false,
      aborted: false,
      elapsedMs: elapsedSince(started),
    };
  }

  const cause: TerminationCause = outcome.cause;
  const termination = await terminateProcessTree(proc);
  if (!termination.completed) {
    stderr.append(
      Buffer.from(
        `\n[code-pact: process-tree termination incomplete: ${termination.error ?? "unknown error"}]\n`,
      ),
    );
  }

  let closeDeadline: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    closePromise.then(result => ({ closed: true as const, result })),
    new Promise<{ closed: false }>(resolve => {
      // Deliberately kept referenced: it is the final guarantee that this
      // function settles even when a platform never delivers `close`.
      closeDeadline = setTimeout(() => resolve({ closed: false }), CLOSE_DEADLINE_MS);
    }),
  ]);
  if (closeDeadline) clearTimeout(closeDeadline);
  termination.closeObserved = closed.closed;

  let exitCode: number | null = null;
  if (closed.closed) {
    exitCode = closed.result.exitCode;
  } else {
    stderr.append(Buffer.from("\n[code-pact: process close deadline exceeded]\n"));
    cleanupChildHandles(proc);
  }

  return {
    exitCode,
    stdout: stdout.value(),
    stderr: stderr.value(),
    stdoutTruncated: stdout.truncated(),
    stderrTruncated: stderr.truncated(),
    timedOut: cause === "timeout",
    aborted: cause === "abort",
    elapsedMs: elapsedSince(started),
    termination,
  };
}

export type BoundedCommandDigestResult = {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  elapsedMs: number;
  /** SHA-256 over the complete stdout byte stream, which is never retained. */
  stdoutSha256: string;
  stdoutBytes: number;
  stderr: string;
  stderrTruncated: boolean;
  termination?: ProcessTerminationResult;
};

export type BoundedCommandDigestOptions = {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Receives stdout chunks as they arrive. Use it to parse the stream without
   * buffering it; throwing from the sink fails the run.
   */
  onStdoutChunk?: (chunk: Buffer) => void;
};

function digestFailureResult(
  overrides: Partial<BoundedCommandDigestResult> & { stderr: string },
): BoundedCommandDigestResult {
  return {
    exitCode: null,
    timedOut: false,
    aborted: false,
    elapsedMs: 0,
    stdoutSha256: createHash("sha256").digest("hex"),
    stdoutBytes: 0,
    stderrTruncated: false,
    ...overrides,
  };
}

/**
 * Run a trusted command without a shell and digest its stdout as it streams.
 *
 * `runBoundedCommand` caps captured stdout at `MAX_COMMAND_OUTPUT_BYTES`, which
 * makes it unsafe for callers that must observe output *losslessly* — a
 * truncated capture silently maps distinct outputs onto one value. This variant
 * keeps the same timeout, cancellation, and process-tree termination guarantees
 * while hashing stdout incrementally, so the digest covers every byte and no
 * arbitrarily large output is retained in memory.
 */
export async function runBoundedCommandDigest(
  options: BoundedCommandDigestOptions,
): Promise<BoundedCommandDigestResult> {
  const { executable, args, cwd, timeoutMs, signal, onStdoutChunk } = options;
  if (signal?.aborted) {
    return digestFailureResult({ stderr: "aborted before start", aborted: true });
  }

  const started = performance.now();
  const stdoutHash = createHash("sha256");
  let stdoutBytes = 0;
  let sinkError: Error | undefined;
  const stderr = createOutputCapture();
  const proc = spawn(executable, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
  });

  let closeSettled = false;
  let resolveClose!: (result: CloseResult) => void;
  const closePromise = new Promise<CloseResult>(resolve => {
    resolveClose = resolve;
  });
  const settleClose = (result: CloseResult): void => {
    if (closeSettled) return;
    closeSettled = true;
    resolveClose(result);
  };

  proc.stdout?.on("data", (chunk: Buffer) => {
    if (sinkError) return;
    stdoutHash.update(chunk);
    stdoutBytes += chunk.byteLength;
    if (!onStdoutChunk) return;
    try {
      onStdoutChunk(chunk);
    } catch (error) {
      // A failing sink invalidates the run; stop consuming and report it.
      sinkError = error instanceof Error ? error : new Error(String(error));
      stderr.append(Buffer.from(`\n[code-pact: stdout sink failed: ${sinkError.message}]\n`));
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

  proc.once("close", code => settleClose({ exitCode: code }));
  proc.once("error", error => {
    stderr.append(Buffer.from(error.message));
    settleClose({ exitCode: null });
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ kind: "terminate"; cause: "timeout" }>(resolve => {
    timeoutHandle = setTimeout(
      () => resolve({ kind: "terminate", cause: "timeout" }),
      timeoutMs,
    );
  });

  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<{ kind: "terminate"; cause: "abort" }>(resolve => {
    if (!signal) return;
    let delivered = false;
    abortHandler = () => {
      if (delivered) return;
      delivered = true;
      resolve({ kind: "terminate", cause: "abort" });
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    if (signal.aborted) abortHandler();
  });

  const closeOutcome = closePromise.then(result => ({ kind: "close" as const, result }));
  const outcome = await Promise.race([closeOutcome, timeoutPromise, abortPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);

  const digest = (): string => stdoutHash.digest("hex");

  if (outcome.kind === "close") {
    if (sinkError) {
      return {
        exitCode: null,
        timedOut: false,
        aborted: false,
        elapsedMs: elapsedSince(started),
        stdoutSha256: digest(),
        stdoutBytes,
        stderr: stderr.value(),
        stderrTruncated: stderr.truncated(),
      };
    }
    return {
      exitCode: outcome.result.exitCode,
      timedOut: false,
      aborted: false,
      elapsedMs: elapsedSince(started),
      stdoutSha256: digest(),
      stdoutBytes,
      stderr: stderr.value(),
      stderrTruncated: stderr.truncated(),
    };
  }

  const cause: TerminationCause = outcome.cause;
  const termination = await terminateProcessTree(proc);
  if (!termination.completed) {
    stderr.append(
      Buffer.from(
        `\n[code-pact: process-tree termination incomplete: ${termination.error ?? "unknown error"}]\n`,
      ),
    );
  }

  let closeDeadline: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    closePromise.then(result => ({ closed: true as const, result })),
    new Promise<{ closed: false }>(resolve => {
      closeDeadline = setTimeout(() => resolve({ closed: false }), CLOSE_DEADLINE_MS);
    }),
  ]);
  if (closeDeadline) clearTimeout(closeDeadline);
  termination.closeObserved = closed.closed;

  if (!closed.closed) {
    stderr.append(Buffer.from("\n[code-pact: process close deadline exceeded]\n"));
    cleanupChildHandles(proc);
  }

  return {
    // A terminated run never produced complete output, so no exit code is
    // reported even when the platform delivered one after the kill.
    exitCode: null,
    timedOut: cause === "timeout",
    aborted: cause === "abort",
    elapsedMs: elapsedSince(started),
    stdoutSha256: digest(),
    stdoutBytes,
    stderr: stderr.value(),
    stderrTruncated: stderr.truncated(),
    termination,
  };
}
