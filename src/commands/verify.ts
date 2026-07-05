import { loadPhase } from "../core/plan/load-phase.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { resolvePhaseInRoadmap } from "../core/plan/resolve-phase.ts";
import { Phase } from "../core/schemas/phase.ts";
import { Task } from "../core/schemas/task.ts";
import { ProgressLog } from "../core/schemas/progress-event.ts";
import { loadMergedProgress } from "../core/progress/io.ts";
import {
  resolveDecisionGate,
  isDecisionRequiredForTask,
  type DecisionResolution,
} from "../core/decisions/adr.ts";
import { ConfigError } from "../lib/argv.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerifyOptions = {
  cwd: string;
  phaseId: string;
  taskId: string;
  dryRun: boolean;
  /** Per-command timeout in milliseconds (default: 300000). */
  timeoutMs?: number;
  /** Optional AbortSignal to cancel command execution. */
  signal?: AbortSignal;
  /**
   * When true, skip the `progress_event` and `task_status` checks.
   * Used by `task complete` to evaluate the deterministic preconditions
   * (commands, decision) without requiring the state that task complete
   * is itself about to produce.
   */
  skipConsistencyChecks?: boolean;
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
};

export type CheckResult = {
  name: string;
  ok: boolean;
  reason?: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  aborted?: boolean;
  exitCode?: number | null;
  elapsedMs?: number;
  commands?: CommandExecutionResult[];
};

export type VerifyResult = {
  ok: boolean;
  checks: CheckResult[];
};

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadProgressLog(cwd: string): Promise<ProgressLog> {
  return (await loadMergedProgress(cwd)).log;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

type CommandRun = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  elapsedMs: number;
};

type TerminationCause = "none" | "timeout" | "abort";

export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
export const MAX_TIMEOUT_MS = 2_147_483_647;
const KILL_FALLBACK_MS = 5_000;
const HARD_DEADLINE_MS = 10_000;

export function validateTimeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new ConfigError(
      `timeout must be a safe integer between 1 and ${MAX_TIMEOUT_MS} ms, got: ${value}`,
    );
  }
  return value;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Operation aborted");
    (err as NodeJS.ErrnoException).code = "ABORTED";
    throw err;
  }
}

type ProcessTerminationResult = {
  attempted: boolean;
  completed: boolean;
  strategy: "process-group" | "taskkill" | "direct-kill";
  error?: string;
  elapsedMs: number;
};

async function killProcessTree(
  proc: ChildProcess,
): Promise<ProcessTerminationResult> {
  const start = Date.now();
  if (proc.pid === undefined) {
    return {
      attempted: false,
      completed: false,
      strategy: "direct-kill",
      error: "No PID",
      elapsedMs: 0,
    };
  }
  // Guard against double-kill: if killProcessTree was already called
  // for this process, don't attempt a second kill. This can happen when
  // timeout and abort fire near-simultaneously.
  if ((proc as ChildProcess & { _killStarted?: boolean })._killStarted) {
    return {
      attempted: false,
      completed: false,
      strategy: "direct-kill",
      error: "Already started",
      elapsedMs: 0,
    };
  }
  (proc as ChildProcess & { _killStarted?: boolean })._killStarted = true;
  if (process.platform !== "win32") {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // fall through to fallback
    }
    // Poll for process extinction (max 500ms)
    const processExited = await waitForProcessExit(proc, 500);
    return {
      attempted: true,
      completed: processExited,
      strategy: "process-group",
      error: processExited ? undefined : "process still exists after timeout",
      elapsedMs: Date.now() - start,
    };
  }
  // Windows: use taskkill /T /F for tree kill
  const tkProc = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
    stdio: "ignore",
    shell: false,
  });
  const tkExit: Promise<number | null> = new Promise(resolve => {
    tkProc.on("close", code => resolve(code));
    tkProc.on("error", () => resolve(1));
  });
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let result: number | null = null;
  try {
    result = await Promise.race([
      tkExit,
      new Promise<null>(resolve => {
        fallbackTimer = setTimeout(() => resolve(null), KILL_FALLBACK_MS);
      }),
    ]);
  } finally {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    try {
      tkProc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
  if (result === null) {
    // Timer side won - taskkill didn't complete in time
    // Terminate taskkill process itself and fallback to direct kill
    try {
      tkProc.kill("SIGKILL");
    } catch {
      // taskkill already dead
    }
    // Fallback to direct kill of original process
    try {
      proc.kill("SIGKILL");
    } catch {
      // already dead
    }
  } else if (result !== 0) {
    // taskkill failed but completed
    // Try multiple fallback strategies
    let fallbackSuccess = false;

    // Fallback 1: Direct SIGKILL
    try {
      proc.kill("SIGKILL");
      fallbackSuccess = true;
    } catch {
      // already dead or permission denied
    }

    // Fallback 2: Try process group kill if available
    if (!fallbackSuccess && proc.pid) {
      try {
        process.kill(-proc.pid, "SIGKILL");
        fallbackSuccess = true;
      } catch {
        // process group kill failed
      }
    }

    // Fallback 3: Try taskkill with different parameters
    if (!fallbackSuccess && proc.pid) {
      try {
        const fallbackTk = spawn("taskkill", ["/f", "/pid", String(proc.pid)], {
          stdio: "ignore",
          shell: false,
        });
        await new Promise<void>(resolve => {
          fallbackTk.on("close", () => resolve());
          fallbackTk.on("error", () => resolve());
          setTimeout(() => {
            try {
              fallbackTk.kill("SIGKILL");
            } catch {
              // already dead
            }
            resolve();
          }, 1000);
        });
        fallbackSuccess = true;
      } catch {
        // fallback taskkill failed
      }
    }
  }
  // Poll for process extinction (max 500ms)
  const processExited = await waitForProcessExit(proc, 500);
  return {
    attempted: true,
    completed: result === 0 && processExited,
    strategy: "taskkill",
    error:
      result !== 0
        ? `taskkill exited with code ${result}`
        : processExited
          ? undefined
          : "process still exists after timeout",
    elapsedMs: Date.now() - start,
  };
}

async function waitForProcessExit(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null || proc.signalCode !== null) return true;
    try {
      process.kill(proc.pid!, 0);
    } catch {
      return true;
    }
    await new Promise(resolve => {
      const t = setTimeout(resolve, 50);
      t.unref();
    });
  }
  // Process still exists after timeout
  return false;
}

const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const TRUNCATED_OUTPUT_MESSAGE = `\n[code-pact: output truncated after ${MAX_COMMAND_OUTPUT_BYTES} bytes]\n`;

function createOutputCapture(): {
  append: (chunk: Buffer) => void;
  value: () => string;
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

      if (remaining > 0) {
        text += chunk.subarray(0, remaining).toString();
      }
      text += TRUNCATED_OUTPUT_MESSAGE;
      bytes = MAX_COMMAND_OUTPUT_BYTES;
      truncated = true;
    },
    value(): string {
      return text;
    },
  };
}

function runCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandRun> {
  return new Promise(resolve => {
    const shellCommand = cmd.trim();
    if (!shellCommand) {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: "empty verification command",
        timedOut: false,
        aborted: false,
        elapsedMs: 0,
      });
      return;
    }

    if (signal?.aborted) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "aborted before start",
        timedOut: false,
        aborted: true,
        elapsedMs: 0,
      });
      return;
    }

    const start = Date.now();
    const proc = spawn(shellCommand, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      detached: process.platform !== "win32",
    });
    const stdout = createOutputCapture();
    const stderr = createOutputCapture();
    let cause: TerminationCause = "none";
    let settled = false;
    let hardDeadline: ReturnType<typeof setTimeout> | undefined;

    const startHardDeadline = () => {
      // Record hard deadline activation
      stderr.append(
        Buffer.from(
          "\n[hard deadline activated - process did not terminate gracefully]\n",
        ),
      );
      hardDeadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({
          exitCode: null,
          stdout: stdout.value(),
          stderr: stderr.value(),
          timedOut: cause === "timeout",
          aborted: cause === "abort",
          elapsedMs: Date.now() - start,
        });
      }, HARD_DEADLINE_MS);
    };

    const timer = setTimeout(async () => {
      if (settled || cause !== "none") return;
      cause = "timeout";
      clearTimeout(timer);
      startHardDeadline();
      const terminationResult = await killProcessTree(proc);
      if (!terminationResult.completed) {
        stderr.append(
          Buffer.from(
            `\n[process tree termination failed: ${terminationResult.error || "unknown error"}]\n`,
          ),
        );
      }
    }, timeoutMs);
    timer.unref();

    let abortHandled = false;
    const onAbort = async () => {
      if (settled || cause !== "none" || abortHandled) return;
      abortHandled = true;
      cause = "abort";
      clearTimeout(timer);
      startHardDeadline();
      const terminationResult = await killProcessTree(proc);
      if (!terminationResult.completed) {
        stderr.append(
          Buffer.from(
            `\n[process tree termination failed: ${terminationResult.error || "unknown error"}]\n`,
          ),
        );
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // Check for abort that occurred between initial check and listener registration
    if (signal?.aborted && !abortHandled) {
      void onAbort();
    }

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardDeadline) clearTimeout(hardDeadline);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code,
        stdout: stdout.value(),
        stderr: stderr.value(),
        timedOut: cause === "timeout",
        aborted: cause === "abort",
        elapsedMs: Date.now() - start,
      });
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });
    proc.on("close", code => {
      void finish(code);
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (!settled) {
        stderr.append(Buffer.from(err.message));
      }
      void finish(1);
    });
  });
}

async function checkCommands(
  commands: string[],
  cwd: string,
  dryRun: boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const cmdResults: CommandExecutionResult[] = [];

  if (dryRun) {
    return {
      name: "commands",
      ok: true,
      reason: `dry-run: would execute: ${commands.join(", ")}`,
      command: commands.join("; "),
      timedOut: false,
      aborted: false,
      exitCode: null,
      elapsedMs: 0,
      stdout: "",
      stderr: "",
      commands: cmdResults,
    };
  }

  if (signal?.aborted) {
    return {
      name: "commands",
      ok: false,
      reason: "aborted before start",
      command: commands.join("; "),
      timedOut: false,
      aborted: true,
      exitCode: null,
      elapsedMs: 0,
      stdout: "",
      stderr: "",
      commands: cmdResults,
    };
  }

  let totalElapsed = 0;
  for (const cmd of commands) {
    const { exitCode, stdout, stderr, timedOut, aborted, elapsedMs } =
      await runCommand(cmd, cwd, timeoutMs, signal);
    totalElapsed += elapsedMs;

    const cmdResult: CommandExecutionResult = {
      command: cmd,
      ok: !timedOut && !aborted && exitCode === 0,
      exitCode,
      timedOut,
      aborted,
      elapsedMs,
      stdout,
      stderr,
    };
    cmdResults.push(cmdResult);

    if (aborted) {
      return {
        name: "commands",
        ok: false,
        reason: `"${cmd}" was aborted`,
        command: cmd,
        timedOut: false,
        aborted: true,
        exitCode,
        elapsedMs: totalElapsed,
        stdout,
        stderr,
        commands: cmdResults,
      };
    }
    if (timedOut) {
      return {
        name: "commands",
        ok: false,
        reason: `"${cmd}" timed out after ${timeoutMs} ms`,
        command: cmd,
        timedOut: true,
        aborted: false,
        exitCode,
        elapsedMs: totalElapsed,
        stdout,
        stderr,
        commands: cmdResults,
      };
    }
    if (exitCode !== 0) {
      return {
        name: "commands",
        ok: false,
        reason: `"${cmd}" exited with code ${exitCode}`,
        command: cmd,
        timedOut: false,
        aborted: false,
        exitCode,
        elapsedMs: totalElapsed,
        stdout,
        stderr,
        commands: cmdResults,
      };
    }
  }
  return {
    name: "commands",
    ok: true,
    command: commands.join("; "),
    timedOut: false,
    aborted: false,
    exitCode: 0,
    elapsedMs: totalElapsed,
    stdout: "",
    stderr: "",
    commands: cmdResults,
  };
}

async function checkProgressEvent(
  log: ProgressLog,
  taskId: string,
): Promise<CheckResult> {
  const event = log.events.find(
    e => e.task_id === taskId && e.status === "done",
  );
  if (!event) {
    return {
      name: "progress_event",
      ok: false,
      reason: `No "done" event for task "${taskId}" in the progress ledger`,
    };
  }
  // Zod already validates the datetime format, so if it parsed it's valid
  return { name: "progress_event", ok: true };
}

export type DecisionGateResult = {
  check: CheckResult;
  /** The underlying resolution, or null when the task has no decision gate. */
  resolution: DecisionResolution | null;
};

/** Project a status-aware resolution onto the verify CheckResult shape. */
export function decisionResolutionToCheck(
  res: DecisionResolution,
): CheckResult {
  return res.resolved
    ? { name: "decision", ok: true }
    : { name: "decision", ok: false, reason: res.reason };
}

/**
 * The single decision gate. Routes through the shared status-aware resolver
 * so verify, task complete, task record-done, and plan lint cannot
 * diverge on what "resolved" means. Returns both the CheckResult (for
 * runVerify) and the full resolution (so record-done can surface `considered`
 * / `via` without re-resolving).
 */
export async function checkDecision(
  cwd: string,
  phase: Phase,
  task: Task,
): Promise<DecisionGateResult> {
  if (!isDecisionRequiredForTask(phase, task)) {
    return { check: { name: "decision", ok: true }, resolution: null };
  }
  const resolution = await resolveDecisionGate(
    cwd,
    task.id,
    task.decision_refs,
  );
  return { check: decisionResolutionToCheck(resolution), resolution };
}

function checkTaskStatus(phase: Phase, taskId: string): CheckResult {
  const task = phase.tasks?.find(t => t.id === taskId);
  if (!task) {
    return {
      name: "task_status",
      ok: false,
      reason: `Task "${taskId}" not found in phase definition`,
    };
  }
  if (task.status !== "done") {
    return {
      name: "task_status",
      ok: false,
      reason: `Task "${taskId}" status is "${task.status}", expected "done"`,
    };
  }
  return { name: "task_status", ok: true };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runVerify(opts: VerifyOptions): Promise<VerifyResult> {
  const { cwd, phaseId, taskId, dryRun, signal } = opts;
  const timeoutMs = validateTimeoutMs(
    opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  );
  const skipConsistency = opts.skipConsistencyChecks === true;

  // Resolve phase
  const ref = await resolvePhaseInRoadmap(cwd, phaseId);
  throwIfAborted(signal);

  // The progress ledger is only loaded when the consistency checks need it.
  const phase = await loadPhase(cwd, ref.path);
  throwIfAborted(signal);

  // Verify task exists in phase before running checks
  const taskExists = phase.tasks?.some(t => t.id === taskId) ?? false;
  if (!taskExists) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  const task = phase.tasks!.find(t => t.id === taskId)!;
  throwIfAborted(signal);

  // Deterministic preflight checks: would always be runnable on a fresh
  // task before any state mutation. `task complete` calls runVerify with
  // skipConsistencyChecks: true so these are the only checks evaluated.
  // checkCommands handles abort internally — if the signal is already
  // aborted or fires mid-execution, it returns a CheckResult with
  // aborted: true rather than throwing.
  const commandsCheck = await checkCommands(
    phase.verification.commands,
    cwd,
    dryRun,
    timeoutMs,
    signal,
  );
  const checks: CheckResult[] = [commandsCheck];

  // If commands check was aborted or timed out, skip remaining checks
  if (commandsCheck.aborted || commandsCheck.timedOut) {
    if (!skipConsistency) {
      checks.push({
        name: "progress_event",
        ok: false,
        reason: commandsCheck.reason || "aborted",
      });
      checks.push({
        name: "task_status",
        ok: false,
        reason: commandsCheck.reason || "aborted",
      });
    }
    checks.push({
      name: "decision",
      ok: false,
      reason: commandsCheck.reason || "aborted",
    });
    return { ok: false, checks };
  }

  // If aborted during commands, skip remaining checks and return early.
  if (signal?.aborted) {
    if (!skipConsistency) {
      checks.push({ name: "progress_event", ok: false, reason: "aborted" });
      checks.push({ name: "task_status", ok: false, reason: "aborted" });
    }
    checks.push({ name: "decision", ok: false, reason: "aborted" });
    return { ok: false, checks };
  }

  throwIfAborted(signal);
  checks.push((await checkDecision(cwd, phase, task)).check);
  throwIfAborted(signal);

  // State-consistency checks: only meaningful AFTER the task has been
  // recorded as done. `verify` (standalone) runs them; `task complete`
  // skips them because it is the action that produces that state.
  if (!skipConsistency) {
    throwIfAborted(signal);
    const log = await loadProgressLog(cwd);
    checks.splice(1, 0, await checkProgressEvent(log, taskId));
    checks.push(checkTaskStatus(phase, taskId));
  }

  const ok = checks.every(c => c.ok);
  return { ok, checks };
}

// ---------------------------------------------------------------------------
// Human-readable formatter
// ---------------------------------------------------------------------------

export function formatVerify(result: VerifyResult): string {
  const lines = result.checks.map(c => {
    const mark = c.ok ? "✓" : "✗";
    const reason = c.reason ? `  → ${c.reason}` : "";
    return `  ${mark} ${c.name}${reason}`;
  });
  const summary = result.ok ? "All checks passed." : "Verification failed.";
  return [summary, ...lines].join("\n");
}
