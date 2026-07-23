import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadPlanState } from "../core/plan/state.ts";
import { resolveTaskInPlanState } from "../core/plan/resolve-task.ts";
import {
  resolvePhaseReadPath,
  resolvePhaseWritePath,
  readOwnedText,
} from "../core/project-fs/index.ts";
import { Phase, type PhaseStatus } from "../core/schemas/phase.ts";
import {
  deriveTaskState,
  type TaskCurrentState,
} from "../core/progress/task-state.ts";
import { loadProgressLog } from "../core/progress/io.ts";
import { directTaskDependents } from "../core/task-dependents.ts";
import {
  assertTaskCancelEligibility,
  assertNoNonCancelledTaskDependents,
} from "../core/task-cancellation.ts";
import {
  derivePhaseLifecycleStatus,
  type PhaseLifecycleTaskState,
} from "../core/phase-lifecycle-status.ts";
import {
  atomicWriteText,
  atomicReplaceExistingText,
} from "../io/atomic-text.ts";
import { postLockRegistrationChangedFields } from "../core/task-registration-spec.ts";

export type TaskCancelOptions = {
  cwd: string;
  taskId: string;
  /** When true, apply the cancellation. Default (false) is dry-run. */
  write?: boolean;
};

export type PhaseLifecycleStatus = "planned" | "in_progress" | "done";

export type TaskCancelNext = {
  type: "noop" | "write_required" | "reconcile";
  message: string;
  command: string | null;
};

type TaskCancelCommon = {
  kind: string;
  task_id: string;
  phase_id: string;
  file: string;
  design_status: PhaseStatus;
  derived_state: TaskCurrentState;
  phase_status_candidate: PhaseLifecycleStatus;
  progress_history_preserved: true;
  contract_lock_preserved: true;
  task_spec_preserved: true;
  next: TaskCancelNext;
};

export type TaskCancelResult =
  | (TaskCancelCommon & {
      kind: "already_cancelled";
      previous_design_status: null;
      would_change: null;
    })
  | (TaskCancelCommon & {
      kind: "cancel_preview";
      previous_design_status: PhaseStatus;
      would_change: {
        design_status: { from: PhaseStatus; to: "cancelled" };
      };
    })
  | (TaskCancelCommon & {
      kind: "cancelled";
      previous_design_status: PhaseStatus;
      applied_change: {
        design_status: { from: PhaseStatus; to: "cancelled" };
      };
    });

function buildPhaseStatusCandidate(
  phase: Phase,
  targetTaskId: string,
  events: readonly import("../core/schemas/progress-event.ts").ProgressEvent[],
): PhaseLifecycleStatus {
  const states: PhaseLifecycleTaskState[] = (phase.tasks ?? []).map(t => ({
    design_status: t.id === targetTaskId ? "cancelled" : t.status,
    derived_state: deriveTaskState(events, t.id).current,
  }));
  return derivePhaseLifecycleStatus(states);
}

function cancelNext(
  kind: "already_cancelled" | "cancel_preview" | "cancelled",
  taskId: string,
  phaseId: string,
): TaskCancelNext {
  if (kind === "already_cancelled") {
    return {
      type: "noop",
      message:
        "Task is already cancelled. No further lifecycle operations are allowed.",
      command: null,
    };
  }
  if (kind === "cancel_preview") {
    return {
      type: "write_required",
      message: "Dry-run preview. Pass --write to apply the cancellation.",
      command: `code-pact task cancel ${taskId} --write`,
    };
  }
  return {
    type: "reconcile",
    message:
      "Cancellation applied. Reconcile the phase when remaining tasks are terminal.",
    command: `code-pact phase reconcile ${phaseId}`,
  };
}

function buildResult<
  K extends "already_cancelled" | "cancel_preview" | "cancelled",
>(
  kind: K,
  taskId: string,
  phaseId: string,
  file: string,
  designStatus: PhaseStatus,
  derivedState: TaskCurrentState,
  previousDesignStatus: PhaseStatus | null,
  phaseStatusCandidate: PhaseLifecycleStatus,
): Extract<TaskCancelResult, { kind: K }> {
  const common = {
    task_id: taskId,
    phase_id: phaseId,
    file,
    design_status: designStatus,
    derived_state: derivedState,
    phase_status_candidate: phaseStatusCandidate,
    progress_history_preserved: true as const,
    contract_lock_preserved: true as const,
    task_spec_preserved: true as const,
    next: cancelNext(kind, taskId, phaseId),
  };

  if (kind === "already_cancelled") {
    return {
      ...common,
      kind,
      previous_design_status: null,
      would_change: null,
    } as Extract<TaskCancelResult, { kind: K }>;
  }

  const change = {
    design_status: { from: previousDesignStatus!, to: "cancelled" as const },
  };

  if (kind === "cancel_preview") {
    return {
      ...common,
      kind,
      previous_design_status: previousDesignStatus!,
      would_change: change,
    } as Extract<TaskCancelResult, { kind: K }>;
  }

  return {
    ...common,
    kind,
    previous_design_status: previousDesignStatus!,
    applied_change: change,
  } as Extract<TaskCancelResult, { kind: K }>;
}

export async function runTaskCancel(
  opts: TaskCancelOptions,
): Promise<TaskCancelResult> {
  const { cwd, taskId } = opts;
  const write = opts.write === true;

  const planState = await loadPlanState(cwd);
  const { phaseId, task } = resolveTaskInPlanState(planState, taskId);
  const phaseEntry = planState.phases.find(p => p.phase.id === phaseId);
  if (!phaseEntry) {
    const err = new Error(
      `Internal error: phase "${phaseId}" not found after resolution.`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }
  const file = phaseEntry.ref.path;

  // Progress events and derived state are read-only inputs. Cancellation never
  // appends, deletes, or rewrites them.
  const { log } = await loadProgressLog(cwd);
  const events = log.events;
  const derived = deriveTaskState(events, taskId);

  const phaseStatusCandidate = buildPhaseStatusCandidate(
    phaseEntry.phase,
    taskId,
    events,
  );

  if (task.status === "cancelled") {
    return buildResult(
      "already_cancelled",
      taskId,
      phaseId,
      file,
      task.status,
      derived.current,
      null,
      phaseStatusCandidate,
    );
  }

  assertTaskCancelEligibility(taskId, task.status, derived.current);

  const allPhases = planState.phases.map(p => p.phase);
  const dependents = directTaskDependents(allPhases, taskId);
  assertNoNonCancelledTaskDependents(taskId, dependents);

  const readPath = await resolvePhaseReadPath(cwd, file);
  const writePath = await resolvePhaseWritePath(cwd, file);

  let originalBytes: string;
  try {
    originalBytes = await readOwnedText(readPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw err;
    const wrapped = new Error(
      `Phase at ${file} cannot be read: ${(err as Error).message}`,
    );
    (wrapped as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw wrapped;
  }

  let phase: Phase;
  try {
    phase = Phase.parse(parseYaml(originalBytes) as unknown);
  } catch (err) {
    const wrapped = new Error(
      `Phase at ${file} is malformed (YAML or schema): ${(err as Error).message}`,
    );
    (wrapped as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw wrapped;
  }

  const tasks = phase.tasks ?? [];
  const targetIndex = tasks.findIndex(t => t.id === taskId);
  if (targetIndex === -1) {
    const err = new Error(
      `Internal error: task "${taskId}" not found in phase "${phaseId}" at write time.`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  const originalTask = tasks[targetIndex]!;
  const updatedTasks = tasks.map((t, i) =>
    i === targetIndex ? { ...t, status: "cancelled" as const } : t,
  );

  let updatedPhase: Phase;
  try {
    updatedPhase = Phase.parse({ ...phase, tasks: updatedTasks });
  } catch (err) {
    const wrapped = new Error(
      `Task cancellation produced an invalid phase: ${(err as Error).message}`,
    );
    (wrapped as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw wrapped;
  }

  const candidateYaml = stringifyYaml(updatedPhase);

  if (!write) {
    return buildResult(
      "cancel_preview",
      taskId,
      phaseId,
      file,
      originalTask.status,
      derived.current,
      originalTask.status,
      phaseStatusCandidate,
    );
  }

  try {
    await atomicWriteText(writePath, candidateYaml, {
      kind: "present",
      content: originalBytes,
    });
  } catch (writeErr) {
    if ((writeErr as Error).message === "destination changed before write") {
      const err = new Error(
        `Task "${taskId}" cancel write conflict: phase file changed before write.`,
      ) as NodeJS.ErrnoException & {
        task_id?: string;
        rollback_status?: string;
      };
      err.code = "TASK_CANCEL_WRITE_CONFLICT";
      err.task_id = taskId;
      err.rollback_status = "not_attempted";
      throw err;
    }
    throw writeErr;
  }

  // Post-write integrity: the bytes on disk must be exactly the candidate and
  // the target task must differ only by status.
  let rollbackStatus: "not_attempted" | "rolled_back" | "failed" =
    "not_attempted";
  try {
    const reloadedBytes = await readOwnedText(readPath);
    if (reloadedBytes !== candidateYaml) {
      throw new Error(`Task "${taskId}" cancel post-write bytes mismatch.`);
    }

    const reloadedPhase = Phase.parse(parseYaml(reloadedBytes) as unknown);
    const reloadedTask = (reloadedPhase.tasks ?? []).find(t => t.id === taskId);
    if (!reloadedTask || reloadedTask.status !== "cancelled") {
      throw new Error(
        `Task "${taskId}" cancel post-write status mismatch: expected cancelled.`,
      );
    }

    const expectedTask = { ...originalTask, status: "cancelled" as const };
    const changedFields = postLockRegistrationChangedFields(
      expectedTask,
      reloadedTask,
    );
    if (changedFields.length > 0) {
      throw new Error(
        `Task "${taskId}" cancel post-write unexpected field changes: ${changedFields.join(", ")}.`,
      );
    }
  } catch (verifyErr) {
    try {
      await atomicReplaceExistingText(writePath, originalBytes, candidateYaml);
      rollbackStatus = "rolled_back";
    } catch {
      rollbackStatus = "failed";
    }

    const err = new Error(
      `Task "${taskId}" cancel write failed: ${(verifyErr as Error).message}; rollback_status=${rollbackStatus}.`,
    ) as NodeJS.ErrnoException & {
      task_id?: string;
      rollback_status?: string;
    };
    err.code = "TASK_CANCEL_WRITE_FAILURE";
    err.task_id = taskId;
    err.rollback_status = rollbackStatus;
    throw err;
  }

  return buildResult(
    "cancelled",
    taskId,
    phaseId,
    file,
    "cancelled",
    derived.current,
    originalTask.status,
    phaseStatusCandidate,
  );
}
