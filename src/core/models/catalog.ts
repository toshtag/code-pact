// Single source of truth for Claude model facts.
//
// These values feed four otherwise-independent places that previously each
// hardcoded their own copy and drifted apart: the `--model` validator
// (schemas/agent-profile.ts), the default agent profile (core/agents.ts), the
// default model profiles (commands/init.ts), and the generated CLAUDE.md model
// guidance (adapters/claude.ts). Bumping a Claude model is now a one-file edit.
//
// This module is a LEAF: plain data only, no zod / schema runtime import. The
// schema layer imports FROM here, so a runtime import back would create a
// cycle. Type-only imports are fine (erased at compile time).
//
// This whole layer is ADVISORY — it drives recommendation text and generated
// instructions. No enforcement path (verify / audit / lifecycle gate) depends
// on these ids. So a stale value mis-advises; it never breaks correctness.
//
// Two DISTINCT namespaces live here. Keep them apart or doctor false-positives:
//   - CLAUDE_MODEL_VERSIONS         short canonical versions, for `--model` /
//                                   the agent profile's `model_version` field.
//   - CLAUDE_KNOWN_VENDOR_MODEL_IDS full vendor ids, for `model_map` values
//                                   (includes haiku, which has no version form).

import type { ModelProfile } from "../schemas/model-profile.ts";

// ---------------------------------------------------------------------------
// model_version namespace (short canonical) — for `--model` / model_version
// ---------------------------------------------------------------------------

/**
 * Supported Claude model versions for model-aware adapter generation.
 * "generic" (or undefined) produces the baseline template. Newest first.
 */
export const CLAUDE_MODEL_VERSIONS = [
  "opus-4.8",
  "opus-4.7",
  "opus-4.6",
  "sonnet-4.6",
] as const;
export type ClaudeModelVersion = (typeof CLAUDE_MODEL_VERSIONS)[number];

/**
 * Accepted aliases for the `--model` flag. The full vendor model id
 * (e.g. "claude-opus-4-7") normalizes to the canonical profile value
 * (e.g. "opus-4.7") so users can pass whichever form they have on hand.
 */
export const MODEL_VERSION_ALIASES: Readonly<Record<string, ClaudeModelVersion>> = {
  "claude-opus-4-8": "opus-4.8",
  "claude-opus-4-7": "opus-4.7",
  "claude-opus-4-6": "opus-4.6",
  "claude-sonnet-4-6": "sonnet-4.6",
};

// ---------------------------------------------------------------------------
// model_map namespace (full vendor ids) — for the agent profile's model_map
// ---------------------------------------------------------------------------

/**
 * Known Claude vendor model ids that may legitimately appear in a claude-code
 * agent profile's `model_map`. Includes haiku, which has no `model_version`
 * form — so this is a SEPARATE set from {@link CLAUDE_MODEL_VERSIONS}. doctor
 * validates `model_map` values against this set (not the version set), or
 * `cheap_mechanical: claude-haiku-4-5` would be a false `MODEL_ID_UNKNOWN`.
 */
export const CLAUDE_KNOWN_VENDOR_MODEL_IDS: readonly string[] = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

/**
 * Current default vendor model id per abstract tier (anthropic / claude-code).
 * core/agents.ts seeds DEFAULT_AGENT_PROFILES["claude-code"].model_map from
 * this, and doctor compares an existing profile's model_map against it to
 * surface `MODEL_MAP_STALE` (a profile generated before a model bump).
 */
export const CLAUDE_TIER_MODEL_IDS = {
  highest_reasoning: "claude-opus-4-8",
  balanced_coding: "claude-sonnet-4-6",
  cheap_mechanical: "claude-haiku-4-5",
} as const;

// ---------------------------------------------------------------------------
// Generated CLAUDE.md model-specific guidance
// ---------------------------------------------------------------------------

export type ModelGuidance = {
  effortGuidance: string;
  thinkingNote: string;
};

const OPUS_EFFORT_GUIDANCE = [
  "- `high` — large context, complex architecture decisions, or tasks with `ambiguity: high`",
  "- `medium` — standard feature work (default)",
  "- `low` — small mechanical tasks (`type: refactor`, `expected_duration: short`)",
].join("\n");

// Opus 4.7 and 4.8: per Anthropic's models table, Extended thinking: No,
// Adaptive thinking: Yes. Manual extended-thinking budgets are not supported;
// the model scales its own reasoning depth.
const OPUS_ADAPTIVE_GUIDANCE: ModelGuidance = {
  effortGuidance: OPUS_EFFORT_GUIDANCE,
  thinkingNote:
    "Adaptive thinking is supported; manual extended thinking is not. The model adapts its reasoning depth automatically for complex or `ambiguity: high` tasks — there is no explicit enable step.",
};

// Opus 4.6: Extended thinking: Yes, Adaptive thinking: Yes.
const OPUS_46_GUIDANCE: ModelGuidance = {
  effortGuidance: OPUS_EFFORT_GUIDANCE,
  thinkingNote:
    "Extended thinking is supported. Enable it for tasks flagged `ambiguity: high` or `context_size: large`.",
};

export const CLAUDE_MODEL_GUIDANCE: Record<ClaudeModelVersion, ModelGuidance> = {
  "opus-4.8": OPUS_ADAPTIVE_GUIDANCE,
  "opus-4.7": OPUS_ADAPTIVE_GUIDANCE,
  "opus-4.6": OPUS_46_GUIDANCE,
  "sonnet-4.6": {
    // Sonnet 4.6: Extended thinking: Yes, Adaptive thinking: Yes.
    effortGuidance: [
      "- `medium` — standard feature work (default)",
      "- `low` — small mechanical tasks (`type: refactor`, `expected_duration: short`)",
      "- `high` is **not supported** on this model — switch to the `highest_reasoning` tier for complex tasks.",
    ].join("\n"),
    thinkingNote:
      "Extended thinking is supported. For tasks requiring deep reasoning (`ambiguity: high`), consider switching to the `highest_reasoning` tier model.",
  },
};

// ---------------------------------------------------------------------------
// Default abstract tier profiles (init seed)
// ---------------------------------------------------------------------------

/**
 * Seed for `.code-pact/model-profiles/*.yaml`. Abstract tier definitions;
 * concrete model ids are mapped per-agent via {@link CLAUDE_TIER_MODEL_IDS}.
 */
export const DEFAULT_MODEL_PROFILES: ModelProfile[] = [
  {
    tier: "highest_reasoning",
    purpose: ["architecture", "high_ambiguity"],
    effort_levels: ["medium", "high"],
    supports_thinking: true,
  },
  {
    tier: "balanced_coding",
    purpose: ["feature", "refactor"],
    effort_levels: ["low", "medium", "high"],
    supports_thinking: false,
  },
  {
    tier: "cheap_mechanical",
    purpose: ["docs", "formatting"],
    effort_levels: ["low"],
    supports_thinking: false,
  },
];
