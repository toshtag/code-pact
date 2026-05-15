import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Roadmap } from "../core/schemas/roadmap.ts";
import { Phase } from "../core/schemas/phase.ts";
import { AgentProfile } from "../core/schemas/agent-profile.ts";
import { recommendTier, type TierRecommendation } from "../core/recommend/tier.ts";
import type { Task } from "../core/schemas/task.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecommendOptions = {
  cwd: string;
  phaseId: string;
  taskId: string;
  agentName: string;
};

export type RecommendResult = {
  phaseId: string;
  taskId: string;
  agentName: string;
  tier: string;
  effort: string;
  modelId: string;
  reasons: string[];
};

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadRoadmap(cwd: string): Promise<Roadmap> {
  const raw = await readFile(join(cwd, "design", "roadmap.yaml"), "utf8");
  return Roadmap.parse(parseYaml(raw) as unknown);
}

async function loadPhase(cwd: string, path: string): Promise<Phase> {
  const raw = await readFile(join(cwd, path), "utf8");
  return Phase.parse(parseYaml(raw) as unknown);
}

async function loadAgentProfile(cwd: string, agentName: string): Promise<AgentProfile> {
  const path = join(cwd, ".code-pact", "agent-profiles", `${agentName}.yaml`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    const err = new Error(`Agent profile for "${agentName}" not found.`);
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }
  return AgentProfile.parse(parseYaml(raw) as unknown);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runRecommend(opts: RecommendOptions): Promise<RecommendResult> {
  const { cwd, phaseId, taskId, agentName } = opts;

  // Resolve phase
  const roadmap = await loadRoadmap(cwd);
  const ref = roadmap.phases.find((p) => p.id === phaseId);
  if (!ref) {
    const err = new Error(`Phase "${phaseId}" not found in roadmap.yaml.`);
    (err as NodeJS.ErrnoException).code = "PHASE_NOT_FOUND";
    throw err;
  }

  const [phase, profile] = await Promise.all([
    loadPhase(cwd, ref.path),
    loadAgentProfile(cwd, agentName),
  ]);

  // Resolve task
  const task: Task | undefined = phase.tasks?.find((t) => t.id === taskId);
  if (!task) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  // Recommend tier
  const rec: TierRecommendation = recommendTier(task);

  // Resolve concrete model ID from agent profile
  const modelId = profile.model_map[rec.tier] ?? rec.tier;

  return {
    phaseId,
    taskId,
    agentName,
    tier: rec.tier,
    effort: rec.effort,
    modelId,
    reasons: rec.reasons,
  };
}

// ---------------------------------------------------------------------------
// Human-readable formatter
// ---------------------------------------------------------------------------

export function formatRecommend(r: RecommendResult): string {
  return [
    `Task:    ${r.phaseId} / ${r.taskId}`,
    `Agent:   ${r.agentName}`,
    `Tier:    ${r.tier}`,
    `Model:   ${r.modelId}`,
    `Effort:  ${r.effort}`,
    ``,
    `Reasons:`,
    ...r.reasons.map((reason) => `  - ${reason}`),
  ].join("\n");
}
