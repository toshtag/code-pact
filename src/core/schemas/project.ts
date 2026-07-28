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

// Whether a new task lock may be created without a `review_contract` (P90).
// `advisory` is the backward-compatible reading — plan lint still reports the
// gap, but the lock is written. `required` refuses it. The enum lives here so
// the schema, the runtime resolver, and the CLI all name the same two values.
export const REVIEW_CONTRACT_POLICY_VALUES = ["advisory", "required"] as const;
export const ReviewContractPolicy = z.enum(REVIEW_CONTRACT_POLICY_VALUES);
export type ReviewContractPolicy = z.infer<typeof ReviewContractPolicy>;

export const VerificationPolicy = z
  .object({
    focused_command: z.string().min(1),
    max_full_attempts: z.number().int().min(1).max(10).optional().default(2),
  })
  .superRefine((policy, ctx) => {
    for (const match of policy.focused_command.matchAll(/\{([^}]+)\}/g)) {
      const placeholder = match[1];
      if (placeholder !== "task_id" && placeholder !== "phase_id") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["focused_command"],
          message: `unknown verification_policy placeholder "{${placeholder}}"`,
        });
      }
    }
  });
export type VerificationPolicy = z.infer<typeof VerificationPolicy>;

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
  verification_policy: VerificationPolicy.optional(),
  // Same posture as `decision_retention`: optional with NO schema default, so
  // an absent field stays absent through a parse/serialize round trip and the
  // effective value (`advisory`) is owned by the runtime reader. An existing
  // project that never heard of review contracts is therefore not made
  // unlockable by the upgrade, while a typo'd value is still REJECTED here so
  // `validate` / `doctor` report it instead of quietly enforcing nothing.
  review_contract_policy: ReviewContractPolicy.optional(),
});
export type Project = z.infer<typeof Project>;
