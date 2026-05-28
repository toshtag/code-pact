# RFC: Failure clarity for `task complete` / `task finalize`

- Status: accepted
- Phase: P32
- Date: 2026-05-28

## Problem

When `task complete` fails verification, the true root cause already exists
in the thrown error's `checks: CheckResult[]` (each carries a human-readable
`reason`, e.g. `decision_refs for "P2-T1" not all accepted: design/decisions/P2-T1.md is "proposed" (needs "accepted")`).
But the surfaces an agent actually reads hide it:

- **human output** is a single generic line —
  `"Verification failed for X. progress.yaml was not modified."`
- **JSON** carries the array as `data.verify.checks`, with no top-of-`data`
  signal of *which* check failed or *what to do next*.

An agent that gets this output cannot decide its next action without
re-running the lower-level `code-pact verify` to inspect the checks — an
observed wasted round-trip. `task finalize` has the same problem on a
different, non-`CheckResult` failure surface (`TASK_FINALIZE_NOT_ELIGIBLE`,
`TASK_FINALIZE_WRITE_REFUSED`, `WRITES_AUDIT_STRICT_FAILED`).

This is squarely code-pact's job: the control plane must make the *next
action* unambiguous at the point of failure, deterministically — not leave
the agent to guess. (It is **not** a bug-detection feature; verify's checks
are unchanged.)

## Decisions

1. **Three additive fields, no new error codes.** The failure envelopes of
   `task complete` and `task finalize` gain `failed_checks: string[]`,
   `first_failure: { name, reason } | null`, and
   `suggested_next_command: string | null`, placed under `data` alongside the
   existing (untouched) `data.verify.checks` / `data.write_audit`. Existing
   fields keep their meaning and shape — additive, schema-compatible for any
   consumer that ignores unknown fields. No new `code:` literal is
   introduced, so the error-code surface is unchanged.

2. **A deterministic, AI-free resolver.** `suggested_next_command` is a
   finite switch on the failing check name (or finalize failure code) → an
   exact command string. No free-form text, no model output. This follows
   the repo's enforcement philosophy: logic-ify what does not need judgment,
   and surface (not hard-block) what does.

3. **`suggested_next_command` means "rerun *after fixing*".** It is the
   command to re-run once the reported `first_failure` is fixed — it does
   **not** imply that re-running unchanged will resolve the failure. To avoid
   misleading an agent that reads the field name loosely, the human label is
   `rerun after fixing:` / `修正後に再実行:` (not `next:`), and
   `docs/cli-contract.md` states the meaning explicitly.

4. **A core helper with no dependency on `commands/`.** The summary type and
   builders live in `src/core/failure/failure-summary.ts`. The helper accepts
   a structural `FailureCheckLike = { name; ok; reason? }` rather than
   importing `CheckResult` from `src/commands/verify.ts`, so `core` never
   depends on `commands` (correct layering; `CheckResult` is structurally
   assignable and passed in from the CLI layer).

5. **A shared CLI render helper.** `renderFailureSummaryLines` (cli layer,
   i18n labels) prints the summary to stderr below the existing generic
   message, reused by both the complete and finalize handlers so human and
   JSON output stay consistent.

## Non-goals

- No change to which checks `verify` runs or how it enforces decisions at
  completion — the gate behavior is identical.
- No new error codes; the additions are fields only.
- No restructuring of `data.verify.checks` / `data.write_audit`.
- `acceptance_refs` / `depends_on` checks are out of scope — they are
  advisories on the finalize *success* envelope and do not fail the command,
  so they are not `first_failure` candidates.
- No bug-detection capability — this is purely failure *clarity*.
