import { z } from "zod";
import { Task } from "./task.ts";

// Input schema for `code-pact phase import <yaml>`.
//
// Shape: top-level `phases:` array. Each entry mirrors a Phase definition
// but with `verify_commands` / `definition_of_done` flattened to
// snake_case top-level fields (the same form the user writes in a draft
// roadmap YAML) and with `tasks[]` accepted directly so a roadmap +
// tasks can be bulk-imported in one call.
//
// All ConfidenceLevel / RiskLevel optionals default to "medium" inside
// runPhaseImport (not via zod default, so the raw shape stays honest).
export const PhaseImportEntry = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  weight: z.number().positive(),
  objective: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
  verify_commands: z.array(z.string().min(1)).min(1).optional(),
  definition_of_done: z.array(z.string().min(1)).min(1).optional(),
  non_goals: z.array(z.string().min(1)).optional(),
  requires_decision: z.boolean().optional(),
  tasks: z.array(Task).optional(),
});
export type PhaseImportEntry = z.infer<typeof PhaseImportEntry>;

export const PhaseImportInput = z.object({
  phases: z.array(PhaseImportEntry).min(1),
});
export type PhaseImportInput = z.infer<typeof PhaseImportInput>;
