import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { atomicWriteText } from "../../io/atomic-text.ts";
import {
  ProgressLog,
  type ProgressEvent,
} from "../schemas/progress-event.ts";
import { computeEventId, normalizeAt } from "./event-id.ts";
import { readEventFiles } from "./events-io.ts";

export const PROGRESS_PATH_SEGMENTS = [".code-pact", "state", "progress.yaml"];

export function progressPath(cwd: string): string {
  return join(cwd, ...PROGRESS_PATH_SEGMENTS);
}

export type LoadedProgress = {
  raw: string;
  log: ProgressLog;
  path: string;
};

/**
 * Load the merged progress log: the legacy monolithic `progress.yaml` (if
 * present) plus every per-event file under `.code-pact/state/events/`
 * (collaboration-safe-state RFC, B2/B3). The in-memory `{ events }` shape is
 * unchanged, so every consumer (`deriveTaskState`, analyze, pack, verify,
 * doctor) is untouched — only how the array is assembled changes.
 *
 * Determinism, glob-order-independent:
 *  - Legacy-only fast path: when there are NO event files, the legacy events
 *    are returned in their original array order, unsorted — byte-for-byte the
 *    same reducer input as before this RFC (the backward-compat guarantee).
 *  - Otherwise the union is deduped by full content id (a legacy event also
 *    migrated to a file collapses to one) and sorted by `at`, then `id`, then
 *    the legacy array index as a final tiebreaker.
 *
 * Throws on an unreadable / schema-invalid legacy file or event file; callers
 * map errors to the appropriate CLI error code. A missing `progress.yaml` is
 * treated as an empty legacy log (event files may still supply events).
 */
export async function loadMergedProgress(cwd: string): Promise<LoadedProgress> {
  const path = progressPath(cwd);

  let raw = "";
  let legacyEvents: ProgressEvent[] = [];
  try {
    raw = await readFile(path, "utf8");
    legacyEvents = ProgressLog.parse(parseYaml(raw) as unknown).events;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const eventFiles = await readEventFiles(cwd);

  // Legacy-only fast path — identical to today's behaviour.
  if (eventFiles.length === 0) {
    return { raw, log: { events: legacyEvents }, path };
  }

  // Merge: dedup by full content id, then sort by (at, id, source_order).
  const byId = new Map<string, { event: ProgressEvent; order: number }>();
  legacyEvents.forEach((event, i) => {
    const id = computeEventId(event);
    if (!byId.has(id)) byId.set(id, { event, order: i });
  });
  for (const { event, id } of eventFiles) {
    if (!byId.has(id)) {
      byId.set(id, { event, order: Number.MAX_SAFE_INTEGER });
    }
  }
  const events = [...byId.entries()]
    .map(([id, { event, order }]) => ({ id, event, order, at: normalizeAt(event.at) }))
    .sort(
      (a, b) =>
        (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
        a.order - b.order,
    )
    .map((m) => m.event);

  return { raw, log: { events }, path };
}

/**
 * Read and Zod-parse the legacy `progress.yaml`. Throws if the file is missing
 * or does not satisfy the schema; callers map errors to the appropriate CLI
 * error code.
 *
 * NOTE: this still reads ONLY `progress.yaml` — it does not yet merge the
 * per-event files. This is deliberate for Bucket B PR 1, which ships the
 * `loadMergedProgress` machinery additively with **no behaviour change**: a
 * repo with no event files (every repo today) is unaffected, and a repo that
 * somehow had event files would NOT get a half-merged view from one reader
 * while others stay legacy-only. PR 2 routes every progress reader (this one,
 * `verify`, `pack`, `doctor`/branch-drift) onto `loadMergedProgress` together,
 * in the same change that flips the writers to event files.
 */
export async function loadProgressLog(cwd: string): Promise<LoadedProgress> {
  const path = progressPath(cwd);
  const raw = await readFile(path, "utf8");
  const log = ProgressLog.parse(parseYaml(raw) as unknown);
  return { raw, log, path };
}

/**
 * Atomic YAML write — serializes `value` then delegates to `atomicWriteText`.
 * Kept as a thin wrapper so progress-log writers do not need to know about
 * the serialization step separately.
 */
export async function atomicWriteYaml(
  path: string,
  value: unknown,
): Promise<void> {
  await atomicWriteText(path, stringifyYaml(value));
}

/**
 * Append a single ProgressEvent to the legacy `progress.yaml`. Reads that file
 * **directly** — NOT the merged view — because this is the monolithic-file
 * appender: it must append based on `progress.yaml`'s own contents and must
 * never fold event-file events back into it. A missing `progress.yaml` throws
 * ENOENT, exactly as before this RFC. (Bucket B PR 2 retires this in favour of
 * `writeEventFile`; until then the production writers still call it.)
 */
export async function appendEvent(
  cwd: string,
  event: ProgressEvent,
): Promise<{ path: string; nextLog: ProgressLog }> {
  const path = progressPath(cwd);
  const raw = await readFile(path, "utf8");
  const log = ProgressLog.parse(parseYaml(raw) as unknown);
  const nextLog: ProgressLog = { events: [...log.events, event] };
  await atomicWriteYaml(path, nextLog);
  return { path, nextLog };
}
