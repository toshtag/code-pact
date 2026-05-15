import { z } from "zod";

export const ModelTier = z.enum(["highest_reasoning", "balanced_coding", "cheap_mechanical"]);
export type ModelTier = z.infer<typeof ModelTier>;

export const EffortLevel = z.enum(["low", "medium", "high"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

export const TierPurpose = z.enum([
  "architecture",
  "high_ambiguity",
  "weak_verification",
  "feature",
  "refactor",
  "docs",
  "formatting",
  "bulk_edit",
]);

// Abstract tier definition. Concrete model IDs are mapped in AgentProfile.
export const ModelProfile = z.object({
  tier: ModelTier,
  purpose: z.array(TierPurpose).min(1),
  effort_levels: z.array(EffortLevel).min(1),
  supports_thinking: z.boolean(),
});
export type ModelProfile = z.infer<typeof ModelProfile>;
