import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Roadmap } from "../core/schemas/roadmap.ts";
import { Phase, type PhaseStatus } from "../core/schemas/phase.ts";
import { loadProgressLog } from "../core/progress/io.ts";
import {
  deriveTaskState,
  type TaskCurrentState,
} from "../core/progress/task-state.ts";
import {
  applyPlannedWrite,
  classifyWriteRequest,
  type WriteRefusalReason,
} from "../core/finalize/safe-write.ts";
import type { TaskStatusDiff } from "../core/finalize/diff.ts";

// ---------------------------------------------------------------------------
// `task finalize <task-id>` — v1.2 P11
//
// Flips a single task's design YAML `status` field to `done`, but only
// when the task already has a `done` event in progress.yaml. Default
// mode is dry-run; `--write` is the explicit opt-in to mutate disk.
//
// The v1.0 contract that `task complete` records progress only and
// never mutates design YAML is preserved — this command is the
// explicit, separate opposite-direction operation that drains
// `STATUS_DRIFT done-but-design-not-done` warnings.
//
// Per the accepted RFC (design/decisions/finalization-reconciliation-
// rfc.md), this command does NOT take an --agent flag. It is a
// design/progress reconciliation command that never calls an adapter.
// ---------------------------------------------------------------------------

export type TaskFinalizeOptions = {
  cwd: string;
  taskId: string;
  /** When true, apply the write. Default (false) is dry-run. */
  write?: boolean;
};

export type AcceptanceRefCheck = {
  path: string;
  exists: boolean;
};

export type DependsOnCheck = {
  task_id: string;
  current: TaskCurrentState;
  satisfied: boolean;
};

type FinalizeContext = {
  task_id: string;
  phase_id: string;
  file: string;
  current_status: PhaseStatus;
  target_status: "done";
  acceptance_refs_check: AcceptanceRefCheck[];
  declared_writes: string[];
  depends_on_check: DependsOnCheck[];
};

export type TaskFinalizeResult =
  | (FinalizeContext & {
      kind: "would_finalize";
      planned_writes: TaskStatusDiff[];
    })
  | (FinalizeContext & {
      kind: "finalized";
      applied_writes: TaskStatusDiff[];
      skipped_writes: never[];
    })
  | (FinalizeContext & {
      kind: "already_finalized";
    });

type RoadmapHit = { phaseId: string; file: string };

async function resolveTaskPhase(
  cwd: string,
  taskId: string,
): Promise<RoadmapHit> {
  const roadmapRaw = await readFile(join(cwd, "design", "roadmap.yaml"), "utf8");
  const roadmap = Roadmap.parse(parseYaml(roadmapRaw) as unknown);

  const hits: RoadmapHit[] = [];
  for (const ref of roadmap.phases) {
    const phaseRaw = await readFile(join(cwd, ref.path), "utf8");
    const phase = Phase.parse(parseYaml(phaseRaw) as unknown);
    if (phase.tasks?.some((t) => t.id === taskId)) {
      hits.push({ phaseId: phase.id, file: ref.path });
    }
  }

  if (hits.length === 0) {
    const err = new Error(`Task "${taskId}" not found in any phase.`);
    (err as NodeJS.ErrnoException).code = "TASK_NOT_FOUND";
    throw err;
  }
  if (hits.length > 1) {
    const err = new Error(
      `Task "${taskId}" exists in multiple phases: ${hits.map((h) => h.phaseId).join(", ")}`,
    );
    (err as NodeJS.ErrnoException).code = "AMBIGUOUS_TASK_ID";
    (err as NodeJS.ErrnoException & { phases?: string[] }).phases = hits.map(
      (h) => h.phaseId,
    );
    throw err;
  }
  return hits[0]!;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p, "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function runTaskFinalize(
  opts: TaskFinalizeOptions,
): Promise<TaskFinalizeResult> {
  const { cwd, taskId } = opts;
  const write = opts.write === true;

  // 1. Resolve task → phase + file.
  const { phaseId, file } = await resolveTaskPhase(cwd, taskId);

  // 2. Derive current state from progress.yaml.
  const { log } = await loadProgressLog(cwd);
  const state = deriveTaskState(log.events, taskId);

  // 3. Eligibility check — derived state must be `done`. Identical in
  //    dry-run and --write modes; dry-run means "won't write", not
  //    "won't validate".
  if (state.current !== "done") {
    const err = new Error(
      `Task "${taskId}" is not finalize-eligible: derived state is "${state.current}", expected "done". Run \`task complete ${taskId}\` first.`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_FINALIZE_NOT_ELIGIBLE";
    (err as NodeJS.ErrnoException & {
      current?: string;
      task_id?: string;
      phase_id?: string;
    }).current = state.current;
    (err as NodeJS.ErrnoException & {
      current?: string;
      task_id?: string;
      phase_id?: string;
    }).task_id = taskId;
    (err as NodeJS.ErrnoException & {
      current?: string;
      task_id?: string;
      phase_id?: string;
    }).phase_id = phaseId;
    throw err;
  }

  // 4. Classify the safe-write request. This reads the phase YAML and
  //    validates path safety + parseability + task existence.
  const classified = await classifyWriteRequest({
    cwd,
    file,
    taskId,
    targetStatus: "done",
  });

  if (classified.kind === "refused") {
    const err = new Error(
      `Refused to finalize "${taskId}": ${classified.detail}`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_FINALIZE_WRITE_REFUSED";
    (err as NodeJS.ErrnoException & {
      reason?: WriteRefusalReason;
      file?: string;
    }).reason = classified.reason;
    (err as NodeJS.ErrnoException & {
      reason?: WriteRefusalReason;
      file?: string;
    }).file = classified.file;
    throw err;
  }

  // 5. The phase parsed cleanly and the task exists. Pull P10 fields
  //    off the task for the report sections that appear under every
  //    kind.
  const task = (classified.phase.tasks ?? []).find((t) => t.id === taskId);
  // task is guaranteed present because classifyWriteRequest validated it.
  if (!task) {
    throw new Error(
      `internal invariant: task "${taskId}" missing from classified phase`,
    );
  }

  const acceptanceRefsCheck: AcceptanceRefCheck[] = [];
  for (const ref of task.acceptance_refs ?? []) {
    acceptanceRefsCheck.push({
      path: ref,
      exists: await fileExists(join(cwd, ref)),
    });
  }

  const dependsOnCheck: DependsOnCheck[] = (task.depends_on ?? []).map(
    (depId) => {
      const depState = deriveTaskState(log.events, depId);
      return {
        task_id: depId,
        current: depState.current,
        satisfied: depState.current === "done",
      };
    },
  );

  const baseContext: FinalizeContext = {
    task_id: taskId,
    phase_id: phaseId,
    file,
    current_status: task.status,
    target_status: "done",
    acceptance_refs_check: acceptanceRefsCheck,
    declared_writes: task.writes ? [...task.writes] : [],
    depends_on_check: dependsOnCheck,
  };

  // 6. Idempotent no-op: already at target.
  if (classified.kind === "no-op") {
    return {
      kind: "already_finalized",
      ...baseContext,
    };
  }

  // 7. classified.kind === "planned": either dry-run report or apply.
  if (!write) {
    return {
      kind: "would_finalize",
      ...baseContext,
      planned_writes: [classified.diff],
    };
  }

  await applyPlannedWrite(cwd, classified.diff);

  return {
    kind: "finalized",
    ...baseContext,
    applied_writes: [classified.diff],
    skipped_writes: [],
  };
}
