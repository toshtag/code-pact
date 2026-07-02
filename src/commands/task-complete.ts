import { loadProject, resolveEnabledAgent } from "../core/project.ts";
import type { ProgressEvent } from "../core/schemas/progress-event.ts";
import { loadProgressLog } from "../core/progress/io.ts";
import { writeEventFile } from "../core/progress/events-io.ts";
import { resolveEventAuthor } from "../core/progress/author.ts";
import { deriveTaskState } from "../core/progress/task-state.ts";
import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";
import { runVerify, type CheckResult } from "./verify.ts";

export type TaskCompleteOptions = {
  cwd: string;
  taskId: string;
  /** Optional. When omitted, project.yaml's default_agent is used. */
  agent?: string;
  /** When true, do not record a progress event (the ledger is unchanged). */
  dryRun?: boolean;
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

  // ---- Step 0: agent validation (same order as task context) ----
  const project = await loadProject(cwd);
  const agentName = resolveEnabledAgent(project, opts.agent);

  // ---- Step 1: resolve phase from task id ----
  const { phaseId } = await resolveTaskInRoadmap(cwd, taskId);

  // ---- Step 2: derive current state ----
  const { log } = await loadProgressLog(cwd);
  const state = deriveTaskState(log.events, taskId);

  if (state.current === "done") {
    return {
      kind: "already_done",
      task_id: taskId,
      phase_id: phaseId,
      agent: agentName,
    };
  }

  // Reject completion from blocked. Task must be explicitly resumed first
  // so the resume event records the unblock decision in the log.
  if (state.current === "blocked") {
    const err = new Error(
      `Task "${taskId}" is blocked. Run \`task resume ${taskId}\` before completing.`,
    );
    (err as NodeJS.ErrnoException).code = "INVALID_TASK_TRANSITION";
    (err as NodeJS.ErrnoException & {
      current?: string;
      next?: string;
    }).current = state.current;
    (err as NodeJS.ErrnoException & {
      current?: string;
      next?: string;
    }).next = "done";
    throw err;
  }
  // planned / started / resumed / failed: proceed to verify.
  // planned→done is permitted at the command layer for compatibility;
  // assertTransition rejects it, so we intentionally do not call that here.

  // ---- Step 3: run verify in preflight mode ----
  // skipConsistencyChecks: true skips the progress_event + task_status
  // checks that task complete is itself about to produce. The remaining
  // checks (commands, decision) are the deterministic preconditions.
  //
  // Propagate the caller's `dryRun`: a `--dry-run` completion must NOT execute
  // the project-controlled `verification.commands` (spawned with shell: true).
  // With dryRun the commands check returns a "would execute" preview instead of
  // running, so a dry run has no side effects. The decision gate is a read and
  // still runs, so an unresolved-decision dry run still surfaces the gate.
  const verifyResult = await runVerify({
    cwd,
    phaseId,
    taskId,
    dryRun,
    skipConsistencyChecks: true,
  });

  if (!verifyResult.ok) {
    // Surface verify result without recording an event.
    const err = new Error(
      `Verification failed for "${taskId}". No progress event was recorded.`,
    );
    (err as NodeJS.ErrnoException).code = "VERIFICATION_FAILED";
    (err as NodeJS.ErrnoException & { checks?: CheckResult[] }).checks =
      verifyResult.checks;
    throw err;
  }

  // ---- Step 4: build the done event ----
  const author = await resolveEventAuthor(cwd);
  const event: ProgressEvent = {
    task_id: taskId,
    status: "done",
    at: now().toISOString(),
    actor: "agent",
    agent: agentName,
    evidence: verifyResult.checks.filter((c) => c.ok).map((c) => c.name),
    source: "loop",
    ...(author !== undefined ? { author } : {}),
  };

  // ---- Step 5: dry-run short circuit ----
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

  // ---- Step 6: append + atomic write (shared helper) ----
  await writeEventFile(cwd, event);

  return {
    kind: "done",
    task_id: taskId,
    phase_id: phaseId,
    agent: agentName,
    event,
    verify: { ok: true, checks: verifyResult.checks },
  };
}
