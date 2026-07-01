import { z } from "zod";
import { RelativePosixPath } from "./relative-path.ts";

export const PhasePath = RelativePosixPath.refine(
  value => value.startsWith("design/phases/"),
  "phase path must be under design/phases/",
)
  .refine(value => value.endsWith(".yaml"), "phase path must end with .yaml")
  .refine(
    value => value !== "design/phases/.yaml",
    "phase path must name a file",
  );

export type PhasePath = z.infer<typeof PhasePath>;

export function isPhasePath(value: string): boolean {
  return PhasePath.safeParse(value).success;
}
