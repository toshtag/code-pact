// Phase-id → phase resolver core.
//
// A plain `roadmap.phases.find((p) => p.id === id)` (or
// `state.phases.find(...)`) silently returns the FIRST match when a
// roadmap contains a DUPLICATE phase id — e.g. two branches
// that both mint `P51` and then merge (separate files, no git conflict). The
// agent then acts on whichever phase happened to be first.
//
// Mirroring `resolve-task.ts` (the task resolver, which fixed the same
// silent-first-match for task ids via `AMBIGUOUS_TASK_ID`), this module is the
// single source of truth for phase-id resolution. It throws `PHASE_NOT_FOUND`
// on zero matches and `AMBIGUOUS_PHASE_ID` on more than one, so a duplicate id
// fails closed instead of resolving the wrong phase.
//
// `AMBIGUOUS_PHASE_ID` carries `.phases: string[]` — the colliding phase **file
// paths** (the ids are identical; the paths are what distinguish them) — for
// callers that surface the list in their JSON envelope.

import type { PhaseRef, Roadmap } from "../schemas/roadmap.ts";
import type { PhaseEntry, PlanState } from "./state.ts";
import { loadRoadmap } from "./roadmap.ts";

function phaseNotFoundError(phaseId: string): NodeJS.ErrnoException {
  // Message is kept stable so existing PHASE_NOT_FOUND behaviour (and tests)
  // are unchanged.
  const err = new Error(`Phase "${phaseId}" not found in roadmap.yaml.`);
  (err as NodeJS.ErrnoException).code = "PHASE_NOT_FOUND";
  return err as NodeJS.ErrnoException;
}

export function ambiguousPhaseError(
  phaseId: string,
  paths: string[],
): NodeJS.ErrnoException {
  const err = new Error(
    `Phase "${phaseId}" is defined in multiple roadmap entries: ${paths.join(", ")}`,
  );
  (err as NodeJS.ErrnoException).code = "AMBIGUOUS_PHASE_ID";
  (err as NodeJS.ErrnoException & { phases?: string[] }).phases = paths;
  return err as NodeJS.ErrnoException;
}

/**
 * Resolve a phase id against an already-loaded `Roadmap`. Pure variant for
 * call sites that have already read `roadmap.yaml`.
 *
 * Throws `PHASE_NOT_FOUND` (zero matches) or `AMBIGUOUS_PHASE_ID` (more than
 * one). The ambiguity error carries `.phases: string[]` (the colliding paths).
 */
export function resolvePhaseRef(roadmap: Roadmap, phaseId: string): PhaseRef {
  const hits = roadmap.phases.filter(p => p.id === phaseId);
  if (hits.length === 0) throw phaseNotFoundError(phaseId);
  if (hits.length > 1) {
    throw ambiguousPhaseError(
      phaseId,
      hits.map(h => h.path),
    );
  }
  return hits[0]!;
}

/**
 * I/O variant: load `design/roadmap.yaml` (strict) and resolve `phaseId`.
 * For call sites that have not already loaded the roadmap.
 */
export async function resolvePhaseInRoadmap(
  cwd: string,
  phaseId: string,
): Promise<PhaseRef> {
  return resolvePhaseRef(await loadRoadmap(cwd), phaseId);
}

/**
 * Resolve a phase id against an already-loaded `PlanState`. Throws
 * `PHASE_NOT_FOUND` / `AMBIGUOUS_PHASE_ID` with the same shape as the roadmap
 * variants.
 */
export function resolvePhaseInPlanState(
  state: PlanState,
  phaseId: string,
): PhaseEntry {
  const hits = state.phases.filter(e => e.phase.id === phaseId);
  if (hits.length === 0) throw phaseNotFoundError(phaseId);
  if (hits.length > 1) {
    throw ambiguousPhaseError(
      phaseId,
      hits.map(h => h.ref.path),
    );
  }
  return hits[0]!;
}

/**
 * Like `resolvePhaseInPlanState`, but returns `undefined` on zero matches
 * instead of throwing — for callers that intentionally *skip* a missing phase
 * (e.g. aggregation loops). It still **fails closed** (`AMBIGUOUS_PHASE_ID`) on
 * a duplicate id, so a collision is never silently resolved to the first match.
 */
export function findUniquePhaseInPlanState(
  state: PlanState,
  phaseId: string,
): PhaseEntry | undefined {
  const hits = state.phases.filter(e => e.phase.id === phaseId);
  if (hits.length > 1) {
    throw ambiguousPhaseError(
      phaseId,
      hits.map(h => h.ref.path),
    );
  }
  return hits[0];
}
