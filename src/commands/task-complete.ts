import { loadProject, resolveEnabledAgent } from "../core/project.ts";
import type { ProgressEvent } from "../core/schemas/progress-event.ts";
import { loadProgressLog } from "../core/progress/io.ts";
import { writeEventFile } from "../core/progress/events-io.ts";
import { resolveEventAuthor } from "../core/progress/author.ts";
import { deriveTaskState } from "../core/progress/task-state.ts";
import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";
import { runVerify, throwIfAborted, type CheckResult } from "./verify.ts";
import { loadPhase } from "../core/plan/load-phase.ts";
import {
  recordLoopMemoryEpisodeBestEffort,
  type LoopMemoryWarning,
} from "../core/loop-memory/task-complete-recorder.ts";

export type TaskCompleteOptions = {
  cwd: string;
  taskId: string;
  /** Optional. When omitted, project.yaml's default_agent is used. */
  agent?: string;
  /** When true, do not record a progress event (the ledger is unchanged). */
  dryRun?: boolean;
  /** Per-command timeout in milliseconds. */
  timeoutMs?: number;
  /** Cancels verification and prevents a pre-commit event write. */
  signal?: AbortSignal;
  /** Date injection for tests. Defaults to new Date(). */
  now?: () => Date;
};

export type TaskCompleteResult =
  | {
      kind: "done";
      task_id: string;
      phase_id: string;
      agent: string;
      event: ProgressEvent;
      verify: { ok: true; checks: CheckResult[] };
      warnings?: LoopMemoryWarning[];
    }
  | {
      kind: "already_done";
      task_id: string;
      phase_id: string;
      agent: string;
    }
  | {
      kind: "dry_run";
      task_id: string;
      phase_id: string;
      agent: string;
      would_append: ProgressEvent;
      verify: { ok: true; checks: CheckResult[] };
    };

export async function runTaskComplete(
  opts: TaskCompleteOptions,
): Promise<TaskCompleteResult> {
  const { cwd, taskId } = opts;
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? (() => new Date());

  throwIfAborted(opts.signal);
  const project = await loadProject(cwd);
  const agentName = resolveEnabledAgent(project, opts.agent);
  throwIfAborted(opts.signal);

  const { phaseId, phasePath } = await resolveTaskInRoadmap(cwd, taskId);
  const phase = await loadPhase(cwd, phasePath);
  const task = phase.tasks?.find(candidate => candidate.id === taskId);
  if (!task) {
    const error = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (error as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw error;
  }
  throwIfAborted(opts.signal);

  const { log } = await loadProgressLog(cwd);
  const state = deriveTaskState(log.events, taskId);
  throwIfAborted(opts.signal);

  if (state.current === "done") {
    return {
      kind: "already_done",
      task_id: taskId,
      phase_id: phaseId,
      agent: agentName,
    };
  }

  if (state.current === "blocked") {
    const error = new Error(
      `Task "${taskId}" is blocked. Run \`task resume ${taskId}\` before completing.`,
    );
    (error as NodeJS.ErrnoException).code = "INVALID_TASK_TRANSITION";
    (error as NodeJS.ErrnoException & { current?: string; next?: string }).current =
      state.current;
    (error as NodeJS.ErrnoException & { current?: string; next?: string }).next =
      "done";
    throw error;
  }

  const verifyResult = await runVerify({
    cwd,
    phaseId,
    taskId,
    dryRun,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    skipConsistencyChecks: true,
  });

  if (!verifyResult.ok) {
    const memoryWarning = dryRun
      ? undefined
      : await recordLoopMemoryEpisodeBestEffort({
          cwd,
          phase,
          task,
          verify: verifyResult,
          recordedAt: now(),
        });
    const error = new Error(
      `Verification failed for "${taskId}". No progress event was recorded.`,
    );
    (error as NodeJS.ErrnoException).code = "VERIFICATION_FAILED";
    (error as NodeJS.ErrnoException & { checks?: CheckResult[] }).checks =
      verifyResult.checks;
    if (memoryWarning !== undefined) {
      (error as NodeJS.ErrnoException & { warnings?: LoopMemoryWarning[] }).warnings = [
        memoryWarning,
      ];
    }
    throw error;
  }

  throwIfAborted(opts.signal);
  const author = await resolveEventAuthor(cwd);
  throwIfAborted(opts.signal);
  const event: ProgressEvent = {
    task_id: taskId,
    status: "done",
    at: now().toISOString(),
    actor: "agent",
    agent: agentName,
    evidence: verifyResult.checks.filter(check => check.ok).map(check => check.name),
    source: "loop",
    ...(author !== undefined ? { author } : {}),
  };
  throwIfAborted(opts.signal);

  if (dryRun) {
    return {
      kind: "dry_run",
      task_id: taskId,
      phase_id: phaseId,
      agent: agentName,
      would_append: event,
      verify: { ok: true, checks: verifyResult.checks },
    };
  }

  // Cancellation before this call writes nothing. Once the atomic event write
  // starts, it is the commit point and is allowed to finish.
  throwIfAborted(opts.signal);
  await writeEventFile(cwd, event);
  const memoryWarning = await recordLoopMemoryEpisodeBestEffort({
    cwd,
    phase,
    task,
    verify: verifyResult,
    recordedAt: now(),
  });

  return {
    kind: "done",
    task_id: taskId,
    phase_id: phaseId,
    agent: agentName,
    event,
    verify: { ok: true, checks: verifyResult.checks },
    ...(memoryWarning !== undefined ? { warnings: [memoryWarning] } : {}),
  };
}
