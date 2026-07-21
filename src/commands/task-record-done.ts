import { loadProject, resolveEnabledAgent } from "../core/project.ts";
import type { ProgressEvent } from "../core/schemas/progress-event.ts";
import { loadProgressLog } from "../core/progress/io.ts";
import { writeEventFile } from "../core/progress/events-io.ts";
import { resolveEventAuthor } from "../core/progress/author.ts";
import { deriveTaskState } from "../core/progress/task-state.ts";
import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";
import { loadPhase } from "../core/plan/load-phase.ts";
import { assertTaskContractCurrent } from "../core/contract-lock.ts";
import { checkDecision, type CheckResult } from "./verify.ts";
import type { ConsideredAcceptance } from "../core/decisions/adr.ts";

export type TaskRecordDoneOptions = {
  cwd: string;
  taskId: string;
  /**
   * Completion proof — a PR, a CI result, or the verification the caller ran
   * (covers both external completion and the `record_only` lane). Non-empty.
   */
  evidence: string[];
  /** Optional. When omitted, project.yaml's default_agent is used. */
  agent?: string;
  /** Optional free-form note stored on the progress event. */
  notes?: string;
  /** When true, do not record a progress event (the ledger is unchanged). */
  dryRun?: boolean;
  /** Date injection for tests. Defaults to new Date(). */
  now?: () => Date;
};

export type TaskRecordDoneResult =
  | {
      kind: "done";
      task_id: string;
      phase_id: string;
      agent: string;
      event: ProgressEvent;
    }
  | {
      kind: "already_done";
      task_id: string;
      phase_id: string;
      agent: string;
    }
  | {
      kind: "dry_run";
      task_id: string;
      phase_id: string;
      agent: string;
      would_append: ProgressEvent;
    };

/** Structured payload attached to a thrown DECISION_REQUIRED error so the
 *  CLI can surface it as the JSON envelope's top-level `data`. */
export type DecisionRequiredData = {
  task_id: string;
  decision_check: CheckResult;
  /** How the gate resolves an ADR. Status-aware. */
  current_resolution: "status-aware";
  /** Which source drove resolution: explicit `decision_refs` or the filename scan. */
  via: "decision_refs" | "filename-scan";
  /** Every ADR the gate considered — with its parsed status and verdict. */
  considered: {
    path: string;
    status: string | null;
    accepted: boolean;
    acceptance: ConsideredAcceptance;
  }[];
  /** `task.decision_refs`, surfaced as informational input. */
  declared_decision_refs: string[];
  /** The filename glob the scan looked for. Present only when `via === "filename-scan"`. */
  expected_pattern?: string;
};

/**
 * Record a task as done without running `task complete`'s verification —
 * the proof is delegated to `evidence`. Two intended uses: work completed
 * OUTSIDE the code-pact loop (already-merged work, changes not verifiable
 * from the tree), and the `record_only` lane where `recommend` advised
 * `lifecycleMode: record_only` and the caller ran the project's verification
 * itself. The existing decision gate is still honored: a `requires_decision`
 * task with no resolvable ADR fails with DECISION_REQUIRED and no progress
 * event is recorded.
 *
 * The emitted event carries `source: "external"` so future diagnostics can
 * distinguish completion asserted via evidence from loop-verified completion.
 */
export async function runTaskRecordDone(
  opts: TaskRecordDoneOptions,
): Promise<TaskRecordDoneResult> {
  const { cwd, taskId } = opts;
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? (() => new Date());

  // ---- Step 1: evidence validation (before any project/roadmap/progress I/O) ----
  // Reject empty arrays AND any empty/whitespace-only item deterministically so
  // an invalid invocation never depends on the environment. Whitespace-only
  // items are rejected outright rather than silently dropped — a blank
  // `--evidence ""` is an error, not a no-op, so the recorded proof can never be
  // padded with empty entries. This is the final defense for direct/internal
  // callers; the CLI may also pre-check.
  if (
    opts.evidence.length === 0 ||
    opts.evidence.some(e => e.trim().length === 0)
  ) {
    const err = new Error(
      'task record-done requires --evidence "<text>" describing the proof of completion — a PR, a CI result, or the verification you ran (no empty or whitespace-only items).',
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }
  const evidence = opts.evidence.map(e => e.trim());

  // ---- Step 2: agent validation (reads project.yaml; before progress mutation) ----
  const project = await loadProject(cwd);
  const agentName = resolveEnabledAgent(project, opts.agent);

  // ---- Step 3: resolve phase from task id ----
  const { phaseId, phasePath } = await resolveTaskInRoadmap(cwd, taskId);

  // ---- Step 4: derive current state ----
  const { log } = await loadProgressLog(cwd);
  const state = deriveTaskState(log.events, taskId);

  // ---- Step 5: idempotency + transition guard (mirrors task complete) ----
  if (state.current === "done") {
    return {
      kind: "already_done",
      task_id: taskId,
      phase_id: phaseId,
      agent: agentName,
    };
  }
  // Reject from blocked. Task must be explicitly resumed first so the resume
  // event records the unblock decision in the log.
  if (state.current === "blocked") {
    const err = new Error(
      `Task "${taskId}" is blocked. Run \`task resume ${taskId}\` before recording done.`,
    );
    (err as NodeJS.ErrnoException).code = "INVALID_TASK_TRANSITION";
    (err as NodeJS.ErrnoException & { current?: string }).current =
      state.current;
    throw err;
  }
  // planned / started / resumed / failed: proceed. Like task complete we do
  // not call assertTransition here (planned→done is a command-layer shortcut).

  // ---- Step 6: load phase and task, check dependencies and decision gate ----
  // Resolve once: the same checkDecision call drives both the CheckResult and
  // the structured data, so they cannot drift apart between two reads of the
  // filesystem.
  const phase = await loadPhase(cwd, phasePath);
  const task = phase.tasks!.find(t => t.id === taskId)!;

  const incompleteDeps: string[] = [];
  for (const depId of task.depends_on ?? []) {
    if (deriveTaskState(log.events, depId).current !== "done") {
      incompleteDeps.push(depId);
    }
  }
  if (incompleteDeps.length > 0) {
    const err = new Error(
      `Task "${taskId}" cannot be recorded as done: dependencies are not done: ${incompleteDeps.join(", ")}.`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_DEPENDENCY_INCOMPLETE";
    (err as NodeJS.ErrnoException & { deps?: string[] }).deps = incompleteDeps;
    throw err;
  }

  const { check, resolution } = await checkDecision(cwd, phase, task);
  if (!check.ok) {
    const err = new Error(
      `Task "${taskId}" requires a decision ADR before it can be marked done.`,
    );
    (err as NodeJS.ErrnoException).code = "DECISION_REQUIRED";
    // resolution is non-null whenever check.ok is false: checkDecision only
    // skips resolution when neither phase nor task has requires_decision, in
    // which case check.ok is true.
    const data: DecisionRequiredData = {
      task_id: taskId,
      decision_check: check,
      current_resolution: "status-aware",
      via: resolution!.via,
      considered: resolution!.considered,
      declared_decision_refs: task.decision_refs ?? [],
      ...(resolution!.via === "filename-scan"
        ? { expected_pattern: `design/decisions/*${taskId}*.md` }
        : {}),
    };
    (err as NodeJS.ErrnoException & { data?: DecisionRequiredData }).data =
      data;
    throw err;
  }

  // Contract lock drift gate: require a lock and verify the contract has not
  // changed since the lock was created.
  await assertTaskContractCurrent({ cwd, taskId, requireLock: true });

  // ---- Step 7: build the done event (source: external) ----
  const author = await resolveEventAuthor(cwd);
  const event: ProgressEvent = {
    task_id: taskId,
    status: "done",
    at: now().toISOString(),
    actor: "agent",
    agent: agentName,
    evidence,
    source: "external",
    ...(opts.notes !== undefined && opts.notes.trim().length > 0
      ? { notes: opts.notes }
      : {}),
    ...(author !== undefined ? { author } : {}),
  };

  // ---- Step 8: dry-run short circuit ----
  if (dryRun) {
    return {
      kind: "dry_run",
      task_id: taskId,
      phase_id: phaseId,
      agent: agentName,
      would_append: event,
    };
  }

  // ---- Step 9: append + atomic write (shared helper) ----
  await writeEventFile(cwd, event);

  return {
    kind: "done",
    task_id: taskId,
    phase_id: phaseId,
    agent: agentName,
    event,
  };
}
