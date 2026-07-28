import { z } from "zod";

// ---------------------------------------------------------------------------
// Review contract schema (P90)
//
// A review contract is the task's declared REVIEW BOUNDARY, recorded before the
// task is locked: which layers of the change are in scope, which operating
// systems must be proven, and what evidence is planned. It is a DECLARATION,
// not proof — later P90 tasks verify that the declared evidence and the required
// external CI actually ran. See docs/review-contract.md.
//
// Three layers, kept apart on purpose:
//
//   - THIS FILE is the SHAPE: field types, enums, and unknown-key rejection.
//   - `src/core/review-contract.ts` is the SEMANTIC validator — every rule that
//     depends on the surrounding task (minimal-mode eligibility, the exact
//     stage/platform sets, ref coverage). Plan lint, `task add`, `task lock`,
//     and `task start` all share it, so their verdict on a SUPPLIED contract
//     cannot drift apart.
//   - Enforcing that a contract EXISTS at all is neither of the above. It is
//     not part of this stage: absence is a plan-lint advisory today and becomes
//     a policy-gated refusal in P90-T0B.
//
// Unknown keys are rejected on every object. A mistyped key must fail loudly at
// parse time rather than being silently stripped and leaving the contract
// looking complete while it silently declares less than the author wrote.
// ---------------------------------------------------------------------------

/** `minimal` is the restricted form for genuinely low-risk work; `boundary` is
 *  the full producer→consumer→runner→OS→security declaration. */
export const ReviewContractMode = z.enum(["minimal", "boundary"]);
export type ReviewContractMode = z.infer<typeof ReviewContractMode>;

/** The five layers a boundary contract must dispose of, in review order. */
export const BoundaryStage = z.enum([
  "producer",
  "consumer",
  "runner",
  "os",
  "security",
]);
export type BoundaryStage = z.infer<typeof BoundaryStage>;

export const BoundaryDisposition = z.enum(["in_scope", "not_applicable"]);
export type BoundaryDisposition = z.infer<typeof BoundaryDisposition>;

export const ReviewPlatform = z.enum(["linux", "macos", "windows"]);
export type ReviewPlatform = z.infer<typeof ReviewPlatform>;

export const PlatformDisposition = z.enum(["required", "not_required"]);
export type PlatformDisposition = z.infer<typeof PlatformDisposition>;

/**
 * How strong a piece of evidence is.
 *
 * - `unit` — an in-process assertion over a pure function or a mocked boundary.
 * - `integration` — real components wired together on the running platform.
 * - `actual_platform` — executed on the real operating system being claimed,
 *   not emulated or simulated by a mock.
 */
export const EvidenceLevel = z.enum(["unit", "integration", "actual_platform"]);
export type EvidenceLevel = z.infer<typeof EvidenceLevel>;

export const ReviewContractStage = z
  .object({
    stage: BoundaryStage,
    disposition: BoundaryDisposition,
    /** Required when `in_scope`: what this layer is asserted to do. */
    claim: z.string().optional(),
    /** Required when `not_applicable`: why the layer cannot be affected. */
    rationale: z.string().optional(),
    /** Required when `in_scope`, and must be empty when `not_applicable`. */
    refs: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ReviewContractStage = z.infer<typeof ReviewContractStage>;

export const ReviewContractPlatform = z
  .object({
    platform: ReviewPlatform,
    disposition: PlatformDisposition,
    /** Required when `required`: how strong the proof on this platform must be. */
    level: EvidenceLevel.optional(),
    /** Required when `not_required`: why this platform cannot be affected. */
    rationale: z.string().optional(),
    /** Required when `required`, and must be empty when `not_required`. */
    refs: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ReviewContractPlatform = z.infer<typeof ReviewContractPlatform>;

export const ReviewContractEvidence = z
  .object({
    /** Unique within the task; names the proof so later tasks can match it. */
    id: z.string().min(1),
    claim: z.string().optional(),
    level: EvidenceLevel,
    /** Required when `level` is `actual_platform`. */
    platform: ReviewPlatform.optional(),
    refs: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ReviewContractEvidence = z.infer<typeof ReviewContractEvidence>;

export const ReviewContract = z
  .object({
    version: z.literal(1),
    mode: ReviewContractMode,
    /** Required in `minimal` mode: why the restricted form is honest here. */
    rationale: z.string().optional(),
    stages: z.array(ReviewContractStage).optional(),
    platforms: z.array(ReviewContractPlatform).optional(),
    evidence: z.array(ReviewContractEvidence).optional(),
  })
  .strict();
export type ReviewContract = z.infer<typeof ReviewContract>;
