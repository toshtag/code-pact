import { z } from "zod";
import { ModelTier } from "./model-profile.ts";

export const AgentProfile = z.object({
  name: z.string().min(1),
  instruction_filename: z.string().min(1),
  context_dir: z.string().min(1),
  skill_dir: z.string().optional(),
  hook_dir: z.string().optional(),
  // Maps abstract model tiers to concrete vendor model IDs.
  // Keeping the mapping here, not in core schema, means the core stays
  // vendor-agnostic and model names can be bumped without touching phases.
  model_map: z.object({
    highest_reasoning: z.string().min(1).optional(),
    balanced_coding: z.string().min(1).optional(),
    cheap_mechanical: z.string().min(1).optional(),
  }),
});
export type AgentProfile = z.infer<typeof AgentProfile>;
