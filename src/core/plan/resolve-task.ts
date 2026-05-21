// Task → phase resolver core (P14 governance / P14-T6).
//
// Before P14 every `task-*` command rolled its own private
// `resolveTaskPhase` scanning roadmap.yaml + each referenced phase
// YAML. Eight sites duplicated the same logic with identical error
// codes (TASK_NOT_FOUND / AMBIGUOUS_TASK_ID) and message shape, and
// `task-runbook` additionally re-scanned PlanState by hand because
// `PlanState.taskIndex` silently keeps the first match on collision.
//
// This module is the single source of truth. Two variants are
// exposed:
//
//   - `resolveTaskInRoadmap(cwd, taskId)` — I/O variant. Reads
//     roadmap.yaml + each phase YAML from disk. Used by commands
//     that have NOT loaded `PlanState`.
//   - `resolveTaskInPlanState(state, taskId)` — pure variant. Uses
//     an already-loaded `PlanState`. Used by `task-runbook` (which
//     consumes the runbook builder's PlanState anyway).
//
// Both variants emit the same `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID`
// errors with the same `.message` shape and the same `.phases`
// array on ambiguity, so the migration is a pure refactor — every
// per-command unit test passes unchanged.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Phase, type Phase as PhaseT } from "../schemas/phase.ts";
import { Roadmap } from "../schemas/roadmap.ts";
import type { Task as TaskT } from "../schemas/task.ts";
import type { PlanState } from "./state.ts";

/** I/O variant return shape. `phasePath` is roadmap-relative. */
export type ResolvedTask = {
  phaseId: string;
  /** Roadmap-relative path (`design/phases/<file>.yaml`). */
  phasePath: string;
};

/** Pure variant return shape: includes the parsed phase + task. */
export type ResolvedTaskWithEntry = {
  phaseId: string;
  phase: PhaseT;
  task: TaskT;
};

function taskNotFoundError(taskId: string): NodeJS.ErrnoException {
  const err = new Error(`Task "${taskId}" not found in any phase.`);
  (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
  return err as NodeJS.ErrnoException;
}

function ambiguousTaskError(
  taskId: string,
  phaseIds: string[],
): NodeJS.ErrnoException {
  const err = new Error(
    `Task "${taskId}" exists in multiple phases: ${phaseIds.join(", ")}`,
  );
  (err as NodeJS.ErrnoException).code = "AMBIGUOUS_TASK_ID";
  (err as NodeJS.ErrnoException & { phases?: string[] }).phases = phaseIds;
  return err as NodeJS.ErrnoException;
}

/**
 * Resolve a task id to its containing phase by reading roadmap.yaml
 * and scanning each referenced phase YAML. Used by every `task-*`
 * command that operates from a raw cwd (no PlanState loaded).
 *
 * Throws `TASK_NOT_FOUND` when no phase contains the task, or
 * `AMBIGUOUS_TASK_ID` when multiple phases do. The ambiguity error
 * carries `.phases: string[]` (the colliding phase ids) for callers
 * that surface the list in their JSON envelope.
 */
export async function resolveTaskInRoadmap(
  cwd: string,
  taskId: string,
): Promise<ResolvedTask> {
  const roadmapRaw = await readFile(
    join(cwd, "design", "roadmap.yaml"),
    "utf8",
  );
  const roadmap = Roadmap.parse(parseYaml(roadmapRaw) as unknown);

  const hits: ResolvedTask[] = [];
  for (const ref of roadmap.phases) {
    const phaseRaw = await readFile(join(cwd, ref.path), "utf8");
    const phase = Phase.parse(parseYaml(phaseRaw) as unknown);
    if (phase.tasks?.some((t) => t.id === taskId)) {
      hits.push({ phaseId: phase.id, phasePath: ref.path });
    }
  }

  if (hits.length === 0) throw taskNotFoundError(taskId);
  if (hits.length > 1) {
    throw ambiguousTaskError(
      taskId,
      hits.map((h) => h.phaseId),
    );
  }
  return hits[0]!;
}

/**
 * Resolve a task id using an already-loaded `PlanState`. Used by
 * `task-runbook`, which needs the parsed task + phase for the
 * runbook builder and cannot tolerate the silent first-match
 * behaviour of `PlanState.taskIndex`.
 *
 * Throws `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` with the same
 * shape as `resolveTaskInRoadmap`.
 */
export function resolveTaskInPlanState(
  state: PlanState,
  taskId: string,
): ResolvedTaskWithEntry {
  const hits: ResolvedTaskWithEntry[] = [];
  for (const entry of state.phases) {
    const task = entry.phase.tasks?.find((t) => t.id === taskId);
    if (task) {
      hits.push({ phaseId: entry.phase.id, phase: entry.phase, task });
    }
  }

  if (hits.length === 0) throw taskNotFoundError(taskId);
  if (hits.length > 1) {
    throw ambiguousTaskError(
      taskId,
      hits.map((h) => h.phaseId),
    );
  }
  return hits[0]!;
}
