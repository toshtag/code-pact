import type { AgentProfile } from "./schemas/agent-profile.ts";

export type SupportedAgent = "claude-code" | "codex" | "generic";

export const SUPPORTED_AGENTS: readonly SupportedAgent[] = [
  "claude-code",
  "codex",
  "generic",
] as const;

export function isSupportedAgent(value: string): value is SupportedAgent {
  return (SUPPORTED_AGENTS as readonly string[]).includes(value);
}

const CLAUDE_PROFILE: AgentProfile = {
  name: "claude-code",
  instruction_filename: "CLAUDE.md",
  context_dir: ".context/claude-code",
  skill_dir: ".claude/skills",
  hook_dir: ".claude/hooks",
  model_map: {
    highest_reasoning: "claude-opus-4-7",
    balanced_coding: "claude-sonnet-4-6",
    cheap_mechanical: "claude-haiku-4-5",
  },
};

const CODEX_PROFILE: AgentProfile = {
  name: "codex",
  instruction_filename: "AGENTS.md",
  context_dir: ".context/codex",
  model_map: {
    highest_reasoning: "o3",
    balanced_coding: "o4-mini",
    cheap_mechanical: "gpt-4.1-mini",
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

export const DEFAULT_AGENT_PROFILES: Record<SupportedAgent, AgentProfile> = {
  "claude-code": CLAUDE_PROFILE,
  codex: CODEX_PROFILE,
  generic: GENERIC_PROFILE,
};
