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
// Allowed: ASCII letters, digits, ".", "_", "-".
// Rejected: spaces/tabs/newlines, slashes, shell metacharacters
// (; | & $ ` " ' etc.), and the path segments "." and "..".
// ---------------------------------------------------------------------------

export const PLAN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export const PLAN_ID_MESSAGE =
  'identifier must match ^[A-Za-z0-9._-]+$ (letters, digits, ".", "_", "-") ' +
  'and must not be "." or ".." — no spaces, slashes, or shell metacharacters';

export const PlanId = z
  .string()
  .min(1)
  .refine(
    (s) => s !== "." && s !== ".." && PLAN_ID_PATTERN.test(s),
    PLAN_ID_MESSAGE,
  );

export type PlanId = z.infer<typeof PlanId>;
