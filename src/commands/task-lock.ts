import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";
import { loadPhase } from "../core/plan/load-phase.ts";
import {
  getContractLockPath,
  readContractLock,
  resolveGitRef,
  writeContractLock,
  type ContractLock,
} from "../core/contract-lock.ts";

export type TaskLockOptions = {
  cwd: string;
  taskId: string;
  baseRef?: string;
  agent?: string;
  author?: string;
  actor?: "agent" | "user";
};

export type TaskLockResult = {
  kind: "locked";
  task_id: string;
  phase_id: string;
  plan_sha: string;
  base_ref: string;
  path: string;
};

export async function runTaskLock(
  opts: TaskLockOptions,
): Promise<TaskLockResult> {
  const { cwd, taskId } = opts;
  const { phaseId, phasePath } = await resolveTaskInRoadmap(cwd, taskId);
  const phase = await loadPhase(cwd, phasePath);
  const task = phase.tasks?.find(t => t.id === taskId);
  if (!task) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  const headSha = await resolveGitRef(cwd, "HEAD");
  const baseRef = opts.baseRef ?? "HEAD";
  const baseRefSha = baseRef === "HEAD" ? headSha : await resolveGitRef(cwd, baseRef);

  const existing = await readContractLock(cwd, taskId);
  if (existing !== null) {
    const err = new Error(
      `Task contract lock already exists for "${taskId}" at ${getContractLockPath(cwd, taskId)}. Use a new task id or remove the lock manually.`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_CONTRACT_LOCK_EXISTS";
    throw err;
  }

  const lock: ContractLock = {
    task_id: taskId,
    phase_id: phaseId,
    plan_sha: headSha,
    base_ref: baseRefSha,
    reads: task.reads ?? [],
    writes: task.writes ?? [],
    at: new Date().toISOString(),
    actor: opts.actor ?? "agent",
    agent: opts.agent,
    author: opts.author,
  };

  await writeContractLock(cwd, lock);

  return {
    kind: "locked",
    task_id: taskId,
    phase_id: phaseId,
    plan_sha: headSha,
    base_ref: baseRefSha,
    path: getContractLockPath(cwd, taskId),
  };
}
