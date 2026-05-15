import type { Task } from "../schemas/task.ts";
import type { ModelTier } from "../schemas/model-profile.ts";

// ---------------------------------------------------------------------------
// Rule-based tier recommendation
//
// Decision tree (evaluated in priority order):
//
// 1. highest_reasoning — any of:
//    - type is "architecture"
//    - ambiguity is "high"
//    - verification_strength is "weak"  (weak verification → need stronger reasoning)
//    - risk is "high" AND ambiguity is "medium"
//
// 2. cheap_mechanical — all of:
//    - type is "docs", "formatting", or "mechanical_refactor"
//    - ambiguity is "low"
//    - risk is "low"
//    - verification_strength is "medium" or "strong"
//
// 3. balanced_coding — everything else
// ---------------------------------------------------------------------------

export type TierRecommendation = {
  tier: ModelTier;
  /** Effort level hint for the recommended tier */
  effort: "low" | "medium" | "high";
  reasons: string[];
};

const CHEAP_TYPES = new Set<string>(["docs", "formatting", "mechanical_refactor"]);

export function recommendTier(task: Task): TierRecommendation {
  const reasons: string[] = [];

  // --- highest_reasoning ---
  if (task.type === "architecture") {
    reasons.push("task type is architecture");
  }
  if (task.ambiguity === "high") {
    reasons.push("ambiguity is high");
  }
  if (task.verification_strength === "weak") {
    reasons.push("verification strength is weak — reasoning helps compensate");
  }
  if (task.risk === "high" && task.ambiguity === "medium") {
    reasons.push("high risk with medium ambiguity");
  }

  if (reasons.length > 0) {
    return {
      tier: "highest_reasoning",
      effort: effortForReasoning(task),
      reasons,
    };
  }

  // --- cheap_mechanical ---
  if (
    CHEAP_TYPES.has(task.type) &&
    task.ambiguity === "low" &&
    task.risk === "low" &&
    task.verification_strength !== "weak"
  ) {
    return {
      tier: "cheap_mechanical",
      effort: "low",
      reasons: [`task type is ${task.type} with low ambiguity and low risk`],
    };
  }

  // --- balanced_coding ---
  return {
    tier: "balanced_coding",
    effort: effortForBalanced(task),
    reasons: ["default tier for standard feature/refactor/bugfix work"],
  };
}

function effortForReasoning(task: Task): "low" | "medium" | "high" {
  // Longer or larger-context tasks warrant higher effort
  if (task.expected_duration === "long" || task.context_size === "large") return "high";
  if (task.expected_duration === "medium" || task.context_size === "medium") return "medium";
  return "medium"; // reasoning tasks default to medium minimum
}

function effortForBalanced(task: Task): "low" | "medium" | "high" {
  if (task.expected_duration === "long" || task.write_surface === "high") return "high";
  if (task.expected_duration === "short" && task.write_surface === "low") return "low";
  return "medium";
}
