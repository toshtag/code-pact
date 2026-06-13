import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { ProgressLog, type ProgressEvent } from "../schemas/progress-event.ts";
import { computeEventId } from "./event-id.ts";
import { type LoadedEventFile, readEventFiles } from "./events-io.ts";
import { progressPath } from "./io.ts";
import {
  readEventPackFiles,
  readEventPackFilesLenient,
  type LoadedEventPack,
} from "../archive/event-pack-reader.ts";
import {
  validateEventPackBinding,
  newSnapshotRawCache,
  type EventPackBindingIssue,
} from "../archive/event-pack-binding.ts";
import { readArchivedTaskIds } from "../archive/snapshot-evidence.ts";

// ---------------------------------------------------------------------------
// The shared progress-source reader (the linchpin).
//
// EVERY progress read in the system flows through here so all surfaces — the
// merged log, validate, plan lint, doctor, branch-drift — see the SAME progress
// truth, including event packs. The reader returns sources with pack boundaries
// intact; callers merge with `mergeProgressStreams(mergeableLegacyEvents, [...looseFiles, ...validatedPackFiles])`.
//
// Locked flow (NO recursive reader, NO cross-pack mutual support):
//   1. read legacy events
//   2. read loose event files
//   3. read packs as LoadedEventPack[], Tier-1 only (no snapshot, no cross-pack)
//   4. for each pack: Tier-2 binding against `loose ∪ THIS pack's own entries`
//      only (an unvalidated pack can never prop up another pack's evidence)
//   5. reject/throw invalid packs (strict) or collect a FileIssue (lenient)
//   6. flatten the PASSED packs → validatedPackFiles
//   7. compute the legacy split: rawLegacyEvents (unfiltered, for diagnostics)
//      vs mergeableLegacyEvents (raw MINUS conflicting archived-task legacy
//      events — the LEGACY_EVENT_FOR_ARCHIVED_TASK gate)
//   8. return { rawLegacyEvents, mergeableLegacyEvents, looseFiles, packs,
//               validatedPackFiles, issues }
//
// strict throws on any corrupt/unbound source or a legacy conflict; lenient
// collects each as an issue and STILL excludes the offending legacy event from
// the merged stream (emitting an issue but merging the event would fail the exit
// yet leave the derived state maintainer-local — a weak "green only on my machine").
// ---------------------------------------------------------------------------

export type ProgressSourceIssue = {
  /** Stable diagnostic code: EVENT_PACK_INVALID | LEGACY_EVENT_FOR_ARCHIVED_TASK. */
  code: "EVENT_PACK_INVALID" | "LEGACY_EVENT_FOR_ARCHIVED_TASK";
  message: string;
};

export type ProgressSources = {
  /** Unfiltered legacy log (for diagnostics / the legacy-retained warning). */
  rawLegacyEvents: ProgressEvent[];
  /** Legacy minus conflicting archived-task events — the set callers MERGE with. */
  mergeableLegacyEvents: ProgressEvent[];
  looseFiles: LoadedEventFile[];
  /** Tier-1-valid packs with boundaries intact (used for per-pack binding). */
  packs: LoadedEventPack[];
  /** Flattened events from packs that PASSED Tier-2 binding (post-binding only). */
  validatedPackFiles: LoadedEventFile[];
  /** Lenient-mode issues (empty in strict mode — strict throws instead). */
  issues: ProgressSourceIssue[];
};

function progressSourceError(
  code: ProgressSourceIssue["code"],
  message: string,
): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/**
 * The LEGACY_EVENT_FOR_ARCHIVED_TASK gate, reusable by any caller that has
 * already parsed its own legacy events (e.g. the lenient plan-artifact loader,
 * which keeps its own legacy parse to surface a corrupt-legacy `SCHEMA_ERROR`).
 * Returns the mergeable subset of `rawLegacyEvents` (conflicting archived-task
 * events removed) plus the conflict issues. In strict mode the FIRST conflict
 * throws; in lenient mode all conflicts are collected and excluded.
 *
 * A "conflict" is a legacy event for an ARCHIVED-snapshot task whose content id
 * is not in the durable set (loose ∪ validated packs) — it would otherwise flip
 * the archived task's derived state on the maintainer's machine but not on a
 * clean checkout / CI.
 */
export function filterArchivedTaskLegacyConflicts(
  rawLegacyEvents: readonly ProgressEvent[],
  durableIds: ReadonlySet<string>,
  archivedTaskIds: ReadonlySet<string>,
  mode: "strict" | "lenient",
  archivedEnumerationComplete = true,
): { mergeableLegacyEvents: ProgressEvent[]; issues: ProgressSourceIssue[] } {
  const mergeableLegacyEvents: ProgressEvent[] = [];
  const issues: ProgressSourceIssue[] = [];

  // FAIL CLOSED on an incomplete archived-task set (a corrupt snapshot was
  // skipped during enumeration). The set can no longer be trusted to contain
  // every archived task_id, so a legacy event for a now-invisible archived task
  // would slip past the per-event check below. With legacy events present and
  // the set known-incomplete, refuse the whole legacy stream rather than admit a
  // possibly-conflicting event. (No legacy events → nothing to gate.)
  if (!archivedEnumerationComplete && rawLegacyEvents.length > 0) {
    const message =
      "cannot trust legacy progress.yaml against archived tasks: a phase snapshot was unreadable, so the archived-task set is incomplete and the conflict gate cannot be applied safely; fix or remove the corrupt snapshot (and run `code-pact plan migrate --write`)";
    if (mode === "strict") {
      throw progressSourceError("LEGACY_EVENT_FOR_ARCHIVED_TASK", message);
    }
    issues.push({ code: "LEGACY_EVENT_FOR_ARCHIVED_TASK", message });
    return { mergeableLegacyEvents: [], issues }; // drop ALL legacy, fail closed
  }

  for (const event of rawLegacyEvents) {
    if (archivedTaskIds.has(event.task_id)) {
      const id = computeEventId(event);
      if (!durableIds.has(id)) {
        const message = `legacy progress.yaml has event ${id} for archived task "${event.task_id}" that is not in the durable ledger (loose ∪ packs); run \`code-pact plan migrate --write\` to normalize, or remove the stale legacy entry`;
        if (mode === "strict") {
          throw progressSourceError("LEGACY_EVENT_FOR_ARCHIVED_TASK", message);
        }
        issues.push({ code: "LEGACY_EVENT_FOR_ARCHIVED_TASK", message });
        continue;
      }
    }
    mergeableLegacyEvents.push(event);
  }
  return { mergeableLegacyEvents, issues };
}

/** Read legacy `progress.yaml` events (ENOENT → empty); strict parse always. */
async function readLegacyEvents(cwd: string): Promise<ProgressEvent[]> {
  try {
    const raw = await readFile(progressPath(cwd), "utf8");
    return ProgressLog.parse(parseYaml(raw) as unknown).events;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Loose files + Tier-2-bound packs, with binding issues — steps 2-6. */
export type PackSources = {
  looseFiles: LoadedEventFile[];
  /** Tier-1-valid packs with boundaries intact. */
  packs: LoadedEventPack[];
  /** Flattened events from packs that PASSED Tier-2 binding. */
  validatedPackFiles: LoadedEventFile[];
  /** Pack issues (EVENT_PACK_INVALID). Empty in strict mode — strict throws. */
  issues: ProgressSourceIssue[];
};

/**
 * Steps 2-6 of the locked flow: read loose files, read packs Tier-1, bind each
 * pack against `loose ∪ ownPack` only (NO cross-pack support), and flatten the
 * packs that passed. Shared by `readAllProgressEventSources` and the lenient
 * plan-artifact loader (which supplies its own legacy handling). strict throws
 * on a corrupt/unbound pack; lenient collects and drops it.
 */
export async function readPackSources(
  cwd: string,
  mode: "strict" | "lenient",
): Promise<PackSources> {
  const lenient = mode === "lenient";
  const issues: ProgressSourceIssue[] = [];

  const looseFiles = await readEventFiles(cwd);
  const looseById = new Map<string, LoadedEventFile>();
  for (const f of looseFiles) looseById.set(f.id, f);

  let packs: LoadedEventPack[];
  if (lenient) {
    // PER-FILE lenient: one corrupt pack must NOT discard the other valid packs
    // (a corrupt OTHER phase's pack can't block compacting THIS phase). A dir
    // that cannot be enumerated still throws — that is not a per-file issue.
    const { packs: validPacks, errors } = await readEventPackFilesLenient(cwd);
    for (const e of errors) {
      issues.push({ code: "EVENT_PACK_INVALID", message: `event pack ${e.path}: ${e.message}` });
    }
    packs = validPacks;
  } else {
    packs = await readEventPackFiles(cwd); // strict: throw on the first bad pack
  }

  const cache = newSnapshotRawCache();
  const validatedPacks: LoadedEventPack[] = [];
  for (const pack of packs) {
    let bindingIssues: EventPackBindingIssue[];
    try {
      bindingIssues = await validateEventPackBinding(cwd, pack, looseById, cache);
    } catch (err) {
      if (!lenient) throw err;
      issues.push({ code: "EVENT_PACK_INVALID", message: (err as Error).message });
      continue;
    }
    if (bindingIssues.length > 0) {
      const message = `event pack "${pack.phaseId}" failed snapshot binding: ${bindingIssues
        .map((i) => i.message)
        .join("; ")}`;
      if (!lenient) throw progressSourceError("EVENT_PACK_INVALID", message);
      issues.push({ code: "EVENT_PACK_INVALID", message });
      continue; // drop the unbound pack
    }
    validatedPacks.push(pack);
  }

  const validatedPackFiles: LoadedEventFile[] = [];
  for (const pack of validatedPacks) validatedPackFiles.push(...pack.entries);

  return { looseFiles, packs, validatedPackFiles, issues };
}

/**
 * Build the durable-id set + archived-task-id set the legacy gate needs from a
 * `PackSources` result. Separate so the lenient loader can also surface the
 * archived-id-enumeration skips if it wants them (it currently ignores them —
 * a corrupt snapshot already surfaces elsewhere).
 */
export async function durableIdsAndArchivedTasks(
  cwd: string,
  pack: PackSources,
): Promise<{
  durableIds: Set<string>;
  archivedTaskIds: Set<string>;
  /** False when a snapshot was unreadable during enumeration — the archived-task
   *  set is then INCOMPLETE and the legacy gate must fail closed (a legacy event
   *  for a now-invisible archived task would otherwise slip through). */
  archivedEnumerationComplete: boolean;
}> {
  const durableIds = new Set<string>();
  for (const f of pack.looseFiles) durableIds.add(f.id);
  for (const f of pack.validatedPackFiles) durableIds.add(f.id);
  const { taskIds: archivedTaskIds, skipped } = await readArchivedTaskIds(cwd);
  return { durableIds, archivedTaskIds, archivedEnumerationComplete: skipped.length === 0 };
}

export async function readAllProgressEventSources(
  cwd: string,
  opts: { mode: "strict" | "lenient" },
): Promise<ProgressSources> {
  // Step 1: legacy.
  const rawLegacyEvents = await readLegacyEvents(cwd);
  // Steps 2-6: loose + packs + binding.
  const pack = await readPackSources(cwd, opts.mode);
  // Step 7: legacy split (archived-task conflict gate).
  const { durableIds, archivedTaskIds, archivedEnumerationComplete } =
    await durableIdsAndArchivedTasks(cwd, pack);
  const { mergeableLegacyEvents, issues: legacyIssues } = filterArchivedTaskLegacyConflicts(
    rawLegacyEvents,
    durableIds,
    archivedTaskIds,
    opts.mode,
    archivedEnumerationComplete,
  );
  return {
    rawLegacyEvents,
    mergeableLegacyEvents,
    looseFiles: pack.looseFiles,
    packs: pack.packs,
    validatedPackFiles: pack.validatedPackFiles,
    issues: [...pack.issues, ...legacyIssues],
  };
}
