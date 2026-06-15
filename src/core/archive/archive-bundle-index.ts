import type { ArchiveBundleKind } from "../schemas/archive-bundle.ts";
import {
  archiveBundleError,
  type LoadedArchiveBundle,
} from "./archive-bundle-reader.ts";

// ---------------------------------------------------------------------------
// Archive-bundle resolution PRIMITIVES (Layer 1c-i) — PURE, no I/O, NOT yet wired
// into any reader. Two pieces the wiring layer (1c-ii) will use:
//
//   1. `buildBundleMemberIndex` — fold Tier-1-loaded bundles into a per-kind
//      id→member index, enforcing CROSS-BUNDLE GLOBAL UNIQUENESS: the same id in
//      two bundles with the SAME sha256 dedupes (a redundant copy is fine); with a
//      DIFFERENT sha256 it fails closed (`duplicate_member_conflict`) — never
//      "pick one". (archive-level-compaction-rfc.md, Blocker-3.)
//   2. `reconcileLooseAndBundle` — the STRICT-RECONCILE primitive: resolve ONE id
//      from `loose ∪ bundle` when BOTH sides are deliberately loaded, requiring a
//      loose record AND a bundle member for the id to be byte-identical, else
//      `bundle_stale` (fail closed). This is NOT a "every reader must call it"
//      primitive — its callers are the contexts where loose and bundle copies
//      legitimately coexist and must agree: the bundle WRITER + READBACK, the
//      `state compact-archive` DELETE-TIME GATE (before any loose unlink), and
//      explicit archive-bundle VERIFY. A normal READ path uses loose-wins instead:
//      a present loose record satisfies the request and the bundle is consulted
//      ONLY when loose is absent, so the reader never calls this and never observes
//      `bundle_stale` (isolating a healthy loose record from an unrelated stale
//      bundle). The two postures are `reader-loose-wins` vs `strict-reconcile` in
//      archive-level-compaction-rfc.md.
//
// NOTE these resolve to a record's BYTES only. A caller parses those bytes with the
// member's schema AND combines `bindBundleMember`'s self-binding with the EXISTING
// reader-side authority checks (roadmap identity / snapshot_sha256 / requested
// canonical_ref) — `bindBundleMember` alone is NOT full authority binding.
// ---------------------------------------------------------------------------

export type BundleIndexEntry = { sha256: string; bytes: string };
export type BundleMemberIndex = Map<ArchiveBundleKind, Map<string, BundleIndexEntry>>;

/**
 * Build the per-kind id→member index across all Tier-1-loaded bundles, fail-closed
 * on a cross-bundle id collision with differing bytes.
 */
export function buildBundleMemberIndex(
  bundles: readonly { file: string; loaded: LoadedArchiveBundle }[],
): BundleMemberIndex {
  const index: BundleMemberIndex = new Map();
  for (const { file, loaded } of bundles) {
    let kindMap = index.get(loaded.kind);
    if (!kindMap) {
      kindMap = new Map();
      index.set(loaded.kind, kindMap);
    }
    for (const m of loaded.members) {
      const existing = kindMap.get(m.id);
      if (existing) {
        if (existing.sha256 !== m.sha256) {
          throw archiveBundleError(
            `member id "${m.id}" appears in more than one ${loaded.kind} bundle with different bytes (duplicate_member_conflict)`,
            file,
          );
        }
        continue; // identical bytes → redundant duplicate, deterministically deduped
      }
      kindMap.set(m.id, { sha256: m.sha256, bytes: m.bytes });
    }
  }
  return index;
}

/**
 * STRICT-RECONCILE resolution of one id's canonical bytes from `loose ∪ bundle`,
 * for callers that deliberately load BOTH sides (bundle writer/readback, the
 * `state compact-archive` delete-time gate, explicit verify) — NOT normal read
 * paths, which use loose-wins and skip the bundle when a loose record is present.
 * A loose record wins; when both a loose record AND a bundle member exist they must
 * be byte-identical, else `bundle_stale` (fail closed — never silently prefer one).
 * Returns `null` when neither side has the id (the caller decides whether that
 * absence is a real missing-truth fault per its own authority).
 */
export function reconcileLooseAndBundle(
  id: string,
  looseBytes: string | null,
  bundleEntry: BundleIndexEntry | null,
  file: string,
): string | null {
  if (looseBytes != null && bundleEntry != null) {
    if (looseBytes !== bundleEntry.bytes) {
      throw archiveBundleError(
        `loose record and a bundle member for "${id}" differ (bundle_stale) — they must be byte-identical`,
        file,
      );
    }
    return looseBytes;
  }
  return looseBytes ?? bundleEntry?.bytes ?? null;
}
