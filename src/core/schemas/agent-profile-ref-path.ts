import { z } from "zod";
import { RelativePosixPath } from "./relative-path.ts";

export const AgentProfileRefPath = RelativePosixPath.refine(
  value => value.startsWith("agent-profiles/") && value.endsWith(".yaml"),
  {
    message: "agent profile must be a YAML path below agent-profiles/",
  },
);
export type AgentProfileRefPath = z.infer<typeof AgentProfileRefPath>;
