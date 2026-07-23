import { type PhaseStatus } from "../core/schemas/phase.ts";
import { loadProgressLog } from "../core/progress/io.ts";
import {
  deriveTaskState,
  type TaskCurrentState,
} from "../core/progress/task-state.ts";
import { resolveTaskDependencyStates } from "../core/task-dependencies.ts";
import {
  applyPlannedWrite,
  classifyWriteRequest,
  type WriteRefusalReason,
} from "../core/finalize/safe-write.ts";
import type { TaskStatusDiff } from "../core/finalize/diff.ts";
import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";
import { auditWrites, type WriteAuditResult } from "../core/audit/index.ts";
import { projectPathPresence } from "../core/plan/checks/fs.ts";
import { assertTaskContractCurrent } from "../core/contract-lock.ts";
import { assertTaskLifecycleNotCancelled } from "../core/task-cancellation.ts";

// ---------------------------------------------------------------------------
// `task finalize <task-id>`
//
// Flips a single task's design YAML `status` field to `done`, but only
// when the task already has a `done` event in the progress ledger. Default
// mode is dry-run; `--write` is the explicit opt-in to mutate disk.
//
// The contract that `task complete` records progress only and
// never mutates design YAML is preserved — this command is the
// explicit, separate opposite-direction operation that drains
// `STATUS_DRIFT done-but-design-not-done` warnings.
//
// This command does NOT take an --agent flag. It is a
// design/progress reconciliation command that never calls an adapter.
// ---------------------------------------------------------------------------

export type TaskFinalizeOptions = {
  cwd: string;
  taskId: string;
  /** When true, apply the write. Default (false) is dry-run. */
  write?: boolean;
  /**
   * Optional base ref for branch-level declared-writes audit. When
   * undefined, the audit (if requested) operates in working-tree mode.
   */
  baseRef?: string;
  /**
   * When true, populate `write_audit` on the result. Default (false)
   * skips the audit entirely — no git spawn, no envelope field. The CLI
   * sets this to `true` only when `--json` is in effect, so human mode
   * `task finalize` runs no audit.
   */
  includeWriteAudit?: boolean;
  /**
   * When true, presence of any `TASK_WRITES_AUDIT_*` warning in the
   * audit result aborts the finalize: no design YAML mutation, the
   * caller sees `TaskFinalizeAuditStrictError`. The CLI surfaces the
   * error as `WRITES_AUDIT_STRICT_FAILED` (exit 1). Requires
   * `includeWriteAudit: true`; supplying `auditStrict: true` with the
   * audit disabled is a programmer error and is rejected.
   */
  auditStrict?: boolean;
};

/**
 * Thrown by `runTaskFinalize` when `auditStrict: true` and the audit
 * emitted at least one warning. The exception carries the full audit
 * envelope so the CLI can return the same `write_audit` shape callers
 * already expect, just under an error envelope instead of a success
 * envelope.
 */
export class TaskFinalizeAuditStrictError extends Error {
  readonly code = "WRITES_AUDIT_STRICT_FAILED";
  readonly task_id: string;
  readonly phase_id: string;
  readonly write_audit: WriteAuditResult;
  readonly applied: boolean;

  constructor(
    task_id: string,
    phase_id: string,
    write_audit: WriteAuditResult,
    message: string,
  ) {
    super(message);
    this.name = "TaskFinalizeAuditStrictError";
    this.task_id = task_id;
    this.phase_id = phase_id;
    this.write_audit = write_audit;
    // Strict gate fires BEFORE `applyPlannedWrite`, so no design YAML
    // mutation ever happens on the strict path. Lock this fact into the
    // error so future maintainers (and downstream tooling) can rely on
    // it without re-deriving from the flow.
    this.applied = false;
  }
}

export type AcceptanceRefCheck = {
  path: string;
  exists: boolean;
};

export type DependsOnCheck = {
  task_id: string;
  current: TaskCurrentState;
  satisfied: boolean;
};

type FinalizeContext = {
  task_id: string;
  phase_id: string;
  file: string;
  current_status: PhaseStatus;
  target_status: "done";
  acceptance_refs_check: AcceptanceRefCheck[];
  declared_writes: string[];
  depends_on_check: DependsOnCheck[];
  /**
   * Populated only when `TaskFinalizeOptions.includeWriteAudit === true`.
   * The CLI sets this whenever `--json` is in effect, so all three
   * success kinds carry the audit in the JSON envelope.
   */
  write_audit?: WriteAuditResult;
};

export type TaskFinalizeResult =
  | (FinalizeContext & {
      kind: "would_finalize";
      planned_writes: TaskStatusDiff[];
    })
  | (FinalizeContext & {
      kind: "finalized";
      applied_writes: TaskStatusDiff[];
      skipped_writes: never[];
    })
  | (FinalizeContext & {
      kind: "already_finalized";
    });

export async function runTaskFinalize(
  opts: TaskFinalizeOptions,
): Promise<TaskFinalizeResult> {
  const { cwd, taskId } = opts;
  const write = opts.write === true;

  // 1. Resolve task → phase + file. The shared resolver returns
  // `phasePath`; alias to the local `file` to keep the rest of this
  // function (which feeds `file` into the safe-write classifier and
  // the public FinalizeContext) unchanged.
  const { phaseId, phasePath: file } = await resolveTaskInRoadmap(cwd, taskId);

  // 2. Derive current state from the progress ledger.
  const { log } = await loadProgressLog(cwd);
  const state = deriveTaskState(log.events, taskId);

  // 3. Eligibility check — derived state must be `done`. Identical in
  //    dry-run and --write modes; dry-run means "won't write", not
  //    "won't validate".
  if (state.current !== "done") {
    const err = new Error(
      `Task "${taskId}" is not finalize-eligible: derived state is "${state.current}", expected "done". Run \`task complete ${taskId}\` first.`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_FINALIZE_NOT_ELIGIBLE";
    (
      err as NodeJS.ErrnoException & {
        current?: string;
        task_id?: string;
        phase_id?: string;
      }
    ).current = state.current;
    (
      err as NodeJS.ErrnoException & {
        current?: string;
        task_id?: string;
        phase_id?: string;
      }
    ).task_id = taskId;
    (
      err as NodeJS.ErrnoException & {
        current?: string;
        task_id?: string;
        phase_id?: string;
      }
    ).phase_id = phaseId;
    throw err;
  }

  // 4. Classify the safe-write request. This reads the phase YAML and
  //    validates path safety + parseability + task existence.
  const classified = await classifyWriteRequest({
    cwd,
    file,
    taskId,
    targetStatus: "done",
  });

  if (classified.kind === "refused") {
    const err = new Error(
      `Refused to finalize "${taskId}": ${classified.detail}`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_FINALIZE_WRITE_REFUSED";
    (
      err as NodeJS.ErrnoException & {
        reason?: WriteRefusalReason;
        file?: string;
      }
    ).reason = classified.reason;
    (
      err as NodeJS.ErrnoException & {
        reason?: WriteRefusalReason;
        file?: string;
      }
    ).file = classified.file;
    throw err;
  }

  // 5. The phase parsed cleanly and the task exists. Pull the readiness
  //    fields off the task for the report sections that appear under every
  //    kind.
  const task = (classified.phase.tasks ?? []).find(t => t.id === taskId);
  // task is guaranteed present because classifyWriteRequest validated it.
  if (!task) {
    throw new Error(
      `internal invariant: task "${taskId}" missing from classified phase`,
    );
  }

  assertTaskLifecycleNotCancelled(taskId, task.status, state.current);

  // TASK_CONTRACT_DRIFT gate. A lock is required unless the task was already
  // finalized before contract locking existed. The locked base and phase blob
  // must still be ancestors of / reachable from HEAD, and the canonical digest
  // of the contract must be unchanged.
  await assertTaskContractCurrent({ cwd, taskId, requireLock: true });

  const acceptanceRefsCheck: AcceptanceRefCheck[] = [];
  for (const ref of task.acceptance_refs ?? []) {
    const exists = (await projectPathPresence(cwd, ref)) === "present";
    acceptanceRefsCheck.push({ path: ref, exists });
  }

  const dependsOnCheck: DependsOnCheck[] = resolveTaskDependencyStates(
    log.events,
    task,
  );

  const baseContext: FinalizeContext = {
    task_id: taskId,
    phase_id: phaseId,
    file,
    current_status: task.status,
    target_status: "done",
    acceptance_refs_check: acceptanceRefsCheck,
    declared_writes: task.writes ? [...task.writes] : [],
    depends_on_check: dependsOnCheck,
  };

  if (opts.includeWriteAudit === true) {
    baseContext.write_audit = await auditWrites({
      cwd,
      declaredWrites: baseContext.declared_writes,
      baseRef: opts.baseRef,
    });
  } else if (opts.auditStrict === true) {
    // Programmer-error guard: auditStrict without includeWriteAudit
    // would silently degrade to "no strict gate ever fires". Refuse
    // loudly so the CLI never lands in that state.
    throw new Error(
      "runTaskFinalize: auditStrict=true requires includeWriteAudit=true",
    );
  }

  // --audit-strict gate. Runs AFTER the audit but BEFORE
  // any design YAML mutation (`applyPlannedWrite`), so the strict
  // failure path never leaves a half-applied flip behind.
  if (
    opts.auditStrict === true &&
    baseContext.write_audit !== undefined &&
    baseContext.write_audit.warnings.length > 0
  ) {
    const warnList = baseContext.write_audit.warnings.join(", ");
    throw new TaskFinalizeAuditStrictError(
      taskId,
      phaseId,
      baseContext.write_audit,
      `task finalize "${taskId}": --audit-strict and audit emitted warnings: ${warnList}. No design YAML mutation applied.`,
    );
  }

  // 6. Idempotent no-op: already at target.
  if (classified.kind === "no-op") {
    return {
      kind: "already_finalized",
      ...baseContext,
    };
  }

  // 7. classified.kind === "planned": either dry-run report or apply.
  if (!write) {
    return {
      kind: "would_finalize",
      ...baseContext,
      planned_writes: [classified.diff],
    };
  }

  await applyPlannedWrite(cwd, classified.diff);

  return {
    kind: "finalized",
    ...baseContext,
    applied_writes: [classified.diff],
    skipped_writes: [],
  };
}
