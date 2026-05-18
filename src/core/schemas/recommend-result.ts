import { z } from "zod";
import { ModelTier, EffortLevel } from "./model-profile.ts";

// ---------------------------------------------------------------------------
// v0.8 Budgeted Execution / Context Budgeting — recommend output contract
//
// Strictly additive over v0.7. Existing fields (phaseId / taskId / agentName /
// tier / effort / modelId / reasons) are unchanged; new fields use camelCase to
// match existing JSON conventions. Enum *values* stay snake_case where they
// are identifiers (clarify_before_implementation, increase_context, ...).
//
// .strict() at the top level guards against accidental snake_case drift —
// adding e.g. `planning_required` next to `planningRequired` becomes an
// explicit error rather than a silent contract split.
// ---------------------------------------------------------------------------

export const ContextProfile = z.enum(["small", "medium", "large"]);
export type ContextProfile = z.infer<typeof ContextProfile>;

export const VerificationProfile = z.enum(["weak", "medium", "strong"]);
export type VerificationProfile = z.infer<typeof VerificationProfile>;

export const AmbiguityAction = z.enum([
  "proceed",
  "clarify_before_implementation",
  "split_recommended",
]);
export type AmbiguityAction = z.infer<typeof AmbiguityAction>;

export const EscalationStep = z.enum([
  "increase_context",
  "increase_effort",
  "escalate_tier",
  "ask_human",
]);
export type EscalationStep = z.infer<typeof EscalationStep>;

export const PreflightEntry = z
  .object({
    id: z.string().min(1),
    command: z.string().min(1),
    argv: z.array(z.string().min(1)).min(1),
    displayCommand: z.string().min(1),
    reason: z.string().min(1),
    required: z.boolean(),
  })
  .strict();
export type PreflightEntry = z.infer<typeof PreflightEntry>;

export const BudgetToolCalls = z.enum(["low", "medium", "high"]);
export type BudgetToolCalls = z.infer<typeof BudgetToolCalls>;

export const BudgetContextFiles = z.enum(["few", "several", "many"]);
export type BudgetContextFiles = z.infer<typeof BudgetContextFiles>;

export const BudgetVerificationCommands = z.enum(["minimal", "standard", "full"]);
export type BudgetVerificationCommands = z.infer<typeof BudgetVerificationCommands>;

// Deterministic categorical profile — NOT an estimate of tokens, cost, or time.
export const BudgetProfile = z
  .object({
    toolCalls: BudgetToolCalls,
    contextFiles: BudgetContextFiles,
    verificationCommands: BudgetVerificationCommands,
  })
  .strict();
export type BudgetProfile = z.infer<typeof BudgetProfile>;

export const StructuredReason = z
  .object({
    factor: z.string().min(1),
    value: z.string().min(1),
    effect: z.string().min(1),
  })
  .strict();
export type StructuredReason = z.infer<typeof StructuredReason>;

export const RecommendResultV2 = z
  .object({
    // existing v0.7 fields — UNCHANGED
    phaseId: z.string().min(1),
    taskId: z.string().min(1),
    agentName: z.string().min(1),
    tier: ModelTier,
    effort: EffortLevel,
    modelId: z.string().min(1),
    reasons: z.array(z.string().min(1)).min(1),

    // new in v0.8 — strictly additive
    contextProfile: ContextProfile,
    verificationProfile: VerificationProfile,
    planningRequired: z.boolean(),
    ambiguityAction: AmbiguityAction,
    allowedEscalation: z.array(EscalationStep).min(1),
    preflight: z.array(PreflightEntry).max(3),
    budgetProfile: BudgetProfile,
    structuredReasons: z.array(StructuredReason).min(1),
  })
  .strict();
export type RecommendResultV2 = z.infer<typeof RecommendResultV2>;
