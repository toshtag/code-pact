import { readdir, readFile, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { resolveWithinProject } from "../path-safety.ts";
import type { ArchiveBundleKind } from "../schemas/archive-bundle.ts";
import { loadArchiveBundles } from "./archive-bundle-loader.ts";
import { bindBundleMember } from "./archive-bundle-binding.ts";
import { validateEventPackTier1 } from "./event-pack-reader.ts";
import { reconcileLooseAndBundle, type BundleMemberIndex } from "./archive-bundle-index.ts";
import {
  assertLooseMemberValid,
  BundleWriteError,
  enumerateLooseMembers,
  writeArchiveBundle,
  type BundleWriteOutcome,
  type LooseMember,
} from "./archive-bundle-writer.ts";
import {
  ARCHIVE_BUNDLES_DIR_SEGMENTS,
  ARCHIVE_DECISIONS_DIR_SEGMENTS,
  ARCHIVE_EVENT_PACKS_DIR_SEGMENTS,
  ARCHIVE_PHASES_DIR_SEGMENTS,
  archiveBundlePath,
  archiveDecisionsDir,
  archiveEventPacksDir,
  archivePhasesDir,
} from "./paths.ts";
import { computeMemberIdsSha256 } from "./archive-bundle-reader.ts";

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
  /** loose ids not yet in any bundle — would be folded into the consolidated bundle. */
  would_bundle: string[];
  /** loose ids a verified bundle already holds byte-identically — would be deleted. */
  would_delete: string[];
  /** loose ids that cannot be acted on (bundle bytes differ / member invalid). */
  would_skip: ArchiveDeleteSkip[];
  /** existing bundle files the consolidated bundle would supersede (and retire). */
  would_retire_bundles: string[];
};

/**
 * READ-ONLY plan of what {@link compactArchive} would do for `kind`: which loose records
 * would be folded into the consolidated bundle (would_bundle), which loose records a
 * bundle already holds byte-identically (would_delete), which cannot be acted on
 * (would_skip: bundle_stale / member_invalid), and which existing bundle files the
 * consolidation would retire (would_retire_bundles). No mutation. STRICT load — a corrupt
 * store throws (the same fault the write path fails closed on).
 */
export async function planCompactArchive(
  cwd: string,
  kind: ArchiveBundleKind,
): Promise<CompactArchivePlan> {
  const { index, bundles } = loadArchiveBundles(cwd);
  const loose = await enumerateLooseMembers(cwd, kind);
  const would_bundle: string[] = [];
  const would_delete: string[] = [];
  const would_skip: ArchiveDeleteSkip[] = [];
  for (const m of loose) {
    const entry = index.get(kind)?.get(m.id) ?? null;
    if (entry == null) {
      // Would be folded into the consolidated bundle — validate it the SAME way the
      // writer would, so the dry-run never promises a would_bundle the write path would
      // fail to build (throws BundleWriteError("build"), fail-fast, like compactArchive).
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

  // The consolidated bundle's id set = existing members ∪ the new loose to fold; any OTHER
  // existing bundle of this kind would be retired by the consolidation.
  const allIds = [...(index.get(kind)?.keys() ?? []), ...would_bundle];
  const would_retire_bundles =
    allIds.length === 0
      ? []
      : (() => {
          const consolidatedFile = join("bundles", basename(archiveBundlePath(cwd, kind, computeMemberIdsSha256(allIds))));
          return bundles
            .filter((b) => b.loaded.kind === kind && b.file !== consolidatedFile)
            .map((b) => b.file);
        })();

  return { kind, would_bundle, would_delete, would_skip, would_retire_bundles };
}

export type CompactArchiveOutcome = {
  kind: ArchiveBundleKind;
  /** The single CONSOLIDATED bundle for the kind (written / noop_already_bundled /
   *  noop_no_members) — all of the kind's members folded into one. */
  bundle: BundleWriteOutcome;
  /** Old bundle files retired because the consolidated bundle now supersedes them
   *  (every member present byte-identically). Bounds the bundle file count. */
  retired_bundles: string[];
  /** Loose deletions (records the consolidated bundle now holds). */
  delete: ArchiveDeleteOutcome;
};

/** Gather the kind's full member set = existing bundle members ∪ loose, reconciled.
 *  A loose that DIVERGES from a same-id bundle member is bundle_stale → kept OUT of the
 *  consolidation (and the delete gate later skips it, fail-closed). */
function gatherConsolidatedMembers(
  index: BundleMemberIndex,
  kind: ArchiveBundleKind,
  loose: readonly LooseMember[],
): LooseMember[] {
  const byId = new Map<string, string>();
  const existing = index.get(kind);
  if (existing) for (const [id, e] of existing) byId.set(id, e.bytes);
  for (const lm of loose) {
    const have = byId.get(lm.id);
    if (have !== undefined) {
      // already a member; a byte-diff is bundle_stale → don't overwrite (keep bundle's).
      continue;
    }
    byId.set(lm.id, lm.bytes);
  }
  return [...byId].map(([id, bytes]) => ({ id, bytes }));
}

/** Retire every bundle file of `kind` EXCEPT `keepFile`, once the on-disk KEEP bundle
 *  holds all of that bundle's members byte-identically — so no truth is lost. The delete
 *  AUTHORITY is the freshly-loaded, Tier-1-validated `keepFile` bundle itself (NOT a
 *  caller-supplied map): a `keepById` is built from its members, and a bundle is retired
 *  only when every member is present in `keepById` byte-identically. The keep bundle MUST
 *  exist (and match `kind`) in the just-loaded store; if it is gone we throw rather than
 *  delete on a vanished authority (in `compactArchive` it was written + readback-verified
 *  immediately before, so its absence here is an abnormal race). TOCTOU + path-safe; a
 *  bundle whose member is missing/diverges from the keep bundle is SKIPPED (kept). */
export async function retireSupersededBundles(
  cwd: string,
  kind: ArchiveBundleKind,
  keepFile: string,
): Promise<string[]> {
  const { bundles } = loadArchiveBundles(cwd);
  const keep = bundles.find((b) => b.file === keepFile && b.loaded.kind === kind);
  if (!keep) {
    throw new BundleWriteError(
      "verify_bundle",
      true,
      `consolidated bundle ${keepFile} is not present at retire time — refusing to retire on a vanished authority`,
    );
  }
  const keepById = new Map(keep.loaded.members.map((m) => [m.id, m.bytes] as const));

  const retired: string[] = [];
  for (const { file, loaded } of bundles) {
    if (loaded.kind !== kind || file === keepFile) continue;
    const allCovered = loaded.members.every((m) => keepById.get(m.id) === m.bytes);
    if (!allCovered) continue; // fail-closed: keep a bundle the keep bundle doesn't fully cover
    let abs: string;
    try {
      abs = await resolveWithinProject(cwd, [...ARCHIVE_BUNDLES_DIR_SEGMENTS, basename(file)].join("/"));
    } catch {
      continue; // unsafe path → never unlink
    }
    try {
      await unlink(abs);
      retired.push(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // ENOENT → already gone
    }
  }
  return retired;
}

/**
 * Fold + CONSOLIDATE + drop, so repeated runs converge to ONE bundle per kind IN A
 * HEALTHY STORE (the bundle file count stays bounded; a `bundle_stale` loose / an
 * uncovered bundle / a fail-closed survivor is left in place to protect truth, by
 * design): gather the kind's full member set (existing bundle
 * members ∪ new loose), write it as a SINGLE consolidated bundle, retire the now-
 * superseded smaller bundles, then delete every loose record the consolidated bundle
 * holds. CRASH-SAFE by ordering: the consolidated bundle is written + verified BEFORE
 * any old bundle is retired (a crash leaves both, with byte-identical overlapping members
 * the cross-bundle uniqueness rule tolerates — a re-run reconverges). Loads STRICT — a
 * corrupt bundle store throws before any write/delete. Run under a write lock. A
 * `bundle_stale` loose (diverged from a member) is neither consolidated nor deleted.
 */
export async function compactArchive(
  cwd: string,
  kind: ArchiveBundleKind,
): Promise<CompactArchiveOutcome> {
  const index: BundleMemberIndex = loadArchiveBundles(cwd).index;
  const loose = await enumerateLooseMembers(cwd, kind);
  const members = gatherConsolidatedMembers(index, kind, loose);

  // ONE consolidated bundle holding every member (content-addressed by the full id set:
  // an unchanged set re-writes to the same file → noop; a grown set → a new file).
  const bundle = await writeArchiveBundle(cwd, kind, members);

  // Retire the smaller bundles the consolidated one now supersedes (AFTER it is on disk
  // + verified). Skip when nothing was consolidated (no members).
  let retired: string[] = [];
  if (bundle.kind === "written" || bundle.kind === "noop_already_bundled") {
    // The retire authority is the on-disk consolidated bundle itself, re-loaded +
    // Tier-1-validated inside retireSupersededBundles — not the in-memory `members`.
    retired = await retireSupersededBundles(cwd, kind, bundle.bundleFile);
  }

  const del = await deleteLooseCoveredByBundle(cwd, kind);
  return { kind, bundle, retired_bundles: retired, delete: del };
}
