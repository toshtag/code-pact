import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Project } from "../core/schemas/project.ts";
import { Roadmap } from "../core/schemas/roadmap.ts";
import { Phase } from "../core/schemas/phase.ts";
import type { ProgressEvent } from "../core/schemas/progress-event.ts";
import { appendEvent, loadProgressLog } from "../core/progress/io.ts";
import {
  assertTransition,
  deriveTaskState,
} from "../core/progress/task-state.ts";

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

async function resolveTaskPhase(cwd: string, taskId: string): Promise<string> {
  const roadmapRaw = await readFile(join(cwd, "design", "roadmap.yaml"), "utf8");
  const roadmap = Roadmap.parse(parseYaml(roadmapRaw) as unknown);

  const hits: string[] = [];
  for (const ref of roadmap.phases) {
    const phaseRaw = await readFile(join(cwd, ref.path), "utf8");
    const phase = Phase.parse(parseYaml(phaseRaw) as unknown);
    if (phase.tasks?.some((t) => t.id === taskId)) {
      hits.push(phase.id);
    }
  }

  if (hits.length === 0) {
    const err = new Error(`Task "${taskId}" not found in any phase.`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }
  if (hits.length > 1) {
    const err = new Error(
      `Task "${taskId}" exists in multiple phases: ${hits.join(", ")}`,
    );
    (err as NodeJS.ErrnoException).code = "AMBIGUOUS_TASK_ID";
    (err as NodeJS.ErrnoException & { phases?: string[] }).phases = hits;
    throw err;
  }
  return hits[0]!;
}

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

  const phaseId = await resolveTaskPhase(cwd, taskId);

  const { log } = await loadProgressLog(cwd);
  const state = deriveTaskState(log.events, taskId);
  assertTransition(state.current, "resumed");

  const event: ProgressEvent = {
    task_id: taskId,
    status: "resumed",
    at: now().toISOString(),
    actor: "agent",
    agent: agentName,
  };

  await appendEvent(cwd, event);

  return {
    kind: "resumed",
    task_id: taskId,
    phase_id: phaseId,
    agent: agentName,
    event,
  };
}
