import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Project } from "../core/schemas/project.ts";
import { buildContextPack, type ContextPackResult } from "../core/pack/index.ts";
import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";

export type TaskContextOptions = {
  cwd: string;
  taskId: string;
  /** Optional. When omitted, project.yaml's default_agent is used. */
  agent?: string;
};

export type TaskContextResult = ContextPackResult;

async function loadProject(cwd: string): Promise<Project> {
  const raw = await readFile(join(cwd, ".code-pact", "project.yaml"), "utf8");
  return Project.parse(parseYaml(raw) as unknown);
}

export async function runTaskContext(opts: TaskContextOptions): Promise<TaskContextResult> {
  const { cwd, taskId } = opts;
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

  return buildContextPack({
    cwd,
    phaseId,
    taskId,
    agentName,
  });
}
