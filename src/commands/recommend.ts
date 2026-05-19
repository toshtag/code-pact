import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Roadmap } from "../core/schemas/roadmap.ts";
import { Phase } from "../core/schemas/phase.ts";
import { AgentProfile } from "../core/schemas/agent-profile.ts";
import { recommendTier, type TierRecommendation } from "../core/recommend/tier.ts";
import { recommendContextProfile } from "../core/recommend/context-profile.ts";
import {
  isPlanningRequired,
  recommendAmbiguityAction,
} from "../core/recommend/planning.ts";
import { recommendEscalation } from "../core/recommend/escalation.ts";
import { recommendPreflight } from "../core/recommend/preflight.ts";
import { recommendBudgetProfile } from "../core/recommend/budget.ts";
import type { Task } from "../core/schemas/task.ts";
import type { ModelTier } from "../core/schemas/model-profile.ts";
import {
  RecommendResultV2,
  type RecommendResultV2 as RecommendResultV2Type,
  type StructuredReason,
} from "../core/schemas/recommend-result.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecommendOptions = {
  cwd: string;
  phaseId: string;
  taskId: string;
  agentName: string;
};

// v0.8 enriched contract. Aliased to RecommendResultV2 so the public type
// name stays stable across versions while the shape evolves.
export type RecommendResult = RecommendResultV2Type;

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
// Structured reasons — machine-readable mirror of `reasons[]`
//
// Each entry pairs ONE notable Task factor with ONE effect on the output.
// This is intentionally lighter than full re-derivation of every decision —
// agents that want machine-readable rationale read this, agents that want
// human strings read `reasons[]`.
// ---------------------------------------------------------------------------

function buildStructuredReasons(task: Task, tier: ModelTier): StructuredReason[] {
  const out: StructuredReason[] = [];

  if (task.type === "architecture") {
    out.push({ factor: "type", value: "architecture", effect: "tier=highest_reasoning" });
  }

  if (task.ambiguity === "high") {
    out.push({ factor: "ambiguity", value: "high", effect: "tier=highest_reasoning" });
  } else if (task.ambiguity === "medium") {
    out.push({ factor: "ambiguity", value: "medium", effect: "planning_required" });
  }

  if (task.risk === "high") {
    out.push({ factor: "risk", value: "high", effect: "planning_required" });
  }

  if (task.verification_strength === "weak") {
    out.push({
      factor: "verification_strength",
      value: "weak",
      effect: "tier=highest_reasoning",
    });
  }

  if (task.requires_decision === true) {
    out.push({
      factor: "requires_decision",
      value: "true",
      effect: "ambiguity_action=clarify_before_implementation",
    });
  }

  // split_recommended condition: long+high_surface+medium_ambiguity+non-high_risk.
  // (high ambiguity OR medium+high_risk would already have routed to clarify.)
  if (
    task.expected_duration === "long" &&
    task.write_surface === "high" &&
    task.ambiguity === "medium" &&
    task.risk !== "high"
  ) {
    out.push({
      factor: "duration+write_surface",
      value: "long+high",
      effect: "ambiguity_action=split_recommended",
    });
  }

  if (tier === "cheap_mechanical" && out.length === 0) {
    out.push({
      factor: "type+ambiguity+risk",
      value: `${task.type}+low+low`,
      effect: "tier=cheap_mechanical",
    });
  }

  // Schema requires at least one entry. Default reason mirrors the default tier.
  if (out.length === 0) {
    out.push({ factor: "defaults", value: "standard", effect: "tier=balanced_coding" });
  }

  return out;
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

  // Existing v0.7 decisions
  const rec: TierRecommendation = recommendTier(task);
  const modelId = profile.model_map[rec.tier] ?? rec.tier;

  // New v0.8 decisions
  const planningRequired = isPlanningRequired(task);
  const ambiguityAction = recommendAmbiguityAction(task);

  const result: RecommendResult = {
    phaseId,
    taskId,
    agentName,
    tier: rec.tier,
    effort: rec.effort,
    modelId,
    reasons: rec.reasons,
    contextProfile: recommendContextProfile(task),
    verificationProfile: task.verification_strength,
    planningRequired,
    ambiguityAction,
    allowedEscalation: recommendEscalation(rec.tier),
    preflight: recommendPreflight(task),
    budgetProfile: recommendBudgetProfile(task),
    structuredReasons: buildStructuredReasons(task, rec.tier),
  };

  // Enforce the contract before handing back to the CLI layer.
  return RecommendResultV2.parse(result);
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

  return sections.join("\n\n");
}
