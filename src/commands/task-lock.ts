import {
  createTaskContractLock,
  type ContractLockResult,
} from "../core/contract-lock.ts";

export type TaskLockOptions = {
  cwd: string;
  taskId: string;
  baseRef?: string;
  agent?: string;
  author?: string;
  actor?: "agent" | "user";
};

export type TaskLockResult = ContractLockResult;

export async function runTaskLock(
  opts: TaskLockOptions,
): Promise<TaskLockResult> {
  return createTaskContractLock({
    cwd: opts.cwd,
    taskId: opts.taskId,
    baseRef: opts.baseRef,
    agent: opts.agent,
    author: opts.author,
    actor: opts.actor,
  });
}
