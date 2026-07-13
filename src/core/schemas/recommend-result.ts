import { z } from "zod";
import { ModelTier, EffortLevel } from "./model-profile.ts";
import { STANDARD_CONTEXT_BUDGET_PROFILE_NAMES } from "../context-fit/budget-profiles.ts";

// ---------------------------------------------------------------------------
// Budgeted Execution / Context Budgeting — recommend output contract
//
// Strictly additive. Existing fields (phaseId / taskId / agentName /
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

// The recommended lifecycle for this task — which loop an agent should run.
// Advisory only; code-pact's own loop behavior is unchanged.
export const LifecycleMode = z.enum(["full_loop", "record_only", "decision_loop"]);
export type LifecycleMode = z.infer<typeof LifecycleMode>;

export const RepairDisabledReasonCode = z.enum([
  "decision_loop",
  "record_only",
  "architecture",
  "high_ambiguity",
  "high_risk",
  "high_write_surface",
  "weak_verification",
]);
export type RepairDisabledReasonCode = z.infer<
  typeof RepairDisabledReasonCode
>;

export const RepairPolicy = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("disabled"),
      reasonCode: RepairDisabledReasonCode,
    })
    .strict(),
  z
    .object({
      mode: z.literal("bounded"),
      maxRepairAttempts: z.literal(1),
      retryableFailureKinds: z.tuple([
        z.literal("command_failed"),
      ]),
      nonRetryableFailureKinds: z.tuple([
        z.literal("timed_out"),
        z.literal("aborted"),
        z.literal("decision_required"),
        z.literal("unsafe_write"),
        z.literal("invalid_state"),
        z.literal("unknown"),
      ]),
      retryContext: z.literal("failure_delta"),
      firstRetry: z.literal(
        "same_model_same_effort_same_context",
      ),
      stopOnRepeatedFingerprint: z.literal(true),
      afterExhaustion: z.literal("use_allowed_escalation"),
    })
    .strict(),
]);
export type RepairPolicy = z.infer<typeof RepairPolicy>;

// An optional, recommended standard context budget
// profile, derived deterministically from existing task readiness fields. This
// is a SUGGESTION the agent/user may apply via `--context-budget <profile>`; it
// is NOT auto-applied and does NOT change the default no-flag context pack.
//
// `recommendedProfile` is a CLOSED enum of the three standard names — recommend
// only ever speaks the standard vocabulary. Custom agent-profile profile names
// live only in layer (a)'s `--context-budget` resolution namespace; they are
// never emitted here. `recommendedBudgetBytes` resolves agent-profile same-name
// override first, then the built-in fallback. It is unrelated to the categorical
// `budgetProfile` (tool-call / context-file / verification estimate) and does
// not overload it.
//
// The enum is derived from the SINGLE source of truth for the standard profile
// names (budget-profiles.ts), so the schema and the pure mapping helper
// (src/core/recommend/context-fit.ts, which types `recommendedProfile` via the
// same constant's keys) can never silently diverge — adding a standard profile
// in one place widens both. This mirrors how budget.ts / lifecycle.ts derive
// their enums once.
export const ContextFitRecommendation = z
  .object({
    recommendedProfile: z.enum(STANDARD_CONTEXT_BUDGET_PROFILE_NAMES),
    recommendedBudgetBytes: z.number().int().positive(),
    reason: z.string().min(1),
  })
  .strict();
export type ContextFitRecommendation = z.infer<typeof ContextFitRecommendation>;

export const RecommendResultV2 = z
  .object({
    // base fields — UNCHANGED
    phaseId: z.string().min(1),
    taskId: z.string().min(1),
    agentName: z.string().min(1),
    tier: ModelTier,
    effort: EffortLevel,
    modelId: z.string().min(1),
    reasons: z.array(z.string().min(1)).min(1),

    // strictly additive
    contextProfile: ContextProfile,
    verificationProfile: VerificationProfile,
    planningRequired: z.boolean(),
    ambiguityAction: AmbiguityAction,
    allowedEscalation: z.array(EscalationStep).min(1),
    preflight: z.array(PreflightEntry).max(3),
    budgetProfile: BudgetProfile,
    structuredReasons: z.array(StructuredReason).min(1),

    // strictly additive
    lifecycleMode: LifecycleMode,
    repairPolicy: RepairPolicy,

    // OPTIONAL strictly-additive. Absent on `recommendation: null`
    // early-return states and unaffected on existing V2 fixtures/consumers.
    contextFit: ContextFitRecommendation.optional(),
  })
  .strict();
export type RecommendResultV2 = z.infer<typeof RecommendResultV2>;
