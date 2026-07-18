import {
  readOwnedText,
  resolveDecisionReadPath,
} from "../core/project-fs/index.ts";
import { parse as parseYaml } from "yaml";
import {
  resolveRecommendation,
  type RecommendResult,
} from "../core/recommend/index.ts";
import { buildContextPack, writeContextPack } from "../core/pack/index.ts";
import type { DeferredContextProjection } from "../core/context-deferral/deferred-section.ts";
import { resolveProfileContextOutputPath } from "../core/pack/context-output-path.ts";
import {
  isDecisionRequiredForTask,
  resolveDecisionGate,
  parseAdrCommitments,
} from "../core/decisions/adr.ts";
import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";
import { loadProgressLog } from "../core/progress/io.ts";
import {
  deriveTaskState,
  type TaskCurrentState,
} from "../core/progress/task-state.ts";
import { AgentProfile } from "../core/schemas/agent-profile.ts";
import {
  assertAgentProfileNameMatches,
  resolveAgentProfilePath,
} from "../core/agent-profile-path.ts";
import { loadPhase } from "../core/plan/load-phase.ts";
import { loadProject, resolveEnabledAgent } from "../core/project.ts";
import type { Task as TaskT } from "../core/schemas/task.ts";
import type { Phase } from "../core/schemas/phase.ts";
import type { ProgressEvent } from "../core/schemas/progress-event.ts";
import {
  appliedBudgetBytes,
  resolveAppliedContextBudget,
  type AppliedContextBudget,
  type TaskPrepareBudgetSelection,
} from "../core/context-fit/applied-context-budget.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TaskPrepareDetail = "minimal" | "full";

export type TaskPrepareOptions = {
  cwd: string;
  taskId: string;
  /** Optional. When omitted, project.yaml's default_agent is used. */
  agent?: string;
  /** When true, build the context pack but do not write it to disk. */
  dryRun?: boolean;
  budgetSelection?: TaskPrepareBudgetSelection;
  /**
   * Output detail level. `"minimal"` returns a compact work order;
   * `"full"` (or an explicit budget) preserves the existing detailed contract.
   */
  detail?: TaskPrepareDetail;
};

export type NextActionType =
  | "start_task"
  | "continue_implementation"
  | "wait_for_dependencies"
  | "resolve_block"
  | "inspect_decision"
  | "noop_already_done"
  | "investigate_failure";

export type TaskPrepareMinimalNextAction = {
  type: NextActionType;
  command: string | null;
};

export type TaskPrepareMinimalFailure = {
  summary: string | null;
  fingerprint: string | null;
  command: string | null;
  exit_code: number | null;
};

export type TaskPrepareMinimalTask = {
  id: string;
  phase_id: string;
  state: TaskCurrentState;
  goal: string;
  read_scope: string[];
  write_scope: string[];
  done_when: string[];
  verify: string[];
  acceptance_refs?: string[];
  decision_required: boolean;
  decision_refs?: string[];
};

export type TaskPrepareMinimalResult = {
  detail: "minimal";
  task: TaskPrepareMinimalTask;
  next: TaskPrepareMinimalNextAction;
  more: { command: string };
  blocked_by?: string[];
  block?: { summary: string };
  failure?: TaskPrepareMinimalFailure;
};

export type TaskPrepareCommands = {
  context: string;
  start: string;
  verify: string;
  complete: string;
  finalize: string;
  /**
   * Additive, always present in every lifecycle mode. The ONE non-runnable
   * entry: `--evidence` is agent-supplied, so it is a template with an
   * angle-bracket token, not a ready-to-run string like the others. The key is
   * exactly `record-done` (hyphen), accessed `commands["record-done"]`.
   */
  "record-done": string;
};

export type TaskPrepareFullResult = {
  detail: "full";
  task_id: string;
  phase_id: string;
  agent: string;
  current_state: TaskCurrentState;
  /**
   * Null only for done/blocked/unmet-dependency early returns.
   * A non-null recommendation includes lifecycleMode and repairPolicy.
   */
  recommendation: RecommendResult | null;
  context_pack_path: string | null;
  context_pack_bytes: number;
  /** Present only in dry-run mode when a pack would have been written. */
  would_write_context_pack_path?: string;
  dry_run: boolean;
  next_action: {
    type: NextActionType;
    message: string;
  };
  commands: TaskPrepareCommands;
  blocked_by: string[];
  /** Present (true) only when current_state is "done". */
  already_done?: boolean;
  /**
   * Parsed `## Implementation commitments` of each ACCEPTED ADR the
   * decision gate considered for this task. Present (possibly `[]`) only for a
   * `requires_decision` task; omitted entirely otherwise.
   */
  decision_commitments?: {
    adr: string;
    has_section: boolean;
    items: { text: string; done: boolean }[];
  }[];
  deferred_context?: DeferredContextProjection;
  /** Present only on the context-pack build path; omitted for early returns. */
  applied_context_budget?: AppliedContextBudget;
};

/** Backward-compatible alias for the full-detail result. */
export type TaskPrepareResult = TaskPrepareFullResult;

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadAgentProfile(
  cwd: string,
  agentName: string,
): Promise<AgentProfile> {
  const path = await resolveAgentProfilePath(cwd, agentName);
  let raw: string;
  try {
    raw = await readOwnedText(path);
  } catch {
    const err = new Error(`Agent profile for "${agentName}" not found.`);
    (err as NodeJS.ErrnoException).code = "AGENT_NOT_FOUND";
    throw err;
  }
  try {
    const profile = AgentProfile.parse(parseYaml(raw) as unknown);
    assertAgentProfileNameMatches(profile, agentName, path);
    return profile;
  } catch (cause) {
    const err = new Error(
      `Agent profile for "${agentName}" is invalid: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCommands(
  agent: string,
  phaseId: string,
  taskId: string,
  contextBudgetBytes?: number | undefined,
): TaskPrepareCommands {
  return {
    context: `code-pact task context ${taskId} --agent ${agent}${
      contextBudgetBytes !== undefined
        ? ` --budget-bytes ${contextBudgetBytes}`
        : ""
    }`,
    start: `code-pact task start ${taskId} --agent ${agent}`,
    verify: `code-pact verify --phase ${phaseId} --task ${taskId} --json --detail agent`,
    complete: `code-pact task complete ${taskId} --agent ${agent} --json --detail agent`,
    finalize: `code-pact task finalize ${taskId} --write --json`,
    "record-done": `code-pact task record-done ${taskId} --agent ${agent} --evidence "<verification you ran>"`,
  };
}

function messageFor(
  actionType: NextActionType,
  mode?: RecommendResult["lifecycleMode"],
): string {
  switch (actionType) {
    case "start_task":
      switch (mode) {
        case "record_only":
          return "Run task start, implement, run project verification yourself, then record completion with `task record-done --evidence`. This is a lighter loop, not lighter verification.";
        case "decision_loop":
          return "Resolve/accept the gating ADR first; verification and completion-recording paths block on the decision gate. Then run task start, implement, and verify.";
        default:
          return "Run task start, then implement, verify, complete.";
      }
    case "continue_implementation":
      switch (mode) {
        case "record_only":
          return "Implement, run project verification yourself, then record completion with `task record-done --evidence`. This is a lighter loop, not lighter verification.";
        case "decision_loop":
          return "Resolve/accept the gating ADR first; verification and completion-recording paths block on the decision gate. Then implement and verify.";
        default:
          return "Implement the task, run verification, then complete the task.";
      }
    case "wait_for_dependencies":
      return "Resolve blocking dependencies, then re-run task prepare.";
    case "resolve_block":
      return "Resolve the manual block reason, then re-run task prepare.";
    case "inspect_decision":
      return "Inspect the gating decision before starting; run the full-detail prepare command.";
    case "noop_already_done":
      return "Task is already done; no action required.";
    case "investigate_failure":
      return "Task last failed; investigate the failure, then re-run task start.";
  }
}

function nextActionTypeFor(state: TaskCurrentState): NextActionType {
  switch (state) {
    case "planned":
      return "start_task";
    case "started":
    case "resumed":
      return "continue_implementation";
    case "blocked":
      return "resolve_block";
    case "done":
      return "noop_already_done";
    case "failed":
      return "investigate_failure";
  }
}

function minimalNextCommand(
  actionType: NextActionType,
  agentName: string,
  taskId: string,
): string | null {
  const fullPrepare = `code-pact task prepare ${taskId} --agent ${agentName} --detail full --json`;
  switch (actionType) {
    case "start_task":
      return `code-pact task start ${taskId} --agent ${agentName}`;
    case "inspect_decision":
      return fullPrepare;
    case "continue_implementation":
    case "wait_for_dependencies":
    case "resolve_block":
    case "noop_already_done":
    case "investigate_failure":
      return null;
  }
}

const MAX_REASON_BYTES = 512;

function utf8Truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  let end = Math.min(maxBytes, buf.length);
  while (end > 0) {
    const byte = buf[end] ?? 0;
    if ((byte & 0b11000000) !== 0b10000000) break;
    end--;
  }
  if (end === 0) {
    return Buffer.from(buf.subarray(0, maxBytes)).toString("utf8");
  }
  return Buffer.from(buf.subarray(0, end)).toString("utf8");
}

function boundedReason(
  reason: string | null | undefined,
  maxBytes: number = MAX_REASON_BYTES,
): string | null {
  if (reason == null) return null;
  return utf8Truncate(reason, maxBytes);
}

function resolveMinimalNextAction(
  currentState: TaskCurrentState,
  blockedBy: string[],
  decisionRequired: boolean,
): NextActionType {
  if (currentState === "done") return "noop_already_done";
  if (blockedBy.length > 0) return "wait_for_dependencies";
  if (currentState === "blocked") return "resolve_block";
  if (currentState === "failed") return "investigate_failure";
  if (currentState === "planned" && decisionRequired) return "inspect_decision";
  return nextActionTypeFor(currentState);
}

function buildMinimalResult(opts: {
  phase: Phase;
  task: TaskT;
  currentState: TaskCurrentState;
  lastEvent: ProgressEvent | undefined;
  agentName: string;
  taskId: string;
  phaseId: string;
  blockedBy: string[];
}): TaskPrepareMinimalResult {
  const {
    phase,
    task,
    currentState,
    lastEvent,
    agentName,
    taskId,
    phaseId,
    blockedBy,
  } = opts;

  const decisionRequired = isDecisionRequiredForTask(phase, task);
  const nextType = resolveMinimalNextAction(
    currentState,
    blockedBy,
    decisionRequired,
  );

  const taskPayload: TaskPrepareMinimalTask = {
    id: taskId,
    phase_id: phaseId,
    state: currentState,
    goal: (task.description ?? "").trim() || phase.objective.trim(),
    read_scope: task.reads ?? [],
    write_scope: task.writes ?? [],
    done_when: phase.definition_of_done,
    verify: phase.verification.commands,
    decision_required: decisionRequired,
  };

  if (task.acceptance_refs && task.acceptance_refs.length > 0) {
    taskPayload.acceptance_refs = task.acceptance_refs;
  }

  if (decisionRequired && task.decision_refs && task.decision_refs.length > 0) {
    taskPayload.decision_refs = task.decision_refs;
  }

  const result: TaskPrepareMinimalResult = {
    detail: "minimal",
    task: taskPayload,
    next: {
      type: nextType,
      command: minimalNextCommand(nextType, agentName, taskId),
    },
    more: {
      command: `code-pact task prepare ${taskId} --agent ${agentName} --detail full --json`,
    },
  };

  if (nextType === "wait_for_dependencies") {
    result.blocked_by = blockedBy;
  }

  if (nextType === "resolve_block") {
    result.block = { summary: boundedReason(lastEvent?.reason) ?? "" };
  }

  if (currentState === "failed") {
    result.failure = {
      summary: boundedReason(lastEvent?.reason),
      fingerprint: null,
      command: null,
      exit_code: null,
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * `code-pact task prepare <task-id>` — single progress-read-only entry
 * point per task.
 *
 * Progress invariant: this function MUST NOT record a progress event
 * (the ledger is left unchanged).
 *
 * - `detail: "minimal"` (default CLI): returns a compact work-order JSON.
 *   Does not build or write a context pack, resolve recommendations, read ADR
 *   bodies, or search memory. The result contains the task goal, declared
 *   read/write scope, completion criteria, verification commands, decision
 *   state, a single next action, and one explicit full-detail fallback command.
 *
 * - `detail: "full"` / explicit budget: preserves the existing detailed
 *   contract, including recommendation, context pack build/write, decision
 *   commitments, and lifecycle commands dictionary.
 */
export async function runTaskPrepare(
  opts: TaskPrepareOptions,
): Promise<TaskPrepareMinimalResult | TaskPrepareFullResult> {
  const { cwd, taskId } = opts;
  const budgetSelection = opts.budgetSelection ?? { kind: "none" };
  // Explicit budget implies full detail — budgeting is about sizing the full
  // context pack, not about the minimal work-order mode.
  const detail: "minimal" | "full" =
    budgetSelection.kind !== "none" ? "full" : (opts.detail ?? "minimal");

  // 1. Agent validation (mirrors task context / task start order).
  const project = await loadProject(cwd);
  const agentName = resolveEnabledAgent(project, opts.agent);

  // 2. Resolve task to phase.
  const { phaseId, phasePath } = await resolveTaskInRoadmap(cwd, taskId);

  // 3. Load phase + progress events in parallel.
  const [phase, progress] = await Promise.all([
    loadPhase(cwd, phasePath),
    loadProgressLog(cwd),
  ]);

  // 4. Find task entry within the phase.
  const task: TaskT | undefined = phase.tasks?.find(t => t.id === taskId);
  if (!task) {
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  // 5. Derive current state.
  const { current: currentState, last_event: lastEvent } = deriveTaskState(
    progress.log.events,
    taskId,
  );

  // 6. Compute blocked-by (used by both modes).
  const blockedBy: string[] = [];
  if (currentState !== "blocked") {
    const dependsOn = task.depends_on ?? [];
    for (const depId of dependsOn) {
      const depState = deriveTaskState(progress.log.events, depId).current;
      if (depState !== "done") blockedBy.push(depId);
    }
  }

  // 7. Minimal mode: return compact work order without heavy loaders.
  if (detail === "minimal") {
    return buildMinimalResult({
      phase,
      task,
      currentState,
      lastEvent,
      agentName,
      taskId,
      phaseId,
      blockedBy,
    });
  }

  // 8. Full-detail mode below. Keep early-return shape identical to the
  // historical contract so existing consumers / tests remain stable.

  const commands = buildCommands(agentName, phaseId, taskId);

  // 8a. Early return — done.
  if (currentState === "done") {
    return {
      task_id: taskId,
      phase_id: phaseId,
      agent: agentName,
      current_state: currentState,
      recommendation: null,
      context_pack_path: null,
      context_pack_bytes: 0,
      detail: "full",
      dry_run: opts.dryRun ?? false,
      next_action: {
        type: "noop_already_done",
        message: messageFor("noop_already_done"),
      },
      commands,
      blocked_by: [],
      already_done: true,
    };
  }

  // 8b. Early return — blocked state OR unmet dependencies.
  if (currentState === "blocked" || blockedBy.length > 0) {
    const isManualBlock = currentState === "blocked";
    const nextType: NextActionType = isManualBlock
      ? "resolve_block"
      : "wait_for_dependencies";
    return {
      task_id: taskId,
      phase_id: phaseId,
      agent: agentName,
      current_state: currentState,
      recommendation: null,
      context_pack_path: null,
      context_pack_bytes: 0,
      detail: "full",
      dry_run: opts.dryRun ?? false,
      next_action: {
        type: nextType,
        message: messageFor(nextType),
      },
      commands,
      blocked_by: blockedBy,
    };
  }

  // 8c. Recommendation (pure function).
  const agentProfile = await loadAgentProfile(cwd, agentName);
  const recommendation = resolveRecommendation({
    phaseId,
    taskId,
    task,
    agentName,
    agentProfile,
    decisionContext: {
      phaseRequiresDecision: phase.requires_decision === true,
    },
  });

  // 8d. Decision commitments (full mode only).
  let decisionCommitments:
    | {
        adr: string;
        has_section: boolean;
        items: { text: string; done: boolean }[];
      }[]
    | undefined;
  if (isDecisionRequiredForTask(phase, task)) {
    const resolution = await resolveDecisionGate(
      cwd,
      taskId,
      task.decision_refs,
    );
    decisionCommitments = [];
    for (const considered of resolution.considered) {
      if (!considered.accepted) continue;
      let adrContent: string;
      try {
        adrContent = await readOwnedText(
          await resolveDecisionReadPath(cwd, considered.path),
        );
      } catch {
        continue;
      }
      const { hasSection, items } = parseAdrCommitments(adrContent);
      decisionCommitments.push({
        adr: considered.path,
        has_section: hasSection,
        items,
      });
    }
  }

  // 8e. Context pack.
  const appliedContextBudget = resolveAppliedContextBudget({
    selection: budgetSelection,
    agentName,
    contextBudget: agentProfile.context_budget,
    recommendation,
  });
  const budgetBytes = appliedBudgetBytes(appliedContextBudget);
  const pack = await buildContextPack({
    cwd,
    phaseId,
    taskId,
    agentName,
    ...(budgetBytes !== undefined ? { budgetBytes } : {}),
  });
  const contextPackBytes = Buffer.byteLength(pack.content, "utf8");

  let contextPackPath: string | null = null;
  let wouldWritePath: string | undefined;
  let deferredContext: DeferredContextProjection | undefined;
  const dryRun = opts.dryRun ?? false;
  if (dryRun) {
    wouldWritePath = await resolveProfileContextOutputPath(
      cwd,
      agentProfile.context_dir,
      taskId,
    );
    if (pack.deferredContext) {
      deferredContext = {
        ...pack.deferredContext,
        persisted: false,
        retrieve_command: null,
      };
    }
  } else {
    const written = await writeContextPack(pack, {
      cwd,
      agentName,
      profileContextDir: agentProfile.context_dir,
    });
    contextPackPath = written.outputPath;
    if (pack.deferredContext) {
      deferredContext = {
        ...pack.deferredContext,
        persisted: true,
        retrieve_command: `code-pact context show ${pack.deferredContext.manifest_ref} --list --json`,
      };
    }
  }

  const nextActionType = nextActionTypeFor(currentState);

  const result: TaskPrepareFullResult = {
    detail: "full",
    task_id: taskId,
    phase_id: phaseId,
    agent: agentName,
    current_state: currentState,
    recommendation,
    context_pack_path: contextPackPath,
    context_pack_bytes: contextPackBytes,
    dry_run: dryRun,
    next_action: {
      type: nextActionType,
      message: messageFor(nextActionType, recommendation.lifecycleMode),
    },
    commands: buildCommands(agentName, phaseId, taskId, budgetBytes),
    blocked_by: [],
    applied_context_budget: appliedContextBudget,
  };

  if (wouldWritePath !== undefined) {
    result.would_write_context_pack_path = wouldWritePath;
  }

  if (decisionCommitments !== undefined) {
    result.decision_commitments = decisionCommitments;
  }

  if (deferredContext !== undefined) {
    result.deferred_context = deferredContext;
  }

  return result;
}
