import { loadPlanState } from "../core/plan/state.ts";
import {
  resolvePhaseInPlanState,
  findUniquePhaseInPlanState,
} from "../core/plan/resolve-phase.ts";
import { buildPhaseRunbook } from "../core/runbook/build-phase-runbook.ts";
import { buildTaskPhaseIndex } from "../core/runbook/depends-on.ts";
import { deriveTaskState } from "../core/progress/task-state.ts";
import type {
  AcrossPhasesRunbookResult,
  PhaseRunbookResult,
} from "../core/runbook/types.ts";

// ---------------------------------------------------------------------------
// `phase runbook <phase-id>` — v1.3 P12-T4
//
// Read-only guidance command. Returns a deterministic list of next
// recommended steps for the given phase. Per the accepted P12 RFC, the
// command does NOT take an --agent flag and does NOT mutate anything.
// Every recommended step is a command string the user runs separately,
// or a manual_action describing a human checkpoint.
//
// Error codes reused (no new codes): PHASE_NOT_FOUND / CONFIG_ERROR
// (in cli.ts argv parsing).
// ---------------------------------------------------------------------------

export type PhaseRunbookOptions = {
  cwd: string;
  phaseId: string;
};

export async function runPhaseRunbook(
  opts: PhaseRunbookOptions,
): Promise<PhaseRunbookResult> {
  const { cwd, phaseId } = opts;

  const state = await loadPlanState(cwd);
  const entry = resolvePhaseInPlanState(state, phaseId);

  const events = state.progress?.events ?? [];

  return buildPhaseRunbook({
    phase: entry.phase,
    events,
  });
}

/**
 * v1.9 P19-T3: aggregated cross-phase runbook. Emits one
 * per-phase runbook for every phase in scope:
 *
 *   - phase.status === "in_progress" (always included), and
 *   - phases that DECLARE a task referenced by an in_progress
 *     phase's task via `depends_on` (one level of transitive
 *     closure — enough for release-prep semantics without
 *     surfacing the entire roadmap).
 *
 * Phases with status `done`, `planned`, or `cancelled` are
 * excluded UNLESS pulled in via the dep-driven rule above.
 * Ordering: phase id ascending.
 */
export async function runPhaseRunbookAcrossPhases(opts: {
  cwd: string;
}): Promise<AcrossPhasesRunbookResult> {
  const { cwd } = opts;
  const state = await loadPlanState(cwd);
  const events = state.progress?.events ?? [];

  const taskPhaseIndex = buildTaskPhaseIndex(state.phases.map((e) => e.phase));

  const inProgressEntries = state.phases.filter(
    (e) => e.phase.status === "in_progress",
  );

  const includedPhaseIds = new Set<string>(
    inProgressEntries.map((e) => e.phase.id),
  );

  // One level of transitive closure: any phase that hosts a task
  // currently depended on (and unsatisfied) by an in-progress
  // phase task gets pulled in.
  for (const ip of inProgressEntries) {
    for (const task of ip.phase.tasks ?? []) {
      for (const dep of task.depends_on ?? []) {
        const declaringPhase = taskPhaseIndex.get(dep);
        if (!declaringPhase || declaringPhase === ip.phase.id) continue;
        const depState = deriveTaskState(events, dep);
        if (depState.current !== "done") {
          includedPhaseIds.add(declaringPhase);
        }
      }
    }
  }

  const considered = Array.from(includedPhaseIds).sort();

  const phaseResults: PhaseRunbookResult[] = [];
  for (const phaseId of considered) {
    const entry = findUniquePhaseInPlanState(state, phaseId);
    if (!entry) continue;
    phaseResults.push(
      buildPhaseRunbook({
        phase: entry.phase,
        events,
      }),
    );
  }

  return {
    kind: "aggregated_runbook",
    phases_considered: considered,
    phases: phaseResults,
  };
}
