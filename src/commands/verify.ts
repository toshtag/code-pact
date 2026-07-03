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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Default per-command timeout: 5 minutes. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;

export type VerifyOptions = {
  cwd: string;
  phaseId: string;
  taskId: string;
  dryRun: boolean;
  /**
   * Per-command timeout in milliseconds. When a verification command
   * exceeds this it is killed (including its child process tree) and
   * reported as a timeout failure. Defaults to
   * {@link DEFAULT_COMMAND_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /**
   * When true, skip the `progress_event` and `task_status` checks.
   * Used by `task complete` to evaluate the deterministic preconditions
   * (commands, decision) without requiring the state that task complete
   * is itself about to produce.
   */
  skipConsistencyChecks?: boolean;
};

export type CheckResult = {
  name: string;
  ok: boolean;
  reason?: string;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  elapsedMs?: number;
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
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
};

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

function killProcessTree(proc: ChildProcess): void {
  if (proc.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      // On Windows, use taskkill with /T to kill the entire process tree.
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        shell: false,
      });
    } else {
      // On POSIX, sending a negative PID signals the process group.
      process.kill(-proc.pid, "SIGKILL");
    }
  } catch {
    // Best-effort: if the process already exited, kill will throw.
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

function runCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandRun> {
  return new Promise(resolve => {
    const shellCommand = cmd.trim();
    if (!shellCommand) {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: "empty verification command",
        timedOut: false,
        elapsedMs: 0,
      });
      return;
    }

    const start = Date.now();
    const proc = spawn(shellCommand, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      // Create a new process group so we can kill the entire tree.
      detached: process.platform !== "win32",
    });
    const stdout = createOutputCapture();
    const stderr = createOutputCapture();
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc);
    }, timeoutMs);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsedMs = Date.now() - start;
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.value(),
        stderr: stderr.value(),
        timedOut,
        elapsedMs,
      });
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });
    proc.on("close", code => finish(code));
    proc.on("error", () => finish(1));
  });
}

async function checkCommands(
  commands: string[],
  cwd: string,
  dryRun: boolean,
  timeoutMs: number,
): Promise<CheckResult> {
  if (dryRun) {
    return {
      name: "commands",
      ok: true,
      reason: `dry-run: would execute: ${commands.join(", ")}`,
    };
  }

  for (const cmd of commands) {
    const { exitCode, stdout, stderr, timedOut, elapsedMs } = await runCommand(
      cmd,
      cwd,
      timeoutMs,
    );
    if (timedOut) {
      return {
        name: "commands",
        ok: false,
        reason: `"${cmd}" timed out after ${timeoutMs}ms`,
        ...(stdout && { stdout }),
        ...(stderr && { stderr }),
        timedOut: true,
        elapsedMs,
      };
    }
    if (exitCode !== 0) {
      return {
        name: "commands",
        ok: false,
        reason: `"${cmd}" exited with code ${exitCode}`,
        ...(stdout && { stdout }),
        ...(stderr && { stderr }),
        elapsedMs,
      };
    }
  }
  return { name: "commands", ok: true, timedOut: false };
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
  const { cwd, phaseId, taskId, dryRun } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const skipConsistency = opts.skipConsistencyChecks === true;

  // Resolve phase
  const ref = await resolvePhaseInRoadmap(cwd, phaseId);

  // The progress ledger is only loaded when the consistency checks need it.
  const phase = await loadPhase(cwd, ref.path);

  // Verify task exists in phase before running checks
  const taskExists = phase.tasks?.some(t => t.id === taskId) ?? false;
  if (!taskExists) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  const task = phase.tasks!.find(t => t.id === taskId)!;

  // Deterministic preflight checks: would always be runnable on a fresh
  // task before any state mutation. `task complete` calls runVerify with
  // skipConsistencyChecks: true so these are the only checks evaluated.
  const checks: CheckResult[] = [
    await checkCommands(phase.verification.commands, cwd, dryRun, timeoutMs),
    (await checkDecision(cwd, phase, task)).check,
  ];

  // State-consistency checks: only meaningful AFTER the task has been
  // recorded as done. `verify` (standalone) runs them; `task complete`
  // skips them because it is the action that produces that state.
  if (!skipConsistency) {
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
