import { readFile } from "node:fs/promises";
import { PhaseSnapshot } from "../schemas/phase-snapshot.ts";
import type { TerminalEvidence } from "../schemas/phase-snapshot.ts";
import { phaseSnapshotPath, sha256Hex } from "./paths.ts";

// ---------------------------------------------------------------------------
// The FIRST reader of the `.code-pact/state/archive/phases/<id>.json` snapshots
// written by `phase-snapshot.ts` (step 3). Used by step 4a to tolerate a
// hand-deleted COMPLETED phase whose roadmap ref still points at the now-missing
// file — WITHOUT faking a `Phase` and WITHOUT introducing task-id ambiguity.
//
// Locked invariants (see design/decisions/design-docs-ephemeral-directive.md and
// the step-4a plan):
//   - LIVE WINS — callers read a snapshot ONLY when the live phase YAML is gone.
//   - NEVER coerce a snapshot into `Phase` — a snapshot is intentionally smaller.
//   - The reader does NOT trust the writer: every identity / terminal / collision
//     condition is re-checked here. A snapshot that is schema-valid but unsafe
//     against the current live+archived graph is fail-closed, not tolerated.
//   - EXISTENCE ≠ SATISFACTION — the archived task index proves a task id EXISTED;
//     dependency satisfaction stays event-based elsewhere. The index carries
//     status/evidence for provenance only, never as a satisfaction source.
// ---------------------------------------------------------------------------

/** Outcome of loading one snapshot file off disk. `invalid` is NEVER collapsed
 * to `absent` — a present-but-corrupt record is a louder signal than "nothing
 * there" and must fail closed distinctly. */
export type LoadPhaseSnapshotResult =
  | { kind: "absent" }
  | { kind: "invalid"; error: unknown }
  | { kind: "valid"; snapshot: PhaseSnapshot };

/**
 * Read `.code-pact/state/archive/phases/<phaseId>.json`, JSON-parse, and
 * `PhaseSnapshot.parse()`-validate. ENOENT → `absent`; any other read error or
 * a JSON/schema failure → `invalid` (never `absent`). An unsafe `phaseId`
 * (rejected by `phaseSnapshotPath` → `assertSafePlanId`) surfaces as `invalid`,
 * fail-closed — a malformed roadmap id never silently resolves a missing phase.
 */
export async function loadPhaseSnapshot(
  cwd: string,
  phaseId: string,
): Promise<LoadPhaseSnapshotResult> {
  let path: string;
  try {
    path = phaseSnapshotPath(cwd, phaseId);
  } catch (error) {
    return { kind: "invalid", error };
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    // A present-but-unreadable record (EACCES, EISDIR, …) must NOT be treated as
    // absent — that would silently tolerate a missing phase on a broken record.
    return { kind: "invalid", error };
  }

  try {
    const snapshot = PhaseSnapshot.parse(JSON.parse(raw) as unknown);
    return { kind: "valid", snapshot };
  } catch (error) {
    return { kind: "invalid", error };
  }
}

/** Resolution of a roadmap ref whose live phase file is missing. */
export type PhaseRefResolution =
  | { kind: "tolerated"; snapshot: PhaseSnapshot }
  | { kind: "fail_missing" }
  | { kind: "fail_invalid"; reason: string };

/**
 * Decide whether a MISSING roadmap-referenced phase may be tolerated as an
 * archived completed phase. Call ONLY after the caller has established the live
 * file is absent (live-wins is the caller's short-circuit). A snapshot is
 * accepted ONLY as positive proof of an archived completed phase — every line of
 * the checklist must hold, or it is fail-closed. This deliberately does NOT trust
 * the writer's guarantees: id / path / path-hash / terminal status are all
 * re-asserted here.
 *
 * NOTE: task-id collision (intra-snapshot / cross-snapshot / archived-vs-live) is
 * a GRAPH-WIDE property and is NOT checked here (this is single-ref). It is
 * enforced by `mergeArchivedTaskIndex`, which every reader path runs before any
 * archived id enters the known set.
 */
export async function resolveMissingPhaseRef(
  cwd: string,
  ref: { id: string; path: string },
): Promise<PhaseRefResolution> {
  const res = await loadPhaseSnapshot(cwd, ref.id);
  if (res.kind === "absent") return { kind: "fail_missing" };
  if (res.kind === "invalid") {
    return { kind: "fail_invalid", reason: "archive snapshot is corrupt or unreadable" };
  }

  const s = res.snapshot;
  // Identity: the record must be for THIS ref, not a misfiled / foreign / renamed
  // one. `<id>.json` names the file, but the body must agree.
  if (s.phase_id !== ref.id) {
    return {
      kind: "fail_invalid",
      reason: `archive snapshot phase_id "${s.phase_id}" does not match roadmap ref id "${ref.id}"`,
    };
  }
  if (s.original_path !== ref.path) {
    return {
      kind: "fail_invalid",
      reason: `archive snapshot original_path "${s.original_path}" does not match roadmap ref path "${ref.path}"`,
    };
  }
  // Re-assert the writer's path_sha256 invariant rather than trusting it.
  if (s.path_sha256 !== sha256Hex(s.original_path)) {
    return {
      kind: "fail_invalid",
      reason: `archive snapshot path_sha256 does not cover its own original_path "${s.original_path}"`,
    };
  }
  // Terminal re-check (defense-in-depth: today the enum is done|cancelled, so a
  // non-terminal record is already schema-invalid; this guards a future widening).
  if (s.phase_status !== "done" && s.phase_status !== "cancelled") {
    return {
      kind: "fail_invalid",
      reason: `archive snapshot phase_status "${s.phase_status}" is not terminal`,
    };
  }
  return { kind: "tolerated", snapshot: s };
}

/**
 * One archived task id, recovered from a tolerated snapshot. EXISTENCE-ONLY —
 * NEVER a satisfaction source. `status` / `terminal_evidence` are provenance for
 * diagnostics and the cancelled-vs-done existence/satisfaction distinction made
 * elsewhere (dependency satisfaction stays event-based). Do not derive
 * "dependency met" from this type.
 */
export type ArchivedTaskEntry = {
  phase_id: string;
  original_path: string;
  task_id: string;
  status: "done" | "cancelled";
  terminal_evidence: TerminalEvidence;
};

/** Project a tolerated snapshot's tasks into archived task entries. */
export function archivedEntriesFromSnapshot(s: PhaseSnapshot): ArchivedTaskEntry[] {
  return s.tasks.map((t) => ({
    phase_id: s.phase_id,
    original_path: s.original_path,
    task_id: t.id,
    status: t.status,
    terminal_evidence: t.terminal_evidence,
  }));
}

/** One detected task-id collision (for the caller to surface as PHASE_SNAPSHOT_INVALID). */
export type ArchivedTaskCollision = {
  task_id: string;
  /** Where the colliding id appears, for the human message. */
  kind: "live" | "cross_snapshot" | "intra_snapshot";
  /** The archived phase id(s) involved. */
  phase_ids: string[];
  reason: string;
};

export type MergeArchivedTaskIndexResult = {
  /** Collision-free archived task ids → entry. Every colliding id is ABSENT. */
  index: Map<string, ArchivedTaskEntry>;
  /** Collisions, one per offending task id. Non-empty ⇒ fail-closed. */
  collisions: ArchivedTaskCollision[];
};

/**
 * Merge per-phase candidate archived entries into a collision-checked index that
 * every reader path consults BEFORE any archived id is used to suppress
 * `TASK_DEPENDS_ON_UNRESOLVED` / `ORPHAN_PROGRESS_EVENT`. Three collisions are
 * fail-closed — an archived task id is rejected when it duplicates:
 *   1. itself, within one snapshot (the snapshot schema does NOT enforce this);
 *   2. across two tolerated snapshots;
 *   3. a LIVE task id (`liveTaskIds`).
 * A colliding id is fail-closed (`PHASE_SNAPSHOT_INVALID`, the caller's job) and
 * NEVER picks a winner: it is dropped from ALL sides and never enters `index`.
 * A non-colliding sibling id in the same snapshot is unambiguous and is KEPT —
 * the drop unit is the id, not the phase. The live id (case 3) is untouched in
 * its own live taskIndex; only the archived contribution is dropped.
 */
export function mergeArchivedTaskIndex(
  liveTaskIds: ReadonlySet<string>,
  candidates: readonly ArchivedTaskEntry[],
): MergeArchivedTaskIndexResult {
  // First pass: count occurrences across all candidates + note intra-snapshot
  // duplicates, so a 3-way collision is reported once and consistently dropped.
  const seen = new Map<string, ArchivedTaskEntry>();
  const collidingIds = new Map<string, ArchivedTaskCollision>();

  const recordCollision = (
    task_id: string,
    kind: ArchivedTaskCollision["kind"],
    phaseId: string,
    reason: string,
  ) => {
    const existing = collidingIds.get(task_id);
    if (existing) {
      if (!existing.phase_ids.includes(phaseId)) existing.phase_ids.push(phaseId);
      return;
    }
    collidingIds.set(task_id, { task_id, kind, phase_ids: [phaseId], reason });
  };

  // Track intra-snapshot duplicates: same (phase_id, task_id) twice.
  const perPhaseSeen = new Set<string>();

  for (const entry of candidates) {
    const { task_id, phase_id } = entry;

    // Case 3: archived vs live.
    if (liveTaskIds.has(task_id)) {
      recordCollision(
        task_id,
        "live",
        phase_id,
        `archived task id "${task_id}" (phase "${phase_id}") collides with a live task id`,
      );
    }

    // Case 1: intra-snapshot duplicate.
    const phaseTaskKey = JSON.stringify([phase_id, task_id]);
    if (perPhaseSeen.has(phaseTaskKey)) {
      recordCollision(
        task_id,
        "intra_snapshot",
        phase_id,
        `archived task id "${task_id}" appears more than once within snapshot "${phase_id}"`,
      );
    }
    perPhaseSeen.add(phaseTaskKey);

    // Case 2: cross-snapshot duplicate (same id, different tolerated snapshot).
    const prior = seen.get(task_id);
    if (prior && prior.phase_id !== phase_id) {
      recordCollision(
        task_id,
        "cross_snapshot",
        prior.phase_id,
        `archived task id "${task_id}" is claimed by two snapshots ("${prior.phase_id}" and "${phase_id}")`,
      );
      recordCollision(task_id, "cross_snapshot", phase_id, collidingIds.get(task_id)!.reason);
    }
    if (!seen.has(task_id)) seen.set(task_id, entry);
  }

  // Build the index, EXCLUDING every colliding id (never pick a winner).
  const index = new Map<string, ArchivedTaskEntry>();
  for (const entry of candidates) {
    if (collidingIds.has(entry.task_id)) continue;
    if (!index.has(entry.task_id)) index.set(entry.task_id, entry);
  }

  return { index, collisions: [...collidingIds.values()] };
}
