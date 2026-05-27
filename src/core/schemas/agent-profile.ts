import { z } from "zod";

// Supported Claude model versions for model-aware adapter generation.
// "generic" (or undefined) produces the baseline template.
export const CLAUDE_MODEL_VERSIONS = ["opus-4.6", "opus-4.7", "sonnet-4.6"] as const;
export type ClaudeModelVersion = (typeof CLAUDE_MODEL_VERSIONS)[number];

// Accepted aliases for the `--model` flag. The full vendor model id
// (e.g. "claude-opus-4-7") normalizes to the canonical profile value
// (e.g. "opus-4.7") so users can pass whichever form they have on hand.
// Canonical values pass through unchanged.
const MODEL_VERSION_ALIASES: Readonly<Record<string, ClaudeModelVersion>> = {
  "claude-opus-4-6": "opus-4.6",
  "claude-opus-4-7": "opus-4.7",
  "claude-sonnet-4-6": "sonnet-4.6",
};

/** Every input string `normalizeModelVersion` accepts, for error messages. */
export const ACCEPTED_MODEL_VERSION_INPUTS: readonly string[] = [
  ...CLAUDE_MODEL_VERSIONS,
  ...Object.keys(MODEL_VERSION_ALIASES),
];

/**
 * Normalizes a `--model` input to a canonical {@link ClaudeModelVersion}, or
 * returns `null` when the value is not recognized. Canonical values
 * (`opus-4.7`) pass through; vendor ids (`claude-opus-4-7`) map via alias.
 * Callers translate `null` into a CONFIG_ERROR — there is no silent fallback.
 */
export function normalizeModelVersion(input: string): ClaudeModelVersion | null {
  const trimmed = input.trim();
  if ((CLAUDE_MODEL_VERSIONS as readonly string[]).includes(trimmed)) {
    return trimmed as ClaudeModelVersion;
  }
  return MODEL_VERSION_ALIASES[trimmed.toLowerCase()] ?? null;
}

export const AgentProfile = z.object({
  name: z.string().min(1),
  instruction_filename: z.string().min(1),
  context_dir: z.string().min(1),
  skill_dir: z.string().optional(),
  hook_dir: z.string().optional(),
  // Maps abstract model tiers to concrete vendor model IDs.
  // Keeping the mapping here, not in core schema, means the core stays
  // vendor-agnostic and model names can be bumped without touching phases.
  model_map: z.object({
    highest_reasoning: z.string().min(1).optional(),
    balanced_coding: z.string().min(1).optional(),
    cheap_mechanical: z.string().min(1).optional(),
  }),
  // Optional: pin the primary Claude model version for model-aware CLAUDE.md generation.
  // When set, the adapter includes model-specific effort and capability guidance.
  // Supported values: "opus-4.6" | "opus-4.7" | "sonnet-4.6"
  // Omit for the generic (version-agnostic) template.
  model_version: z.string().optional(),
});
export type AgentProfile = z.infer<typeof AgentProfile>;
