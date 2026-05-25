import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * True when `error` means `design/decisions/` simply is not there
 * (`ENOENT`) or is not a directory (`ENOTDIR`) — the normal "no ADR" state.
 * Exported so the rethrow policy can be tested without mocking `readdir`.
 */
export function isAbsentDecisionsDirError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" ||
      (error as { code?: unknown }).code === "ENOTDIR")
  );
}

/**
 * Reads the filenames in `design/decisions/`.
 *
 * Returns `[]` when the directory is absent — a roadmap that has not
 * recorded any decisions is a normal "no ADR" state. Any other error
 * (permissions, a broken path) is rethrown: silently swallowing it would
 * convert a real environment problem into a spurious
 * `TASK_DECISION_UNRESOLVED` advisory.
 */
export async function readDecisionAdrFiles(cwd: string): Promise<string[]> {
  try {
    return await readdir(join(cwd, "design", "decisions"));
  } catch (error) {
    if (isAbsentDecisionsDirError(error)) return [];
    throw error;
  }
}

/**
 * True when `entries` contains an ADR that resolves `taskId`.
 *
 * Shared by `verify` (the task-completion decision gate) and `plan lint`
 * (the `TASK_DECISION_UNRESOLVED` advisory) so the two can never diverge on
 * what "resolved" means. The substring match `f.includes(taskId)` is a
 * deliberately-preserved compatibility: `"P1-T1"` also matches
 * `"P1-T10-decision.md"`. Changing the rule means changing it for both
 * consumers at once.
 */
export function hasDecisionAdrForTaskId(
  entries: string[],
  taskId: string,
): boolean {
  return entries.some((f) => f.endsWith(".md") && f.includes(taskId));
}
