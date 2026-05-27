import { z } from "zod";
import { RelativePosixPath } from "./relative-path.ts";

export { RelativePosixPath } from "./relative-path.ts";

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

// Base object shape, shared by the strict and lenient parsers below. The
// lenient form (no duplicate-path refinement) exists only so the
// `adapter upgrade` repair path can READ a legacy manifest that already has
// duplicate `files[].path` entries without the strict parse aborting before
// it can regenerate a clean, unique manifest.
const AdapterManifestObject = z
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

/**
 * Lenient parser — same shape as {@link AdapterManifest} but WITHOUT the
 * duplicate-path constraint. Only the `adapter install`/`adapter upgrade`
 * repair paths should use this (via `readManifest(..., { tolerantDuplicatePaths: true })`).
 * Everything else must use the strict {@link AdapterManifest}.
 */
export const AdapterManifestLenient = AdapterManifestObject;

// Strict manifest contract: every `files[].path` must be unique. A manifest
// with duplicate paths is a corrupt/legacy artifact — `writeManifest` rejects
// producing one, and strict reads reject consuming one (callers map the throw
// to ADAPTER_MANIFEST_INVALID rather than crashing).
export const AdapterManifest = AdapterManifestObject.superRefine((manifest, ctx) => {
  const seen = new Set<string>();
  manifest.files.forEach((file, index) => {
    if (seen.has(file.path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files", index, "path"],
        message: `duplicate manifest file path: "${file.path}"`,
      });
      return;
    }
    seen.add(file.path);
  });
});
export type AdapterManifest = z.infer<typeof AdapterManifest>;
