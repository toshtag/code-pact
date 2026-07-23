import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { deriveTaskState } from "./progress/task-state.ts";
import type { ProgressEvent } from "./schemas/progress-event.ts";
import { readOwnedText, resolvePhaseReadPath } from "./project-fs/index.ts";

const execFileAsync = promisify(execFile);

function fail(reason: string): PhaseLifecycleClassification {
  return { lifecycleOnly: false, changedFields: [], reason };
}

export type LifecycleControlPlaneEntry = {
  file: string;
  changed_fields: string[];
};

export type ClassifyPhaseLifecycleOptions = {
  cwd: string;
  phasePath: string;
  baseSha: string;
  events: readonly ProgressEvent[];
  derivedPhaseStatus: "planned" | "in_progress" | "done";
};

export type PhaseLifecycleClassification = {
  lifecycleOnly: boolean;
  changedFields: string[];
  reason?: string;
};

/**
 * Recursively compare two parsed YAML values. Key order in objects is ignored;
 * array order is preserved. This is semantic comparison, not byte comparison,
 * so YAML comment-only changes collapse to equality.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj).sort();
    const bKeys = Object.keys(bObj).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i += 1) {
      if (aKeys[i] !== bKeys[i]) return false;
      if (!deepEqual(aObj[aKeys[i]!], bObj[aKeys[i]!])) return false;
    }
    return true;
  }

  return false;
}

async function readBasePhase(
  cwd: string,
  baseSha: string,
  phasePath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["show", `${baseSha}:${phasePath}`],
      { cwd, encoding: "utf8" },
    );
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Classify a phase-file diff between the lock base and HEAD as either a
 * Code Pact lifecycle-only mutation (allowed) or an implementation change
 * (must be declared in the task's `writes`).
 *
 * Allowed changes:
 *   - phase.status, when the new status equals the derived phase status.
 *   - phase.tasks[i].status, when the new status is "done" and the progress
 *     ledger derived state for that task is also "done". Task ids and order
 *     must be identical between base and head; every non-status field must be
 *     unchanged.
 *
 * Everything else is fail-closed: unknown YAML fields, changed field values,
 * added/removed/reordered tasks, and any parse failure.
 */
export async function classifyPhaseLifecycle(
  opts: ClassifyPhaseLifecycleOptions,
): Promise<PhaseLifecycleClassification> {
  const { cwd, phasePath, baseSha, events, derivedPhaseStatus } = opts;

  const baseRaw = await readBasePhase(cwd, baseSha, phasePath);
  if (baseRaw === null) {
    return fail(`base phase file not reachable at ${baseSha}`);
  }

  let baseDoc: unknown;
  let headDoc: unknown;
  try {
    baseDoc = parseYaml(baseRaw);
    // Reading HEAD from disk via the owned phase read keeps the classifier
    // consistent with the working tree that `git diff` already reports.
    const headRaw = await readOwnedText(
      await resolvePhaseReadPath(cwd, phasePath),
    );
    headDoc = parseYaml(headRaw);
  } catch {
    return fail("base or head phase YAML could not be parsed");
  }

  if (
    typeof baseDoc !== "object" ||
    baseDoc === null ||
    typeof headDoc !== "object" ||
    headDoc === null
  ) {
    return fail("base or head phase YAML is not a mapping");
  }

  const base = baseDoc as Record<string, unknown>;
  const head = headDoc as Record<string, unknown>;

  const changedFields: string[] = [];

  // Phase-level status is allowed to change only to the derived status.
  if (base.status !== head.status) {
    if (head.status !== derivedPhaseStatus) {
      return fail(
        `phase.status changed to "${head.status}" but derived status is "${derivedPhaseStatus}"`,
      );
    }
    changedFields.push("status");
  }

  // All other top-level fields must be byte-identical in semantic terms.
  const topLevelKeys = new Set([...Object.keys(base), ...Object.keys(head)]);
  for (const key of topLevelKeys) {
    if (key === "status" || key === "tasks") continue;
    if (!deepEqual(base[key], head[key])) {
      return fail(
        `top-level field "${key}" changed outside allowed lifecycle status fields`,
      );
    }
  }

  // Tasks array: same ids in the same order; only status may change, and only
  // to done when the derived state is done.
  const baseTasks = Array.isArray(base.tasks) ? base.tasks : [];
  const headTasks = Array.isArray(head.tasks) ? head.tasks : [];
  if (!Array.isArray(base.tasks) || !Array.isArray(head.tasks)) {
    return fail("tasks is not an array in base or head");
  }
  if (baseTasks.length !== headTasks.length) {
    return fail("task count changed between base and head");
  }

  for (let i = 0; i < headTasks.length; i += 1) {
    const bTask = baseTasks[i];
    const hTask = headTasks[i];
    if (
      typeof bTask !== "object" ||
      bTask === null ||
      typeof hTask !== "object" ||
      hTask === null
    ) {
      return fail(`task at index ${i} is not a mapping`);
    }
    const baseTask = bTask as Record<string, unknown>;
    const headTask = hTask as Record<string, unknown>;

    if (baseTask.id !== headTask.id) {
      return fail(
        `task id at index ${i} differs (${baseTask.id} vs ${headTask.id})`,
      );
    }
    const taskId = String(headTask.id);

    for (const key of new Set([
      ...Object.keys(baseTask),
      ...Object.keys(headTask),
    ])) {
      if (key === "status") continue;
      if (!deepEqual(baseTask[key], headTask[key])) {
        return fail(
          `task "${taskId}" field "${key}" changed outside allowed status field`,
        );
      }
    }

    if (baseTask.status !== headTask.status) {
      if (headTask.status === "done") {
        const derived = deriveTaskState(events, taskId);
        if (derived.current !== "done") {
          return fail(
            `task "${taskId}" status is "done" but progress ledger derived state is "${derived.current}"`,
          );
        }
        changedFields.push(`tasks[${taskId}].status`);
      } else if (headTask.status === "cancelled") {
        // Cancelling a task is a terminal lifecycle decision. It is allowed
        // only when the task was not already done (fail-closed) and the base
        // status was planned or in_progress.
        const baseStatus = baseTask.status;
        if (baseStatus !== "planned" && baseStatus !== "in_progress") {
          return fail(
            `task "${taskId}" status changed to "cancelled" from non-eligible base status "${baseStatus}"`,
          );
        }
        const derived = deriveTaskState(events, taskId);
        if (derived.current === "done") {
          return fail(
            `task "${taskId}" is cancelled but progress ledger derived state is "done"`,
          );
        }
        changedFields.push(`tasks[${taskId}].status`);
      } else {
        return fail(
          `task "${taskId}" status changed to non-terminal value "${headTask.status}"`,
        );
      }
    }
  }

  return { lifecycleOnly: true, changedFields };
}
