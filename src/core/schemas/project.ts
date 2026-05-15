import { z } from "zod";
import { LocaleConfig } from "./locale.ts";

export const AgentRef = z.object({
  name: z.string().min(1),
  profile: z.string().min(1),
});
export type AgentRef = z.infer<typeof AgentRef>;

export const Project = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  locale: LocaleConfig,
  default_agent: z.string().min(1),
  agents: z.array(AgentRef).min(1),
});
export type Project = z.infer<typeof Project>;
