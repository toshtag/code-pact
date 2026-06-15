import { readdir, readFile, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { resolveWithinProject } from "../path-safety.ts";
import type { ArchiveBundleKind } from "../schemas/archive-bundle.ts";
import { loadArchiveBundles } from "./archive-bundle-loader.ts";
import { bindBundleMember } from "./archive-bundle-binding.ts";
import { validateEventPackTier1 } from "./event-pack-reader.ts";
import { reconcileLooseAndBundle, type BundleMemberIndex } from "./archive-bundle-index.ts";
import {
  assertLooseMemberValid,
  enumerateLooseMembers,
  writeArchiveBundle,
  type BundleWriteOutcome,
} from "./archive-bundle-writer.ts";
import {
  ARCHIVE_DECISIONS_DIR_SEGMENTS,
  ARCHIVE_EVENT_PACKS_DIR_SEGMENTS,
  ARCHIVE_PHASES_DIR_SEGMENTS,
  archiveDecisionsDir,
  archiveEventPacksDir,
  archivePhasesDir,
} from "./paths.ts";

// ---------------------------------------------------------------------------
// Archive-bundle GATED DELETE (Layer 3) — the destructive step that finally drops
// the loose archive file count. It removes a loose archive record ONLY once it is
// safely captured in a verified bundle (byte-identical), re-checked immediately
// before each unlink (TOCTOU), mirroring the event-pack Layer-3 delete discipline.
//
// Because EVERY archive reader resolves loose ∪ bundle (Layer 1) and the event-pack
// compaction path now resolves its snapshot from loose ∪ bundle too (this layer's
// prerequisite), deleting a loose record that a verified bundle already holds strands
// nothing — every consumer falls back to the bundle. So the gate is UNIFORM across
// kinds: path-in-project, a fresh re-read, and byte-identity to a Tier-1+Tier-2-bound
// bundle member. A loose record NOT yet captured (no bundle member, or a member whose
// bytes differ — `bundle_stale`) is a per-record SKIP, never deleted (fail-closed).
//
// `compactArchive` is the redundant-bundle-safe driver: it bundles only the loose
// records not already in a bundle, then deletes everything a bundle now covers — so
// re-running never grows a duplicate bundle.
//
// TOCTOU threat model (explicit): the gate re-reads the loose file immediately before
// deciding, and the unlink targets the gate-resolved abs path. This proves LOGICAL
// safety just before unlink; it does NOT close the tiny gate→unlink window against an
// adversarial same-path replacement (the loose store is not a hostile-input boundary).
// Callers MUST run this under the repo write lock (Layer 4's verb does) so no concurrent
// code-pact mutation races it; the threat model is accidental races, not an attacker.
// ---------------------------------------------------------------------------

const ARCHIVE_BUNDLE_STORE_LABEL = ".code-pact/state/archive/bundles";

function looseDirFor(cwd: string, kind: ArchiveBundleKind): string {
  return kind === "phase_snapshot"
    ? archivePhasesDir(cwd)
    : kind === "event_pack"
      ? archiveEventPacksDir(cwd)
      : archiveDecisionsDir(cwd);
}

function looseRelPath(kind: ArchiveBundleKind, name: string): string {
  const segments =
    kind === "phase_snapshot"
      ? ARCHIVE_PHASES_DIR_SEGMENTS
      : kind === "event_pack"
        ? ARCHIVE_EVENT_PACKS_DIR_SEGMENTS
        : ARCHIVE_DECISIONS_DIR_SEGMENTS;
  return [...segments, name].join("/");
}

export type ArchiveDeleteSkipReason =
  | "path_escape" // resolveWithinProject rejected the path (`..` / symlink escape)
  | "unreadable" // the loose file is present but could not be read
  | "not_in_bundle" // no bundle member covers this id → not safely captured
  | "bundle_member_invalid" // the covering bundle member failed Tier-2 self-bind
  | "bundle_stale" // loose bytes ≠ the bundle member's bytes → not safely captured
  | "unlink_failed"; // a non-ENOENT failure during the unlink itself

export type ArchiveDeleteSkip = { id: string; reason: ArchiveDeleteSkipReason; detail?: string };

export type ArchiveDeleteOutcome = {
  kind: ArchiveBundleKind;
  /** ids whose loose file was unlinked (captured in a verified bundle). */
  deleted: string[];
  /** ids already gone at gate / unlink time (ENOENT) — not survivors, not deleted. */
  vanished: string[];
  /** ids kept because they could not be proven safe to delete (per-record reason). */
  skipped: ArchiveDeleteSkip[];
  /** true once any unlink happened (paired with a non-empty `deleted`). */
  partial_applied: boolean;
  /** present loose records that survived the run (re-enumerated after deletes). */
  remaining_loose: number;
};

type DeleteVerdict =
  | { disposition: "delete"; abs: string }
  | { disposition: "vanished" }
  | { disposition: "skip"; reason: ArchiveDeleteSkipReason; detail?: string };

/** Re-verify, at delete time, that ONE loose record is safe to unlink: path-in-project,
 *  re-readable, and byte-identical to a Tier-2-bound bundle member. Reads disk fresh
 *  (TOCTOU); performs NO unlink. */
async function evaluateRecordDeleteGate(
  cwd: string,
  kind: ArchiveBundleKind,
  name: string,
  index: BundleMemberIndex,
): Promise<DeleteVerdict> {
  const id = basename(name, ".json");
  let abs: string;
  try {
    abs = await resolveWithinProject(cwd, looseRelPath(kind, name));
  } catch {
    return { disposition: "skip", reason: "path_escape" };
  }
  let looseBytes: string;
  try {
    looseBytes = await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { disposition: "vanished" };
    return { disposition: "skip", reason: "unreadable", detail: (err as Error).message };
  }
  const entry = index.get(kind)?.get(id) ?? null;
  if (!entry) return { disposition: "skip", reason: "not_in_bundle" };
  // Tier-2 self-bind the covering member, then assert loose ≡ bundle byte-for-byte.
  // For event_pack, ALSO run full Tier-1 (per-entry bijection / order / event_ids_sha256)
  // — bindBundleMember only checks schema + canonical + id, so a byte-identical pair of
  // semantically-invalid event-pack bytes must NOT be a deletion authority.
  try {
    bindBundleMember(kind, { id, sha256: entry.sha256, bytes: entry.bytes }, ARCHIVE_BUNDLE_STORE_LABEL);
    if (kind === "event_pack") validateEventPackTier1(id, entry.bytes, ARCHIVE_BUNDLE_STORE_LABEL);
  } catch (err) {
    return { disposition: "skip", reason: "bundle_member_invalid", detail: (err as Error).message };
  }
  try {
    reconcileLooseAndBundle(id, looseBytes, entry, ARCHIVE_BUNDLE_STORE_LABEL);
  } catch (err) {
    return { disposition: "skip", reason: "bundle_stale", detail: (err as Error).message };
  }
  return { disposition: "delete", abs };
}

export type ArchiveDeleteHooks = {
  /** Invoked just before each per-record gate (test seam for injecting races). */
  beforeGate?: (id: string) => Promise<void> | void;
  /** Invoked after a gate says "delete" but before the unlink (test seam). */
  beforeUnlink?: (id: string) => Promise<void> | void;
};

/**
 * Delete every loose record of `kind` that a VERIFIED bundle already holds
 * byte-identically. Gated per-record at delete time (TOCTOU); a record not safely
 * captured is skipped, never deleted. Two failure granularities (don't conflate them):
 * a **Tier-1-corrupt bundle STORE** throws from `loadArchiveBundles` BEFORE any unlink
 * (whole-run fail-closed — nothing deleted); a **per-member** fault (Tier-2 bind /
 * event_pack Tier-1 / loose≠bundle bytes) is a per-record SKIP that leaves that record
 * but does not block deleting other safely-captured records. Run under a write lock.
 */
export async function deleteLooseCoveredByBundle(
  cwd: string,
  kind: ArchiveBundleKind,
  hooks: ArchiveDeleteHooks = {},
): Promise<ArchiveDeleteOutcome> {
  // Load the bundle store STRICT, BEFORE any unlink. A corrupt bundle → throw, so we
  // never delete a loose record we cannot prove is captured.
  const { index } = loadArchiveBundles(cwd);

  const dir = looseDirFor(cwd, kind);
  let names: string[];
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    names = dirents.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind, deleted: [], vanished: [], skipped: [], partial_applied: false, remaining_loose: 0 };
    }
    throw err;
  }

  const deleted: string[] = [];
  const vanished: string[] = [];
  const skipped: ArchiveDeleteSkip[] = [];
  for (const name of names) {
    const id = basename(name, ".json");
    if (hooks.beforeGate) await hooks.beforeGate(id);
    const verdict = await evaluateRecordDeleteGate(cwd, kind, name, index);
    if (verdict.disposition === "vanished") {
      vanished.push(id);
      continue;
    }
    if (verdict.disposition === "skip") {
      skipped.push({ id, reason: verdict.reason, detail: verdict.detail });
      continue;
    }
    if (hooks.beforeUnlink) await hooks.beforeUnlink(id);
    try {
      await unlink(verdict.abs);
      deleted.push(id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") vanished.push(id);
      else skipped.push({ id, reason: "unlink_failed", detail: (err as Error).message });
    }
  }

  // Reconcile: re-enumerate present loose records — the survivors (kept = not deleted).
  let remaining = 0;
  try {
    const after = await readdir(dir, { withFileTypes: true });
    remaining = after.filter((e) => e.isFile() && e.name.endsWith(".json")).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return { kind, deleted, vanished, skipped, partial_applied: deleted.length > 0, remaining_loose: remaining };
}

export type CompactArchivePlan = {
  kind: ArchiveBundleKind;
  /** loose ids not yet in any bundle — would be folded into a new bundle. */
  would_bundle: string[];
  /** loose ids a verified bundle already holds byte-identically — would be deleted. */
  would_delete: string[];
  /** loose ids that cannot be acted on (bundle bytes differ / member invalid). */
  would_skip: ArchiveDeleteSkip[];
};

/**
 * READ-ONLY plan of what {@link compactArchive} would do for `kind`: partition the
 * loose records into would-bundle (not yet in a bundle), would-delete (a bundle holds
 * them byte-identically), and would-skip (a same-id bundle member differs / is invalid).
 * No mutation. The bundle store is loaded STRICT — a corrupt store throws (the dry-run
 * surfaces the same fault the write path would fail-closed on).
 */
export async function planCompactArchive(
  cwd: string,
  kind: ArchiveBundleKind,
): Promise<CompactArchivePlan> {
  const index = loadArchiveBundles(cwd).index;
  const loose = await enumerateLooseMembers(cwd, kind);
  const would_bundle: string[] = [];
  const would_delete: string[] = [];
  const would_skip: ArchiveDeleteSkip[] = [];
  for (const m of loose) {
    const entry = index.get(kind)?.get(m.id) ?? null;
    if (entry == null) {
      // Would be folded into a new bundle — validate it the SAME way the writer would,
      // so the dry-run never promises a would_bundle the write path would fail to build.
      // An unfoldable loose record THROWS BundleWriteError("build") here, exactly as
      // `compactArchive` would (fail-fast — an invalid archive record is a corruption,
      // not a skip-and-continue).
      assertLooseMemberValid(kind, m);
      would_bundle.push(m.id);
      continue;
    }
    // Mirror the delete gate's member validation so the dry-run cannot promise a
    // would_delete the write path would actually skip as bundle_member_invalid.
    try {
      bindBundleMember(kind, { id: m.id, sha256: entry.sha256, bytes: entry.bytes }, ARCHIVE_BUNDLE_STORE_LABEL);
      if (kind === "event_pack") validateEventPackTier1(m.id, entry.bytes, ARCHIVE_BUNDLE_STORE_LABEL);
    } catch (err) {
      would_skip.push({ id: m.id, reason: "bundle_member_invalid", detail: (err as Error).message });
      continue;
    }
    if (entry.bytes === m.bytes) {
      would_delete.push(m.id);
      continue;
    }
    would_skip.push({ id: m.id, reason: "bundle_stale" });
  }
  return { kind, would_bundle, would_delete, would_skip };
}

export type CompactArchiveOutcome = {
  kind: ArchiveBundleKind;
  bundle: BundleWriteOutcome;
  delete: ArchiveDeleteOutcome;
};

/**
 * Fold + drop in one redundant-bundle-safe pass: bundle ONLY the loose records of
 * `kind` not already in a bundle, then delete every loose record a verified bundle
 * now covers. Re-running never grows a duplicate bundle (already-bundled records are
 * deleted, not re-bundled; a `bundle_stale` record is neither re-bundled nor deleted —
 * it is surfaced as a delete skip, fail-closed). Run under a write lock.
 */
export async function compactArchive(
  cwd: string,
  kind: ArchiveBundleKind,
): Promise<CompactArchiveOutcome> {
  // Partition: bundle only loose records whose id is NOT already covered by a bundle.
  // A loose id already in a bundle is left for the delete step (byte-identical → drop;
  // byte-different → bundle_stale skip). Load STRICT and fail-closed: a corrupt bundle
  // store throws HERE — before we write a new bundle on top of it (which could become a
  // duplicate_member_conflict once the operator repairs the corrupt one) and before any
  // delete. (An ABSENT store is fine — loadArchiveBundles returns an empty index.)
  const index: BundleMemberIndex = loadArchiveBundles(cwd).index;
  const loose = await enumerateLooseMembers(cwd, kind);
  const toBundle = loose.filter((m) => !index.get(kind)?.has(m.id));
  const bundle = await writeArchiveBundle(cwd, kind, toBundle);
  const del = await deleteLooseCoveredByBundle(cwd, kind);
  return { kind, bundle, delete: del };
}
