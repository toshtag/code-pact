import type { Task } from "../schemas/task.ts";
import type { PreflightEntry } from "../schemas/recommend-result.ts";
import { isPlanningRequired } from "./planning.ts";

// ---------------------------------------------------------------------------
// Preflight — Task-derivable triggers only
//
// | Trigger                              | Entry              |
// | planningRequired == true             | plan lint          |
// | planningRequired == true             | plan analyze       |
// | task.status == "in_progress"         | task status <id>   |
//
// Capped at 3 entries. There are exactly 3 deterministic triggers, so the
// cap is a no-op safety guard today; it documents the invariant.
//
// This stays pure and Task-only to preserve the no-I/O boundary;
// phase-level rollups and derived-state-aware preflight would need
// `derivedTaskState` on RecommendContext.
// ---------------------------------------------------------------------------

const PREFLIGHT_CAP = 3;

export function recommendPreflight(task: Task): PreflightEntry[] {
  const entries: PreflightEntry[] = [];

  if (isPlanningRequired(task)) {
    entries.push({
      id: "plan_lint",
      command: "plan lint",
      argv: ["plan", "lint", "--json"],
      displayCommand: "code-pact plan lint --json",
      reason: "planning_required",
      required: false,
    });
    entries.push({
      id: "plan_analyze",
      command: "plan analyze",
      argv: ["plan", "analyze", "--json"],
      displayCommand: "code-pact plan analyze --json",
      reason: "planning_required",
      required: false,
    });
  }

  if (task.status === "in_progress") {
    entries.push({
      id: "task_status",
      command: "task status",
      argv: ["task", "status", task.id, "--json"],
      displayCommand: `code-pact task status ${task.id} --json`,
      reason: "task_in_progress",
      required: false,
    });
  }

  return entries.slice(0, PREFLIGHT_CAP);
}
