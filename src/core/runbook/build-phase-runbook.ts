import {
  deriveTaskState,
  type TaskCurrentState,
} from "../progress/task-state.ts";
import {
  classifyTaskDrift,
  type DriftClassification,
} from "../plan/analyze.ts";
import {
  classifyReconcile,
  type ReconcileClassification,
} from "../finalize/reconcile-classifier.ts";
import type { Phase, PhaseStatus } from "../schemas/phase.ts";
import type { ProgressEvent } from "../schemas/progress-event.ts";
import type { Task } from "../schemas/task.ts";
import {
  assertStepInvariant,
  type RunbookStep,
  type PhaseRunbookResult,
  type PhaseSummary,
  type TaskHistogram,
  type DriftHistogram,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Phase runbook builder.
//
// Pure function. Given an already-loaded phase and progress events, returns
// the deterministic runbook for that phase. The command layer
// handles I/O, phase resolution from roadmap, and JSON envelope assembly.
// ---------------------------------------------------------------------------

export type BuildPhaseRunbookInput = {
  phase: Phase;
  events: readonly ProgressEvent[];
};

const PHASE_STATUS_ADVISORY_NOTE =
  "advisory — phase status is never written by phase runbook (or by phase reconcile)";

type ClassifiedTask = {
  task: Task;
  derived: TaskCurrentState;
  drift: DriftClassification | null;
  reconcile: ReconcileClassification;
  hasEvents: boolean;
};

function step(
  init: Partial<RunbookStep> & Pick<RunbookStep, "reason">,
): RunbookStep {
  const s: RunbookStep = {
    command: init.command ?? null,
    manual_action: init.manual_action ?? null,
    reason: init.reason,
    blocking: init.blocking ?? false,
    safety_note: init.safety_note ?? null,
    expected_result: init.expected_result ?? null,
  };
  assertStepInvariant(s);
  return s;
}

function computeHistograms(classified: ClassifiedTask[]): {
  task_histogram: TaskHistogram;
  drift_histogram: DriftHistogram;
} {
  const task_histogram: TaskHistogram = {
    planned: 0,
    started: 0,
    blocked: 0,
    resumed: 0,
    done: 0,
    failed: 0,
  };
  const drift_histogram: DriftHistogram = {
    "done-but-design-not-done": 0,
    manual_review: 0,
    consistent: 0,
  };
  for (const c of classified) {
    task_histogram[c.derived] += 1;
    if (c.reconcile.action === "manual_review") {
      drift_histogram.manual_review += 1;
    } else if (c.drift?.kind === "done-but-design-not-done") {
      drift_histogram["done-but-design-not-done"] += 1;
    } else {
      drift_histogram.consistent += 1;
    }
  }
  return { task_histogram, drift_histogram };
}

function computePhaseStatusCandidate(
  classified: ClassifiedTask[],
): PhaseStatus {
  if (classified.length === 0) return "planned";

  const effective: PhaseStatus[] = classified.map((c) => {
    if (c.reconcile.action === "flip") return "done";
    if (c.task.status === "done") return "done";
    return c.task.status;
  });

  if (effective.every((s) => s === "done")) return "done";

  const hasActiveWork = classified.some(
    (c) =>
      c.derived === "started" ||
      c.derived === "blocked" ||
      c.derived === "resumed" ||
      c.derived === "failed",
  );
  if (hasActiveWork) return "in_progress";

  if (effective.some((s) => s === "in_progress")) return "in_progress";
  return "planned";
}

function blockedSteps(c: ClassifiedTask): RunbookStep[] {
  return [
    step({
      manual_action: `Resolve the blocker recorded in ${c.task.id}'s last \`blocked\` event`,
      reason: `${c.task.id} is in derived state \`blocked\`; resolution is a human concern.`,
      blocking: true,
    }),
    step({
      command: `code-pact task resume ${c.task.id} --reason "<unblock reason>"`,
      reason: `Record the resume transition so ${c.task.id}'s progress log captures the unblock decision.`,
      blocking: true,
    }),
  ];
}

function manualReviewStep(c: ClassifiedTask): RunbookStep {
  const driftLabel = c.drift?.kind ?? c.derived;
  return step({
    manual_action: `Run \`code-pact plan analyze --json\` and inspect ${c.task.id} (derived: ${c.derived}, drift: ${driftLabel}) — human judgement required; phase reconcile intentionally refuses to mechanize this state.`,
    reason: `${c.task.id} is in derived state \`${c.derived}\` and cannot be resolved by phase reconcile. Diagnose before continuing.`,
    blocking: true,
  });
}

function inProgressHintStep(c: ClassifiedTask): RunbookStep {
  return step({
    command: `code-pact task runbook ${c.task.id} --json`,
    reason: `${c.task.id} is in derived state \`${c.derived}\` — run its task-level runbook to see the per-task next step.`,
  });
}

function primaryLoopSteps(taskId: string): RunbookStep[] {
  return [
    step({
      command: `code-pact task start ${taskId}`,
      reason: `Begin ${taskId}: record the planned → started transition so handoff and downstream tools see who is on this task.`,
    }),
    step({
      command: `code-pact task context ${taskId}`,
      reason: `Fetch the context pack for ${taskId}'s implementation. Invoke with your own --agent choice.`,
    }),
    step({
      manual_action: `Implement ${taskId}`,
      reason: `Apply the changes described by ${taskId}'s design.`,
    }),
    step({
      command: `code-pact task complete ${taskId}`,
      reason: `Run verify and, on pass, append a done event for ${taskId}.`,
      expected_result: `${taskId} derived state becomes done; design YAML status is NOT mutated.`,
    }),
  ];
}

function reconcileBatchStep(
  phaseId: string,
  flipTaskIds: string[],
): RunbookStep {
  const ids = flipTaskIds.join(", ");
  return step({
    command: `code-pact phase reconcile ${phaseId} --write`,
    reason: `${flipTaskIds.length} task(s) (${ids}) are done in the progress ledger but design status is still planned/in_progress. \`phase reconcile --write\` flips them in one atomic batch.`,
    safety_note: `This is a --write operation. Preview first with \`code-pact phase reconcile ${phaseId} --json\` (dry-run).`,
    expected_result: `design/phases/<phase>.yaml task statuses flip planned → done; STATUS_DRIFT done-but-design-not-done clears for each task.`,
  });
}

function phaseStatusAdvisoryStep(
  phaseId: string,
  candidate: PhaseStatus,
): RunbookStep {
  return step({
    manual_action: `Flip the phase \`status\` field for ${phaseId} from its current value to \`${candidate}\` by hand in design/phases/${phaseId}-*.yaml.`,
    reason: `Every task in ${phaseId} would be \`done\` post-reconcile. Phase reconcile reports the candidate \`${candidate}\` but never writes the phase's own status; flip it by hand in release prep.`,
  });
}

export function buildPhaseRunbook(
  input: BuildPhaseRunbookInput,
): PhaseRunbookResult {
  const { phase, events } = input;

  const tasks = phase.tasks ?? [];
  const classified: ClassifiedTask[] = tasks.map((task) => {
    const derived = deriveTaskState(events, task.id);
    const hasEvents = derived.history.length > 0;
    return {
      task,
      derived: derived.current,
      drift: classifyTaskDrift(task.status, derived.current, hasEvents),
      reconcile: classifyReconcile(task.status, derived.current),
      hasEvents,
    };
  });

  const { task_histogram, drift_histogram } = computeHistograms(classified);
  const phase_status_candidate = computePhaseStatusCandidate(classified);

  // Build steps in priority order.
  const steps: RunbookStep[] = [];

  // 1. Blocked tasks → resume guidance (blocking).
  for (const c of classified) {
    if (c.derived === "blocked") {
      steps.push(...blockedSteps(c));
    }
  }

  // 2. Failed / complex-drift tasks → manual_review (blocking).
  for (const c of classified) {
    if (c.derived === "failed") {
      steps.push(manualReviewStep(c));
      continue;
    }
    if (
      c.drift?.kind === "done-blocked-conflict" ||
      c.drift?.kind === "done-with-incomplete-events"
    ) {
      steps.push(manualReviewStep(c));
    }
  }

  // 3. Eligible reconcile batch (one step covering every flip candidate).
  const flipCandidates = classified.filter((c) => c.reconcile.action === "flip");
  if (flipCandidates.length > 0) {
    steps.push(
      reconcileBatchStep(
        phase.id,
        flipCandidates.map((c) => c.task.id),
      ),
    );
  }

  // 4. In-progress task hints (non-blocking).
  for (const c of classified) {
    if (c.derived === "started" || c.derived === "resumed") {
      steps.push(inProgressHintStep(c));
    }
  }

  // 5. Untouched ready tasks → primary loop (non-blocking, only when
  //    depends_on is fully satisfied).
  for (const c of classified) {
    if (c.derived !== "planned" || c.hasEvents) continue;
    const deps = c.task.depends_on ?? [];
    const allDepsSatisfied = deps.every((depId) => {
      const ds = deriveTaskState(events, depId);
      return ds.current === "done";
    });
    if (!allDepsSatisfied) continue;
    steps.push(...primaryLoopSteps(c.task.id));
  }

  // 6. Phase-status advisory (manual_action, only when every task would be
  //    done post-reconcile AND the phase itself isn't already done).
  if (
    classified.length > 0 &&
    phase_status_candidate === "done" &&
    phase.status !== "done"
  ) {
    steps.push(phaseStatusAdvisoryStep(phase.id, phase_status_candidate));
  }

  const phase_summary: PhaseSummary = {
    task_histogram,
    drift_histogram,
    phase_status_candidate,
    phase_status_note: PHASE_STATUS_ADVISORY_NOTE,
  };

  return {
    kind: "runbook",
    phase_id: phase.id,
    phase_summary,
    next_steps: steps,
  };
}
