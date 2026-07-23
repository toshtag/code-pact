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
  command: string | null;
};

type TaskCancelAlreadyCancelled = {
  kind: "already_cancelled";
  task_id: string;
  phase_id: string;
  design_status: "cancelled";
  derived_state: TaskCurrentState;
  phase_status_candidate: PhaseLifecycleStatus;
  progress_history_preserved: true;
  contract_lock_preserved: true;
  task_spec_preserved: true;
  next: TaskCancelNext;
};

type TaskCancelPreview = {
  kind: "cancel_preview";
  task_id: string;
  phase_id: string;
  current_design_status: PhaseStatus;
  derived_state: TaskCurrentState;
  phase_status_candidate: PhaseLifecycleStatus;
  would_change: {
    task_status: { from: PhaseStatus; to: "cancelled" };
  };
  next: TaskCancelNext;
};

type TaskCancelApplied = {
  kind: "cancelled";
  task_id: string;
  phase_id: string;
  previous_design_status: PhaseStatus;
  design_status: "cancelled";
  derived_state: TaskCurrentState;
  phase_status_candidate: PhaseLifecycleStatus;
  progress_history_preserved: true;
  contract_lock_preserved: true;
  task_spec_preserved: true;
  next: TaskCancelNext;
};

export type TaskCancelResult =
  | TaskCancelAlreadyCancelled
  | TaskCancelPreview
  | TaskCancelApplied;

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
    return { command: null };
  }
  if (kind === "cancel_preview") {
    return { command: `code-pact task cancel ${taskId} --write --json` };
  }
  return { command: `code-pact phase reconcile ${phaseId} --write --json` };
}

function buildResult(
  kind: "already_cancelled",
  taskId: string,
  phaseId: string,
  derivedState: TaskCurrentState,
  phaseStatusCandidate: PhaseLifecycleStatus,
): TaskCancelAlreadyCancelled;
function buildResult(
  kind: "cancel_preview",
  taskId: string,
  phaseId: string,
  derivedState: TaskCurrentState,
  phaseStatusCandidate: PhaseLifecycleStatus,
  currentDesignStatus: PhaseStatus,
): TaskCancelPreview;
function buildResult(
  kind: "cancelled",
  taskId: string,
  phaseId: string,
  derivedState: TaskCurrentState,
  phaseStatusCandidate: PhaseLifecycleStatus,
  previousDesignStatus: PhaseStatus,
): TaskCancelApplied;
function buildResult(
  kind: "already_cancelled" | "cancel_preview" | "cancelled",
  taskId: string,
  phaseId: string,
  derivedState: TaskCurrentState,
  phaseStatusCandidate: PhaseLifecycleStatus,
  designStatus?: PhaseStatus,
): TaskCancelResult {
  const next = cancelNext(kind, taskId, phaseId);

  if (kind === "already_cancelled") {
    return {
      kind,
      task_id: taskId,
      phase_id: phaseId,
      design_status: "cancelled",
      derived_state: derivedState,
      phase_status_candidate: phaseStatusCandidate,
      progress_history_preserved: true,
      contract_lock_preserved: true,
      task_spec_preserved: true,
      next,
    };
  }

  if (kind === "cancel_preview") {
    return {
      kind,
      task_id: taskId,
      phase_id: phaseId,
      current_design_status: designStatus!,
      derived_state: derivedState,
      phase_status_candidate: phaseStatusCandidate,
      would_change: {
        task_status: { from: designStatus!, to: "cancelled" },
      },
      next,
    };
  }

  return {
    kind,
    task_id: taskId,
    phase_id: phaseId,
    previous_design_status: designStatus!,
    design_status: "cancelled",
    derived_state: derivedState,
    phase_status_candidate: phaseStatusCandidate,
    progress_history_preserved: true,
    contract_lock_preserved: true,
    task_spec_preserved: true,
    next,
  };
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
      derived.current,
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
      derived.current,
      phaseStatusCandidate,
      originalTask.status,
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
    derived.current,
    phaseStatusCandidate,
    originalTask.status,
  );
}
