import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { EventPack, type PackedEvent } from "../schemas/event-pack.ts";
import type { LoadedEventFile } from "../progress/events-io.ts";
import { parseEventFileName } from "../progress/events-io.ts";
import { atCompact, computeEventId, eventFileName } from "../progress/event-id.ts";
import { archiveEventPacksDir } from "./paths.ts";
import { sha256Hex } from "./paths.ts";

// ---------------------------------------------------------------------------
// Event-pack READER — Tier 1 (cheap, per-load, self-contained).
//
// Tier 1 validates a pack against ITSELF and the filename↔content bijection,
// with NO disk access beyond the pack file and NO snapshot read. It is the
// validation that runs on every progress load. Tier 2 (snapshot binding +
// semantic replay) lives in `event-pack-binding.ts` and runs against an
// in-memory durable map the caller builds — never re-entering the reader.
//
// `readEventPackFiles` returns `LoadedEventPack[]` — each pack with its boundary
// (per-pack `entries`) intact, NOT a flattened event list. The boundary is
// load-bearing: Tier 2 binding resolves each pack's evidence against `loose ∪
// THAT pack's own entries` only, so an unvalidated pack can never prop up
// another pack's evidence. Flattening here would destroy that boundary.
// ---------------------------------------------------------------------------

/** A Tier-1-validated pack with its event boundary intact (per-pack entries). */
export type LoadedEventPack = {
  phaseId: string;
  /** The pack file path, for diagnostics. */
  path: string;
  pack: EventPack;
  /** This pack's events as LoadedEventFile, deduped/validated; pack-local order. */
  entries: LoadedEventFile[];
};

/**
 * Tag an event-pack error with the diagnostic `code` consumers map straight
 * through. `EVENT_PACK_INVALID` covers schema / integrity / per-entry / order /
 * duplicate failures — a strict reader throws it, a lenient reader collects it.
 */
export function eventPackError(message: string, file: string): NodeJS.ErrnoException {
  const err = new Error(`Event pack ${file}: ${message}`) as NodeJS.ErrnoException;
  err.code = "EVENT_PACK_INVALID";
  return err;
}

/**
 * Deterministic event-id-set checksum: sort the events by (atCompact, id), take
 * the id list, and hash `JSON.stringify(ids)`. Hashes the id LIST, not the
 * bodies and not YAML bytes — a flat string array is canonical, and each id is
 * itself a content hash of its event (re-verified per entry), so the id list
 * pins the bodies. This decides pack-vs-loose state identity for the compaction
 * idempotency table; it is NOT independent tamper-detection.
 */
export function computeEventIdsSha256(entries: readonly LoadedEventFile[]): string {
  const ids = [...entries]
    .sort((a, b) => {
      const aAt = atCompact(a.event.at);
      const bAt = atCompact(b.event.at);
      return aAt < bAt ? -1 : aAt > bAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((e) => e.id);
  return sha256Hex(JSON.stringify(ids));
}

/**
 * Validate ONE packed event against the filename↔content bijection — directly,
 * with NO YAML round-trip (the loose-file validator re-serializes to YAML; a
 * pack entry is already a structured object, so coupling to YAML formatting
 * would be wrong here). Checks, fail-closed (`EVENT_PACK_INVALID`):
 *  - `entry.file` is a valid event-file basename;
 *  - `entry.event` is a valid ProgressEvent (schema already ran via
 *    `EventPack.parse`; re-asserted here for defense in depth);
 *  - `computeEventId(event) === entry.id`;
 *  - the id embedded in `entry.file` === `entry.id`;
 *  - `atCompact(event.at)` === the file's at-compact prefix;
 *  - `eventFileName(event)` === `entry.file`.
 * Returns the event as a `LoadedEventFile`, so packed events flow through
 * `mergeProgressStreams` identically to loose files.
 */
export function validatePackedEvent(entry: PackedEvent, packFile: string): LoadedEventFile {
  const name = parseEventFileName(entry.file);
  if (!name) {
    throw eventPackError(`entry.file "${entry.file}" is not a valid event-file basename`, packFile);
  }
  const event = entry.event;
  const computedId = computeEventId(event);
  if (computedId !== entry.id) {
    throw eventPackError(
      `entry.id (${entry.id}) does not match computed content id (${computedId}) for "${entry.file}"`,
      packFile,
    );
  }
  if (name.id !== entry.id) {
    throw eventPackError(
      `entry.file "${entry.file}" embeds id (${name.id}) that differs from entry.id (${entry.id})`,
      packFile,
    );
  }
  if (atCompact(event.at) !== name.atCompact) {
    throw eventPackError(
      `atCompact(event.at)="${atCompact(event.at)}" does not match filename prefix "${name.atCompact}" for "${entry.file}"`,
      packFile,
    );
  }
  const expectedFile = eventFileName(event);
  if (expectedFile !== entry.file) {
    throw eventPackError(
      `eventFileName(event)="${expectedFile}" does not match entry.file "${entry.file}"`,
      packFile,
    );
  }
  return { event, id: entry.id, file: entry.file };
}

/**
 * Tier 1 validation of one pack's raw JSON: strict schema, per-entry
 * `validatePackedEvent`, duplicate-id check, deterministic order, and the
 * `event_ids_sha256` self-consistency check. NO snapshot read (that is Tier 2).
 * Throws `EVENT_PACK_INVALID` on any failure. `fileStem` is the `<phase-id>` the
 * file is named by; the schema's `phase_id` is checked against it (a misfiled
 * pack is rejected before its events are ever trusted).
 */
export function validateEventPackTier1(
  fileStem: string,
  raw: string,
  packFile: string,
): LoadedEventPack {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw eventPackError(`not valid JSON: ${(err as Error).message}`, packFile);
  }
  const result = EventPack.safeParse(parsedJson);
  if (!result.success) {
    throw eventPackError(`failed schema validation: ${result.error.message}`, packFile);
  }
  const pack = result.data;
  if (pack.phase_id !== fileStem) {
    throw eventPackError(
      `pack phase_id "${pack.phase_id}" does not match its filename "${fileStem}.json"`,
      packFile,
    );
  }

  const entries: LoadedEventFile[] = [];
  const seenIds = new Set<string>();
  for (const packed of pack.events) {
    const loaded = validatePackedEvent(packed, packFile);
    if (seenIds.has(loaded.id)) {
      throw eventPackError(`duplicate event id ${loaded.id}`, packFile);
    }
    seenIds.add(loaded.id);
    entries.push(loaded);
  }

  // Deterministic order: the stored `events` must already be sorted by
  // (atCompact, id). A pack that is out of order is rejected, not silently
  // re-sorted — order is part of the record's canonical form.
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const cur = entries[i]!;
    const prevAt = atCompact(prev.event.at);
    const curAt = atCompact(cur.event.at);
    const outOfOrder = prevAt > curAt || (prevAt === curAt && prev.id > cur.id);
    if (outOfOrder) {
      throw eventPackError(
        `events are not in deterministic (atCompact, id) order at index ${i}`,
        packFile,
      );
    }
  }

  // event_ids_sha256 self-consistency: the stored checksum must equal the
  // recomputed id-set checksum. A mismatch means the stored events and the
  // stored checksum disagree — reject.
  const recomputed = computeEventIdsSha256(entries);
  if (recomputed !== pack.event_ids_sha256) {
    throw eventPackError(
      `event_ids_sha256 mismatch: stored ${pack.event_ids_sha256}, recomputed ${recomputed}`,
      packFile,
    );
  }

  return { phaseId: pack.phase_id, path: packFile, pack, entries };
}

/**
 * Read and Tier-1-validate every event pack under
 * `.code-pact/state/archive/event-packs/`. Returns `[]` when the directory does
 * not exist. Non-`.json` files are ignored. Throws `EVENT_PACK_INVALID` on the
 * first invalid pack (same fail-closed policy as `readEventFiles`); a lenient
 * caller catches and collects. Tier 2 binding is NOT run here — it needs the
 * in-memory durable map the caller assembles.
 */
export async function readEventPackFiles(cwd: string): Promise<LoadedEventPack[]> {
  const dir = archiveEventPacksDir(cwd);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: LoadedEventPack[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const fileStem = basename(name, ".json");
    const path = join(dir, name);
    const raw = await readFile(path, "utf8");
    out.push(validateEventPackTier1(fileStem, raw, path));
  }
  return out;
}
