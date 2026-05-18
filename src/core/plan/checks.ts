import { readdir, access } from "node:fs/promises";
import { join } from "node:path";
import type { PhaseEntry } from "./state.ts";
import type { PlanIssue } from "./shared.ts";
import type { ProgressEvent } from "../schemas/progress-event.ts";
import type { Roadmap } from "../schemas/roadmap.ts";

const PHASE_ID_PATTERN = /^P\d+$/;
const TASK_ID_PATTERN = (phaseId: string): RegExp =>
  new RegExp(`^${phaseId}-T\\d+$`);

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Task IDs must be unique across every phase. The detector reports the
 * second (and subsequent) occurrence; doctor's historical behavior is
 * preserved by using the same code/severity/message so existing
 * integrations keep working.
 */
export function detectDuplicateTaskIds(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const seen = new Map<string, string>();
  for (const { phase } of phases) {
    for (const task of phase.tasks ?? []) {
      const first = seen.get(task.id);
      if (first !== undefined) {
        issues.push({
          code: "DUPLICATE_TASK_ID",
          severity: "error",
          message: `Task "${task.id}" appears in both phase "${first}" and "${phase.id}"`,
          phase_id: phase.id,
          task_id: task.id,
        });
      } else {
        seen.set(task.id, phase.id);
      }
    }
  }
  return issues;
}

/** Phase IDs must be unique across the roadmap. */
export function detectDuplicatePhaseIds(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const seen = new Map<string, string>();
  for (const entry of phases) {
    const first = seen.get(entry.phase.id);
    if (first !== undefined) {
      issues.push({
        code: "DUPLICATE_PHASE_ID",
        severity: "error",
        message: `Phase id "${entry.phase.id}" appears in both ${first} and ${entry.ref.path}`,
        phase_id: entry.phase.id,
        file: entry.ref.path,
      });
    } else {
      seen.set(entry.phase.id, entry.ref.path);
    }
  }
  return issues;
}

/**
 * The phase id inside a phase YAML must match the id the roadmap uses to
 * reference it. Catches copy/paste mistakes where a phase file was
 * cloned but the inner id was not updated.
 */
export function detectPhaseIdMismatches(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const entry of phases) {
    if (entry.phase.id !== entry.ref.id) {
      issues.push({
        code: "PHASE_ID_MISMATCH",
        severity: "error",
        message: `${entry.ref.path} has id="${entry.phase.id}" but roadmap expects "${entry.ref.id}"`,
        file: entry.ref.path,
        phase_id: entry.phase.id,
      });
    }
  }
  return issues;
}

/**
 * Roadmap references a phase file that does not exist on disk. doctor
 * historically reports this under the `ORPHAN_PHASE_FILE` code; plan
 * lint uses the clearer `MISSING_PHASE_FILE` code via
 * `detectMissingPhaseFiles`. Both call sites should treat this as an
 * error.
 */
export async function detectMissingPhaseFiles(
  cwd: string,
  roadmap: Roadmap,
): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  for (const ref of roadmap.phases) {
    const absPath = join(cwd, ref.path);
    if (!(await fileExists(absPath))) {
      issues.push({
        code: "MISSING_PHASE_FILE",
        severity: "error",
        message: `roadmap.yaml references "${ref.path}" but the file does not exist`,
        file: ref.path,
        phase_id: ref.id,
      });
    }
  }
  return issues;
}

/**
 * Phase YAML exists under design/phases/ but the roadmap does not
 * reference it. Warning-level so a deliberate stash of work-in-progress
 * does not block CI.
 */
export async function detectOrphanPhaseFiles(
  cwd: string,
  roadmap: Roadmap,
): Promise<PlanIssue[]> {
  const phasesDir = join(cwd, "design", "phases");
  let entries: string[] = [];
  try {
    entries = await readdir(phasesDir);
  } catch {
    return [];
  }
  const referenced = new Set(roadmap.phases.map((r) => r.path));
  const issues: PlanIssue[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".yaml")) continue;
    const relPath = `design/phases/${entry}`;
    if (!referenced.has(relPath)) {
      issues.push({
        code: "ORPHAN_PHASE_FILE",
        severity: "warning",
        message: `${relPath} exists but is not referenced in roadmap.yaml`,
        file: relPath,
      });
    }
  }
  return issues;
}

/**
 * Progress events whose `task_id` does not correspond to any task in
 * any phase. Almost always indicates a renamed/deleted task whose
 * historical events were left behind.
 *
 * `plan lint` does NOT call this — orphan event detection compares
 * progress against the task index and therefore belongs in
 * `plan analyze`. `doctor` keeps calling it to preserve historical
 * behavior for users who run `doctor` as their single health gate.
 */
export function detectOrphanProgressEvents(
  events: ProgressEvent[],
  taskIndex: Map<string, unknown>,
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (taskIndex.has(event.task_id)) continue;
    if (seen.has(event.task_id)) continue;
    seen.add(event.task_id);
    issues.push({
      code: "ORPHAN_PROGRESS_EVENT",
      severity: "warning",
      message: `progress.yaml references task "${event.task_id}" which does not exist in any phase`,
      task_id: event.task_id,
    });
  }
  return issues;
}

/** Phase ids should follow the repo's P<N> convention (warning only). */
export function detectPhaseIdNaming(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    if (!PHASE_ID_PATTERN.test(phase.id)) {
      issues.push({
        code: "PHASE_ID_NAMING",
        severity: "warning",
        message: `Phase id "${phase.id}" does not match the P<N> naming convention`,
        file: ref.path,
        phase_id: phase.id,
      });
    }
  }
  return issues;
}

/**
 * Task ids should look like `<phaseId>-T<N>` (warning only). Catches
 * the most common copy/paste error where a task is pasted into the
 * wrong phase.
 */
export function detectTaskIdPhasePrefix(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    const pattern = TASK_ID_PATTERN(phase.id);
    for (const task of phase.tasks ?? []) {
      if (!pattern.test(task.id)) {
        issues.push({
          code: "TASK_ID_PHASE_PREFIX",
          severity: "warning",
          message: `Task id "${task.id}" does not match the "${phase.id}-T<N>" naming convention`,
          file: ref.path,
          phase_id: phase.id,
          task_id: task.id,
        });
      }
    }
  }
  return issues;
}
