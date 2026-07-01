import { z } from "zod";
import { PlanId } from "./plan-id.ts";
import { PhasePath } from "./phase-path.ts";

// PhaseRef is a lightweight pointer stored in roadmap.yaml.
// total_weight is NOT stored here; it is derived from phase refs at runtime.
export const PhaseRef = z.object({
  id: PlanId,
  path: PhasePath,
  weight: z.number().positive(),
});
export type PhaseRef = z.infer<typeof PhaseRef>;

export const Roadmap = z.object({
  phases: z.array(PhaseRef),
});
export type Roadmap = z.infer<typeof Roadmap>;
