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

// Team-collaboration settings. Additive and optional;
// absence means defaults.
export const CollaborationConfig = z.object({
  // Whether to capture the `author` (git user.name) on progress events.
  // `auto` (default): capture when an identity is resolvable. `off`: never
  // capture — the strongest signal, not overridable by `CODE_PACT_AUTHOR`.
  author: z.enum(["auto", "off"]).optional().default("auto"),
});
export type CollaborationConfig = z.infer<typeof CollaborationConfig>;

export const Project = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  locale: LocaleConfig,
  default_agent: PlanId,
  agents: z.array(AgentRef).min(1),
  collaboration: CollaborationConfig.optional(),
});
export type Project = z.infer<typeof Project>;
