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
// committed-but-incomplete deletion FORWARD (completes the unlinks idempotently),
// never backward. See design/decisions/retention-pair-delete-journal-rfc.md.
//
// `phase_sha256` / `pack_sha256` are the bytes the delete gate validated at commit
// — DIAGNOSTIC / audit only. Recovery does NOT re-gate on them: a delete intent
// must COMPLETE, never skip (a skip would leave a permanent half-state).
//
// Unknown-keys policy: STRICT (house convention; future fields via a version bump).
// ---------------------------------------------------------------------------

export const DELETE_INTENT_SCHEMA_VERSION = 1 as const;

/** One committed pair deletion: the loose phase snapshot AND the loose event pack
 *  share `phase_id`; their on-disk paths are derived from it. */
export const DeleteIntentPair = z.strictObject({
  phase_id: PlanId,
  phase_sha256: Sha256Hex,
  pack_sha256: Sha256Hex,
});
export type DeleteIntentPair = z.infer<typeof DeleteIntentPair>;

export const DeleteIntent = z.strictObject({
  schema_version: z.literal(DELETE_INTENT_SCHEMA_VERSION),
  pairs: z.array(DeleteIntentPair).min(1),
});
export type DeleteIntent = z.infer<typeof DeleteIntent>;
