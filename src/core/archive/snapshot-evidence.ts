import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import type { ProgressEvent } from "../schemas/progress-event.ts";
import type { PhaseSnapshot } from "../schemas/phase-snapshot.ts";
import { isSafePlanId } from "../schemas/plan-id.ts";
import { archivePhasesDir } from "./paths.ts";
import { loadPhaseSnapshot } from "./load-phase-snapshot.ts";

// ---------------------------------------------------------------------------
// Snapshot event-evidence validator.
//
// Closes a gap that exists TODAY, independent of compaction: a phase snapshot
// with `terminal_evidence.kind === "progress_events"` carries `event_ids`, but
// nothing validates those ids resolve from the durable ledger. You can archive a
// phase, hand-delete its loose events, and validate/lint/doctor stay green while
// the snapshot's provenance dangles. This validator fails that closed.
//
// It takes an ALREADY-BUILT resolved map (`Map<event_id, ProgressEvent>`) — it
// does NOT call the progress reader (no re-entry). The caller builds the map
// from the durable set (loose ∪ validated packs); legacy is NOT a durable
// evidence source (a local-only/ignored legacy file would make evidence resolve
// on the maintainer's machine but not on a clean checkout / CI).
//
// Each `progress_events` event_id must, against the resolved map: resolve;
// belong to the SAME task; have status "done" (sv1 progress_events is done-only);
// and the task must be in the snapshot's phase task set. Returns issues; never
// throws — callers (validate/lint/doctor/compact preflight) decide severity.
// ---------------------------------------------------------------------------

export type SnapshotEvidenceIssue = {
  phase_id: string;
  task_id: string;
  event_id: string;
  reason:
    | "unresolved"
    | "wrong_task"
    | "wrong_status"
    | "task_not_in_phase";
  message: string;
};

export type SnapshotEvidenceResult =
  | { ok: true }
  | { ok: false; issues: SnapshotEvidenceIssue[] };

/**
 * The pure per-snapshot evidence check: for ONE already-parsed snapshot, every
 * `progress_events` event_id must resolve from `resolved` to an event with the
 * SAME task_id, a `done` status, and a task in the phase's task set. Pushes
 * issues into `out`. No I/O — the caller supplies the parsed snapshot. Shared by
 * the global validator (loops over all snapshots) and the per-phase validator
 * (one snapshot the caller already holds).
 */
function collectSnapshotEvidenceIssues(
  snapshot: PhaseSnapshot,
  resolved: ReadonlyMap<string, ProgressEvent>,
  out: SnapshotEvidenceIssue[],
): void {
  const phaseTaskIds = new Set(snapshot.tasks.map((t) => t.id));
  for (const task of snapshot.tasks) {
    const ev = task.terminal_evidence;
    if (ev.kind !== "progress_events") continue;
    for (const eventId of ev.event_ids) {
      const event = resolved.get(eventId);
      if (!event) {
        out.push({
          phase_id: snapshot.phase_id,
          task_id: task.id,
          event_id: eventId,
          reason: "unresolved",
          message: `snapshot "${snapshot.phase_id}" task "${task.id}" evidence event_id ${eventId} does not resolve from the durable ledger (loose ∪ packs)`,
        });
        continue;
      }
      if (event.task_id !== task.id) {
        out.push({
          phase_id: snapshot.phase_id,
          task_id: task.id,
          event_id: eventId,
          reason: "wrong_task",
          message: `snapshot "${snapshot.phase_id}" task "${task.id}" evidence event_id ${eventId} belongs to task "${event.task_id}"`,
        });
      }
      if (event.status !== "done") {
        out.push({
          phase_id: snapshot.phase_id,
          task_id: task.id,
          event_id: eventId,
          reason: "wrong_status",
          message: `snapshot "${snapshot.phase_id}" task "${task.id}" progress_events evidence event_id ${eventId} has status "${event.status}" (expected done)`,
        });
      }
      if (!phaseTaskIds.has(event.task_id)) {
        out.push({
          phase_id: snapshot.phase_id,
          task_id: task.id,
          event_id: eventId,
          reason: "task_not_in_phase",
          message: `snapshot "${snapshot.phase_id}" evidence event_id ${eventId} resolves to task "${event.task_id}" which is not in the phase task set`,
        });
      }
    }
  }
}

/**
 * TARGET-ONLY evidence validation for ONE already-parsed snapshot (the
 * `state compact` preflight path). Pass the snapshot the caller already read —
 * NOT cwd+phaseId — so the writer and the validator check the SAME bytes (no
 * TOCTOU). Does NOT scan other snapshots, so a corrupt OTHER phase can never
 * block compacting THIS phase. Global multi-snapshot validation stays the job of
 * validate / plan lint / doctor via `validateSnapshotEventEvidence`.
 */
export function validateSnapshotEventEvidenceForSnapshot(args: {
  snapshot: PhaseSnapshot;
  resolved: ReadonlyMap<string, ProgressEvent>;
}): SnapshotEvidenceResult {
  const issues: SnapshotEvidenceIssue[] = [];
  collectSnapshotEvidenceIssues(args.snapshot, args.resolved, issues);
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * The set of every task_id that belongs to an archived phase snapshot, plus soft
 * enumeration failures. Self-contained (reads only the archive dir, no roadmap),
 * so EVERY progress reader — including the low-level `loadMergedProgress` — can
 * scope the `LEGACY_EVENT_FOR_ARCHIVED_TASK` gate without a roadmap dependency.
 * A corrupt snapshot is a soft skip (it supplies no ids), never a throw.
 */
export async function readArchivedTaskIds(
  cwd: string,
): Promise<{ taskIds: Set<string>; skipped: SnapshotEvidenceSkip[] }> {
  const taskIds = new Set<string>();
  const skipped: SnapshotEvidenceSkip[] = [];
  let names: string[];
  try {
    names = await readdir(archivePhasesDir(cwd));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { taskIds, skipped };
    skipped.push({
      scope: "directory",
      detail: `archive phases directory could not be read (${code ?? "unknown error"})`,
    });
    return { taskIds, skipped };
  }
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const fileStem = basename(name, ".json");
    if (!isSafePlanId(fileStem)) {
      skipped.push({ scope: "file", detail: `unsafe snapshot filename "${name}"` });
      continue;
    }
    const res = await loadPhaseSnapshot(cwd, fileStem);
    if (res.kind === "absent") continue;
    if (res.kind === "invalid") {
      skipped.push({ scope: "file", detail: `snapshot "${fileStem}" is corrupt or unreadable` });
      continue;
    }
    for (const task of res.snapshot.tasks) taskIds.add(task.id);
  }
  return { taskIds, skipped };
}

/** A soft enumeration failure (directory unreadable / a snapshot file corrupt). */
export type SnapshotEvidenceSkip = { scope: "directory" | "file"; detail: string };

/**
 * Validate every archived phase snapshot's `progress_events` evidence against a
 * pre-built resolved durable map. `skipped` collects soft failures (the archive
 * dir is unreadable, or one snapshot file is corrupt) so the caller can record a
 * skipped-check rather than failing on enumeration noise — the same fail-soft
 * discovery contract `discoverUnreferencedSnapshots` uses.
 */
export async function validateSnapshotEventEvidence(
  cwd: string,
  resolved: ReadonlyMap<string, ProgressEvent>,
): Promise<{ result: SnapshotEvidenceResult; skipped: SnapshotEvidenceSkip[] }> {
  const issues: SnapshotEvidenceIssue[] = [];
  const skipped: SnapshotEvidenceSkip[] = [];

  let names: string[];
  try {
    names = await readdir(archivePhasesDir(cwd));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { result: { ok: true }, skipped };
    skipped.push({
      scope: "directory",
      detail: `archive phases directory could not be read (${code ?? "unknown error"})`,
    });
    return { result: { ok: true }, skipped };
  }

  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const fileStem = basename(name, ".json");
    if (!isSafePlanId(fileStem)) {
      skipped.push({ scope: "file", detail: `unsafe snapshot filename "${name}"` });
      continue;
    }
    const res = await loadPhaseSnapshot(cwd, fileStem);
    if (res.kind === "absent") continue; // vanished mid-scan
    if (res.kind === "invalid") {
      skipped.push({ scope: "file", detail: `snapshot "${fileStem}" is corrupt or unreadable` });
      continue;
    }
    collectSnapshotEvidenceIssues(res.snapshot, resolved, issues);
  }

  return {
    result: issues.length === 0 ? { ok: true } : { ok: false, issues },
    skipped,
  };
}
