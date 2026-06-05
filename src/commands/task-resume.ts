import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Project } from "../core/schemas/project.ts";
import type { ProgressEvent } from "../core/schemas/progress-event.ts";
import { loadProgressLog } from "../core/progress/io.ts";
import { writeEventFile } from "../core/progress/events-io.ts";
import { resolveEventAuthor } from "../core/progress/author.ts";
import {
  assertTransition,
  deriveTaskState,
} from "../core/progress/task-state.ts";
import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";

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

async function loadProject(cwd: string): Promise<Project> {
  const raw = await readFile(join(cwd, ".code-pact", "project.yaml"), "utf8");
  return Project.parse(parseYaml(raw) as unknown);
}

export async function runTaskResume(
  opts: TaskResumeOptions,
): Promise<TaskResumeResult> {
  const { cwd, taskId } = opts;
  const now = opts.now ?? (() => new Date());

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

  const { phaseId } = await resolveTaskInRoadmap(cwd, taskId);

  const { log } = await loadProgressLog(cwd);
  const state = deriveTaskState(log.events, taskId);
  assertTransition(state.current, "resumed");

  const author = await resolveEventAuthor(cwd);
  const event: ProgressEvent = {
    task_id: taskId,
    status: "resumed",
    at: now().toISOString(),
    actor: "agent",
    agent: agentName,
    ...(author !== undefined ? { author } : {}),
  };

  await writeEventFile(cwd, event);

  return {
    kind: "resumed",
    task_id: taskId,
    phase_id: phaseId,
    agent: agentName,
    event,
  };
}
