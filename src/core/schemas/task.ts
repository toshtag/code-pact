import { z } from "zod";

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
  id: z.string().min(1),
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
});
export type Task = z.infer<typeof Task>;
