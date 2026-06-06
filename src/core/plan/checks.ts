import { readdir, access } from "node:fs/promises";
import { join } from "node:path";
import type { PhaseEntry } from "./state.ts";
import type { PlanIssue, PlanIssueRecovery } from "./shared.ts";
import type { ProgressEvent } from "../schemas/progress-event.ts";
import {
  assertTransition,
  type TaskCurrentState,
  type TaskTransition,
} from "../progress/task-state.ts";
import { computeEventId } from "../progress/event-id.ts";
import type { Roadmap } from "../schemas/roadmap.ts";
import { assertSafeRelativePath } from "../path-safety.ts";
import {
  findProtectedPathOverlaps,
  type ProtectedPathEntry,
  validateGlobSyntax,
  walkAndMatch,
} from "../glob.ts";

const PHASE_ID_PATTERN = /^P\d+$/;
const TASK_ID_PATTERN = (phaseId: string): RegExp =>
  new RegExp(`^${phaseId}-T\\d+$`);

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
        recovery: duplicatePhaseIdRecovery(entry.phase.id, first, entry.ref.path),
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
      message: `the progress ledger references task "${event.task_id}" which does not exist in any phase`,
      task_id: event.task_id,
    });
  }
  return issues;
}

// `planned -> done` is the v0.5 legacy command-layer shortcut (task complete on
// a never-started task), so it is acceptable, not a conflict.
function isAcceptableTransition(
  current: TaskCurrentState,
  next: TaskTransition,
): boolean {
  if (current === "planned" && next === "done") return true;
  try {
    assertTransition(current, next);
    return true;
  } catch {
    return false;
  }
}

/**
 * One side of a `PROGRESS_EVENT_CONFLICT` — the structured `details.events[]`
 * shape (Collaboration UX RFC, D3). Lets an agent read *who* produced each side
 * of a conflict without parsing the human `message`. `author` is omitted for
 * legacy / capture-off (anonymous) events, exactly as on the event itself.
 * `event_id` is the content id (`computeEventId`) — the *suffix* of a per-event
 * filename `<at-compact>-<event_id>.yaml` (NOT the whole name; locate the file
 * with `.code-pact/state/events/*-<event_id>.yaml`). An event that lives only in
 * a legacy `.code-pact/state/progress.yaml` has no per-event file — reconcile the
 * matching `progress.yaml` entry (or migrate it) in that case.
 */
export type ConflictEventEntry = {
  event_id: string;
  status: ProgressEvent["status"];
  author?: string;
  at: string;
};

/** Project an event onto its `details.events[]` entry (D3). Key order matches the
 *  RFC-pinned shape (`event_id, status, author?, at`); `author` omitted when absent. */
function toConflictEventEntry(e: ProgressEvent): ConflictEventEntry {
  return {
    event_id: computeEventId(e),
    status: e.status,
    ...(e.author !== undefined ? { author: e.author } : {}),
    at: e.at,
  };
}

/** Human rendering of one side, naming the author when present (D3). */
function describeSide(e: ProgressEvent): string {
  return e.author !== undefined ? `"${e.status}" (by ${e.author})` : `"${e.status}"`;
}

/**
 * Detect conflicting progress events for a task (collaboration-safe-state RFC,
 * B6). With the per-event ledger, two contributors/branches can produce events
 * that, once merged, form a sequence no single writer would: a second `started`
 * while already started, a `done` after `done`, a `blocked`/`started` after a
 * terminal `done`, etc. Folding each task's merged events through the lifecycle
 * state machine surfaces these as `PROGRESS_EVENT_CONFLICT` (warning) instead of
 * letting the reducer silently pick a last-writer winner.
 *
 * `deriveTaskState` is intentionally NOT made conflict-aware — it stays total;
 * this is the detection surface. One conflict is reported per task (the first),
 * to avoid cascading noise from a single divergence.
 *
 * D3 (Collaboration UX RFC) enriches each issue with a structured
 * `details.events[]` naming the conflicting side(s) — the event that established
 * the current state (when present) and the offending event; usually two, but one
 * when the very first event for a task is itself an invalid transition — so an
 * agent (and `code-pact status`) reads *who* collided without parsing the
 * message. Pure read-side enrichment: the same detection, same one-per-task rule,
 * same `warning` severity.
 */
export function detectProgressEventConflicts(
  events: readonly ProgressEvent[],
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const byTask = new Map<string, ProgressEvent[]>();
  for (const e of events) {
    const list = byTask.get(e.task_id);
    if (list) list.push(e);
    else byTask.set(e.task_id, [e]);
  }
  for (const [taskId, taskEvents] of byTask) {
    let current: TaskCurrentState = "planned";
    let prev: ProgressEvent | undefined;
    for (const e of taskEvents) {
      const next = e.status as TaskTransition;
      if (!isAcceptableTransition(current, next)) {
        // Name the conflicting side(s): the event that put the task into
        // `current` (when present) and the offending event. On the first-event
        // case (no prior accepted event) there is only the one side to name.
        const sides = prev !== undefined ? [prev, e] : [e];
        const who =
          prev !== undefined
            ? `${describeSide(prev)} → ${describeSide(e)}`
            : describeSide(e);
        issues.push({
          code: "PROGRESS_EVENT_CONFLICT",
          severity: "warning",
          message: `Task "${taskId}" has conflicting progress events: ${who} is not a valid lifecycle transition (incompatible or concurrent events from different sources). Inspect details.events[] and reconcile the corresponding progress event — its per-event ledger file, or the legacy .code-pact/state/progress.yaml entry.`,
          task_id: taskId,
          details: { events: sides.map(toConflictEventEntry) },
        });
        break;
      }
      current = next;
      prev = e;
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// P10 — Task Readiness Schema detectors
//
// Field-by-field validation for the optional fields declared in
// design/decisions/task-readiness-schema-rfc.md. All detectors are
// additive — existing v1.0.x tasks declare none of these fields and so
// produce no new issues. See docs/cli-contract.md § Plan diagnostic codes
// for the public surface. Path safety helpers live in
// `src/core/path-safety.ts` (promoted from the adapter layer in P10-T3
// so plan lint imports from a neutral module).
// ---------------------------------------------------------------------------

function safePathReason(path: string): string {
  try {
    assertSafeRelativePath(path);
    return "";
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return detail;
  }
}

/**
 * `depends_on` references a task id not present in any phase.
 *
 * v1.9 (P19-T2): same-phase lookup first; cross-phase lookup as
 * fallback. An id present in another phase is a valid cross-phase
 * dependency and is NOT reported here.
 */
export function detectTaskDependsOnUnresolved(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const globalTaskIds = new Set<string>();
  for (const { phase } of phases) {
    for (const task of phase.tasks ?? []) {
      globalTaskIds.add(task.id);
    }
  }
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const deps = task.depends_on ?? [];
      deps.forEach((dep, index) => {
        if (!globalTaskIds.has(dep)) {
          issues.push({
            code: "TASK_DEPENDS_ON_UNRESOLVED",
            severity: "error",
            message: `Task "${task.id}" depends_on references unknown task id "${dep}" (not in any phase)`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `depends_on[${index}]`,
            details: { value: dep },
          });
        }
      });
    }
  }
  return issues;
}

/**
 * `depends_on` includes the task's own id — a direct self-cycle.
 *
 * Multi-node cycles (A → B → A, A → B → C → A, etc.) are reported
 * separately by `detectTaskDependsOnCycle` (v1.9 P19-T2). Self-cycles
 * keep this dedicated diagnostic because it is narrower and points
 * directly at the offending line.
 */
export function detectTaskDependsOnSelfReference(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const deps = task.depends_on ?? [];
      deps.forEach((dep, index) => {
        if (dep === task.id) {
          issues.push({
            code: "TASK_DEPENDS_ON_SELF_REFERENCE",
            severity: "error",
            message: `Task "${task.id}" depends_on lists itself (direct self-cycle)`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `depends_on[${index}]`,
          });
        }
      });
    }
  }
  return issues;
}

/**
 * Multi-node depends_on cycles across the entire project graph.
 *
 * v1.9 P19-T2. Builds a directed graph (task id → its depends_on list)
 * over every task in every phase, then runs Tarjan's strongly connected
 * components algorithm iteratively (no recursion, safe for deep chains).
 *
 * Any SCC of size > 1 is a multi-node cycle. One PlanIssue is emitted
 * per task in the cycle, with `details.cycle` listing the cycle members
 * in SCC traversal order so a human reading the diagnostic can see the
 * shape at a glance.
 *
 * Self-cycles (size-1 SCCs whose only node has a self-edge) are
 * intentionally NOT reported here — they keep their dedicated
 * `TASK_DEPENDS_ON_SELF_REFERENCE` diagnostic, which is narrower and
 * already in the v1.0 surface.
 *
 * Severity matches `TASK_DEPENDS_ON_SELF_REFERENCE` (error) — both are
 * dep-graph integrity diagnostics; demoting only the multi-node case
 * would create an arbitrary cliff.
 */
export function detectTaskDependsOnCycle(phases: PhaseEntry[]): PlanIssue[] {
  // Build the global task index + dep adjacency.
  const taskLocation = new Map<string, { phase: PhaseEntry["phase"]; ref: PhaseEntry["ref"] }>();
  const adjacency = new Map<string, string[]>();
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      if (!taskLocation.has(task.id)) {
        taskLocation.set(task.id, { phase, ref });
      }
      // Drop self-loops here — they are reported by SELF_REFERENCE.
      const deps = (task.depends_on ?? []).filter((d) => d !== task.id);
      adjacency.set(task.id, deps);
    }
  }

  // Iterative Tarjan's SCC.
  const sccs = tarjanScc(Array.from(adjacency.keys()), adjacency);

  const issues: PlanIssue[] = [];
  for (const scc of sccs) {
    if (scc.length < 2) continue;
    // Every member of an SCC of size > 1 participates in a cycle.
    const cycleDescription = scc.join(" → ") + " → " + scc[0];
    for (const taskId of scc) {
      const loc = taskLocation.get(taskId);
      if (!loc) continue;
      issues.push({
        code: "TASK_DEPENDS_ON_CYCLE",
        severity: "error",
        message: `Task "${taskId}" participates in a depends_on cycle: ${cycleDescription}`,
        file: loc.ref.path,
        phase_id: loc.phase.id,
        task_id: taskId,
        details: { cycle: [...scc] },
      });
    }
  }
  return issues;
}

/**
 * Iterative Tarjan's SCC. Returns SCCs in reverse topological order;
 * the order is deterministic given a sorted node list.
 */
function tarjanScc(
  nodes: string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const sortedNodes = [...nodes].sort();
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let index = 0;
  const sccs: string[][] = [];

  type Frame = { node: string; iter: number };
  for (const start of sortedNodes) {
    if (indexOf.has(start)) continue;

    const frames: Frame[] = [{ node: start, iter: 0 }];
    indexOf.set(start, index);
    lowlink.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const neighbours = adjacency.get(frame.node) ?? [];
      if (frame.iter < neighbours.length) {
        const next = neighbours[frame.iter]!;
        frame.iter++;
        if (!indexOf.has(next)) {
          // Skip nodes we have no record of (unresolved deps are not
          // part of the graph for cycle purposes).
          if (!adjacency.has(next)) continue;
          indexOf.set(next, index);
          lowlink.set(next, index);
          index++;
          stack.push(next);
          onStack.add(next);
          frames.push({ node: next, iter: 0 });
        } else if (onStack.has(next)) {
          lowlink.set(
            frame.node,
            Math.min(lowlink.get(frame.node)!, indexOf.get(next)!),
          );
        }
      } else {
        if (lowlink.get(frame.node) === indexOf.get(frame.node)) {
          const scc: string[] = [];
          while (stack.length > 0) {
            const popped = stack.pop()!;
            onStack.delete(popped);
            scc.push(popped);
            if (popped === frame.node) break;
          }
          // Normalise ordering: rotate so the lexicographically smallest
          // id sits first. Keeps test fixtures deterministic regardless
          // of traversal order.
          if (scc.length > 1) {
            const reversed = scc.reverse();
            let minIdx = 0;
            for (let i = 1; i < reversed.length; i++) {
              if (reversed[i]! < reversed[minIdx]!) minIdx = i;
            }
            sccs.push([...reversed.slice(minIdx), ...reversed.slice(0, minIdx)]);
          } else {
            sccs.push(scc);
          }
        }
        frames.pop();
        if (frames.length > 0) {
          const parent = frames[frames.length - 1]!;
          lowlink.set(
            parent.node,
            Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!),
          );
        }
      }
    }
  }
  return sccs;
}

/** `decision_refs` path is not a safe repo-root-relative POSIX path. */
export function detectTaskDecisionRefUnsafePath(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const refs = task.decision_refs ?? [];
      refs.forEach((p, index) => {
        const reason = safePathReason(p);
        if (reason !== "") {
          issues.push({
            code: "TASK_DECISION_REF_UNSAFE_PATH",
            severity: "error",
            message: `Task "${task.id}" decision_refs path "${p}" is not a safe repo-root-relative path: ${reason}`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `decision_refs[${index}]`,
            details: { value: p, reason },
          });
        }
      });
    }
  }
  return issues;
}

/** `decision_refs` path does not exist on disk. */
export async function detectTaskDecisionRefNotFound(
  cwd: string,
  phases: PhaseEntry[],
): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const refs = task.decision_refs ?? [];
      for (let index = 0; index < refs.length; index++) {
        const p = refs[index]!;
        // Don't double-report — path safety failures are surfaced by the
        // dedicated detector and would also fail this access check for
        // the wrong reason.
        if (safePathReason(p) !== "") continue;
        if (!(await fileExists(join(cwd, p)))) {
          issues.push({
            code: "TASK_DECISION_REF_NOT_FOUND",
            severity: "error",
            message: `Task "${task.id}" decision_refs path "${p}" does not exist on disk`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `decision_refs[${index}]`,
            details: { value: p },
          });
        }
      }
    }
  }
  return issues;
}

/** `reads` glob is not a safe repo-root-relative POSIX path. */
export function detectTaskReadsUnsafePath(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const globs = task.reads ?? [];
      globs.forEach((g, index) => {
        const reason = safePathReason(g);
        if (reason !== "") {
          issues.push({
            code: "TASK_READS_UNSAFE_PATH",
            severity: "error",
            message: `Task "${task.id}" reads glob "${g}" is not a safe repo-root-relative path: ${reason}`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `reads[${index}]`,
            details: { value: g, reason },
          });
        }
      });
    }
  }
  return issues;
}

/** `reads` glob uses syntax outside the P10 supported subset. */
export function detectTaskReadsGlobInvalid(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const globs = task.reads ?? [];
      globs.forEach((g, index) => {
        if (safePathReason(g) !== "") return;
        const reason = validateGlobSyntax(g);
        if (reason !== null) {
          issues.push({
            code: "TASK_READS_GLOB_INVALID",
            severity: "error",
            message: `Task "${task.id}" reads glob "${g}" uses unsupported syntax: ${reason}`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `reads[${index}]`,
            details: { value: g, reason },
          });
        }
      });
    }
  }
  return issues;
}

/** `reads` glob matches zero files on disk (warning — possibly a typo). */
export async function detectTaskReadsNoMatch(
  cwd: string,
  phases: PhaseEntry[],
): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const globs = task.reads ?? [];
      for (let index = 0; index < globs.length; index++) {
        const g = globs[index]!;
        // Skip entries that another detector already flagged.
        if (safePathReason(g) !== "") continue;
        if (validateGlobSyntax(g) !== null) continue;
        const matched = await walkAndMatch(cwd, g);
        if (matched.length === 0) {
          issues.push({
            code: "TASK_READS_NO_MATCH",
            severity: "warning",
            message: `Task "${task.id}" reads glob "${g}" matches zero files on disk — if the file moved, redirect it with \`code-pact plan sync-paths --rename "${g}=<new-path>" --write\`; if it is gone, drop the entry`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `reads[${index}]`,
            details: { value: g },
          });
        }
      }
    }
  }
  return issues;
}

/** `writes` glob is not a safe repo-root-relative POSIX path. */
export function detectTaskWritesUnsafePath(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const globs = task.writes ?? [];
      globs.forEach((g, index) => {
        const reason = safePathReason(g);
        if (reason !== "") {
          issues.push({
            code: "TASK_WRITES_UNSAFE_PATH",
            severity: "error",
            message: `Task "${task.id}" writes glob "${g}" is not a safe repo-root-relative path: ${reason}`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `writes[${index}]`,
            details: { value: g, reason },
          });
        }
      });
    }
  }
  return issues;
}

/** `writes` glob uses syntax outside the P10 supported subset. */
export function detectTaskWritesGlobInvalid(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const globs = task.writes ?? [];
      globs.forEach((g, index) => {
        if (safePathReason(g) !== "") return;
        const reason = validateGlobSyntax(g);
        if (reason !== null) {
          issues.push({
            code: "TASK_WRITES_GLOB_INVALID",
            severity: "error",
            message: `Task "${task.id}" writes glob "${g}" uses unsupported syntax: ${reason}`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `writes[${index}]`,
            details: { value: g, reason },
          });
        }
      });
    }
  }
  return issues;
}

/**
 * `writes` glob covers a protected path. P10 advisory warning. The
 * protected-paths list is loaded from `design/rules/protected-paths.md`
 * via `loadProtectedPaths` (v1.6 P15-T3); when the rule file is absent
 * the hardcoded `PROTECTED_PATHS` constant in `src/core/glob.ts` is
 * the fallback.
 *
 * Accepts an optional `protectedPaths` parameter for callers that have
 * already loaded the list (lint orchestrator does this once per run);
 * omitting it falls back to the hardcoded defaults so this function
 * remains usable in isolation (tests, ad-hoc scripts, future REPL).
 */
export function detectTaskWritesProtectedPath(
  phases: PhaseEntry[],
  protectedPaths?: readonly ProtectedPathEntry[],
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const globs = task.writes ?? [];
      globs.forEach((g, index) => {
        // Don't double-report on already-broken patterns.
        if (safePathReason(g) !== "") return;
        if (validateGlobSyntax(g) !== null) return;
        const overlaps = findProtectedPathOverlaps(g, protectedPaths);
        for (const entry of overlaps) {
          issues.push({
            code: "TASK_WRITES_PROTECTED_PATH",
            severity: "warning",
            message: `Task "${task.id}" writes glob "${g}" covers a protected path (matches "${entry.pattern}")`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `writes[${index}]`,
            details: { value: g, protected_pattern: entry.pattern },
          });
        }
      });
    }
  }
  return issues;
}

// `writes` glob is too coarse — its root path segment is the doublestar
// (`**`), meaning the glob matches the entire repository (or huge
// swaths of it). v1.6 P15-T2.
//
// Examples that trip this check (root segment is doublestar):
//   - just `**`
//   - `**` then `/` then `*`
//   - `**` then `/` then `*.ts`
//   - `**` then `/` then a literal filename
//
// Legitimate task-scoped globs have a concrete root segment and pass
// unchanged: `src/core/audit/**`, `src/**/*.ts`, `tests/unit/**`,
// `docs/cli-contract.md`, etc.
//
// Heuristic-only — the goal is to catch obvious "writes everywhere"
// declarations during plan lint, not to encode a precise breadth
// metric. Severity: warning, advisory. Under `plan lint --strict` the
// existing binary promotion makes it exit-relevant (same posture as
// `TASK_WRITES_PROTECTED_PATH`).
export function detectTaskWritesOverBroad(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const globs = task.writes ?? [];
      globs.forEach((g, index) => {
        // Don't double-report on already-broken patterns.
        if (safePathReason(g) !== "") return;
        if (validateGlobSyntax(g) !== null) return;
        if (!isOverBroadGlob(g)) return;
        issues.push({
          code: "TASK_WRITES_OVER_BROAD",
          severity: "warning",
          message: `Task "${task.id}" writes glob "${g}" is too broad — its root segment is "**", which matches the entire repository. Narrow it to a concrete root (e.g. "src/...", "tests/...", "docs/...") that reflects the task's actual write surface.`,
          file: ref.path,
          phase_id: phase.id,
          task_id: task.id,
          path: `writes[${index}]`,
          details: { value: g },
        });
      });
    }
  }
  return issues;
}

function isOverBroadGlob(g: string): boolean {
  const segments = g.split("/");
  return segments[0] === "**";
}

/** `acceptance_refs` path is not a safe repo-root-relative POSIX path. */
export function detectTaskAcceptanceRefUnsafePath(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const refs = task.acceptance_refs ?? [];
      refs.forEach((p, index) => {
        const reason = safePathReason(p);
        if (reason !== "") {
          issues.push({
            code: "TASK_ACCEPTANCE_REF_UNSAFE_PATH",
            severity: "error",
            message: `Task "${task.id}" acceptance_refs path "${p}" is not a safe repo-root-relative path: ${reason}`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `acceptance_refs[${index}]`,
            details: { value: p, reason },
          });
        }
      });
    }
  }
  return issues;
}

/** `acceptance_refs` path does not exist on disk. */
export async function detectTaskAcceptanceRefNotFound(
  cwd: string,
  phases: PhaseEntry[],
): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const refs = task.acceptance_refs ?? [];
      for (let index = 0; index < refs.length; index++) {
        const p = refs[index]!;
        if (safePathReason(p) !== "") continue;
        if (!(await fileExists(join(cwd, p)))) {
          issues.push({
            code: "TASK_ACCEPTANCE_REF_NOT_FOUND",
            severity: "error",
            message: `Task "${task.id}" acceptance_refs path "${p}" does not exist on disk`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `acceptance_refs[${index}]`,
            details: { value: p },
          });
        }
      }
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
