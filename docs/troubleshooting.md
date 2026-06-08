# Troubleshooting

When a command surfaces one of the diagnostic codes below, this page maps it to the typical recovery action. The full per-code reference is in [`docs/cli-contract.md` § Error codes](cli-contract.md#error-codes); for the project walkthrough these examples are drawn from, see [dogfood.md](dogfood.md). Unfamiliar with a term? See the [glossary](glossary.md).

## Quick lookup

| Code | Usually means | Start here |
| --- | --- | --- |
| [`VERIFICATION_FAILED`](#verification_failed-from-task-complete-or-standalone-verify) | A completion check failed (command **or** decision gate) | On `task complete`: read `error.cause_code` (`COMMANDS_FAILED` / `DECISION_REQUIRED`). On standalone `verify`: inspect `data.checks` |
| [`INVALID_TASK_TRANSITION`](#invalid_task_transition-from-task-start--block--resume--complete) | Wrong state transition (e.g. complete a blocked task) | Check `task status`; `task resume` first |
| [`TASK_FINALIZE_NOT_ELIGIBLE`](#task_finalize_not_eligible-from-task-finalize) | Task isn't `done` yet | Run `task complete` first |
| [`TASK_FINALIZE_WRITE_REFUSED`](#task_finalize_write_refused-from-task-finalize---write) | Phase-YAML write blocked by the safety check | Read `data.reason`; usually fix the phase file |
| [`PHASE_RECONCILE_WRITE_REFUSED`](#phase_reconcile_write_refused-from-phase-reconcile---write) | Every reconcile write was refused | Re-run dry-run; fix the phase file |
| [`DECISION_PRUNE_NOT_ELIGIBLE`](#decision_prune_not_eligible-from-decision-prune) | A decision record cannot be retired yet | Read `data.blocks[]`; resolve each gate (or pick a different target) |
| [`LOCK_HELD`](#lock_held-from-a-lock-covered-mutation) | Another mutation is running | Wait, then retry (transient) |
| [`MANIFEST_NOT_FOUND`](#manifest_not_found-from-adapter-upgrade---check----write) | Adapter not installed yet | Run `adapter install <agent>` |
| [`ADAPTER_GENERATOR_STALE`](#adapter_generator_stale-from-adapter-doctor--global-doctor) | Older CLI stamp **and** generated output drifted (stamp-only lag is silent) | Run `adapter upgrade --check`, then `--write` |
| [`PLAN_NORMALIZE_REQUIRED`](#plan_normalize_required-from-plan-normalize---check) | Whitespace / newline drift | Run `plan normalize --write` |
| [`CONFIG_ERROR` (reserved `TUTORIAL`)](#config_error-from-phase-add---id-tutorial--phase-import-containing-tutorial) | Tried to create a `TUTORIAL` phase | Pick a different phase id |
| [`DECISION_REQUIRED`](#decision_required-from-task-record-done) | A `requires_decision` task has no **accepted** ADR | Flip the ADR's `**Status:**` to `accepted` |
| [`ADR_STATUS_UNRECOGNIZED`](#adr_status_unrecognized-from-plan-lint---include-quality) | An ADR's status word is a typo | Fix the `**Status:**` line named in `details.status_source` |
| [`CONTROL_PLANE_NOT_DRIVEN`](#control_plane_not_driven-from-doctor) | Scaffold adopted but the loop isn't being driven | Start a task, or silence the check |
| [`CONTROL_PLANE_BRANCH_NOT_DRIVEN`](#control_plane_branch_not_driven-from-doctor--validate---base-ref) | A PR branch changed real code but never drove the loop | Drive a task (or `record-done`) and commit the ledger (`state/events/**`), or exempt the path |
| [`ADR_ACCEPTED_BODY_THIN`](#adr_accepted_body_thin-from-plan-lint---include-quality) | An accepted ADR's body is an empty stub | Add the decision + rationale, or revert status to `proposed` |
| [`ADR_COMMITMENTS_EMPTY`](#adr_commitments_empty-from-plan-lint---include-quality) | An accepted ADR that resolves a gated task's gate records no implementation commitments | Add a `## Implementation commitments` checkbox list (warning only — never blocks) |
| [`PHASE_DOCS_WRITE_NO_DOC_CHECK`](#phase_docs_write_no_doc_check-from-plan-lint---include-quality) | A not-done phase writes public docs but runs no doc check | Add `pnpm check:docs` to the phase's verification.commands (warning only) |
| [`TASK_CONTEXT_PACK_LARGE`](#context-fit-advisories-from-plan-lint---include-quality) | Natural context pack > balanced budget (60000 bytes) | Consider a wider profile or review task scope (advisory only) |
| [`TASK_CONTEXT_BUDGET_UNACHIEVABLE`](#context-fit-advisories-from-plan-lint---include-quality) | Recommended budget below the achievable floor | Use a wider profile or split the task (advisory only) |
| [`TASK_DECLARED_DECISION_LARGE`](#context-fit-advisories-from-plan-lint---include-quality) | A `decision_refs` body > tight budget (30000 bytes) | Split follow-up tasks or confirm scope (advisory only) |
| [`TASK_READS_MATCH_TOO_MANY`](#context-fit-advisories-from-plan-lint---include-quality) | A `reads` glob matches > 100 files | Narrow the glob if the task can be scoped (advisory only) |
| [`TASK_READS_NO_MATCH`](#task_reads_no_match-from-plan-lint) | A task `reads` glob matches no live file (often after renaming/merging a referenced source file) | If the file moved, `plan sync-paths --rename "<old>=<new>" --write`; if it's gone, drop the entry |
| [`EVENT_FILE_ID_MISMATCH`](#event_file_id_mismatch-from-doctor--plan-lint) | A per-event ledger file's content doesn't match its content-addressed name (corrupt / hand-edited) | Restore from git or remove the file named in the message, then re-run |
| [`PROGRESS_EVENT_CONFLICT`](#progress_event_conflict-from-doctor--plan-analyze) | Incompatible same-task lifecycle events (e.g. two branches both `done` a task) | Reconcile the conflicting event(s) for the named task |
| [`CONTROL_PLANE_GITIGNORED`](#control_plane_gitignored-from-doctor) | A `.gitignore` rule keeps part of the shared control plane off git, so collaboration silently breaks | Narrow the `.gitignore` to the local-only subset and commit the shared control plane (project.yaml, profiles, baselines, state/events/) |
| [`DUPLICATE_PHASE_ID`](#duplicate_phase_id-from-plan-lint--doctor) | Two phase files claim the same `P<N>` id (often a clean-but-wrong branch merge) | Renumber one phase + its roadmap entry, then re-run `plan lint` |
| [`DUPLICATE_TASK_ID`](#duplicate_task_id-from-plan-lint--doctor) | One task id appears in two phases | Renumber one task (+ refs to it), then re-run `plan lint` |
| [`PHASE_ID_MISMATCH`](#phase_id_mismatch-from-plan-lint--doctor) | A phase file's inner `id:` differs from its roadmap entry | Make the two ids match, then re-run `plan lint` |
| [`AMBIGUOUS_PHASE_ID`](#ambiguous_phase_id-and-ambiguous_task_id-fail-closed-id-resolution) | A command resolved a phase id that two files claim — fails closed (exit 2) | Resolve the duplicate (see `data.phases`), then retry |
| [`AMBIGUOUS_TASK_ID`](#ambiguous_phase_id-and-ambiguous_task_id-fail-closed-id-resolution) | A command resolved a task id that two phases claim — fails closed (exit 2) | Resolve the duplicate (see `data.phases`), then retry |

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

## `TASK_READS_NO_MATCH` from `plan lint`
A task's `reads` glob matches no file on disk. `plan lint --include-quality --strict` (a CI gate) promotes this warning to a failure. It fires after you rename, merge, or delete a source file that a phase — often a **done, historical** one — still lists in its `reads` (or `writes`): the phase's recorded file surface and the live tree have diverged.

If the file **moved or was merged**, redirect the stale entries with an explicit old=new rename map. Repeat `--rename` per move; entries that collapse to the same path are de-duplicated. Dry-run first, then apply:

```sh
code-pact plan sync-paths --rename src/old.ts=src/new.ts --json          # preview (writes nothing)
code-pact plan sync-paths --rename src/old.ts=src/new.ts --write --json  # apply
code-pact plan lint --include-quality --strict --json                    # confirm green
```

The map is explicit by design: a moved file can be a rename, a merge, or a split, none of which is recoverable from git heuristics, so you state the intent. `plan sync-paths` only rewrites `reads` / `writes` of tasks under `design/phases/`; it never touches CHANGELOG or RFC prose. If the file is **gone for good**, remove the entry from the phase YAML by hand.

## `VERIFICATION_FAILED` from `task complete` (or standalone `verify`)

A deterministic completion check did not pass. `task complete` runs two checks — `commands` (the phase's `verification.commands`) and `decision` (the `requires_decision` ADR gate) — so `VERIFICATION_FAILED` is **not** only a command failure.

**Read `error.cause_code` first — you usually don't need to re-run `verify`.** On `task complete`, the `VERIFICATION_FAILED` envelope carries an additive `error.cause_code` and an actionable `error.message`:

- `error.cause_code: "COMMANDS_FAILED"` → a verification command failed. `error.message` embeds the failing command's reason. Fix the command (or, if the command itself is wrong — typo, missing dependency — edit `design/phases/<phase>.yaml` `verification.commands`), then re-run.
- `error.cause_code: "DECISION_REQUIRED"` → the task `requires_decision` and no **accepted** ADR resolves the gate. `error.message` says an accepted ADR is required. Write/accept the ADR (see [`DECISION_REQUIRED` from `task record-done`](#decision_required-from-task-record-done) for the gate semantics), then re-run. `error.code` stays `VERIFICATION_FAILED` at exit 1 (the full structured `DecisionRequiredData` block only appears on `task record-done`).

```sh
code-pact verify --phase <phase-id> --task <task-id>
# Runs the same checks stand-alone so you can read the full output.
# No progress event is recorded when verify fails; re-run task complete
# after fixing the underlying issue.
```

**`data` detail.** The `task complete` failure envelope carries `failed_checks`, `first_failure: { name, reason }`, and `suggested_next_command` under `data`, alongside `data.verify.checks`. The same three summary fields also appear on the `task finalize` failure envelopes (`TASK_FINALIZE_NOT_ELIGIBLE`, `TASK_FINALIZE_WRITE_REFUSED`, `WRITES_AUDIT_STRICT_FAILED`) — but `finalize` does **not** run verify, so there is no `data.verify.checks` there; the summary sits alongside the finalize-specific `data` instead (e.g. `data.write_audit` on `WRITES_AUDIT_STRICT_FAILED`, `data.current` / `data.phase_id` on `TASK_FINALIZE_NOT_ELIGIBLE`). Human (non-`--json`) output leads with the actionable cause headline (the `cause_code` message above — no longer a generic line) and prints `cause:` and `rerun after fixing:` lines below it. `suggested_next_command` is the command to rerun **after fixing** `first_failure` — not a hint that re-running unchanged will pass.

## `TASK_FINALIZE_NOT_ELIGIBLE` from `task finalize`
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

# Alternative: `task runbook` returns the same diagnosis plus
# the recommended next step inline (no manual state interpretation).
code-pact task runbook <task-id> --json
# Read data.state_summary + data.next_steps[0].command.
```

`task finalize` deliberately refuses ineligible cases instead of guessing. Every legitimate path through the state machine ends in a `done` event, which is the precondition for finalization.

## `TASK_FINALIZE_WRITE_REFUSED` from `task finalize --write`
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

## `PHASE_RECONCILE_WRITE_REFUSED` from `phase reconcile --write`
Every eligible task write was refused for safety reasons. Partial successes (one or more applied + one or more refused) return exit 0 — this code only fires when the whole batch failed. `data.skipped_writes[]` carries per-task refusal detail in the same `reason` enum as `TASK_FINALIZE_WRITE_REFUSED` above.

```sh
code-pact phase reconcile <phase-id> --json
# Re-run in dry-run mode to inspect the per-task verdicts. Fix the
# underlying cause (unparseable phase file is the most common) and
# re-run with --write.

# Alternative: `phase runbook` returns the same per-task verdicts
# plus the recommended next steps (blocked / manual_review / reconcile
# batch / primary loop / phase-status advisory).
code-pact phase runbook <phase-id> --json
```

If `data.tasks[]` shows every flip candidate has the same refusal reason, the issue is the phase file itself, not individual tasks — fix it once and reconcile will proceed for all of them.

## `DECISION_PRUNE_NOT_ELIGIBLE` from `decision prune`
The target decision record cannot be retired. `decision prune` is dry-run today, so this is always advisory — nothing is deleted. `data.blocks[]` lists **every applicable** failing gate so you can resolve them together (the link-rewrite gates below are only evaluated once the target itself is a readable, accepted, top-level record — a `target_*` failure short-circuits them):

```sh
code-pact decision prune design/decisions/<name>.md --json
# data.blocks[].gate is one of:
#   target_invalid / target_missing / target_unreadable
#     → the target is not a readable, top-level, real design/decisions/*.md file
#   plan_artifacts_unreadable
#     → design/roadmap.yaml or a referenced design/phases/*.yaml could not be read,
#       so prune cannot prove every referencing task is done; fix the plan graph first
#   link_rewrite_unsupported
#     → a doc links to the decision with a reference-style link ([t][label] + [label]: …)
#       — convert it to an inline link [t](…); OR a markdown link to the decision sits
#       inside the append-only PRUNED.md ledger — remove that link by hand (the ledger
#       is never rewritten)
#   link_rewrite_scan_unreadable
#     → a doc source under the scanned surface could not be read, so the rewrite
#       plan would be incomplete; fix/remove the unreadable file
#   target_not_accepted
#     → only an accepted decision is prunable; a proposed/draft/rejected/
#       superseded/empty/unknown one is not (data.blocks[].status names it)
#   referencing_task_not_done
#     → a not-`done` task still references it (finish or re-scope that task)
#   open_commitments
#     → check off (or remove) the `## Implementation commitments` items
#   live_decision_depends / dependency_status_unknown
#     → a proposed/draft (or typo'd-status) decision links to it; settle that
#       decision first, or fix its status line
#   decision_scan_unreadable / dependency_unreadable
#     → a file under design/decisions/ could not be read (e.g. a directory
#       named *.md); fix the tree so the scan can complete
```

When `data.eligible` is `true` but `data.referencing_tasks` is empty, prune cannot prove the decision was shipped through a task reference — confirm it is genuinely retired, not an unconnected record, before relying on it.

## `LOCK_HELD` from a lock-covered mutation
Another `code-pact` mutation is in progress on the same project. The advisory write lock (`.code-pact/locks/write.lock`) is held by the process whose details appear in the envelope:

```json
{
  "ok": false,
  "error": { "code": "LOCK_HELD", "message": "Another code-pact mutation is in progress: phase reconcile P3 --write (pid: 12345, host: laptop.local, started: 2026-05-21T10:15:00.000Z). ..." },
  "data": {
    "lock_holder": { "pid": 12345, "hostname": "laptop.local", "cmd": "phase reconcile P3 --write", "created_at": "2026-05-21T10:15:00.000Z" },
    "lock_path": "/path/to/.code-pact/locks/write.lock"
  }
}
```

**Normal case — another command is running.** Wait for the holder to release (the lock is created/released within a single CLI invocation) and re-run. The lock is transient by design; LOCK_HELD belongs in the retry-on-transient list for any orchestration that runs multiple `code-pact` commands in parallel.

**Stale-lock case — the holder is gone.** A prior `code-pact` process crashed (SIGKILL, OOM, OS reboot) without releasing the lock. code-pact does NOT auto-detect this; recovery is manual and intentionally conservative:

1. Verify no `code-pact` process is running (check `ps` / `pgrep` for the `pid` in `data.lock_holder.pid`; on a different host, check `data.lock_holder.hostname` matches yours).
2. **Only when certain no process holds it**, delete the lock file: `rm .code-pact/locks/write.lock`.
3. Re-run the command.

Do not blindly delete the lock file just because LOCK_HELD fired — if a concurrent mutation IS in progress, deleting the lock undermines the guarantee. The conservative manual-recovery default deliberately favours wait-and-retry over automation, because automated stale detection is subtle (two processes can both decide the other is stale and clobber a real lock).

Read-only commands (`status`, `plan lint`, `plan analyze`, `task runbook`, `phase runbook`, `validate`, `doctor`, `recommend`, `task context`, `task status`) do NOT acquire the lock and can be used to observe project state while a mutation is pending.

See [`docs/concepts/governance.md`](concepts/governance.md) for the governance walkthrough and [`docs/cli-contract.md` § Advisory write lock](cli-contract.md#advisory-write-lock-v15--p14) for the full acquisition-point matrix.

## `CONFIG_ERROR` from `phase add --id TUTORIAL` / `phase import` containing `TUTORIAL`
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

If you genuinely want a phase named `TUTORIAL` for a non-tutorial purpose, **pick a different id**. The block uses the existing `CONFIG_ERROR` envelope — no new error code ships for this. The error message names the reserved id and points back at `init --sample-phase` as the sanctioned path. Existing projects with a TUTORIAL phase are untouched; the block only fires on new creation. See [`docs/concepts/sample-phase.md`](concepts/sample-phase.md#tutorial-is-a-reserved-phase-id) for the user-facing rules.

## `ADAPTER_GENERATOR_STALE` from `adapter doctor` / global `doctor`

Your adapter manifest's `generator_version` field doesn't match the installed code-pact version **and** the generated adapter output the current CLI would produce no longer matches the manifest.

A stale `generator_version` on its own is **silent**: a no-op patch bump that changes nothing about your generated adapter files does not raise this warning, so you are not nagged to run `adapter upgrade` for a re-stamp that would touch no managed content. The warning fires only when the desired output has actually drifted (or when the agent profile can't be read, so equivalence can't be proven — in which case it is kept conservatively).

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

`BRIEF_MISSING` and `CONSTITUTION_PLACEHOLDER` do **not** fire on a fresh project — both are gated on a real (non-`TUTORIAL`) phase existing, so they stay quiet until the project has started real work. Once a phase exists, `BRIEF_MISSING` fires if `design/brief.md` is still absent (it is optional — `init` never creates it) and `CONSTITUTION_PLACEHOLDER` fires if the constitution is still the template. Resolve both from CI with the non-interactive `plan brief` / `plan constitution` modes (`--from-file <yaml>`, `--stdin`, or the flag forms — see [maintainers/operations.md § Non-interactive `plan brief` / `plan constitution`](maintainers/operations.md#non-interactive-plan-brief--plan-constitution-v16-p17)).

These are intentionally warnings, not errors — `validate` still exits 0. CI scripts that require a clean run can either fix the underlying state or pass `--strict` only after deciding to treat them as failures.

A separate `STATUS_DRIFT done-but-design-not-done` warning from `plan analyze --json` is also expected after any `task complete` until the design YAML's `status` field is flipped to `done`. `task complete` records progress, but does not mutate design intent. `code-pact task finalize <task-id> --write` (single task) or `code-pact phase reconcile <phase-id> --write` (whole phase) mechanizes the flip; the warning's `details.remediation` field carries the exact command. `code-pact task runbook <task-id> --json` (single task) or `code-pact phase runbook <phase-id> --json` (whole phase) also surfaces the same recommendation — runbook is read-only and never executes anything. See [maintainers/operations.md § `task complete` vs `design/`](maintainers/operations.md#task-complete-vs-design-v10-contract), [`docs/concepts/finalization-reconciliation.md`](concepts/finalization-reconciliation.md), and [`docs/concepts/runbook.md`](concepts/runbook.md).

## `DECISION_REQUIRED` from `task record-done`
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

The gate is the same one `verify` and `task complete` enforce, and it reads the ADR's status (see the [decision-gate concept](concepts/decision-gate.md)). To generate `proposed` stubs to fill in, import with `--scaffold-decisions`.

## `ADR_STATUS_UNRECOGNIZED` from `plan lint --include-quality`
An ADR in `design/decisions/` declares a status word the gate doesn't recognize — almost always a typo like `**Status:** acceptd`. The gate treats an unrecognized status as **not accepted**, so the decision stays blocked even though you meant to accept it. Advisory only (`affects_exit: false`); never fails the lint.

```sh
code-pact plan lint --include-quality --json
# → issues[] entry with code ADR_STATUS_UNRECOGNIZED
# details.status        — the offending word (e.g. "acceptd")
# details.status_source — "frontmatter" or "bold-line": which one to fix
```

Recovery: fix the status word to one of `accepted` / `proposed` / `draft` / `rejected` / `superseded`. `details.status_source` tells you whether the typo is in the YAML frontmatter `status:` or the body `**Status:**` line (frontmatter wins when both are present).

## `CONTROL_PLANE_NOT_DRIVEN` from `doctor`
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

## `CONTROL_PLANE_BRANCH_NOT_DRIVEN` from `doctor` / `validate --base-ref`
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

## `ADR_ACCEPTED_BODY_THIN` from `plan lint --include-quality`
An `accepted` ADR in `design/decisions/` has an empty-stub body — an accepted decision with no recorded reasoning. The check is **structure-independent** (no heading-name matching): it fires only when the substantive body (frontmatter removed, status line + h1 title stripped, whitespace normalized) is below an internal threshold **and** the body has zero `##` (h2) headings. So a short-but-structured or long-but-heading-free ADR never fires. Advisory only (`affects_exit: false`); it does not change the decision gate.

```sh
code-pact plan lint --include-quality --json
# → issues[] entry with code ADR_ACCEPTED_BODY_THIN
# details.body_chars     — substantive body length measured
# details.heading_count  — number of h2 headings found (0 to fire)
```

Recovery: add the decision and its rationale to the ADR body, or — if it isn't actually decided yet — revert its `**Status:**` to `proposed` (then the [decision gate](concepts/decision-gate.md) correctly blocks completion until it's accepted with real content). A file that is just a `**Status:** accepted` line is exactly the stub this surfaces; a 0-byte empty file and `proposed`/`draft` ADRs are not flagged.

## `ADR_COMMITMENTS_EMPTY` from `plan lint --include-quality`
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

## `PHASE_DOCS_WRITE_NO_DOC_CHECK` from `plan lint --include-quality`
A **not-yet-`done`** phase has a task whose `writes` includes a public doc that `pnpm check:docs` guards (a `docs/**` file or a root-level public `.md`), but the phase's `verification.commands` run no doc check. The phase will edit public docs without verifying them — exactly the docs-drift this guard exists to stop.

This is a **warning, not a blocker**: `affects_exit: false`. CHANGELOG.md is excluded (it is not scanned by `check:docs`), `design/**` is excluded (validated by `validate` / `plan lint`), and `done` phases are never flagged (it is a forward-looking guard — a frozen phase can't be changed).

```sh
code-pact plan lint --include-quality --json
# → issues[] entry with code PHASE_DOCS_WRITE_NO_DOC_CHECK
# file              — the phase YAML path
# phase_id / task_id — the phase and the task whose writes triggered it
# details.doc_write — the offending public-doc write target
```

Recovery: add a doc check (`pnpm check:docs`, or `check:doc-links` / `check:doc-invariants`) to the phase's `verification.commands` so the doc edits are verified; or, if the declared doc write is stale, remove it from the task's `writes`.

## Context Fit advisories from `plan lint --include-quality`
The four Context Fit advisories flag likely **context-size risk** before a task runs. They appear **only** under `--include-quality`, are **absent** without it, and every one is `affects_exit: false` — they never change the exit code, even under `--strict`. Thresholds are deterministic byte/count values; the pass is local and deterministic (no model / tokenizer / summarization / compression / network), changes no context pack content, and applies no budget automatically.

These are **readiness signals, not correctness failures**. A large context pack, a large declared decision, or a broad `reads` glob can all be legitimate — the advisories help you notice size risk early, not block work or force premature micro-optimization.

```sh
code-pact plan lint --include-quality --json
# → issues[] entries (all affects_exit: false)
```

- **`TASK_CONTEXT_PACK_LARGE`** — the task's **natural** (pre-elision) context pack exceeds the `balanced` budget (60000 bytes). `details.natural_bytes` / `details.threshold_bytes` / `details.recommended_profile` (`"wide"`). Reuses the `natural_bytes` explain metric. Recovery (optional): pass `--context-budget wide` when building the pack, or split the task if its scope is genuinely too broad. Needs a resolvable project `default_agent` for the pack build; skipped otherwise.
- **`TASK_CONTEXT_BUDGET_UNACHIEVABLE`** — the deterministically recommended budget (the default agent's same-name `context_budget` override when available, else the built-in fallback — the same byte value `recommend` surfaces) cannot fit even after maximal eligible elision: `minimum_achievable_bytes > budget_bytes`. `details.profile` / `details.budget_bytes` / `details.minimum_achievable_bytes` (the **same floor `CONTEXT_OVER_BUDGET` reports**). Recovery (optional): use a wider profile or split the task. It does not change the recommendation or fail lint. Needs a resolvable `default_agent`; skipped otherwise.
- **`TASK_DECLARED_DECISION_LARGE`** — a `decision_refs` entry points to a decision body larger than the `tight` budget (30000 bytes), large enough to dominate a tight pack. `details.path` / `details.bytes` / `details.threshold_bytes`. This is **not** an ADR-quality error — do not delete the ADR; consider splitting follow-up tasks, using a wider profile, or confirming the task scope justifies the large reference. Unsafe/missing refs are reported by `TASK_DECISION_REF_UNSAFE_PATH` / `TASK_DECISION_REF_NOT_FOUND` instead.
- **`TASK_READS_MATCH_TOO_MANY`** — a `reads` glob matches more than 100 files and may inflate context planning cost. `details.glob` / `details.match_count` / `details.threshold_count`. Recovery (optional): narrow the glob if the task can be scoped more precisely. Broad reads can be valid for cross-cutting refactors.

## `EVENT_FILE_ID_MISMATCH` from `doctor` / `plan lint`
A per-event progress-ledger file under `.code-pact/state/events/` failed the
filename↔content invariant. The filename is `<at-compact>-<id>.yaml`, where the
`<id>` suffix is the sha256 content id and the `<at-compact>` prefix is the
event's normalized `at`. The check fails when any of these disagree: the
recomputed content id does not match the filename's id suffix, the event's `at`
does not match the filename prefix, or its stored `id` disagrees with the
recomputed content id. This is fail-closed — a corrupt, partial, or hand-edited
event file is never read or written over silently.

```sh
# The message names the offending file, e.g.
#   Event file 2026…-<id>.yaml: content id (<a>) does not match filename id (<b>)
git checkout -- .code-pact/state/events/<file>   # restore it if it was committed
# or, if it is a stray / corrupt local file:
rm .code-pact/state/events/<file>
```

Do **not** hand-edit event files — they are content-addressed: the filename
embeds the event's timestamp prefix and the sha256 content id suffix
(`<at-compact>-<id>.yaml`). To change recorded progress, append a new event
via the `task` verbs. On the strict-loader commands the same corruption surfaces
as a command failure — `plan analyze` → `PLAN_ANALYZE_FAILED`, `plan migrate` →
`PLAN_MIGRATE_FAILED`, `task *` / `verify` abort — with this diagnostic carried in
`error.message`.

## `PROGRESS_EVENT_CONFLICT` from `doctor` / `plan analyze`
The merged ledger contains incompatible lifecycle events for one task — e.g. two
branches that each recorded `done` for the same task, a second `started` while it
was already `started`, or a `done` / `blocked` with no intervening `resumed`. The
reducer still derives a state, but the conflict is **surfaced, not silently
resolved**.

```sh
code-pact doctor --json | jq '.data.issues[] | select(.code=="PROGRESS_EVENT_CONFLICT")'
# Inspect details.events[] for the named task, decide which event is correct,
# then remove or correct the other. For a per-event ledger entry find the file as
# .code-pact/state/events/*-<event_id>.yaml; for a legacy ledger, reconcile the
# matching entry in .code-pact/state/progress.yaml — then re-run doctor / plan
# analyze to confirm.
```

**Who collided.** The issue carries a
structured `details.events[]` naming the conflicting side(s) — `{ event_id,
status, author?, at }` (usually two, the establishing event and the offender; one
when the first event for a task is itself invalid) — so you (and an agent) see
*who* produced each event without opening the files (`author` is omitted for
legacy / capture-off events). `event_id` is the **content id**, and where the
offending event lives depends on the ledger:

- **Per-event ledger** — `event_id` is the *suffix* of the filename `<at-compact>-<event_id>.yaml`, not the whole name; locate it with `.code-pact/state/events/*-<event_id>.yaml`.
- **Legacy `.code-pact/state/progress.yaml`** — there is **no** per-event file; reconcile the matching entry in `progress.yaml` (or migrate the legacy ledger first).

The same conflict also shows up in the team overview:

```sh
# Same facts, from the activity overview (PROGRESS_EVENT_CONFLICT only):
code-pact status --json | jq '.data.conflicts[]'
# Each side: { event_id, status, author?, at }. Decide which is correct, then
# remove/correct the other event — for a per-event ledger entry the file is
# .code-pact/state/events/*-<event_id>.yaml; for a legacy ledger, the matching
# entry in .code-pact/state/progress.yaml — and re-run.
```

Advisory by default (`severity: warning`); `validate --strict` promotes it to a
failure so CI can gate on it. It is **not** auto-resolved because a same-task
concurrent edit is a genuine collaboration conflict a human should adjudicate.

## `CONTROL_PLANE_GITIGNORED` from `doctor`
Your `.gitignore` keeps part of the shared control plane out of git. The
`message` names which areas — any of `project.yaml`, `agent-profiles/`,
`model-profiles/`, `state/baselines/`, or `state/events/` (the progress ledger).
Whatever it names **never reaches git**, so that state stays local: a teammate or
a clean checkout misses whatever is ignored — project config, profiles,
baselines, or the progress ledger. **If the ledger itself is ignored**, the
`CONTROL_PLANE_BRANCH_NOT_DRIVEN` CI gate *also* silently skips because it has no
tracked ledger to read (a config/profile/baseline-only ignore does not affect
that gate).

The usual cause is a **blanket `/.code-pact/` ignore**, but a **file-scoped** rule
like `/.code-pact/state/events/*.yaml` is just as dangerous — the `events/`
directory is not ignored, yet every *new* event file is. `init` *merges* its
narrow entries into an existing `.gitignore` and **never deletes your lines**, so a
pre-existing rule survives and overrides them. `doctor` reports this
authoritatively: it asks git (`git check-ignore --no-index`) for a representative
*file* in each shared area, so a force-added `.gitkeep` does not mask it and a
`!`-negation re-include is honoured.

```sh
# Confirm the diagnosis the same way doctor does (rule-based, index-independent).
# Probe a representative NEW file in each shared area — exit 0 prints the ignored ones:
git check-ignore --no-index \
  .code-pact/project.yaml \
  .code-pact/agent-profiles/x.yaml \
  .code-pact/model-profiles/x.yaml \
  .code-pact/state/baselines/x.json \
  .code-pact/state/events/19700101T000000Z-x.yaml
# (no output + exit 1 = nothing ignored = ok)
```

Add `-v` to see *which* rule matches, but read it carefully: a printed `!`-negation
line can mean a path is actually **re-included** (not ignored). `code-pact doctor`
(`CONTROL_PLANE_GITIGNORED`) is the authority — it interprets negations the same way.

Fix it by **narrowing** the rule yourself (neither `init` nor `doctor` edits your
`.gitignore`). Keep only the local/derived subset ignored:

```gitignore
/.code-pact/locks/
/.code-pact/cache/
/.local/
/.context/
```

Remove or narrow the offending rule (the blanket `/.code-pact/` line, or the
file-scoped one the `-v` output named), then commit the shared state
(`project.yaml`, `agent-profiles/`, `model-profiles/`, `state/baselines/`,
`state/events/`) and re-run `code-pact doctor` to confirm. See the shared-vs-local
table in [State file write guarantees](cli-contract.md#state-file-write-guarantees).

Advisory (`severity: warning`): `doctor` and default `validate` do not fail on
it, but `validate --strict` promotes it to exit-relevant (like other doctor
warnings), so CI can gate on it. If the repo is intentionally solo/throwaway,
silence it via `.code-pact/doctor.yaml` (`disabled_checks: [CONTROL_PLANE_GITIGNORED]`).

## Id collisions & mismatches (collaboration)

These are the **clean-but-wrong merge** class: two contributors on separate
branches each mint the same `P<N>` / `P<N>-T<M>` id in separate files, git
auto-merges with no conflict, and the corruption only surfaces when a check runs.
They are **errors** (they fail `plan lint` / `doctor` by default — no `--strict`
needed), and each now carries a structured `recovery` object (`recovery.manual_action`
= the edit, `recovery.confirm` = the re-verify command, `recovery.reference`) in
JSON so an agent can act without parsing prose. The manual fix is always the same
shape: **give one of the colliding things a unique id, update anything that
references it, then re-run the check.**

### `DUPLICATE_PHASE_ID` from `plan lint` / `doctor`

Two roadmap entries (and their phase files) claim the same phase id — e.g. both
branches minted `P7`. The message names both files.

```sh
code-pact plan lint --json | jq '.data.issues[] | select(.code=="DUPLICATE_PHASE_ID")'
# .recovery.manual_action names the exact edit; .recovery.confirm is the re-verify
# command; .file is one colliding file.
```

Fix: pick one phase, give it a unique id — edit its `id:` field and update its
entry in `design/roadmap.yaml` (rename the file/path too if the filename embeds
the old id or to keep the `<id>-<slug>.yaml` convention). If that phase has tasks
whose ids use the **old phase prefix** (e.g. `P7-T1`), rename those task ids too
and update any `depends_on` that references them — then re-run
`code-pact plan lint` and address any follow-up `TASK_ID_PHASE_PREFIX` /
`DUPLICATE_TASK_ID`. If the two files are actually the **same** phase merged from
two branches, delete the duplicate file and its roadmap entry instead of
renumbering.

### `DUPLICATE_TASK_ID` from `plan lint` / `doctor`

One task id appears under two phases. The message names both phases **and their
files** — the file path disambiguates the compound case where two phase files
also share a phase id (in that case, fix `DUPLICATE_PHASE_ID` first).

Fix: renumber one task — change its `id:` under that phase's `tasks:`, **and any
`depends_on` entry (in any task) that references the old id**. Note `decision_refs`
/ `acceptance_refs` are **file paths**, not task-id references — only touch them if
a path intentionally embeds the old id. If **progress events already exist** for
the duplicated id, check which task they belong to *before* editing — do not
blindly rewrite event files. Then re-run `code-pact plan lint`. If the task was
duplicated by a merge, delete the redundant copy instead.

### `PHASE_ID_MISMATCH` from `plan lint` / `doctor`

A phase file's inner `id:` does not match the id the roadmap uses to reference it
(`<file> has id="<actual>" but roadmap expects "<expected>"`) — usually a phase
file cloned without updating its id, or a half-resolved merge.

Fix one of the two to agree: set `id: <expected>` inside the file, **or** change
that file's entry id in `design/roadmap.yaml` to `<actual>`. Then re-run
`code-pact plan lint`.

### `AMBIGUOUS_PHASE_ID` and `AMBIGUOUS_TASK_ID` (fail-closed id resolution)

A command tried to **resolve** an id that two files (phase) or two phases (task)
claim, and **failed closed** (exit 2) rather than silently acting on the first
match. The colliding locations are in **`data.phases[]`**
(`AMBIGUOUS_TASK_ID`: the phase ids that both define the task; `AMBIGUOUS_PHASE_ID`:
the phase file paths).

```sh
code-pact task prepare P7-T1 --agent claude-code --json | jq '{error, data}'
# { "error": { "code": "AMBIGUOUS_TASK_ID", "message": "..." },
#   "data": { "phases": ["P3","P7"] } }
```

This is a symptom of an unresolved `DUPLICATE_PHASE_ID` / `DUPLICATE_TASK_ID`:
resolve that first (sections above) — renumber the duplicate and re-run
`code-pact plan lint` until clean — then retry the original command. The tool
refuses to guess which one you meant, by design.
