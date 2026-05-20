import { loadPlanState } from "../core/plan/state.ts";
import { buildPhaseRunbook } from "../core/runbook/build-phase-runbook.ts";
import type { PhaseRunbookResult } from "../core/runbook/types.ts";

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
  const entry = state.phases.find((e) => e.phase.id === phaseId);

  if (!entry) {
    const err = new Error(`Phase "${phaseId}" not found in roadmap.yaml.`);
    (err as NodeJS.ErrnoException).code = "PHASE_NOT_FOUND";
    throw err;
  }

  const events = state.progress?.events ?? [];

  return buildPhaseRunbook({
    phase: entry.phase,
    events,
  });
}
