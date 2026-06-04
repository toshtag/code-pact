# Troubleshooting

When a command surfaces one of the diagnostic codes below, this page maps it to the typical recovery action. The full per-code reference is in [`docs/cli-contract.md` § Error codes](cli-contract.md#error-codes); for the project walkthrough these examples are drawn from, see [dogfood.md](dogfood.md). Unfamiliar with a term? See the [glossary](glossary.md).

## Quick lookup

| Code | Usually means | Start here |
| --- | --- | --- |
| [`VERIFICATION_FAILED`](#verification_failed-from-task-complete-or-standalone-verify) | A completion check failed (command **or** decision gate) | On `task complete`: read `error.cause_code` (`COMMANDS_FAILED` / `DECISION_REQUIRED`). On standalone `verify`: inspect `data.checks` |
| [`INVALID_TASK_TRANSITION`](#invalid_task_transition-from-task-start--block--resume--complete) | Wrong state transition (e.g. complete a blocked task) | Check `task status`; `task resume` first |
| [`TASK_FINALIZE_NOT_ELIGIBLE`](#task_finalize_not_eligible-from-task-finalize-v12) | Task isn't `done` yet | Run `task complete` first |
| [`TASK_FINALIZE_WRITE_REFUSED`](#task_finalize_write_refused-from-task-finalize---write-v12) | Phase-YAML write blocked by the safety check | Read `data.reason`; usually fix the phase file |
| [`PHASE_RECONCILE_WRITE_REFUSED`](#phase_reconcile_write_refused-from-phase-reconcile---write-v12) | Every reconcile write was refused | Re-run dry-run; fix the phase file |
| [`LOCK_HELD`](#lock_held-from-a-design-mutating-command-v15) | Another mutation is running | Wait, then retry (transient) |
| [`MANIFEST_NOT_FOUND`](#manifest_not_found-from-adapter-upgrade---check----write) | Adapter not installed yet | Run `adapter install <agent>` |
| [`ADAPTER_GENERATOR_STALE`](#adapter_generator_stale-from-adapter-doctor--global-doctor) | Older CLI stamp **and** generated output drifted (stamp-only lag is silent since v1.30.1) | Run `adapter upgrade --check`, then `--write` |
| [`PLAN_NORMALIZE_REQUIRED`](#plan_normalize_required-from-plan-normalize---check) | Whitespace / newline drift | Run `plan normalize --write` |
| [`CONFIG_ERROR` (reserved `TUTORIAL`)](#config_error-from-phase-add---id-tutorial--phase-import-containing-tutorial-v15) | Tried to create a `TUTORIAL` phase | Pick a different phase id |
| [`DECISION_REQUIRED`](#decision_required-from-task-record-done-v121) | A `requires_decision` task has no **accepted** ADR | Flip the ADR's `**Status:**` to `accepted` |
| [`ADR_STATUS_UNRECOGNIZED`](#adr_status_unrecognized-from-plan-lint---include-quality-v124) | An ADR's status word is a typo | Fix the `**Status:**` line named in `details.status_source` |
| [`CONTROL_PLANE_NOT_DRIVEN`](#control_plane_not_driven-from-doctor-v125) | Scaffold adopted but the loop isn't being driven | Start a task, or silence the check |
| [`CONTROL_PLANE_BRANCH_NOT_DRIVEN`](#control_plane_branch_not_driven-from-doctor--validate---base-ref-v126) | A PR branch changed real code but never drove the loop | Drive a task (or `record-done`) and commit the ledger (`state/events/**`), or exempt the path |
| [`ADR_ACCEPTED_BODY_THIN`](#adr_accepted_body_thin-from-plan-lint---include-quality-v126) | An accepted ADR's body is an empty stub | Add the decision + rationale, or revert status to `proposed` |
| [`ADR_COMMITMENTS_EMPTY`](#adr_commitments_empty-from-plan-lint---include-quality-v127) | An accepted ADR that resolves a gated task's gate records no implementation commitments | Add a `## Implementation commitments` checkbox list (warning only — never blocks) |
| [`PHASE_DOCS_WRITE_NO_DOC_CHECK`](#phase_docs_write_no_doc_check-from-plan-lint---include-quality-v127) | A not-done phase writes public docs but runs no doc check | Add `pnpm check:docs` to the phase's verification.commands (warning only) |
| [`TASK_CONTEXT_PACK_LARGE`](#context-fit-advisories-from-plan-lint---include-quality-v130) | Natural context pack > balanced budget (60000 bytes) | Consider a wider profile or review task scope (advisory only) |
| [`TASK_CONTEXT_BUDGET_UNACHIEVABLE`](#context-fit-advisories-from-plan-lint---include-quality-v130) | Recommended budget below the achievable floor | Use a wider profile or split the task (advisory only) |
| [`TASK_DECLARED_DECISION_LARGE`](#context-fit-advisories-from-plan-lint---include-quality-v130) | A `decision_refs` body > tight budget (30000 bytes) | Split follow-up tasks or confirm scope (advisory only) |
| [`TASK_READS_MATCH_TOO_MANY`](#context-fit-advisories-from-plan-lint---include-quality-v130) | A `reads` glob matches > 100 files | Narrow the glob if the task can be scoped (advisory only) |

## `MANIFEST_NOT_FOUND` from `adapter upgrade --check` / `--write`

You haven't run `adapter install <agent>` yet, or the per-agent manifest at `.code-pact/adapters/<agent>.manifest.yaml` was deleted.

```sh
code-pact adapter install <agent>
# then re-run the upgrade.
```

Distinct from the `ADAPTER_MANIFEST_MISSING` *warning* surfaced by `adapter doctor` for the same root cause — `adapter doctor` is read-only and never fails on a missing manifest; the upgrade commands need a manifest to do their job.

## `INVALID_TASK_TRANSITION` from `task start` / `block` / `resume` / `complete`

The current state derived from the progress ledger doesn't allow the requested transition. The most common case is `task complete` against a `blocked` task — the task must be `resume`d first so the `resumed` event records the unblock decision.

```sh
code-pact task status <task-id> --json
# Read data.current; see docs/cli-contract.md § task * for the
# allowed-transitions table.

code-pact task resume <task-id>   # if currently blocked
code-pact task complete <task-id>
```

## `PLAN_NORMALIZE_REQUIRED` from `plan normalize --check`

A file under `design/` or the legacy `.code-pact/state/progress.yaml` has trailing whitespace, CRLF line endings, or a missing/extra final newline. (Per-event files under `.code-pact/state/events/` are machine-generated and not normalized.)

```sh
code-pact plan normalize --write
# Idempotent. Comments and Markdown hard line breaks are preserved.
```

`plan normalize --write` is the apply-mode counterpart to `--check`. Passing both at once is a `PLAN_NORMALIZE_CONFLICT` (exit 2) so the intent is unambiguous in CI scripts.

## `VERIFICATION_FAILED` from `task complete` (or standalone `verify`)

A deterministic completion check did not pass. `task complete` runs two checks — `commands` (the phase's `verification.commands`) and `decision` (the `requires_decision` ADR gate) — so `VERIFICATION_FAILED` is **not** only a command failure.

**v1.27+ (P39): read `error.cause_code` first — you usually don't need to re-run `verify`.** On `task complete`, the `VERIFICATION_FAILED` envelope carries an additive `error.cause_code` and an actionable `error.message`:

- `error.cause_code: "COMMANDS_FAILED"` → a verification command failed. `error.message` embeds the failing command's reason. Fix the command (or, if the command itself is wrong — typo, missing dependency — edit `design/phases/<phase>.yaml` `verification.commands`), then re-run.
- `error.cause_code: "DECISION_REQUIRED"` → the task `requires_decision` and no **accepted** ADR resolves the gate. `error.message` says an accepted ADR is required. Write/accept the ADR (see [`DECISION_REQUIRED` from `task record-done`](#decision_required-from-task-record-done-v121) for the gate semantics), then re-run. `error.code` stays `VERIFICATION_FAILED` at exit 1 (the full structured `DecisionRequiredData` block only appears on `task record-done`).

```sh
code-pact verify --phase <phase-id> --task <task-id>
# Runs the same checks stand-alone so you can read the full output.
# No progress event is recorded when verify fails; re-run task complete
# after fixing the underlying issue.
```

**v1.26+ (P32) `data` detail.** The `task complete` failure envelope carries `failed_checks`, `first_failure: { name, reason }`, and `suggested_next_command` under `data`, alongside `data.verify.checks`. The same three P32 summary fields also appear on the `task finalize` failure envelopes (`TASK_FINALIZE_NOT_ELIGIBLE`, `TASK_FINALIZE_WRITE_REFUSED`, `WRITES_AUDIT_STRICT_FAILED`) — but `finalize` does **not** run verify, so there is no `data.verify.checks` there; the summary sits alongside the finalize-specific `data` instead (e.g. `data.write_audit` on `WRITES_AUDIT_STRICT_FAILED`, `data.current` / `data.phase_id` on `TASK_FINALIZE_NOT_ELIGIBLE`). Human (non-`--json`) output leads with the actionable cause headline (the `cause_code` message above — no longer a generic line) and prints `cause:` and `rerun after fixing:` lines below it. `suggested_next_command` is the command to rerun **after fixing** `first_failure` — not a hint that re-running unchanged will pass.

## `TASK_FINALIZE_NOT_ELIGIBLE` from `task finalize` (v1.2+)

The task's derived state from the progress ledger is not `done`, so flipping its design YAML status would create a worse drift (design says done, progress says otherwise). The check fires in **both** dry-run and `--write` — dry-run means "won't write", not "won't validate".

```sh
code-pact task status <task-id> --json
# Read data.current. Common cases:
#   - current: "planned" → you forgot to run `task complete` (or
#     `task start` + implementation + `task complete`).
#   - current: "blocked" → resume first, then complete, then finalize.
#   - current: "started" / "resumed" → still in progress; complete
#     the task first.
#   - current: "failed" → the verify failed at task complete; fix
#     the underlying issue, complete again, then finalize.

# v1.3+ alternative: `task runbook` returns the same diagnosis plus
# the recommended next step inline (no manual state interpretation).
code-pact task runbook <task-id> --json
# Read data.state_summary + data.next_steps[0].command.
```

`task finalize` deliberately refuses ineligible cases instead of guessing. Every legitimate path through the state machine ends in a `done` event, which is the precondition for finalization.

## `TASK_FINALIZE_WRITE_REFUSED` from `task finalize --write` (v1.2+)

The phase YAML write was refused by the safety classifier. `data.reason` is one of:

| Reason | Cause | Recovery |
|---|---|---|
| `unsafe_path` | The resolved path failed `assertSafeRelativePath` (traversal, absolute) | Should not happen from normal CLI use; report a bug |
| `outside_design_phases` | The phase file resolves outside `design/phases/` | Same — should not happen via the roadmap-driven resolver |
| `not_yaml` | The phase file does not end in `.yaml` | Rename the phase file to `.yaml` |
| `symlink_escape` | `resolveWithinProject` detected a symlink leaving the project root | Replace the symlink with the actual file inside the project |
| `unreadable` | The phase file could not be read (permissions, missing) | `ls -l design/phases/` and fix file permissions or restore the file |
| `unparseable_phase` | The phase file's YAML failed schema parse | Run `code-pact plan lint --json` — the underlying parse error is reported there |
| `task_not_found` | The task id is not in the phase's `tasks[]` array | The task id and phase do not match; verify the task id against `code-pact phase show <phase-id> --json` |

`task finalize --write` will not partially-modify a phase file. If the safety check fails, no write occurs.

## `PHASE_RECONCILE_WRITE_REFUSED` from `phase reconcile --write` (v1.2+)

Every eligible task write was refused for safety reasons. Partial successes (one or more applied + one or more refused) return exit 0 — this code only fires when the whole batch failed. `data.skipped_writes[]` carries per-task refusal detail in the same `reason` enum as `TASK_FINALIZE_WRITE_REFUSED` above.

```sh
code-pact phase reconcile <phase-id> --json
# Re-run in dry-run mode to inspect the per-task verdicts. Fix the
# underlying cause (unparseable phase file is the most common) and
# re-run with --write.

# v1.3+ alternative: `phase runbook` returns the same per-task verdicts
# plus the recommended next steps (blocked / manual_review / reconcile
# batch / primary loop / phase-status advisory).
code-pact phase runbook <phase-id> --json
```

If `data.tasks[]` shows every flip candidate has the same refusal reason, the issue is the phase file itself, not individual tasks — fix it once and reconcile will proceed for all of them.

## `LOCK_HELD` from a design-mutating command (v1.5+)

Another `code-pact` mutation is in progress on the same project. The advisory write lock (`.code-pact/locks/write.lock`) is held by the process whose details appear in the envelope:

```json
{
  "ok": false,
  "error": { "code": "LOCK_HELD", "message": "Another code-pact mutation is in progress: phase reconcile P14 --write (pid: 12345, host: laptop.local, started: 2026-05-21T10:15:00.000Z). ..." },
  "data": {
    "lock_holder": { "pid": 12345, "hostname": "laptop.local", "cmd": "phase reconcile P14 --write", "created_at": "2026-05-21T10:15:00.000Z" },
    "lock_path": "/path/to/.code-pact/locks/write.lock"
  }
}
```

**Normal case — another command is running.** Wait for the holder to release (the lock is created/released within a single CLI invocation) and re-run. The lock is transient by design; LOCK_HELD belongs in the retry-on-transient list for any orchestration that runs multiple `code-pact` commands in parallel.

**Stale-lock case — the holder is gone.** A prior `code-pact` process crashed (SIGKILL, OOM, OS reboot) without releasing the lock. v1.5 does NOT auto-detect this; recovery is manual and intentionally conservative:

1. Verify no `code-pact` process is running (check `ps` / `pgrep` for the `pid` in `data.lock_holder.pid`; on a different host, check `data.lock_holder.hostname` matches yours).
2. **Only when certain no process holds it**, delete the lock file: `rm .code-pact/locks/write.lock`.
3. Re-run the command.

Do not blindly delete the lock file just because LOCK_HELD fired — if a concurrent mutation IS in progress, deleting the lock undermines the guarantee. The conservative manual-recovery default in v1.5 deliberately favours wait-and-retry over automation, because automated stale detection is subtle (two processes can both decide the other is stale and clobber a real lock).

Read-only commands (`plan lint`, `plan analyze`, `task runbook`, `phase runbook`, `validate`, `doctor`, `recommend`, `task context`, `task status`) do NOT acquire the lock and can be used to observe project state while a mutation is pending.

See [`docs/concepts/governance.md`](concepts/governance.md) for the v1.5 governance walkthrough and [`docs/cli-contract.md` § Advisory write lock](cli-contract.md#advisory-write-lock-v15--p14) for the full acquisition-point matrix.

## `CONFIG_ERROR` from `phase add --id TUTORIAL` / `phase import` containing `TUTORIAL` (v1.5+)

The id `TUTORIAL` is reserved at the governance layer for the sample-phase artifact created by `code-pact init --sample-phase`. The block fires at creation time on every path except the sanctioned bootstrap.

```sh
# Rejected: phase add cannot create a TUTORIAL phase.
code-pact phase add --id TUTORIAL --name ... --weight 1 --objective ...
# → CONFIG_ERROR (exit 2). Roadmap is byte-identical (no write).

# Rejected: phase import containing a TUTORIAL entry (anywhere in the
# file) is preflighted before any createPhase call, so the whole
# import is rejected with the roadmap untouched.
code-pact phase import path/to/import.yaml
# → CONFIG_ERROR (exit 2) if any phase entry has id: TUTORIAL.

# Sanctioned: init --sample-phase is the only allowed creation path.
code-pact init --sample-phase
# → creates design/phases/TUTORIAL-walkthrough.yaml + the roadmap entry.
```

If you genuinely want a phase named `TUTORIAL` for a non-tutorial purpose, **pick a different id**. The block uses the existing `CONFIG_ERROR` envelope — no new error code ships for this. The error message names the reserved id and points back at `init --sample-phase` as the sanctioned path. Existing v1.4.x projects with a TUTORIAL phase are untouched; the block only fires on new creation. See [`docs/concepts/sample-phase.md`](concepts/sample-phase.md#tutorial-is-a-reserved-phase-id-v15--p14) for the user-facing rules.

## `ADAPTER_GENERATOR_STALE` from `adapter doctor` / global `doctor`

Your adapter manifest's `generator_version` field doesn't match the installed code-pact version **and** the generated adapter output the current CLI would produce no longer matches the manifest.

Since v1.30.1 (Issue #340), a stale `generator_version` on its own is **silent**: a no-op patch bump that changes nothing about your generated adapter files does not raise this warning, so you are not nagged to run `adapter upgrade` for a re-stamp that would touch no managed content. The warning fires only when the desired output has actually drifted (or when the agent profile can't be read, so equivalence can't be proven — in which case it is kept conservatively).

When you do see it, inspect the plan before writing:

```sh
code-pact adapter upgrade <agent> --check --json
# Read plan[] — managed-clean files appear as action:update,
# managed-modified files as action:refuse.

code-pact adapter upgrade <agent> --write
# Safe for managed-clean. Refuses managed-modified unless you also
# pass --accept-modified (the only flag that overwrites local edits).
```

See [`docs/upgrading.md`](upgrading.md) for the upgrade path (the alpha-era detail is archived in `migration.md`).

## Expected warnings around non-interactive setup

If you ran `code-pact init --non-interactive --agent <agent> --locale <locale>` from CI or a script, the project does not have generated instruction files or a pinned model version yet. `code-pact validate --json` then reports two warnings as expected state:

| Code | Severity | Why it fires |
|---|---|---|
| `ADAPTER_MISSING` | warning | The enabled agent's instruction files (e.g. `CLAUDE.md`) have not been generated yet. Run `code-pact adapter install <agent> --model <version>` to create them. |
| `ADAPTER_STALE` | warning | `adapter install <agent>` was called without `--model <version>`, so the model profile is not pinned. Re-run `adapter install <agent> --model <version>` (e.g. `--model opus-4.7`) to silence. |

`BRIEF_MISSING` and `CONSTITUTION_PLACEHOLDER` do **not** fire on a fresh project — both are gated on a real (non-`TUTORIAL`) phase existing, so they stay quiet until the project has started real work. Once a phase exists, `BRIEF_MISSING` fires if `design/brief.md` is still absent (it is optional — `init` never creates it) and `CONSTITUTION_PLACEHOLDER` fires if the constitution is still the template. Resolve both from CI with the non-interactive `plan brief` / `plan constitution` modes (**v1.6+**: `--from-file <yaml>`, `--stdin`, or the flag forms — see [maintainers/operations.md § Non-interactive `plan brief` / `plan constitution`](maintainers/operations.md#non-interactive-plan-brief--plan-constitution-v16-p17)).

These are intentionally warnings, not errors — `validate` still exits 0. CI scripts that require a clean run can either fix the underlying state or pass `--strict` only after deciding to treat them as failures.

A separate `STATUS_DRIFT done-but-design-not-done` warning from `plan analyze --json` is also expected after any `task complete` until the design YAML's `status` field is flipped to `done`. `task complete` records progress, but does not mutate design intent. v1.2+ mechanizes the flip via `code-pact task finalize <task-id> --write` (single task) or `code-pact phase reconcile <phase-id> --write` (whole phase); the warning's `details.remediation` field carries the exact command. v1.3+ also exposes the same recommendation via `code-pact task runbook <task-id> --json` (single task) or `code-pact phase runbook <phase-id> --json` (whole phase) — runbook is read-only and never executes anything. See [maintainers/operations.md § `task complete` vs `design/`](maintainers/operations.md#task-complete-vs-design-v10-contract), [`docs/concepts/finalization-reconciliation.md`](concepts/finalization-reconciliation.md) for the v1.2+ walkthrough, and [`docs/concepts/runbook.md`](concepts/runbook.md) for the v1.3+ walkthrough.

## `DECISION_REQUIRED` from `task record-done` (v1.21+)

The task (or its phase) is `requires_decision: true`, and the [decision gate](concepts/decision-gate.md) cannot resolve an **accepted** ADR for it. `task record-done` skips verification commands, so this gate is the only thing standing between a non-`task complete` completion path (external completion or a `record_only` task) and a `done` event — it is **not** bypassable. No progress event is recorded (exit 2).

```sh
code-pact task record-done <task-id> --evidence "PR #123" --json
# → error.code: DECISION_REQUIRED
# Inspect why: data.via ("decision_refs" | "filename-scan") and
# data.considered[] (each ADR with its status + acceptance).
```

Recovery: make an ADR for the task **accepted**.
- If `data.via` is `"filename-scan"`, create or edit `design/decisions/<task-id>.md` (the `data.expected_pattern`) so its `**Status:**` line reads `accepted`.
- If `data.via` is `"decision_refs"`, **every** path in the task's `decision_refs` must resolve to an `accepted` ADR (all-must-be-accepted). Fix the ones `data.considered[]` shows as `blocked` / `empty` / `missing` / `unknown_status` / `unsafe_path`. For `unsafe_path`, the reference escapes the project root (`..`, an absolute path, or a symlink out) and is never read — replace it with a safe repo-relative path that stays inside the project (normally under `design/decisions/`).

The gate is the same one `verify` and `task complete` enforce, and since v1.22 it reads the ADR's status (see the [decision-gate concept](concepts/decision-gate.md)). To generate `proposed` stubs to fill in, import with `--scaffold-decisions`.

## `ADR_STATUS_UNRECOGNIZED` from `plan lint --include-quality` (v1.24+)

An ADR in `design/decisions/` declares a status word the gate doesn't recognize — almost always a typo like `**Status:** acceptd`. The gate treats an unrecognized status as **not accepted**, so the decision stays blocked even though you meant to accept it. Advisory only (`affects_exit: false`); never fails the lint.

```sh
code-pact plan lint --include-quality --json
# → issues[] entry with code ADR_STATUS_UNRECOGNIZED
# details.status        — the offending word (e.g. "acceptd")
# details.status_source — "frontmatter" or "bold-line": which one to fix
```

Recovery: fix the status word to one of `accepted` / `proposed` / `draft` / `rejected` / `superseded`. `details.status_source` tells you whether the typo is in the YAML frontmatter `status:` or the body `**Status:**` line (frontmatter wins when both are present).

## `CONTROL_PLANE_NOT_DRIVEN` from `doctor` (v1.25+)

`doctor` noticed the project has real (non-TUTORIAL) tasks and uncommitted git changes, but the progress ledger has never recorded a `started`/`done` event for a non-TUTORIAL task — i.e. the scaffold is in place but the loop isn't being driven. Advisory only (`severity: warning`; never fails `doctor`).

Recovery — pick whichever matches reality:
- **Drive the loop**: `code-pact task prepare <task-id> --agent <agent> --json`, then `task start`.
- **Record completion without `task complete`**: for external completion *or* the `record_only` lane after you ran the project's verification by hand, `code-pact task record-done <task-id> --evidence "..."` (records a `done` with `source: external`; the decision gate still applies).
- **Silence it** (you knowingly aren't driving this project through code-pact): add to `.code-pact/doctor.yaml`:
  ```yaml
  disabled_checks:
    - CONTROL_PLANE_NOT_DRIVEN
  ```

It is a **silent skip** outside a git repo or when git isn't installed, so it never fires in CI sandboxes that aren't checkouts.

## `CONTROL_PLANE_BRANCH_NOT_DRIVEN` from `doctor` / `validate --base-ref` (v1.26+)

The PR branch changed real code (vs the base ref's merge-base) but added **no** `started`/`done` event for a **known** non-TUTORIAL task to the committed ledger (legacy `progress.yaml` or `state/events/**`) — code changed without driving the loop. Unlike `CONTROL_PLANE_NOT_DRIVEN` (which looks at the uncommitted working tree and so never fires in CI after a clean checkout), this is branch-diff based and is meant for PR CI. It runs **only** when `--base-ref` is supplied, and is advisory (`severity: warning`); pair it with `validate --strict` to make it a gate.

```sh
code-pact validate --strict --base-ref origin/main --json
# → CONTROL_PLANE_BRANCH_NOT_DRIVEN when real, non-excluded files
#   changed but no known non-TUTORIAL task got a started/done event
#   on the branch.
```

Recovery — pick whichever matches reality:
- **Drive the loop**: `code-pact task prepare <task-id> --agent <agent> --json`, then `task start` / `task complete`, and **commit the new event file(s)** under `.code-pact/state/events/` (the gate reads the committed ledger, not the working tree).
- **Record completion without `task complete`**: for external completion *or* the `record_only` lane after verification, `code-pact task record-done <task-id> --evidence "..."`, then commit.
- **Exempt docs/config-only paths** the team agrees don't need the loop, in `.code-pact/doctor.yaml`:
  ```yaml
  control_plane_branch_not_driven:
    exclude_globs:
      - "docs/**"
      - "**/*.md"
  ```
- **Silence it**: add `CONTROL_PLANE_BRANCH_NOT_DRIVEN` to `disabled_checks`.

**Precondition.** The gate reads the **committed** ledger — the per-event files under `.code-pact/state/events/` **and** the legacy `.code-pact/state/progress.yaml`. `init` ignores only the machine-local / derived subset of `.code-pact/` (`/.code-pact/locks/`, `/.code-pact/cache/`, plus `/.local/` and `/.context/`), so by default the ledger is committable — commit it and the gate works. The check **silently skips** when neither the event files nor `progress.yaml` is git-tracked (e.g. you deliberately ignore `.code-pact/` — then `git add -f .code-pact/state/events/ .code-pact/state/progress.yaml`) or when git/merge-base is unavailable. `validate` also needs the project config (`.code-pact/project.yaml`, agent/model profiles) in the CI checkout. See [Running code-pact in CI](workflows/ci.md) for the copy-paste GitHub Actions workflow, and [`docs/cli-contract.md` § `doctor`](cli-contract.md#--base-ref-and-ci-branch-drift-gating-v126-p34) for the `--base-ref` contract and the precondition.

## `ADR_ACCEPTED_BODY_THIN` from `plan lint --include-quality` (v1.26+)

An `accepted` ADR in `design/decisions/` has an empty-stub body — an accepted decision with no recorded reasoning. The check is **structure-independent** (no heading-name matching): it fires only when the substantive body (frontmatter removed, status line + h1 title stripped, whitespace normalized) is below an internal threshold **and** the body has zero `##` (h2) headings. So a short-but-structured or long-but-heading-free ADR never fires. Advisory only (`affects_exit: false`); it does not change the decision gate.

```sh
code-pact plan lint --include-quality --json
# → issues[] entry with code ADR_ACCEPTED_BODY_THIN
# details.body_chars     — substantive body length measured
# details.heading_count  — number of h2 headings found (0 to fire)
```

Recovery: add the decision and its rationale to the ADR body, or — if it isn't actually decided yet — revert its `**Status:**` to `proposed` (then the [decision gate](concepts/decision-gate.md) correctly blocks completion until it's accepted with real content). A file that is just a `**Status:** accepted` line is exactly the stub this surfaces; a 0-byte empty file and `proposed`/`draft` ADRs are not flagged.

## `ADR_COMMITMENTS_EMPTY` from `plan lint --include-quality` (v1.27+)

An **accepted** ADR that **resolves** a `requires_decision` task's [decision gate](concepts/decision-gate.md) records no implementation commitments — it has no `## Implementation commitments` section, or the section is present but has zero GFM checkbox items (`- [ ]`, `- [x]`, `* [ ]`, `* [x]` — checked **and** unchecked all count toward `item_count`). The decision is settled, but the downstream work it implies is unrecorded. (Only a gate that actually resolves is in scope: a partially-accepted explicit `decision_refs` set is unresolved and surfaces `TASK_DECISION_UNRESOLVED` instead.)

This is a **warning, not a blocker**: `affects_exit: false`, so it never changes the exit code, **including under `--strict`**. It is scoped to accepted ADRs that **resolve** a gated task's gate, so unreferenced ADRs and unresolved (partially-accepted) gates never fire.

```sh
code-pact plan lint --include-quality --json
# → issues[] entry with code ADR_COMMITMENTS_EMPTY
# file                  — the ADR path (there is no `path` field; the subject is ADR content)
# task_id / phase_id    — the gated task that references the ADR
# details.has_section   — false = no section; true = section present
# details.item_count    — number of checkbox items (0 to fire)
```

Recovery: add a `## Implementation commitments` checkbox list to the accepted ADR — the concrete downstream work the decision implies (`- [ ]` for work to do, `- [x]` for work already satisfied). If the decision genuinely implies no downstream work, record that explicitly as a checked item: `- [x] No downstream implementation work.` — use this **only when there truly is none**, not merely to silence the advisory (the point of recording commitments is to make the consequences deliberate).

## `PHASE_DOCS_WRITE_NO_DOC_CHECK` from `plan lint --include-quality` (v1.27+)

A **not-yet-`done`** phase has a task whose `writes` includes a public doc that `pnpm check:docs` guards (a `docs/**` file or a root-level public `.md`), but the phase's `verification.commands` run no doc check. The phase will edit public docs without verifying them — the docs-drift class P43 exists to stop.

This is a **warning, not a blocker**: `affects_exit: false`. CHANGELOG.md is excluded (it is not scanned by `check:docs`), `design/**` is excluded (validated by `validate` / `plan lint`), and `done` phases are never flagged (it is a forward-looking guard — a frozen phase can't be changed).

```sh
code-pact plan lint --include-quality --json
# → issues[] entry with code PHASE_DOCS_WRITE_NO_DOC_CHECK
# file              — the phase YAML path
# phase_id / task_id — the phase and the task whose writes triggered it
# details.doc_write — the offending public-doc write target
```

Recovery: add a doc check (`pnpm check:docs`, or `check:doc-links` / `check:doc-invariants`) to the phase's `verification.commands` so the doc edits are verified; or, if the declared doc write is stale, remove it from the task's `writes`.

## Context Fit advisories from `plan lint --include-quality` (v1.30+)

The four Context Fit advisories (P50, Context Fit layer d) flag likely **context-size risk** before a task runs. They appear **only** under `--include-quality`, are **absent** without it, and every one is `affects_exit: false` — they never change the exit code, even under `--strict`. Thresholds are deterministic byte/count values; the pass is local and deterministic (no model / tokenizer / summarization / compression / network), changes no context pack content, and applies no budget automatically.

These are **readiness signals, not correctness failures**. A large context pack, a large declared decision, or a broad `reads` glob can all be legitimate — the advisories help you notice size risk early, not block work or force premature micro-optimization.

```sh
code-pact plan lint --include-quality --json
# → issues[] entries (all affects_exit: false)
```

- **`TASK_CONTEXT_PACK_LARGE`** — the task's **natural** (pre-elision) context pack exceeds the `balanced` budget (60000 bytes). `details.natural_bytes` / `details.threshold_bytes` / `details.recommended_profile` (`"wide"`). Reuses the P49 `natural_bytes` explain metric. Recovery (optional): pass `--context-budget wide` when building the pack, or split the task if its scope is genuinely too broad. Needs a resolvable project `default_agent` for the pack build; skipped otherwise.
- **`TASK_CONTEXT_BUDGET_UNACHIEVABLE`** — the deterministically recommended budget (P48 mapping; the default agent's same-name `context_budget` override when available, else the built-in fallback — the same byte value `recommend` surfaces) cannot fit even after maximal eligible elision: `minimum_achievable_bytes > budget_bytes`. `details.profile` / `details.budget_bytes` / `details.minimum_achievable_bytes` (the **same floor `CONTEXT_OVER_BUDGET` reports**). Recovery (optional): use a wider profile or split the task. It does not change the recommendation or fail lint. Needs a resolvable `default_agent`; skipped otherwise.
- **`TASK_DECLARED_DECISION_LARGE`** — a `decision_refs` entry points to a decision body larger than the `tight` budget (30000 bytes), large enough to dominate a tight pack. `details.path` / `details.bytes` / `details.threshold_bytes`. This is **not** an ADR-quality error — do not delete the ADR; consider splitting follow-up tasks, using a wider profile, or confirming the task scope justifies the large reference. Unsafe/missing refs are reported by `TASK_DECISION_REF_UNSAFE_PATH` / `TASK_DECISION_REF_NOT_FOUND` instead.
- **`TASK_READS_MATCH_TOO_MANY`** — a `reads` glob matches more than 100 files and may inflate context planning cost. `details.glob` / `details.match_count` / `details.threshold_count`. Recovery (optional): narrow the glob if the task can be scoped more precisely. Broad reads can be valid for cross-cutting refactors.
