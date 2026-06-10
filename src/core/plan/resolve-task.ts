// Task → phase resolver core.
//
// Without it, every `task-*` command would roll its own private
// `resolveTaskPhase` scanning roadmap.yaml + each referenced phase
// YAML, duplicating the same logic and error codes
// (TASK_NOT_FOUND / AMBIGUOUS_TASK_ID); and a by-hand PlanState scan
// is needed because `PlanState.taskIndex` silently keeps the first
// match on collision.
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
import { type Phase as PhaseT } from "../schemas/phase.ts";
import { Roadmap } from "../schemas/roadmap.ts";
import { loadPhase } from "./load-phase.ts";
import type { Task as TaskT } from "../schemas/task.ts";
import type { PlanState } from "./state.ts";
import { PhaseSnapshotInvalidError } from "./state.ts";
import {
  archivedEntriesFromSnapshot,
  mergeArchivedTaskIndex,
  resolveMissingPhaseRef,
  type ArchivedTaskEntry,
} from "../archive/load-phase-snapshot.ts";

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
  // design-docs-ephemeral (step 4a): collect ALL live task ids + the archived
  // candidates of any tolerated (hand-deleted, snapshotted) COMPLETED phase, so we
  // can run the SAME collision check the loaders/doctor run BEFORE returning a
  // target — `task context` / `task prepare` must not bypass it. The target itself
  // is always a LIVE task (the active task's own phase is never archived); the
  // archived index is consulted here ONLY for collision validation, never to
  // resolve the target and never coerced into a `Phase`.
  const liveTaskIds = new Set<string>();
  const archivedCandidates: ArchivedTaskEntry[] = [];
  for (const ref of roadmap.phases) {
    let phase: PhaseT;
    try {
      phase = await loadPhase(cwd, ref.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const res = await resolveMissingPhaseRef(cwd, ref);
      if (res.kind === "tolerated") {
        archivedCandidates.push(...archivedEntriesFromSnapshot(res.snapshot));
        continue; // deleted completed phase — never holds the active target
      }
      if (res.kind === "fail_invalid") {
        throw new PhaseSnapshotInvalidError(
          `${ref.path} is missing and its archive snapshot cannot release it: ${res.reason}`,
        );
      }
      throw err; // no snapshot — fail closed exactly as before
    }
    for (const t of phase.tasks ?? []) liveTaskIds.add(t.id);
    if (phase.tasks?.some((t) => t.id === taskId)) {
      hits.push({ phaseId: phase.id, phasePath: ref.path });
    }
  }

  // Collision check (same as the loaders): a drifted snapshot whose archived id
  // collides with a live id makes `depends_on` ambiguous — fail closed, even when
  // the target was found in a live phase.
  const merge = mergeArchivedTaskIndex(liveTaskIds, archivedCandidates);
  if (merge.collisions.length > 0) {
    throw new PhaseSnapshotInvalidError(
      `archive snapshot task ids collide with the live plan: ${merge.collisions
        .map((c) => c.reason)
        .join("; ")}`,
    );
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
