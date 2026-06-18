import { z } from "zod";
import { PlanId } from "./plan-id.ts";
import { Sha256Hex } from "./phase-snapshot.ts";

// ---------------------------------------------------------------------------
// Retention DELETE-INTENT journal (write-ahead log for a crash-safe pair delete).
//
// A `phase_snapshot` and its `event_pack` are mutually bound (the pack carries
// the snapshot's `snapshot_sha256`; the snapshot's progress_events evidence
// resolves from the pack), so they must be deleted both-or-neither. A filesystem
// cannot unlink two files atomically, so the intent journal IS the commit point:
// once it is durably on disk, the pair is logically deleted, and recovery rolls a
// committed-but-incomplete deletion FORWARD (completes the deletes idempotently),
// never backward. See design/decisions/retention-pair-delete-journal-rfc.md and
// design/decisions/bundle-member-removal-rfc.md (the bundle-pair extension).
//
// schema_version 2 adds an `intent_kind` DISCRIMINATOR so one journal can carry
// BOTH a LOOSE pair (two loose files unlinked) AND a BUNDLE pair (two old bundles
// retired after their reduced replacements are durably written). The two recovery
// authorities are different — a loose pair's digests are loose-FILE digests; a
// bundle pair's are old-bundle / new-bundle digests — so they are distinct shapes
// under one union, and recovery branches on `intent_kind`.
//
// All digests are DIAGNOSTIC for a loose pair (recovery never re-gates a loose
// delete — it must COMPLETE) but a SAFETY RE-VERIFY input for a bundle pair
// (recovery confirms the new bundle still covers the survivors and the old bundle
// still matches its expected hash before retiring it).
//
// Unknown-keys policy: STRICT (house convention; future fields via a version bump).
// ---------------------------------------------------------------------------

export const DELETE_INTENT_SCHEMA_VERSION = 2 as const;

// --- loose pair (the #474 shape, now tagged) --------------------------------

/** One committed LOOSE pair deletion: the loose phase snapshot AND the loose event
 *  pack share `phase_id`; their on-disk paths are derived from it. `phase_sha256` /
 *  `pack_sha256` are the bytes the delete gate validated at commit — DIAGNOSTIC /
 *  audit only (recovery does NOT re-gate; a delete intent must COMPLETE). */
export const LoosePairIntent = z.strictObject({
  intent_kind: z.literal("loose_pair"),
  phase_id: PlanId,
  phase_sha256: Sha256Hex,
  pack_sha256: Sha256Hex,
});
export type LoosePairIntent = z.infer<typeof LoosePairIntent>;

// --- bundle pair (the bundle-member-removal extension) ----------------------

/** A bundle FILE name as the recovery authority sees it: a `bundles/` basename, the
 *  content-addressed `<kind>-<16hex>.json` form the writer emits. Constrained (not a
 *  bare string) because the journal is a recovery authority that `join(dir, file)`s and
 *  re-reads this name — a hand-edited / traversal name must read as corrupt, not be opened. */
export const BundleFileName = z.string().regex(/^(phase_snapshot|event_pack|decision_record)-[0-9a-f]{16}\.json$/);

/** An old bundle a retire must remove, with the exact bytes digest the commit saw —
 *  recovery RE-READS the bundle and confirms this hash before the unlink (delete
 *  exactly the planned bytes). `file` is the basename under `bundles/`. */
export const BundleRetireTarget = z.strictObject({
  file: BundleFileName,
  sha256: Sha256Hex,
});
export type BundleRetireTarget = z.infer<typeof BundleRetireTarget>;

/** The reduced replacement bundle a kind's removal writes (content-addressed by the
 *  survivor id SET), carrying BOTH the set address and the raw bytes digest so
 *  recovery can re-verify it covers the survivors byte-identically. `null` is the
 *  EMPTY-SET marker: the kind had no survivors → the old bundle is just deleted. */
export const BundlePairNewBundle = z.strictObject({
  file: BundleFileName,
  member_ids_sha256: Sha256Hex,
  sha256: Sha256Hex,
});
export type BundlePairNewBundle = z.infer<typeof BundlePairNewBundle>;

/** One kind's half of a bundle pair: the member ids removed from this kind, the old
 *  bundle(s) that held them (an ARRAY — a redundant / pre-consolidation store can
 *  have several), and the reduced replacement bundle (or the empty-set marker). */
export const BundlePairMember = z.strictObject({
  removed_ids: z.array(PlanId).min(1),
  old_bundles: z.array(BundleRetireTarget).min(1),
  new_bundle: BundlePairNewBundle.nullable(),
});
export type BundlePairMember = z.infer<typeof BundlePairMember>;

/** One committed BUNDLE pair deletion: the phase_snapshot bundle member AND its
 *  event_pack bundle member are removed both-or-neither, by retiring each kind's old
 *  bundle(s) after the reduced replacements are durable. `phase_id` keys the pair
 *  (the same id names both members). */
export const BundlePairIntent = z.strictObject({
  intent_kind: z.literal("bundle_pair"),
  phase_id: PlanId,
  members: z.strictObject({
    phase_snapshot: BundlePairMember,
    event_pack: BundlePairMember,
  }),
});
export type BundlePairIntent = z.infer<typeof BundlePairIntent>;

// --- the journal ------------------------------------------------------------

/** One committed pair deletion — a loose pair OR a bundle pair. Both are keyed by
 *  `phase_id`; recovery branches on `intent_kind`. A given `phase_id` appears AT MOST
 *  ONCE across the whole journal (a phase is one pair, loose XOR bundle — never both in
 *  one run); `readDeleteIntent` rejects a duplicate `phase_id` as corrupt. */
export const DeleteIntentRecord = z.discriminatedUnion("intent_kind", [LoosePairIntent, BundlePairIntent]);
export type DeleteIntentRecord = z.infer<typeof DeleteIntentRecord>;

export const DeleteIntent = z.strictObject({
  schema_version: z.literal(DELETE_INTENT_SCHEMA_VERSION),
  intents: z.array(DeleteIntentRecord).min(1),
});
export type DeleteIntent = z.infer<typeof DeleteIntent>;
