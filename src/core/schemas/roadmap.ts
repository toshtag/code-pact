import { z } from "zod";
import { RelativePosixPath } from "./relative-path.ts";

// PhaseRef is a lightweight pointer stored in roadmap.yaml.
// total_weight is NOT stored here; it is derived from phase refs at runtime.
export const PhaseRef = z.object({
  id: z.string().min(1),
  path: RelativePosixPath
    .refine(
      (s) => s.startsWith("design/phases/"),
      "phase path must be under design/phases/",
    )
    .refine((s) => s.endsWith(".yaml"), "phase path must end with .yaml")
    .refine((s) => s !== "design/phases/.yaml", "phase path must name a file"),
  weight: z.number().positive(),
});
export type PhaseRef = z.infer<typeof PhaseRef>;

export const Roadmap = z.object({
  phases: z.array(PhaseRef),
});
export type Roadmap = z.infer<typeof Roadmap>;
