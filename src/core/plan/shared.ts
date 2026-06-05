export type IssueSeverity = "error" | "warning";

/**
 * Structured recovery guidance for an issue (additive). Mirrors the doctor
 * `DoctorIssueRecovery` shape so a plan issue's recovery threads through
 * `planIssueToDoctor` into the doctor surface unchanged. Lets an agent pick the
 * next action from JSON without parsing the prose `message`. Populated on the
 * collaboration conflict diagnostics (DUPLICATE_PHASE_ID / DUPLICATE_TASK_ID /
 * PHASE_ID_MISMATCH); omitted elsewhere — consumers reading only
 * `code` / `severity` / `message` are unaffected.
 *
 * `primary` is a runnable command; when the fix is a manual edit with no single
 * command (renaming a colliding id), set `manual_action` (the instruction —
 * **not** a shell command) + `confirm` (a runnable verify command) instead, so
 * `primary` stays strictly executable. Same convention as `DoctorIssueRecovery`.
 */
export type PlanIssueRecovery = {
  /** A runnable command (template; `<…>` placeholders are agent-supplied). */
  primary?: string;
  /** A manual fix instruction (not a shell command). Set INSTEAD of `primary`. */
  manual_action?: string;
  /** A runnable command that verifies the fix worked. */
  confirm?: string;
  /** Equally-valid alternatives, if any (e.g. an inspect command). */
  alternatives?: string[];
  /** How to confirm / where to read more: a command or docs pointer. */
  reference?: string;
};

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
  /** Structured recovery guidance (additive). See PlanIssueRecovery. */
  recovery?: PlanIssueRecovery;
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
