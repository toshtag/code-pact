import { z } from "zod";

// PhaseRef is a lightweight pointer stored in roadmap.yaml.
// total_weight is NOT stored here; it is derived from phase refs at runtime.
export const PhaseRef = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  weight: z.number().positive(),
});
export type PhaseRef = z.infer<typeof PhaseRef>;

export const Roadmap = z.object({
  phases: z.array(PhaseRef),
});
export type Roadmap = z.infer<typeof Roadmap>;
