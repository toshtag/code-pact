import { loadPlanState } from "../core/plan/state.ts";
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

  // Detect ambiguity by scanning every phase, since PlanState.taskIndex
  // silently keeps the first match. Per the P12 RFC § Non-goals, we do
  // NOT extract the duplicated task→phase resolver into a shared helper
  // in P12 — that refactor is P14 governance scope. Runbook uses the
  // already-loaded PlanState directly.
  const hits: { phaseId: string }[] = [];
  for (const entry of state.phases) {
    if (entry.phase.tasks?.some((t) => t.id === taskId)) {
      hits.push({ phaseId: entry.phase.id });
    }
  }

  if (hits.length === 0) {
    const err = new Error(`Task "${taskId}" not found in any phase.`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }
  if (hits.length > 1) {
    const err = new Error(
      `Task "${taskId}" exists in multiple phases: ${hits.map((h) => h.phaseId).join(", ")}`,
    );
    (err as NodeJS.ErrnoException).code = "AMBIGUOUS_TASK_ID";
    (err as NodeJS.ErrnoException & { phases?: string[] }).phases = hits.map(
      (h) => h.phaseId,
    );
    throw err;
  }

  const indexed = state.taskIndex.get(taskId);
  // taskIndex is built from the same phase list we just scanned, so an
  // unambiguous hit is always indexed.
  if (!indexed) {
    throw new Error(
      `internal invariant: task "${taskId}" resolved to phase but missing from taskIndex`,
    );
  }

  const events = state.progress?.events ?? [];

  return buildTaskRunbook({
    cwd,
    task: indexed.task,
    phaseId: indexed.phaseId,
    events,
  });
}
