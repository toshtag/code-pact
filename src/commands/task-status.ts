import type { ProgressEvent } from "../core/schemas/progress-event.ts";
import { loadProgressLog } from "../core/progress/io.ts";
import {
  deriveTaskState,
  type TaskCurrentState,
} from "../core/progress/task-state.ts";
import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";

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

/**
 * Pure-read inspection of a task's current state. Intentionally does NOT
 * validate agent configuration — `task status` should be invokable from
 * CI, monitoring, or a human reviewer without project agent setup.
 */
export async function runTaskStatus(
  opts: TaskStatusOptions,
): Promise<TaskStatusResult> {
  const { cwd, taskId } = opts;
  const { phaseId } = await resolveTaskInRoadmap(cwd, taskId);
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
