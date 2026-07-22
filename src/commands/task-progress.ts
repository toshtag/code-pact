// The three progress-transition runners — `task start` / `block` / `resume`.
// They share the same preamble (resolve the agent, the task's phase, and its
// current state) and the same epilogue (build a ProgressEvent and append it to
// the ledger), but each keeps its own input validation, transition rule, and
// result shape. The two genuinely-identical mechanical halves live in
// `resolveProgressRuntime` / `appendProgressEvent`; the runners are NOT merged
// into one generic function — the transitions mean different things.

import { loadProject, resolveEnabledAgent } from "../core/project.ts";
import type { ProgressEvent } from "../core/schemas/progress-event.ts";
import { loadProgressLog } from "../core/progress/io.ts";
import { writeEventFile } from "../core/progress/events-io.ts";
import { resolveEventAuthor } from "../core/progress/author.ts";
import {
  assertTransition,
  deriveTaskState,
} from "../core/progress/task-state.ts";
import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";
import { loadPhase } from "../core/plan/load-phase.ts";
import {
  createTaskContractLock,
  readContractLock,
} from "../core/contract-lock.ts";
import { incompleteTaskDependencyIds } from "../core/task-dependencies.ts";

// Resolve the agent (against project.yaml), the task's phase, and its current
// derived state. Identical across the three runners; agent validation runs
// before task resolution so an invalid agent fails first.
async function resolveProgressRuntime(
  cwd: string,
  taskId: string,
  agent: string | undefined,
) {
  const project = await loadProject(cwd);
  const agentName = resolveEnabledAgent(project, agent);
  const { phaseId, phasePath } = await resolveTaskInRoadmap(cwd, taskId);
  const { log } = await loadProgressLog(cwd);
  const state = deriveTaskState(log.events, taskId);
  return { agentName, phaseId, phasePath, state, events: log.events };
}

// Build the ProgressEvent and append it. Field order
// (task_id, status, at, actor, agent, [reason], [author]) is preserved from the
// original per-runner literals — the event is serialized to the ledger, so the
// key order is observable.
async function appendProgressEvent(
  cwd: string,
  fields: {
    taskId: string;
    status: "started" | "blocked" | "resumed";
    agentName: string;
    now: () => Date;
    reason?: string;
  },
): Promise<ProgressEvent> {
  const author = await resolveEventAuthor(cwd);
  const event: ProgressEvent = {
    task_id: fields.taskId,
    status: fields.status,
    at: fields.now().toISOString(),
    actor: "agent",
    agent: fields.agentName,
    ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
    ...(author !== undefined ? { author } : {}),
  };
  await writeEventFile(cwd, event);
  return event;
}

// ---------------------------------------------------------------------------
// task start
// ---------------------------------------------------------------------------

export type TaskStartOptions = {
  cwd: string;
  taskId: string;
  /** Optional. When omitted, project.yaml's default_agent is used. */
  agent?: string;
  /** Date injection for tests. Defaults to new Date(). */
  now?: () => Date;
};

export type TaskStartResult =
  | {
      kind: "started";
      task_id: string;
      phase_id: string;
      agent: string;
      event: ProgressEvent;
    }
  | {
      kind: "already_started";
      task_id: string;
      phase_id: string;
      agent: string;
    };

export async function runTaskStart(
  opts: TaskStartOptions,
): Promise<TaskStartResult> {
  const { cwd, taskId } = opts;
  const now = opts.now ?? (() => new Date());

  const { agentName, phaseId, phasePath, state, events } =
    await resolveProgressRuntime(cwd, taskId, opts.agent);

  if (state.current === "started") {
    return {
      kind: "already_started",
      task_id: taskId,
      phase_id: phaseId,
      agent: agentName,
    };
  }

  assertTransition(state.current, "started");

  // Dependency gate: evaluated before any contract lock or progress write.
  const phase = await loadPhase(cwd, phasePath);
  const task = phase.tasks?.find(t => t.id === taskId);
  if (!task) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }
  const incompleteDeps = incompleteTaskDependencyIds(events, task);
  if (incompleteDeps.length > 0) {
    const err = new Error(
      `Task "${taskId}" cannot be started: dependencies are not done: ${incompleteDeps.join(", ")}.`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_DEPENDENCY_INCOMPLETE";
    (err as NodeJS.ErrnoException & { deps?: string[] }).deps = incompleteDeps;
    throw err;
  }

  const lock = await readContractLock(cwd, taskId);
  if (lock === null) {
    await createTaskContractLock({
      cwd,
      taskId,
      agent: agentName,
      author: await resolveEventAuthor(cwd),
      actor: "agent",
    });
  }

  const event = await appendProgressEvent(cwd, {
    taskId,
    status: "started",
    agentName,
    now,
  });

  return {
    kind: "started",
    task_id: taskId,
    phase_id: phaseId,
    agent: agentName,
    event,
  };
}

// ---------------------------------------------------------------------------
// task block
// ---------------------------------------------------------------------------

export type TaskBlockOptions = {
  cwd: string;
  taskId: string;
  reason: string;
  agent?: string;
  now?: () => Date;
};

export type TaskBlockResult = {
  kind: "blocked";
  task_id: string;
  phase_id: string;
  agent: string;
  event: ProgressEvent;
};

export async function runTaskBlock(
  opts: TaskBlockOptions,
): Promise<TaskBlockResult> {
  const { cwd, taskId, reason } = opts;
  const now = opts.now ?? (() => new Date());

  if (!reason || reason.trim().length === 0) {
    const err = new Error(
      "task block requires a non-empty --reason describing why the task is blocked.",
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }

  const { agentName, phaseId, state } = await resolveProgressRuntime(
    cwd,
    taskId,
    opts.agent,
  );
  assertTransition(state.current, "blocked");

  const event = await appendProgressEvent(cwd, {
    taskId,
    status: "blocked",
    agentName,
    now,
    reason,
  });

  return {
    kind: "blocked",
    task_id: taskId,
    phase_id: phaseId,
    agent: agentName,
    event,
  };
}

// ---------------------------------------------------------------------------
// task resume
// ---------------------------------------------------------------------------

export type TaskResumeOptions = {
  cwd: string;
  taskId: string;
  agent?: string;
  now?: () => Date;
};

export type TaskResumeResult = {
  kind: "resumed";
  task_id: string;
  phase_id: string;
  agent: string;
  event: ProgressEvent;
};

export async function runTaskResume(
  opts: TaskResumeOptions,
): Promise<TaskResumeResult> {
  const { cwd, taskId } = opts;
  const now = opts.now ?? (() => new Date());

  const { agentName, phaseId, state } = await resolveProgressRuntime(
    cwd,
    taskId,
    opts.agent,
  );
  assertTransition(state.current, "resumed");

  const event = await appendProgressEvent(cwd, {
    taskId,
    status: "resumed",
    agentName,
    now,
  });

  return {
    kind: "resumed",
    task_id: taskId,
    phase_id: phaseId,
    agent: agentName,
    event,
  };
}
