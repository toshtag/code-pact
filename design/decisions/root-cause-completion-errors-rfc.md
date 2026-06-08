# RFC: Root-cause-first completion errors

**Status:** accepted (P39, 2026-05-30)
**Scope:** `task complete` failure envelope only — add `error.cause_code` + an actionable `error.message`; register the new public code `COMMANDS_FAILED`. `finalize` is documented, not modified.
**Owners:** maintainer
**Related:** [failure-clarity](failure-clarity-rfc.md) (P32 — added `data.failed_checks` / `data.first_failure` / `data.suggested_next_command`, the source this builds on) · [post-1.26-agent-dx-backlog](../../docs/maintainers/history/post-1.26-agent-dx-backlog.md) (P40 `task prepare` flow, sequenced separately).

## Summary

When `task complete` fails its decision gate (a `requires_decision` task with no accepted ADR), the **primary judgement surface** an agent reads — `error.code` / `error.message` — is generic (`VERIFICATION_FAILED` + "progress.yaml was not modified"). P32 put the real cause in `data`, but agents key on `error.*` first: the observed failure mode was an agent concluding the *verification command* had broken and re-running it pointlessly, when the cause was a missing ADR. The same repo already does this right — `task record-done` emits `error.code: "DECISION_REQUIRED"` (exit 2) on the identical gate failure. P39 ports that cause onto `task complete` minimally, without breaking its v1-stable top-level contract.

## Decisions

1. **Additive cause surface, not a breaking `error.code` change.** On `task complete`, `error.code` stays `VERIFICATION_FAILED` and the exit code stays `1`; the real cause goes in a new additive sibling **`error.cause_code`**. Promoting `error.code` to `DECISION_REQUIRED` was rejected — `error.code` is the v1-stable contract field consumers key on. The intentional asymmetry with `record-done` (top-level `DECISION_REQUIRED`, exit 2) is documented, not a bug.

2. **Actionable `error.message`, derived from the existing first failing check.** The message changes from the generic string to a first-failure-derived, actionable sentence (e.g. `"P3-T1 requires an accepted ADR before completion."`), built from `data.first_failure.reason` that P32 already computes — **no new data source**. `error.message` is not a stable contract field (only `error.code` is — `design/rules/json-output.md`), so this is non-breaking. "progress.yaml was not modified" demotes to a supplementary clause.

3. **Minimal surface — no field duplication into `error`.** `failed_checks` / `first_failure` / `suggested_next_command` stay in `data` only. Copying them up into `error` was rejected — two sources of truth, and it widens the contract against *small surfaces, clear contracts*. `cause_code` + the actionable message are the minimal sufficient fix.

4. **No new structured envelope on `task complete`.** It does **not** gain `record-done`'s full `DecisionRequiredData` block (`decision_check` / `via` / `considered` / `declared_decision_refs` / `expected_pattern`) — that would re-grow exactly the surface decision 3 keeps minimal. Extracting `buildDecisionRequiredData` to de-duplicate the inline block in `record-done` is a welcome *independent, optional* refactor, not a P39 prerequisite.

5. **`cause_code` is a deterministic, finite map from `first_failure.name`.** `task complete` runs only the `commands` + `decision` checks, so `cause_code ∈ {DECISION_REQUIRED, COMMANDS_FAILED}` (`decision → DECISION_REQUIRED`, `commands → COMMANDS_FAILED`). `DECISION_REQUIRED` already exists; `COMMANDS_FAILED` is a **new public code** registered in `KNOWN_CODES` + `docs/cli-contract.md`. The map is a finite switch over the check names, and is tested.

6. **`progress.yaml`-unchanged invariant preserved.** Envelope-shaping only — when/whether `progress.yaml` is written does not change; a failed `task complete` (including `--dry-run`) still leaves it byte-identical.

7. **Human (non-JSON) output reaches parity.** The plain-text failure output prints the cause and the rerun-after-fixing line too, not just the JSON path.

8. **`cause_code` stays in the contract.** The error-code-surface test's emission scan (`/\bcode:/`) does not match `cause_code:` (the `_` defeats the word boundary), so the test is extended to also scan `cause_code:` literals. Every `cause_code` value is thereby pinned in `KNOWN_CODES` + `docs/cli-contract.md`, exactly like `code:` values.

9. **`finalize` is documented, not modified.** Verified in code: `task finalize` never calls `checkDecision` / `runVerify` and emits no `VERIFICATION_FAILED` — its failures (`TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` / `TASK_FINALIZE_NOT_ELIGIBLE` / write-refused) are already specific. The decision gate runs in `verify` / `task complete` / `record-done` only. P39 changes no `finalize` code; `docs/cli-contract.md` gains a short note naming which verbs run the gate.

## CLI contract / error taxonomy

| Field / Code | Surface | Notes |
| --- | --- | --- |
| `error.cause_code` | new additive sibling on the `task complete` failure envelope | `∈ {DECISION_REQUIRED, COMMANDS_FAILED}`; pinned in `KNOWN_CODES` + `docs/cli-contract.md` via the extended emission scan. |
| `COMMANDS_FAILED` | **new public code** | the `commands`-check cause of a `task complete` failure. |
| `error.code` (`task complete`) | unchanged | stays `VERIFICATION_FAILED`, exit code stays `1`. |

## Alternatives considered

- **Promote `error.code` to `DECISION_REQUIRED` on `task complete`** — rejected; `error.code` is the v1-stable field consumers key on. Cause goes in the additive `cause_code` sibling instead.
- **Duplicate the P32 `data` fields up into `error`** — rejected; two sources of truth, widens the contract. Keep them in `data` only.
- **Add the full `DecisionRequiredData` structured block to `task complete`** — rejected; re-grows the minimal surface. `cause_code` + actionable message suffice.
- **Modify `finalize` too** — rejected as out of scope; `finalize` never runs the decision gate (verified in code), so it does not have the defect. Document the boundary only.
- **A new test framework for the contract scan** — rejected; extend the existing error-code-surface test to also scan `cause_code:` literals.
- **Change the decision-gate semantics** (status-aware resolution, all-must-be-accepted vs any-accepted-wins) — out of scope; P39 only changes how `task complete` surfaces the failure, not when the gate fails.

## References

- RFCs: [failure-clarity](failure-clarity-rfc.md) (P32 — `data.first_failure`, the source) · [post-1.26-agent-dx-backlog](../../docs/maintainers/history/post-1.26-agent-dx-backlog.md) (P40).
- Docs / rules: [docs/cli-contract.md](../../docs/cli-contract.md) (the gate-running verbs note + `COMMANDS_FAILED`) · [design/rules/json-output.md](../rules/json-output.md) (`error.code` is the only stable error field).
