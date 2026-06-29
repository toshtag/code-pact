import { z } from "zod";
import { LocaleConfig } from "./locale.ts";
import { PlanId } from "./plan-id.ts";
import { AgentProfileRefPath } from "./agent-profile-ref-path.ts";

export const AgentRef = z.object({
  // Agent name flows into agent-facing command strings (`--agent <name>`) and
  // filesystem path segments (`agent-profiles/<name>.yaml`,
  // `.context/<name>/...`), so it shares the PlanId charset constraint.
  name: PlanId,
  // `profile` is resolved below `.code-pact/agent-profiles/**`. Keep the
  // runtime resolver's ownership check as defense in depth, but reject other
  // namespaces at the schema boundary.
  profile: AgentProfileRefPath,
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

// What a shipped (`done`) decision record becomes — the maintainer's retention
// preference (decision-lifecycle RFC § 4). `keep-full` is the backward-compatible
// default (today's ADR-forever behavior); `prune-on-ship` retires eligible records
// via `decision prune`; `compress-on-ship` compresses them (the transform lands in
// a later layer). The policy is surfaced/overridable on `decision prune --policy`;
// it never auto-deletes (deletion stays an explicit `decision prune` action).
export const DECISION_RETENTION_VALUES = ["keep-full", "compress-on-ship", "prune-on-ship"] as const;
export const DecisionRetention = z.enum(DECISION_RETENTION_VALUES);
export type DecisionRetention = z.infer<typeof DecisionRetention>;

export const Project = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  locale: LocaleConfig,
  default_agent: PlanId,
  agents: z.array(AgentRef).min(1),
  collaboration: CollaborationConfig.optional(),
  // Optional + no schema default: absence is backward-compatible (new project.yaml
  // need not carry it), and the effective default (`keep-full`) is owned by the
  // runtime reader. The schema's job here is to REJECT an out-of-enum value so
  // `validate` / `doctor` flag a typo'd policy.
  decision_retention: DecisionRetention.optional(),
});
export type Project = z.infer<typeof Project>;
