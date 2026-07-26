import { loadPhase } from "../core/plan/load-phase.ts";
import {
  runBoundedCommand,
  type CommandExecutionResult,
  type ProcessTerminationResult,
} from "../core/process/bounded-command.ts";
import { loadProject } from "../core/project.ts";
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
import {
  appendVerificationLedgerEntry,
  currentVerificationState,
  lastStageEntryForState,
  ledgerCommandsFromCheck,
  readVerificationLedger,
  stageAttemptCount,
} from "../core/verification-ledger.ts";
import {
  canonicalFocusedVerifyCommand,
  focusedVerificationCommand,
  hasVerificationPolicy,
  maxFullAttempts,
  type VerificationStage,
} from "../core/verification-policy.ts";

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
  /** Optional stage. Omitted preserves the historical full verification path. */
  stage?: VerificationStage;
};

export type { CommandExecutionResult, ProcessTerminationResult };

export type CheckResult = {
  name: string;
  ok: boolean;
  stage?: VerificationStage;
  reason?: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut?: boolean;
  aborted?: boolean;
  exitCode?: number | null;
  elapsedMs?: number;
  commands?: CommandExecutionResult[];
  next?: { stage: VerificationStage; command: string };
};

export type VerifyResult = {
  ok: boolean;
  stage?: VerificationStage;
  next?: { stage: VerificationStage; command: string };
  checks: CheckResult[];
};

export { DEFAULT_COMMAND_TIMEOUT_MS, MAX_TIMEOUT_MS, validateTimeoutMs };

export type PublicCommandExecutionResult = Omit<
  CommandExecutionResult,
  "stdoutTruncated" | "stderrTruncated"
>;

export type PublicCheckResult = Omit<
  CheckResult,
  "stdoutTruncated" | "stderrTruncated" | "commands"
> & {
  commands?: PublicCommandExecutionResult[];
};

export type PublicVerifyResult = {
  ok: boolean;
  stage?: VerificationStage;
  next?: { stage: VerificationStage; command: string };
  checks: PublicCheckResult[];
};

export function projectCommandForPublicJson(
  command: CommandExecutionResult,
): PublicCommandExecutionResult {
  const { stdoutTruncated: _stdoutTruncated, stderrTruncated: _stderrTruncated, ...rest } = command;
  return rest;
}

export function projectCheckForPublicJson(check: CheckResult): PublicCheckResult {
  const {
    stdoutTruncated: _stdoutTruncated,
    stderrTruncated: _stderrTruncated,
    commands,
    ...rest
  } = check;
  return {
    ...rest,
    ...(commands ? { commands: commands.map(projectCommandForPublicJson) } : {}),
  };
}

export function projectVerifyForPublicJson(result: VerifyResult): PublicVerifyResult {
  return {
    ok: result.ok,
    ...(result.stage ? { stage: result.stage } : {}),
    ...(result.next ? { next: result.next } : {}),
    checks: result.checks.map(projectCheckForPublicJson),
  };
}

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
        stdoutTruncated: false,
        stderrTruncated: false,
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
      stdoutTruncated: false,
      stderrTruncated: false,
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
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
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
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    exitCode: 0,
    elapsedMs: totalElapsedMs,
    commands: commandResults,
  };
}

function fullRetryRequiresFocusedPass(
  taskId: string,
  phaseId: string,
): { stage: VerificationStage; command: string } {
  return {
    stage: "focused",
    command: canonicalFocusedVerifyCommand(phaseId, taskId),
  };
}

async function assertFullStageAllowed(opts: {
  cwd: string;
  taskId: string;
  phaseId: string;
  maxAttempts: number;
  signal?: AbortSignal;
}): Promise<void> {
  // Throwing here keeps the full verification commands from starting at all
  // when the run was cancelled while its authorization state was collected.
  const state = await currentVerificationState(opts.cwd, {
    signal: opts.signal,
  });
  const ledger = await readVerificationLedger(opts.cwd);
  if (stageAttemptCount(ledger, opts.taskId, "full") >= opts.maxAttempts) {
    const error = new Error(
      `Full verification budget exceeded for task "${opts.taskId}" (max ${opts.maxAttempts}).`,
    );
    (error as NodeJS.ErrnoException).code =
      "FULL_VERIFICATION_BUDGET_EXCEEDED";
    (
      error as NodeJS.ErrnoException & {
        next?: { stage: VerificationStage; command: string };
      }
    ).next = fullRetryRequiresFocusedPass(opts.taskId, opts.phaseId);
    throw error;
  }

  const focusedSuccess = lastStageEntryForState(
    ledger,
    opts.taskId,
    state,
    "focused",
  );
  const lastFull = lastStageEntryForState(ledger, opts.taskId, state, "full");
  const focusedAfterLastFull =
    focusedSuccess &&
    !focusedSuccess.failure &&
    (!lastFull ||
      new Date(focusedSuccess.finished_at).getTime() >
        new Date(lastFull.finished_at).getTime());

  if (!focusedAfterLastFull) {
    const error = new Error(
      `Full verification requires a successful focused pass first for the current change set.`,
    );
    (error as NodeJS.ErrnoException).code =
      "FULL_RETRY_REQUIRES_FOCUSED_PASS";
    (
      error as NodeJS.ErrnoException & {
        next?: { stage: VerificationStage; command: string };
      }
    ).next = fullRetryRequiresFocusedPass(opts.taskId, opts.phaseId);
    throw error;
  }
}

async function recordStageAttempt(opts: {
  cwd: string;
  taskId: string;
  phaseId: string;
  stage: VerificationStage;
  startedAt: Date;
  finishedAt: Date;
  commandCheck: CheckResult;
  failure: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  // A ledger entry is only meaningful alongside the state it was produced
  // under, so a cancelled collection must record nothing rather than guess.
  const state = await currentVerificationState(opts.cwd, {
    signal: opts.signal,
  });
  await appendVerificationLedgerEntry(opts.cwd, {
    started_at: opts.startedAt.toISOString(),
    finished_at: opts.finishedAt.toISOString(),
    task_id: opts.taskId,
    phase_id: opts.phaseId,
    head_sha: state.headSha,
    working_tree_diff_digest: state.workingTreeDiffDigest,
    stage: opts.stage,
    commands: ledgerCommandsFromCheck(opts.commandCheck),
    duration_ms: opts.finishedAt.getTime() - opts.startedAt.getTime(),
    failure: opts.failure,
  });
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
  const stage = opts.stage;

  throwIfAborted(signal);
  const project = stage === undefined ? null : await loadProject(cwd);
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

  if (stage === "focused") {
    const focusedCommand = focusedVerificationCommand(project!, taskId, phaseId);
    if (focusedCommand === null) {
      const error = new Error(
        "Focused verification is not configured for this project.",
      );
      (error as NodeJS.ErrnoException).code =
        "FOCUSED_VERIFICATION_NOT_CONFIGURED";
      throw error;
    }

    const startedAt = new Date();
    const commandsCheck = await checkCommands(
      [focusedCommand],
      cwd,
      dryRun,
      timeoutMs,
      signal,
    );
    commandsCheck.stage = "focused";
    const finishedAt = new Date();
    const result: VerifyResult = {
      ok: commandsCheck.ok,
      stage: "focused",
      checks: [commandsCheck],
      ...(commandsCheck.ok
        ? {
            next: {
              stage: "full",
              command: `code-pact task complete ${taskId} --json --detail agent`,
            },
          }
        : {}),
    };
    if (!dryRun) {
      await recordStageAttempt({
        cwd,
        taskId,
        phaseId,
        stage: "focused",
        startedAt,
        finishedAt,
        commandCheck: commandsCheck,
        failure: !result.ok,
        signal,
      });
    }
    return result;
  }

  if (stage === "full" && hasVerificationPolicy(project!)) {
    await assertFullStageAllowed({
      cwd,
      taskId,
      phaseId,
      maxAttempts: maxFullAttempts(project!),
      signal,
    });
  }

  const startedAt = new Date();
  const commandsCheck = await checkCommands(
    phase.verification.commands,
    cwd,
    dryRun,
    timeoutMs,
    signal,
  );
  if (stage === "full") commandsCheck.stage = "full";
  const checks: CheckResult[] = [commandsCheck];

  if (commandsCheck.aborted || commandsCheck.timedOut) {
    const finishedAt = new Date();
    if (!dryRun && stage === "full" && hasVerificationPolicy(project!)) {
      await recordStageAttempt({
        cwd,
        taskId,
        phaseId,
        stage: "full",
        startedAt,
        finishedAt,
        commandCheck: commandsCheck,
        failure: true,
        signal,
      });
    }
    return {
      ok: false,
      ...(stage === "full"
        ? {
            stage: "full" as const,
            next: fullRetryRequiresFocusedPass(taskId, phaseId),
          }
        : {}),
      checks,
    };
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

  const ok = checks.every(check => check.ok);
  const finishedAt = new Date();
  if (!dryRun && stage === "full" && hasVerificationPolicy(project!)) {
    await recordStageAttempt({
      cwd,
      taskId,
      phaseId,
      stage: "full",
      startedAt,
      finishedAt,
      commandCheck: commandsCheck,
      failure: !ok,
      signal,
    });
  }

  return {
    ok,
    ...(stage === "full"
      ? {
          stage: "full" as const,
          ...(!ok ? { next: fullRetryRequiresFocusedPass(taskId, phaseId) } : {}),
        }
      : {}),
    checks,
  };
}

export function formatVerify(result: VerifyResult): string {
  const lines = result.checks.map(check => {
    const mark = check.ok ? "✓" : "✗";
    return `  ${mark} ${check.name}${check.reason ? `  → ${check.reason}` : ""}`;
  });
  return [result.ok ? "All checks passed." : "Verification failed.", ...lines].join("\n");
}
