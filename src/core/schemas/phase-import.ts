import { z } from "zod";
import {
  TaskType,
  AmbiguityLevel,
  RiskLevel,
  ContextSize,
  WriteSurface,
  VerificationStrength,
  ExpectedDuration,
  TaskStatus,
} from "./task.ts";
import { PlanId } from "./plan-id.ts";
import { DecisionRefPath } from "./decision-ref.ts";

// Lenient task schema for imports. Only `id` is required; all detail
// fields have defaults applied by runPhaseImport() unless --strict is set.
// This lets AI-generated YAML (which often omits ambiguity/context_size
// etc.) be imported without manual field-filling.
export const TaskImport = z.object({
  // Imported (often AI-generated / external) ids flow into command strings and
  // path segments just like authored ids — same charset constraint applies.
  id: PlanId,
  description: z.string().optional(),
  type: TaskType.optional(),
  ambiguity: AmbiguityLevel.optional(),
  risk: RiskLevel.optional(),
  context_size: ContextSize.optional(),
  write_surface: WriteSurface.optional(),
  verification_strength: VerificationStrength.optional(),
  expected_duration: ExpectedDuration.optional(),
  status: TaskStatus.optional(),
  requires_decision: z.boolean().optional(),
  // Task Readiness Schema additions. All optional; forwarded
  // verbatim by applyTaskDefaults() without synthetic defaults so
  // absent == undefined == old behaviour.
  depends_on: z.array(z.string().min(1)).optional(),
  // Namespace contract enforced even on lenient import — an external/
  // AI-generated phase YAML is exactly the hostile-input path this guards.
  // See the Task schema note: design/decisions/*.md (top-level) only, multi-layer.
  decision_refs: z.array(DecisionRefPath).optional(),
  reads: z.array(z.string().min(1)).optional(),
  writes: z.array(z.string().min(1)).optional(),
  acceptance_refs: z.array(z.string().min(1)).optional(),
});
export type TaskImport = z.infer<typeof TaskImport>;

// Input schema for `code-pact phase import <yaml>`.
//
// Shape: top-level `phases:` array. Each entry mirrors a Phase definition
// but with `verify_commands` / `definition_of_done` flattened to
// snake_case top-level fields (the same form the user writes in a draft
// roadmap YAML) and with `tasks[]` accepted directly so a roadmap +
// tasks can be bulk-imported in one call.
//
// Tasks use TaskImport (lenient). runPhaseImport() applies defaults for
// any omitted fields unless --strict prevents it.
export const PhaseImportEntry = z.object({
  id: PlanId,
  name: z.string().min(1),
  weight: z.number().positive(),
  objective: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
  verify_commands: z.array(z.string().min(1)).min(1).optional(),
  definition_of_done: z.array(z.string().min(1)).min(1).optional(),
  non_goals: z.array(z.string().min(1)).optional(),
  requires_decision: z.boolean().optional(),
  tasks: z.array(TaskImport).optional(),
});
export type PhaseImportEntry = z.infer<typeof PhaseImportEntry>;

export const PhaseImportInput = z.object({
  phases: z.array(PhaseImportEntry).min(1),
});
export type PhaseImportInput = z.infer<typeof PhaseImportInput>;
