import { runDoctor, type DoctorIssue } from "./doctor.ts";

export type ValidateOptions = {
  cwd: string;
  /** When true, warnings also count as failures (exit 1). */
  strict?: boolean;
  /** Branch base ref for the CI branch-drift check. */
  baseRef?: string;
};

export type ValidateResult = {
  ok: boolean;
  issues: DoctorIssue[];
};

/**
 * CI-friendly validation entry point. Delegates to runDoctor() for all
 * checks, then collapses the result into a single ok/fail signal based
 * on whether any errors (or, in strict mode, any issues) were found.
 *
 * Kept separate from `doctor` so the two commands can diverge in the
 * future: doctor is user-facing and may grow fix suggestions; validate
 * stays pure and machine-readable.
 */
export async function runValidate(opts: ValidateOptions): Promise<ValidateResult> {
  const result = await runDoctor(
    opts.cwd,
    opts.baseRef !== undefined ? { baseRef: opts.baseRef } : {},
  );
  const ok = opts.strict
    ? result.issues.length === 0
    : result.issues.every((i) => i.severity !== "error");
  return { ok, issues: result.issues };
}
