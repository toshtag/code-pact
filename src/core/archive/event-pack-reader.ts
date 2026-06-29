import { readdir, readFile } from "../project-fs/index.ts";
import { basename } from "node:path";
import { EventPack, type PackedEvent } from "../schemas/event-pack.ts";
import type { LoadedEventFile } from "../progress/events-io.ts";
import { parseEventFileName } from "../progress/events-io.ts";
import { atCompact, computeEventId, eventFileName } from "../progress/event-id.ts";
import { archiveEventPacksRelDir, eventPackRelPath, resolveArchiveOwnedPath, sha256Hex } from "./paths.ts";
import { loadArchiveBundles } from "./archive-bundle-loader.ts";
import { bindBundleMember } from "./archive-bundle-binding.ts";
import type { BundleIndexEntry } from "./archive-bundle-index.ts";
import { resolveArchiveRecordBytes, type RawLooseRecord } from "./resolve-archive-record.ts";
import { readPendingDeleteFilters } from "./delete-intent-journal.ts";

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

// The bundle store, for loose ∪ bundle resolution of event-packs.
const ARCHIVE_BUNDLE_STORE_LABEL = ".code-pact/state/archive/bundles";

/**
 * Validate one `event_pack` BUNDLE member into a `LoadedEventPack`: FIRST the SAME
 * Tier-1 a loose pack gets (`validateEventPackTier1` — per-entry bijection, order,
 * `event_ids_sha256`), so a pack-content fault surfaces as `EVENT_PACK_INVALID`
 * exactly as for a loose pack; THEN the bundle self-bind (`bindBundleMember` —
 * id↔phase_id and the canonical-bytes authority), which adds the bundle-only
 * guarantee (`ARCHIVE_BUNDLE_INVALID` on non-canonical bytes). Used only for a phase
 * whose LOOSE pack is absent (loose-wins).
 */
function loadEventPackFromBundleMember(phaseId: string, entry: BundleIndexEntry): LoadedEventPack {
  const loaded = validateEventPackTier1(
    phaseId,
    entry.bytes,
    `${ARCHIVE_BUNDLE_STORE_LABEL} (event_pack ${phaseId})`,
  );
  bindBundleMember(
    "event_pack",
    { id: phaseId, sha256: entry.sha256, bytes: entry.bytes },
    ARCHIVE_BUNDLE_STORE_LABEL,
  );
  return loaded;
}

/** The `event_pack` bundle members not shadowed by a loose pack, sorted by phaseId
 *  for deterministic order. Loose wins: a phaseId with a loose pack skips its bundle
 *  copy (no reconcile — stale detection is the delete-time gate's job, not a read). */
function bundleOnlyEventPackEntries(
  index: ReturnType<typeof loadArchiveBundles>["index"],
  looseStems: ReadonlySet<string>,
): [string, BundleIndexEntry][] {
  const members = index.get("event_pack");
  if (!members) return [];
  return [...members]
    .filter(([phaseId]) => !looseStems.has(phaseId))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Read and Tier-1-validate every event pack from loose ∪ bundle: the loose
 * `.code-pact/state/archive/event-packs/<id>.json` files PLUS any `event_pack`
 * bundle members whose loose copy was compacted away (loose wins). Returns `[]`
 * when neither store has packs. Non-`.json` files are ignored. Throws
 * `EVENT_PACK_INVALID` on the first invalid pack and `ARCHIVE_BUNDLE_INVALID` on a
 * corrupt bundle (same all-or-nothing fail-closed policy as `readEventFiles`); a
 * lenient caller catches and collects. Tier 2 binding is NOT run here.
 */
export async function readEventPackFiles(cwd: string): Promise<LoadedEventPack[]> {
  const dir = await resolveArchiveOwnedPath(cwd, archiveEventPacksRelDir());
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") names = [];
    else throw err;
  }
  // A pack named in a pending LOOSE-pair intent is LOGICALLY ABSENT everywhere; a pack
  // named in a pending BUNDLE-pair intent is absent from the BUNDLE side only (its loose
  // copy, if any, still resolves). Read-only; the journal is untouched.
  const { looseAbsentIds, bundleAbsentIds } = await readPendingDeleteFilters(cwd);
  const out: LoadedEventPack[] = [];
  const looseStems = new Set<string>();
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const fileStem = basename(name, ".json");
    if (looseAbsentIds.has(fileStem)) continue; // loose-pair mid-deletion → absent
    looseStems.add(fileStem);
    const path = await resolveArchiveOwnedPath(cwd, `${archiveEventPacksRelDir()}/${name}`);
    const raw = await readFile(path, "utf8");
    out.push(validateEventPackTier1(fileStem, raw, path));
  }
  // Bundle members for phases whose loose pack is gone (strict: throws on a bad bundle).
  const index = loadArchiveBundles(cwd).index;
  for (const [phaseId, entry] of bundleOnlyEventPackEntries(index, looseStems)) {
    if (looseAbsentIds.has(phaseId) || bundleAbsentIds.has(phaseId)) continue; // mid-deletion pair → bundle member absent
    out.push(loadEventPackFromBundleMember(phaseId, entry));
  }
  return out;
}

/** Read the LOOSE event-pack file's raw bytes. ENOENT → absent; other error → invalid. */
async function readLooseEventPackRaw(cwd: string, phaseId: string): Promise<RawLooseRecord> {
  try {
    return { kind: "present", bytes: await readFile(await resolveArchiveOwnedPath(cwd, eventPackRelPath(phaseId)), "utf8") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", error: err };
  }
}

/** The raw bytes of a phase's event-pack, resolved from loose ∪ bundle
 *  (`reader-loose-wins`): the loose `event-packs/<id>.json` wins; an event_pack bundle
 *  member supplies it once the loose copy is compacted away. So the event-pack PRODUCER
 *  (`planEventPack`) and cleanup gate see an existing bundled pack instead of treating
 *  it as absent (which would regenerate a subset pack). `absent` when neither store has
 *  it; `invalid` on a bundle-integrity fault or an unreadable loose file. The CALLER
 *  still runs `validateEventPackTier1` on the bytes (full Tier-1). */
export async function resolveEventPackRaw(cwd: string, phaseId: string): Promise<RawLooseRecord> {
  let resolved;
  try {
    const { looseAbsentIds, bundleAbsentIds } = await readPendingDeleteFilters(cwd); // mid-deletion pair → logically absent (bundle-pair: bundle side only)
    resolved = await resolveArchiveRecordBytes({
      kind: "event_pack",
      id: phaseId,
      mode: "reader-loose-wins",
      pendingAbsentIds: looseAbsentIds,
      pendingBundleAbsentIds: bundleAbsentIds,
      readLooseRaw: () => readLooseEventPackRaw(cwd, phaseId),
      loadBundleIndex: () => loadArchiveBundles(cwd).index,
    });
  } catch (error) {
    return { kind: "invalid", error };
  }
  if (resolved.kind === "absent") return { kind: "absent" };
  if (resolved.kind === "invalid") return { kind: "invalid", error: resolved.error };
  return { kind: "present", bytes: resolved.bytes };
}

/** One pack that failed Tier-1 (or read), for the per-file lenient reader. */
export type EventPackReadError = { phaseId: string; path: string; message: string };

/**
 * PER-FILE lenient read of every event pack: a single invalid/unreadable pack is
 * collected as an error and SKIPPED — it does NOT discard the other valid packs.
 * (`readEventPackFiles` is all-or-nothing: it throws on the FIRST bad pack, which
 * a strict caller wants but which would let one corrupt pack hide every healthy
 * one in lenient mode.) Returns `[]` valid packs when the dir is absent; a dir
 * that cannot be enumerated (a non-ENOENT readdir failure) throws — that is not a
 * per-file issue and the caller must decide.
 */
export async function readEventPackFilesLenient(
  cwd: string,
): Promise<{ packs: LoadedEventPack[]; errors: EventPackReadError[] }> {
  const dir = await resolveArchiveOwnedPath(cwd, archiveEventPacksRelDir());
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") names = [];
    else throw err; // a dir that cannot be enumerated is not a per-file issue
  }
  const { looseAbsentIds, bundleAbsentIds } = await readPendingDeleteFilters(cwd); // mid-deletion pairs → logically absent
  const packs: LoadedEventPack[] = [];
  const errors: EventPackReadError[] = [];
  const looseStems = new Set<string>();
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const fileStem = basename(name, ".json");
    if (looseAbsentIds.has(fileStem)) continue; // loose-pair mid-deletion → absent
    looseStems.add(fileStem);
    const path = await resolveArchiveOwnedPath(cwd, `${archiveEventPacksRelDir()}/${name}`);
    try {
      const raw = await readFile(path, "utf8");
      packs.push(validateEventPackTier1(fileStem, raw, path));
    } catch (err) {
      errors.push({ phaseId: fileStem, path, message: (err as Error).message });
    }
  }
  // Bundle members for phases whose loose pack is gone. Lenient: a corrupt bundle
  // STORE is collected as one error (loose packs already read are kept), and a
  // single bad bundle member is collected per-member — never thrown to the caller.
  let index: ReturnType<typeof loadArchiveBundles>["index"] | null = null;
  try {
    index = loadArchiveBundles(cwd).index;
  } catch (err) {
    errors.push({
      phaseId: "(bundles)",
      path: ARCHIVE_BUNDLE_STORE_LABEL,
      message: (err as Error).message,
    });
  }
  if (index) {
    for (const [phaseId, entry] of bundleOnlyEventPackEntries(index, looseStems)) {
      if (looseAbsentIds.has(phaseId) || bundleAbsentIds.has(phaseId)) continue; // mid-deletion pair → bundle member absent
      try {
        packs.push(loadEventPackFromBundleMember(phaseId, entry));
      } catch (err) {
        errors.push({
          phaseId,
          path: `${ARCHIVE_BUNDLE_STORE_LABEL} (event_pack ${phaseId})`,
          message: (err as Error).message,
        });
      }
    }
  }
  return { packs, errors };
}
