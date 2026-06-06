// Pure, deterministic recommendation of a standard context budget profile
// from existing task readiness fields. No I/O, no tokenizer, no network,
// no model/provider knowledge, no file inspection — a total function over
// a handful of categorical inputs.
//
// The recommendation is a SUGGESTION only. It is surfaced additively on
// `recommend` / `task prepare` and is never auto-applied: applying a profile
// stays explicit via `--context-budget <profile>`. The recommended bytes resolve
// an agent-profile same-name override first, then the built-in fallback; the
// recommended NAME is always one of the three standard profiles — custom
// agent-profile profile names are never emitted here.

import {
  STANDARD_CONTEXT_BUDGET_PROFILES,
  type StandardContextBudgetProfile,
} from "../context-fit/budget-profiles.ts";
import type { ContextFitRecommendation } from "../schemas/recommend-result.ts";

// The return type is the zod-inferred `ContextFitRecommendation` (re-exported
// for convenience), matching how budget.ts / lifecycle.ts import their return
// types from the schema rather than hand-rolling a parallel shape. The schema's
// `recommendedProfile` enum is itself derived from the same
// STANDARD_CONTEXT_BUDGET_PROFILE_NAMES tuple these names come from, so the two
// cannot drift.
export type { ContextFitRecommendation };

/**
 * The readiness signals that drive the recommendation, plus the optional
 * agent-profile `context_budget.profiles` map used to override the recommended
 * byte value for a same-named standard profile.
 *
 * `requiresDecision` is accepted for completeness but DELIBERATELY does not
 * shrink the recommendation — a gated task usually needs *more* context, not
 * less.
 */
export type RecommendContextFitInput = {
  contextSize: "small" | "medium" | "large";
  ambiguity: "low" | "medium" | "high";
  writeSurface: "low" | "medium" | "high";
  requiresDecision?: boolean;
  /**
   * The agent profile's `context_budget.profiles` block, when one is in play.
   * Only a same-named STANDARD profile entry is consulted (custom names never
   * change the recommendation). Omit for built-in fallback bytes.
   */
  agentContextBudgetProfiles?: Record<string, { max_bytes: number }>;
};

// ---------------------------------------------------------------------------
// Decision table — recommendedProfile
//
// | condition                                                   | profile  |
// | context_size=large OR ambiguity=high OR write_surface=high  | wide     |
// | context_size=medium (and not the wide case above)           | balanced |
// | otherwise (small + low/medium ambiguity + low/medium write) | tight    |
//
// requires_decision does NOT enter the mapping — it never shrinks the budget.
// ---------------------------------------------------------------------------

function mapProfile(
  input: RecommendContextFitInput,
): { profile: StandardContextBudgetProfile; signal: string } {
  if (input.contextSize === "large") {
    return { profile: "wide", signal: "context_size=large" };
  }
  if (input.ambiguity === "high") {
    return { profile: "wide", signal: "ambiguity=high" };
  }
  if (input.writeSurface === "high") {
    return { profile: "wide", signal: "write_surface=high" };
  }
  if (input.contextSize === "medium") {
    return { profile: "balanced", signal: "context_size=medium" };
  }
  return { profile: "tight", signal: "context_size=small" };
}

/**
 * Resolve a standard profile recommendation. Pure and total: every valid input
 * maps to exactly one of `tight | balanced | wide`. Byte resolution prefers an
 * agent-profile same-name override, then the built-in fallback; the `reason`
 * records the driving signal and which byte source was used.
 */
export function recommendContextFit(
  input: RecommendContextFitInput,
): ContextFitRecommendation {
  const { profile, signal } = mapProfile(input);

  // Resolve bytes and the source label together, from one branch, so the
  // `reason` can never misreport which source produced `recommendedBudgetBytes`.
  const override = input.agentContextBudgetProfiles?.[profile];
  const { recommendedBudgetBytes, byteSource } =
    override !== undefined
      ? { recommendedBudgetBytes: override.max_bytes, byteSource: "agent profile override" }
      : {
          recommendedBudgetBytes: STANDARD_CONTEXT_BUDGET_PROFILES[profile],
          byteSource: "built-in fallback",
        };

  return {
    recommendedProfile: profile,
    recommendedBudgetBytes,
    reason: `${signal} -> ${profile}; bytes from ${byteSource}`,
  };
}
