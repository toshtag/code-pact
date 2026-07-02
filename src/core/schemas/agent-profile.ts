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
export function normalizeModelVersion(
  input: string,
): ClaudeModelVersion | null {
  const trimmed = input.trim();
  if ((CLAUDE_MODEL_VERSIONS as readonly string[]).includes(trimmed)) {
    return trimmed as ClaudeModelVersion;
  }
  return MODEL_VERSION_ALIASES[trimmed.toLowerCase()] ?? null;
}

// A context budget profile name is used as a
// `--context-budget <profile>` CLI token, so it is constrained to a safe
// identifier charset (letters, digits, `-`, `_`; non-empty) — no spaces, no
// path/flag-ambiguous characters. The three standard names (tight/balanced/
// wide) satisfy this; custom names must too.
const ContextBudgetProfileName = z
  .string()
  .min(1, "context budget profile name must be non-empty")
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "context budget profile name must use only letters, digits, '-' or '_'",
  );

/**
 * Optional `context_budget` block. Names a small set of byte budgets the
 * agent can refer to by name via `--context-budget <profile>`. Validated when
 * present; a missing block is valid (backward compatible) and is NOT applied
 * automatically to any command — there is no implicit default-budget behavior.
 * `default_profile` is validated for future ergonomics only.
 */
export const ContextBudgetProfiles = z
  .object({
    // Optional convenience pointer. Validated to reference an existing profile,
    // but it is NOT auto-applied anywhere.
    default_profile: ContextBudgetProfileName.optional(),
    // A `max_bytes` is a positive integer byte cap (the unit the budget enforcement
    // path already speaks). Non-empty: an empty block carries no information and
    // is almost certainly a mistake.
    profiles: z
      .record(
        ContextBudgetProfileName,
        z.object({ max_bytes: z.number().int().positive() }),
      )
      .refine(p => Object.keys(p).length > 0, {
        message: "context_budget.profiles must declare at least one profile",
      }),
  })
  .refine(
    cb =>
      cb.default_profile === undefined ||
      Object.prototype.hasOwnProperty.call(cb.profiles, cb.default_profile),
    {
      message:
        "context_budget.default_profile must reference a profile declared in context_budget.profiles",
      path: ["default_profile"],
    },
  );
export type ContextBudgetProfiles = z.infer<typeof ContextBudgetProfiles>;

/**
 * Context pack output directory — a project-relative POSIX path constrained to
 * the reserved `.context` generated namespace. Profile `context_dir` MUST be
 * `.context` or a directory below `.context/`; arbitrary project directories
 * (`design`, `docs`, `src`, …) are rejected at the schema boundary so a
 * hostile profile cannot redirect context pack writes into unowned project
 * files (e.g. `context_dir: design` + `taskId: constitution` → overwrite
 * `design/constitution.md`).
 */
export const ContextOutputDir = RelativePosixPath.refine(
  value => value === ".context" || value.startsWith(".context/"),
  {
    message: "context_dir must be .context or a directory below .context/",
  },
);

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
  context_dir: ContextOutputDir,
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
  // Optional named context budget profiles. See ContextBudgetProfiles.
  context_budget: ContextBudgetProfiles.optional(),
});
export type AgentProfile = z.infer<typeof AgentProfile>;
