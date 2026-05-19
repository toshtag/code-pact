import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { RelativePosixPath } from "../schemas/adapter-manifest.ts";

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Throws if `relPath` is not a safe project-relative POSIX path. Delegates
 * to the same zod refinement used by the manifest schema so callers get one
 * consistent rule set: empty / leading `/` / leading `~` / `\` / Windows
 * drive letter / `..` / `.` / empty segments are all rejected.
 *
 * This is a structural check only — it does NOT touch the filesystem. Use
 * `resolveWithinProject` to additionally guard against symlink escape.
 */
export function assertSafeRelativePath(relPath: string): void {
  RelativePosixPath.parse(relPath);
}

/**
 * Resolves `relPath` against `cwd` and returns the joined absolute path,
 * but throws if any existing ancestor of the target resolves outside
 * `realpath(cwd)` via a symlink. The check walks up from the target
 * through existing parents until it finds one that exists on disk; that
 * ancestor's realpath must remain within the project root.
 *
 * Returns the path joined to the ORIGINAL `cwd` (not the realpath'd
 * cwd). This matters on macOS where `/var/folders/...` is a symlink to
 * `/private/var/folders/...`; users passing the former in expect the
 * former back out. The realpath is computed internally only for the
 * symlink-escape safety check.
 *
 * Throws on:
 *  - any structural path failure from `assertSafeRelativePath`
 *  - an existing ancestor whose realpath escapes the project root
 */
export async function resolveWithinProject(
  cwd: string,
  relPath: string,
): Promise<string> {
  assertSafeRelativePath(relPath);
  const cwdReal = await realpath(cwd);
  const target = resolve(cwd, relPath);
  const targetReal = resolve(cwdReal, relPath);

  // Walk up `targetReal` (the realpath-rooted candidate) until we hit
  // something that exists on disk, then verify its realpath is still
  // under cwdReal. This catches symlink escape both for files that
  // exist and for files we are about to create whose parent directory
  // is a symlink to outside the project.
  let ancestor = targetReal;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const ancestorReal = await realpath(ancestor);
      if (
        ancestorReal !== cwdReal &&
        !ancestorReal.startsWith(cwdReal + sep)
      ) {
        throw new Error(
          `path "${relPath}" resolves outside project root (ancestor "${ancestor}" → "${ancestorReal}")`,
        );
      }
      return target;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const parent = dirname(ancestor);
        if (parent === ancestor) {
          // Reached filesystem root without finding an existing ancestor.
          // This cannot happen in practice because cwd itself exists, but
          // guard defensively so we never loop forever.
          return target;
        }
        ancestor = parent;
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// 2-axis file state classification
// ---------------------------------------------------------------------------

export type LocalFileState =
  | "new" // no manifest entry, no disk file
  | "unmanaged" // no manifest entry, disk has the file
  | "managed-clean" // manifest entry, disk hash == manifest hash
  | "managed-modified" // manifest entry, disk hash != manifest hash
  | "managed-missing"; // manifest entry, no disk file

export type DesiredFileState =
  | "current" // disk hash == desired hash (content matches current generator output)
  | "stale" // disk hash != desired hash (or generator no longer emits this path)
  | "absent"; // disk has no file — desired comparison is not applicable

export type FileClassificationInput = {
  manifestHash: string | null;
  diskHash: string | null;
  desiredHash: string | null;
};

export type FileClassification = {
  local: LocalFileState;
  desired: DesiredFileState;
};

/**
 * Pure function: classifies a file along the two axes. Hash computation is
 * the caller's job — pass null for any hash that is not available
 * (manifest entry missing, disk file missing, generator no longer emits).
 *
 * The `desired` axis is meaningful only when the file exists on disk; when
 * the disk hash is null we return `desired: "absent"` regardless of the
 * desired hash, because there is nothing to compare. When the disk file
 * exists but the generator no longer emits it (desiredHash === null), we
 * return `desired: "stale"` — the file is by definition not current.
 */
export function classifyFileState(
  input: FileClassificationInput,
): FileClassification {
  const { manifestHash, diskHash, desiredHash } = input;

  let local: LocalFileState;
  if (manifestHash === null && diskHash === null) {
    local = "new";
  } else if (manifestHash === null && diskHash !== null) {
    local = "unmanaged";
  } else if (manifestHash !== null && diskHash === null) {
    local = "managed-missing";
  } else if (manifestHash === diskHash) {
    local = "managed-clean";
  } else {
    local = "managed-modified";
  }

  let desired: DesiredFileState;
  if (diskHash === null) {
    desired = "absent";
  } else if (desiredHash === null) {
    desired = "stale";
  } else if (diskHash === desiredHash) {
    desired = "current";
  } else {
    desired = "stale";
  }

  return { local, desired };
}

// ---------------------------------------------------------------------------
// Action matrix
// ---------------------------------------------------------------------------

export type AdapterMode = "install" | "upgrade-check" | "upgrade-write";

export type FileAction =
  | "write" // create / recreate from desired content
  | "skip" // no change
  | "adopt" // existing file matches desired — record in manifest, do not touch content
  | "replace_unmanaged" // overwrite unmanaged file with desired content
  | "update" // overwrite managed file with desired content (managed-clean × stale or accepted managed-modified × stale)
  | "update_manifest" // update only the manifest hash (managed-modified × current)
  | "refuse" // would destroy local modifications; requires --accept-modified
  | "warn"; // surfaceable issue but no action (e.g. unmanaged without --force in check mode)

export type ActionDecisionInput = {
  local: LocalFileState;
  desired: DesiredFileState;
  mode: AdapterMode;
  force: boolean;
  acceptModified: boolean;
};

/**
 * Pure action matrix. Maps `(local, desired, mode, force, acceptModified)`
 * to the single FileAction the command layer should perform for one file.
 *
 * Notes on semantics:
 *  - `install` is initial setup and never updates an existing managed file.
 *    `managed-clean × stale` and `managed-modified × *` return `skip` so
 *    re-running install is always idempotent.
 *  - `--force` is unmanaged-adoption only. It NEVER overrides
 *    `managed-modified`; destructive overwrite of locally-modified files
 *    requires `--accept-modified` on `upgrade --write`.
 *  - `upgrade --check` is read-only. It returns the action that `--write`
 *    WOULD take, except for `managed-modified × stale` where it reports
 *    `refuse` even with `--accept-modified` (the caller may need to know
 *    the file is modified before running with that flag).
 *  - `--regen-skills` is a role-scoped force handled by the command layer
 *    before calling this function; it does not appear here.
 */
export function decideAction(input: ActionDecisionInput): FileAction {
  const { local, desired, mode, force, acceptModified } = input;

  // managed-missing and new: always write (or report "write" in check).
  if (local === "new" || local === "managed-missing") return "write";

  // unmanaged: needs --force to act.
  if (local === "unmanaged") {
    if (mode === "upgrade-check") return "warn";
    if (!force) return "skip";
    return desired === "current" ? "adopt" : "replace_unmanaged";
  }

  // managed-clean
  if (local === "managed-clean") {
    if (desired === "current") return "skip";
    // desired === "stale" → safe update; install is hands-off so skip there
    if (mode === "install") return "skip";
    return "update";
  }

  // managed-modified (the only remaining local state)
  if (desired === "current") {
    // hash drift but content matches current desired — manifest-only update
    if (mode === "install") return "skip";
    return "update_manifest";
  }

  // managed-modified × stale: refuse unless --accept-modified
  if (mode === "install") return "skip";
  if (mode === "upgrade-check") return "refuse";
  return acceptModified ? "update" : "refuse";
}
