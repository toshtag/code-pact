import { z } from "zod";
import { Task } from "./task.ts";

export const PhaseStatus = z.enum(["planned", "in_progress", "done", "cancelled"]);
export const ConfidenceLevel = z.enum(["low", "medium", "high"]);

export const PhaseVerification = z.object({
  commands: z.array(z.string().min(1)).min(1),
});

export const Phase = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  weight: z.number().positive(),
  confidence: ConfidenceLevel,
  risk: z.enum(["low", "medium", "high"]),
  status: PhaseStatus,
  objective: z.string().min(1),
  non_goals: z.array(z.string()).optional(),
  definition_of_done: z.array(z.string().min(1)).min(1),
  verification: PhaseVerification,
  requires_decision: z.boolean().optional(),
  tasks: z.array(Task).optional(),
});
export type Phase = z.infer<typeof Phase>;
