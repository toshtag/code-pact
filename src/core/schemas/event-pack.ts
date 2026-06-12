import { z } from "zod";
import { PlanId } from "./plan-id.ts";
import { Sha256Hex } from "./phase-snapshot.ts";
import { ProgressEvent } from "./progress-event.ts";

// ---------------------------------------------------------------------------
// Event pack — `.code-pact/state/archive/event-packs/<phase-id>.json`.
//
// A pack holds the compacted per-event ledger for an ARCHIVED phase: every
// progress event (ALL statuses — started/blocked/resumed/done/failed) for every
// task_id the phase owns, moved out of the loose per-event ledger
// (`.code-pact/state/events/*.yaml`) into one committed file so the loose files
// can be deleted without losing provenance. The reader merges packed events back
// into the progress log exactly as it merges loose files, deduped by event id.
//
// A pack is a SHARED, COMMITTED control record (like a phase snapshot), so the
// unknown-keys policy is STRICT: an unrecognized field is a drifted/foreign
// record, not forward-compat data. Future fields arrive via a schema_version
// bump, never via implicit passthrough.
//
// IMPORTANT — `event_ids_sha256` is an event-SET self-consistency checksum, NOT
// independent tamper-detection (a hand-editor who rewrites `events` can
// recompute it). Real safety is the layered gate the reader applies: strict
// schema + per-entry validation (filename↔content bijection via the same
// `computeEventId`/`eventFileName` invariant the loose files use) + the
// snapshot binding (`snapshot_sha256`, phase_id, task membership) + evidence
// resolution + semantic replay. `event_ids_sha256` only decides pack-vs-loose
// state identity for the compaction idempotency table.
// ---------------------------------------------------------------------------

/**
 * One packed event: the event body plus its content id and original loose
 * filename. The reader re-validates `id === computeEventId(event)` and
 * `file === eventFileName(event)` directly (no YAML round-trip), so these fields
 * cannot drift from the body they describe.
 */
export const PackedEvent = z.strictObject({
  /** The content-derived id — equals `computeEventId(event)` and the filename suffix. */
  id: Sha256Hex,
  /** The original loose-event basename `<at-compact>-<id>.yaml` (basename only). */
  file: z
    .string()
    .min(1)
    .refine(
      (s) => !/[/\\\x00]/.test(s) && /^\d{8}T\d{9}Z-[0-9a-f]{64}\.yaml$/.test(s),
      "must be a valid event-file basename (no path separators, no NUL, matches event-file pattern)",
    ),
  /** The full validated event body. */
  event: ProgressEvent,
});
export type PackedEvent = z.infer<typeof PackedEvent>;

export const EVENT_PACK_SCHEMA_VERSION = 1 as const;

export const EventPack = z.strictObject({
  schema_version: z.literal(EVENT_PACK_SCHEMA_VERSION),
  phase_id: PlanId,
  /**
   * sha256 of the raw bytes of the phase snapshot JSON that authorized this
   * compaction — the identity binding. The reader recomputes it against the
   * on-disk snapshot and refuses a pack whose snapshot drifted.
   */
  snapshot_sha256: Sha256Hex,
  /**
   * sha256 of the deterministically-ordered event-id LIST (NOT the bodies, NOT
   * YAML bytes): sort by (atCompact, id), then `sha256Hex(JSON.stringify(ids))`.
   * Decides pack-vs-loose state identity for the compaction idempotency table.
   */
  event_ids_sha256: Sha256Hex,
  events: z.array(PackedEvent).min(1),
});
export type EventPack = z.infer<typeof EventPack>;
