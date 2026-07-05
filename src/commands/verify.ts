import { loadPhase } from "../core/plan/load-phase.ts";
import {
  runBoundedCommand,
  type CommandExecutionResult,
  type ProcessTerminationResult,
} from "../core/process/bounded-command.ts";
import { resolvePhaseInRoadmap } from "../core/plan/resolve-phase.ts";
import type { Phase } from "../core/schemas/phase.ts";
import type { Task } from "../core/schemas/task.ts";
import type { ProgressLog } from "../core/schemas/progress-event.ts";
import { loadMergedProgress } from "../core/progress/io.ts";
import {
  resolveDecisionGate,
  isDecisionRequiredForTask,
  type DecisionResolution,
} from "../core/decisions/adr.ts";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  validateTimeoutMs,
} from "../lib/timeout.ts";

export type VerifyOptions = {
  cwd: string;
  phaseId: string;
  taskId: string;
  dryRun: boolean;
  /** Per-command timeout in milliseconds. Defaults to five minutes. */
  timeoutMs?: number;
  /** Cancels the active verification command and prevents later checks. */
  signal?: AbortSignal;
  /** Skip checks for state that `task complete` is about to create. */
  skipConsistencyChecks?: boolean;
};

export type { CommandExecutionResult, ProcessTerminationResult };

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

export { DEFAULT_COMMAND_TIMEOUT_MS, MAX_TIMEOUT_MS, validateTimeoutMs };

export function createAbortError(): Error {
  const error = new Error("Operation aborted");
  (error as NodeJS.ErrnoException).code = "ABORTED";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

async function loadProgressLog(cwd: string): Promise<ProgressLog> {
  return (await loadMergedProgress(cwd)).log;
}

async function checkCommands(
  commands: string[],
  cwd: string,
  dryRun: boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const commandResults: CommandExecutionResult[] = [];

  if (dryRun) {
    for (const command of commands) {
      commandResults.push({
        command,
        ok: true,
        exitCode: null,
        timedOut: false,
        aborted: false,
        elapsedMs: 0,
        stdout: "",
        stderr: "",
      });
    }
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
      commands: commandResults,
    };
  }

  let totalElapsedMs = 0;
  for (const command of commands) {
    const run = await runBoundedCommand(command, cwd, timeoutMs, signal);
    const result: CommandExecutionResult = {
      command,
      ok: !run.timedOut && !run.aborted && run.exitCode === 0,
      ...run,
    };
    commandResults.push(result);
    totalElapsedMs += run.elapsedMs;

    if (!result.ok) {
      const reason = result.aborted
        ? `"${command}" was aborted`
        : result.timedOut
          ? `"${command}" timed out after ${timeoutMs} ms`
          : result.exitCode === null
            ? `"${command}" failed to start`
            : `"${command}" exited with code ${result.exitCode}`;
      return {
        name: "commands",
        ok: false,
        reason,
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        aborted: result.aborted,
        exitCode: result.exitCode,
        elapsedMs: totalElapsedMs,
        commands: commandResults,
      };
    }
  }

  return {
    name: "commands",
    ok: true,
    command: commands.join("; "),
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: false,
    exitCode: 0,
    elapsedMs: totalElapsedMs,
    commands: commandResults,
  };
}

async function checkProgressEvent(log: ProgressLog, taskId: string): Promise<CheckResult> {
  const event = log.events.find(
    (candidate: ProgressLog["events"][number]) =>
      candidate.task_id === taskId && candidate.status === "done",
  );
  return event
    ? { name: "progress_event", ok: true }
    : {
        name: "progress_event",
        ok: false,
        reason: `No "done" event for task "${taskId}" in the progress ledger`,
      };
}

export type DecisionGateResult = {
  check: CheckResult;
  resolution: DecisionResolution | null;
};

export function decisionResolutionToCheck(resolution: DecisionResolution): CheckResult {
  return resolution.resolved
    ? { name: "decision", ok: true }
    : { name: "decision", ok: false, reason: resolution.reason };
}

export async function checkDecision(
  cwd: string,
  phase: Phase,
  task: Task,
): Promise<DecisionGateResult> {
  if (!isDecisionRequiredForTask(phase, task)) {
    return { check: { name: "decision", ok: true }, resolution: null };
  }
  const resolution = await resolveDecisionGate(cwd, task.id, task.decision_refs);
  return { check: decisionResolutionToCheck(resolution), resolution };
}

function checkTaskStatus(phase: Phase, taskId: string): CheckResult {
  const task = phase.tasks?.find((candidate: Task) => candidate.id === taskId);
  if (!task) {
    return {
      name: "task_status",
      ok: false,
      reason: `Task "${taskId}" not found in phase definition`,
    };
  }
  return task.status === "done"
    ? { name: "task_status", ok: true }
    : {
        name: "task_status",
        ok: false,
        reason: `Task "${taskId}" status is "${task.status}", expected "done"`,
      };
}

export async function runVerify(opts: VerifyOptions): Promise<VerifyResult> {
  const { cwd, phaseId, taskId, dryRun, signal } = opts;
  const timeoutMs = validateTimeoutMs(opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  const skipConsistencyChecks = opts.skipConsistencyChecks === true;

  throwIfAborted(signal);
  const ref = await resolvePhaseInRoadmap(cwd, phaseId);
  throwIfAborted(signal);
  const phase = await loadPhase(cwd, ref.path);
  throwIfAborted(signal);

  const task = phase.tasks?.find((candidate: Task) => candidate.id === taskId);
  if (!task) {
    const error = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (error as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw error;
  }

  const commandsCheck = await checkCommands(
    phase.verification.commands,
    cwd,
    dryRun,
    timeoutMs,
    signal,
  );
  const checks: CheckResult[] = [commandsCheck];

  if (commandsCheck.aborted || commandsCheck.timedOut) {
    return { ok: false, checks };
  }

  throwIfAborted(signal);
  const decisionCheck = (await checkDecision(cwd, phase, task)).check;
  checks.push(decisionCheck);
  throwIfAborted(signal);

  if (!skipConsistencyChecks) {
    const log = await loadProgressLog(cwd);
    throwIfAborted(signal);
    checks.splice(1, 0, await checkProgressEvent(log, taskId));
    checks.push(checkTaskStatus(phase, taskId));
  }

  return { ok: checks.every(check => check.ok), checks };
}

export function formatVerify(result: VerifyResult): string {
  const lines = result.checks.map(check => {
    const mark = check.ok ? "✓" : "✗";
    return `  ${mark} ${check.name}${check.reason ? `  → ${check.reason}` : ""}`;
  });
  return [result.ok ? "All checks passed." : "Verification failed.", ...lines].join("\n");
}
