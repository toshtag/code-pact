import { z } from "zod";
import { PlanId } from "./plan-id.ts";
import {
  TaskType,
  AmbiguityLevel,
  RiskLevel,
  ContextSize,
  WriteSurface,
  VerificationStrength,
  ExpectedDuration,
} from "./task.ts";
import { DecisionRefPath } from "./decision-ref.ts";
import { ReviewContract } from "./review-contract.ts";

/**
 * Strict, lossless task-registration spec.
 *
 * Every readiness field is required and must be explicit, including empty
 * arrays. Unknown keys are rejected so that agent-generated spec files cannot
 * silently drop or mistype fields (e.g. `depends_on`) and still parse.
 *
 * The `status` is pinned to `planned` because registration is always a new
 * task; historical states must use `phase import`.
 *
 * `review_contract` (P90) is the one OPTIONAL field, and it stays optional
 * through the advisory rollout. Spec files written before P90 exist on disk and
 * are re-parsed by `assertTaskContractCurrent` for every lock that stored a
 * `spec_path`; requiring the field would turn those historical locks into
 * permanent drift failures. Nothing enforces PRESENCE yet — P90-T0B introduces
 * the project-level policy that does.
 *
 * Losslessness still holds regardless: when a contract IS supplied it takes part
 * in the canonical registration JSON and the digest, so a spec that declares a
 * contract the phase task does not (or declares a different one) diverges.
 */
export const TaskRegistrationSpec = z
  .object({
    schema_version: z.literal(1),
    phase_id: PlanId,
    task: z
      .object({
        id: PlanId,
        type: TaskType,
        ambiguity: AmbiguityLevel,
        risk: RiskLevel,
        context_size: ContextSize,
        write_surface: WriteSurface,
        verification_strength: VerificationStrength,
        expected_duration: ExpectedDuration,
        status: z.literal("planned"),
        description: z.string(),
        requires_decision: z.boolean(),
        depends_on: z.array(z.string().min(1)),
        decision_refs: z.array(DecisionRefPath),
        reads: z.array(z.string().min(1)),
        writes: z.array(z.string().min(1)),
        acceptance_refs: z.array(z.string().min(1)),
        review_contract: ReviewContract.optional(),
      })
      .strict(),
  })
  .strict();

export type TaskRegistrationSpec = z.infer<typeof TaskRegistrationSpec>;
