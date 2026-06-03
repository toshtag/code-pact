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
  /**
   * When true, the returned ContextPackResult includes section-level
   * `sections` and `excluded` arrays plus the P49 `explainMetrics`
   * (natural / final / saved / minimum-achievable bytes + elided sections).
   * The rendered `content` string is byte-identical regardless of this flag.
   */
  explain?: boolean;
  /**
   * P24: upper bound on the rendered pack size in UTF-8 bytes. When
   * set, sections elide in the locked priority order until the bound
   * is met; throws `ContextOverBudgetError` when unachievable. The
   * no-flag default path is byte-identical to v1.12.
   */
  budgetBytes?: number;
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
    ...(opts.explain === true ? { explain: true as const } : {}),
    ...(opts.budgetBytes !== undefined ? { budgetBytes: opts.budgetBytes } : {}),
  });
}
