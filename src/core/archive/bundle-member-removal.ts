import { readFileSync } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ArchiveBundle, ArchiveBundleKind } from "../schemas/archive-bundle.ts";
import { loadArchiveBundles } from "./archive-bundle-loader.ts";
import { computeMemberIdsSha256 } from "./archive-bundle-reader.ts";
import { buildArchiveBundle, serializeArchiveBundle, verifyBundleReadback } from "./archive-bundle-writer.ts";
import { bindBundleMember } from "./archive-bundle-binding.ts";
import { looseStillAuthorityValid } from "./archive-retention.ts";
import { DeleteIntentDurabilityError, fsyncDirRequired } from "./delete-intent-journal.ts";
import {
  archiveBundlePath,
  archiveBundlesDir,
  archiveDecisionsDir,
  archiveEventPacksDir,
  archivePhasesDir,
  sha256Hex,
} from "./paths.ts";

// ---------------------------------------------------------------------------
// Bundle-member removal — Layer 1: the read-only planner + the destructive
// single-kind apply (supersede-by-removal). A bundle is content-addressed by its
// member-id SET, so a member cannot be edited out in place — removal = rebuild the
// kind's consolidated bundle from (current members − removed), DURABLY write it,
// then retire the old bundle(s). See design/decisions/bundle-member-removal-rfc.md.
//
// AUTHORITY: a member EXISTING in the Tier-1 index is NOT "an authority-valid record
// of this id" — the class retention learned (#472). So EVERY current member of the
// kind is re-validated (`bindBundleMember` self-bind + the kind's identity check);
// if ANY is authority-invalid, the kind is fail-closed — never silently rebuilt
// (a rebuild that keeps a corrupt survivor, or retires a misfiled member's bundle,
// can't be proven safe). Repair the corrupt member (`state compact-archive`) first.
//
// The planner (read-only) and the apply share ONE authority source — `computeRemoval`
// — so the dry-run plan and the write can never drift.
// ---------------------------------------------------------------------------

// --- shared authority computation (the single source for plan AND apply) -----

type RetireTarget = { file: string; sha256: string; member_ids_sha256: string; member_ids: string[] };

type RemovalComputation = {
  kind: ArchiveBundleKind;
  removable: string[];
  not_member: string[];
  invalid: string[];
  survivors: string[];
  /** the built consolidated new bundle (with bytes), or null (empty-set or no-op). */
  new_bundle: ArchiveBundle | null;
  retire: RetireTarget[];
  unsafe: boolean;
};

/** A bundle member is a trustworthy removal/keep authority only if it self-binds AND passes its
 *  kind's identity check — Tier-1 index presence is not enough. */
function memberAuthorityValid(kind: ArchiveBundleKind, id: string, bytes: string): boolean {
  try {
    bindBundleMember(kind, { id, sha256: sha256Hex(bytes), bytes }, "(bundle member removal authority)");
    return looseStillAuthorityValid(kind, id, bytes);
  } catch {
    return false;
  }
}

function computeRemoval(cwd: string, kind: ArchiveBundleKind, removeIds: readonly string[]): RemovalComputation {
  const { index, bundles } = loadArchiveBundles(cwd); // STRICT — a corrupt store throws (fail-closed)
  const members = index.get(kind) ?? new Map<string, { sha256: string; bytes: string }>();
  const removeSet = new Set(removeIds);

  const not_member = [...removeSet].filter((id) => !members.has(id)).sort();
  // A rebuild touches every member, so a single authority-invalid member makes the kind unprovable.
  const invalid = [...members.keys()].filter((id) => !memberAuthorityValid(kind, id, members.get(id)!.bytes)).sort();
  if (invalid.length > 0) {
    return { kind, removable: [], not_member, invalid, survivors: [...members.keys()].sort(), new_bundle: null, retire: [], unsafe: true };
  }

  const removable = [...removeSet].filter((id) => members.has(id)).sort();
  const survivors = [...members.keys()].filter((id) => !removeSet.has(id)).sort();

  // Nothing removable → a pure no-op (never consolidate as a side effect of a removal verb).
  if (removable.length === 0) {
    return { kind, removable, not_member, invalid: [], survivors, new_bundle: null, retire: [], unsafe: false };
  }

  const new_bundle = survivors.length > 0 ? buildArchiveBundle(kind, survivors.map((id) => ({ id, bytes: members.get(id)!.bytes }))) : null;
  const keepFile = new_bundle ? basename(archiveBundlePath(cwd, kind, new_bundle.member_ids_sha256)) : null;

  const retire: RetireTarget[] = bundles
    .filter((b) => b.loaded.kind === kind && basename(b.file) !== keepFile)
    .map((b) => ({
      file: basename(b.file),
      sha256: sha256Hex(readFileSync(join(archiveBundlesDir(cwd), basename(b.file)), "utf8")), // the on-disk raw bytes
      member_ids_sha256: computeMemberIdsSha256(b.loaded.members.map((m) => m.id)),
      member_ids: b.loaded.members.map((m) => m.id),
    }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  return { kind, removable, not_member, invalid: [], survivors, new_bundle, retire, unsafe: false };
}

// --- read-only planner -------------------------------------------------------

/** An existing bundle file the apply would retire, with the EXACT bytes the plan saw (the apply
 *  re-reads + confirms this hash before the unlink — delete exactly the planned bytes). */
export type RetireBundle = RetireTarget;

export type BundleMemberRemovalPlan = {
  kind: ArchiveBundleKind;
  /** `removeIds` that ARE authority-valid current members → actually removable. */
  removable: string[];
  /** `removeIds` that are NOT a current member → a reported no-op. */
  not_member: string[];
  /** current members that FAIL authority re-validation → the kind is fail-closed (`unsafe`). */
  invalid: string[];
  /** surviving member ids (current members − removable), sorted. */
  survivors: string[];
  /** the consolidated bundle the apply would write (`addr(survivors)`), or `null` (empty-set / no-op). */
  new_bundle: { file: string; member_ids_sha256: string; sha256: string } | null;
  /** existing bundle files the apply would retire, with their expected bytes. */
  retire_bundles: RetireBundle[];
  /** when true, a current member is authority-invalid → the apply does NOTHING for the kind. */
  unsafe: boolean;
};

/** READ-ONLY plan of removing `removeIds` from `kind`'s bundle store — mutates nothing, loads STRICT. */
export function planBundleMemberRemoval(cwd: string, kind: ArchiveBundleKind, removeIds: readonly string[]): BundleMemberRemovalPlan {
  const c = computeRemoval(cwd, kind, removeIds);
  return {
    kind: c.kind,
    removable: c.removable,
    not_member: c.not_member,
    invalid: c.invalid,
    survivors: c.survivors,
    new_bundle: c.new_bundle
      ? { file: basename(archiveBundlePath(cwd, kind, c.new_bundle.member_ids_sha256)), member_ids_sha256: c.new_bundle.member_ids_sha256, sha256: sha256Hex(serializeArchiveBundle(c.new_bundle)) }
      : null,
    retire_bundles: c.retire,
    unsafe: c.unsafe,
  };
}

// --- destructive apply -------------------------------------------------------

/** One removed member's outcome: `deleted` (no copy of the record resolves anymore) or
 *  `bundle_member_removed` (a loose copy still resolves — the loose layer drops it next run). */
export type RemovedMember = { id: string; outcome: "deleted" | "bundle_member_removed" };

export type BundleMemberRemovalOutcome = {
  kind: ArchiveBundleKind;
  removed: RemovedMember[];
  not_member: string[];
  /** the kind was left UNTOUCHED because a current member is authority-invalid. */
  unsafe_invalid: string[];
  /** retire-bundle files SKIPPED because their on-disk bytes no longer matched the plan. */
  skipped_stale: string[];
};

/** Test seam: fired before each retire-bundle re-read/unlink (inject a swap / failure). */
export type BundleRemovalHooks = { beforeRetire?: (file: string) => Promise<void> | void };

/**
 * Apply a single-kind bundle-member removal DESTRUCTIVELY (supersede-by-removal). DURABLY writes the
 * consolidated new bundle (fsync DATA + DIR) BEFORE retiring any old bundle, then retires each old
 * bundle through a re-read-expected-bytes gate, then fsyncs the directory. The order
 * (new-bundle-durable ≤ any old-retire-durable) is the crash-safety: until the retire is durable the
 * removed member still resolves from the old bundle, so a power loss converges on a re-run. Run under
 * the write lock. An authority-invalid kind is left untouched.
 */
export async function removeBundleMembers(
  cwd: string,
  kind: ArchiveBundleKind,
  removeIds: readonly string[],
  hooks: BundleRemovalHooks = {},
): Promise<BundleMemberRemovalOutcome> {
  const c = computeRemoval(cwd, kind, removeIds); // re-run the authority (never a stale caller plan)
  if (c.unsafe) return { kind, removed: [], not_member: c.not_member, unsafe_invalid: c.invalid, skipped_stale: [] };
  if (c.removable.length === 0) return { kind, removed: [], not_member: c.not_member, unsafe_invalid: [], skipped_stale: [] };

  const dir = archiveBundlesDir(cwd);

  // 1. DURABLY write the consolidated new bundle (if any survivors) BEFORE any retire.
  if (c.new_bundle) await durablyWriteBundle(cwd, kind, c.new_bundle);

  // 2. Retire each old bundle through the expected-bytes gate, then make the removal durable.
  const skipped_stale: string[] = [];
  let retiredAny = false;
  for (const rb of c.retire) {
    if (hooks.beforeRetire) await hooks.beforeRetire(rb.file);
    const abs = join(dir, basename(rb.file));
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // already gone — idempotent
      throw err;
    }
    if (sha256Hex(raw) !== rb.sha256) {
      skipped_stale.push(rb.file); // swapped under us → never retire on a stale proof
      continue;
    }
    await unlink(abs);
    retiredAny = true;
  }
  if (retiredAny) await fsyncDirRequired(dir, "bundle_retire"); // make the removal durable

  // 3. Per-record outcome: a removed member that still has a loose copy is `bundle_member_removed`.
  const removed: RemovedMember[] = [];
  for (const id of c.removable) {
    const hasLoose = await pathExists(join(looseDirFor(cwd, kind), `${id}.json`));
    removed.push({ id, outcome: hasLoose ? "bundle_member_removed" : "deleted" });
  }
  return { kind, removed, not_member: c.not_member, unsafe_invalid: [], skipped_stale };
}

/** Durably write a built content-addressed bundle: write temp → fsync DATA → rename → fsync DIR →
 *  readback-verify. No-op if the target already holds the byte-identical bundle (the keep). */
async function durablyWriteBundle(cwd: string, kind: ArchiveBundleKind, bundle: ArchiveBundle): Promise<void> {
  const path = archiveBundlePath(cwd, kind, bundle.member_ids_sha256);
  const bytes = serializeArchiveBundle(bundle);
  if (await pathExists(path)) {
    if ((await readFile(path, "utf8")) === bytes) return; // already the keep — idempotent
    throw new Error(`bundle-member removal: a different bundle already exists at ${basename(path)}`);
  }
  const dir = archiveBundlesDir(cwd);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(bytes, "utf8");
    await fh.sync(); // MANDATORY: fsync the DATA before it can be renamed into place
  } catch (err) {
    await fh.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw new DeleteIntentDurabilityError("failed", `new bundle temp write/fsync failed: ${(err as Error).message}`);
  }
  try {
    await fh.close(); // a close failure after fsync is still a durability fault (the data may not be flushed)
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw new DeleteIntentDurabilityError("failed", `new bundle temp close failed: ${(err as Error).message}`);
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await fsyncDirRequired(dir, "bundle_write"); // REQUIRED: make the rename durable BEFORE any retire
  verifyBundleReadback(await readFile(path, "utf8"), kind, bundle.members, basename(path)); // re-read + verify
}

function looseDirFor(cwd: string, kind: ArchiveBundleKind): string {
  return kind === "phase_snapshot" ? archivePhasesDir(cwd) : kind === "event_pack" ? archiveEventPacksDir(cwd) : archiveDecisionsDir(cwd);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const fh = await open(path, "r");
    await fh.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
