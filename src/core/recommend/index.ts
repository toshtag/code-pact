import type { AgentProfile } from "../schemas/agent-profile.ts";
import type { ModelTier } from "../schemas/model-profile.ts";
import {
  RecommendResultV2,
  type RecommendResultV2 as RecommendResultV2Type,
  type StructuredReason,
} from "../schemas/recommend-result.ts";
import type { Task } from "../schemas/task.ts";
import { recommendBudgetProfile } from "./budget.ts";
import { recommendContextProfile } from "./context-profile.ts";
import { recommendEscalation } from "./escalation.ts";
import { isPlanningRequired, recommendAmbiguityAction } from "./planning.ts";
import { recommendPreflight } from "./preflight.ts";
import { recommendTier, type TierRecommendation } from "./tier.ts";
import { recommendLifecycleMode } from "./lifecycle.ts";
import { recommendContextFit } from "./context-fit.ts";
import {
  recommendRepairPolicy,
} from "./repair-policy.ts";

export type ResolveRecommendationOptions = {
  phaseId: string;
  taskId: string;
  task: Task;
  agentName: string;
  agentProfile: AgentProfile;
  /**
   * Decision context for the lifecycle recommendation. Meaning-closed rather
   * than a bare boolean so `requires_decision` stays an explicit control axis.
   * Defaults to `{ phaseRequiresDecision: false }` when omitted.
   */
  decisionContext?: { phaseRequiresDecision: boolean };
};

export type RecommendResult = RecommendResultV2Type;

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
    // Weak verification reflects in the budget (fewer verification commands to
    // lean on), NOT in tier escalation — see recommend/tier.ts.
    out.push({
      factor: "verification_strength",
      value: "weak",
      effect: "budgetProfile.verificationCommands=minimal",
    });
  }

  if (task.requires_decision === true) {
    out.push({
      factor: "requires_decision",
      value: "true",
      effect: "ambiguity_action=clarify_before_implementation",
    });
  }

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

  if (out.length === 0) {
    out.push({ factor: "defaults", value: "standard", effect: "tier=balanced_coding" });
  }

  return out;
}

/**
 * Pure recommendation resolver. Given an already-loaded task and agent
 * profile, compute the v2 recommendation envelope.
 *
 * No I/O: callers (the `code-pact recommend` CLI command and the
 * `code-pact task prepare` compound command) load the inputs and pass
 * them in.
 *
 * Earlier fields preserve their in-place semantics; newer fields (e.g.
 * `lifecycleMode`) are strictly additive. The existing
 * snapshot and JSON envelope tests, plus `RecommendResultV2.parse`, are the
 * contract.
 */
export function resolveRecommendation(
  opts: ResolveRecommendationOptions,
): RecommendResult {
  const { phaseId, taskId, task, agentName, agentProfile } = opts;
  const decisionContext = opts.decisionContext ?? { phaseRequiresDecision: false };

  const rec: TierRecommendation = recommendTier(task);
  const modelId = agentProfile.model_map[rec.tier] ?? rec.tier;
  const lifecycleMode = recommendLifecycleMode(
    task,
    decisionContext,
  );

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
    planningRequired: isPlanningRequired(task),
    ambiguityAction: recommendAmbiguityAction(task),
    allowedEscalation: recommendEscalation(rec.tier),
    preflight: recommendPreflight(task),
    budgetProfile: recommendBudgetProfile(task),
    structuredReasons: buildStructuredReasons(task, rec.tier),
    lifecycleMode,
    repairPolicy: recommendRepairPolicy(
      task,
      lifecycleMode,
    ),
    // Additive context budget recommendation. Reuses the already-loaded agent
    // profile's context_budget for the same-name byte override, so no extra
    // I/O. The recommendation stays advisory in `recommend`; `task prepare`
    // may apply this already-produced value only through explicit opt-in.
    contextFit: recommendContextFit({
      contextSize: task.context_size,
      ambiguity: task.ambiguity,
      writeSurface: task.write_surface,
      requiresDecision: task.requires_decision,
      agentContextBudgetProfiles: agentProfile.context_budget?.profiles,
    }),
  };

  return RecommendResultV2.parse(result);
}
