import type { TaskCurrentState } from "../progress/task-state.ts";
import type { PhaseStatus } from "../schemas/phase.ts";
import type { DriftKind } from "../plan/analyze.ts";

// ---------------------------------------------------------------------------
// Runbook types — v1.3 P12.
//
// Shared shape for `task runbook` and `phase runbook`. Every field is present
// in JSON output regardless of value; null is used where a field does not
// apply to a particular step or summary. JSON consumers can assume the
// schema is constant across step kinds.
//
// Invariant on RunbookStep: exactly one of `command` / `manual_action` is
// non-null — never both, never neither. The builders enforce this; tests
// assert it.
// ---------------------------------------------------------------------------

export type RunbookStep = {
  /** Full code-pact invocation. Null when manual_action is set. */
  command: string | null;
  /** Human-readable action a user takes outside the CLI. Null when command is set. */
  manual_action: string | null;
  /** Why this step is recommended. Required. */
  reason: string;
  /** When true, downstream steps assume this is resolved first. */
  blocking: boolean;
  /** Optional safety note (e.g. "this is a --write; preview with --json first"). */
  safety_note: string | null;
  /** Optional expected post-step state (e.g. "task status: done"). */
  expected_result: string | null;
};

export type DependsOnEntry = {
  task_id: string;
  current: TaskCurrentState;
  satisfied: boolean;
  /**
   * Phase id of the dependency, populated only when the dependency
   * resolves to a task in a different phase from the depending task
   * (v1.9 P19 cross-phase resolution). Omitted for same-phase
   * dependencies so existing JSON consumers see no shape change.
   */
  phase_id?: string;
};

export type AcceptanceRefCheck = {
  path: string;
  exists: boolean;
};

export type TaskStateSummary = {
  design_status: PhaseStatus;
  derived_state: TaskCurrentState;
  drift_kind: DriftKind | null;
  depends_on: DependsOnEntry[];
  acceptance_refs_check: AcceptanceRefCheck[];
  declared_writes: string[];
  decision_refs: string[];
};

export type TaskRunbookResult = {
  kind: "runbook";
  task_id: string;
  phase_id: string;
  state_summary: TaskStateSummary;
  next_steps: RunbookStep[];
};

export type TaskHistogram = {
  planned: number;
  started: number;
  blocked: number;
  resumed: number;
  done: number;
  failed: number;
};

export type DriftHistogram = {
  "done-but-design-not-done": number;
  manual_review: number;
  consistent: number;
};

export type PhaseSummary = {
  task_histogram: TaskHistogram;
  drift_histogram: DriftHistogram;
  phase_status_candidate: PhaseStatus;
  phase_status_note: string;
};

export type PhaseRunbookResult = {
  kind: "runbook";
  phase_id: string;
  phase_summary: PhaseSummary;
  next_steps: RunbookStep[];
};

/**
 * Assertion helper for the command/manual_action invariant. Both builders
 * use this when constructing every step so the invariant is checked at
 * source. Tests assert this throws when both fields are null or both set.
 */
export function assertStepInvariant(step: RunbookStep): void {
  const hasCommand = step.command !== null;
  const hasManual = step.manual_action !== null;
  if (hasCommand === hasManual) {
    throw new Error(
      `RunbookStep invariant violated: exactly one of command / manual_action must be non-null (command=${JSON.stringify(step.command)}, manual_action=${JSON.stringify(step.manual_action)})`,
    );
  }
}
