import { loadPlanState } from "../core/plan/state.ts";
import { resolveTaskInPlanState } from "../core/plan/resolve-task.ts";
import { buildTaskRunbook } from "../core/runbook/build-task-runbook.ts";
import type { TaskRunbookResult } from "../core/runbook/types.ts";

// ---------------------------------------------------------------------------
// `task runbook <task-id>` — v1.3 P12-T3
//
// Read-only guidance command. Returns a deterministic list of next
// recommended steps for the given task. The command itself does no
// mutation; every recommended step is a command string the user runs
// separately, or a manual_action describing a human checkpoint.
//
// Per the accepted P12 RFC (design/decisions/lightweight-runbook-rfc.md),
// this command does NOT take an --agent flag. Agent choice belongs to
// whichever command in the recommended sequence needs an adapter.
//
// Error codes reused (no new codes): TASK_NOT_FOUND / AMBIGUOUS_TASK_ID /
// CONFIG_ERROR (in cli.ts argv parsing).
// ---------------------------------------------------------------------------

export type TaskRunbookOptions = {
  cwd: string;
  taskId: string;
};

export async function runTaskRunbook(
  opts: TaskRunbookOptions,
): Promise<TaskRunbookResult> {
  const { cwd, taskId } = opts;

  const state = await loadPlanState(cwd);

  // P14-T6: resolver core does the ambiguity scan that `PlanState.
  // taskIndex` silently elides (first-match). One call replaces the
  // previous manual rescan in this command.
  const { phaseId, task } = resolveTaskInPlanState(state, taskId);

  const events = state.progress?.events ?? [];

  return buildTaskRunbook({
    cwd,
    task,
    phaseId,
    events,
  });
}
