import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { resolveOwnedProjectPath } from "../path-safety.ts";
import {
  ProgressLog,
  type ProgressEvent,
} from "../schemas/progress-event.ts";
import { computeEventId, normalizeAt } from "./event-id.ts";
import { type LoadedEventFile } from "./events-io.ts";
import { readAllProgressEventSources } from "./all-sources.ts";

export const PROGRESS_PATH_SEGMENTS = [".code-pact", "state", "progress.yaml"];

export function progressPath(cwd: string): string {
  return join(cwd, ...PROGRESS_PATH_SEGMENTS);
}

export async function resolveProgressPath(cwd: string): Promise<string> {
  try {
    return await resolveOwnedProjectPath(cwd, PROGRESS_PATH_SEGMENTS.join("/"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PATH_OUTSIDE_PROJECT" || code === "PATH_NOT_OWNED") {
      const e = new Error(
        `.code-pact/state/progress.yaml is not a safe owned progress ledger path: ${(err as Error).message}`,
      );
      (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw e;
    }
    throw err;
  }
}

export type LoadedProgress = {
  raw: string;
  log: ProgressLog;
  path: string;
};

/**
 * Load the merged progress log: the legacy monolithic `progress.yaml` (if
 * present) plus every per-event file under `.code-pact/state/events/`
 * The in-memory `{ events }` shape is
 * unchanged, so every consumer (`deriveTaskState`, analyze, pack, verify,
 * doctor) is untouched — only how the array is assembled changes.
 *
 * Determinism, glob-order-independent:
 *  - Legacy-only fast path: when there are NO event files, the legacy events
 *    are returned in their original array order, unsorted — byte-for-byte the
 *    same reducer input (the backward-compat guarantee).
 *  - Otherwise the union is deduped by full content id (a legacy event also
 *    migrated to a file collapses to one) and sorted by `at`, then `id`, then
 *    the legacy array index as a final tiebreaker.
 *
 * Throws on an unreadable / schema-invalid legacy file or event file; callers
 * map errors to the appropriate CLI error code. A missing `progress.yaml` is
 * treated as an empty legacy log (event files may still supply events).
 */
/**
 * Deterministically merge a legacy `progress.yaml` event array with the
 * per-event files. Glob-order-independent — shared by every progress
 * source (workspace and git-tree) so the ordering is identical everywhere:
 *  - Legacy-only fast path: with NO event files, the legacy events are returned
 *    in their original array order, unsorted — byte-for-byte the same reducer
 *    input (the backward-compat guarantee).
 *  - Otherwise the union is deduped by full content id (a legacy event also
 *    migrated to a file collapses to one) and sorted by `at`, then `id`, then
 *    the legacy array index as a final tiebreaker.
 */
export function mergeProgressStreams(
  legacyEvents: readonly ProgressEvent[],
  eventFiles: readonly LoadedEventFile[],
): ProgressEvent[] {
  if (eventFiles.length === 0) return [...legacyEvents];

  const byId = new Map<string, { event: ProgressEvent; order: number }>();
  legacyEvents.forEach((event, i) => {
    const id = computeEventId(event);
    if (!byId.has(id)) byId.set(id, { event, order: i });
  });
  for (const { event, id } of eventFiles) {
    if (!byId.has(id)) byId.set(id, { event, order: Number.MAX_SAFE_INTEGER });
  }
  return [...byId.entries()]
    .map(([id, { event, order }]) => ({ id, event, order, at: normalizeAt(event.at) }))
    .sort(
      (a, b) =>
        (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
        a.order - b.order,
    )
    .map((m) => m.event);
}

/**
 * Workspace progress loader: the merged view of the working-tree legacy
 * `progress.yaml` (if present) plus every per-event file under
 * `.code-pact/state/events/`. Throws on an unreadable / schema-invalid legacy
 * file or event file; callers map errors to the appropriate CLI surface. A
 * missing `progress.yaml` is treated as an empty legacy log (event files may
 * still supply events).
 *
 * NB: reads the WORKSPACE only. The branch-drift gate reads a committed git
 * revision instead — see `loadMergedProgressFromGitTree` — and the two must
 * never be mixed.
 */
export async function loadMergedProgress(cwd: string): Promise<LoadedProgress> {
  const path = await resolveProgressPath(cwd);

  // `raw` is the legacy file bytes (empty when absent) — kept for callers that
  // need the raw string. The merged events come from the shared reader, so event
  // packs are included everywhere and the LEGACY_EVENT_FOR_ARCHIVED_TASK gate is
  // enforced. Strict mode: a corrupt/unbound pack or a legacy conflict throws.
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const sources = await readAllProgressEventSources(cwd, { mode: "strict" });
  return {
    raw,
    log: {
      events: mergeProgressStreams(sources.mergeableLegacyEvents, [
        ...sources.looseFiles,
        ...sources.validatedPackFiles,
      ]),
    },
    path,
  };
}

/**
 * Read the progress log — the merged view of legacy `progress.yaml` plus the
 * per-event files (delegates to {@link loadMergedProgress}). Kept as the
 * historical name so callers need no change. Throws on an unreadable /
 * schema-invalid legacy file or event file; callers map errors to the
 * appropriate CLI error code. (Bucket B PR 2 wires every progress reader onto
 * the merged view together with the writer flip.)
 */
export async function loadProgressLog(cwd: string): Promise<LoadedProgress> {
  return loadMergedProgress(cwd);
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

// `appendEvent` (the legacy monolithic-file appender) was removed in Bucket B
// PR 2: every progress writer now writes a per-event file via `writeEventFile`,
// and `progress.yaml` is read-merge-only. Keeping no legacy appender makes the
// "writers never touch progress.yaml" rule structural.
