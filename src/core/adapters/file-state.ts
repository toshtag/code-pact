// ---------------------------------------------------------------------------
// Path safety — re-exported from the neutral module
//
// `assertSafeRelativePath` / `resolveWithinProject` live in the neutral
// `src/core/path-safety.ts` so non-adapter callers (plan lint, finalize,
// governance) can use them without taking an adapter dependency. The
// re-exports below keep existing adapter call sites working unchanged.
// ---------------------------------------------------------------------------

import { readFile, stat } from "../project-fs/index.ts";
import {
  assertSafeRelativePath as assertSafeRelativePathImpl,
  resolveSymlinkFreeProjectPath,
} from "../path-safety.ts";

export {
  assertSafeRelativePath,
  resolveWithinProject,
  pathTraversesSymlink,
} from "../path-safety.ts";

/**
 * What an adapter write path will be used AS, so the preflight can reject an
 * existing on-disk entry of the WRONG type before the write is attempted:
 *  - `directory`: a `mkdir(..., {recursive})` target (context_dir / hook_dir).
 *    An existing regular file there fails the mkdir with EEXIST.
 *  - `file`: an `atomicWriteText` / `readFileMaybe` target (a generated file or a
 *    manifest-tracked orphan). An existing directory there fails with EISDIR.
 */
export type AdapterWritePathKind = "directory" | "file";
export type AdapterWritePathSpec = { path: string; kind: AdapterWritePathKind };
export type ResolvedAdapterWritePathSpec = AdapterWritePathSpec & {
  absPath: string;
};

function configError(message: string): Error {
  const e = new Error(message);
  (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
  return e;
}

/** Read a path only after the caller has established static read authority. */
export async function readAuthorizedRegularFileMaybe(
  absPath: string,
  relPath: string,
): Promise<string | null> {
  let st: import("node:fs").Stats;
  try {
    st = await stat(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw configError(
      `authorized adapter file "${relPath}" cannot be inspected (${code ?? "unreadable"})`,
    );
  }
  if (!st.isFile()) {
    throw configError(
      `authorized adapter file "${relPath}" exists but is not a regular file`,
    );
  }
  try {
    return await readFile(absPath, "utf8");
  } catch (err) {
    throw configError(
      `authorized adapter file "${relPath}" cannot be read (${(err as NodeJS.ErrnoException).code ?? "unreadable"})`,
    );
  }
}

/** Existence probe for an authorized dynamic create target; never reads bytes. */
export async function authorizedPathExists(
  absPath: string,
  relPath: string,
): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw configError(
      `authorized adapter path "${relPath}" cannot be inspected (${code ?? "unreadable"})`,
    );
  }
}

/**
 * Fail-closed write PREFLIGHT for an adapter write pass. For every path the pass
 * will touch — placeholder dirs, generated files, and (for upgrade) manifest-
 * tracked orphan candidates — it checks BOTH:
 *
 *  1. OWNERSHIP — {@link resolveSymlinkFreeProjectPath} (every symlink component,
 *     including an in-project alias, is rejected).
 *  2. TYPE — an EXISTING entry must match how the pass will use it: a `directory`
 *     spec must not already be a file (the `mkdir` would EEXIST); a `file` spec
 *     must not already be a directory (the write/read would EISDIR); and a
 *     non-directory intermediate component (ENOTDIR) is rejected. Mismatches map
 *     to `CONFIG_ERROR`.
 *
 * Both run BEFORE the caller's first persistent side effect (the `--model` pin,
 * a file write, an orphan unlink), so a path-containment OR type failure aborts
 * with NO mutation — never a half-applied run that pinned the model and then
 * failed the mkdir/write. (Runtime faults during the real write — ENOSPC, a
 * concurrent change — are out of scope; this guarantees only that a *containment
 * or type* problem is caught before any mutation.) Nothing is mutated here.
 */
export async function assertAdapterWritePathsContained(
  cwd: string,
  specs: Iterable<AdapterWritePathSpec>,
): Promise<ResolvedAdapterWritePathSpec[]> {
  const resolved: ResolvedAdapterWritePathSpec[] = [];
  for (const { path, kind } of specs) {
    assertSafeRelativePathImpl(path);

    let abs: string;
    try {
      abs = await resolveSymlinkFreeProjectPath(cwd, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "PATH_OUTSIDE_PROJECT")
        throw err;
      // ENOTDIR (a non-directory component blocks the path) or any other resolve
      // failure means a write here cannot succeed: a CONFIG_ERROR, not exit 3.
      throw configError(
        `adapter write path "${path}" is not usable: ${(err as Error).message}`,
      );
    }

    // Type check the FINAL entry (follow symlinks — containment already vetted).
    let st: import("node:fs").Stats;
    try {
      st = await stat(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // not-yet-created — valid for file & directory
        resolved.push({ path, kind, absPath: abs });
        continue;
      }
      // ENOTDIR (intermediate component is a file), EACCES, etc.
      throw configError(
        `adapter write path "${path}" cannot be used (${code ?? "unreadable"})`,
      );
    }
    if (kind === "directory" && !st.isDirectory()) {
      throw configError(
        `adapter directory "${path}" already exists but is not a directory`,
      );
    }
    if (kind === "file" && !st.isFile()) {
      // Reject a directory AND any non-regular file (FIFO / socket / device):
      // a later readFile on a FIFO BLOCKS forever waiting for a writer, which —
      // after the --model pin — would hang the command with the pin stranded.
      // (stat followed the symlink, so a symlink → regular file is still a file.)
      throw configError(
        `adapter file path "${path}" already exists but is not a regular file`,
      );
    }
    resolved.push({ path, kind, absPath: abs });
  }
  return resolved;
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

/**
 * Upgrade plan desired state, extended to cover unverifiable files whose
 * content cannot be compared (dynamic existing, unowned, unsafe).
 */
export type AdapterUpgradePlanDesiredState = DesiredFileState | "unverifiable";

/**
 * Stable machine-readable reason for a non-obvious action in upgrade plans.
 */
export type AdapterUpgradeReason =
  | "managed_modified"
  | "unowned_generated_path"
  | "symlink_traversal"
  | "dynamic_file_unverifiable"
  | "unowned_orphan_not_pruned";

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
  | "prune" // delete a managed-clean file the generator no longer emits (orphan cleanup on upgrade)
  | "warn"; // non-blocking advisory: no mutation on this file, but the run continues.
//   Can occur in both --check and --write (e.g. an existing dynamic
//   file that cannot be read/hashed, or an unowned orphan kept on disk).

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
 *  - `install` is initial setup. It re-renders a `managed-clean × stale` file
 *    (`update`) — the file is verbatim generator output, so refreshing it is
 *    safe and avoids trusting a project-shipped manifest to keep stale (or
 *    forged) generated content. `managed-modified × current` stays `skip`
 *    (benign hash drift), and `managed-clean × current` is `skip`, keeping a
 *    no-change re-install idempotent. `managed-modified × stale` is **`refuse`d**
 *    (not overwritten — possible local edit — but not silently skipped either:
 *    the content matches neither the manifest nor the generator, a divergence
 *    install surfaces rather than passing over).
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
    // desired === "stale" → safe update. Includes INSTALL: a project ships the
    // manifest, so trusting a manifest hash to keep a stale generated file lets
    // a forged manifest (hash matching shipped malicious content) survive
    // install untouched. A managed-clean file is by definition unmodified
    // relative to its manifest entry, so overwriting it with the current
    // generator output destroys no user edits — and self-heals poisoned
    // instructions. (managed-MODIFIED × stale is still refused/skipped below,
    // so genuine local edits are never clobbered.)
    return "update";
  }

  // managed-modified (the only remaining local state)
  if (desired === "current") {
    // hash drift but content matches current desired — manifest-only update
    if (mode === "install") return "skip";
    return "update_manifest";
  }

  // managed-modified × stale: the on-disk content matches NEITHER the manifest
  // hash NOR the current generator output. install REFUSES (does not overwrite —
  // it could be a genuine local edit) but must NOT silently skip: on a fresh
  // clone of a hostile repo it cannot tell a user edit from attacker-shipped
  // content, so the divergence is surfaced rather than passed over in silence.
  // Overwriting requires the explicit `upgrade --write --accept-modified`.
  if (mode === "install") return "refuse";
  if (mode === "upgrade-check") return "refuse";
  return acceptModified ? "update" : "refuse";
}
