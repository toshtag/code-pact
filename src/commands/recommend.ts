import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentProfile } from "../core/schemas/agent-profile.ts";
import { Phase } from "../core/schemas/phase.ts";
import { loadRoadmap } from "../core/plan/roadmap.ts";
import type { Task } from "../core/schemas/task.ts";
import { assertSafePlanId } from "../core/schemas/plan-id.ts";
import { resolveAgentProfilePath } from "../core/agent-profile-path.ts";
import {
  resolveRecommendation,
  type RecommendResult,
} from "../core/recommend/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecommendOptions = {
  cwd: string;
  phaseId: string;
  taskId: string;
  agentName: string;
};

export type { RecommendResult };

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadPhase(cwd: string, path: string): Promise<Phase> {
  const raw = await readFile(join(cwd, path), "utf8");
  return Phase.parse(parseYaml(raw) as unknown);
}

async function loadAgentProfile(cwd: string, agentName: string): Promise<AgentProfile> {
  // `agentName` (raw `--agent`) can become a path segment; reject unsafe names
  // up front. (resolveAgentProfilePath also validates, so this is defence in
  // depth — the resolver is the single source for the path.)
  assertSafePlanId(agentName, "Agent");
  const path = await resolveAgentProfilePath(cwd, agentName);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    const err = new Error(`Agent profile for "${agentName}" not found.`);
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }
  // A malformed profile — including an explicitly-configured but invalid P47
  // `context_budget` block, which P48 now reads to resolve the contextFit byte
  // override — surfaces as CONFIG_ERROR rather than an unclassified YAML/Zod
  // throw, mirroring task-prepare.ts so `recommend` renders a clean envelope.
  try {
    return AgentProfile.parse(parseYaml(raw) as unknown);
  } catch (cause) {
    const err = new Error(
      `Agent profile for "${agentName}" is invalid: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runRecommend(opts: RecommendOptions): Promise<RecommendResult> {
  const { cwd, phaseId, taskId, agentName } = opts;

  const roadmap = await loadRoadmap(cwd);
  const ref = roadmap.phases.find((p) => p.id === phaseId);
  if (!ref) {
    const err = new Error(`Phase "${phaseId}" not found in roadmap.yaml.`);
    (err as NodeJS.ErrnoException).code = "PHASE_NOT_FOUND";
    throw err;
  }

  const [phase, agentProfile] = await Promise.all([
    loadPhase(cwd, ref.path),
    loadAgentProfile(cwd, agentName),
  ]);

  const task: Task | undefined = phase.tasks?.find((t) => t.id === taskId);
  if (!task) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  return resolveRecommendation({
    phaseId,
    taskId,
    task,
    agentName,
    agentProfile,
    decisionContext: { phaseRequiresDecision: phase.requires_decision === true },
  });
}

// ---------------------------------------------------------------------------
// Human-readable formatter
// ---------------------------------------------------------------------------

function yesNo(b: boolean): string {
  return b ? "yes" : "no";
}

function formatPreflight(entries: RecommendResult["preflight"]): string {
  if (entries.length === 0) return "Preflight: (none)";
  const lines = ["Preflight:"];
  for (const e of entries) {
    lines.push(`  - ${e.displayCommand}  (reason: ${e.reason})`);
  }
  return lines.join("\n");
}

export function formatRecommend(r: RecommendResult): string {
  const sections: string[] = [];

  sections.push(
    [
      `Task:    ${r.phaseId} / ${r.taskId}`,
      `Agent:   ${r.agentName}`,
      `Tier:    ${r.tier}`,
      `Model:   ${r.modelId}`,
      `Effort:  ${r.effort}`,
    ].join("\n"),
  );

  sections.push(["Reasons:", ...r.reasons.map((reason) => `  - ${reason}`)].join("\n"));

  sections.push(`Lifecycle: ${r.lifecycleMode}`);

  sections.push(
    [
      `Planning:`,
      `  Required:         ${yesNo(r.planningRequired)}`,
      `  Ambiguity action: ${r.ambiguityAction}`,
      `  Context profile:  ${r.contextProfile}`,
      `  Verification:     ${r.verificationProfile}`,
    ].join("\n"),
  );

  sections.push(
    [`Escalation:`, ...r.allowedEscalation.map((step, i) => `  ${i + 1}. ${step}`)].join("\n"),
  );

  sections.push(formatPreflight(r.preflight));

  sections.push(
    [
      `Budget:`,
      `  Tool calls:            ${r.budgetProfile.toolCalls}`,
      `  Context files:         ${r.budgetProfile.contextFiles}`,
      `  Verification commands: ${r.budgetProfile.verificationCommands}`,
    ].join("\n"),
  );

  // P48 — recommended (not applied) context budget. Worded to make clear this is
  // a suggestion; applying it stays explicit via `--context-budget <profile>`.
  if (r.contextFit) {
    sections.push(
      `Context fit: recommended context budget ${r.contextFit.recommendedProfile} ` +
        `(${r.contextFit.recommendedBudgetBytes} bytes) — ${r.contextFit.reason}`,
    );
  }

  return sections.join("\n\n");
}
