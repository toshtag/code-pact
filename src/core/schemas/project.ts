import { z } from "zod";
import { LocaleConfig } from "./locale.ts";
import { PlanId } from "./plan-id.ts";
import { RelativePosixPath } from "./relative-path.ts";

export const AgentRef = z.object({
  // Agent name flows into agent-facing command strings (`--agent <name>`) and
  // filesystem path segments (`agent-profiles/<name>.yaml`,
  // `.context/<name>/...`), so it shares the PlanId charset constraint.
  name: PlanId,
  // `profile` is read as `join(cwd, ".code-pact", profile)` (doctor), so it is
  // a project-relative POSIX path, not a free string — reject `..` / absolute.
  profile: RelativePosixPath,
  enabled: z.boolean().optional().default(true),
});
export type AgentRef = z.infer<typeof AgentRef>;

export const Project = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  locale: LocaleConfig,
  default_agent: PlanId,
  agents: z.array(AgentRef).min(1),
});
export type Project = z.infer<typeof Project>;
