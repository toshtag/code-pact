// ---------------------------------------------------------------------------
// Event-pack compaction LAYER 3b-2b-2b (part 1) — post-run RECONCILIATION (R0–R5).
// NON-destructive: it re-reads the events dir AFTER the unlink loop and classifies
// every PRESENT survivor; it removes nothing.
//
// The per-file gate + unlink loop (`unlinkGatedLoose`, merged) only knows what IT
// did. Between the plan and the end of the loop the dir can gain a file (a
// concurrent writer) or a removed file can reappear with different content — such a
// survivor never went through the gate, so it has no skip record. Reconciliation
// closes that gap: it re-enumerates the on-disk truth and is the single authority
// for `cleanup_remaining_loose` / `skipped[]` / the terminal disposition.
//
// It wires the merged PURE classifiers (`classifyPostRunSurvivor` /
// `aggregateSurvivorVerdicts`) to a disk re-enumeration + the R0 candidate-set
// scoping + the R5 out-of-scope advisory. The `CleanupOutcome` is then built by the
// orchestrator (Layer 3b-2b-2b part 2), which also knows the loop tallies and
// whether the pack was written this run.
//
// See design/decisions/event-pack-compaction-rfc.md — the "Final reconciliation
// step (R0–R5)" is the binding source here.
// ---------------------------------------------------------------------------

import { readdir, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ProgressEvent } from "../schemas/progress-event.ts";
import { computeEventId } from "../progress/event-id.ts";
import { eventsDir, parseEventFileName } from "../progress/events-io.ts";
import { looseEventRelPath } from "./event-pack-cleanup-gate.ts";
import {
  classifyPostRunSurvivor,
  aggregateSurvivorVerdicts,
  type SurvivorVerdict,
  type CleanupSkip,
  type CleanupSkipReason,
  type CleanupAdvisory,
  type CleanupErrorCode,
} from "./event-pack-cleanup.ts";

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** The R1.0 id-unverifiable reasons (a survivor whose content id can't be computed). */
type IdUnknownReason = Extract<
  CleanupSkipReason,
  | "not_regular_file_after_cleanup"
  | "unreadable_after_cleanup"
  | "parse_failed_after_cleanup"
  | "id_unknown_after_cleanup"
>;

/** What a post-run survivor's content tells us, re-read fresh from disk. */
type SurvivorContent =
  | "gone" // ENOENT at reconciliation time — not a present survivor.
  | {
      /** Recomputed CONTENT event id, or null when it cannot be computed (R1.0). */
      id: string | null;
      /** The event's task_id, or null when the content can't be parsed (for R0 iii). */
      taskId: string | null;
      /** When `id` is null, the specific R1.0 reason; otherwise null. */
      reason: IdUnknownReason | null;
    };

/**
 * Re-read ONE present survivor's content id + task_id, fresh from disk, mapping
 * every failure to the matching R1.0 `*_after_cleanup` reason. `ENOENT` means it
 * vanished since the re-enumeration (`"gone"` — not a survivor).
 *
 * Unlike the delete-time gate (`O_NOFOLLOW` + fd inode-identity, because it gates an
 * irreversible unlink), this is a plain `lstat` + `readFile` — best-effort, read-only,
 * removes NOTHING. Under the non-hostile-FS threat model (accidental corruption /
 * honest concurrent writers) a symlink read here only mis-classifies a survivor for
 * the advisory/INCOMPLETE counts; it can never cause a delete.
 */
async function readSurvivorContent(abs: string): Promise<SurvivorContent> {
  let st;
  try {
    st = await lstat(abs);
  } catch (err) {
    if (isEnoent(err)) return "gone";
    return { id: null, taskId: null, reason: "unreadable_after_cleanup" };
  }
  if (!st.isFile()) return { id: null, taskId: null, reason: "not_regular_file_after_cleanup" };
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    if (isEnoent(err)) return "gone";
    return { id: null, taskId: null, reason: "unreadable_after_cleanup" };
  }
  let parsed: ProgressEvent;
  try {
    const doc = parseYaml(raw) as unknown;
    if (!doc || typeof doc !== "object") throw new Error("not an object");
    // The stored `id` is not part of the event schema; strip it before parsing
    // (same as the canonical loose-file validator).
    const { id: _stored, ...rest } = doc as Record<string, unknown>;
    parsed = ProgressEvent.parse(rest);
  } catch {
    return { id: null, taskId: null, reason: "parse_failed_after_cleanup" };
  }
  return { id: computeEventId(parsed), taskId: parsed.task_id, reason: null };
}

/** Inputs the reconciliation needs from the cleanup run (all read-only). */
export type ReconcileSurvivorsInput = {
  /** The ORIGINAL cleanup target set the loop iterated — R0 (i). Matched by
   *  BASENAME, so either basenames or project-relative paths are accepted. */
  target: readonly string[];
  /** The verified pack's covered event-id set — R0 (ii) + R1 pack-coverage. */
  packIds: ReadonlySet<string>;
  /** The archived snapshot's task ids — R0 (iii). */
  snapshotTaskIds: ReadonlySet<string>;
  /** The unlink loop's per-file skip records — R0 (iv) + the existing skip reason
   *  R1 preserves. Keyed by project-relative path (as the loop records them). */
  loopSkipped: readonly CleanupSkip[];
};

/** Test seam: `afterReaddir` fires AFTER the events-dir re-enumeration and BEFORE
 *  any per-file content read, so a test can inject a vanish/change race and assert
 *  reconciliation handles it (mirrors the other layers' hooks). */
export type ReconcileSurvivorsHooks = { afterReaddir?: () => Promise<void> };

/** The reconciliation verdict: the terminal disposition + the authoritative counts.
 *  The orchestrator combines this with the loop tallies (deleted / vanished) and
 *  the pack-write fact to build the public `CleanupOutcome`. */
export type LooseCleanupReconciliation = {
  /** `null` = every present in-scope file is accounted for and the run may succeed;
   *  otherwise the error code a present survivor forces. */
  terminal: CleanupErrorCode | null;
  /** Set only on a `STATE_COMPACT_CLEANUP_FAILED` from a not-in-pack survivor (R1.1). */
  block?: "pack_stale_after_cleanup";
  /** One record per PRESENT in-scope survivor (R4); empty when none remain. */
  skipped: CleanupSkip[];
  /** Count of present in-scope survivors after R1 (R2). Vanished files are excluded. */
  cleanup_remaining_loose: number;
  /** Files this phase observed vanish during reconciliation, scoped to this phase by
   *  a filename/target/skip tie — EITHER present at the re-enumeration then ENOENT by
   *  the content read, OR a loop-skipped file already absent from the re-enumeration.
   *  NOT a survivor (not in `skipped` / remaining). The orchestrator adds this to the
   *  unlink loop's own vanished tally for the public `vanished_count`. */
  vanished_count: number;
  /** Global out-of-scope anomalies (R5) — present on success too (empty when none). */
  advisories: CleanupAdvisory[];
};

/**
 * Re-enumerate the events dir AFTER the unlink loop and classify every PRESENT
 * event-shaped file (R0–R5). For each present file:
 *  - R0 in-scope iff its basename was in the target, OR its filename id is in the
 *    pack, OR its content task_id is in the snapshot, OR it carries a loop skip
 *    record (none of which need the content to be readable, so an unreadable file
 *    tied to this pack/target is still scoped — caught by R1.0).
 *  - in-scope → `classifyPostRunSurvivor` (R1.0 id-unknown / R1.1 not-in-pack FAILED
 *    / R1.2 keep skip reason / R1.3 appeared), aggregated (FAILED dominates).
 *  - out-of-scope → a global `unclassified_loose_after_cleanup` advisory (R5); never
 *    counted in THIS phase's `cleanup_remaining_loose`.
 * NO unlink, no lock — read-only.
 */
export async function reconcileSurvivors(
  cwd: string,
  input: ReconcileSurvivorsInput,
  hooks: ReconcileSurvivorsHooks = {},
): Promise<LooseCleanupReconciliation> {
  const { target, packIds, snapshotTaskIds, loopSkipped } = input;
  // R0 (i) matches on BASENAME (`readdir` yields basenames). Normalize each target
  // entry to its basename so scoping is robust whether the caller passes basenames OR
  // project-relative paths — a path/basename mismatch here would silently drop a
  // target-only survivor to an advisory and UNDERCOUNT this phase's remaining loose.
  const targetSet = new Set(target.map((t) => t.slice(t.lastIndexOf("/") + 1)));
  const skipByPath = new Map(loopSkipped.map((s) => [s.path, s.reason]));

  const dir = eventsDir(cwd);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (isEnoent(err)) names = []; // no dir → nothing present
    else throw err;
  }

  const verdicts: SurvivorVerdict[] = [];
  const advisories: CleanupAdvisory[] = [];
  let vanishedCount = 0;
  // The post-run enumeration snapshot. A loop-skipped file MISSING from it vanished
  // BEFORE this readdir (handled after the main loop); the `presentNames` guard there
  // prevents double-counting a skip file the main loop instead sees vanish at read.
  const presentNames = new Set(names);

  if (hooks.afterReaddir) await hooks.afterReaddir();

  for (const name of [...names].sort()) {
    const parsedName = parseEventFileName(name);
    if (!parsedName) continue; // not an event-shaped file — not a loose event at all

    const relPath = looseEventRelPath(name);
    const existingSkipReason: CleanupSkipReason | null = skipByPath.get(relPath) ?? null;
    // FILENAME-only R0 ties (i)/(ii)/(iv) — they need neither the content nor the
    // task_id, so they hold even for a file that has since vanished or gone unreadable.
    const filenameScoped =
      targetSet.has(name) || // (i) was a cleanup target
      packIds.has(parsedName.id) || // (ii) filename id is in the verified pack
      existingSkipReason !== null; // (iv) carries a loop skip record

    const survivor = await readSurvivorContent(join(dir, name));
    if (survivor === "gone") {
      // Vanished between the re-enumeration and the content read. NOT a present
      // survivor (so never in `skipped` / remaining), but if a filename/target/skip
      // tie makes it THIS phase's, it IS a vanish this phase observed — count it so
      // the orchestrator's public `vanished_count` is accurate. Its task_id is
      // unreadable, so the snapshot-membership tie (iii) cannot apply here.
      if (filenameScoped) vanishedCount += 1;
      continue;
    }

    // R0 — in-scope for THIS phase: a filename tie, OR the content's task ∈ snapshot
    // (iii). (i)/(ii)/(iv) hold without the content; (iii) needs the parsed task_id.
    const inScope =
      filenameScoped || (survivor.taskId !== null && snapshotTaskIds.has(survivor.taskId));

    if (!inScope) {
      // R5 — an event-looking file no phase cleanup owns. Surface it globally; never
      // count it in this phase's remaining-loose (that would make the result lie).
      advisories.push({ code: "unclassified_loose_after_cleanup", path: relPath });
      continue;
    }

    verdicts.push(
      classifyPostRunSurvivor(
        {
          path: relPath,
          contentEventId: survivor.id,
          idUnknownReason: survivor.reason ?? undefined,
          existingSkipReason,
        },
        { has: (eventId) => packIds.has(eventId) },
      ),
    );
  }

  // A loop-skipped file (already proven THIS phase's via R0 (iv)) that is ABSENT from
  // the post-run enumeration vanished before this readdir — not a present survivor,
  // but a vanish this phase observed, so count it. Only the loop-skip tie is
  // unambiguous here: a target/pack-tied file missing from disk may have been the
  // loop's own deletion (the loop's tallies own that), but a SKIP means the loop kept
  // it, so its absence now is a genuine vanish. `presentNames` excludes the
  // read-time-vanish files the main loop already counted.
  for (const s of loopSkipped) {
    const base = s.path.slice(s.path.lastIndexOf("/") + 1);
    if (!parseEventFileName(base)) continue; // not an event file — ignore
    if (!presentNames.has(base)) vanishedCount += 1;
  }

  const agg = aggregateSurvivorVerdicts(verdicts);
  return {
    terminal: agg.terminal,
    ...(agg.block ? { block: agg.block } : {}),
    skipped: agg.skipped,
    // R2 — present in-scope survivors only; vanished/out-of-scope excluded.
    cleanup_remaining_loose: verdicts.length,
    vanished_count: vanishedCount,
    advisories,
  };
}
