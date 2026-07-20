import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { Task } from "./schemas/task.ts";
import {
  readOwnedText,
  mkdirOwned,
  writeOwnedText,
  resolveContractLockDirWritePath,
  resolveContractLockReadPath,
  resolveContractLockWritePath,
} from "./project-fs/index.ts";

const execFileAsync = promisify(execFile);

export const ContractLock = z.object({
  task_id: z.string(),
  phase_id: z.string(),
  plan_sha: z.string(),
  base_ref: z.string(),
  reads: z.array(z.string()),
  writes: z.array(z.string()),
  at: z.string().datetime(),
  actor: z.enum(["agent", "user"]),
  agent: z.string().optional(),
  author: z.string().optional(),
});

export type ContractLock = z.infer<typeof ContractLock>;

export function getContractLockPath(cwd: string, taskId: string): string {
  return join(cwd, ".code-pact", "state", "locks", `${taskId}.yaml`);
}

export async function resolveGitRef(cwd: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", ref],
    { cwd, encoding: "utf8" },
  );
  return stdout.trim();
}

export async function readContractLock(
  cwd: string,
  taskId: string,
): Promise<ContractLock | null> {
  try {
    const path = await resolveContractLockReadPath(cwd, `${taskId}.yaml`);
    const raw = await readOwnedText(path);
    return ContractLock.parse(parseYaml(raw) as unknown);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeContractLock(
  cwd: string,
  lock: ContractLock,
): Promise<void> {
  const dir = await resolveContractLockDirWritePath(cwd);
  await mkdirOwned(dir, { recursive: true });
  const path = await resolveContractLockWritePath(cwd, `${lock.task_id}.yaml`);
  await writeOwnedText(path, stringifyYaml(lock));
}

export type ContractDriftReason =
  | { kind: "scope"; field: "reads" | "writes"; message: string }
  | { kind: "base_ref"; message: string };

export function checkContractLock(
  task: Task,
  baseRef: string | undefined,
  lock: ContractLock,
): ContractDriftReason[] {
  const reasons: ContractDriftReason[] = [];

  const taskReads = [...(task.reads ?? [])].sort();
  const taskWrites = [...(task.writes ?? [])].sort();
  const lockReads = [...lock.reads].sort();
  const lockWrites = [...lock.writes].sort();

  if (JSON.stringify(taskReads) !== JSON.stringify(lockReads)) {
    reasons.push({
      kind: "scope",
      field: "reads",
      message: `declared reads changed since lock`,
    });
  }
  if (JSON.stringify(taskWrites) !== JSON.stringify(lockWrites)) {
    reasons.push({
      kind: "scope",
      field: "writes",
      message: `declared writes changed since lock`,
    });
  }

  if (baseRef !== undefined && baseRef !== lock.base_ref) {
    reasons.push({
      kind: "base_ref",
      message: `base ref does not match locked base_ref (${lock.base_ref})`,
    });
  }

  return reasons;
}
