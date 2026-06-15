import { posix } from "node:path";
import { PhaseSnapshot } from "../schemas/phase-snapshot.ts";
import { EventPack } from "../schemas/event-pack.ts";
import { DecisionStateRecord } from "../schemas/decision-state-record.ts";
import type { PhaseSnapshot as PhaseSnapshotT } from "../schemas/phase-snapshot.ts";
import type { EventPack as EventPackT } from "../schemas/event-pack.ts";
import type { DecisionStateRecord as DecisionStateRecordT } from "../schemas/decision-state-record.ts";
import { serializePhaseSnapshot } from "./phase-snapshot.ts";
import { serializeEventPack } from "./event-pack.ts";
import { serializeDecisionRecord } from "./decision-record.ts";
import { pathHash8 } from "./paths.ts";
import { archiveBundleError, type LoadedBundleMember } from "./archive-bundle-reader.ts";
import type { ArchiveBundleKind } from "../schemas/archive-bundle.ts";

// ---------------------------------------------------------------------------
// Archive-bundle Tier-2 per-member binding (Layer 1b). After Tier-1 proves the
// bundle is internally consistent, Tier-2 proves each member is a VALID record of
// the bundle's `kind`, that the member's external `id` equals the record's OWN
// internal identity (never the filename alone), and that the stored `bytes` are
// exactly the per-item writer's canonical output (parse → re-serialize → equal).
// This keeps "canonical bytes" an enforced property, not a writer convention, and
// the [[step4-archive-reader-invariants]] identity discipline holds for members.
// Still NO loose∪bundle wiring (Layer 1c) and NO writes — pure validation.
// ---------------------------------------------------------------------------

/** The decision-record stem-hash identity, derived the SAME way as its filename. */
export function decisionRecordStem(canonicalRef: string): string {
  return `${posix.basename(canonicalRef, ".md")}-${pathHash8(canonicalRef)}`;
}

export type BoundBundleMember =
  | { kind: "phase_snapshot"; id: string; record: PhaseSnapshotT }
  | { kind: "event_pack"; id: string; record: EventPackT }
  | { kind: "decision_record"; id: string; record: DecisionStateRecordT };

/**
 * Bind one Tier-1-loaded member to its kind's authority. Throws
 * `ARCHIVE_BUNDLE_INVALID` on a schema failure, an id↔internal-identity mismatch,
 * or non-canonical bytes (the stored bytes are not `serialize<Kind>(parsed)`).
 */
export function bindBundleMember(
  kind: ArchiveBundleKind,
  member: LoadedBundleMember,
  bundleFile: string,
): BoundBundleMember {
  let parsed: unknown;
  try {
    parsed = JSON.parse(member.bytes);
  } catch (err) {
    throw archiveBundleError(`member "${member.id}" bytes are not valid JSON: ${(err as Error).message}`, bundleFile);
  }

  switch (kind) {
    case "phase_snapshot": {
      const r = PhaseSnapshot.safeParse(parsed);
      if (!r.success) throw archiveBundleError(`member "${member.id}" is not a valid phase_snapshot: ${r.error.message}`, bundleFile);
      assertIdentity(member.id, r.data.phase_id, "phase_id", bundleFile);
      assertCanonical(member, serializePhaseSnapshot(r.data), bundleFile);
      return { kind, id: member.id, record: r.data };
    }
    case "event_pack": {
      const r = EventPack.safeParse(parsed);
      if (!r.success) throw archiveBundleError(`member "${member.id}" is not a valid event_pack: ${r.error.message}`, bundleFile);
      assertIdentity(member.id, r.data.phase_id, "phase_id", bundleFile);
      assertCanonical(member, serializeEventPack(r.data), bundleFile);
      return { kind, id: member.id, record: r.data };
    }
    case "decision_record": {
      const r = DecisionStateRecord.safeParse(parsed);
      if (!r.success) throw archiveBundleError(`member "${member.id}" is not a valid decision_record: ${r.error.message}`, bundleFile);
      assertIdentity(member.id, decisionRecordStem(r.data.canonical_ref), "stem-hash", bundleFile);
      assertCanonical(member, serializeDecisionRecord(r.data), bundleFile);
      return { kind, id: member.id, record: r.data };
    }
  }
}

function assertIdentity(memberId: string, internal: string, field: string, bundleFile: string): void {
  if (memberId !== internal) {
    throw archiveBundleError(
      `member id "${memberId}" does not match its own ${field} "${internal}" — the filename/id must not be trusted over the record's identity`,
      bundleFile,
    );
  }
}

function assertCanonical(member: LoadedBundleMember, reserialized: string, bundleFile: string): void {
  if (reserialized !== member.bytes) {
    throw archiveBundleError(
      `member "${member.id}" bytes are not the per-item writer's canonical output (re-serialization differs)`,
      bundleFile,
    );
  }
}
