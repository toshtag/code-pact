import type { FailureSummary } from "../../core/failure/failure-summary.ts";

/** i18n labels for the failure-summary lines (the `task.failure` block). */
export type FailureSummaryLabels = {
  cause: (name: string, reason: string) => string;
  otherChecks: (names: string[]) => string;
  rerunAfterFixing: (cmd: string) => string;
};

/**
 * Renders a {@link FailureSummary} as 0–3 human lines, intended for stderr
 * below the command's existing generic failure message. Shared by
 * `task complete` and `task finalize` so their human output stays consistent.
 *
 * Order: the first failure's cause, then the remaining failed checks (only
 * when more than one failed), then the rerun-after-fixing command.
 */
export function renderFailureSummaryLines(
  labels: FailureSummaryLabels,
  summary: FailureSummary,
): string[] {
  const lines: string[] = [];
  if (summary.first_failure) {
    lines.push(labels.cause(summary.first_failure.name, summary.first_failure.reason));
  }
  const others = summary.failed_checks.slice(1);
  if (others.length > 0) {
    lines.push(labels.otherChecks(others));
  }
  if (summary.suggested_next_command) {
    lines.push(labels.rerunAfterFixing(summary.suggested_next_command));
  }
  return lines;
}
