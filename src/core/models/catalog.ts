// Single source of truth for Claude model facts.
//
// These values feed three otherwise-independent places that would otherwise
// each hardcode their own copy and drift apart: the `--model` validator
// (schemas/agent-profile.ts), the default agent profile (core/agents.ts), and
// the default model profiles (commands/init.ts). Bumping a Claude model is a
// one-file edit here. The generated claude-code instruction file is NOT one of
// them — it is model-neutral and reads nothing from this module.
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
 * Supported canonical Claude model versions for `--model` validation and
 * `model_version` profile pinning. Newest first. Not a template switch: the
 * schema-v2 bootstrap renders identical bytes for every value here.
 */
export const CLAUDE_MODEL_VERSIONS = [
  "opus-5",
  "sonnet-5",
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
  "claude-opus-5": "opus-5",
  "claude-sonnet-5": "sonnet-5",
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
 *
 * `claude-fable-5` is listed for the same reason as haiku: it is a shipping
 * Claude 5 model that a `model_map` may legitimately pin, but it is not a
 * `model_version` value and is not a tier default.
 */
export const CLAUDE_KNOWN_VENDOR_MODEL_IDS: readonly string[] = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
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
  highest_reasoning: "claude-opus-5",
  balanced_coding: "claude-sonnet-5",
  // No Haiku 5 exists, so the cheap tier stays on Haiku 4.5.
  cheap_mechanical: "claude-haiku-4-5",
} as const;

// ---------------------------------------------------------------------------
// No per-model guidance block lives here any more.
//
// A `CLAUDE_MODEL_GUIDANCE` map used to render an effort/thinking section into
// the generated CLAUDE.md. The claude-code bootstrap is model-neutral (P88), so
// nothing consumed it, and per-model prose about thinking mechanics was the part
// of this file that went stale fastest — the authoritative per-model capability
// table is Anthropic's documentation, not a bundled copy of it. Effort guidance
// now reaches the agent through `recommend` / `task prepare --detail full`,
// which is per-task rather than per-model.
// ---------------------------------------------------------------------------

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
