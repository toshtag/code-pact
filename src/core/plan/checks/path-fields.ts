import type { PhaseEntry } from "../state.ts";
import type { PlanIssue } from "../shared.ts";
import { assertSafeRelativePath } from "../../path-safety.ts";
import {
  findProtectedPathOverlaps,
  type ProtectedPathEntry,
  validateGlobSyntax,
  matchGlob,
} from "../../glob.ts";
import { listTrackedProjectFiles } from "../../project-files/tracked-files.ts";
import { projectPathPresence } from "./fs.ts";
import { decisionRefPathReason } from "../../schemas/decision-ref.ts";
import { readPrunedLedger, normalizeRelPath } from "../../decisions/pruned-ledger.ts";
import {
  decisionRecordSoftensMissingRef,
  resolveRetiredDecisionGate,
} from "../../decisions/decision-gate-archive.ts";

// ---------------------------------------------------------------------------
// Task Readiness Schema detectors
//
// Field-by-field validation for the optional task-readiness fields. All
// detectors are additive — a task that declares none of these fields
// produces no new issues. See docs/cli-contract.md § Plan diagnostic codes
// for the public surface. Path safety helpers live in
// `src/core/path-safety.ts` so plan lint imports from a neutral module.
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
 * A decision whose gate is no longer live: the referencing *task* is `done`.
 * The gate passed at `task complete`, so the `decision_refs` / `acceptance_refs`
 * target is now a *historical annotation*, not a live requirement — a missing
 * target downgrades from `error` to an advisory `warning` rather than failing
 * the plan. Mirrors the soft `reads` no-match story; lets a shipped decision
 * record be retired without breaking integrity.
 *
 * Keyed on the TASK's own status ONLY — never the phase's. A `done` phase that
 * still holds a `planned` / `in_progress` task is an inconsistent state
 * (`PHASE_DONE_WITH_OPEN_TASKS`), and that open task's gate is still live; the
 * phase status must not loosen it. `cancelled` is intentionally NOT treated as
 * terminal here — whether an abandoned task's ref is historical is a separate
 * decision the RFC has not yet made.
 * See design/decisions/decision-lifecycle-rfc.md.
 */
function refIsHistorical(task: { status?: string }): boolean {
  return task.status === "done";
}

/**
 * The advisory (`affects_exit:false`) variant of `TASK_DECISION_REF_NOT_FOUND`.
 * `kind: "done"` — a completed task's ref is a historical annotation.
 * `kind: "retired"` — an ACTIVE task whose missing ref is released by an accepted
 * `.code-pact/state` decision-state record (step 5).
 */
function decisionRefAdvisory(
  taskId: string,
  p: string,
  file: string,
  phaseId: string,
  index: number,
  kind: "done" | "retired",
): PlanIssue {
  return {
    code: "TASK_DECISION_REF_NOT_FOUND",
    severity: "warning",
    affects_exit: false,
    message:
      kind === "done"
        ? `Task "${taskId}" is done; its decision_refs path "${p}" is no longer on disk — advisory only. The task has already completed, so the ref is now a historical annotation, not a live file requirement. Restore the file if this was accidental, or drop the ref if the decision was intentionally retired and you no longer need it.`
        : `Task "${taskId}" decision_refs path "${p}" is no longer on disk, but a retired decision-state record in .code-pact/state releases its gate (accepted) — advisory only. Restore the decision file if this was accidental, or keep relying on the recorded outcome.`,
    file,
    phase_id: phaseId,
    task_id: taskId,
    path: `decision_refs[${index}]`,
    details: { value: p, ...(kind === "done" ? { historical: true } : { retired_decision: true }) },
  };
}

/**
 * `decision_refs` path violates the decision namespace contract (not a safe
 * repo-relative path, OR outside `design/decisions/**\/*.md`, OR README/PRUNED).
 *
 * The Task/phase-import schemas hard-fail these at parse time, so a normally
 * loaded plan never reaches lint with a bad ref. This detector is the lint-layer
 * of the multi-layer defense: it still produces a precise, exit-affecting
 * diagnostic for any path that reaches lint by another route (a raw-YAML lint
 * surface, a plan written before the schema tightened). Uses the SAME
 * `decisionRefPathReason` as the schema so the verdict can never drift.
 */
export function detectTaskDecisionRefUnsafePath(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const refs = task.decision_refs ?? [];
      refs.forEach((p, index) => {
        const reason = decisionRefPathReason(p);
        if (reason !== "") {
          issues.push({
            code: "TASK_DECISION_REF_UNSAFE_PATH",
            severity: "error",
            message: `Task "${task.id}" decision_refs path "${p}" is not a valid decision reference (a .md record under design/decisions/): ${reason}`,
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
  const pruned = await readPrunedLedger(cwd);
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const refs = task.decision_refs ?? [];
      for (let index = 0; index < refs.length; index++) {
        const p = refs[index]!;
        // Don't double-report — path safety failures are surfaced by the
        // dedicated detector and would also fail this access check for
        // the wrong reason.
        if (safePathReason(p) !== "") continue;
        // design-docs-ephemeral (step 5): use the THREE-WAY presence — record
        // consultation is gated on a TRUE absence (ENOENT), never on the old
        // `fileExists` boolean (which collapses any access failure to "missing"
        // and would re-open the live-wins-inaccessible hole). `present` → no issue;
        // `inaccessible` keeps the existing severity, never record-softened.
        const presence = await projectPathPresence(cwd, p);
        if (presence === "present") continue;
        const historical = refIsHistorical(task);
        if (presence === "absent") {
          // A done task's retired ref is silent when recorded (PRUNED row OR a valid
          // decision-state record of ANY status — both prove intentional retirement);
          // otherwise it is an advisory (the existing done baseline — never an error).
          if (historical) {
            if (pruned.has(normalizeRelPath(p))) continue;
            if (await decisionRecordSoftensMissingRef(cwd, p)) continue;
          } else {
            // An ACTIVE task's gate is still live: it softens ONLY when the gate
            // would RELEASE (a valid ACCEPTED record) — tracking the gate exactly,
            // so A3-positive (rm -rf design/decisions + all gates recorded accepted)
            // is green under `plan lint --strict`. A blocked / no / invalid record
            // leaves it a hard error, matching the live gate's fail-closed verdict.
            if ((await resolveRetiredDecisionGate(cwd, p)).kind === "released") {
              issues.push(decisionRefAdvisory(task.id, p, ref.path, phase.id, index, "retired"));
              continue;
            }
          }
        }
        // `inaccessible`, or `absent` not softened above → the existing severity.
        issues.push(
          historical
            ? decisionRefAdvisory(task.id, p, ref.path, phase.id, index, "done")
            : {
                code: "TASK_DECISION_REF_NOT_FOUND",
                severity: "error",
                message: `Task "${task.id}" decision_refs path "${p}" does not exist on disk`,
                file: ref.path,
                phase_id: phase.id,
                task_id: task.id,
                path: `decision_refs[${index}]`,
                details: { value: p },
              },
        );
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

/** `reads` glob uses syntax outside the supported subset. */
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
  let tracked: string[] | null = null;
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const globs = task.reads ?? [];
      for (let index = 0; index < globs.length; index++) {
        const g = globs[index]!;
        // Skip entries that another detector already flagged.
        if (safePathReason(g) !== "") continue;
        if (validateGlobSyntax(g) !== null) continue;
        if (tracked === null) {
          try {
            tracked = await listTrackedProjectFiles(cwd);
          } catch {
            issues.push({
              code: "TASK_READS_UNAVAILABLE",
              severity: "error",
              message:
                "Task reads globs require a readable Git tracked-file index; untracked filesystem walks are not allowed.",
              file: ref.path,
              phase_id: phase.id,
              task_id: task.id,
              path: `reads[${index}]`,
              details: { value: g },
            });
            continue;
          }
        }
        const matched = tracked.filter(path => matchGlob(g, path));
        if (matched.length === 0) {
          issues.push({
            code: "TASK_READS_NO_MATCH",
            severity: "warning",
            message: `Task "${task.id}" reads glob "${g}" matches zero tracked files — if the file moved, redirect it with \`code-pact plan sync-paths --rename "${g}=<new-path>" --write\`; if it is gone, drop the entry`,
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

/** `writes` glob uses syntax outside the supported subset. */
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
 * `writes` glob covers a protected path. Advisory warning. The
 * protected-paths list is loaded from `design/rules/protected-paths.md`
 * via `loadProtectedPaths`; when the rule file is absent
 * the hardcoded `PROTECTED_PATHS` constant in `src/core/glob.ts` is
 * the fallback.
 *
 * Completed tasks keep the warning visible, but mark it non-exit-relevant:
 * at that point the declaration is historical evidence for write audit, not a
 * live plan risk that release strictness can still fix.
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
            ...(task.status === "done" ? { affects_exit: false } : {}),
          });
        }
      });
    }
  }
  return issues;
}

// `writes` glob is too coarse — its root path segment is the doublestar
// (`**`), meaning the glob matches the entire repository (or huge
// swaths of it).
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
  // PRUNED.md is the tombstone for *decision* records and does NOT soften
  // acceptance_refs (which routinely point at docs / phase YAML). A DONE task's
  // missing acceptance_ref stays a PR-A advisory for ANY target (unchanged).
  // design-docs-ephemeral (step 5): a NOT-DONE task's missing acceptance_ref softens
  // to advisory ONLY when the target is a `.md` decision record under `design/decisions/` backed by
  // a VALID record of ANY status (predicate B) — acceptance_refs is a
  // reference-integrity annotation, not a gate release, so a blocked record still
  // proves intentional archival. A non-decision target (`docs/...`) never softens.
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const refs = task.acceptance_refs ?? [];
      for (let index = 0; index < refs.length; index++) {
        const p = refs[index]!;
        if (safePathReason(p) !== "") continue;
        // Three-way presence (step 5): record consultation is gated on a TRUE absence
        // (ENOENT). `present` → no issue; `inaccessible` keeps the existing severity
        // and never consults a record (never the old `fileExists` boolean).
        const presence = await projectPathPresence(cwd, p);
        if (presence === "present") continue;
        const historical = refIsHistorical(task);
        // Done task → advisory for ANY target (existing baseline, unchanged).
        // Active task + absent + a valid decision-state record (predicate B) → advisory.
        const softened =
          historical ||
          (presence === "absent" && (await decisionRecordSoftensMissingRef(cwd, p)));
        issues.push({
          code: "TASK_ACCEPTANCE_REF_NOT_FOUND",
          severity: softened ? "warning" : "error",
          ...(softened ? { affects_exit: false } : {}),
          message: softened
            ? historical
              ? `Task "${task.id}" is done; its acceptance_refs path "${p}" is no longer on disk — advisory only. The task has already completed, so the ref is now a historical annotation, not a live file requirement. Restore the file if this was accidental, or drop the ref if it was intentionally removed.`
              : `Task "${task.id}" acceptance_refs path "${p}" is no longer on disk, but it is a retired design decision recorded in .code-pact/state — advisory only.`
            : `Task "${task.id}" acceptance_refs path "${p}" does not exist on disk`,
          file: ref.path,
          phase_id: phase.id,
          task_id: task.id,
          path: `acceptance_refs[${index}]`,
          details: {
            value: p,
            ...(historical
              ? { historical: true }
              : softened
                ? { retired_decision: true }
                : {}),
          },
        });
      }
    }
  }
  return issues;
}
