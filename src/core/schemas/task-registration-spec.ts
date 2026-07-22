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

/**
 * Strict, lossless task-registration spec.
 *
 * Every readiness field is required and must be explicit, including empty
 * arrays. Unknown keys are rejected so that agent-generated spec files cannot
 * silently drop or mistype fields (e.g. `depends_on`) and still parse.
 *
 * The `status` is pinned to `planned` because registration is always a new
 * task; historical states must use `phase import`.
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
      })
      .strict(),
  })
  .strict();

export type TaskRegistrationSpec = z.infer<typeof TaskRegistrationSpec>;
