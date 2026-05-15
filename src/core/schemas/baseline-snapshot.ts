import { z } from "zod";
import { PhaseRef } from "./roadmap.ts";

export const BaselineSnapshot = z.object({
  name: z.string().min(1),
  created_at: z.iso.datetime({ offset: true }),
  total_weight: z.number().nonnegative(),
  phases: z.array(PhaseRef),
});
export type BaselineSnapshot = z.infer<typeof BaselineSnapshot>;
