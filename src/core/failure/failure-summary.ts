/**
 * Failure clarity (P32): turn a verify/finalize failure into a compact,
 * agent-readable summary — which check failed, why, and the command to rerun
 * *after fixing* it.
 *
 * This module is pure and has no dependency on `src/commands/`. It accepts a
 * structural {@link FailureCheckLike} rather than importing `CheckResult` from
 * `src/commands/verify.ts`, so `core` never depends on `commands` (a verify
 * `CheckResult` is structurally assignable and is passed in from the CLI
 * layer). `suggested_next_command` is produced by a deterministic finite
 * switch — never free-form text.
 */

/** Structural shape of a verify check. A verify `CheckResult` satisfies this. */
export type FailureCheckLike = { name: string; ok: boolean; reason?: string };

export type FailureSummary = {
  /** Names of every failing check, in the order verify produced them. */
  failed_checks: string[];
  /** The first failing check, or `null` when nothing failed. */
  first_failure: { name: string; reason: string } | null;
  /**
   * The command to rerun *after fixing* {@link first_failure}. It does NOT
   * imply that rerunning unchanged will resolve the failure. `null` when there
   * is no deterministic next command.
   */
  suggested_next_command: string | null;
};

/**
 * `task finalize` failure codes that map to a synthesized pseudo-check.
 * (finalize never produces verify `CheckResult`s.)
 */
export type FinalizeFailureCode =
  | "TASK_FINALIZE_NOT_ELIGIBLE"
  | "TASK_FINALIZE_WRITE_REFUSED"
  | "WRITES_AUDIT_STRICT_FAILED";

/** Deterministic next-command for a failing verify check. */
function suggestedNextCommandForCheck(name: string, taskId: string): string | null {
  switch (name) {
    case "commands":
    case "decision":
    case "progress_event":
      return `code-pact task complete ${taskId}`;
    case "task_status":
      // A `done` event exists but the design YAML status lags — finalize fixes it.
      return `code-pact task finalize ${taskId} --write`;
    default:
      return null;
  }
}

/** Deterministic next-command for a finalize failure code. */
function suggestedNextCommandForFinalizeCode(
  code: FinalizeFailureCode,
  taskId: string,
): string | null {
  switch (code) {
    case "TASK_FINALIZE_NOT_ELIGIBLE":
      // Not yet `done` — record the done event first, then finalize again.
      return `code-pact task complete ${taskId}`;
    case "TASK_FINALIZE_WRITE_REFUSED":
    case "WRITES_AUDIT_STRICT_FAILED":
      // Both need a human edit (fix the path / declared writes); no rerun
      // command resolves them deterministically.
      return null;
    default:
      return null;
  }
}

/** Synthesized pseudo-check name for a finalize failure code. */
function finalizeCheckName(code: FinalizeFailureCode): string {
  switch (code) {
    case "TASK_FINALIZE_NOT_ELIGIBLE":
      return "eligibility";
    case "TASK_FINALIZE_WRITE_REFUSED":
      return "write_safety";
    case "WRITES_AUDIT_STRICT_FAILED":
      return "write_audit";
    default:
      return "finalize";
  }
}

/**
 * Builds a {@link FailureSummary} from a verify check list. The first failing
 * check (in verify's order) becomes `first_failure`.
 */
export function buildFailureSummaryFromChecks(
  checks: FailureCheckLike[],
  taskId: string,
): FailureSummary {
  const failed = checks.filter((c) => !c.ok);
  const first = failed[0] ?? null;
  return {
    failed_checks: failed.map((c) => c.name),
    first_failure: first ? { name: first.name, reason: first.reason ?? "" } : null,
    suggested_next_command: first
      ? suggestedNextCommandForCheck(first.name, taskId)
      : null,
  };
}

/**
 * Builds a {@link FailureSummary} for a `task finalize` failure, which has no
 * verify checks — a single pseudo-check is synthesized from the failure code.
 * `reason` is the thrown error's message (the full structured detail stays in
 * the envelope's existing fields, e.g. `data.write_audit`).
 */
export function buildFailureSummaryFromFinalizeCode(
  code: FinalizeFailureCode,
  taskId: string,
  reason: string,
): FailureSummary {
  const name = finalizeCheckName(code);
  return {
    failed_checks: [name],
    first_failure: { name, reason },
    suggested_next_command: suggestedNextCommandForFinalizeCode(code, taskId),
  };
}
