import { matchGlob } from "../glob.ts";
import { resolveSymlinkFreeProjectPath } from "../path-safety.ts";
import {
  brandOwnedWrite,
  type OwnedWritePath,
} from "../project-fs/branded-paths-internal.ts";
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

export type AdapterMutationPathAuthority =
  | { kind: "owned"; absPath: OwnedWritePath }
  | { kind: "dynamic_write"; absPath: OwnedWritePath }
  | { kind: "unowned" }
  | { kind: "unsafe" };

/**
 * Authorize a mutation-command path before any existence check, read, or hash.
 * Static paths require an exact path/role match. A desired dynamic path may be
 * resolved for creation, but it never gains authority to read existing bytes.
 * Manifest-only orphans pass `allowDynamicWrite: false`, so an unowned path is
 * rejected without even touching the target on disk.
 *
 * Role check order is fixed: role mismatch is determined BEFORE filesystem
 * resolution so an unowned verdict never touches the target.
 */
export async function authorizeAdapterMutationPath(
  cwd: string,
  descriptor: AdapterDescriptor,
  relPath: string,
  opts: {
    expectedRole: DesiredAdapterFileRole;
    declaredRole?: DesiredAdapterFileRole;
    allowDynamicWrite: boolean;
  },
): Promise<AdapterMutationPathAuthority> {
  const staticRole = descriptor.ownedPathRoles[relPath];
  if (staticRole !== undefined) {
    if (
      staticRole !== opts.expectedRole ||
      (opts.declaredRole !== undefined && opts.declaredRole !== staticRole)
    ) {
      return { kind: "unowned" };
    }
    try {
      return {
        kind: "owned",
        absPath: brandOwnedWrite(
          await resolveSymlinkFreeProjectPath(cwd, relPath),
        ),
      };
    } catch {
      return { kind: "unsafe" };
    }
  }

  if (!opts.allowDynamicWrite) return { kind: "unowned" };

  // Role mismatch on a dynamic path is checked before filesystem resolution.
  if (
    opts.declaredRole !== undefined &&
    opts.declaredRole !== opts.expectedRole
  ) {
    return { kind: "unowned" };
  }

  const createGlobs =
    descriptor.createPathGlobsByRole?.[opts.expectedRole] ?? [];
  if (!createGlobs.some(g => matchGlob(g, relPath))) {
    return { kind: "unowned" };
  }
  try {
    return {
      kind: "dynamic_write",
      absPath: brandOwnedWrite(
        await resolveSymlinkFreeProjectPath(cwd, relPath),
      ),
    };
  } catch {
    return { kind: "unsafe" };
  }
}

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
 * In particular `createPathGlobsByRole` (e.g. `.claude/skills/*.md` for
 * role=skill) covers a namespace SHARED with hand-authored user skills and
 * with dynamically-named, attacker-influenceable verification-command skills.
 * Using it as read authority would let a forged manifest read a victim's
 * `.claude/skills/private.md` (it matches the wildcard) and oracle its sha256
 * / headings. So this gate uses ONLY the adapter's NARROW `ownedPathRoles` —
 * the exact, wildcard-free, BUILT-IN static paths (e.g. `CLAUDE.md`,
 * `.claude/skills/context.md|verify.md|progress.md`). A dynamic skill in the
 * shared namespace cannot prove read ownership and is therefore never read by
 * a diagnostic. The declared role must match the static path's expected role,
 * and the path must traverse no symlink (resolveSymlinkFreeProjectPath rejects
 * every symlink component).
 *
 * The PRIMARY guard is the narrow exact-path set (it alone blocks reading a
 * victim's `.claude/skills/private.md`). The declared role is checked against
 * the static path's expected role BEFORE any filesystem access — a forged
 * `role: instruction` on a skill path (e.g. `CLAUDE.md` with `role: skill`) is
 * `unowned` before any heading inspection or read.
 *
 * For dynamic paths, the manifest's declared role must match the role-scoped
 * create namespace (e.g. a `.claude/skills/private.md` with role=skill is
 * `unverifiable_dynamic`; with role=instruction it is `unowned`).
 */
export async function classifyManifestFileForRead(
  cwd: string,
  descriptor: AdapterDescriptor,
  relPath: string,
  declaredRole: DesiredAdapterFileRole,
): Promise<ManifestFileOwnership> {
  // NARROW static read authority — exact lookup, never glob matching.
  const staticRole = descriptor.ownedPathRoles[relPath];
  if (staticRole === undefined) {
    // Distinguish a LEGITIMATE-but-unverifiable dynamic skill (inside the
    // role-scoped create namespace) from a forged arbitrary path. The declared
    // role must match the create namespace's role for the path to qualify as
    // `unverifiable_dynamic`; otherwise it is `unowned`.
    const createGlobs = descriptor.createPathGlobsByRole?.[declaredRole] ?? [];
    if (createGlobs.some(g => matchGlob(g, relPath))) {
      return { kind: "unverifiable_dynamic" };
    }
    return { kind: "unowned" };
  }
  // Role mismatch: the declared role disagrees with the static path's only
  // legitimate role. This is checked BEFORE any filesystem access.
  if (declaredRole !== staticRole) {
    return { kind: "unowned" };
  }
  try {
    // Rejects any symlink component (and `..` / absolute / drive paths): a
    // lexical path match is not proof the real destination is owned.
    const absPath = await resolveSymlinkFreeProjectPath(cwd, relPath);
    return { kind: "owned", absPath };
  } catch {
    return { kind: "unsafe" };
  }
}

/**
 * Build the exact `path → role` map for the adapter's NARROW static read
 * authority: run the generator, then keep only the desired files whose path is
 * in `ownedPathRoles` (the exact built-in set). Dynamic skills in the shared
 * `.claude/skills/*.md` namespace are intentionally EXCLUDED — their names are
 * attacker-influenceable (derived from project verification commands), so they
 * can never be a read-ownership proof.
 */
export function buildOwnedRoleMap(
  descriptor: AdapterDescriptor,
  desiredFiles: ReadonlyArray<{ path: string; role: DesiredAdapterFileRole }>,
): Map<string, DesiredAdapterFileRole> {
  const out = new Map<string, DesiredAdapterFileRole>();
  for (const f of desiredFiles) {
    if (descriptor.ownedPathRoles[f.path] === f.role) {
      out.set(f.path, f.role);
    }
  }
  return out;
}
