import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Project } from "../core/schemas/project.ts";
import type { ProgressEvent } from "../core/schemas/progress-event.ts";
import { appendEvent, loadProgressLog } from "../core/progress/io.ts";
import { deriveTaskState } from "../core/progress/task-state.ts";
import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";
import { checkDecision, loadPhase, type CheckResult } from "./verify.ts";

export type TaskRecordDoneOptions = {
  cwd: string;
  taskId: string;
  /** Evidence for the externally-completed work. Must be non-empty. */
  evidence: string[];
  /** Optional. When omitted, project.yaml's default_agent is used. */
  agent?: string;
  /** Optional free-form note stored on the progress event. */
  notes?: string;
  /** When true, do not modify progress.yaml. */
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
  /** How the current gate resolves an ADR. Deliberately not status-aware in v1.21. */
  current_resolution: "file-presence-by-task-id";
  /** The filename pattern the gate looks for. */
  expected_pattern: string;
  /** task.decision_refs, surfaced as informational only — the gate does NOT use them. */
  declared_decision_refs: string[];
};

async function loadProject(cwd: string): Promise<Project> {
  const raw = await readFile(join(cwd, ".code-pact", "project.yaml"), "utf8");
  return Project.parse(parseYaml(raw) as unknown);
}

/**
 * Record a task as done for work completed OUTSIDE the code-pact loop
 * (already-merged work, docs-only changes whose loop cost is clearly
 * excessive, etc.). Unlike `task complete` this does NOT run verification
 * commands — the proof is delegated to `evidence`. The existing decision
 * gate is still honored: a `requires_decision` task with no resolvable ADR
 * fails with DECISION_REQUIRED and progress.yaml is left untouched.
 *
 * The emitted event carries `source: "external"` so future diagnostics can
 * distinguish externally-asserted completion from loop-verified completion.
 */
export async function runTaskRecordDone(
  opts: TaskRecordDoneOptions,
): Promise<TaskRecordDoneResult> {
  const { cwd, taskId } = opts;
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? (() => new Date());

  // ---- Step 1: evidence validation (before any project/roadmap/progress I/O) ----
  // Reject empty arrays and empty/whitespace-only items deterministically so
  // an invalid invocation never depends on the environment. This is the final
  // defense for direct/internal callers; the CLI may also pre-check.
  const evidence = opts.evidence.map((e) => e.trim()).filter((e) => e.length > 0);
  if (evidence.length === 0) {
    const err = new Error(
      "task record-done requires --evidence \"<text>\" describing the externally-completed work.",
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }

  // ---- Step 2: agent validation (reads project.yaml; before progress mutation) ----
  const project = await loadProject(cwd);
  const agentName = opts.agent ?? project.default_agent;
  const ref = project.agents.find((a) => a.name === agentName);
  if (!ref) {
    const err = new Error(`Agent "${agentName}" is not configured in project.yaml.`);
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }
  if (ref.enabled === false) {
    const err = new Error(
      `Agent "${agentName}" is disabled in project.yaml (enabled: false).`,
    );
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_ENABLED";
    throw err;
  }

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
    (err as NodeJS.ErrnoException & { current?: string }).current = state.current;
    throw err;
  }
  // planned / started / resumed / failed: proceed. Like task complete we do
  // not call assertTransition here (planned→done is a command-layer shortcut).

  // ---- Step 6: decision gate (same gate as verify, no verification commands) ----
  const phase = await loadPhase(cwd, phasePath);
  const task = phase.tasks!.find((t) => t.id === taskId)!;
  const decisionCheck = await checkDecision(cwd, phase, task);
  if (!decisionCheck.ok) {
    const err = new Error(
      `Task "${taskId}" requires a decision ADR before it can be marked done.`,
    );
    (err as NodeJS.ErrnoException).code = "DECISION_REQUIRED";
    const data: DecisionRequiredData = {
      task_id: taskId,
      decision_check: decisionCheck,
      current_resolution: "file-presence-by-task-id",
      expected_pattern: `design/decisions/*${taskId}*.md`,
      declared_decision_refs: task.decision_refs ?? [],
    };
    (err as NodeJS.ErrnoException & { data?: DecisionRequiredData }).data = data;
    throw err;
  }

  // ---- Step 7: build the done event (source: external) ----
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
  await appendEvent(cwd, event);

  return {
    kind: "done",
    task_id: taskId,
    phase_id: phaseId,
    agent: agentName,
    event,
  };
}
