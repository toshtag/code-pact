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
import {
  appliedBudgetBytes,
  resolveAppliedContextBudget,
  type AppliedContextBudget,
  type TaskPrepareBudgetSelection,
} from "../core/context-fit/applied-context-budget.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TaskPrepareOptions = {
  cwd: string;
  taskId: string;
  /** Optional. When omitted, project.yaml's default_agent is used. */
  agent?: string;
  /** When true, build the context pack but do not write it to disk. */
  dryRun?: boolean;
  budgetSelection?: TaskPrepareBudgetSelection;
};

export type NextActionType =
  | "start_task"
  | "continue_implementation"
  | "wait_for_dependencies"
  | "noop_already_done"
  | "investigate_failure";

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

export type TaskPrepareResult = {
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
   * `requires_decision` task; omitted entirely otherwise. It is `[]` only when
   * the resolver found no accepted ADR entries — note an unresolved explicit
   * `decision_refs` gate may still surface its accepted refs (this surface is
   * advisory context, NOT gate enforcement; unlike the `ADR_COMMITMENTS_EMPTY`
   * lint advisory it does not require the gate to resolve). Additive.
   * Entries follow the resolver's `considered[]` order — no
   * chronological/priority/dependency meaning.
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
  // A malformed profile (e.g. an explicitly-configured but invalid
  // context_budget block) surfaces as CONFIG_ERROR rather than an
  // unclassified YAML/Zod throw, so `task prepare --context-budget …` matches
  // the documented error contract and the CLI renders a clean envelope.
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
      contextBudgetBytes !== undefined ? ` --budget-bytes ${contextBudgetBytes}` : ""
    }`,
    start: `code-pact task start ${taskId} --agent ${agent}`,
    verify: `code-pact verify --phase ${phaseId} --task ${taskId} --json --detail agent`,
    complete: `code-pact task complete ${taskId} --agent ${agent} --json --detail agent`,
    finalize: `code-pact task finalize ${taskId} --write --json`,
    // Template, not ready-to-run: `--evidence` is the agent's completion proof.
    "record-done": `code-pact task record-done ${taskId} --agent ${agent} --evidence "<verification you ran>"`,
  };
}

/**
 * The one mode-aware guidance surface. `mode` is consulted ONLY for the two
 * workable, pre-completion states (`start_task` / `continue_implementation`); the
 * early-return states pass no mode (recommendation is null there by construction)
 * and keep their static, mode-agnostic messages. The mode→message wording restates
 * `lifecycle.ts` / `per-task-loop.md` semantics, inventing nothing. The
 * `decision_loop` message states only the gate fact + a generic implement/verify
 * step — it does NOT decide complete-vs-record-done (lifecycle.ts returns
 * decision_loop whenever requires_decision is true, independent of ADR acceptance,
 * so the mode never implies the post-gate completion path).
 */
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
      return "wait_for_dependencies";
    case "done":
      return "noop_already_done";
    case "failed":
      return "investigate_failure";
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * `code-pact task prepare <task-id>` — single progress-read-only entry
 * point per task. Returns current state, recommendation, context pack
 * metadata, a structured `next_action`, and a `commands` dictionary.
 *
 * Progress invariant: this function MUST NOT record a progress event
 * (the ledger is left unchanged). It MAY write the deterministic
 * context pack at the agent profile's `context_dir/<task-id>.md`
 * (default `.context/<agent>/<task-id>.md`) unless `dryRun` is passed.
 *
 * Early-return states (`done`, `blocked`, unmet dependencies) skip
 * the context pack build entirely; their envelope returns
 * `recommendation: null`, `context_pack_path: null`,
 * `context_pack_bytes: 0`.
 */
export async function runTaskPrepare(
  opts: TaskPrepareOptions,
): Promise<TaskPrepareResult> {
  const { cwd, taskId } = opts;
  const dryRun = opts.dryRun ?? false;
  const budgetSelection = opts.budgetSelection ?? { kind: "none" };

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
    // This should be unreachable because resolveTaskInRoadmap already
    // confirmed the task exists in this phase, but guard anyway so a
    // future schema divergence does not silently produce a null result.
    const err = new Error(`Task "${taskId}" not found in phase "${phaseId}".`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }

  // 5. Derive current state.
  const currentState = deriveTaskState(progress.log.events, taskId).current;

  const commands = buildCommands(agentName, phaseId, taskId);

  // 6. Early return — done.
  if (currentState === "done") {
    return {
      task_id: taskId,
      phase_id: phaseId,
      agent: agentName,
      current_state: currentState,
      recommendation: null,
      context_pack_path: null,
      context_pack_bytes: 0,
      dry_run: dryRun,
      next_action: {
        type: "noop_already_done",
        message: messageFor("noop_already_done"),
      },
      commands,
      blocked_by: [],
      already_done: true,
    };
  }

  // 7. Early return — blocked state OR unmet dependencies.
  const blockedBy: string[] = [];
  if (currentState === "blocked") {
    // The state itself is blocked. We do not list specific dependency
    // ids in this branch — the block is a manual `task block` reason.
  } else {
    const dependsOn = task.depends_on ?? [];
    for (const depId of dependsOn) {
      const depState = deriveTaskState(progress.log.events, depId).current;
      if (depState !== "done") blockedBy.push(depId);
    }
  }

  if (currentState === "blocked" || blockedBy.length > 0) {
    return {
      task_id: taskId,
      phase_id: phaseId,
      agent: agentName,
      current_state: currentState,
      recommendation: null,
      context_pack_path: null,
      context_pack_bytes: 0,
      dry_run: dryRun,
      next_action: {
        type: "wait_for_dependencies",
        message: messageFor("wait_for_dependencies"),
      },
      commands,
      blocked_by: blockedBy,
    };
  }

  // 8. Recommendation (pure function).
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

  // 8b. Decision commitments. For a requires_decision task, resolve the
  // gate (read-only — preserves the progress-read-only invariant) and surface
  // the parsed `## Implementation commitments` of each ACCEPTED ADR in
  // resolution.considered[], in considered[] order. Present (possibly []) only
  // for gated tasks; it is [] only when the resolver found no accepted ADR
  // entries. An unresolved explicit decision_refs gate may still surface
  // accepted refs — task prepare is advisory implementation context, NOT gate
  // enforcement (task complete / verify own that). Unlike the
  // ADR_COMMITMENTS_EMPTY lint advisory, this does NOT require res.resolved.
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
      // The gate already classified this accepted ADR by reading it; re-read to
      // parse commitments. If it vanished in between (a TOCTOU race), skip it
      // rather than failing the whole prepare — commitments are advisory context,
      // and the gate's accepted verdict already stands. `considered.path` is the
      // gate's repo-root-relative, safety-checked path (an unsafe path is never
      // `accepted`), so this read cannot escape the project root.
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

  // 9. Context pack — build always, write unless dry-run. The budget is
  // resolved here, on the build path, so the done / blocked / unmet-deps early
  // returns above never trigger budget resolution or extra profile I/O.
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
  if (dryRun) {
    // Use the same resolver as the actual write so the would-write hint
    // matches what an actual write would produce, and the same .context/**
    // namespace + symlink-free containment rules apply.
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

  // 10. Map state → next_action.
  const nextActionType = nextActionTypeFor(currentState);

  const result: TaskPrepareResult = {
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
