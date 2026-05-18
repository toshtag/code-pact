import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Roadmap } from "../core/schemas/roadmap.ts";
import { Phase } from "../core/schemas/phase.ts";
import type { ProgressEvent } from "../core/schemas/progress-event.ts";
import { loadProgressLog } from "../core/progress/io.ts";
import {
  deriveTaskState,
  type TaskCurrentState,
} from "../core/progress/task-state.ts";

export type TaskStatusOptions = {
  cwd: string;
  taskId: string;
};

export type TaskStatusResult = {
  task_id: string;
  phase_id: string;
  current: TaskCurrentState;
  last_event?: ProgressEvent;
  history: ProgressEvent[];
};

async function resolveTaskPhase(cwd: string, taskId: string): Promise<string> {
  const roadmapRaw = await readFile(join(cwd, "design", "roadmap.yaml"), "utf8");
  const roadmap = Roadmap.parse(parseYaml(roadmapRaw) as unknown);

  const hits: string[] = [];
  for (const ref of roadmap.phases) {
    const phaseRaw = await readFile(join(cwd, ref.path), "utf8");
    const phase = Phase.parse(parseYaml(phaseRaw) as unknown);
    if (phase.tasks?.some((t) => t.id === taskId)) {
      hits.push(phase.id);
    }
  }

  if (hits.length === 0) {
    const err = new Error(`Task "${taskId}" not found in any phase.`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }
  if (hits.length > 1) {
    const err = new Error(
      `Task "${taskId}" exists in multiple phases: ${hits.join(", ")}`,
    );
    (err as NodeJS.ErrnoException).code = "AMBIGUOUS_TASK_ID";
    (err as NodeJS.ErrnoException & { phases?: string[] }).phases = hits;
    throw err;
  }
  return hits[0]!;
}

/**
 * Pure-read inspection of a task's current state. Intentionally does NOT
 * validate agent configuration — `task status` should be invokable from
 * CI, monitoring, or a human reviewer without project agent setup.
 */
export async function runTaskStatus(
  opts: TaskStatusOptions,
): Promise<TaskStatusResult> {
  const { cwd, taskId } = opts;
  const phaseId = await resolveTaskPhase(cwd, taskId);
  const { log } = await loadProgressLog(cwd);
  const state = deriveTaskState(log.events, taskId);
  return {
    task_id: taskId,
    phase_id: phaseId,
    current: state.current,
    last_event: state.last_event,
    history: state.history,
  };
}
