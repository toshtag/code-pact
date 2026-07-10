import { spawn, type ChildProcess } from "node:child_process";

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

const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const TRUNCATED_OUTPUT_MESSAGE = `\n[code-pact: output truncated after ${MAX_COMMAND_OUTPUT_BYTES} bytes]\n`;
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

function createOutputCapture(): {
  append: (chunk: Buffer) => void;
  value: () => string;
  truncated: () => boolean;
} {
  let text = "";
  let bytes = 0;
  let truncated = false;

  return {
    append(chunk: Buffer): void {
      if (truncated) return;
      const remaining = MAX_COMMAND_OUTPUT_BYTES - bytes;
      if (chunk.byteLength <= remaining) {
        text += chunk.toString();
        bytes += chunk.byteLength;
        return;
      }
      if (remaining > 0) text += chunk.subarray(0, remaining).toString();
      text += TRUNCATED_OUTPUT_MESSAGE;
      bytes = MAX_COMMAND_OUTPUT_BYTES;
      truncated = true;
    },
    value: () => text,
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

/**
 * Run a trusted project shell command with bounded output, timeout, external
 * cancellation, and descendant-tree termination diagnostics.
 */
export async function runBoundedCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BoundedCommandResult> {
  const shellCommand = command.trim();
  if (!shellCommand) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "empty verification command",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
      elapsedMs: 0,
    };
  }
  if (signal?.aborted) {
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

  const started = performance.now();
  const stdout = createOutputCapture();
  const stderr = createOutputCapture();
  const proc = spawn(shellCommand, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    detached: process.platform !== "win32",
  });

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
