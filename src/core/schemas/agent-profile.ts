import { z } from "zod";
import { PlanId } from "./plan-id.ts";
import { RelativePosixPath } from "./relative-path.ts";
import {
  CLAUDE_MODEL_VERSIONS,
  MODEL_VERSION_ALIASES,
  type ClaudeModelVersion,
} from "../models/catalog.ts";

// The supported-version list and `--model` aliases now live in the model
// catalog (the single source of truth). Re-export the names existing import
// sites — and tests — depend on, so `from "./agent-profile.ts"` keeps working.
export { CLAUDE_MODEL_VERSIONS };
export type { ClaudeModelVersion };

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
  // Same charset constraint as AgentRef.name (project.ts): the profile name
  // is the agent identifier used in command strings and path segments.
  name: PlanId,
  // Path fields are project-relative POSIX paths: they flow into
  // `join(cwd, ...)` → mkdir / writeFile (context pack output, adapter
  // install dirs) and readFile (doctor), so an unconstrained value like
  // `../../tmp` or `/etc` would escape the project root. Constrain at the
  // schema boundary — the same "paths use a path schema" rule the read
  // schemas (roadmap PhaseRef.path) already follow.
  instruction_filename: RelativePosixPath,
  context_dir: RelativePosixPath,
  skill_dir: RelativePosixPath.optional(),
  hook_dir: RelativePosixPath.optional(),
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
  // Supported values: see CLAUDE_MODEL_VERSIONS in core/models/catalog.ts
  // (e.g. "opus-4.8" | "opus-4.7" | "opus-4.6" | "sonnet-4.6").
  // Omit for the generic (version-agnostic) template.
  model_version: z.string().optional(),
});
export type AgentProfile = z.infer<typeof AgentProfile>;
