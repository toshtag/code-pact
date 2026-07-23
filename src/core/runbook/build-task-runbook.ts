import {
  deriveTaskState,
  type TaskCurrentState,
} from "../progress/task-state.ts";
import {
  classifyTaskDrift,
  type DriftClassification,
} from "../plan/analyze.ts";
import type { ProgressEvent } from "../schemas/progress-event.ts";
import type { PhaseStatus } from "../schemas/phase.ts";
import type { Task } from "../schemas/task.ts";
import { resolveDependsOnStates } from "./depends-on.ts";
import {
  assertStepInvariant,
  type RunbookStep,
  type TaskRunbookResult,
  type TaskStateSummary,
  type AcceptanceRefCheck,
  type DependsOnEntry,
} from "./types.ts";
import { projectPathPresenceSync } from "../plan/checks/fs.ts";

// ---------------------------------------------------------------------------
// Task runbook builder.
//
// Pure function. Given an already-loaded plan state (phase reference + task)
// and progress events, returns the deterministic runbook for that task.
// The command layer handles I/O and JSON envelope assembly.
// ---------------------------------------------------------------------------

export type BuildTaskRunbookInput = {
  cwd: string;
  task: Task;
  phaseId: string;
  events: readonly ProgressEvent[];
  /**
   * Optional task_id → phase_id index covering every phase in the project.
   * When supplied, the dependency resolver annotates cross-phase entries
   * with the foreign phase id.
   */
  taskPhaseIndex?: ReadonlyMap<string, string>;
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

function checkAcceptanceRefs(cwd: string, task: Task): AcceptanceRefCheck[] {
  return (task.acceptance_refs ?? []).map(path => {
    const exists = projectPathPresenceSync(cwd, path) === "present";
    return { path, exists };
  });
}

function blockingDependsOnStep(unsatisfied: DependsOnEntry[]): RunbookStep {
  const first = unsatisfied[0]!;
  const others =
    unsatisfied.length > 1 ? ` (+ ${unsatisfied.length - 1} more)` : "";
  return step({
    manual_action: `Wait for ${first.task_id} to reach derived state: done (currently: ${first.current})${others}`,
    reason: `Task depends on ${unsatisfied.map(d => `${d.task_id} (current: ${d.current})`).join(", ")}. All subsequent steps are blocked until the dependencies resolve.`,
    blocking: true,
  });
}

function primaryLoopSteps(taskId: string): RunbookStep[] {
  return [
    step({
      command: `code-pact task start ${taskId}`,
      reason:
        "Record the planned → started transition so handoff and downstream tools see who is on this task.",
    }),
    step({
      command: `code-pact task context ${taskId}`,
      reason:
        "Fetch the context pack for implementation. Invoke this command with your own --agent choice; the runbook does not embed an agent name.",
    }),
    step({
      manual_action: "Implement the task",
      reason: "Apply the changes described by the task's design.",
    }),
    step({
      command: `code-pact task complete ${taskId}`,
      reason:
        "Run verify and, on pass, record a done event (written as a file under .code-pact/state/events/).",
      expected_result:
        "task derived state becomes done; design YAML status is NOT mutated (that is task finalize's job).",
    }),
  ];
}

function continueImplementationSteps(taskId: string): RunbookStep[] {
  return [
    step({
      manual_action: "Continue implementation",
      reason:
        "Task is already started; pick up where progress was last recorded.",
    }),
    step({
      command: `code-pact task complete ${taskId}`,
      reason:
        "Run verify and, on pass, record a done event (written as a file under .code-pact/state/events/).",
      expected_result:
        "task derived state becomes done; design YAML status is NOT mutated.",
    }),
  ];
}

function blockedSteps(taskId: string): RunbookStep[] {
  return [
    step({
      manual_action: "Resolve the blocker recorded in the last `blocked` event",
      reason:
        "Task is in derived state `blocked`; the blocker must be resolved before progress can resume.",
      blocking: true,
    }),
    step({
      command: `code-pact task resume ${taskId} --reason "<unblock reason>"`,
      reason:
        "Record the resume transition so the progress log captures the unblock decision.",
      blocking: true,
    }),
  ];
}

function failedSteps(taskId: string): RunbookStep[] {
  return [
    step({
      manual_action:
        "Diagnose the failure recorded in the last `failed` event and fix the underlying issue",
      reason:
        "Task is in derived state `failed`; verify did not pass during the last task complete attempt.",
      blocking: true,
    }),
    step({
      command: `code-pact task complete ${taskId}`,
      reason: "Re-run verify after the fix.",
    }),
  ];
}

function finalizeStep(taskId: string): RunbookStep {
  return step({
    command: `code-pact task finalize ${taskId} --write`,
    reason:
      "Task is done in the progress ledger but design status is still planned/in_progress. `task finalize` is the deterministic resolver.",
    safety_note: `This is a --write operation. Preview first with \`code-pact task finalize ${taskId} --json\` (dry-run).`,
    expected_result:
      "design/phases/<phase>.yaml task status flips to done; STATUS_DRIFT done-but-design-not-done clears on next plan analyze.",
  });
}

function manualReviewStep(taskId: string, driftKind: string): RunbookStep {
  return step({
    manual_action: `Run \`code-pact plan analyze --json\` and inspect the STATUS_DRIFT (${driftKind}) entry for ${taskId} — human judgement is required; phase reconcile intentionally refuses to mechanize this drift kind.`,
    reason: `Drift kind \`${driftKind}\` cannot be resolved mechanically. Reconcile / finalize will not touch the task.`,
    blocking: true,
  });
}

function lifecycleSteps(
  taskId: string,
  derived: TaskCurrentState,
  designStatus: PhaseStatus,
  drift: DriftClassification | null,
): RunbookStep[] {
  // Cancelled: terminal status, no lifecycle steps.
  if (designStatus === "cancelled") {
    return [];
  }

  // Done + consistent (with or without events): no work to do.
  if (designStatus === "done" && derived === "done") {
    return [];
  }
  // Done in design but progress disagrees → cannot mechanically reconcile.
  if (designStatus === "done" && drift) {
    if (drift.kind === "done-historical") return []; // hidden-by-default
    return [manualReviewStep(taskId, drift.kind)];
  }
  // Design says done but progress isn't done at all (in-progress-no-events mirror).
  if (designStatus === "done") {
    return [manualReviewStep(taskId, "design-says-done-progress-disagrees")];
  }

  // Design is planned or in_progress from here on.
  switch (derived) {
    case "done":
      // Drift is done-but-design-not-done; mechanical finalize resolves it.
      return [finalizeStep(taskId)];
    case "planned":
      // No events recorded → primary loop.
      return primaryLoopSteps(taskId);
    case "started":
    case "resumed":
      return continueImplementationSteps(taskId);
    case "blocked":
      return blockedSteps(taskId);
    case "failed":
      return failedSteps(taskId);
  }
}

export function buildTaskRunbook(
  input: BuildTaskRunbookInput,
): TaskRunbookResult {
  const { cwd, task, phaseId, events, taskPhaseIndex } = input;

  const derived = deriveTaskState(events, task.id);
  const drift = classifyTaskDrift(
    task.status,
    derived.current,
    derived.history.length > 0,
  );
  const depends = resolveDependsOnStates(events, task, {
    ownPhaseId: phaseId,
    taskPhaseIndex,
  });
  const acceptance = checkAcceptanceRefs(cwd, task);

  const state_summary: TaskStateSummary = {
    design_status: task.status,
    derived_state: derived.current,
    drift_kind: drift?.kind ?? null,
    depends_on: depends,
    acceptance_refs_check: acceptance,
    declared_writes: task.writes ?? [],
    decision_refs: task.decision_refs ?? [],
  };

  const unsatisfied = depends.filter(d => !d.satisfied);
  const steps: RunbookStep[] = [];

  if (task.status !== "cancelled") {
    if (unsatisfied.length > 0) {
      steps.push(blockingDependsOnStep(unsatisfied));
    }
    steps.push(...lifecycleSteps(task.id, derived.current, task.status, drift));
  }

  return {
    kind: "runbook",
    task_id: task.id,
    phase_id: phaseId,
    state_summary,
    next_steps: steps,
  };
}
