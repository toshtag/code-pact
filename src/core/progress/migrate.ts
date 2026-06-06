import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { ProgressLog, type ProgressEvent } from "../schemas/progress-event.ts";
import { mergeProgressStreams, progressPath } from "./io.ts";
import { readEventFiles, writeEventFile } from "./events-io.ts";
import { computeEventId } from "./event-id.ts";
import { deriveTaskState } from "./task-state.ts";

/**
 * Migrate a legacy monolithic `progress.yaml` to the per-event ledger.
 * Each legacy event becomes its own file
 * under `.code-pact/state/events/` via {@link writeEventFile}, so the migration
 * is idempotent by construction (re-running writes nothing new — the content id
 * makes a re-migrated event collide with itself).
 *
 * The legacy `progress.yaml` is **left in place** (readers merge it), so the
 * migration never loses data and partial runs are safe.
 *
 * Because readers switch from legacy *array order* to the merged `(at, id)`
 * order once event files exist, a repo whose legacy array order disagreed with
 * `at` order could see a task's derived state change. The migration reports any
 * such task so the flip is reviewed, never silent.
 */

export type MigrationStateChange = {
  task_id: string;
  /** Derived `current` under the legacy array order (today). */
  before: string;
  /** Derived `current` under the merged (at, id) order (after migration). */
  after: string;
};

export type MigrationResult = {
  dry_run: boolean;
  legacy_events: number;
  /** Event files newly written (0 in a dry run). */
  written: number;
  /** Legacy events that were already present as event files (idempotent). */
  already_present: number;
  /** Tasks whose derived state changes under merged ordering. */
  state_changes: MigrationStateChange[];
};

export async function migrateProgressToEvents(
  cwd: string,
  opts: { write: boolean },
): Promise<MigrationResult> {
  let legacyEvents: ProgressEvent[] = [];
  try {
    const raw = await readFile(progressPath(cwd), "utf8");
    legacyEvents = ProgressLog.parse(parseYaml(raw) as unknown).events;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // Derived-state diff: legacy array order (today's reducer input) vs the
  // post-migration merged order. After migration the legacy events exist as
  // event files too, so the post view is the legacy events (plus any event
  // files already present) deduped by id and sorted by (at, id) — NOT the
  // legacy-only fast path. Build that explicitly so the diff is meaningful even
  // in a dry run (no files written yet).
  const existing = await readEventFiles(cwd);
  const asFiles = legacyEvents.map((event) => ({
    event,
    id: computeEventId(event),
    file: "",
  }));
  const postMigration = mergeProgressStreams(legacyEvents, [...existing, ...asFiles]);
  const state_changes: MigrationStateChange[] = [];
  for (const task_id of new Set(legacyEvents.map((e) => e.task_id))) {
    const before = deriveTaskState(legacyEvents, task_id).current;
    const after = deriveTaskState(postMigration, task_id).current;
    if (before !== after) state_changes.push({ task_id, before, after });
  }

  let written = 0;
  let already_present = 0;
  if (opts.write) {
    for (const event of legacyEvents) {
      const r = await writeEventFile(cwd, event);
      if (r.alreadyExisted) already_present += 1;
      else written += 1;
    }
  }

  return {
    dry_run: !opts.write,
    legacy_events: legacyEvents.length,
    written,
    already_present,
    state_changes,
  };
}
