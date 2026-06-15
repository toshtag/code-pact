import { readdir, readFile, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { resolveWithinProject } from "../path-safety.ts";
import type { ArchiveBundleKind } from "../schemas/archive-bundle.ts";
import { loadArchiveBundles } from "./archive-bundle-loader.ts";
import { bindBundleMember } from "./archive-bundle-binding.ts";
import { validateEventPackTier1 } from "./event-pack-reader.ts";
import { reconcileLooseAndBundle, type BundleMemberIndex } from "./archive-bundle-index.ts";
import {
  buildArchiveBundle,
  BundleWriteError,
  enumerateLooseMembers,
  serializeArchiveBundle,
  supersedeArchiveBundle,
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
  sha256Hex,
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
  /** loose ids that DIVERGE from their (single) bundle member and are safely adoptable —
   *  the bundle member would be SUPERSEDED with the fresher loose bytes, then the loose
   *  deleted. (A diverging loose whose member is held by a redundant survivor bundle, or
   *  whose fresh bytes are not foldable, stays in would_skip as bundle_stale.) */
  would_supersede: string[];
  /** loose ids that cannot be acted on (bundle bytes differ and not adoptable / member invalid). */
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
  const p = await buildCompactionPlan(cwd, kind);
  // Drop the apply-only fields (consolidated_members / has_adoption) — the dry-run surface.
  return {
    kind: p.kind,
    would_bundle: p.would_bundle,
    would_delete: p.would_delete,
    would_supersede: p.would_supersede,
    would_skip: p.would_skip,
    would_retire_bundles: p.would_retire_bundles,
  };
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

/** One loose record's PER-MEMBER eligibility in a compaction (before the global adoption
 *  gate). `supersede` here is a CANDIDATE — {@link buildCompactionPlan} decides whether the
 *  store shape lets it be adopted this run. */
type LooseDisposition =
  | { action: "bundle" } // not yet bundled → fold into the consolidated bundle
  | { action: "delete" } // a bundle already holds it byte-identically → loose is redundant
  | { action: "supersede" } // diverges from its bundle member, fresh bytes foldable → adopt candidate
  | { action: "skip"; reason: ArchiveDeleteSkipReason; detail?: string };

/**
 * Classify ONE loose record against the bundle store. A diverging loose (loose bytes ≠ its
 * bundle member) is a SUPERSESSION candidate when both the COVERING bundle member is a valid
 * authority AND the fresh loose bytes are themselves foldable (never adopt garbage). Whether a
 * candidate is actually adopted this run is decided globally in {@link buildCompactionPlan}
 * (the in-place supersede is only safe as a pure same-id-set replace of a single bundle).
 */
function classifyLooseMember(index: BundleMemberIndex, kind: ArchiveBundleKind, m: LooseMember): LooseDisposition {
  const entry = index.get(kind)?.get(m.id) ?? null;
  if (entry == null) return { action: "bundle" };
  // The covering bundle member must itself be a valid authority (Tier-2 self-bind, + event_pack
  // Tier-1) — mirror the delete gate so the dry-run cannot promise an action the gate rejects.
  try {
    bindBundleMember(kind, { id: m.id, sha256: entry.sha256, bytes: entry.bytes }, ARCHIVE_BUNDLE_STORE_LABEL);
    if (kind === "event_pack") validateEventPackTier1(m.id, entry.bytes, ARCHIVE_BUNDLE_STORE_LABEL);
  } catch (err) {
    return { action: "skip", reason: "bundle_member_invalid", detail: (err as Error).message };
  }
  if (entry.bytes === m.bytes) return { action: "delete" };
  // DIVERGING → supersession candidate. The fresh loose must be foldable to adopt it.
  try {
    bindBundleMember(kind, { id: m.id, sha256: sha256Hex(m.bytes), bytes: m.bytes }, "loose record");
    if (kind === "event_pack") validateEventPackTier1(m.id, m.bytes, "loose record");
  } catch (err) {
    return { action: "skip", reason: "bundle_stale", detail: `fresh loose not foldable: ${(err as Error).message}` };
  }
  return { action: "supersede" };
}

/** A compaction plan PLUS the apply-only fields — the single source of truth both the dry-run
 *  ({@link planCompactArchive}) and the apply ({@link compactArchive}) drive off, so they
 *  cannot drift. */
type CompactionPlan = CompactArchivePlan & {
  /** the member set the consolidated bundle should hold (loose-wins for adopted supersedes). */
  consolidated_members: LooseMember[];
  /** true when ≥1 member is adopted → the write must SUPERSEDE the stale bundle in place,
   *  not fail closed on the (intentional) divergence. */
  has_adoption: boolean;
};

/**
 * Build the shared compaction plan for `kind`: classify each loose record, then apply the
 * GLOBAL adoption gate. An in-place supersede is only safe as a pure same-id-set replace of a
 * single bundle — exactly one bundle of the kind AND nothing new to fold this run. Otherwise
 * the consolidated id set would either grow to a NEW content address (which still conflicts
 * with the old bundle's old member bytes) or face a redundant survivor — both need
 * retire-before-replace (a later layer). So when the store shape is not adoption-safe, the
 * diverging candidates are DEFERRED as `bundle_stale` skips; the consolidation still folds +
 * retires + converges, so a later run (single bundle, nothing to fold) adopts them. STRICT
 * load — a corrupt store throws (the same fault the write path fails closed on).
 */
async function buildCompactionPlan(cwd: string, kind: ArchiveBundleKind): Promise<CompactionPlan> {
  const { index, bundles } = loadArchiveBundles(cwd);
  const loose = await enumerateLooseMembers(cwd, kind);

  const would_bundle: string[] = [];
  const would_delete: string[] = [];
  const would_skip: ArchiveDeleteSkip[] = [];
  const supersedeCandidates: string[] = [];
  for (const m of loose) {
    const d = classifyLooseMember(index, kind, m);
    if (d.action === "bundle") would_bundle.push(m.id);
    else if (d.action === "delete") would_delete.push(m.id);
    else if (d.action === "supersede") supersedeCandidates.push(m.id);
    else would_skip.push({ id: m.id, reason: d.reason, detail: d.detail });
  }

  // GLOBAL adoption gate: an in-place supersede is only safe as a pure same-id-set replace of a
  // SINGLE bundle that already sits at its OWN content address — then the consolidated bundle
  // (same id set, since nothing new is folded) targets that exact path and the supersede is an
  // atomic in-place replace with no other bundle to conflict. A misnamed/legacy single bundle
  // (not at its content address) would instead make the consolidated write CREATE at the content
  // address while the old file survives → conflict; defer it (the loose stays as bundle_stale).
  const kindBundles = bundles.filter((b) => b.loaded.kind === kind);
  const only = kindBundles.length === 1 ? kindBundles[0] : undefined;
  let canAdopt = false;
  if (only && would_bundle.length === 0) {
    const caPath = archiveBundlePath(cwd, kind, computeMemberIdsSha256(only.loaded.members.map((m) => m.id)));
    canAdopt = only.file === join("bundles", basename(caPath));
  }
  const would_supersede: string[] = [];
  if (canAdopt) {
    would_supersede.push(...supersedeCandidates);
  } else {
    for (const id of supersedeCandidates) {
      would_skip.push({
        id,
        reason: "bundle_stale",
        detail: "supersede deferred: consolidate/retire to a single bundle (and fold pending loose) first",
      });
    }
  }
  const adoptIds = new Set(would_supersede);
  const has_adoption = would_supersede.length > 0;

  // Consolidated member set = existing bundle members ∪ loose, loose-wins ONLY for adopted ids.
  const byId = new Map<string, string>();
  const existing = index.get(kind);
  if (existing) for (const [id, e] of existing) byId.set(id, e.bytes);
  for (const m of loose) {
    if (existing?.has(m.id)) {
      if (adoptIds.has(m.id)) byId.set(m.id, m.bytes); // adopt the fresher loose
    } else {
      byId.set(m.id, m.bytes); // fold a new record
    }
  }
  const consolidated_members: LooseMember[] = [...byId].map(([id, bytes]) => ({ id, bytes }));

  // BUILD the exact consolidated bundle the write path would, so the dry-run predicts BUILD
  // faults read-only (a non-canonical / Tier-1-invalid member throws BundleWriteError "build").
  let would_retire_bundles: string[] = [];
  if (consolidated_members.length > 0) {
    const bundle = buildArchiveBundle(kind, consolidated_members);
    const absPath = archiveBundlePath(cwd, kind, bundle.member_ids_sha256);
    const consolidatedFile = join("bundles", basename(absPath));
    let existingBytes: string | null = null;
    try {
      existingBytes = await readFile(absPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new BundleWriteError("write_bundle", false, `existing bundle unreadable: ${(err as Error).message}`);
      }
    }
    // WRITE-conflict prediction: ONLY the non-adoption (create) path fails closed on a divergence
    // (the #467 guard — a non-canonical wrapper loadArchiveBundles tolerates must not be silently
    // overwritten). With adoption the write SUPERSEDES, so a divergence is INTENDED, not a conflict.
    if (!has_adoption && existingBytes !== null && existingBytes !== serializeArchiveBundle(bundle)) {
      throw new BundleWriteError(
        "write_bundle",
        false,
        `a different bundle already exists at ${consolidatedFile} (same id set, different bytes)`,
      );
    }
    would_retire_bundles = bundles
      .filter((b) => b.loaded.kind === kind && b.file !== consolidatedFile)
      .map((b) => b.file);
  }

  return {
    kind,
    would_bundle,
    would_delete,
    would_supersede,
    would_skip,
    would_retire_bundles,
    consolidated_members,
    has_adoption,
  };
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
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // already gone — fine
      // A real retire-phase unlink failure is a destructive-write fault, NOT a corrupt
      // store: surface it as ARCHIVE_BUNDLE_WRITE_FAILED with phase "retire_bundle".
      // partial_applied is always true here — the consolidated bundle is already on disk
      // (and `retired` may already hold earlier removals this run).
      throw new BundleWriteError(
        "retire_bundle",
        true,
        `failed to retire superseded bundle ${file}: ${(err as Error).message}`,
      );
    }
  }
  return retired;
}

/**
 * Fold + CONSOLIDATE + SUPERSEDE + drop, so repeated runs converge to ONE bundle per kind IN
 * A HEALTHY STORE (the bundle file count stays bounded; a fail-closed survivor / deferred
 * supersede / uncovered bundle is left in place to protect truth, by design). Drives off the
 * shared {@link buildCompactionPlan}: gather the kind's full member set (existing bundle
 * members ∪ new loose, with a safely-adoptable diverging loose SUPERSEDING its stale bundle
 * member loose-wins), write it as ONE consolidated bundle, retire the now-superseded smaller
 * bundles, then delete every loose record the consolidated bundle now holds byte-identically.
 *
 * The write is a SUPERSEDE (in-place replace) when a member is being adopted — the consolidated
 * bundle intentionally diverges from the existing one at the same content address — and a plain
 * create/noop otherwise (which keeps writeArchiveBundle's fail-closed-on-divergence guard).
 * Adoption is gated to the safe shape (single bundle, nothing new to fold) in the plan; other
 * diverging loose stay as deferred `bundle_stale` skips until the consolidation converges the
 * store. CRASH-SAFE: the consolidated bundle is written + verified BEFORE any old bundle is
 * retired; a `superseded` write is atomic, leaving the old or new bundle (both valid) on a
 * crash. Loads STRICT — a corrupt bundle store throws before any write/delete. Run under a
 * write lock.
 */
export async function compactArchive(
  cwd: string,
  kind: ArchiveBundleKind,
): Promise<CompactArchiveOutcome> {
  const plan = await buildCompactionPlan(cwd, kind);

  // ONE consolidated bundle holding every member. Adoption (a member's bytes changed under the
  // same content address) requires an in-place SUPERSEDE; otherwise a plain create/noop that
  // keeps writeArchiveBundle's fail-closed-on-divergence guard for an UNINTENDED collision.
  const bundle = plan.has_adoption
    ? await supersedeArchiveBundle(cwd, kind, plan.consolidated_members)
    : await writeArchiveBundle(cwd, kind, plan.consolidated_members);

  // Retire the smaller bundles the consolidated one now supersedes (AFTER it is on disk +
  // verified). Retire whenever a consolidated bundle exists on disk — every write outcome
  // EXCEPT `noop_no_members` (which has no bundleFile and means nothing was consolidated).
  let retired: string[] = [];
  if (bundle.kind !== "noop_no_members") {
    // The retire authority is the on-disk consolidated bundle itself, re-loaded +
    // Tier-1-validated inside retireSupersededBundles — not the in-memory members.
    retired = await retireSupersededBundles(cwd, kind, bundle.bundleFile);
  }

  const del = await deleteLooseCoveredByBundle(cwd, kind);
  return { kind, bundle, retired_bundles: retired, delete: del };
}
