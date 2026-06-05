import { runLint, type LintOptions } from "../core/plan/lint.ts";
import {
  isExitRelevant,
  isHiddenByDefault,
  type PlanIssue,
} from "../core/plan/shared.ts";

export type PlanLintOptions = LintOptions & {
  /**
   * Promote warnings to exit-relevant. Mirrors validate --strict semantics.
   */
  strict?: boolean;
};

export type PlanLintResult = {
  /** True when no exit-relevant issues remain after applying --strict. */
  ok: boolean;
  errors: number;
  warnings: number;
  /**
   * Visible issues that never affect the exit code (`affects_exit: false`).
   * Counted separately from `warnings` so `--strict` semantics stay honest:
   * these stay advisory even under `--strict`.
   */
  advisories: number;
  /**
   * Every issue surfaced by the lenient loader plus the orchestrator,
   * regardless of hidden_by_default. Callers decide what to render.
   */
  issues: PlanIssue[];
  /** Roadmap-dependent checks that the lenient loader had to skip. */
  skippedChecks: string[];
  includeQuality: boolean;
  strict: boolean;
};

export async function runPlanLint(
  opts: PlanLintOptions,
): Promise<PlanLintResult> {
  const { issues, skippedChecks, includeQuality } = await runLint(opts);
  const strict = opts.strict === true;

  // Default output suppresses hidden_by_default issues. lint does not
  // emit any today, but the filter keeps the same contract shared with
  // analyze so future additions stay consistent.
  const visible = issues.filter((i) => !isHiddenByDefault(i));
  const exitRelevant = visible.filter(isExitRelevant);
  const errors = exitRelevant.filter((i) => i.severity === "error").length;
  const warnings = exitRelevant.filter((i) => i.severity === "warning").length;
  // Visible but non-exit-relevant (e.g. P31 clarify advisories). Disjoint
  // from errors/warnings, which only count exit-relevant issues.
  const advisories = visible.filter((i) => !isExitRelevant(i)).length;

  const ok = strict ? errors + warnings === 0 : errors === 0;

  return {
    ok,
    errors,
    warnings,
    advisories,
    issues: visible,
    skippedChecks,
    includeQuality,
    strict,
  };
}

/** Stable JSON payload for --json output. snake_case keys throughout. */
export function serializePlanLintData(
  result: PlanLintResult,
): Record<string, unknown> {
  return {
    errors: result.errors,
    warnings: result.warnings,
    advisories: result.advisories,
    include_quality: result.includeQuality,
    strict: result.strict,
    skipped_checks: result.skippedChecks,
    issues: result.issues.map((i) => ({
      code: i.code,
      severity: i.severity,
      message: i.message,
      ...(i.file !== undefined ? { file: i.file } : {}),
      ...(i.path !== undefined ? { path: i.path } : {}),
      ...(i.phase_id !== undefined ? { phase_id: i.phase_id } : {}),
      ...(i.task_id !== undefined ? { task_id: i.task_id } : {}),
      ...(i.details !== undefined ? { details: i.details } : {}),
      ...(i.affects_exit === false ? { affects_exit: false } : {}),
      ...(i.hidden_by_default === true ? { hidden_by_default: true } : {}),
      ...(i.recovery !== undefined ? { recovery: i.recovery } : {}),
    })),
  };
}

export function summarizePlanLint(result: PlanLintResult): string {
  const parts: string[] = [];
  parts.push(`${result.errors} error${result.errors === 1 ? "" : "s"}`);
  parts.push(
    `${result.warnings} warning${result.warnings === 1 ? "" : "s"}`,
  );
  if (result.advisories > 0) {
    parts.push(
      `${result.advisories} advisor${result.advisories === 1 ? "y" : "ies"}`,
    );
  }
  if (result.skippedChecks.length > 0) {
    parts.push(
      `${result.skippedChecks.length} skipped check${result.skippedChecks.length === 1 ? "" : "s"}`,
    );
  }
  return parts.join(", ");
}

export function formatPlanLintHuman(result: PlanLintResult): string {
  if (result.issues.length === 0 && result.skippedChecks.length === 0) {
    return "plan lint: no issues found.";
  }
  const lines: string[] = [`plan lint: ${summarizePlanLint(result)}`];
  for (const issue of result.issues) {
    const mark = isExitRelevant(issue)
      ? issue.severity === "error"
        ? "[error]"
        : "[warn] "
      : "[advisory]";
    const loc = issue.file !== undefined ? ` ${issue.file}` : "";
    const path = issue.path !== undefined ? `:${issue.path}` : "";
    lines.push(`  ${mark} ${issue.code}${loc}${path} — ${issue.message}`);
  }
  if (result.skippedChecks.length > 0) {
    lines.push(`  Skipped checks: ${result.skippedChecks.join(", ")}`);
  }
  return lines.join("\n");
}
