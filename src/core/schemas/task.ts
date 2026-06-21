import { z } from "zod";
import { PlanId } from "./plan-id.ts";
import { DecisionRefPath } from "./decision-ref.ts";

export const TaskType = z.enum([
  "architecture",
  "feature",
  "bugfix",
  "refactor",
  "docs",
  "test",
  "mechanical_refactor",
  "other",
]);

export const AmbiguityLevel = z.enum(["low", "medium", "high"]);
export const RiskLevel = z.enum(["low", "medium", "high"]);
export const ContextSize = z.enum(["small", "medium", "large"]);
export const WriteSurface = z.enum(["low", "medium", "high"]);
export const VerificationStrength = z.enum(["weak", "medium", "strong"]);
export const ExpectedDuration = z.enum(["short", "medium", "long"]);
export const TaskStatus = z.enum(["planned", "in_progress", "done", "cancelled"]);

export const Task = z.object({
  id: PlanId,
  type: TaskType,
  ambiguity: AmbiguityLevel,
  risk: RiskLevel,
  context_size: ContextSize,
  write_surface: WriteSurface,
  verification_strength: VerificationStrength,
  expected_duration: ExpectedDuration,
  status: TaskStatus,
  description: z.string().optional(),
  requires_decision: z.boolean().optional(),
  // Task Readiness Schema (additive, optional). This file declares
  // the shape only; the lint validation rules live in the plan-lint
  // detectors (TASK_DEPENDS_ON_*, TASK_READS_*, TASK_WRITES_*,
  // TASK_DECISION_REF_*, TASK_ACCEPTANCE_REF_*), not here.
  //
  // EXCEPTION — `decision_refs` carries a NAMESPACE contract enforced at
  // parse time (DecisionRefPath: design/decisions/**/*.md, README/PRUNED
  // excluded). It is NOT a lint-only advisory: a `decision_refs: [.env]`
  // value reaches the gate (lenient accept → release) and the context pack
  // (file body rendered). Hard-failing here stops it at YAML parse, BEFORE
  // any read; the gate/loader re-validate (multi-layer, never schema-only).
  // `acceptance_refs` keeps the loose shape ON PURPOSE — it routinely points
  // at docs / phase YAML, not just ADRs (see plan-lint path-fields).
  depends_on: z.array(z.string().min(1)).optional(),
  decision_refs: z.array(DecisionRefPath).optional(),
  reads: z.array(z.string().min(1)).optional(),
  writes: z.array(z.string().min(1)).optional(),
  acceptance_refs: z.array(z.string().min(1)).optional(),
});
export type Task = z.infer<typeof Task>;
