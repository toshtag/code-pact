import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProgressEvent } from "../../src/core/schemas/progress-event.ts";
import type { EventPack, PackedEvent } from "../../src/core/schemas/event-pack.ts";
import { EVENT_PACK_SCHEMA_VERSION } from "../../src/core/schemas/event-pack.ts";
import { computeEventId, atCompact, eventFileName } from "../../src/core/progress/event-id.ts";
import { computeEventIdsSha256 } from "../../src/core/archive/event-pack-reader.ts";
import {
  eventPackPath,
  phaseSnapshotPath,
  sha256Hex,
} from "../../src/core/archive/paths.ts";

/**
 * Build a VALID `EventPack` object for `phaseId` from a set of events, binding
 * it to the on-disk snapshot's raw bytes. Tests then write it as-is (valid) or
 * tamper with a field to exercise a specific fail-closed path.
 */
export async function buildValidEventPack(
  cwd: string,
  phaseId: string,
  events: ProgressEvent[],
): Promise<EventPack> {
  const snapshotRaw = await readFile(phaseSnapshotPath(cwd, phaseId), "utf8");
  const packed: PackedEvent[] = events
    .map((event) => ({ id: computeEventId(event), file: eventFileName(event), event }))
    .sort((a, b) => {
      const aAt = atCompact(a.event.at);
      const bAt = atCompact(b.event.at);
      return aAt < bAt ? -1 : aAt > bAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const eventIdsSha256 = computeEventIdsSha256(
    packed.map((p) => ({ event: p.event, id: p.id, file: p.file })),
  );
  return {
    schema_version: EVENT_PACK_SCHEMA_VERSION,
    phase_id: phaseId,
    snapshot_sha256: sha256Hex(snapshotRaw),
    event_ids_sha256: eventIdsSha256,
    events: packed,
  };
}

/** Write an event pack object to its on-disk path (creating the dir). */
export async function writeEventPackFile(
  cwd: string,
  phaseId: string,
  pack: EventPack | Record<string, unknown>,
): Promise<void> {
  const path = eventPackPath(cwd, phaseId);
  await mkdir(join(cwd, ".code-pact", "state", "archive", "event-packs"), { recursive: true });
  await writeFile(path, JSON.stringify(pack, null, 2) + "\n", "utf8");
}
