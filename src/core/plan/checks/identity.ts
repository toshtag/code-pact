import type { PhaseEntry } from "../state.ts";
import type { PlanIssue, PlanIssueRecovery } from "../shared.ts";

const PHASE_ID_PATTERN = /^P\d+$/;
const TASK_ID_PATTERN = (phaseId: string): RegExp =>
  new RegExp(`^${phaseId}-T\\d+[A-Z]?$`);

// ---------------------------------------------------------------------------
// Recovery guidance for the collaboration conflict diagnostics.
//
// These id collisions / mismatches are the dangerous "clean-but-wrong merge"
// class: two branches independently mint the same `P<N>` (or `P<N>-T<M>`) id in
// separate files, git auto-merges with no conflict, and the corruption only
// surfaces here. The detector already names which files/phases collide; these
// builders add the *fix* — minimal manual edit + the re-verify command — as a
// structured field so an agent can act without parsing prose. Exported so the
// doctor surface (which emits PHASE_ID_MISMATCH directly) reuses identical text.
// ---------------------------------------------------------------------------

// The fix for an id collision/mismatch is a manual edit (rename an id), not a
// single runnable command, so these use `manual_action` + `confirm` rather than a
// prose `primary` — keeping `primary` strictly executable so an agent never runs
// prose as a command. Same convention as the doctor CONTROL_PLANE_GITIGNORED fix.
const PLAN_LINT_CONFIRM = "code-pact plan lint";

export function duplicatePhaseIdRecovery(
  id: string,
  fileA: string,
  fileB: string,
): PlanIssueRecovery {
  return {
    manual_action: `Give one phase a unique id: edit \`id:\` in ${fileB} and update its entry in design/roadmap.yaml (rename the file/path too if the filename embeds the old id or to keep the \`<id>-<slug>.yaml\` convention). If that phase has tasks whose ids use the old phase prefix, rename those task ids too and update any \`depends_on\` that references them. If ${fileA} and ${fileB} are the SAME phase merged from two branches, delete the duplicate file and its roadmap.yaml entry instead of renumbering.`,
    confirm: PLAN_LINT_CONFIRM,
    reference: `Both files claim phase id "${id}". Re-run plan lint after editing to surface any follow-up TASK_ID_PHASE_PREFIX / DUPLICATE_TASK_ID. See docs/troubleshooting.md (DUPLICATE_PHASE_ID).`,
  };
}

export function duplicateTaskIdRecovery(
  id: string,
  phaseA: string,
  fileA: string,
  phaseB: string,
  fileB: string,
): PlanIssueRecovery {
  return {
    manual_action: `Renumber one task to a unique id: change its \`id:\` under the \`tasks:\` of phase "${phaseB}" (${fileB}), and update any \`depends_on\` entry that references the old id "${id}". (\`decision_refs\` / \`acceptance_refs\` are file paths, not task-id references — only touch them if a path intentionally embeds the old id.) If progress events already exist for "${id}", check which task they belong to before editing — do not blindly rewrite event files. If the task was duplicated by a branch merge, delete the redundant copy from one of ${fileA} / ${fileB} instead.`,
    confirm: PLAN_LINT_CONFIRM,
    reference: `Task id "${id}" is claimed by phase "${phaseA}" (${fileA}) and phase "${phaseB}" (${fileB}). If the two phases also share an id, fix DUPLICATE_PHASE_ID first. See docs/troubleshooting.md (DUPLICATE_TASK_ID).`,
  };
}

export function phaseIdMismatchRecovery(
  file: string,
  expected: string,
  actual: string,
): PlanIssueRecovery {
  return {
    manual_action: `Make the id consistent: set \`id: ${expected}\` inside ${file}, OR change that file's entry id in design/roadmap.yaml to "${actual}".`,
    confirm: PLAN_LINT_CONFIRM,
    reference: `${file} has id="${actual}" but roadmap.yaml references it as "${expected}". See docs/troubleshooting.md (PHASE_ID_MISMATCH).`,
  };
}

/**
 * Task IDs must be unique across every phase. The detector reports the
 * second (and subsequent) occurrence; doctor's historical behavior is
 * preserved by using the same code/severity/message so existing
 * integrations keep working.
 */
export function detectDuplicateTaskIds(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  // Track the file too, not just the phase id: two phase files that BOTH claim
  // `id: P7` (a DUPLICATE_PHASE_ID) and both define `P7-T1` would otherwise
  // surface as "phase P7 and phase P7" — useless. The path disambiguates.
  const seen = new Map<string, { phaseId: string; file: string }>();
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const first = seen.get(task.id);
      if (first !== undefined) {
        issues.push({
          code: "DUPLICATE_TASK_ID",
          severity: "error",
          message: `Task "${task.id}" appears in both phase "${first.phaseId}" (${first.file}) and "${phase.id}" (${ref.path})`,
          phase_id: phase.id,
          task_id: task.id,
          // `file` is single-valued (the second occurrence). The full collision
          // pair is in `details` so an agent can act without parsing the message.
          file: ref.path,
          details: {
            colliding_files: [first.file, ref.path],
            colliding_phases: [first.phaseId, phase.id],
          },
          recovery: duplicateTaskIdRecovery(
            task.id,
            first.phaseId,
            first.file,
            phase.id,
            ref.path,
          ),
        });
      } else {
        seen.set(task.id, { phaseId: phase.id, file: ref.path });
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
        // `file` is single-valued (the second occurrence). The full collision
        // pair is in `details` for machine consumption.
        file: entry.ref.path,
        details: { colliding_files: [first, entry.ref.path] },
        recovery: duplicatePhaseIdRecovery(
          entry.phase.id,
          first,
          entry.ref.path,
        ),
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
        recovery: phaseIdMismatchRecovery(
          entry.ref.path,
          entry.ref.id,
          entry.phase.id,
        ),
      });
    }
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
 * Task ids should look like `<phaseId>-T<N>` with an optional single
 * uppercase trial suffix, e.g. `<phaseId>-T<N><A-Z>` (warning only).
 * Catches the most common copy/paste error where a task is pasted into
 * the wrong phase while still allowing historical one-off trial ids.
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
          message: `Task id "${task.id}" does not match the "${phase.id}-T<N>" or "${phase.id}-T<N><A-Z>" naming convention`,
          file: ref.path,
          phase_id: phase.id,
          task_id: task.id,
        });
      }
    }
  }
  return issues;
}
