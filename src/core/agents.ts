import type { AgentProfile } from "./schemas/agent-profile.ts";
import { CLAUDE_TIER_MODEL_IDS } from "./models/catalog.ts";

export type SupportedAgent =
  | "claude-code"
  | "codex"
  | "generic"
  | "cursor"
  | "gemini-cli";

export const SUPPORTED_AGENTS: readonly SupportedAgent[] = [
  "claude-code",
  "codex",
  "generic",
  "cursor",
  "gemini-cli",
] as const;

/**
 * Adapters whose generated instructions or rule format may shift across
 * v0.2.x. We surface this both in README and in a comment at the top of
 * the generated file so contributors know to expect churn.
 */
export const EXPERIMENTAL_AGENTS: ReadonlySet<SupportedAgent> = new Set([
  "cursor",
  "gemini-cli",
]);

export function isSupportedAgent(value: string): value is SupportedAgent {
  return (SUPPORTED_AGENTS as readonly string[]).includes(value);
}

const CLAUDE_PROFILE: AgentProfile = {
  name: "claude-code",
  instruction_filename: "CLAUDE.md",
  context_dir: ".context/claude-code",
  skill_dir: ".claude/skills",
  hook_dir: ".claude/hooks",
  // Concrete vendor model ids per tier come from the model catalog (single
  // source of truth) so a model bump is a one-file edit, not a hunt across
  // agents.ts / init.ts / agent-profile.ts / claude.ts.
  model_map: { ...CLAUDE_TIER_MODEL_IDS },
};

const CODEX_PROFILE: AgentProfile = {
  name: "codex",
  instruction_filename: "AGENTS.md",
  context_dir: ".context/codex",
  // Advisory display only. Unlike claude-code, these vendor ids are NOT backed
  // by a catalog: there is no OpenAI version validator, no model guidance, and
  // the doctor MODEL_ID_UNKNOWN / MODEL_MAP_STALE checks are claude-code scoped,
  // so these are user-maintained and not drift-checked. Refresh by hand, or run
  // a provider audit before adding catalog/doctor coverage (see
  // docs/maintainers/operations.md → "Provider scope").
  // Current OpenAI Codex models per https://developers.openai.com/codex/models
  // (verified 2026-06): gpt-5.5 flagship, gpt-5.4 professional/agentic,
  // gpt-5.4-mini efficient/budget. Advisory only — refresh by hand when OpenAI
  // bumps the lineup (no validator/doctor catches codex drift; see comment above).
  model_map: {
    highest_reasoning: "gpt-5.5",
    balanced_coding: "gpt-5.4",
    cheap_mechanical: "gpt-5.4-mini",
  },
};

// Generic adapter targets any agent that does not have a dedicated profile.
// It writes a single human-readable instruction file under docs/code-pact/
// rather than docs/ to avoid colliding with existing project docs.
const GENERIC_PROFILE: AgentProfile = {
  name: "generic",
  instruction_filename: "docs/code-pact/agent-instructions.md",
  context_dir: ".context/generic",
  model_map: {},
};

// Cursor adapter (experimental, v0.2).
// Source: https://cursor.com/docs/context/rules — `.cursor/rules/*.mdc`
// is the canonical placement (`.cursorrules` was deprecated in 0.43).
// Each rule is markdown with frontmatter (description / globs /
// alwaysApply). code-pact's instructions are project-wide and must be
// in the agent's context at all times, so we write a single file with
// `alwaysApply: true`.
const CURSOR_PROFILE: AgentProfile = {
  name: "cursor",
  instruction_filename: ".cursor/rules/code-pact.mdc",
  context_dir: ".context/cursor",
  // Cursor publishes its own model selection UI; we leave the model map
  // empty so users are not surprised by stale vendor ids in the profile.
  model_map: {},
};

// Gemini CLI adapter (experimental, v0.2).
// Source: https://github.com/google-gemini/gemini-cli (Google's
// official org). The CLI discovers `GEMINI.md` hierarchically starting
// from the current working directory and walking up to the project
// root (.git). Writing a single GEMINI.md at the project root is the
// idiomatic placement and mirrors how CLAUDE.md / AGENTS.md work.
//
// Note: the `gemini-cli` name on npm has typosquat history. Users must
// install from the google-gemini org, not from look-alike packages. The
// generated file body carries an "experimental" notice for that reason.
const GEMINI_CLI_PROFILE: AgentProfile = {
  name: "gemini-cli",
  instruction_filename: "GEMINI.md",
  context_dir: ".context/gemini-cli",
  model_map: {},
};

export const DEFAULT_AGENT_PROFILES: Record<SupportedAgent, AgentProfile> = {
  "claude-code": CLAUDE_PROFILE,
  codex: CODEX_PROFILE,
  generic: GENERIC_PROFILE,
  cursor: CURSOR_PROFILE,
  "gemini-cli": GEMINI_CLI_PROFILE,
};
