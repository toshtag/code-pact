import { z } from "zod";

// ---------------------------------------------------------------------------
// v0.9 Adapter Platform — per-agent manifest contract
//
// One file per agent at `.code-pact/adapters/<agent>.manifest.yaml`. Records
// which files code-pact wrote, their LF-normalized UTF-8 sha256 hashes, the
// generator/adapter version at install time, and a fingerprint of the
// adapter-output-affecting profile fields so drift can be surfaced later.
//
// .strict() at every level so accidental field-name drift fails loudly
// instead of producing a silent contract split. All paths are
// project-relative POSIX strings — absolute paths, `..`, `.`, empty
// segments, and Windows separators are rejected.
// ---------------------------------------------------------------------------

const RELATIVE_POSIX_PATH_HINT =
  "path must be project-relative POSIX (no leading `/`, no `..`, no `.`, no empty segments, no `\\`)";

export const RelativePosixPath = z
  .string()
  .min(1, "path must not be empty")
  .refine((s) => !s.startsWith("/"), RELATIVE_POSIX_PATH_HINT)
  .refine((s) => !s.startsWith("~"), RELATIVE_POSIX_PATH_HINT)
  .refine((s) => !s.includes("\\"), RELATIVE_POSIX_PATH_HINT)
  .refine((s) => !/^[A-Za-z]:/.test(s), RELATIVE_POSIX_PATH_HINT)
  .refine((s) => {
    const segs = s.split("/");
    return !segs.some((seg) => seg === ".." || seg === "." || seg === "");
  }, RELATIVE_POSIX_PATH_HINT);

export const ManifestFileRole = z.enum(["instruction", "skill", "hook", "rule"]);
export type ManifestFileRole = z.infer<typeof ManifestFileRole>;

export const ManifestFile = z
  .object({
    path: RelativePosixPath,
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex characters"),
    managed: z.boolean(),
    role: ManifestFileRole,
  })
  .strict();
export type ManifestFile = z.infer<typeof ManifestFile>;

// Fingerprint of adapter-output-affecting profile fields. Compared by deep
// equality via the zod-parsed shape so key order in YAML does not matter.
// Includes resolved_model only when the adapter content actually depends on
// it (Claude's CLAUDE.md does; codex / generic / cursor / gemini-cli do not).
export const ProfileFingerprint = z
  .object({
    instruction_filename: z.string().min(1),
    context_dir: z.string().min(1),
    skill_dir: z.string().min(1).optional(),
    hook_dir: z.string().min(1).optional(),
    resolved_model: z.string().min(1).optional(),
  })
  .strict();
export type ProfileFingerprint = z.infer<typeof ProfileFingerprint>;

export const AdapterManifest = z
  .object({
    // Bump on breaking manifest layout changes only. v0.9 ships schema_version 1.
    schema_version: z.literal(1),
    agent_name: z.string().min(1),
    // Equal to the code-pact package.json version at install/upgrade time.
    // Compared by simple equality (no semver ordering) when emitting
    // ADAPTER_GENERATOR_STALE.
    generator_version: z.string().min(1),
    // Bumped by the adapter module when its file layout changes structurally
    // (catalog/i18n tweaks do NOT bump this). Drives ADAPTER_SCHEMA_DRIFT.
    adapter_schema_version: z.number().int().nonnegative(),
    generated_at: z.iso.datetime({ offset: true }),
    profile_fingerprint: ProfileFingerprint,
    files: z.array(ManifestFile),
  })
  .strict();
export type AdapterManifest = z.infer<typeof AdapterManifest>;
