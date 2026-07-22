import { loadPhase } from "../core/plan/load-phase.ts";
import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";
import {
  resolveExplicitUserReadPath,
  readExplicitUserText,
} from "../core/project-fs/index.ts";
import {
  createTaskContractLock,
  type ContractLockResult,
  type ContractLockRegistration,
} from "../core/contract-lock.ts";
import {
  parseTaskRegistrationSpec,
  taskRegistrationDigest,
  registrationChangedFields,
} from "../core/task-registration-spec.ts";

export type TaskLockOptions = {
  cwd: string;
  taskId: string;
  baseRef?: string;
  agent?: string;
  author?: string;
  actor?: "agent" | "user";
  /** Path to the strict task-registration spec used at add time. */
  specFile?: string;
};

export type TaskLockResult = ContractLockResult;

async function readAndValidateSpecFile(
  cwd: string,
  taskId: string,
  specFile: string,
): Promise<{ registration: ContractLockRegistration; specDigest: string }> {
  let specPath;
  try {
    specPath = await resolveExplicitUserReadPath(cwd, specFile);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PATH_OUTSIDE_PROJECT" || code === "PATH_NOT_OWNED") {
      const wrapped = new Error(
        `task lock: --spec-file "${specFile}" is outside the project or not a safe path.`,
      );
      (wrapped as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw wrapped;
    }
    throw err;
  }

  let raw: string;
  try {
    raw = await readExplicitUserText(specPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const wrapped = new Error(
        `task lock: spec file "${specFile}" not found.`,
      );
      (wrapped as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw wrapped;
    }
    throw err;
  }

  const spec = parseTaskRegistrationSpec(raw);

  const { phaseId, phasePath } = await resolveTaskInRoadmap(cwd, taskId);
  const phase = await loadPhase(cwd, phasePath);
  const currentTask = phase.tasks?.find(t => t.id === taskId);
  if (!currentTask) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  if (spec.phase_id !== phaseId) {
    const err = new Error(
      `task lock: spec phase_id "${spec.phase_id}" does not match task phase "${phaseId}".`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }

  if (spec.task.id !== taskId) {
    const err = new Error(
      `task lock: spec task id "${spec.task.id}" does not match "${taskId}".`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }

  const expectedDigest = taskRegistrationDigest(spec.phase_id, spec.task);
  const actualDigest = taskRegistrationDigest(phase.id, currentTask);

  if (expectedDigest !== actualDigest) {
    const changedFields = registrationChangedFields(spec.task, currentTask);
    const err = new Error(
      `TASK_REGISTRATION_SPEC_MISMATCH: task "${taskId}" phase task does not match the supplied spec (${changedFields.join(", ")}).`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_REGISTRATION_SPEC_MISMATCH";
    (err as NodeJS.ErrnoException & { task_id?: string }).task_id = taskId;
    (
      err as NodeJS.ErrnoException & { expected_spec_digest?: string }
    ).expected_spec_digest = expectedDigest;
    (
      err as NodeJS.ErrnoException & { actual_task_digest?: string }
    ).actual_task_digest = actualDigest;
    (
      err as NodeJS.ErrnoException & { changed_fields?: string[] }
    ).changed_fields = changedFields;
    throw err;
  }

  return {
    registration: { mode: "spec_file", spec_digest: expectedDigest },
    specDigest: expectedDigest,
  };
}

export async function runTaskLock(
  opts: TaskLockOptions,
): Promise<TaskLockResult> {
  let registration: ContractLockRegistration | undefined;
  if (opts.specFile) {
    const validated = await readAndValidateSpecFile(
      opts.cwd,
      opts.taskId,
      opts.specFile,
    );
    registration = validated.registration;
  }

  return createTaskContractLock({
    cwd: opts.cwd,
    taskId: opts.taskId,
    baseRef: opts.baseRef,
    agent: opts.agent,
    author: opts.author,
    actor: opts.actor,
    registration,
  });
}
