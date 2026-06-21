import { matchGlob } from "../glob.ts";
import { resolveOwnedProjectPath } from "../path-safety.ts";
import type { AdapterDescriptor, DesiredAdapterFileRole } from "./types.ts";

/**
 * Verdict for "may this manifest entry path be READ by a diagnostic
 * (conformance / doctor)?".
 *
 *   - `owned`     → the path is in the adapter's NARROW static read-authority
 *                   set, its declared role matches, AND it traverses no symlink
 *                   → safe to resolve + read.
 *   - `unowned`   → the path is NOT one the adapter could have generated, or its
 *                   declared role does not match the expected role for that
 *                   static path. A forged manifest naming `.env`, or a victim's
 *                   hand-authored `.claude/skills/private.md`, lands here.
 *   - `unsafe`    → the path resolves through a symlink (or escapes the root).
 *                   An in-project `.claude/skills -> ../../etc` redirect lands
 *                   here even if the lexical path matched.
 *
 * On `owned`, `absPath` is the resolved, symlink-free absolute path to read.
 */
export type ManifestFileOwnership =
  | { kind: "owned"; absPath: string }
  | { kind: "unowned" }
  | { kind: "unsafe" }
  // The path is inside the adapter's BROAD write namespace (e.g. a dynamically
  // named `.claude/skills/plan-lint.md`) but NOT in the narrow read-authority
  // set. It is a LEGITIMATE generated file, but its name is attacker-
  // influenceable (derived from project verification commands), so it cannot
  // serve as read-ownership proof. The diagnostic must NOT read/hash/inspect it,
  // but it is NOT a forged-manifest security failure either — callers SKIP it
  // (no checksum) rather than reading it or flagging it unowned.
  | { kind: "unverifiable_dynamic" };

/**
 * SECURITY (CWE-22/CWE-59/CWE-200 — forged-manifest file-content/SHA oracle):
 * a manifest is project-supplied and attacker-controllable. Its `files[].path`
 * is just a `RelativePosixPath`, so a hostile repo can list `path: .env` (or any
 * credential file) and have a diagnostic READ it and emit its SHA-256 / heading
 * substrings — a content oracle.
 *
 * READ AUTHORITY IS NARROWER THAN WRITE AUTHORITY. The two are distinct rights:
 *   "may CREATE a new generated file here"  ≠  "may READ + hash + inspect an
 *   EXISTING file here".
 * In particular `writePathGlobs` (e.g. `.claude/skills/*.md`) covers a namespace
 * SHARED with hand-authored user skills and with dynamically-named, attacker-
 * influenceable verification-command skills. Using it as read authority would
 * let a forged manifest read a victim's `.claude/skills/private.md` (it matches
 * the wildcard) and oracle its sha256 / headings. So this gate uses ONLY the
 * adapter's NARROW `ownedPathGlobs` — the exact, wildcard-free, BUILT-IN static
 * paths (e.g. `CLAUDE.md`, `.claude/skills/context.md|verify.md|progress.md`).
 * A dynamic skill in the shared namespace cannot prove read ownership and is
 * therefore never read by a diagnostic. The role must also match the expected
 * role for that static path, and the path must traverse no symlink
 * (resolveOwnedProjectPath rejects every symlink component).
 *
 * The PRIMARY guard is the narrow exact-path set (it alone blocks reading a
 * victim's `.claude/skills/private.md`). When the caller can afford to run the
 * generator it SHOULD also pass `roleCheck` — the exact `path → role` map from
 * `buildOwnedRoleMap` — for the secondary defense: a manifest entry whose
 * declared role disagrees with the path's only legitimate role is `unowned`
 * (a forged `role: instruction` on a skill path is refused before any heading
 * inspection). Conformance, which does not run the generator, omits it and
 * relies on the exact-path + symlink guards, which already close the oracle.
 */
export async function classifyManifestFileForRead(
  cwd: string,
  descriptor: AdapterDescriptor,
  relPath: string,
  roleCheck?: {
    declaredRole: DesiredAdapterFileRole;
    expectedRoleFor: ReadonlyMap<string, DesiredAdapterFileRole>;
  },
): Promise<ManifestFileOwnership> {
  // NARROW static read authority — never the shared writePathGlobs namespace.
  const ownedExact = descriptor.ownedPathGlobs;
  if (!ownedExact.some((g) => matchGlob(g, relPath))) {
    // Distinguish a LEGITIMATE-but-unverifiable dynamic skill (inside the broad
    // write namespace) from a forged arbitrary path. The former is skipped (not
    // read, not a failure); the latter is a fail-closed security issue.
    const writeNamespace = descriptor.writePathGlobs ?? descriptor.ownedPathGlobs;
    if (writeNamespace.some((g) => matchGlob(g, relPath))) {
      return { kind: "unverifiable_dynamic" };
    }
    return { kind: "unowned" };
  }
  // Secondary defense (when the caller generated the desired set): the declared
  // role must match the path's only legitimate role.
  if (roleCheck !== undefined) {
    const expected = roleCheck.expectedRoleFor.get(relPath);
    if (expected === undefined || expected !== roleCheck.declaredRole) {
      return { kind: "unowned" };
    }
  }
  try {
    // Rejects any symlink component (and `..` / absolute / drive paths): a
    // lexical path match is not proof the real destination is owned.
    const absPath = await resolveOwnedProjectPath(cwd, relPath);
    return { kind: "owned", absPath };
  } catch {
    return { kind: "unsafe" };
  }
}

/**
 * Build the exact `path → role` map for the adapter's NARROW static read
 * authority: run the generator, then keep only the desired files whose path is
 * in `ownedPathGlobs` (the wildcard-free built-in set). Dynamic skills in the
 * shared `.claude/skills/*.md` namespace are intentionally EXCLUDED — their
 * names are attacker-influenceable (derived from project verification commands),
 * so they can never be a read-ownership proof.
 */
export function buildOwnedRoleMap(
  descriptor: AdapterDescriptor,
  desiredFiles: ReadonlyArray<{ path: string; role: DesiredAdapterFileRole }>,
): Map<string, DesiredAdapterFileRole> {
  const out = new Map<string, DesiredAdapterFileRole>();
  for (const f of desiredFiles) {
    if (descriptor.ownedPathGlobs.some((g) => matchGlob(g, f.path))) {
      out.set(f.path, f.role);
    }
  }
  return out;
}
