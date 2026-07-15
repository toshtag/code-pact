import { loopMemoryStatus, type LoopMemoryStatus } from "../core/loop-memory/status.ts";

export type MemoryStatusResult = LoopMemoryStatus;

export async function runMemoryStatus(cwd: string): Promise<MemoryStatusResult> {
  return loopMemoryStatus(cwd);
}

export function formatMemoryStatus(status: MemoryStatusResult): string {
  return [
    `Episodes: ${status.episode_count}`,
    `Bytes: ${status.total_bytes}`,
    `Failures: ${status.failure_count}`,
    `Successes: ${status.success_count}`,
    `Unique tasks: ${status.unique_task_count}`,
    `Unique fingerprints: ${status.unique_fingerprint_count}`,
    `Corrupt entries: ${status.corrupt_count}`,
    `Measured corrupt bytes: ${status.corrupt_bytes}`,
    `Unmeasured corrupt entries: ${status.corrupt_unmeasured_count}`,
  ].join("\n");
}
