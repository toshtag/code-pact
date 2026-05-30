# RFC: Root-cause-first completion errors

- Status: accepted
- Phase: P39
- Date: 2026-05-30

## Problem

When `task complete` fails its decision gate (a `requires_decision` task with no
accepted ADR), the JSON envelope's **primary judgement surface** still reads:

```json
{ "ok": false, "error": { "code": "VERIFICATION_FAILED",
  "message": "Verification failed for \"P3-T1\". progress.yaml was not modified." } }
```

P32 (failure-clarity) added the root cause to `data` — `data.failed_checks`,
`data.first_failure`, `data.suggested_next_command` — and that part works. But an
AI agent reads `error.code` / `error.message` **first** to decide its next move,
and at that surface the message is generic. The observed failure mode: an agent
saw `VERIFICATION_FAILED` + "progress.yaml was not modified", concluded the
*verification command* (`pnpm verify`) had broken, and ran it pointlessly — when
the real cause was a missing accepted ADR, only discoverable by dropping to the
low-level `code-pact verify`. "The detail is in `data`" is not enough; the
control surface itself misdirects.

The asymmetry that makes this a clear defect rather than a feature gap: the
**same repository already does this right**. `task record-done`
(`src/commands/task-record-done.ts:164-198`) emits `error.code:
"DECISION_REQUIRED"` (exit 2) on the identical decision-gate failure.
`DECISION_REQUIRED` is already a registered public code (`docs/cli-contract.md`,
`error-code-surface.test.ts`). Only `task complete` degrades the cause to a
generic string. P39 ports the cause that already exists; it does not invent one.

**Scope boundary, verified in code.** P39's only behavioral target is
`task complete`. `task finalize` is **not** in scope: `src/commands/task-finalize.ts`
never calls `checkDecision` / `runVerify` and emits no `VERIFICATION_FAILED` —
its failures are `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` /
`TASK_FINALIZE_NOT_ELIGIBLE` / write-refused, which are already specific (not
generic). The decision gate runs in `verify` / `task complete` / `task record-done`
only. So `finalize` does not have the problem P39 fixes, and P39 changes no
`finalize` code (it only documents the boundary). This corrects an earlier draft
that wrongly assumed a `finalize` `VERIFICATION_FAILED` path.

## Decisions

1. **Additive cause surface, not a breaking `error.code` change.** On
   `task complete`, `error.code` stays `VERIFICATION_FAILED` and the exit code
   stays `1`. We add **`error.cause_code`** carrying the real cause. Promoting
   `error.code` to `DECISION_REQUIRED` here was rejected: `error.code` is the
   v1-stable contract field and consumers key on `VERIFICATION_FAILED`; cause
   goes in an additive sibling instead. (Note the intentional asymmetry with
   `record-done`, whose *top-level* code is `DECISION_REQUIRED` at exit 2 —
   `task complete`'s top-level contract is deliberately unchanged. Documented,
   not a bug.)

2. **Actionable `error.message`, derived from the existing first failing check.**
   The message changes from the generic string to a first-failure-derived,
   actionable sentence, e.g. `"P3-T1 requires an accepted ADR before
   completion."`. It is built from `data.first_failure.reason`, which P32 already
   computes — **no new data source is introduced**. `error.message` is not a
   stable contract field (only `error.code` is — see
   `design/rules/json-output.md`), so this is non-breaking. The "progress.yaml
   was not modified" note demotes to a supplementary clause; it is no longer the
   headline.

3. **Minimal surface — no field duplication into `error`.**
   `failed_checks` / `first_failure` / `suggested_next_command` stay in `data`
   only, where P32 placed them. `error.cause_code` + the actionable
   `error.message` are the **minimal sufficient** fix for the misdirection.
   Copying the P32 fields up into `error` was rejected: it creates two sources of
   truth and widens the contract against the constitution's *small surfaces,
   clear contracts*.

4. **No new structured envelope on `task complete`.** `task complete` does **not**
   gain `record-done`'s full `DecisionRequiredData` block (`decision_check` /
   `via` / `considered` / `declared_decision_refs` / `expected_pattern`). P39's
   goal is "make the error face name the cause", not "extend the decision error
   envelope". `cause_code` + the actionable `message` (from the existing
   `first_failure.reason`) are sufficient; adding the full structured block would
   re-grow exactly the surface decision 3 keeps minimal. Extracting
   `buildDecisionRequiredData` to de-duplicate the **inline** block inside
   `task-record-done.ts` is welcome as an *independent, optional* refactor, but it
   is not wired into the `task complete` envelope and is not a P39 prerequisite.

5. **`cause_code` is a deterministic, finite map from `first_failure.name`.**
   `task complete` runs only the `commands` + `decision` checks, so its
   `cause_code ∈ {DECISION_REQUIRED, COMMANDS_FAILED}`:
   `decision → DECISION_REQUIRED`, `commands → COMMANDS_FAILED`. The map is a
   finite switch over the check names `task complete` can produce, and is tested.
   `DECISION_REQUIRED` already exists; `COMMANDS_FAILED` is a **new public code**
   registered in `KNOWN_CODES` + `docs/cli-contract.md`.

6. **`progress.yaml`-unchanged invariant preserved.** P39 is an envelope-shaping
   change only. When/whether `progress.yaml` is written does not change; a failed
   `task complete` (including `--dry-run`) still leaves it byte-identical.

7. **Human (non-JSON) output reaches parity for `task complete`.** The plain-text
   failure output prints the cause and the rerun-after-fixing line too, not just
   the JSON path.

8. **`cause_code` stays in the contract.** The error-code-surface test's emission
   scan (`/\bcode:/`) does not match `cause_code:` (the `_` defeats the word
   boundary), so the test is extended to also scan `cause_code:` literals. Every
   `cause_code` value is thereby pinned in `KNOWN_CODES` + `docs/cli-contract.md`,
   exactly like `code:` values.

9. **`finalize` is documented, not modified.** P39 changes no `finalize` code.
   `docs/cli-contract.md` gains a short note stating which verbs run the decision
   gate (`verify` / `task complete` / `record-done`) and that `finalize` does not,
   so the asymmetry is explicit for readers and agents.

## Non-goals

- No promotion of `error.code` to `DECISION_REQUIRED` on `task complete`, and no
  change to its exit code.
- No duplication of the P32 `data` fields (`failed_checks` / `first_failure` /
  `suggested_next_command`) into `error`.
- No new `DecisionRequiredData` (full structured decision block) on the
  `task complete` envelope — `cause_code` + actionable `message` only.
- No `finalize` behavioral change and no decision `cause_code` carried into
  `finalize` — it does not run the decision gate (verified in code).
- No change to the decision-gate **semantics** (status-aware resolution,
  all-must-be-accepted vs any-accepted-wins) — only how `task complete` surfaces
  the failure.
- No `task prepare` lifecycle-flow work — that is P40 (sequenced separately; see
  `post-1.26-agent-dx-backlog.md`).
- No new framework; extend the existing error-code-surface test only.
