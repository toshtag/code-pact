export type IssueSeverity = "error" | "warning";

/**
 * Common shape for issues surfaced by plan lint / plan analyze and the
 * shared detectors in checks.ts. Optional metadata fields let analyze
 * report drift kinds and historical visibility without forking the type.
 *
 * Default semantics when fields are omitted:
 *   - hidden_by_default → false (issue appears in default output)
 *   - affects_exit      → true  (issue counts toward exit code)
 *
 * `details` carries structured extras such as STATUS_DRIFT kind so we
 * avoid an explosion of error codes for closely related drifts.
 */
export type PlanIssue = {
  code: string;
  severity: IssueSeverity;
  message: string;
  file?: string;
  path?: string;
  phase_id?: string;
  task_id?: string;
  details?: Record<string, unknown>;
  hidden_by_default?: boolean;
  affects_exit?: boolean;
};

/** Issues produced while loading plan artifacts in lenient mode. */
export type FileIssue = PlanIssue;

/** True when the issue should change the command's exit code. */
export function isExitRelevant(issue: PlanIssue): boolean {
  return issue.affects_exit !== false;
}

/** True when the issue should be hidden from default output. */
export function isHiddenByDefault(issue: PlanIssue): boolean {
  return issue.hidden_by_default === true;
}
