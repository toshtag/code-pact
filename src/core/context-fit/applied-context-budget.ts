import { z } from "zod";
import {
  STANDARD_CONTEXT_BUDGET_PROFILE_NAMES,
  type StandardContextBudgetProfile,
} from "./budget-profiles.ts";
import {
  resolveContextBudgetProfile,
  type ContextBudgetConfig,
} from "./resolve-budget-profile.ts";
import type { ContextFitRecommendation } from "../schemas/recommend-result.ts";

export type TaskPrepareBudgetSelection =
  | { kind: "none" }
  | { kind: "explicit_bytes"; budgetBytes: number }
  | { kind: "explicit_profile"; profileName: string }
  | { kind: "recommended_cli" };

const StandardProfile = z.enum(STANDARD_CONTEXT_BUDGET_PROFILE_NAMES);

export const AppliedContextBudget = z.discriminatedUnion("source", [
  z.object({ source: z.literal("none") }).strict(),
  z
    .object({
      source: z.literal("explicit_bytes"),
      budget_bytes: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      source: z.literal("explicit_profile"),
      profile: z.string().min(1),
      budget_bytes: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      source: z.literal("recommended_cli"),
      profile: StandardProfile,
      budget_bytes: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      source: z.literal("recommended_agent_profile"),
      profile: StandardProfile,
      budget_bytes: z.number().int().positive(),
    })
    .strict(),
]);
export type AppliedContextBudget = z.infer<typeof AppliedContextBudget>;

export type ResolveAppliedContextBudgetInput = {
  selection: TaskPrepareBudgetSelection;
  agentName: string;
  contextBudget?: ContextBudgetConfig | undefined;
  recommendation: {
    contextFit?: ContextFitRecommendation | undefined;
  };
};

function recommendedAppliedContextBudget(
  source: "recommended_cli" | "recommended_agent_profile",
  contextFit: ContextFitRecommendation | undefined,
): AppliedContextBudget {
  if (contextFit === undefined) {
    const err = new Error("task prepare recommendation is missing contextFit.");
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }
  return {
    source,
    profile: contextFit.recommendedProfile as StandardContextBudgetProfile,
    budget_bytes: contextFit.recommendedBudgetBytes,
  };
}

export function resolveAppliedContextBudget(
  input: ResolveAppliedContextBudgetInput,
): AppliedContextBudget {
  const { selection, agentName, contextBudget, recommendation } = input;
  switch (selection.kind) {
    case "none":
      if (contextBudget?.application_mode === "recommended") {
        return recommendedAppliedContextBudget(
          "recommended_agent_profile",
          recommendation.contextFit,
        );
      }
      return { source: "none" };
    case "explicit_bytes":
      return {
        source: "explicit_bytes",
        budget_bytes: selection.budgetBytes,
      };
    case "explicit_profile":
      return {
        source: "explicit_profile",
        profile: selection.profileName,
        budget_bytes: resolveContextBudgetProfile({
          profileName: selection.profileName,
          contextBudget,
          agentName,
        }),
      };
    case "recommended_cli":
      return recommendedAppliedContextBudget(
        "recommended_cli",
        recommendation.contextFit,
      );
  }
}

export function appliedBudgetBytes(
  applied: AppliedContextBudget,
): number | undefined {
  return applied.source === "none" ? undefined : applied.budget_bytes;
}
