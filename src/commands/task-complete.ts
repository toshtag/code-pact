import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Project } from "../core/schemas/project.ts";
import type { ProgressEvent } from "../core/schemas/progress-event.ts";
import { loadProgressLog } from "../core/progress/io.ts";
import { writeEventFile } from "../core/progress/events-io.ts";
import { deriveTaskState } from "../core/progress/task-state.ts";
import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";
import { runVerify, type CheckResult } from "./verify.ts";

export type TaskCompleteOptions = {
  cwd: string;
  taskId: string;
  /** Optional. When omitted, project.yaml's default_agent is used. */
  agent?: string;
  /** When true, do not modify progress.yaml. */
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

async function loadProject(cwd: string): Promise<Project> {
  const raw = await readFile(join(cwd, ".code-pact", "project.yaml"), "utf8");
  return Project.parse(parseYaml(raw) as unknown);
}

export async function runTaskComplete(
  opts: TaskCompleteOptions,
): Promise<TaskCompleteResult> {
  const { cwd, taskId } = opts;
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? (() => new Date());

  // ---- Step 0: agent validation (same order as task context) ----
  const project = await loadProject(cwd);
  const agentName = opts.agent ?? project.default_agent;
  const ref = project.agents.find((a) => a.name === agentName);
  if (!ref) {
    const err = new Error(`Agent "${agentName}" is not configured in project.yaml.`);
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }
  if (ref.enabled === false) {
    const err = new Error(
      `Agent "${agentName}" is disabled in project.yaml (enabled: false).`,
    );
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_ENABLED";
    throw err;
  }

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
  // planned→done is permitted at the command layer for v0.5 compatibility;
  // assertTransition rejects it, so we intentionally do not call that here.

  // ---- Step 3: run verify in preflight mode ----
  // skipConsistencyChecks: true skips the progress_event + task_status
  // checks that task complete is itself about to produce. The remaining
  // checks (commands, decision) are the deterministic preconditions.
  const verifyResult = await runVerify({
    cwd,
    phaseId,
    taskId,
    dryRun: false,
    skipConsistencyChecks: true,
  });

  if (!verifyResult.ok) {
    // Surface verify result without touching progress.yaml.
    const err = new Error(
      `Verification failed for "${taskId}". progress.yaml was not modified.`,
    );
    (err as NodeJS.ErrnoException).code = "VERIFICATION_FAILED";
    (err as NodeJS.ErrnoException & { checks?: CheckResult[] }).checks =
      verifyResult.checks;
    throw err;
  }

  // ---- Step 4: build the done event ----
  const event: ProgressEvent = {
    task_id: taskId,
    status: "done",
    at: now().toISOString(),
    actor: "agent",
    agent: agentName,
    evidence: verifyResult.checks.filter((c) => c.ok).map((c) => c.name),
    source: "loop",
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
