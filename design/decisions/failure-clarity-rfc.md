# RFC: Failure clarity for `task complete` / `task finalize`

**Status:** accepted (P32, 2026-05)
**Scope:** additive failure-envelope fields on `task complete` / `task finalize` (`data.failed_checks`, `data.first_failure`, `data.suggested_next_command`) + a deterministic AI-free resolver + a shared CLI render helper. No new error codes; `verify`'s checks are unchanged.
**Owners:** maintainer
**Related:** [root-cause-completion-errors](root-cause-completion-errors-rfc.md) (P39 — builds on these `data.*` fields, ports the cause onto `error.*`).

## Summary

On a failed `task complete` / `task finalize`, the true root cause already exists in the result (`data.verify.checks[].reason`, e.g. `decision_refs for "P2-T1" not all accepted: …`) but the surfaces an agent reads hide it: human output is a single generic line (`"Verification failed for X. progress.yaml was not modified."`) and JSON gives no top-of-`data` signal of *which* check failed or *what to do next*. The agent then re-runs the lower-level `code-pact verify` to inspect checks — an observed wasted round-trip. This makes the *next action* unambiguous at the point of failure, deterministically. It is failure **clarity**, not bug detection.

## Decisions

1. **Three additive fields, no new error codes.** The failure envelopes of `task complete` and `task finalize` gain, under `data` alongside the untouched `data.verify.checks` / `data.write_audit`:
   - `failed_checks: string[]`
   - `first_failure: { name, reason } | null`
   - `suggested_next_command: string | null`

   Additive and schema-compatible — existing fields keep their meaning and shape, any consumer ignoring unknown fields is unaffected, and no `code:` literal is introduced (the error-code surface is unchanged). `finalize`'s non-`CheckResult` failures (`TASK_FINALIZE_NOT_ELIGIBLE`, `TASK_FINALIZE_WRITE_REFUSED`, `WRITES_AUDIT_STRICT_FAILED`) feed the same fields.

2. **A deterministic, AI-free resolver.** `suggested_next_command` is a finite switch on the failing check name (or finalize failure code) → an exact command string. No free-form text, no model output — logic-ify what needs no judgment, surface what does.

3. **`suggested_next_command` means "rerun *after fixing*".** It is the command to re-run once the reported `first_failure` is fixed; it does **not** imply that re-running unchanged resolves the failure. So the human label is `rerun after fixing:` / `修正後に再実行:` (not `next:`), and `docs/cli-contract.md` states the meaning explicitly.

4. **Core helper with no dependency on `commands/`.** The summary type and builders live in `src/core/failure/failure-summary.ts` and accept a structural `FailureCheckLike = { name; ok; reason? }` rather than importing `CheckResult` from `commands/`, so `core` never depends on `commands` (`CheckResult` is structurally assignable, passed in from the CLI layer).

5. **A shared CLI render helper.** `renderFailureSummaryLines` (CLI layer, i18n labels) prints the summary to stderr below the existing generic message, reused by both the complete and finalize handlers so human and JSON output stay consistent.

## Non-goals

- No change to which checks `verify` runs or how it enforces decisions at completion — the gate behavior is identical.
- No new error codes; the additions are fields only.
- No restructuring of `data.verify.checks` / `data.write_audit`.
- `acceptance_refs` / `depends_on` checks are out of scope — they are advisories on the finalize *success* envelope and never fail the command, so they are not `first_failure` candidates.
- No bug-detection capability — this is purely failure *clarity*.

## References

- RFCs: [root-cause-completion-errors](root-cause-completion-errors-rfc.md) (P39 — ports the cause onto `error.*`).
- Docs: [docs/cli-contract.md](../../docs/cli-contract.md) (documents `suggested_next_command` semantics).
