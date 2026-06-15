import { z } from "zod";
import { Sha256Hex } from "./phase-snapshot.ts";

// ---------------------------------------------------------------------------
// Archive bundle — `.code-pact/state/archive/bundles/<kind>-<hash>.json`.
//
// A bundle folds N per-item archive records of ONE kind (phase snapshots, event
// packs, or decision records) into one committed file, so the archive's loose
// per-item records (`state/archive/{phases,event-packs,decisions}/*.json`) can be
// deleted without losing them. Readers resolve a record from `loose ∪ bundle
// members`, exactly as the durable ledger resolves `loose events ∪ event-packs`
// (see event-pack-compaction-rfc.md) — this is that pattern one level up
// (archive-level-compaction-rfc.md). Bundling COMPACTS the retained set; the
// archive's BOUND comes from retention/prune, not from bundling.
//
// A bundle is a SHARED, COMMITTED control record → STRICT unknown-keys (an
// unrecognized field is a drifted/foreign record, not forward-compat data; future
// fields arrive via a schema_version bump).
//
// IMPORTANT — a member stores its source record's CANONICAL BYTES VERBATIM (the
// exact text the per-item writer emits: stable key order / 2-space indent /
// trailing newline) plus `sha256` of those bytes. Hashing the stored verbatim
// bytes (NOT a re-serialization) is the single source, so newline / key-order /
// spacing can never drift a member hash. `member_ids_sha256` is a member-SET
// self-consistency checksum (like event_ids_sha256), NOT tamper-detection — real
// safety is Tier-1 (this self/bijection check) + Tier-2 per-member binding to its
// own authority (a later layer).
// ---------------------------------------------------------------------------

export const ARCHIVE_BUNDLE_SCHEMA_VERSION = 1 as const;

/** Which kind of per-item archive record this bundle folds. */
export const ArchiveBundleKind = z.enum(["phase_snapshot", "event_pack", "decision_record"]);
export type ArchiveBundleKind = z.infer<typeof ArchiveBundleKind>;

/**
 * One bundled archive record. `bytes` is the member record's canonical serialized
 * text verbatim; `sha256` is `sha256Hex(bytes)`. The reader re-validates
 * `sha256 === sha256Hex(bytes)` (Tier-1) so the manifest cannot drift from the
 * body it carries, and parses `bytes` with the member's own schema (Tier-2).
 */
export const BundledRecord = z.strictObject({
  /**
   * The member id within its kind: a phase id (`P12`) for `phase_snapshot` /
   * `event_pack`, or the decision record stem (`<stem>-<hash8>`) for
   * `decision_record`. Tier-1 only requires a non-empty, in-bundle-unique string;
   * the id↔authority format is checked in Tier-2 binding.
   */
  id: z.string().min(1),
  /** `sha256Hex` of `bytes` (the per-item writer's canonical output). */
  sha256: Sha256Hex,
  /** The member record's canonical serialized bytes, verbatim (UTF-8 JSON text). */
  bytes: z.string().min(1),
});
export type BundledRecord = z.infer<typeof BundledRecord>;

export const ArchiveBundle = z.strictObject({
  schema_version: z.literal(ARCHIVE_BUNDLE_SCHEMA_VERSION),
  kind: ArchiveBundleKind,
  /**
   * `sha256Hex(JSON.stringify(memberIdsSortedAscending))` — a member-SET
   * self-consistency checksum decided over the sorted id list (NOT the bytes), the
   * `event_ids_sha256` analogue. Cross-bundle global uniqueness (the same id must
   * not appear in two bundles with different bytes) is a reader-level rule, not a
   * field here.
   */
  member_ids_sha256: Sha256Hex,
  members: z.array(BundledRecord).min(1),
});
export type ArchiveBundle = z.infer<typeof ArchiveBundle>;
