// Resolves a named context budget profile to a byte cap, which the CLI
// then feeds into the --budget-bytes enforcement path. This module never
// touches the pack builder or the elision order — it only turns a NAME
// into a NUMBER.
//
// Resolution order:
//   1. An agent profile's `context_budget.profiles[name]` wins when present —
//      this is how a project OVERRIDES a standard byte value or declares a
//      custom profile.
//   2. Otherwise, a standard name (tight | balanced | wide) falls back to its
//      built-in byte value. Standard names therefore resolve even with NO
//      agent profile in play ("agent-less resolution"), keeping the ergonomic
//      name usable without forcing --agent.
//   3. Anything else is a CONFIG_ERROR naming the missing profile (and the
//      agent, when one is in play).

import {
  STANDARD_CONTEXT_BUDGET_PROFILE_NAMES,
  isStandardContextBudgetProfile,
  STANDARD_CONTEXT_BUDGET_PROFILES,
} from "./budget-profiles.ts";

/**
 * The minimal `context_budget` shape the resolver reads. Mirrors the optional
 * block on {@link AgentProfile} (src/core/schemas/agent-profile.ts) without
 * importing it, so this stays a pure, schema-agnostic helper.
 */
export type ContextBudgetConfig = {
  application_mode?: "manual" | "recommended";
  default_profile?: string;
  profiles?: Record<string, { max_bytes: number }> | undefined;
};

export type ResolveContextBudgetProfileInput = {
  /** The profile name requested via `--context-budget <profile>`. */
  profileName: string;
  /**
   * The loaded agent profile's `context_budget` block, when one is in play.
   * Omit (or pass `undefined`) for agent-less resolution — standard names
   * still resolve to their built-in fallback bytes.
   */
  contextBudget?: ContextBudgetConfig | undefined;
  /** Agent name, used only to make the CONFIG_ERROR message actionable. */
  agentName?: string | undefined;
};

/** Thrown when a `--context-budget` profile name cannot be resolved. */
export class ContextBudgetProfileError extends Error {
  readonly code = "CONFIG_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "ContextBudgetProfileError";
  }
}

/**
 * Resolves `profileName` to a positive byte budget. An agent-profile override
 * wins; a standard name falls back to its built-in value; anything else throws
 * {@link ContextBudgetProfileError} (`code: "CONFIG_ERROR"`).
 */
export function resolveContextBudgetProfile(
  input: ResolveContextBudgetProfileInput,
): number {
  const { profileName, contextBudget, agentName } = input;

  // 1. Agent-profile override (also the only source of custom profiles).
  const override = contextBudget?.profiles?.[profileName];
  if (override !== undefined) {
    return override.max_bytes;
  }

  // 2. Standard built-in fallback (resolves even agent-less).
  if (isStandardContextBudgetProfile(profileName)) {
    return STANDARD_CONTEXT_BUDGET_PROFILES[profileName];
  }

  // 3. Unknown — name the missing profile, the agent (when known), and the
  //    standard vocabulary plus any custom names the agent declared.
  const standardList = STANDARD_CONTEXT_BUDGET_PROFILE_NAMES.join(" | ");
  const customNames = contextBudget?.profiles
    ? Object.keys(contextBudget.profiles)
    : [];
  const known =
    customNames.length > 0
      ? `${standardList}, or an agent-defined profile (${customNames.join(", ")})`
      : standardList;
  const forAgent = agentName ? ` for agent "${agentName}"` : "";
  throw new ContextBudgetProfileError(
    `unknown context budget profile "${profileName}"${forAgent}. Known profiles: ${known}.`,
  );
}
