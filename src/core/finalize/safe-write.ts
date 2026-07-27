import {
  readOwnedText,
  resolvePhaseReadPath,
  resolvePhaseWritePath,
} from "../project-fs/index.ts";
import { parse as parseYaml } from "yaml";
import { atomicReplaceExistingText } from "../../io/atomic-text.ts";
import { assertSafeRelativePath } from "../path-safety.ts";
import { Phase, type PhaseStatus } from "../schemas/phase.ts";
import { computeTaskStatusDiff, type TaskStatusDiff } from "./diff.ts";
import { buildTaskStatusSourceEdit } from "./task-status-source-edit.ts";

// ---------------------------------------------------------------------------
// Safe-write contract for Finalization & Reconciliation
//
// Owns the load → source-edit → atomic-replace pattern that both `task
// finalize` and `phase reconcile` need. The mutation itself is a single
// scalar replacement in the original bytes (see task-status-source-edit.ts),
// never a re-serialization of the parsed phase. Returns
// structured refusals instead of throwing so the command layer can
// map each refusal reason to its own public error code
//
// READ-MODIFY-WRITE — deliberately NOT routed through the
// core/plan/load-phase.ts seam, and (per the design-docs-ephemeral directive)
// it must NEVER archive-fallback: this module rewrites the phase file in place,
// and you cannot rewrite a phase you have archived / deleted. A missing or
// unreadable phase here is a structured refusal (`unreadable` /
// `unparseable_phase`), never a value synthesized from a `.code-pact/state`
// snapshot.
// (TASK_FINALIZE_WRITE_REFUSED / PHASE_RECONCILE_WRITE_REFUSED) and
// its own JSON envelope shape.
//
// Safety constraints:
//   - The target path must pass `assertSafeRelativePath` (no `..`,
//     leading `/`, etc.).
//   - The target path must be under `design/phases/` and end with
//     `.yaml`. design/roadmap.yaml is deliberately NOT writable.
//   - `resolveSymlinkFreeProjectPath` must succeed (catches symlink escape and
//     in-project symlink aliases).
//   - The file must be readable and parseable as a Phase.
//   - The task id must exist in the parsed phase's tasks[].
//
// This module performs NO command-layer concerns: it does not throw
// error codes, does not produce JSON envelopes, and does not log.
// ---------------------------------------------------------------------------

/** Why a write was refused. The command layer maps each value to its own error code. */
export type WriteRefusalReason =
  /** `assertSafeRelativePath` rejected the path (traversal, absolute, etc.). */
  | "unsafe_path"
  /** The path is not under `design/phases/`. */
  | "outside_design_phases"
  /** The path does not end in `.yaml`. */
  | "not_yaml"
  /** Owned path resolution rejected the path (symlink escape or alias). */
  | "symlink_escape"
  /** The file could not be read from disk. */
  | "unreadable"
  /** YAML parse or zod Phase validation failed. */
  | "unparseable_phase"
  /** The task id is not present in `phase.tasks[]`. */
  | "task_not_found";

export type PlannedWrite = {
  kind: "planned";
  diff: TaskStatusDiff;
  /**
   * The parsed phase. Caller must treat this as read-only. Useful for
   * commands that surface declared_writes / acceptance_refs / depends_on
   * on the same task in their JSON envelope.
   */
  phase: Phase;
};

export type RefusedWrite = {
  kind: "refused";
  reason: WriteRefusalReason;
  detail: string;
  file: string;
};

export type NoChange = {
  kind: "no-op";
  file: string;
  task_id: string;
  current_status: PhaseStatus;
  phase: Phase;
};

export type ClassifyResult = PlannedWrite | RefusedWrite | NoChange;

export type ClassifyRequest = {
  cwd: string;
  /** Repo-root-relative POSIX path to the phase YAML. */
  file: string;
  taskId: string;
  /** Target status to flip the task to. Only "done" is used. */
  targetStatus: PhaseStatus;
};

/**
 * Classifies a proposed task-status write against the safety contract.
 *
 *   - `kind: "planned"` — the write is safe and will be a change. The
 *     caller can use `result.diff` for a dry-run report, and pass the
 *     same diff to `applyPlannedWrite` to execute it.
 *   - `kind: "no-op"` — the file is safe and parseable, but the task is
 *     already at `targetStatus`. The caller treats this as idempotent
 *     success (`already_finalized` in `task finalize`'s envelope).
 *   - `kind: "refused"` — one of the safety checks failed. The caller
 *     maps `reason` to its command-specific error code.
 *
 * This function reads the phase YAML to validate it but does NOT write
 * anywhere.
 */
export async function classifyWriteRequest(
  req: ClassifyRequest,
): Promise<ClassifyResult> {
  const { cwd, file, taskId, targetStatus } = req;

  // 1. Path structural safety. `assertSafeRelativePath` rejects empty,
  //    `..`, leading `/`, leading `~`, Windows drive letters, `.`
  //    segments, etc.
  try {
    assertSafeRelativePath(file);
  } catch (err) {
    return {
      kind: "refused",
      reason: "unsafe_path",
      detail: err instanceof Error ? err.message : String(err),
      file,
    };
  }

  // 2. Confine writes to design/phases/*.yaml. design/roadmap.yaml is
  //    deliberately NOT writable here; release prep continues to
  //    handle it manually.
  if (!file.startsWith("design/phases/")) {
    return {
      kind: "refused",
      reason: "outside_design_phases",
      detail: `write target "${file}" is not under design/phases/`,
      file,
    };
  }
  if (!file.endsWith(".yaml")) {
    return {
      kind: "refused",
      reason: "not_yaml",
      detail: `write target "${file}" does not end in .yaml`,
      file,
    };
  }

  // 3. Owned path resolution: no symlink component is allowed for automated
  //    phase mutation, including in-project aliases.
  try {
    await resolvePhaseReadPath(cwd, file);
  } catch (err) {
    return {
      kind: "refused",
      reason: "symlink_escape",
      detail: err instanceof Error ? err.message : String(err),
      file,
    };
  }

  // 4. Read the phase YAML.
  let raw: string;
  try {
    raw = await readOwnedText(await resolvePhaseReadPath(cwd, file));
  } catch (err) {
    return {
      kind: "refused",
      reason: "unreadable",
      detail: err instanceof Error ? err.message : String(err),
      file,
    };
  }

  // 5. Parse + zod-validate as Phase.
  let phase: Phase;
  try {
    phase = Phase.parse(parseYaml(raw) as unknown);
  } catch (err) {
    return {
      kind: "refused",
      reason: "unparseable_phase",
      detail: err instanceof Error ? err.message : String(err),
      file,
    };
  }

  // 6. Task must exist in this phase.
  const task = (phase.tasks ?? []).find(t => t.id === taskId);
  if (!task) {
    return {
      kind: "refused",
      reason: "task_not_found",
      detail: `task "${taskId}" not found in phase "${phase.id}" (${file})`,
      file,
    };
  }

  // 7. Compute the diff. null means already at target → idempotent no-op.
  const diff = computeTaskStatusDiff({ file, phase, taskId, targetStatus });
  if (diff === null) {
    return {
      kind: "no-op",
      file,
      task_id: taskId,
      current_status: task.status,
      phase,
    };
  }

  return { kind: "planned", diff, phase };
}

/**
 * Applies a previously classified planned write to disk as a **source edit**:
 * the only bytes that change are the target task's `status` scalar. Everything
 * else in the phase file — the top-level `evidence:` list, keys the Phase
 * schema does not model, comments, key order, block-scalar wrapping — is left
 * exactly as the maintainer wrote it (issue #560).
 *
 * The write re-reads the file rather than trusting the `phase` snapshot from
 * `classifyWriteRequest`, and hands those same bytes to
 * `atomicReplaceExistingText` as the expected current content. A concurrent
 * writer that changed the file between the read and the rename loses the race
 * and keeps its bytes: this candidate is built from a source that no longer
 * exists, so writing it would silently revert that writer's edit.
 *
 * Throws when:
 *   - owned path resolution fails (path safety changed since classify).
 *   - The file has been deleted or become unreadable since classify.
 *   - The file no longer parses as YAML or no longer validates as a Phase.
 *   - The task id no longer exists, or exists more than once.
 *   - The task's status is no longer `diff.before`.
 *   - The file changed under us between the read and the rename.
 */
export async function applyPlannedWrite(
  cwd: string,
  diff: TaskStatusDiff,
): Promise<void> {
  const writePath = await resolvePhaseWritePath(cwd, diff.file);
  const raw = await readOwnedText(await resolvePhaseReadPath(cwd, diff.file));
  const { candidate } = buildTaskStatusSourceEdit({
    raw,
    taskId: diff.task_id,
    expectedBefore: diff.before,
    targetAfter: diff.after,
  });
  await atomicReplaceExistingText(writePath, candidate, raw);
}
