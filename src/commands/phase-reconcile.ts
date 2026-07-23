import { resolvePhaseRef } from "../core/plan/resolve-phase.ts";
import { loadPhase } from "../core/plan/load-phase.ts";
import { loadRoadmap } from "../core/plan/roadmap.ts";
import { Phase, type PhaseStatus } from "../core/schemas/phase.ts";
import { loadProgressLog } from "../core/progress/io.ts";
import {
  deriveTaskState,
  type TaskCurrentState,
} from "../core/progress/task-state.ts";
import {
  applyPlannedWrite,
  classifyWriteRequest,
  type WriteRefusalReason,
} from "../core/finalize/safe-write.ts";
import type { TaskStatusDiff } from "../core/finalize/diff.ts";
import { classifyReconcile } from "../core/finalize/reconcile-classifier.ts";
import { derivePhaseLifecycleStatus } from "../core/phase-lifecycle-status.ts";

// ---------------------------------------------------------------------------
// `phase reconcile <phase-id>`
//
// Bulk version of `task finalize`: walks `phase.tasks[]` once and flips
// every task whose derived state is `done` but whose design status is
// still `planned` / `in_progress`. Default is dry-run; `--write` is
// the explicit opt-in.
//
// `phase reconcile` never auto-flips the phase's own `status` field —
// it reports a `phase_status_candidate` as advisory only.
// Per-task flip / skip / manual_review classification is exposed in
// `data.tasks[]` so the user can audit the verdict before --write.
//
// Partial success: `--write` does NOT raise an error when some tasks
// flip and others are refused. `applied_writes[]` and `skipped_writes[]`
// are both populated and exit 0 is returned. Only when EVERY eligible
// write is refused does `PHASE_RECONCILE_WRITE_REFUSED` (exit 2) fire.
// ---------------------------------------------------------------------------

export type PhaseReconcileOptions = {
  cwd: string;
  phaseId: string;
  /** When true, apply the writes. Default (false) is dry-run. */
  write?: boolean;
};

export type TaskReconcileVerdict = {
  task_id: string;
  current_design_status: PhaseStatus;
  derived_state: TaskCurrentState;
  target_status: "done";
  action: "flip" | "skip" | "manual_review";
  reason: string | null;
};

export type SkippedWrite = {
  file: string;
  task_id: string;
  reason: WriteRefusalReason;
  detail: string;
};

type ReconcileContext = {
  phase_id: string;
  file: string;
  tasks: TaskReconcileVerdict[];
  phase_status_candidate: PhaseStatus;
  phase_status_note: string;
};

export type PhaseReconcileResult =
  | (ReconcileContext & {
      kind: "would_reconcile";
      planned_writes: TaskStatusDiff[];
    })
  | (ReconcileContext & {
      kind: "reconciled";
      applied_writes: TaskStatusDiff[];
      skipped_writes: SkippedWrite[];
    })
  | (ReconcileContext & {
      kind: "no_eligible_tasks";
    });

const PHASE_STATUS_ADVISORY_NOTE =
  "advisory — phase status is never written by phase reconcile; flip it by hand in release prep";

async function resolvePhase(
  cwd: string,
  phaseId: string,
): Promise<{ phase: Phase; file: string }> {
  // Contained roadmap seam — this is a `--write` (mutating) command, so reading
  // the target phase from an out-of-project symlinked roadmap is refused.
  const roadmap = await loadRoadmap(cwd);
  const ref = resolvePhaseRef(roadmap, phaseId);
  const phase = await loadPhase(cwd, ref.path);
  return { phase, file: ref.path };
}

/**
 * Computes the candidate phase status by simulating each task's
 * post-reconcile effective status and aggregating. Never writes
 * anything — this is advisory only.
 */
function computePhaseStatusCandidate(
  verdicts: TaskReconcileVerdict[],
): PhaseStatus {
  const states = verdicts.map(v => ({
    design_status: v.current_design_status,
    derived_state: v.derived_state,
  }));
  return derivePhaseLifecycleStatus(states);
}

export async function runPhaseReconcile(
  opts: PhaseReconcileOptions,
): Promise<PhaseReconcileResult> {
  const { cwd, phaseId } = opts;
  const write = opts.write === true;

  // 1. Resolve phase from roadmap.
  const { phase, file } = await resolvePhase(cwd, phaseId);

  // 2. Load progress events and derive per-task state.
  const { log } = await loadProgressLog(cwd);

  // 3. Classify each task.
  const tasks = phase.tasks ?? [];
  const verdicts: TaskReconcileVerdict[] = tasks.map(t => {
    const derived = deriveTaskState(log.events, t.id).current;
    const { action, reason } = classifyReconcile(t.status, derived);
    return {
      task_id: t.id,
      current_design_status: t.status,
      derived_state: derived,
      target_status: "done",
      action,
      reason,
    };
  });

  // 4. Compute phase status candidate (advisory).
  const phase_status_candidate = computePhaseStatusCandidate(verdicts);

  const baseContext: ReconcileContext = {
    phase_id: phase.id,
    file,
    tasks: verdicts,
    phase_status_candidate,
    phase_status_note: PHASE_STATUS_ADVISORY_NOTE,
  };

  // 5. Collect the flip candidates (the only eligible writes).
  const flipCandidates = verdicts.filter(v => v.action === "flip");

  if (flipCandidates.length === 0) {
    return { kind: "no_eligible_tasks", ...baseContext };
  }

  // 6. Dry-run: classify each candidate against safe-write rules and
  //    collect the diffs. Refusals at classify time still go in
  //    skipped_writes once we apply (or in the dry-run output too — we
  //    represent them in planned_writes only for the writable subset).
  const plannedDiffs: TaskStatusDiff[] = [];
  const skippedAtClassify: SkippedWrite[] = [];
  for (const v of flipCandidates) {
    const classified = await classifyWriteRequest({
      cwd,
      file,
      taskId: v.task_id,
      targetStatus: "done",
    });
    if (classified.kind === "refused") {
      skippedAtClassify.push({
        file: classified.file,
        task_id: v.task_id,
        reason: classified.reason,
        detail: classified.detail,
      });
      continue;
    }
    if (classified.kind === "no-op") {
      // Defensive: should not happen because the verdict only marks
      // `flip` when design status differs. Treat as skip silently.
      continue;
    }
    plannedDiffs.push(classified.diff);
  }

  if (!write) {
    // In dry-run we surface refusals only via skipped_writes if any
    // were caught at classify-time. Mostly this stays empty.
    return {
      kind: "would_reconcile",
      ...baseContext,
      planned_writes: plannedDiffs,
    };
  }

  // 7. --write: apply each planned diff. Apply-time refusals go to
  //    skipped_writes too.
  const appliedWrites: TaskStatusDiff[] = [];
  const skippedWrites: SkippedWrite[] = [...skippedAtClassify];
  for (const diff of plannedDiffs) {
    try {
      await applyPlannedWrite(cwd, diff);
      appliedWrites.push(diff);
    } catch (err) {
      skippedWrites.push({
        file: diff.file,
        task_id: diff.task_id,
        reason: "unreadable",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 8. If every eligible write was refused, raise the error code.
  if (
    appliedWrites.length === 0 &&
    skippedWrites.length > 0 &&
    skippedWrites.length === flipCandidates.length
  ) {
    const err = new Error(
      `phase reconcile --write was unable to apply any of ${flipCandidates.length} eligible writes for phase "${phase.id}".`,
    );
    (err as NodeJS.ErrnoException).code = "PHASE_RECONCILE_WRITE_REFUSED";
    (
      err as NodeJS.ErrnoException & {
        phase_id?: string;
        file?: string;
        skipped_writes?: SkippedWrite[];
      }
    ).phase_id = phase.id;
    (
      err as NodeJS.ErrnoException & {
        phase_id?: string;
        file?: string;
        skipped_writes?: SkippedWrite[];
      }
    ).file = file;
    (
      err as NodeJS.ErrnoException & {
        phase_id?: string;
        file?: string;
        skipped_writes?: SkippedWrite[];
      }
    ).skipped_writes = skippedWrites;
    throw err;
  }

  return {
    kind: "reconciled",
    ...baseContext,
    applied_writes: appliedWrites,
    skipped_writes: skippedWrites,
  };
}
