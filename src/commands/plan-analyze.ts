import { runAnalyze, type AnalyzeOptions } from "../core/plan/analyze.ts";
import {
  isExitRelevant,
  isHiddenByDefault,
  type PlanIssue,
} from "../core/plan/shared.ts";

export type PlanAnalyzeOptions = AnalyzeOptions & {
  /** Promote warnings to exit-relevant. Mirrors validate --strict. */
  strict?: boolean;
  /** Show issues normally hidden (today: STATUS_DRIFT done-historical). */
  includeHistorical?: boolean;
};

export type PlanAnalyzeResult = {
  ok: boolean;
  errors: number;
  warnings: number;
  hidden: number;
  /** Issues filtered for default rendering. Excludes hidden_by_default unless includeHistorical. */
  issues: PlanIssue[];
  /** Every issue analyze produced, before filtering. Useful for --json consumers. */
  rawIssues: PlanIssue[];
  taskCount: number;
  phaseCount: number;
  strict: boolean;
  includeHistorical: boolean;
};

export async function runPlanAnalyze(
  opts: PlanAnalyzeOptions,
): Promise<PlanAnalyzeResult> {
  const strict = opts.strict === true;
  const includeHistorical = opts.includeHistorical === true;

  const { state, issues: raw } = await runAnalyze({ cwd: opts.cwd });

  const phaseCount = state.phases.length;
  const taskCount = state.phases.reduce(
    (acc, e) => acc + (e.phase.tasks?.length ?? 0),
    0,
  );

  // Default rendering hides issues flagged hidden_by_default unless
  // the caller explicitly opts in. --strict does NOT flip hidden_by_default;
  // it only changes whether warnings affect the exit code.
  const visible = includeHistorical
    ? raw
    : raw.filter((i) => !isHiddenByDefault(i));

  const exitRelevant = visible.filter(isExitRelevant);
  const errors = exitRelevant.filter((i) => i.severity === "error").length;
  const warnings = exitRelevant.filter((i) => i.severity === "warning").length;
  const hidden = raw.length - visible.length;

  const ok = strict ? errors + warnings === 0 : errors === 0;

  return {
    ok,
    errors,
    warnings,
    hidden,
    issues: visible,
    rawIssues: raw,
    taskCount,
    phaseCount,
    strict,
    includeHistorical,
  };
}

export function serializePlanAnalyzeData(
  result: PlanAnalyzeResult,
): Record<string, unknown> {
  return {
    summary: {
      phases: result.phaseCount,
      tasks: result.taskCount,
      errors: result.errors,
      warnings: result.warnings,
      hidden: result.hidden,
    },
    strict: result.strict,
    include_historical: result.includeHistorical,
    issues: result.issues.map(serializeIssue),
  };
}

function serializeIssue(i: PlanIssue): Record<string, unknown> {
  return {
    code: i.code,
    severity: i.severity,
    message: i.message,
    ...(i.file !== undefined ? { file: i.file } : {}),
    ...(i.phase_id !== undefined ? { phase_id: i.phase_id } : {}),
    ...(i.task_id !== undefined ? { task_id: i.task_id } : {}),
    ...(i.details !== undefined ? { details: i.details } : {}),
    ...(i.hidden_by_default ? { hidden_by_default: true } : {}),
    ...(i.affects_exit === false ? { affects_exit: false } : {}),
    ...(i.recovery !== undefined ? { recovery: i.recovery } : {}),
  };
}

export function summarizePlanAnalyze(result: PlanAnalyzeResult): string {
  const parts = [
    `${result.errors} error${result.errors === 1 ? "" : "s"}`,
    `${result.warnings} warning${result.warnings === 1 ? "" : "s"}`,
  ];
  if (result.hidden > 0) parts.push(`${result.hidden} hidden`);
  return parts.join(", ");
}

export function formatPlanAnalyzeHuman(result: PlanAnalyzeResult): string {
  if (result.issues.length === 0) {
    const hiddenHint =
      result.hidden > 0
        ? ` (${result.hidden} hidden — re-run with --include-historical to inspect)`
        : "";
    return `plan analyze: ${result.phaseCount} phases, ${result.taskCount} tasks, no drift${hiddenHint}.`;
  }
  const lines: string[] = [
    `plan analyze: ${summarizePlanAnalyze(result)} across ${result.phaseCount} phases / ${result.taskCount} tasks.`,
  ];
  for (const issue of result.issues) {
    const mark = issue.severity === "error" ? "[error]" : "[warn] ";
    const kind = issue.details?.["kind"];
    const detail = typeof kind === "string" ? ` (${kind})` : "";
    const where = issue.task_id ? ` ${issue.task_id}` : "";
    lines.push(`  ${mark} ${issue.code}${detail}${where} — ${issue.message}`);
  }
  return lines.join("\n");
}
