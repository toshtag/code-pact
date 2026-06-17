import { bindBundleMember } from "./archive-bundle-binding.ts";
import { reconcileLooseAndBundle, type BundleMemberIndex } from "./archive-bundle-index.ts";
import type { ArchiveBundleKind } from "../schemas/archive-bundle.ts";

// ---------------------------------------------------------------------------
// The ONE shared loose ∪ bundle resolver every archive reader routes through, so
// the two resolution MODES (archive-level-compaction-rfc.md) stay identical across
// readers instead of each re-implementing loose-vs-bundle handling and drifting:
//
//   - `reader-loose-wins` (every READ path): a present loose record satisfies the
//     request and the bundle store is NOT loaded for that id — loose-wins
//     short-circuit. The bundle is consulted ONLY when loose is absent. This keeps
//     the loose-only path unchanged AND isolates it: an unrelated corrupt bundle
//     elsewhere in the store can never fail a healthy loose resolution.
//   - `strict-reconcile` (bundle writer/readback, the delete-time gate, explicit
//     verify): loads BOTH sides and enforces the byte-identical invariant
//     (`bundle_stale` fail-closed) — where a loose+bundle disagreement is caught.
//
// MODE decides WHEN the bundle is loaded; the caller's POSTURE decides WHAT to do
// when a loaded bundle FAILS validation: this resolver THROWS the bundle-integrity
// fault (`ARCHIVE_BUNDLE_INVALID` from the lazy index load / `bindBundleMember` /
// reconcile) and the caller maps it — fail-closed strict (referenced resolution) or
// fail-soft lenient (advisory/discovery). A loose-read invalidity is RETURNED as
// `invalid`, not thrown (it is not a bundle fault). `bindBundleMember` self-binds
// the bundle member (schema + id↔internal-identity + canonical bytes), but it is NOT
// full authority binding — the caller still runs its own kind-specific authority
// checks (roadmap identity / snapshot_sha256 / requested canonical_ref) on the bytes.
// ---------------------------------------------------------------------------

const ARCHIVE_BUNDLE_STORE_LABEL = ".code-pact/state/archive/bundles";

/** Raw loose-record bytes off disk, before any parsing. `invalid` (present but
 *  unreadable / unsafe path) is NEVER collapsed to `absent`. */
export type RawLooseRecord =
  | { kind: "absent" }
  | { kind: "invalid"; error: unknown }
  | { kind: "present"; bytes: string };

export type ResolveMode = "reader-loose-wins" | "strict-reconcile";

export type ResolvedArchiveRecord =
  | { kind: "absent" } // neither loose nor bundle has the id
  | { kind: "invalid"; error: unknown } // the loose record is present but unreadable
  | { kind: "resolved"; bytes: string; source: "loose" | "bundle" };

export type ResolveArchiveRecordOpts = {
  kind: ArchiveBundleKind;
  /** The bundle member id (phase_id for snapshot/pack; stem-hash for a decision). */
  id: string;
  mode: ResolveMode;
  /** Phase ids named by a PENDING delete-intent (a phase_snapshot↔event_pack pair
   *  mid-deletion). A record whose id is in this set reads as LOGICALLY ABSENT, so
   *  no reader observes the crash→recovery half-state. Decisions are never in the
   *  journal (it is keyed by phase_id), so the filter applies only to
   *  phase_snapshot / event_pack. Omit (or empty) when there is no pending intent. */
  pendingAbsentIds?: ReadonlySet<string>;
  /** Read the loose record's raw bytes (absent / invalid / present). */
  readLooseRaw: () => Promise<RawLooseRecord> | RawLooseRecord;
  /** Build the cross-bundle index. LAZY: invoked only when the bundle store must be
   *  consulted (loose absent for `reader-loose-wins`; always for `strict-reconcile`),
   *  so a present loose record never pays for — nor is failed by — bundle loading.
   *  MAY THROW `ARCHIVE_BUNDLE_INVALID` (Tier-1 / duplicate_member_conflict). */
  loadBundleIndex: () => BundleMemberIndex;
};

/**
 * Resolve one archived record's canonical bytes from loose ∪ bundle per `mode`.
 * Returns absent / invalid / resolved. THROWS `ARCHIVE_BUNDLE_INVALID` on a
 * bundle-integrity fault (lazy index load / `bindBundleMember` / `reconcile`) — the
 * caller maps that throw to its posture. See the module header.
 */
export async function resolveArchiveRecordBytes(
  opts: ResolveArchiveRecordOpts,
): Promise<ResolvedArchiveRecord> {
  // A phase_snapshot / event_pack named in a pending delete-intent is mid-deletion
  // (its pair is being removed both-or-neither). Until recovery completes it, every
  // reader treats it as LOGICALLY ABSENT — so the transient half-state (one file
  // already unlinked) is never read as archive truth. Decisions are never pending.
  if (opts.kind !== "decision_record" && opts.pendingAbsentIds?.has(opts.id)) {
    return { kind: "absent" };
  }
  const loose = await opts.readLooseRaw();
  if (loose.kind === "invalid") return { kind: "invalid", error: loose.error };

  if (opts.mode === "reader-loose-wins") {
    // Loose wins: a present loose record is the answer; the bundle is never loaded
    // for this id (isolation from an unrelated corrupt/stale bundle).
    if (loose.kind === "present") return { kind: "resolved", bytes: loose.bytes, source: "loose" };
    // Loose absent → consult the bundle store (lazy load).
    const entry = opts.loadBundleIndex().get(opts.kind)?.get(opts.id) ?? null;
    if (entry == null) return { kind: "absent" };
    bindBundleMember(
      opts.kind,
      { id: opts.id, sha256: entry.sha256, bytes: entry.bytes },
      ARCHIVE_BUNDLE_STORE_LABEL,
    );
    return { kind: "resolved", bytes: entry.bytes, source: "bundle" };
  }

  // strict-reconcile: load BOTH sides and enforce the byte-identical invariant.
  const looseBytes = loose.kind === "present" ? loose.bytes : null;
  const entry = opts.loadBundleIndex().get(opts.kind)?.get(opts.id) ?? null;
  if (entry != null) {
    bindBundleMember(
      opts.kind,
      { id: opts.id, sha256: entry.sha256, bytes: entry.bytes },
      ARCHIVE_BUNDLE_STORE_LABEL,
    );
  }
  const canonical = reconcileLooseAndBundle(opts.id, looseBytes, entry, ARCHIVE_BUNDLE_STORE_LABEL);
  if (canonical == null) return { kind: "absent" };
  return { kind: "resolved", bytes: canonical, source: looseBytes != null ? "loose" : "bundle" };
}
