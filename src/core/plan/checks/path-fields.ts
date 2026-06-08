import { join } from "node:path";
import type { PhaseEntry } from "../state.ts";
import type { PlanIssue } from "../shared.ts";
import { assertSafeRelativePath } from "../../path-safety.ts";
import {
  findProtectedPathOverlaps,
  type ProtectedPathEntry,
  validateGlobSyntax,
  walkAndMatch,
} from "../../glob.ts";
import { fileExists } from "./fs.ts";

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
          const historical = refIsHistorical(task);
          issues.push({
            code: "TASK_DECISION_REF_NOT_FOUND",
            severity: historical ? "warning" : "error",
            ...(historical ? { affects_exit: false } : {}),
            message: historical
              ? `Task "${task.id}" is done; its decision_refs path "${p}" is no longer on disk — advisory only (the decision gate already passed). Restore the file if this was accidental; if the decision was intentionally retired, leave the ref as a historical annotation or drop it if you no longer need it.`
              : `Task "${task.id}" decision_refs path "${p}" does not exist on disk`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `decision_refs[${index}]`,
            details: { value: p, ...(historical ? { historical: true } : {}) },
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
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const refs = task.acceptance_refs ?? [];
      for (let index = 0; index < refs.length; index++) {
        const p = refs[index]!;
        if (safePathReason(p) !== "") continue;
        if (!(await fileExists(join(cwd, p)))) {
          const historical = refIsHistorical(task);
          issues.push({
            code: "TASK_ACCEPTANCE_REF_NOT_FOUND",
            severity: historical ? "warning" : "error",
            ...(historical ? { affects_exit: false } : {}),
            message: historical
              ? `Task "${task.id}" is done; its acceptance_refs path "${p}" is no longer on disk — advisory only. Restore the file if this was accidental; if it was intentionally removed, leave or drop the stale ref as you prefer.`
              : `Task "${task.id}" acceptance_refs path "${p}" does not exist on disk`,
            file: ref.path,
            phase_id: phase.id,
            task_id: task.id,
            path: `acceptance_refs[${index}]`,
            details: { value: p, ...(historical ? { historical: true } : {}) },
          });
        }
      }
    }
  }
  return issues;
}
