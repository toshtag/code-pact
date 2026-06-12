import { readFile } from "node:fs/promises";
import type { ProgressEvent } from "../schemas/progress-event.ts";
import type { PhaseSnapshot, SnapshotTask } from "../schemas/phase-snapshot.ts";
import type { LoadedEventFile } from "../progress/events-io.ts";
import { deriveTaskState } from "../progress/task-state.ts";
import { atCompact } from "../progress/event-id.ts";
import { loadPhaseSnapshot } from "./load-phase-snapshot.ts";
import { phaseSnapshotPath, sha256Hex } from "./paths.ts";
import type { LoadedEventPack } from "./event-pack-reader.ts";

// ---------------------------------------------------------------------------
// Event-pack TIER 2 — snapshot binding + semantic replay.
//
// Tier 2 binds a Tier-1-valid pack to its phase snapshot and proves the packed
// events cannot rewrite the archived history. It resolves evidence from
// `loose ∪ THIS pack's own entries` ONLY — never the union of all packs — so an
// unvalidated/forged pack can never satisfy another pack's binding. It NEVER
// calls the progress reader (no re-entry): the caller passes a per-phase
// snapshot-raw memo cache so each phase's snapshot is read at most once.
//
// The semantic-replay rule is keyed on the (evidence kind × snapshot task
// status) PAIR. A blanket "derived == snapshot status" would falsely reject
// legitimate cancelled tasks (cancellation has no progress-event form) and
// legitimately-attested done tasks (attestation exists precisely because the
// progress events are incomplete). The pairs:
//   - progress_events + done  → POSITIVE proof: replay derives done; the
//     referenced done event is the winning terminal event.
//   - design_status + cancelled → NON-CONTRADICTION: replay must not derive done.
//   - maintainer_attestation + done → attestation is authoritative; replay may
//     derive nothing/started/blocked/resumed OR done, but NOT failed.
//   - maintainer_attestation + cancelled → NON-CONTRADICTION (as design_status).
// ---------------------------------------------------------------------------

/** One Tier-2 binding failure for a specific pack. */
export type EventPackBindingIssue = {
  phase_id: string;
  kind:
    | "snapshot_missing"
    | "snapshot_invalid"
    | "snapshot_sha256_mismatch"
    | "snapshot_phase_id_mismatch"
    | "task_id_not_in_snapshot"
    | "evidence_unresolved"
    | "semantic_replay_conflict";
  message: string;
};

/** A per-call cache of snapshot raw bytes + parse result, keyed by phase id. */
export type SnapshotRawCacheEntry =
  | { kind: "absent" }
  | { kind: "invalid"; error: unknown }
  | { kind: "valid"; raw: string; snapshot: PhaseSnapshot };

export type SnapshotRawCache = Map<string, SnapshotRawCacheEntry>;

export function newSnapshotRawCache(): SnapshotRawCache {
  return new Map();
}

/**
 * Read a snapshot's raw bytes + parsed body once per phase, memoized. Mirrors
 * `loadPhaseSnapshot` (ENOENT → absent; other error / parse failure → invalid)
 * but also keeps the raw bytes so the caller can verify `snapshot_sha256`.
 */
async function loadSnapshotRaw(
  cwd: string,
  phaseId: string,
  cache: SnapshotRawCache,
): Promise<SnapshotRawCacheEntry> {
  const hit = cache.get(phaseId);
  if (hit) return hit;
  let entry: SnapshotRawCacheEntry;
  let path: string;
  try {
    path = phaseSnapshotPath(cwd, phaseId);
  } catch (error) {
    entry = { kind: "invalid", error };
    cache.set(phaseId, entry);
    return entry;
  }
  try {
    const raw = await readFile(path, "utf8");
    // Reuse the canonical parse/validate (fail-closed on a corrupt record).
    const res = await loadPhaseSnapshot(cwd, phaseId);
    if (res.kind === "valid") {
      entry = { kind: "valid", raw, snapshot: res.snapshot };
    } else if (res.kind === "invalid") {
      entry = { kind: "invalid", error: res.error };
    } else {
      // raw read succeeded but loadPhaseSnapshot says absent: a race; treat as invalid.
      entry = { kind: "invalid", error: new Error("snapshot vanished during binding") };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") entry = { kind: "absent" };
    else entry = { kind: "invalid", error };
  }
  cache.set(phaseId, entry);
  return entry;
}

/** Sort events by the same (atCompact, id) key the merged reader uses. */
function sortForReplay(events: LoadedEventFile[]): ProgressEvent[] {
  return [...events]
    .sort((a, b) => {
      const aAt = atCompact(a.event.at);
      const bAt = atCompact(b.event.at);
      return aAt < bAt ? -1 : aAt > bAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((e) => e.event);
}

/**
 * Semantic replay for one snapshot task, keyed on (evidence kind × status).
 * `taskEvents` is this task's events from `loose ∪ ownPack`, already deduped by
 * id (the caller dedups). Returns an issue message, or null when consistent.
 */
function replayTaskConsistency(
  task: SnapshotTask,
  taskEvents: LoadedEventFile[],
): string | null {
  const ordered = sortForReplay(taskEvents);
  // deriveTaskState derives `current` from the LAST event in the given order.
  const derived = deriveTaskState(ordered, task.id);
  const ev = task.terminal_evidence;

  if (ev.kind === "progress_events") {
    // progress_events is done-only (schema-enforced). POSITIVE proof: derived
    // state must be `done`, and a referenced done event must be the winning
    // terminal event (the last event in order, which deriveTaskState used).
    if (task.status !== "done") {
      // Defensive: schema already ties progress_events to done.
      return `task "${task.id}" has progress_events evidence but status "${task.status}" (expected done)`;
    }
    if (derived.current !== "done") {
      return `task "${task.id}" (progress_events evidence) replays to "${derived.current}", not the required terminal "done"`;
    }
    const last = derived.last_event;
    if (!last || last.status !== "done") {
      return `task "${task.id}" (progress_events evidence) has no winning terminal done event after replay`;
    }
    return null;
  }

  if (ev.kind === "maintainer_attestation") {
    // Attestation is the authority for the terminal state; replay must merely
    // NOT contradict it.
    if (task.status === "done") {
      // May derive nothing / started / blocked / resumed / done — but not failed
      // (or any other state incompatible with the attested done).
      if (derived.current === "failed") {
        return `task "${task.id}" is attested done but replays to "failed" — packed events contradict the attestation`;
      }
      return null;
    }
    // attested + cancelled (if ever used): non-contradiction — must not derive done.
    if (derived.current === "done") {
      return `task "${task.id}" is attested ${task.status} but replays to terminal "done" — packed events contradict the attestation`;
    }
    return null;
  }

  // design_status (cancelled-only, schema-enforced): NON-CONTRADICTION — replay
  // must not derive terminal done. Absence of a progress-derived cancelled is
  // expected (cancellation is design-YAML-derived, not event-derived).
  if (derived.current === "done") {
    return `task "${task.id}" is ${task.status} (design_status) but replays to terminal "done" — packed events contradict the snapshot`;
  }
  return null;
}

/**
 * Tier 2: bind one Tier-1-valid pack to its phase snapshot and prove its events
 * cannot rewrite history. Resolves evidence from `loose ∪ pack.entries` ONLY.
 * Returns an array of issues (empty = bound). Never throws on a binding failure
 * (the caller decides strict-throw vs lenient-collect); it only awaits the
 * memoized snapshot read.
 *
 * `looseEventsById` is the loose-file events keyed by id (the caller's loose
 * set). The own-pack entries are merged in here, deduped by id.
 */
export async function validateEventPackBinding(
  cwd: string,
  loadedPack: LoadedEventPack,
  looseEventsById: ReadonlyMap<string, LoadedEventFile>,
  cache: SnapshotRawCache,
): Promise<EventPackBindingIssue[]> {
  const phaseId = loadedPack.phaseId;
  const issues: EventPackBindingIssue[] = [];
  const mk = (kind: EventPackBindingIssue["kind"], message: string) =>
    issues.push({ phase_id: phaseId, kind, message });

  const snap = await loadSnapshotRaw(cwd, phaseId, cache);
  if (snap.kind === "absent") {
    mk("snapshot_missing", `no phase snapshot for pack "${phaseId}" — a pack must bind to an archived snapshot`);
    return issues;
  }
  if (snap.kind === "invalid") {
    mk("snapshot_invalid", `phase snapshot for pack "${phaseId}" is corrupt or unreadable`);
    return issues;
  }

  const snapshot = snap.snapshot;
  if (sha256Hex(snap.raw) !== loadedPack.pack.snapshot_sha256) {
    mk(
      "snapshot_sha256_mismatch",
      `pack snapshot_sha256 (${loadedPack.pack.snapshot_sha256}) does not match the on-disk snapshot bytes`,
    );
  }
  if (snapshot.phase_id !== phaseId) {
    mk(
      "snapshot_phase_id_mismatch",
      `snapshot phase_id "${snapshot.phase_id}" does not match pack phase_id "${phaseId}"`,
    );
  }

  // Build the per-pack resolution set: loose ∪ this pack's own entries, deduped
  // by id. NEVER other packs' events.
  const ownById = new Map<string, LoadedEventFile>();
  for (const e of looseEventsById.values()) ownById.set(e.id, e);
  for (const e of loadedPack.entries) ownById.set(e.id, e);

  const snapshotTaskIds = new Set(snapshot.tasks.map((t) => t.id));

  // Cross-task injection guard: every packed event's task_id must belong to the
  // snapshot's phase task set.
  for (const entry of loadedPack.entries) {
    if (!snapshotTaskIds.has(entry.event.task_id)) {
      mk(
        "task_id_not_in_snapshot",
        `packed event for task "${entry.event.task_id}" is not in snapshot "${phaseId}" task set`,
      );
    }
  }

  // Per-task: evidence resolution (progress_events ids must resolve, with the
  // status rule) + semantic replay (kind × status).
  const allEvents = [...ownById.values()];
  for (const task of snapshot.tasks) {
    const ev = task.terminal_evidence;
    if (ev.kind === "progress_events") {
      for (const eventId of ev.event_ids) {
        const resolved = ownById.get(eventId);
        if (!resolved) {
          mk(
            "evidence_unresolved",
            `task "${task.id}" evidence event_id ${eventId} does not resolve from loose ∪ pack`,
          );
          continue;
        }
        if (resolved.event.task_id !== task.id) {
          mk(
            "evidence_unresolved",
            `task "${task.id}" evidence event_id ${eventId} belongs to task "${resolved.event.task_id}"`,
          );
        }
        if (resolved.event.status !== "done") {
          mk(
            "evidence_unresolved",
            `task "${task.id}" progress_events evidence event_id ${eventId} has status "${resolved.event.status}" (expected done)`,
          );
        }
      }
    }
    // Semantic replay for this task from loose ∪ ownPack (this task's events).
    const taskEvents = allEvents.filter((e) => e.event.task_id === task.id);
    const conflict = replayTaskConsistency(task, taskEvents);
    if (conflict) mk("semantic_replay_conflict", conflict);
  }

  return issues;
}
