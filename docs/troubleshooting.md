# Troubleshooting

When a command surfaces one of the diagnostic codes below, this page maps it to the typical recovery action. The full per-code reference is in [`docs/cli-contract.md` § Error codes](cli-contract.md#error-codes); for the project walkthrough these examples are drawn from, see [dogfood.md](dogfood.md). Unfamiliar with a term? See the [glossary](glossary.md).

## `MANIFEST_NOT_FOUND` from `adapter upgrade --check` / `--write`

You haven't run `adapter install <agent>` yet, or the per-agent manifest at `.code-pact/adapters/<agent>.manifest.yaml` was deleted.

```sh
code-pact adapter install <agent>
# then re-run the upgrade.
```

Distinct from the `ADAPTER_MANIFEST_MISSING` *warning* surfaced by `adapter doctor` for the same root cause — `adapter doctor` is read-only and never fails on a missing manifest; the upgrade commands need a manifest to do their job.

## `INVALID_TASK_TRANSITION` from `task start` / `block` / `resume` / `complete`

The current state derived from `progress.yaml` doesn't allow the requested transition. The most common case is `task complete` against a `blocked` task — the task must be `resume`d first so the `resumed` event records the unblock decision.

```sh
code-pact task status <task-id> --json
# Read data.current; see docs/cli-contract.md § task * for the
# allowed-transitions table.

code-pact task resume <task-id>   # if currently blocked
code-pact task complete <task-id>
```

## `PLAN_NORMALIZE_REQUIRED` from `plan normalize --check`

A file under `design/` or `.code-pact/state/progress.yaml` has trailing whitespace, CRLF line endings, or a missing/extra final newline.

```sh
code-pact plan normalize --write
# Idempotent. Comments and Markdown hard line breaks are preserved.
```

`plan normalize --write` is the apply-mode counterpart to `--check`. Passing both at once is a `PLAN_NORMALIZE_CONFLICT` (exit 2) so the intent is unambiguous in CI scripts.

## `VERIFICATION_FAILED` from `task complete` (or standalone `verify`)

The phase's `verify.commands` did not pass.

```sh
code-pact verify --phase <phase-id> --task <task-id>
# Runs the same commands stand-alone so you can read the failure
# output directly. progress.yaml is NOT mutated when verify fails;
# you can re-run task complete after fixing the underlying issue.
```

If the verify command itself is wrong (typo, dependency missing) rather than the task's implementation, edit `design/phases/<phase>.yaml` `verification.commands` and re-run.

## `TASK_FINALIZE_NOT_ELIGIBLE` from `task finalize` (v1.2+)

The task's derived state from `progress.yaml` is not `done`, so flipping its design YAML status would create a worse drift (design says done, progress says otherwise). The check fires in **both** dry-run and `--write` — dry-run means "won't write", not "won't validate".

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

Your adapter manifest's `generator_version` field doesn't match the installed code-pact version. This is the expected state after upgrading the CLI (`0.9.0-alpha.0` → `1.0.0` is the v1.0 case).

```sh
code-pact adapter upgrade <agent> --check --json
# Read plan[] — managed-clean files appear as action:update,
# managed-modified files as action:refuse.

code-pact adapter upgrade <agent> --write
# Safe for managed-clean. Refuses managed-modified unless you also
# pass --accept-modified (the only flag that overwrites local edits).
```

See [`docs/upgrading.md`](upgrading.md) for the upgrade path (the alpha-era detail is archived in `migration.md`).

## Expected warnings after a non-interactive bootstrap

If you ran `code-pact init --non-interactive --agent <agent> --locale <locale>` from CI or a script, the project skips the brief / constitution wizards and does not pin a model version. `code-pact validate --json` then reports three warnings as expected state:

| Code | Severity | Why it fires |
|---|---|---|
| `BRIEF_MISSING` | warning | `design/brief.md` does not exist — the non-interactive init does not run `plan brief`. **v1.6+**: resolve from CI with `code-pact plan brief --from-file <yaml>`, `--stdin`, or `--what "..." --who "..." [--differentiator "..."]` (see [dogfood.md § Non-interactive `plan brief` / `plan constitution`](dogfood.md#non-interactive-plan-brief--plan-constitution-v16-p17)). Pre-v1.6: edit it manually, or run `code-pact plan brief` in a TTY. |
| `CONSTITUTION_PLACEHOLDER` | warning | `design/constitution.md` still contains the template text from `init`. **v1.6+**: resolve from CI with `code-pact plan constitution --from-file <yaml>`, `--stdin`, or `--description "..." --principle "..."` (repeatable). Pre-v1.6: edit it manually, or run `code-pact plan constitution` in a TTY. |
| `ADAPTER_STALE` | warning | `adapter install <agent>` was called without `--model <version>`, so the model profile is not pinned. Re-run `adapter install <agent> --model <version>` (e.g. `--model opus-4.7`) to silence. |

These are intentionally warnings, not errors — `validate` still exits 0. CI scripts that require a clean run can either fix the underlying state (recommended for `BRIEF_MISSING` / `CONSTITUTION_PLACEHOLDER`) or pass `--strict` only after deciding to treat them as failures.

A separate `STATUS_DRIFT done-but-design-not-done` warning from `plan analyze --json` is also expected after any `task complete` until the design YAML's `status` field is flipped to `done`. `task complete` records progress, but does not mutate design intent. v1.2+ mechanizes the flip via `code-pact task finalize <task-id> --write` (single task) or `code-pact phase reconcile <phase-id> --write` (whole phase); the warning's `details.remediation` field carries the exact command. v1.3+ also exposes the same recommendation via `code-pact task runbook <task-id> --json` (single task) or `code-pact phase runbook <phase-id> --json` (whole phase) — runbook is read-only and never executes anything. See [dogfood.md § `task complete` vs `design/`](dogfood.md#task-complete-vs-design-v10-contract), [`docs/concepts/finalization-reconciliation.md`](concepts/finalization-reconciliation.md) for the v1.2+ walkthrough, and [`docs/concepts/runbook.md`](concepts/runbook.md) for the v1.3+ walkthrough.
