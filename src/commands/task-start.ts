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

  // Agent validation (mirrors task complete order).
  const project = await loadProject(cwd);
  const agentName = resolveEnabledAgent(project, opts.agent);

  const { phaseId } = await resolveTaskInRoadmap(cwd, taskId);

  const { log } = await loadProgressLog(cwd);
  const state = deriveTaskState(log.events, taskId);

  if (state.current === "started") {
    return {
      kind: "already_started",
      task_id: taskId,
      phase_id: phaseId,
      agent: agentName,
    };
  }

  assertTransition(state.current, "started");

  const author = await resolveEventAuthor(cwd);
  const event: ProgressEvent = {
    task_id: taskId,
    status: "started",
    at: now().toISOString(),
    actor: "agent",
    agent: agentName,
    ...(author !== undefined ? { author } : {}),
  };

  await writeEventFile(cwd, event);

  return {
    kind: "started",
    task_id: taskId,
    phase_id: phaseId,
    agent: agentName,
    event,
  };
}
