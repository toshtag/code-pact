import { z } from "zod";

// ---------------------------------------------------------------------------
// Plan identifier charset (task ids, phase ids, agent names).
//
// These identifiers flow into TWO untrusted-output surfaces at once:
//   1. Agent-facing command strings (e.g. `task prepare`'s `commands.*`,
//      `task/phase runbook` `next_steps[].command`, the P32 failure
//      `suggested_next_command`) that an agent may execute verbatim.
//   2. Filesystem path segments (`.context/<agent>/<task-id>.md`,
//      `design/decisions/<task-id>.md`, `agent-profiles/<agent>.yaml`).
//
// Constraining the charset at parse time is the single chokepoint that keeps
// every downstream command string shell-safe and every path segment
// traversal-safe — without per-emit quoting that can be forgotten at one site
// and silently regress. It also rejects accidental breakage (an id with a
// space breaks every emitted command) at the point of authoring, surfaced as
// a plan-validation error rather than a malformed command later.
//
// Mirrors the runtime allowlist in `assertSafeDecisionFilenameSegment`
// (core/decisions/scaffold.ts), which imports this same pattern.
//
// Allowed: an ASCII letter/digit first char, then letters, digits, ".", "_",
// "-". The leading char MUST be alphanumeric so an id can never look like a
// CLI option (`--json`, `-P1`) when interpolated into a generated command —
// otherwise an agent running e.g. `code-pact task complete --json` would have
// the id swallowed as a flag (argument confusion).
// Rejected: a leading "-" / "." / "_", spaces/tabs/newlines, slashes, shell
// metacharacters (; | & $ ` " ' etc.), and the path segments "." and "..".
// ---------------------------------------------------------------------------

export const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const PLAN_ID_MESSAGE =
  "identifier must start with a letter or digit and then match " +
  '[A-Za-z0-9._-]* — no leading "-"/"."/"_", spaces, slashes, or shell ' +
  'metacharacters (and it must not be "." or "..")';

export const PlanId = z
  .string()
  .min(1)
  .refine((s) => PLAN_ID_PATTERN.test(s), PLAN_ID_MESSAGE);

export type PlanId = z.infer<typeof PlanId>;

/**
 * True when `value` is a safe plan identifier (same rule as {@link PlanId}).
 * The pattern already excludes "." / ".." (they start with a non-alphanumeric).
 */
export function isSafePlanId(value: string): boolean {
  return PLAN_ID_PATTERN.test(value);
}

/**
 * Runtime guard for write/CLI entrypoints that build a filesystem path or an
 * agent-facing command from a raw identifier *before* any schema parse runs
 * (e.g. `createPhase` derives `design/phases/<id>-<slug>.yaml`; `recommend` /
 * `pack` derive `agent-profiles/<agent>.yaml`). Throws a CONFIG_ERROR-coded
 * Error so the CLI surfaces a clean exit-2 usage error instead of a raw
 * ZodError. `label` names the field for the message (e.g. "Phase id").
 */
export function assertSafePlanId(value: string, label = "identifier"): void {
  if (!isSafePlanId(value)) {
    const err = new Error(`${label} "${value}" is invalid: ${PLAN_ID_MESSAGE}.`);
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }
}
