# CLI Contract

This document is the canonical reference for code-pact's CLI surface
contract. It defines stdout/stderr behavior, JSON output shapes, exit
codes, error codes, TTY/CI detection, and interactive-mode rules.

The contract is part of the public API. Breaking changes here require
a version bump and a migration note.

## Quick reference

The 90% you reach for first; each link jumps to the full section below.

**Exit codes** — `0` success · `1` a check failed (e.g. verification) · `2` usage / config error · `3` internal error. Full table: [Exit codes](#exit-codes).

**JSON envelope** — every `--json` command emits exactly one of these to stdout:

```json
{ "ok": true,  "data": { ... } }
{ "ok": false, "error": { "code": "...", "message": "..." }, "data": { ... } }
```

Some documented error envelopes carry additive `error` fields — e.g. `error.cause_code` on `task complete` `VERIFICATION_FAILED` (v1.27+, P39). Branch on `error.code`; when `error.cause_code` is documented for a broad code, branch on it too for the root cause. `error.message` must not be parsed.

Details: [JSON output shape](#json-output-shape).

**Most common error codes**

| Code                                                                                   | Exit | When it fires                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | What to do                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONFIG_ERROR`                                                                         | 2    | Bad flag, missing input, or malformed YAML                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Re-check the command's flag surface below                                                                                                                                                                                                                                                                                                                |
| `PARTIAL_MUTATION` (adapter transaction)                                               | 2    | `adapter install` / `adapter upgrade --write` failed after mutating at least one staged file before the durable commit marker. The command attempts rollback and includes `data.committed_paths`, `data.rollback_failures`, `data.backup_paths`, and `data.journal_path` when available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Inspect the listed paths and journal. Re-run `adapter install` / `adapter upgrade --write` only after confirming the working tree state; recovery keeps the journal/backups when rollback is incomplete.                                                                                                                                                 |
| `TRANSACTION_CLEANUP_PENDING` (adapter transaction)                                    | 2    | The adapter transaction reached its durable commit marker and final files are committed, but cleanup of backups/temp files/journal failed. Committed final files are **not** rolled back after this point.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Re-run `adapter install` / `adapter upgrade --write`; startup recovery cleans committed journals and removes leftover backups/temps. If it repeats, inspect `data.cleanup_failures` / `data.journal_path`.                                                                                                                                               |
| `ADAPTER_TRANSACTION_RECOVERY_FAILED`                                                  | 2    | A pending adapter transaction journal in code-pact's user-private state directory could not be recovered or cleaned safely before a new adapter mutation began. The directory defaults under the user state home and may be overridden with absolute `CODE_PACT_STATE_HOME`; legacy project-local journals under `.code-pact/state/adapter-transactions/` are rejected, not executed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Do not delete the journal blindly. Inspect `data.journal_path`, the referenced backup/final files, and repair or restore the project before retrying.                                                                                                                                                                                                    |
| `TASK_NOT_FOUND`                                                                       | 2    | Task id isn't in any phase                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Verify the id (the `P1-T1` form)                                                                                                                                                                                                                                                                                                                         |
| `AMBIGUOUS_TASK_ID`                                                                    | 2    | Same id exists in multiple phases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The message lists them — qualify the id                                                                                                                                                                                                                                                                                                                  |
| `AMBIGUOUS_PHASE_ID`                                                                   | 2    | Same phase id exists in more than one `roadmap.yaml` entry (e.g. two branches both minted it, then merged)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `data.phases[]` lists the colliding files — remove or renumber the duplicate                                                                                                                                                                                                                                                                             |
| `ARCHIVE_BUNDLE_WRITE_FAILED` (v2.0, archive-level compaction — Layer 2/4)             | 2    | `state compact-archive` could not **build**, write, verify, or retire an archive bundle (a non-canonical or Tier-1-invalid member — loose OR an existing bundle member folded into the consolidation — an atomic-write failure, a readback divergence, or a superseded-bundle unlink failure). Emitted by BOTH dry-run (a `build` validation fault, or a `write_bundle` content-address conflict it predicts read-only — either way mutates nothing) and `--write`.                                                                                                                                                                                                                                                                                                                                                                                                    | Read `error.message` + `data.phase` (`build` / `write_bundle` / `verify_bundle` / `retire_bundle`). On `--write`, `data.failed_kind` is the kind being processed when the run stopped and `data.completed_results[]` / `data.partial_applied` say what already applied. Fix the offending record (or remove a stale bundle at the named path) and re-run |
| `DELETE_INTENT_RECOVERY_FAILED` (v2.0, archive-level compaction — Layer 4)             | 2    | The delete-intent recovery AUTHORITY could not be used safely — in EITHER of two shapes (NOT "corrupt journal only"): (a) the journal (`.code-pact/state/archive/delete-intent.json`) is **corrupt** (unreadable / non-canonical), or (b) the journal is **valid+present** but the archive bundles/files it references are missing or their bytes no longer match the committed recovery proof. Surfaced by `state archive-retention --write` / `state archive-maintain --write` (which recover first), AND by `state compact-archive --write`'s refusal on a corrupt pending journal. Fail-closed: NO new compaction/retention plan proceeds — but a valid `present` journal's recovery may already have completed PART of the committed prior delete before failing (a mixed journal's loose unlinks run before its bundle retires), so read `data.partial_applied`. | A blind re-run fails the SAME way — read `data.recovery_failure_kind`: `journal_corrupt` → inspect/repair the journal file; `present_journal_recovery_failed` (`data.journal_status: "present"`) → inspect/repair the referenced archive **bundles/files**, NOT the journal. Either way, do NOT just re-run unchanged                                    |
| `DELETE_INTENT_DURABILITY_FAILED` (v2.0, archive-level compaction — Layer 4)           | 2    | `state archive-retention --write` / `state archive-maintain --write` hit a REQUIRED durability barrier failure deleting a loose pair — a temp/data or directory `fsync` failed (`reason: "failed"` — a real I/O fault). A platform that cannot `fsync` a directory at all (`reason: "unsupported"`) is NOT this error: it defers the pair conservatively.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Read `data.reason` (`failed`), `data.journal_status`, and `data.partial_applied` (a valid `present` journal's recovery may already have completed part of a committed delete before the fault). `data.recovery_pending` says whether a committed journal remains (re-run completes it both-or-neither). Fix the I/O fault and re-run                     |
| `PENDING_DELETE_INTENT` (v2.0, archive-level compaction — Layer 4)                     | 2    | Either (a) a delete-intent journal already exists when a new pair-delete tried to start (a prior crash was not recovered — `state archive-retention --write`'s defensive guard, which recovers first), OR (b) `state compact-archive --write` REFUSED because a journal is pending: compaction is not recovery-first and would retire a crashed bundle-pair's reduced survivor bundle (wedging recovery), so the low-level verb refuses and points to the high-level recovery entry.                                                                                                                                                                                                                                                                                                                                                                                   | `data.recovery_pending` is `true`; run `state archive-maintain --write` — it recovers the pending journal FIRST, then compacts + retains                                                                                                                                                                                                                 |
| `BUNDLE_PAIR_NOT_COMMITTABLE` (v2.0, archive-level compaction — bundle-member removal) | 2    | A bundle-pair removal's PRE-COMMIT reverify found the store no longer matches the plan (an old or survivor bundle is missing / its bytes changed since the plan). Fail-closed BEFORE the journal is written — nothing was mutated, so a re-plan can decide afresh. Surfaced by `state archive-maintain --write` (which orchestrates the bundle-pair removal).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `data.step` names the failing maintenance step, `data.partial_applied` whether anything mutated. Re-run — the apply re-plans from the current store; if it recurs, an external writer is racing the archive (run under the write lock only)                                                                                                              |
| `VERIFICATION_FAILED`                                                                  | 1    | `verify` / `task complete` check did not pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | On `task complete`: read `error.cause_code` — `COMMANDS_FAILED` → fix the command; `DECISION_REQUIRED` → add/accept the ADR; `ABORTED` → re-run after the cancellation source is cleared. On standalone `verify`: `ABORTED` is reported as a cause code; otherwise inspect `data.checks`. Then re-run                                                                                                                                                |
| `INVALID_TASK_TRANSITION`                                                              | 2    | Illegal state move (e.g. completing a `blocked` task)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `task resume` first, then complete                                                                                                                                                                                                                                                                                                                       |
| `TASK_FINALIZE_NOT_ELIGIBLE`                                                           | 2    | Task's derived state isn't `done` yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Run `task complete` first                                                                                                                                                                                                                                                                                                                                |
| `LOCK_HELD`                                                                            | 2    | Another mutation is in progress (transient)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Wait and retry; read-only commands are unaffected                                                                                                                                                                                                                                                                                                        |
| `CONTEXT_OVER_BUDGET`                                                                  | 2    | Pack can't fit `--budget-bytes`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Re-run with the returned `data.minimum_achievable_bytes`                                                                                                                                                                                                                                                                                                 |

The complete catalog (Public / Plan / Doctor / Adapter) is in [Error codes](#error-codes).

## Contents

- **Output & exit contract** — [Stdout / stderr](#stdout--stderr) · [JSON output shape](#json-output-shape) · [Exit codes](#exit-codes) · [Error codes](#error-codes)
- **Environment** — [TTY and CI detection](#tty-and-ci-detection) · [`--non-interactive`](#--non-interactive) · [Locale resolution](#locale-resolution) · [State file write guarantees](#state-file-write-guarantees)
- **Planning & import** — [`plan`](#plan) · [`phase import`](#phase-import) · [`spec import`](#spec-import-v18)
- **Per-task lifecycle** — [`task prepare`](#task-prepare--single-per-task-entry-point-v111-p21) · [`task context`](#task-context--context-quality-gates-v051-v11-additions) · [`task start` / `status` / `block` / `resume`](#task-start--task-status--task-block--task-resume-v06) · [`task complete`](#task-complete) · [`task record-done`](#task-record-done--record-completion-without-task-complete-v121) · [`task finalize`](#task-finalize--flip-task-design-status-to-done-v12-p11) · [`task add`](#task-add--append-a-task-to-a-phase-v06-non-interactive-in-v14)
- **Phase-level & sequencing** — [`phase reconcile`](#phase-reconcile--bulk-flip-task-design-statuses-for-a-phase-v12-p11) · [`task runbook`](#task-runbook--read-only-guidance-for-a-single-task-v13-p12) · [`phase runbook`](#phase-runbook--read-only-guidance-for-an-entire-phase-v13-p12)
- **Collaboration** — [`status`](#status--team-activity-overview-v132-collaboration-ux-rfc-d2d3)
- **Adapters & diagnostics** — [`adapter`](#adapter-v09) · [`doctor`](#doctor--plan-quality-checks-v053) · [`recommend`](#recommend-v08)
- **Stability** — [Stability taxonomy (v1.0)](#stability-taxonomy-v10) · [Stability](#stability)

## Command aliases

A few commands have beginner-friendly aliases. Each alias dispatches to the **exact same handler** as its canonical command (same flags, exit codes, JSON envelope, error codes); when an alias is misused, its human-facing error message names the alias and points back at the canonical command.

Canonical names remain the **primary** documented commands and the names emitted by adapters. The aliases are **secondary Stable (v1.x+) public aliases** — once listed here they are public surface you can depend on, so they stay additive and must not diverge semantically from the command they shadow.

| Alias                 | Canonical                                                                         | Reads better as                        |
| --------------------- | --------------------------------------------------------------------------------- | -------------------------------------- |
| `task next <id>`      | [`task runbook`](#task-runbook--read-only-guidance-for-a-single-task-v13-p12)     | "what should I do next on this task?"  |
| `phase next <id>`     | [`phase runbook`](#phase-runbook--read-only-guidance-for-an-entire-phase-v13-p12) | "what should I do next in this phase?" |
| `task reconcile <id>` | [`task finalize`](#task-finalize--flip-task-design-status-to-done-v12-p11)        | verb-consistent with `phase reconcile` |
| `plan import <yaml>`  | [`phase import`](#phase-import)                                                   | it ingests a whole multi-phase roadmap |

This table is the live compatibility contract for the aliases. The historical rationale was recorded in the now-retired **cli-alias-ux RFC** (in git history / the `.code-pact/state` archive record).

## Stdout / stderr

- **stdout** carries the primary command result. In human mode, this is
  formatted text. In JSON mode (`--json` set globally or on the command),
  stdout contains exactly one JSON document per invocation, terminated
  by a newline.
- **stderr** carries human-readable progress logs, errors, and any
  output that would otherwise pollute stdout.
- Child processes invoked by `verify` and similar commands have their
  stdout and stderr captured. Captured output is forwarded to stderr in
  human mode or included inside the JSON `data` envelope in JSON mode.
  It is never written directly to stdout.

> **Trust boundaries.** code-pact distinguishes three, and they are
> deliberately not collapsed into "the plan is trusted, so anything goes":
>
> - **Execution boundary — trusted.** A phase's `verification.commands` are
>   executed through the shell by `verify` and `task complete`. Phase YAML is
>   trusted project configuration, equivalent to a CI script — do not run
>   `verify` / `task complete` against unreviewed plans from untrusted sources.
> - **Path boundary — constrained even when trusted.** Any config value used as
>   a filesystem path (agent-profile `instruction_filename` / `context_dir` /
>   `skill_dir` / `hook_dir`, `agents[].profile`, `decision_refs`) is a
>   project-relative POSIX path: the schema (or `resolveWithinProject` at the
>   read/write site) rejects absolute paths, `..`, `.`, empty segments,
>   backslashes, and symlink escape, so a plan cannot redirect reads or writes
>   outside the project root. Trusted config does not imply unconstrained write
>   destinations.
> - **Identifier boundary — constrained even when trusted.** Task/phase ids and
>   agent names flow into generated command strings and path segments, so the
>   schema constrains them to `^[A-Za-z0-9][A-Za-z0-9._-]*$` (leading char
>   alphanumeric, so an id can never be read as a CLI option like `--json`).

## JSON output shape

`--json` is accepted both before and after the command name. The two
positions are equivalent:

```sh
code-pact --json phase ls
code-pact phase ls --json
```

In JSON mode, every command emits exactly one of these shapes to stdout:

```json
{ "ok": true, "data": { ... } }
{ "ok": false, "error": { "code": "...", "message": "..." }, "data": { ... } }
```

The `data` field on errors is optional and used when the command was
able to compute partial results before failing (for example, `verify`
returning the failed criteria alongside the error code).

The `error` object always contains `code` and `message`. Some documented
envelopes carry **additive** `error` fields beyond those two — e.g.
`error.cause_code` on a `task complete` `VERIFICATION_FAILED` failure
(v1.27+, P39; see [Public cause codes](#public-cause-codes)). Consumers must
not assume `error` has only `code` and `message`, and must not parse
`error.message`; branch only on documented stable fields (`error.code`, and
`error.cause_code` where documented).

## Exit codes

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | Success                                                                    |
| 1    | Verification or check failed (non-fatal command outcome)                   |
| 2    | Usage or configuration error (bad flags, missing inputs, schema violation) |
| 3    | Internal error (unexpected exception, file system failure, bug)            |

A successful operation always exits 0. A command that completes but
reports a logical failure (such as `verify` reporting unmet criteria)
exits 1. Commands invoked with malformed arguments or against an
invalid project structure exit 2. Unhandled exceptions exit 3.

## Error codes

Most stable codes appear in the `error.code` field of the JSON envelope and
in stderr messages, or as `code` on individual diagnostic issues from
`doctor` / `validate` / `plan lint` / `plan analyze` / `adapter doctor`.
A small number are **cause codes** that appear in `error.cause_code` (an
additive sibling of `error.code`) on a documented envelope rather than as a
top-level `error.code` — these are listed in their own table below. All are
stable identifiers that callers can match against.

The full v1.0 surface is anchored by `tests/unit/error-code-surface.test.ts`,
which fails if src/ emits a code that isn't listed below or if a code
listed below is no longer emitted. Codes are partitioned into categories —
adding a new code in `src/` requires updating both the test and the
appropriate table below.

### Public codes (top-level error envelopes)

These appear in `error.code` of `{ok:false, error}` envelopes returned by
the listed commands. They are the primary failure signal for agents and
CI. (For `error.cause_code` values, see [Public cause codes](#public-cause-codes) below.)

| Code                                                                     | Raised by                                                                                                                                                                                                                                                                                                                                                                                                                                         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONFIG_ERROR`                                                           | most commands                                                                                                                                                                                                                                                                                                                                                                                                                                     | Bad flags, missing required input, malformed YAML                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `UNKNOWN_COMMAND`                                                        | top-level dispatch                                                                                                                                                                                                                                                                                                                                                                                                                                | Unrecognized command name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ALREADY_INITIALIZED`                                                    | `init`                                                                                                                                                                                                                                                                                                                                                                                                                                            | `.code-pact/` already exists without `--force`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ALREADY_EXISTS`                                                         | `plan brief`, `plan constitution`                                                                                                                                                                                                                                                                                                                                                                                                                 | Target design file already exists without `--force`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `BASELINE_NOT_FOUND`                                                     | `progress`                                                                                                                                                                                                                                                                                                                                                                                                                                        | Named baseline snapshot missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PHASE_NOT_FOUND`                                                        | `phase show`, `pack`, `verify`, `recommend`, `status`                                                                                                                                                                                                                                                                                                                                                                                             | Phase id not in `roadmap.yaml`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `TASK_NOT_FOUND`                                                         | `pack`, `verify`, `task context`, `task start/block/resume/complete/record-done/status`                                                                                                                                                                                                                                                                                                                                                           | Task id not present anywhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `AMBIGUOUS_TASK_ID`                                                      | `task context`, `task start/block/resume/complete/record-done/status`                                                                                                                                                                                                                                                                                                                                                                             | Same task id exists in multiple phases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `AMBIGUOUS_PHASE_ID`                                                     | `phase show`, `phase reconcile`, `phase runbook`, `pack`, `verify`, `recommend`, `task prepare`, `task context`, `task add`, `status`                                                                                                                                                                                                                                                                                                             | Same phase id exists in more than one `roadmap.yaml` entry; `data.phases[]` lists the colliding files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AGENT_NOT_FOUND`                                                        | `pack`, `adapter *`, `task context`, `task start/block/resume/complete/record-done`                                                                                                                                                                                                                                                                                                                                                               | Agent name not in `project.yaml`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `AGENT_NOT_ENABLED`                                                      | `task context`, `task start/block/resume/complete/record-done`                                                                                                                                                                                                                                                                                                                                                                                    | Agent is configured but has `enabled: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `INVALID_TASK_TRANSITION`                                                | `task start/block/resume/complete/record-done`                                                                                                                                                                                                                                                                                                                                                                                                    | Requested state transition is not allowed from the current state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DUPLICATE_PHASE_ID`                                                     | `phase add`, `phase import`                                                                                                                                                                                                                                                                                                                                                                                                                       | Phase id collides with an existing or imported phase                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `MANIFEST_NOT_FOUND`                                                     | `adapter upgrade`                                                                                                                                                                                                                                                                                                                                                                                                                                 | `.code-pact/adapters/<agent>.manifest.yaml` does not exist (run `adapter install` first)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ADAPTER_MANIFEST_INVALID`                                               | `adapter install`, `adapter upgrade` (also a `doctor` / `adapter doctor` issue)                                                                                                                                                                                                                                                                                                                                                                   | Manifest state is unusable. As a **top-level** envelope (exit 2): manifest I/O was fail-closed because `.code-pact/adapters` resolves **outside** the project (a symlink escape — `resolveWithinProject` refused it; no bytes are read or written outside the project). The same code is also emitted as a `doctor` issue for a manifest that failed YAML parse / schema validation. The adversarial-symlink case is surfaced as this structured envelope rather than an internal error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `VERIFICATION_FAILED`                                                    | `verify`, `task complete`                                                                                                                                                                                                                                                                                                                                                                                                                         | Deterministic completion check did not pass. The envelope may also carry `error.cause_code`: `task complete` uses `DECISION_REQUIRED`, `COMMANDS_FAILED`, or `ABORTED`; standalone `verify` uses `ABORTED` for cancellation (see [Public cause codes](#public-cause-codes)) and an actionable `error.message`; `error.code` stays `VERIFICATION_FAILED` at exit 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DECISION_REQUIRED` (v1.21+)                                             | `task record-done`                                                                                                                                                                                                                                                                                                                                                                                                                                | A `requires_decision` task's ADR could not be resolved by the decision gate. As a **top-level `error.code`** this is raised only by `task record-done`; on `task complete` the _same semantic cause_ appears only as `error.cause_code` under `VERIFICATION_FAILED` (see [Public cause codes](#public-cause-codes)). **The two surfaces differ.** **On `task record-done` (as `error.code`):** exit code 2, no progress event recorded, and the full structured envelope — `data.task_id`, `data.decision_check` (the gate's `{name, ok, reason}`), `data.current_resolution` (`"status-aware"` since v1.22), `data.via` (`"decision_refs"` or `"filename-scan"`), `data.considered` (per-ADR `{path, status, accepted, acceptance}`; `acceptance` ∈ `"accepted" \| "blocked" \| "empty" \| "unknown_status" \| "missing" \| "unsafe_path" \| "unreadable"`), `data.declared_decision_refs`, and `data.expected_pattern` (only when `via === "filename-scan"`). **On `task complete` (as `error.cause_code`):** `error.code` stays `VERIFICATION_FAILED` at exit 1, there is **no** full `DecisionRequiredData` block, and the P32 fields (`failed_checks` / `first_failure` / `suggested_next_command`) stay under `data` — see the [`task complete`](#task-complete) failure envelope. Resolution semantics (shared by both surfaces): explicit `decision_refs` use **all-must-be-accepted**; the filename scan uses **any-accepted-wins** (preserves the substring-collision compat). A `decision_refs` entry that is structurally unsafe or resolves outside the project root (`..`, an absolute path, or a symlink out of the repo) is **fail-closed**: it is never read and reported as `acceptance: "unsafe_path"` with `accepted: false`, so the gate stays unresolved regardless of the file's contents.                                                                                                                                              |
| `VALIDATE_FAILED`                                                        | `validate`                                                                                                                                                                                                                                                                                                                                                                                                                                        | One or more errors (or, under `--strict`, any issue) detected by the underlying doctor checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DOCTOR_FAILED`                                                          | `doctor`                                                                                                                                                                                                                                                                                                                                                                                                                                          | One or more error-severity doctor issues found                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `TUTORIAL_FAILED` (v1.15+)                                               | `tutorial`                                                                                                                                                                                                                                                                                                                                                                                                                                        | A step in the sandbox walkthrough threw; the sandbox is still cleaned up (unless `--keep`). The message carries the underlying error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PLAN_LINT_FAILED`                                                       | `plan lint`                                                                                                                                                                                                                                                                                                                                                                                                                                       | One or more lint issues found (under `--strict`, includes warnings)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PLAN_NORMALIZE_REQUIRED`                                                | `plan normalize --check`                                                                                                                                                                                                                                                                                                                                                                                                                          | At least one file needs normalization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PLAN_NORMALIZE_CONFLICT`                                                | `plan normalize`                                                                                                                                                                                                                                                                                                                                                                                                                                  | `--check` and `--write` both passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PLAN_ANALYZE_FAILED`                                                    | `plan analyze`                                                                                                                                                                                                                                                                                                                                                                                                                                    | One or more exit-relevant drift issues found, **or** a ledger-read integrity failure caught while reading the merged ledger (the diagnostic `EVENT_FILE_ID_MISMATCH` / `INVALID_YAML` / `SCHEMA_ERROR` is wrapped here, original cause in `error.message`, never leaked as a top-level code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PHASE_SNAPSHOT_INVALID` (v2.0, design-docs-ephemeral)                   | `task context` / `task prepare` / `task status` / `task start` / `task block` / `task resume` / `task complete` / `task record-done` / `task finalize` / `task runbook` / `status` / `phase runbook` / `phase next` / `phase runbook --across-phases` (exit 2); `plan analyze` (exit 1, its strict-loader failure convention) — **and** an issue-level diagnostic in `plan lint` / `doctor` (see [Plan diagnostic codes](#plan-diagnostic-codes)) | A phase archive snapshot (`.code-pact/state/archive/phases/<id>.json`) integrity failure, fail-closed. Two top-level cases: **(1)** a **roadmap-referenced** missing phase whose snapshot cannot release it — corrupt / schema-invalid / identity-mismatched (`phase_id` / `original_path` / `path_sha256`) / non-terminal; **(2)** **any** valid archived snapshot, **referenced OR unreferenced**, whose task ids **collide** with the current live+archived task graph (graph-ambiguous state). The strict plan-state loader (`loadPlanState`) and the shared task resolver (`resolveTaskInRoadmap`) throw it as the top-level `error.code`; the lenient-loader surfaces (`plan lint`, `doctor`) report it as a `data.issues[]` error. **NOT a top-level error:** an _unreferenced_ snapshot that is itself corrupt / unsafe-named, or an unreadable archive directory — those are `plan lint`-only `affects_exit:false` advisories (see Plan diagnostic codes), unless the missing ids cause INDEPENDENT diagnostics (`TASK_DEPENDS_ON_UNRESOLVED` from `plan lint`, `ORPHAN_PROGRESS_EVENT` from `doctor`/`plan analyze`). Fail-closed: a hand-deleted **completed** phase is tolerated only by a fully valid, identity-checked terminal snapshot; a present live file is never released by a snapshot (live-wins)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PLAN_MIGRATE_FAILED` (collaboration-safe-state RFC, B4)                 | `plan migrate`                                                                                                                                                                                                                                                                                                                                                                                                                                    | The migration could not complete — e.g. an existing per-event ledger file is corrupt. Like `plan analyze`, a ledger-read integrity failure (`EVENT_FILE_ID_MISMATCH` / `INVALID_YAML` / `SCHEMA_ERROR`) is wrapped into this command-level code with the original cause in `error.message`, never leaked as a top-level `EVENT_FILE_ID_MISMATCH`. Exit 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `TASK_FINALIZE_NOT_ELIGIBLE`                                             | `task finalize`                                                                                                                                                                                                                                                                                                                                                                                                                                   | Task's derived state from the progress ledger is not `done` (raised in **both** dry-run and `--write`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DECISION_PRUNE_NOT_ELIGIBLE`                                            | `decision prune`                                                                                                                                                                                                                                                                                                                                                                                                                                  | The target decision record cannot be retired. `data.blocks[].gate` lists every **applicable** failing gate: `target_invalid` / `target_missing` / `target_unreadable` / `target_not_accepted` (not a readable, accepted `.md` record under `design/decisions/`); `referencing_task_not_done`; `open_commitments`; `live_decision_depends` / `dependency_status_unknown`; `decision_scan_unreadable` / `dependency_unreadable`; `plan_artifacts_unreadable` (an unreadable `roadmap.yaml` / `design/phases/*.yaml`, so referencing tasks can't be fully verified); `link_rewrite_unsupported` (a reference-style inbound link, or a markdown link to the decision inside the append-only `PRUNED.md` ledger) / `link_rewrite_scan_unreadable` (an unreadable doc source — the rewrite plan would be incomplete) — all fail-closed. The **link-rewrite** gates are only evaluated once the target itself is a readable, accepted decision record (a `target_*` failure short-circuits them). Exit 2; raised in **both** dry-run and `--write` — the verdict is identical. See [`decision prune`](#decision-prune) for the success envelope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DECISION_PRUNE_PLAN_STALE`                                              | `decision prune --write`                                                                                                                                                                                                                                                                                                                                                                                                                          | Caught in the **preflight, before any write**: re-collecting inbound links no longer reproduces the plan exactly, a span no longer byte-matches its collected `raw_link`, the **target record** vanished / became a non-regular file, or its **content changed since the verdict** (an in-place edit — same inode, different bytes). `data` is `{ mode: "write", decision, stale[] }` where each `stale[]` entry is `{source_file, line, column, expected, found}`. **Zero writes**; exit 2; re-run `decision prune` to rebuild the plan. (Drift detected mid-commit — a source edited after preflight, or the record edited/disappearing before the final delete — is `DECISION_PRUNE_WRITE_FAILED`, not this code.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `DECISION_PRUNE_WRITE_FAILED`                                            | `decision prune --write`                                                                                                                                                                                                                                                                                                                                                                                                                          | A write could not complete **after** preflight passed: an unreadable ledger caught in preflight, or **`PRUNED.md` edited since preflight** (`append_ledger` — refused, never clobbered, zero writes); a **source edited since preflight** (`rewrite_links` — the edit is refused, never clobbered); the **record edited or disappearing** before the delete (`delete_record` — an in-place content edit or removal between the rewrites and the delete is refused, not claimed as a removal); or a commit-time `rename`/`unlink` I/O error (disk full, permissions, a path that became a directory). `data` is `{ mode: "write", decision, phase, partial_applied, message }` where `phase` is `append_ledger` \| `rewrite_links` \| `delete_record`. `partial_applied` is whether **this invocation** already landed a mutation — the ledger was **appended this run** (not an idempotent already-recorded retry), or **≥1 source was rewritten**: so `append_ledger` is always `false`, and `rewrite_links` / `delete_record` are `true` **except** on an already-recorded retry that fails before any rewrite lands, where they are `false`. Exit 2; inspect the working tree when `partial_applied` is `true`, then re-run — the ledger append is idempotent (a decision already recorded is not duplicated)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DECISION_RETIRE_NOT_ELIGIBLE`                                           | `decision retire`, `decision retire --write`                                                                                                                                                                                                                                                                                                                                                                                                      | The decision cannot be retired. `data.blocks[].gate` lists every failing gate: `target_invalid` / `target_missing` / `target_unreadable`; `referencing_task_not_done` (**status-sensitive** — an active task's `decision_refs` needs an **accepted** record to carry the gate; an `acceptance_refs` is carried by a valid record **only when it targets a `.md` decision record under `design/decisions/`** — a non-decision target stays strict; a **filename-scan** gate is never carriable); `open_commitments`; `live_decision_depends` / `dependency_status_unknown` / `dependency_unreadable`; `decision_scan_unreadable`; `plan_artifacts_unreadable`. Unlike `decision prune`, there is **no `target_not_accepted`** (retire accepts any status) and **no `link_rewrite_*`** (retire rewrites no links). Exit 2; identical in dry-run and `--write`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DECISION_RETIRE_NOT_RETIRED`                                            | `decision retire`, `decision retire --write`                                                                                                                                                                                                                                                                                                                                                                                                      | The decision's `.md` is **absent** (true lexical `lstat` ENOENT, real parent) but **no valid, identity-checked decision-state record** resolves it — a broken state, not "already retired". Fail-closed, exit 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DECISION_RETIRE_STALE`                                                  | `decision retire`, `decision retire --write`                                                                                                                                                                                                                                                                                                                                                                                                      | A path/identity/verification/TOCTOU refusal; `data.reason` is one of `source_changed` (the `.md` bytes changed between baseline and delete), `identity_changed` (a symlink final/ancestor component, a non-regular file, or an inode/dev swap), `path_inaccessible` (an escape, an unreadable scan/dependency, or unreadable plan artifacts at the final recheck), `record_unverified` (the written record was not reader-resolvable, its `source_sha256` mismatched, or `writeDecisionRecord` / `planDecisionRecord` refused a stale existing record), or `gate_would_orphan` (a **post-write** external-state recheck found a current active gate the record can't carry — a non-accepted `decision_refs`, a filename-scan gate, or a live decision dependant — that appeared in the write→delete window). **Zero destructive effect** — the `.md` is untouched. Exit 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `TASK_FINALIZE_WRITE_REFUSED`                                            | `task finalize --write`                                                                                                                                                                                                                                                                                                                                                                                                                           | Safety check refused the phase YAML write (unsafe path, outside `design/phases/`, symlink escape, unparseable, etc.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PHASE_RECONCILE_WRITE_REFUSED`                                          | `phase reconcile --write`                                                                                                                                                                                                                                                                                                                                                                                                                         | Every eligible task write in the phase was refused for safety reasons. Partial successes return exit 0; this fires only when **all** writes refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PHASE_ARCHIVE_INELIGIBLE`                                               | `phase archive`, `phase archive --write`                                                                                                                                                                                                                                                                                                                                                                                                          | The phase cannot be archived: `writePhaseSnapshot`'s eligibility verdict refused it. `data.blocks[]` lists every failing gate (e.g. `phase_not_terminal`, `task_not_terminal`, `task_done_without_done_event`, `record_stale`, …). Identical in dry-run and `--write`. Exit 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PHASE_ARCHIVE_NOT_ARCHIVED`                                             | `phase archive`, `phase archive --write`                                                                                                                                                                                                                                                                                                                                                                                                          | The phase YAML is **absent** (true lexical `lstat` ENOENT) but **no valid snapshot** resolves it (no record / corrupt / identity-mismatched / non-terminal). A missing YAML with no valid snapshot is a **broken** state, not "already archived" — fail-closed. `data.reason` carries the reader's detail. Exit 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PHASE_ARCHIVE_STALE`                                                    | `phase archive`, `phase archive --write`                                                                                                                                                                                                                                                                                                                                                                                                          | The archive was refused for a path/identity/verification reason; `data.reason` is one of `source_changed` (YAML bytes changed between baseline and delete), `identity_changed` (a symlink final component — dangling or not — / a non-regular file / an inode-dev swap), `path_inaccessible` (an ancestor symlink escape or an unreadable path), or `snapshot_unverified` (the written snapshot was not reader-tolerated, or its `source_sha256` did not match the live YAML). **Zero destructive effect** — the YAML is untouched. Exit 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `STATE_COMPACT_INELIGIBLE` (v2.0, event-pack compaction Layer 2)         | `state compact`, `state compact --write`                                                                                                                                                                                                                                                                                                                                                                                                          | `state compact <phase-id>` cannot compact the phase. `data.block.kind` is one of: `phase_file_still_present` (a live phase YAML with that id still exists — found via the roadmap **or** a scan of `design/phases/*.yaml`, so an orphan doc the roadmap doesn't reference is still caught; `data.block.phase_path`; run `phase archive <id> --write` first), `ambiguous_phase_id` (the id maps to **multiple** live phase YAMLs — control-plane corruption; `data.block.phase_paths` lists them; fail-closed), `phase_discovery_incomplete` (`design/phases/` could not be enumerated, so absence of a live YAML cannot be proven — fail-closed), `snapshot_missing` / `snapshot_invalid` (no/corrupt phase snapshot), `snapshot_evidence_broken` (the snapshot's `progress_events` evidence does not resolve from the durable ledger — loose ∪ packs), `pack_stale` (a loose event id is **not** covered by the existing pack — pack and loose have diverged; note a strict, non-empty **subset** where every remaining loose id IS in the pack is NOT stale but a resumable partial cleanup — dry-run returns it as the **success** result `would_resume_cleanup` (exit 0), and `--write` finishes the job, removing the remaining loose files and returning `cleaned`; the matching-full-set and no-loose-left cases are dry-run `would_cleanup_loose` / `noop_already_cleaned`), `pack_invalid` (an existing pack failed Tier-1/binding), or `candidate_bind_failed` (an internal consistency guard). The block enum and eligibility conditions are shared by dry-run and `--write`, but the JSON `data` shapes differ: dry-run emits the legacy compact ineligible shape (`data.phase_id`, `data.block`); `--write` emits the `CleanupOutcome`-derived shape, which additionally carries `cleanup_pending`, `partial_applied`, `cleanup_started`, `loose_deleted_count`, `cleanup_remaining_loose`, `vanished_count`, `skipped`, and `advisories`. Exit 2 |
| `STATE_COMPACT_WRITE_FAILED` (v2.0, event-pack compaction Layer 2)       | `state compact --write`                                                                                                                                                                                                                                                                                                                                                                                                                           | The pack step mutated nothing usable, OR mutated the tree but cleanup never started. `data.phase` is `write_pack` (`partial_applied:false` — the pack is NOT on disk; e.g. a concurrent writer created it) or `verify_pack` (`partial_applied:true` — the pack **step** mutated the tree but cleanup did not begin: either a Layer-2-style readback failure (pack on disk) **or** a post-write re-prepare failure (the racing change may have already removed the pack). `partial_applied:true` asserts the mutation happened, **NOT** that the pack is still present; `data.next_action` says to inspect the pack **if it is still present**, resolve the conflict, and rerun — no loose file was unlinked, so the durable ledger is intact). `data.pack_path` is always present so an operator can locate the file. Exit 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `STATE_COMPACT_CLEANUP_FAILED` (v2.0, event-pack compaction Layer 3)     | `state compact --write`                                                                                                                                                                                                                                                                                                                                                                                                                           | A global cleanup safety gate aborted the loose-file removal: the re-plan went stale (G0), a live phase reappeared as the owner of a task_id (G6), the pack/snapshot diverged (G8), or post-run reconciliation found a present survivor the verified pack no longer covers (`data.block` = `pack_stale_after_cleanup`). The pack itself is fine; the environment changed under the cleanup. `data.partial_applied` reflects whether THIS invocation has already mutated the filesystem at all — the pack was written on the cell-10 path, **or** at least one loose file was unlinked — so it can be `true` even with `data.loose_deleted_count:0` (pack written, then the gate aborted before any unlink). `data.cleanup_started` is true (the cleanup phase began); `data.loose_deleted_count` reports the unlink count only. Resolve the conflict, then rerun. Exit 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `STATE_COMPACT_CLEANUP_INCOMPLETE` (v2.0, event-pack compaction Layer 3) | `state compact --write`                                                                                                                                                                                                                                                                                                                                                                                                                           | The run completed but ≥1 present loose survivor could not be removed (gate-skipped, or a gate-bypassing file the pack still covers). `data.skipped[]` lists each survivor with its reason; `data.cleanup_remaining_loose` is the post-run count. Not corruption — read `skipped[]`, fix each, and rerun (idempotent). Exit 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `LOCK_HELD` (v1.5+ / P14)                                                | `init --sample-phase`, `init` wizard, `phase add`, `phase new`, `phase import`, `task add`, `task finalize --write`, `phase reconcile --write`, `phase archive --write`, `state compact --write`, `state compact-archive --write`, `state archive-retention --write`, `state archive-maintain --write`, `plan adopt --write`, `plan sync-paths --write`, `decision prune --write`, `decision retire --write`                                      | Another code-pact mutation is in progress on the same project. The envelope's `data.lock_holder` carries `{pid, hostname, cmd, created_at}` for diagnostic display; `data.lock_path` is the lock file path. Transient + retryable — wait for the holder to release, or manually delete the lock file if you are certain no process holds it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `WRITES_AUDIT_STRICT_FAILED` (v1.6+ / P15-T6)                            | `task finalize --audit-strict`                                                                                                                                                                                                                                                                                                                                                                                                                    | The audit emitted at least one `TASK_WRITES_AUDIT_*` warning and `--audit-strict` was supplied. Exit code is **1** (not 2 — the invocation was well-formed; only the strict gate refused). The envelope carries the full `write_audit` plus `applied: false` to make the no-mutation guarantee machine-readable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `CONTEXT_OVER_BUDGET` (v1.13+ / P24)                                     | `task context --budget-bytes`, `task prepare --budget-bytes`                                                                                                                                                                                                                                                                                                                                                                                      | Even maximal section elision could not bring the rendered pack at or below the requested byte budget. Exit code 2. The envelope carries `data.budget_bytes`, `data.minimum_achievable_bytes` (the post-maximal-elision size — re-running with this value as the budget succeeds), and `data.unelidable_sections` (the structural floor)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `INTERNAL_ERROR`                                                         | any command                                                                                                                                                                                                                                                                                                                                                                                                                                       | Reserved for unhandled exceptions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ADAPTER_DESIRED_PATH_CONFLICT` (v1.20+)                                 | `adapter install`, `adapter upgrade --write`                                                                                                                                                                                                                                                                                                                                                                                                      | Defense-in-depth invariant: an adapter generator produced two desired files at the same path with differing content or differing roles. Should never fire in practice (each adapter uniquifies its own paths); surfaced as an unhandled exception (exit 3), not a structured envelope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PATH_OUTSIDE_PROJECT`                                                   | (internal — never a top-level `error.code`)                                                                                                                                                                                                                                                                                                                                                                                                       | Path-safety guard: `resolveWithinProject` tags a symlink/unsafe-path escape with this code. It is always **caught and remapped** at the command boundary before it reaches an agent — `adapter install` / `adapter upgrade` map it to `ADAPTER_MANIFEST_INVALID` (manifest path) or `CONFIG_ERROR` (placeholder `.context` / hook dir), and `decision prune` / `decision retire` classify it as the `target_invalid` gate. Listed here only so the error-code surface stays complete                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PATH_NOT_OWNED`                                                         | (internal — never a top-level `error.code`)                                                                                                                                                                                                                                                                                                                                                                                                       | Path-ownership guard: `resolveSymlinkFreeProjectPath` tags an in-project symlink alias with this code. It is caught and remapped at command boundaries before it reaches an agent — adapter manifest/profile writes map it to `ADAPTER_MANIFEST_INVALID` or `CONFIG_ERROR`, and lifecycle destructive paths fail closed. Listed here only so the error-code surface stays complete                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

> **Not a top-level command error:** `EVENT_FILE_ID_MISMATCH` (collaboration-safe-state RFC, B1/B5) is a **ledger-integrity diagnostic**, not a public structured command error. It is surfaced as a structured `data.issues[]` entry only by the lenient-loader surfaces (`doctor`, `plan lint`) — see [Plan diagnostic codes](#plan-diagnostic-codes). The strict-loader readers never expose it as the top-level `error.code`: `task *` and `verify` abort as a raw unhandled failure (exit 3, no JSON envelope — the same as a corrupt legacy `progress.yaml`), while `plan analyze` and `plan migrate` wrap the ledger-read failure in the command's own code (`PLAN_ANALYZE_FAILED` for analyze, `PLAN_MIGRATE_FAILED` for migrate) with the original cause in `error.message`. `pack` is best-effort and skips it.

### Public cause codes

These appear in `error.cause_code` — an **additive sibling** of `error.code`, not a
top-level code — on a documented failure envelope. They name the root cause when
`error.code` is a broad code such as `VERIFICATION_FAILED`, so an agent reading
only `error` knows what failed without dropping into `data`. Added in v1.27+
(P39); pinned by the same `tests/unit/error-code-surface.test.ts` scan as
top-level codes (it also matches `cause_code:` literals). See [`verify`](#verify) and the [`task complete`](#task-complete) failure envelope for the full shapes.

| Code                                         | Appears on                                                                      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMMANDS_FAILED` (v1.27+)                   | `error.cause_code` on a `task complete` `VERIFICATION_FAILED` envelope (exit 1) | A verification command failed. `error.message` embeds the failing command's reason; the P32 fields (`failed_checks` / `first_failure` / `suggested_next_command`) stay under `data`                                                                                                                                                                                                                                                                                                                                                                   |
| `DECISION_REQUIRED` (v1.27+ as a cause code) | `error.cause_code` on a `task complete` `VERIFICATION_FAILED` envelope (exit 1) | The decision gate is unresolved (a `requires_decision` task with no accepted ADR). `error.message` names that an accepted ADR is required **and embeds the gate's reason** (e.g. `… requires an accepted ADR before completion: No accepted ADR found for "P1-T1". …`). There is **no** full `DecisionRequiredData` block here — that richer envelope only appears on `task record-done`, where `DECISION_REQUIRED` is the top-level `error.code` at exit 2 (see the [Public codes](#public-codes-top-level-error-envelopes) `DECISION_REQUIRED` row) |
| `ABORTED` | `error.cause_code` on `verify` or `task complete` `VERIFICATION_FAILED` (exit 1) | The CLI received cancellation through its `AbortSignal` (including the first `SIGINT` or `SIGTERM`). The active verification process tree is terminated and no `task complete` progress event is written before the event-write commit point. Re-run only when the caller intends the operation to proceed. |

### Plan diagnostic codes

Issue-level codes emitted by diagnostic surfaces — `plan lint`, `plan analyze`, and selected shared `doctor` checks (e.g. the id-conflict diagnostics) — inside `data.issues[]`. Carry severity `error` or `warning`. The id-conflict diagnostics (`DUPLICATE_PHASE_ID` / `DUPLICATE_TASK_ID`) also carry `details.colliding_files` (a `string[]` of the colliding phase-file paths; `DUPLICATE_TASK_ID` adds `details.colliding_phases`) so an agent can read the collision pair without parsing the prose `message` — `issue.file` is single-valued (the second occurrence).

| Code                                                                         | Severity         | Emitter                                                                                                                                                                                                                                            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `INVALID_YAML`                                                               | error            | `plan lint`                                                                                                                                                                                                                                        | A roadmap or phase YAML file failed to parse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SCHEMA_ERROR`                                                               | error            | `plan lint`                                                                                                                                                                                                                                        | A YAML file parsed but failed Zod schema validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `EVENT_FILE_ID_MISMATCH` (collaboration-safe-state RFC, B1/B5)               | error            | `plan lint` / `doctor`                                                                                                                                                                                                                             | A per-event progress-ledger file's content (or its stored `id`) does not match the content id encoded in its filename (`<at-compact>-<id>.yaml`) — a broken / partial / hand-edited entry. Fail-closed: emitted as a structured issue **only** by the lenient-loader surfaces (`plan lint`, `doctor`). The strict-loader readers never expose it as a top-level `error.code`: `task *` / `verify` abort raw (exit 3); `plan analyze` / `plan migrate` wrap it in the command's own failure code (`PLAN_ANALYZE_FAILED` / `PLAN_MIGRATE_FAILED`) with the cause in `error.message`. `pack` is best-effort and skips it. A genuinely unparseable event body reports `INVALID_YAML`; a parseable-but-invalid one reports `SCHEMA_ERROR`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `EVENT_PACK_INVALID` (v2.0, event-pack compaction)                           | error            | `plan lint` / `doctor`                                                                                                                                                                                                                             | An event pack (`.code-pact/state/archive/event-packs/<id>.json`) failed validation: Tier-1 (schema / per-entry filename↔content bijection / duplicate id / order / `event_ids_sha256`) or Tier-2 snapshot binding (`snapshot_sha256` / `phase_id` / task membership / evidence resolution / semantic replay). Fail-closed: a strict-loader read throws it (wrapped by `plan analyze` / `plan migrate` like `EVENT_FILE_ID_MISMATCH`), the lenient-loader surfaces emit it as a `data.issues[]` error and DROP the unbound pack so it never enters the merged log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ARCHIVE_BUNDLE_INVALID` (v2.0, archive-level compaction)                    | error            | strict archive readers (lenient surfaces drop the bundle); also surfaced as a top-level `error.code` (exit 2) by `state compact-archive` when the bundle store is corrupt                                                                          | An archive bundle (`.code-pact/state/archive/bundles/<kind>-<hash>.json`, which folds many per-item archive records of one kind for bounded-archive compaction (the **archive-level-compaction RFC**, retired — in git history / the `.code-pact/state` archive record)) failed **Tier-1** self/bijection validation: schema, per-member `sha256`↔canonical-bytes match, in-bundle duplicate id, ascending-id order, or the `member_ids_sha256` set checksum; or a cross-bundle `duplicate_member_conflict`; or a Tier-2 per-member binding fault. Same fail-closed family as `EVENT_PACK_INVALID`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SNAPSHOT_EVENT_EVIDENCE_UNRESOLVABLE` (v2.0, event-pack compaction)         | error            | `plan lint --strict` / `doctor` / `validate`                                                                                                                                                                                                       | An archived phase snapshot's `terminal_evidence.kind === "progress_events"` `event_id` does not resolve from the durable ledger (loose event files ∪ Tier-2-validated packs — NOT legacy `progress.yaml`), or resolves to the wrong task / a non-`done` status. Closes the silent-provenance-loss gap (hand-deleting an archived task's events after archive).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `LEGACY_EVENT_FOR_ARCHIVED_TASK` (v2.0, event-pack compaction)               | error            | `plan lint` / `doctor` (lenient); strict readers throw                                                                                                                                                                                             | A legacy `progress.yaml` event for an ARCHIVED-snapshot task whose content id is not in the durable ledger (loose ∪ packs) — it would flip the archived task's derived state on the maintainer's machine but not on a clean checkout / CI. Excluded from the merged stream in both modes; strict throws, lenient records the issue. Recover: `code-pact plan migrate --write` to normalize, or remove the stale legacy entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `MISSING_PHASE_FILE`                                                         | error            | `plan lint` / `doctor` / `validate`                                                                                                                                                                                                                | `roadmap.yaml` references a phase file that does not exist on disk, or is present-but-inaccessible, and no valid archive snapshot covers it (a covered one is tolerated; a corrupt one is `PHASE_SNAPSHOT_INVALID`). The code name matches the condition — _referenced but not present_. `doctor` / `validate` emit the same code as `plan lint` for this case; earlier versions mis-reported it under `ORPHAN_PHASE_FILE` (see the CHANGELOG behavior-change note).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PHASE_SNAPSHOT_INVALID` (v2.0, design-docs-ephemeral)                       | error \| warning | `plan lint` / `doctor` (issue-level); **also a top-level `error.code`** — see [Public codes](#public-codes-top-level-error-envelopes) for the full list of top-level emitters (`task *`, `status`, `phase runbook` / `phase next`, `plan analyze`) | A roadmap-referenced phase file is missing **and** its archive snapshot (`.code-pact/state/archive/phases/<id>.json`) cannot release it (corrupt / schema-invalid / identity-mismatched / non-terminal), **OR** a snapshot's task ids collide against the current live+archived graph. Two severities by scope: **(error)** a _referenced_ missing phase whose snapshot is bad, or **any** task-id collision (graph-ambiguous state) — fail-closed everywhere. **(warning, `affects_exit: false` — `plan lint` only)** a v2.0 _unreferenced_ archived snapshot discovered by enumeration that is itself corrupt / unsafe-named, or an unreadable archive directory — the snapshot supplies no ids, so the **`PHASE_SNAPSHOT_INVALID` advisory** never fails `--strict` and `doctor` / `validate` do not emit it. That suppression is scoped to the advisory ONLY — INDEPENDENT diagnostics still fire on the consequences of the missing ids: a live `depends_on` to a would-be id → `TASK_DEPENDS_ON_UNRESOLVED` (`plan lint` only — `plan analyze` does not run the depends-on detector); a leftover progress event for one → `ORPHAN_PROGRESS_EVENT` (`doctor` / `plan analyze`). So `validate --strict` is green only when no such independent strict-relevant issue remains. When the live phase file is present the snapshot is never consulted (live-wins). |
| `DUPLICATE_TASK_ID`                                                          | error            | `plan lint` / `doctor`                                                                                                                                                                                                                             | The same task id appears in more than one phase. Carries `recovery` (`manual_action` + `confirm`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DUPLICATE_PHASE_ID`                                                         | error            | `plan lint` / `doctor`                                                                                                                                                                                                                             | Two roadmap entries / phase files claim the same phase id (e.g. a clean-but-wrong branch merge — no git conflict). Carries `recovery` (`manual_action` + `confirm`). Also a top-level exit-2 `error.code` from `phase add` / `phase import` (see Public codes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PHASE_ID_MISMATCH`                                                          | error            | `plan lint` / `doctor`                                                                                                                                                                                                                             | `phase.id` inside the YAML does not match the roadmap reference. Carries `recovery` (`manual_action` + `confirm`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ORPHAN_PHASE_FILE`                                                          | warning          | `plan lint` / `doctor`                                                                                                                                                                                                                             | A phase YAML exists on disk but is **not** referenced by `roadmap.yaml` — the inverse of `MISSING_PHASE_FILE` (_present but unreferenced_). Warning-level so a deliberate stash of work-in-progress does not block CI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PHASE_ID_NAMING`                                                            | warning          | `plan lint`                                                                                                                                                                                                                                        | Phase id does not match `P<N>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `TASK_ID_PHASE_PREFIX`                                                       | warning          | `plan lint`                                                                                                                                                                                                                                        | Task id does not match `<phase>-T<N>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `WEAK_DOD`                                                                   | warning          | `plan lint --include-quality`                                                                                                                                                                                                                      | DoD entry is suspiciously short or contains `TODO`/`FIXME`/`tbd`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PLACEHOLDER_VERIFICATION`                                                   | warning          | `plan lint --include-quality`                                                                                                                                                                                                                      | Verification command starts with `echo`/`true`/`noop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `TASK_DECISION_UNRESOLVED` (v1.17+, P31; status-aware since v1.22)           | warning          | `plan lint --include-quality`                                                                                                                                                                                                                      | A task (or its phase) is `requires_decision: true` but the decision gate does not resolve it (uses the same shared status-aware resolver as `verify` / `task record-done`). Fires when no ADR matches **and** when an ADR exists but is `proposed` / `draft` / `rejected` / `superseded` / empty / unknown-status, or when explicit `decision_refs` are not all accepted — including a `decision_refs` path that is unsafe or escapes the project root (such paths are fail-closed: never read, reported as `acceptance: "unsafe_path"`). Advisory: `affects_exit: false` — stays advisory even under `--strict`. `details.source` is `"task"` or `"phase"`; `details.via` and `details.reason` carry the resolver verdict; `details.considered[]` lists the ADRs the resolver inspected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ADR_STATUS_UNRECOGNIZED` (v1.24+)                                           | warning          | `plan lint --include-quality`                                                                                                                                                                                                                      | An ADR in `design/decisions/**/*.md` declares an **explicit but unrecognized** status word (e.g. a typo `**Status:** acceptd`). Since v1.22 the gate treats an unrecognized status as `unknown_status` — it does **not** resolve — so a typo silently keeps a decision blocked; this surfaces it. File-centric: fires per ADR file even if no task references it yet, and complements `TASK_DECISION_UNRESOLVED`. Advisory: `affects_exit: false`. `details.status` is the offending word and `details.status_source` (`"frontmatter"` or `"bold-line"`) is which channel to fix. Not raised for `accepted` / `proposed` / `draft` / `rejected` / `superseded`, a missing status line, or an empty file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ADR_ACCEPTED_BODY_THIN` (v1.26+, P36)                                       | warning          | `plan lint --include-quality`                                                                                                                                                                                                                      | An `accepted` ADR in `design/decisions/**/*.md` whose body is an empty stub — an accepted decision with no recorded reasoning. **Structure-independent, no heading-name matching**: fires only when the substantive body (frontmatter removed, status line + h1 title stripped, whitespace normalized) is below an internal threshold (`ADR_THIN_BODY_CHARS`, 400) **AND** the raw body has zero `##` (h2) headings — so a short-but-structured or long-but-heading-free ADR never fires. A file that is _just_ a `**Status:** accepted` line is in scope; a 0-byte empty file (`acceptance: "empty"`) and proposed/draft ADRs are not. Advisory: `affects_exit: false`; does not change the decision gate. `details.body_chars` / `details.heading_count`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ADR_COMMITMENTS_EMPTY` (v1.27+, P43)                                        | warning          | `plan lint --include-quality`                                                                                                                                                                                                                      | An **accepted** ADR that **resolves** a `requires_decision` task's decision gate records no implementation commitments — no `## Implementation commitments` section, or the section is present with zero GFM checkbox items (`- [ ]`, `- [x]`, `* [ ]`, `* [x]` — checked **and** unchecked all count). Fires only when the gate actually resolves (a partially-accepted explicit `decision_refs` set is unresolved → `TASK_DECISION_UNRESOLVED`, not this). **Scoped to accepted ADRs that resolve a gated task's gate** (via the shared resolver), so historical/unreferenced ADRs never fire. One issue per ADR file (first task wins). `file` is the ADR path; there is **no `path`** field — the subject is ADR content, not a plan-YAML field (matching the other ADR-centric advisories). Advisory: `affects_exit: false`, **including under `--strict`** — commitments are implementation guidance, not a hard plan-validity rule. `details.has_section` / `details.item_count` distinguish "no section" from "empty section".                                                                                                                                                                                                                                                                                                                             |
| `PHASE_DOCS_WRITE_NO_DOC_CHECK` (v1.27+, P43)                                | warning          | `plan lint --include-quality`                                                                                                                                                                                                                      | A **not-yet-`done`** phase has a task whose `writes` includes a public doc that `check:docs` guards (a `docs/` file or a root-level public `.md`; **CHANGELOG.md is excluded** — it is not scanned by `check:docs`; `design/**` is excluded — validated elsewhere), but the phase's `verification.commands` run **no** doc check (`check:docs` / `check:doc-links` / `check:doc-invariants`). Forward-looking docs-drift guard: a phase that will edit public docs should verify them. Structural (phase YAML only — no free-text parsing), so it cannot misfire; `done` phases are never flagged (can't be changed → noise). One issue per phase. Advisory: `affects_exit: false`. `file` is the phase YAML path, `path` is `verification.commands` (a plan-YAML field — unlike the ADR-content advisories), `phase_id` / `task_id` name the offending task, and `details.doc_write` is the offending write.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PHASE_CONFIDENCE_LOW` (v1.17+, P31)                                         | warning          | `plan lint --include-quality`                                                                                                                                                                                                                      | Phase is `confidence: low`. Advisory: `affects_exit: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `TASK_DESCRIPTION_MISSING` (v1.17+, P31)                                     | warning          | `plan lint --include-quality`                                                                                                                                                                                                                      | Task has no description (empty/unset; no length floor). Advisory: `affects_exit: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `TASK_CONTEXT_PACK_LARGE` (v1.30+, P50, Context Fit layer d)                 | warning          | `plan lint --include-quality`                                                                                                                                                                                                                      | The task's **natural** (pre-elision) context pack size exceeds the `balanced` fallback budget (`60000` bytes — `STANDARD_CONTEXT_BUDGET_PROFILES.balanced`). Reuses the P49 explain metric `natural_bytes` from one cached context-pack build per task. Advisory only — a large pack can be legitimate; it suggests a wider profile or reviewing task scope, and does **not** imply the pack is invalid or auto-apply `wide`. `details.natural_bytes` / `details.threshold_bytes` (60000) / `details.recommended_profile` (`"wide"`). Advisory: `affects_exit: false`. Requires a resolvable project `default_agent` for the pack build; skipped otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `TASK_CONTEXT_BUDGET_UNACHIEVABLE` (v1.30+, P50, Context Fit layer d)        | warning          | `plan lint --include-quality`                                                                                                                                                                                                                      | The deterministically **recommended** context budget (P48 mapping; the default agent's same-name `context_budget` override when available, otherwise built-in fallback bytes — the same byte value `recommend` / `task prepare` would surface) for the task cannot fit even after maximal eligible elision — i.e. `minimum_achievable_bytes > budget_bytes`. `minimum_achievable_bytes` is the **same floor `CONTEXT_OVER_BUDGET` reports**, from the one shared P49 helper (not a separate hard-coded floor). Suggests a wider profile or a task split; does not change the recommendation or fail lint. `details.profile` / `details.budget_bytes` / `details.minimum_achievable_bytes`. Advisory: `affects_exit: false`. Requires a resolvable project `default_agent`; skipped otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `TASK_DECLARED_DECISION_LARGE` (v1.30+, P50, Context Fit layer d)            | warning          | `plan lint --include-quality`                                                                                                                                                                                                                      | A `decision_refs` entry points to a decision/ADR body larger than the `tight` budget (`30000` bytes — `STANDARD_CONTEXT_BUDGET_PROFILES.tight`), large enough to dominate a tight context budget. Byte-based, **not** an ADR-quality judgment — it does not suggest deleting the ADR, only splitting follow-up tasks, using a wider profile, or confirming the scope justifies the large reference. Skips unsafe/missing refs (those are `TASK_DECISION_REF_UNSAFE_PATH` / `TASK_DECISION_REF_NOT_FOUND`), so it never duplicates a real error. `details.path` / `details.bytes` / `details.threshold_bytes` (30000). Advisory: `affects_exit: false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `TASK_READS_MATCH_TOO_MANY` (v1.30+, P50, Context Fit layer d)               | warning          | `plan lint --include-quality`                                                                                                                                                                                                                      | A `reads` glob matches more than `100` Git tracked files (a fixed count threshold) and may inflate context planning cost. A broad reads glob can be valid (e.g. a cross-cutting refactor), so this only suggests narrowing the glob. Skips entries already flagged by the structural reads detectors (unsafe path / unsupported glob syntax). `details.glob` / `details.match_count` / `details.threshold_count` (100). Advisory: `affects_exit: false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `STATUS_DRIFT`                                                               | error/warning    | `plan analyze`                                                                                                                                                                                                                                     | Design status disagrees with derived progress state (see `details.kind`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PHASE_DONE_WITH_OPEN_TASKS`                                                 | error            | `plan analyze`                                                                                                                                                                                                                                     | Phase marked done but at least one task is still open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ORPHAN_PROGRESS_EVENT`                                                      | warning          | `plan analyze`, `doctor`                                                                                                                                                                                                                           | Progress event references a `task_id` that does not exist in any phase                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PROGRESS_EVENT_CONFLICT` (collaboration-safe-state RFC, B6; attribution D3) | warning          | `plan analyze`, `doctor`, `status` (as `data.conflicts[]`)                                                                                                                                                                                         | A task's merged progress events form an invalid lifecycle sequence (e.g. two `started`, `done` after `done`, an event after a terminal `done`) — incompatible / concurrent events from different sources. The reducer stays total; this is the detection surface. Carries structured **`details.events[]`** (`{ event_id, status, author?, at }`, D3) naming the conflicting side(s) — the establishing event, when present, and the offender — so the "who" is machine-readable (`author` omitted for legacy / capture-off events). Gate it in CI with `validate --strict`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

#### Task Readiness Schema diagnostics (P10, v1.1+)

Issue-level codes emitted by `plan lint` against the optional task fields introduced in v1.1 (`depends_on`, `decision_refs`, `reads`, `writes`, `acceptance_refs`). All twelve are additive — a v1.0.x task that declares none of these fields produces none of these codes. See `design/decisions/task-readiness-schema-rfc.md` for field semantics.

| Code                                                 | Severity        | Trigger                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TASK_DEPENDS_ON_UNRESOLVED`                         | error           | `depends_on` references a task id not present in any phase (v1.9+ resolves same-phase first, then cross-phase fallback)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `TASK_DEPENDS_ON_SELF_REFERENCE`                     | error           | A task lists itself in `depends_on` (direct self-cycle)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `TASK_DEPENDS_ON_CYCLE`                              | error           | Two or more tasks form a multi-node `depends_on` cycle, e.g. A → B → A or A → B → C → A. Self-cycles keep `TASK_DEPENDS_ON_SELF_REFERENCE`; this code covers length ≥ 2. `details.cycle` lists the cycle members. v1.9+ (P19).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `TASK_DECISION_REF_NOT_FOUND`                        | error / warning | `decision_refs` path does not exist on disk. **Status-aware**, keyed on the **task's own status** (a `done` phase does not loosen an open task's gate). Record consultation fires ONLY on a **true ENOENT** absence (a present-but-inaccessible file — EACCES/EPERM/EISDIR/ENOTDIR — keeps its existing severity and never consults a record; live-wins). **done task:** a truly-absent ref stays NON-failing — a [`PRUNED.md`](../design/decisions/PRUNED.md) row OR a valid `.code-pact/state` decision-state record of ANY status SUPPRESSES it (silent); otherwise it is a `warning` (`affects_exit: false`, `details.historical: true`) — never an error. **not-`done` (active) task (v2.0, design-docs-ephemeral):** a truly-absent ref downgrades to `warning` (`affects_exit: false`, `details.retired_decision: true`) ONLY when a valid **accepted** decision-state record releases its gate (`may_satisfy_active_gate`); a non-accepted / no / invalid record, or a PRUNED-only entry, stays `error` (matching the live gate's fail-closed verdict). `cancelled` stays `error`. Lets a recorded decision be retired (`rm -rf design/decisions`) without breaking an active gate's plan lint. See [decision-lifecycle-rfc](../design/decisions/decision-lifecycle-rfc.md) |
| `TASK_DECISION_REF_UNSAFE_PATH`                      | error           | `decision_refs` path fails `assertSafeRelativePath` (traversal / absolute / etc.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `TASK_READS_UNSAFE_PATH`                             | error           | `reads` glob fails `assertSafeRelativePath`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `TASK_READS_GLOB_INVALID`                            | error           | `reads` glob uses syntax outside the P10 supported subset (see RFC § Supported glob subset)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `TASK_READS_NO_MATCH`                                | warning         | `reads` glob matches zero Git tracked files (likely a typo, an untracked local file, or a file not yet created)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `TASK_READS_UNAVAILABLE`                             | error           | A task declares `reads`, but the project has no readable Git tracked-file index. `task.reads` never falls back to walking untracked local files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `TASK_WRITES_UNSAFE_PATH`                            | error           | `writes` glob fails `assertSafeRelativePath`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `TASK_WRITES_GLOB_INVALID`                           | error           | `writes` glob uses syntax outside the P10 supported subset                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `TASK_WRITES_PROTECTED_PATH`                         | warning         | `writes` glob covers a protected path. v1.6+ (P15-T3) loads the list from `design/rules/protected-paths.md` when present; when the file is absent, falls back to the hardcoded defaults (`.git/**`, `node_modules/**`, `.code-pact/**`, `design/roadmap.yaml`, `design/phases/*.yaml`). Stays `warning` severity. Under `plan lint --strict`, the warning becomes exit-relevant per the existing binary `--strict` promotion (see § `plan lint` below). The code-pact dogfood corpus is strict-clean as of v1.5.1. Selective per-code promotion is P15-T6 scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `TASK_WRITES_AUDIT_OUTSIDE_DECLARED` (v1.6+, P15-T1) | warning         | Real filesystem changes touched a file matched by no declared `writes` glob. Emitted in `data.write_audit.warnings[]` on `task finalize --json` only. Advisory: never changes the exit code in v1.6 (the `--audit-strict` flag in P15-T6 opts into exit-relevant enforcement)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `TASK_WRITES_AUDIT_DECLARED_UNUSED` (v1.6+, P15-T4)  | warning         | A declared `writes` glob matched zero files in the audit's `files_touched` set. Usually signals that the declaration is stale, the task was split across PRs, or the planning artifact drifted from reality. Emitted in `data.write_audit.warnings[]` on `task finalize --json` only. Fires independently of `TASK_WRITES_AUDIT_OUTSIDE_DECLARED` — a single audit can emit both. Advisory: never changes the exit code in v1.6 (the `--audit-strict` flag in P15-T6 opts into exit-relevant enforcement)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `TASK_WRITES_OVER_BROAD` (v1.6+, P15-T2)             | warning         | A declared `writes` glob is too coarse — its root path segment is `**`, meaning the glob matches the entire repository (or huge swaths of it). Heuristic-only. Examples flagged: `**`, `**/*`, `**/*.ts`, `**/foo.ts`. Examples NOT flagged: `src/core/audit/**`, `src/**/*.ts`, `tests/unit/**`, `*.md`. Under `plan lint --strict` the warning becomes exit-relevant per the existing binary promotion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `TASK_ACCEPTANCE_REF_NOT_FOUND`                      | error / warning | `acceptance_refs` path does not exist on disk. **Status-aware**, keyed on the task's own status; record consultation fires only on a true ENOENT (inaccessible keeps existing severity, no record). **done task:** advisory `warning` (`affects_exit: false`, `details.historical: true`) for ANY target, with or without a record/PRUNED (existing baseline, unchanged). **not-`done` task:** `error` by default — `acceptance_refs` stays STRICT (it may point at ordinary docs like `docs/cli-contract.md`, which must still fail). It downgrades to `warning` (`affects_exit: false`, `details.retired_decision: true`) (v2.0, design-docs-ephemeral) ONLY when the target normalizes to a `.md` decision record under `design/decisions/` backed by a valid decision-state record of ANY status (a reference-integrity annotation, not a gate release — so a `blocked` record still softens). A non-decision target / PRUNED-only / no record never softens                                                                                                                                                                                                                                                                                                                    |
| `TASK_ACCEPTANCE_REF_UNSAFE_PATH`                    | error           | `acceptance_refs` path fails `assertSafeRelativePath`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Doctor diagnostic codes

Issue-level codes emitted by `doctor` / `validate` for general project health.

| Code                                            | Severity | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MISSING_DIR`                                   | error    | A required directory under `.code-pact/` or `design/` is absent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `MISSING_MODEL_TIER`                            | warning  | An agent profile is missing a required `model_map` tier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `EMPTY_OBJECTIVE`                               | error    | A phase `objective` is blank or fewer than 10 characters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DUPLICATE_PHASE_ID`                            | error    | Two roadmap entries / phase files claim the same phase id (a clean-but-wrong branch merge — no git conflict). Shared detector with `plan lint`. Carries `recovery` (`manual_action` + `confirm`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DUPLICATE_TASK_ID`                             | error    | The same task id appears in more than one phase. Shared detector with `plan lint`. Carries `recovery` (`manual_action` + `confirm`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PHASE_ID_MISMATCH`                             | error    | `phase.id` inside a phase YAML does not match its `roadmap.yaml` reference. Carries `recovery` (`manual_action` + `confirm`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MODEL_ID_UNKNOWN` (v1.29+)                     | warning  | The `claude-code` profile has a `model_map` value or `model_version` that is not present in the bundled Claude catalog — typically a typo, or a model id code-pact does not track yet. Offline check against `src/core/models/catalog.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MODEL_MAP_STALE` (v1.29+)                      | warning  | The `claude-code` profile's `model_map` points at a known Claude id that is no longer the current catalog default (e.g. the profile predates a model bump). A difference from the default, **not** an invalid value — to follow it, hand-edit the tier in the profile path doctor names (e.g. `.code-pact/agent-profiles/<agent>.yaml`) then run `adapter upgrade <agent> --write` to regenerate (note: `--model` re-pins `model_version` only, never `model_map`). Keep it if the pin is intentional, or silence via `.code-pact/doctor.yaml` → `disabled_checks: [MODEL_MAP_STALE]`. Scoped to `claude-code`; never fires for codex/other agents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `BAK_FILE`                                      | warning  | A `.bak` file is present alongside a tracked file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `LOCAL_NOT_GITIGNORED`                          | warning  | `.local/` is not listed in `.gitignore` (the private planning-notes dir; `init` adds `/.local/` among its ignore entries, so this fires only if `.gitignore` was edited away)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `BRIEF_MISSING`                                 | warning  | `design/brief.md` does not exist (gated on a real non-`TUTORIAL` phase existing — never fires on a fresh project; `brief.md` is optional and not created by `init`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CONSTITUTION_PLACEHOLDER`                      | warning  | `design/constitution.md` still contains the template edit hint (gated on a real non-`TUTORIAL` phase existing — never fires on a fresh project)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ADAPTER_STALE`                                 | warning  | An enabled agent profile has no `model_version` set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `STALE_CONTEXT`                                 | warning  | A cached context file is older than its source design files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CONTROL_PLANE_NOT_DRIVEN` (v1.25+)             | warning  | The scaffold exists but isn't being driven. Fires only when **all** of: a non-TUTORIAL task is planned; the progress ledger (legacy `progress.yaml` + per-event files) has no `started`/`done` event for a non-TUTORIAL task (tutorial usage does not count); and git shows uncommitted working changes (excluding code-pact's own runtime state). **git-unavailable is a silent skip** (never an error); a broken/unparseable ledger is also skipped (the existing `INVALID_YAML`/`SCHEMA_ERROR`/`EVENT_FILE_ID_MISMATCH` reports that). Advisory: `severity: warning`, never affects doctor's exit. Silence via `.code-pact/doctor.yaml` → `disabled_checks: [CONTROL_PLANE_NOT_DRIVEN]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `CONTROL_PLANE_BRANCH_NOT_DRIVEN` (v1.26+, P34) | warning  | Branch-diff drift for PR CI. Runs only when `doctor` / `validate` is given `--base-ref <ref>`. Fires when the branch (`merge-base..HEAD`) changed real, non-excluded files but added no `started`/`done` event for a **known** non-TUTORIAL task — code changed without driving the loop. Silent skip when `--base-ref` is absent, git/merge-base is unavailable, none of legacy `progress.yaml` / `state/events/**` / `state/archive/event-packs/**` is git-tracked (after compaction the history can live entirely in packs), or the committed HEAD ledger is unreadable/corrupt. Advisory; gate via `validate --strict --base-ref`. Exempt paths via `control_plane_branch_not_driven.exclude_globs` (default empty); silence via `disabled_checks`. See the `doctor` section for the committed-ledger precondition, and [Running code-pact in CI](workflows/ci.md) for the copy-paste GitHub Actions workflow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `CONTROL_PLANE_GITIGNORED` (v1.32+)             | warning  | Part of the **shared control plane** is git-ignored — a `.gitignore` rule matches one or more of `project.yaml`, `agent-profiles/`, `model-profiles/`, `state/baselines/`, or `state/events/` (the progress ledger), so that state never reaches git and stays local: a teammate or clean checkout misses whatever is ignored (project config, profiles, baselines, or the ledger). **Only when the ledger itself is ignored** does `CONTROL_PLANE_BRANCH_NOT_DRIVEN` _also_ silently skip (no tracked ledger to read) — a config/profile/baseline-only ignore does not affect that gate. The `message` names the affected area(s). Usual cause is a blanket `/.code-pact/` ignore, but a **file-scoped** rule like `state/events/*.yaml` is caught too (the dir is not ignored, yet every new event file is). `init` writes a narrow ignore but never deletes a user's pre-existing line. Authoritative via `git check-ignore --no-index` over a representative **file** in each shared area (matches the ignore **rules**, so a force-added `.gitkeep` does not mask it and a negation re-include is honoured). **Silent skip** when git is unavailable / not a repo, or `.code-pact/project.yaml` is absent. Advisory: `severity: warning` — `doctor` / default `validate` do not fail on it; `validate --strict` promotes it to exit-relevant (like other doctor warnings), so CI can gate on it. Silence via `.code-pact/doctor.yaml` → `disabled_checks: [CONTROL_PLANE_GITIGNORED]`. See [§ State file write guarantees](#state-file-write-guarantees) for the shared-vs-local policy |

**`issue.recovery` (v1.28+ — additive).** The three `CONTROL_PLANE_*` issues above carry a structured `recovery` object alongside `message`, so an agent can pick the next action from JSON without parsing the prose. Shape (command-driven fix):

```json
{
  "recovery": {
    "primary": "code-pact task prepare <id> --agent <agent>",
    "alternatives": ["code-pact task record-done <id> --evidence \"...\""],
    "reference": ".code-pact/doctor.yaml (disabled_checks: [CONTROL_PLANE_NOT_DRIVEN])"
  }
}
```

`primary` is the recommended next command — a runnable template (`<…>` placeholders are agent-supplied). `alternatives` (optional) lists equally-valid commands. `reference` (optional) names the config key / docs pointer to scope, silence, or read more about the check.

**Manual-fix variant (v1.32+).** When the remedy is an edit with **no single runnable command** (e.g. `CONTROL_PLANE_GITIGNORED`, whose fix is narrowing `.gitignore`, or the id-conflict diagnostics, whose fix is renaming a colliding id), `recovery` omits `primary` and instead carries `manual_action` (the instruction — **not** a shell command; do not execute it) and `confirm` (a runnable command that verifies the fix). This keeps `primary` strictly executable, so an agent never mistakes prose for something it can run:

```json
{
  "recovery": {
    "manual_action": "Narrow .gitignore: remove the blanket rule; keep only /.code-pact/locks/, /.code-pact/cache/, /.local/, /.context/ ignored; commit project.yaml, agent-profiles/, model-profiles/, state/baselines/, state/events/.",
    "confirm": "code-pact doctor",
    "reference": "docs/cli-contract.md § State file write guarantees; disabled_checks: [CONTROL_PLANE_GITIGNORED]"
  }
}
```

`recovery` is **additive** — every diagnostic that omits it behaves exactly as before, and a consumer reading just `code` / `severity` / `message` sees no change. The same `message` prose is retained for human output. It is currently populated on: the `CONTROL_PLANE_*` doctor advisories above, and (v1.32+) the collaboration **conflict** diagnostics `DUPLICATE_PHASE_ID` / `DUPLICATE_TASK_ID` / `PHASE_ID_MISMATCH` — wherever they surface (`plan lint` and `doctor`, in `data.issues[]`; the `plan lint` orchestrator runs these three id checks, `plan analyze` does not). The conflict diagnostics use the manual-fix variant (`manual_action` = rename one colliding id + update what references it; `confirm` = `code-pact plan lint`; `reference` names what collides and points at [`docs/troubleshooting.md`](troubleshooting.md#id-collisions--mismatches-collaboration)). The fail-closed `AMBIGUOUS_PHASE_ID` / `AMBIGUOUS_TASK_ID` errors do not carry `recovery` (their `data.phases[]` already lists the colliding locations); their recovery steps live in troubleshooting.

### Adapter diagnostic codes

Emitted by `adapter doctor` and (manifest-aware) global `doctor`. See the `adapter doctor` section above for severity rules and the rationale for each code.

| Code                                     | Severity | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADAPTER_MISSING`                        | warning  | (legacy v0.8) Enabled agent has no instruction file AND no manifest. Replaced by manifest-aware codes once a manifest exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ADAPTER_MANIFEST_MISSING`               | warning  | `adapter doctor` only — no manifest for an enabled agent. Never emitted by global `doctor`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ADAPTER_MANIFEST_INVALID`               | error    | Manifest YAML failed parse or schema validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ADAPTER_GENERATOR_STALE`                | warning  | Manifest's `generator_version` differs from the current package version **and** the current desired generated output differs from the manifest (or cannot be proven equivalent). Stamp-only version lag with byte-identical output is silent (Issue #340, v1.30.1).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ADAPTER_SCHEMA_DRIFT`                   | warning  | Manifest's `adapter_schema_version` is older than the module's declared version                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ADAPTER_PROFILE_DRIFT`                  | warning  | Profile fields recorded in `profile_fingerprint` have changed since install                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ADAPTER_FILE_MISSING`                   | error    | A file listed in the manifest is missing from disk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ADAPTER_FILE_PATH_UNSAFE`               | error    | A file listed in the manifest resolves through an unsafe / non-contained path (for example, a symlink escape), OR names a path this adapter could not have generated (forged-manifest guard). `adapter doctor` / global `doctor` do not read, hash, or inspect the target; fix the path or regenerate the adapter output.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ADAPTER_FILE_DRIFT`                     | warning  | A managed file was locally modified AND the generator output also moved on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ADAPTER_DESIRED_STALE`                  | warning  | A managed file is unchanged locally but the generator now produces different content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ADAPTER_FILE_UNVERIFIABLE`              | warning  | A manifest file is in the shared skills namespace (role-scoped `createPathGlobsByRole`) but NOT in the adapter's current exact generated set (`ownedPathRoles`), and it is not recorded as `ownership: handed_off`. Indistinguishable by path from a stale/orphaned skill or a hand-authored file, so `doctor` does NOT read/hash/inspect it (no content oracle). Review the file. To regenerate it, move or delete it, then run `adapter upgrade <agent> --write`. Handed-off dynamic entries also skip existing-byte reads; doctor may still warn when the manifest entry is missing from current desired output or its recorded hash is stale.                                                                                                                                                             |
| `ADAPTER_UNMANAGED_FILE`                 | warning  | A file under one of the adapter's `ownedPathRoles` (exact static owned paths) exists on disk but is not in the manifest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ADAPTER_CONTRACT_DRIFT` (v1.7+, P16-T5) | warning  | An instruction file's body lacks the v1.7+ agent-contract section or one of its three axis sub-headings. Soft signal — does NOT change the doctor exit code. Independent of `ADAPTER_FILE_DRIFT` (file-level hash drift); both can fire in the same run. `details.kind` is `"section_missing"` (whole `## Agent contract` heading absent) or `"axes_incomplete"` (heading present but one or more of `### When to invoke code-pact`, `### What to verify first`, `### How to handle failures` is missing). `details.missing_axes: string[]` enumerates which axes are missing when `kind === "axes_incomplete"`. Resolution: `adapter upgrade <agent> --write` (use `--accept-modified` to preserve user edits to the file body). |

### Stability rules for codes (v1.0)

- **Additive changes** (new codes, new severities, new diagnostic categories) may land in minor releases without a major bump.
- **Renaming or removing** a code listed in any of the four tables above is a breaking change.
- **Re-categorizing** a code between Public / Plan / Doctor / Adapter is documentation only — agents that match on `error.code` are unaffected.

## TTY and CI detection

The helper `isInteractive()` in `src/lib/tty.ts` is the single source
of truth. It returns true only when **all** of the following hold:

- `process.stdin.isTTY` is truthy
- `process.stdout.isTTY` is truthy
- `process.env.CI` is unset, empty, `"false"`, or `"0"`

Any other state is treated as non-interactive. Commands that have an
interactive variant (currently `init`, with `phase new` to follow)
fall back to the flag-based code path when `isInteractive()` returns
false.

## --non-interactive

`code-pact <command> --non-interactive` forces the flag-based path
even when stdin and stdout are both TTYs. The semantics match a CI
invocation:

- Interactive prompts are suppressed.
- Required information must come from flags.
- Missing required flags raise `CONFIG_ERROR` (exit 2).

This flag is for automation that runs from an interactive shell but
must not depend on user input (scripts, agent calls, scheduled jobs).

`init` in non-interactive or CI mode (`--non-interactive` or `CI=true`)
specifically requires `--locale` and `--agent`. Running `init` without
these flags in automation mode raises `CONFIG_ERROR` (exit 2) instead
of silently picking defaults.

When `--agent` lists multiple agents (e.g. `--agent claude-code,generic`)
and no dedicated default-agent option is provided, the first agent in
the list becomes `default_agent` in the generated `project.yaml`.

## `phase import`

For usage, flags, and basic examples, see the generated [CLI reference § `phase import`](cli-reference.generated.md#phase-import). `plan import` is an alias that routes to the same implementation and shares this flag surface.

`phase import` bulk-imports a draft roadmap. Input shape:

```yaml
phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: "..."
    # optional phase fields:
    confidence: medium
    risk: low
    verify_commands: ["pnpm test"]
    definition_of_done: ["..."]
    non_goals: ["..."]
    requires_decision: false
    tasks: # optional; only `id` is required per task (v0.4+)
      - id: P1-T1
        description: "..." # all other task fields are optional
        type: feature # defaults to "feature" when omitted
        ambiguity: low # defaults to "medium" when omitted
        risk: low # defaults to "medium" when omitted
        context_size: small # defaults to "medium" when omitted
        write_surface: medium
        verification_strength: strong
        expected_duration: short
        status: planned # defaults to "planned" when omitted

        # P10 (v1.1+) — Task Readiness Schema. All five fields are
        # optional and have NO synthetic default — absent stays
        # undefined, which means v1.0.x YAML behaviour is unchanged.
        depends_on: [P1-T2] # same-phase task ids
        decision_refs: [design/decisions/x.md] # paths surfaced into the pack
        reads: [src/core/**/*.ts] # declared read surface (globs)
        writes: [src/core/foo.ts] # declared write surface (globs)
        acceptance_refs: [docs/cli-contract.md] # acceptance criteria paths
```

**Verification key (`verify_commands`, NOT `verification`).** The import shape uses a flat top-level `verify_commands: [...]` list. This is **distinct from** the full Phase schema written under `design/phases/*.yaml`, which nests the same data as `verification: { commands: [...] }`. `PhaseImportEntry` is not strict, so a nested `verification:` block is silently dropped by validation and the phase falls back to the default verify command (`pnpm test`). To make this footgun visible rather than silent, import emits a `PHASE_VERIFY_COMMANDS_MISSHAPED` advisory (see `warnings` below) whenever an input phase carries `verification.commands` — including when a canonical `verify_commands` is also present, in which case the nested block is ignored.

**Lenient task schema (v0.4+):** Only `id` is required on each task entry. Missing detail fields are filled with sensible defaults at import time. This allows AI-generated roadmap YAML (which often omits `ambiguity`, `context_size`, etc.) to be imported directly without manual field-filling.

**P10 Task Readiness Schema fields (v1.1+):** `depends_on` / `decision_refs` / `reads` / `writes` / `acceptance_refs` are additive optional fields. They have **no synthetic default** — when omitted from the input they stay `undefined` on the parsed task and the corresponding pack section is omitted. Field semantics, validation rules, the supported glob subset (literal segments, single-segment `*`, full-segment `**` only), and the protected-path seed set live in the **task-readiness-schema RFC** (retired — in git history / the `.code-pact/state` archive record). The twelve additive lint codes that validate them are listed below under [§ Plan diagnostic codes](#plan-diagnostic-codes) → Task Readiness Schema diagnostics.

Add `--strict` to require every task field to be present explicitly; missing fields raise `CONFIG_ERROR` (exit 2) before any writes.

Validation runs in a single pre-write pass:

1. Malformed YAML or schema violation → `CONFIG_ERROR` (exit 2). No files are written.
2. **Reserved-id preflight (v1.5+ / P14).** Any input phase entry whose `id` is a reserved id (currently `TUTORIAL`) → `CONFIG_ERROR` (exit 2). The check runs **before any `createPhase` call**, so the roadmap stays byte-identical on failure — partial imports with TUTORIAL rejected mid-loop are not possible. `--force` does NOT bypass this; reserved ids are reserved at the governance layer, not the collision-handling layer. The sanctioned path for creating a `TUTORIAL` phase is `code-pact init --sample-phase`.
3. The same phase id appearing twice **within the input** → `DUPLICATE_PHASE_ID` (exit 2). No files are written.
4. An input phase id colliding with an existing `roadmap.yaml` entry, **without `--force`** → `DUPLICATE_PHASE_ID` (exit 2). No files are written.
5. With `--force`, colliding phases are **skipped**; tasks declared inside those skipped phases are not imported either.
6. Across all _kept_ import targets, plus the existing kept roadmap phases, every task id must be unique. Any collision → `AMBIGUOUS_TASK_ID` (exit 2). `--force` does **not** bypass this: task-level integrity wins over throughput. No files are written.
7. With `--strict`, any task that is missing one or more required Task fields → `CONFIG_ERROR` (exit 2). No files are written.

On success the JSON envelope returns

```json
{
  "ok": true,
  "data": {
    "imported_phases": [
      { "id": "P1", "path": "design/phases/P1-foundation.yaml", "weight": 12 }
    ],
    "imported_tasks": ["P1-T1"],
    "skipped_phases": [],
    "completed_fields": [
      { "taskId": "P1-T1", "fields": ["type", "ambiguity", "risk"] }
    ],
    "warnings": [],
    "suggested_next_steps": [
      "Review the `completed_fields` array — every entry is a task field code-pact filled with a default. Confirm each is appropriate before treating the imported tasks as source-of-truth.",
      "Run `code-pact plan lint --json` to validate the imported phase(s).",
      "Run `code-pact phase runbook P1 --json` to see the recommended per-phase next steps (reconcile-batch step is the natural follow-up after the per-task loop starts).",
      "Run `code-pact task runbook P1-T1 --json` to see the per-task lifecycle starting from a fresh task."
    ],
    "scaffolded_decisions": [],
    "scaffold_skipped": []
  }
}
```

`completed_fields` is non-empty only when defaults were applied. In strict mode it is always `[]`.

**`--scaffold-decisions` (v1.23+ / RFC §3-D, opt-in).** When set, after the phase write pass the importer scaffolds a `**Status:** proposed` ADR stub for every task the decision gate would block (`requires_decision` on the task **or** its phase). The stub opens at `proposed`, so the status-aware gate (RFC §3-C) still **blocks** `verify` / `task complete` / `task record-done` until a human flips it to `accepted` — scaffolding fills the work-surface, it does not pre-approve anything. Targets:

- a task with `decision_refs` → each referenced path **under `design/decisions/`** that is missing is scaffolded (the all-must-be-accepted contract); the task shape is never modified;
- a task without `decision_refs` → the default `design/decisions/<task-id>.md`, skipped when a matching ADR filename already exists.

Existing files are never overwritten. Path safety is enforced in the **preflight** (before any write): an unsafe `decision_refs` path (`../x.md`, `/tmp/x.md`, …) or an unsafe task-id filename segment (`P1/T1`) → `CONFIG_ERROR` (exit 2) with **nothing written** and the roadmap byte-identical. A _safe_ `decision_refs` path that simply lives **outside** `design/decisions/` is not an error: it is left unwritten and reported in `scaffold_skipped`.

- `scaffolded_decisions: string[]` — repo-relative POSIX paths of the stubs created. Always present, `[]` when the flag is off or nothing was scaffolded.
- `scaffold_skipped: { ref: string; reason: string }[]` — targets intentionally not written (e.g. `reason: "outside design/decisions/"`). Always present. Existing-file skips are silent (idempotent); only surfacing-worthy omissions appear here.

**`warnings` (additive field).** Always present, even as `[]` (field-presence-fixed, like `suggested_next_steps`). Each entry is `{ code, phase_id?, message }`. Warnings are advisories only — they never change the exit code. The current code is:

- `PHASE_VERIFY_COMMANDS_MISSHAPED` — an input phase used the nested `verification: { commands: [...] }` (full Phase) shape instead of the flat `verify_commands: [...]` (import) shape. Detected on the raw parsed YAML before schema validation, so it fires even though zod strips the unknown key. `phase_id` carries the offending phase id when the entry had a string `id`.

**`suggested_next_steps` (v1.4+ additive field).** Always present, even as `[]`. Names the canonical post-import sequence:

- A leading defaults-review hint is prepended when `completed_fields` is non-empty (lenient mode filled defaults).
- One `phase runbook <id>` step per imported phase.
- One `task runbook <id>` step pointing at the first imported task.
- The whole array is empty when every input phase was skipped (`imported_phases.length === 0`).

The field is additive: existing JSON consumers see no shape change.

The validation pass detects logic errors before any write; ordinary disk failures during the per-phase write loop (disk full, permission denied) are out of scope for v0.2 and may leave a partial result.

## `spec import` (v1.8+)

`code-pact spec import` is a dry-run-first, one-way bridge that ingests external spec-driven planning artifacts into code-pact's phase YAML. It never mutates the source artifact; `--write` can persist an unregistered draft phase inside the code-pact project. **It does NOT re-implement Spec Kit or any spec-generation tool** — code-pact remains a control plane that accepts artifacts produced by other tools.

For usage, flags, and basic examples, see the generated [CLI reference § `spec import`](cli-reference.generated.md#spec-import).

Two mutually exclusive modes:

### Import from tasks.md

Parses a Spec Kit-style `tasks.md` (or any Markdown that follows the supported subset) into a draft phase YAML.

**Supported subset:**

- `### Heading 3` → one phase task group
- `- [ ]` unchecked checkbox item → one task candidate
- Everything else (other heading levels, plain bullets, numbered lists, checked items, prose, code fences, tables, frontmatter, HTML comments) is silently dropped and counted in `skipped_lines`.

In import mode, the source path must pass `assertSafeRelativePath` (relative to cwd, no `..`, no absolute, no leading `~`). The phase id must match `/^[A-Za-z][A-Za-z0-9_-]*$/`. Dry-run is the default and prints YAML to stdout; write mode persists to `design/phases/<id>-imported.yaml`, refusing to overwrite an existing draft unless force is requested.

**Generated phase shape:** tasks carry minimal P10 defaults — `type=feature`, all judgement axes (`ambiguity`, `risk`, `context_size`, `write_surface`, `verification_strength`, `expected_duration`) = `medium`, `status=planned`. Descriptions are the verbatim `- [ ]` text prefixed with the section title (`[Section Name] task text`). The user adds `reads` / `writes` / `acceptance_refs` after import.

**The importer does NOT add the generated phase to `design/roadmap.yaml`** — `--write` persists an _unregistered_ draft, and adopting it (adding a `roadmap.yaml` entry that points at the imported file) stays an explicit, hand-edited follow-up. Coupling the two operations would silently bypass the roadmap chokepoint contract. Note `phase add` does **not** register the imported draft: it creates a _fresh_ phase from flags.

**Success envelope:**

```json
{
  "ok": true,
  "data": {
    "kind": "would_import" | "imported",
    "source_path": "tasks.md",
    "phase_id": "P18",
    "sections_imported": 2,
    "tasks_imported": 4,
    "skipped_lines": 3,
    "output_path": "design/phases/P18-imported.yaml" | null,
    "phase_yaml": "id: P18\nname: P18\n...",
    "warnings": ["checked_task_dropped: 1 line(s)", ...]
  }
}
```

`output_path` is `null` on dry-run. `warnings` summarises dropped constructs by code+count.

### Suggest from spec.md / plan.md

Reads a Spec Kit `spec.md` or `plan.md` and surfaces brief / constitution candidates. **Never writes any file** — the user pipes the suggestions into `plan brief --from-file` / `plan constitution --from-file` (v1.6 P17 non-interactive paths) if they accept them.

Recognised headings (case-insensitive, Markdown punctuation stripped):

- **what:** Problem statement, Problem, Overview, Summary, Goal(s), Objective(s)
- **who:** Audience, Users, Personas, Stakeholders, Target users
- **differentiator:** Positioning, Differentiator, Value proposition, Why now, Unique value
- **description:** Background, Context, Rationale, Motivation, Vision, Philosophy
- **principles:** Principles, Constraints, Tenets, Non-goals, Guidelines, Guiding principles

First match wins. Each candidate field is independently optional.

**Success envelope:**

```json
{
  "ok": true,
  "data": {
    "source_path": "spec.md",
    "brief_candidates": {
      "what": "...",
      "who": "...",
      "differentiator": "..."
    },
    "constitution_candidates": {
      "description": "...",
      "principles": ["..."]
    },
    "recognised_sections": ["Problem statement", "Audience"],
    "skipped_sections": ["Implementation notes"]
  }
}
```

### Mutex constraints

- `--from` and `--suggest-from` are mutually exclusive. Passing both → `CONFIG_ERROR` with `data.detail: "mutex_violation"`.
- `--from` without `--phase-id` → `CONFIG_ERROR` with `data.detail: "missing_phase_id"`.
- `--suggest-from` + `--phase-id` → `--phase-id` silently ignored (suggestion mode has no use for it).

### Failure envelope

All `spec import` failures reuse `CONFIG_ERROR` (exit 2). No new public error codes were added in v1.8. The structured `data.detail` enum is:

<!-- @generated:spec-import-details — DO NOT EDIT by hand; regenerate with `pnpm gen:doc-blocks`. Source: SPEC_IMPORT_DETAILS in src/contracts/spec-import-details.ts. -->
| `detail` | When |
| --- | --- |
| `unsafe_path` | `--from` / `--suggest-from` failed `assertSafeRelativePath` |
| `file_not_found` | source file does not exist |
| `unreadable` | source file exists but cannot be read |
| `phase_id_invalid` | `--phase-id` does not match `/^[A-Za-z][A-Za-z0-9_-]*$/` |
| `phase_yaml_exists` | `--write` would clobber an existing imported YAML (use `--force`) |
| `no_sections_parsed` | input has no Heading 3 sections (importer mode only) |
| `mutex_violation` | `--from` + `--suggest-from` both passed |
| `missing_phase_id` | `--from` passed without `--phase-id` |
<!-- @generated:spec-import-details:end -->

### Post-import advisories

Running `plan lint --include-quality --strict` against an imported phase will likely warn about `PLACEHOLDER_VERIFICATION` (the default `pnpm test` may not match the project's actual verify command), `WEAK_DOD` (the default objective is generic), and `TASK_READS_NO_MATCH` if the user added reads. These are normal post-import advisories — the same posture as a brand-new phase added by hand.

## `plan`

`code-pact plan <subcommand>` provides AI-assisted project planning tools that feed into the design directory.

For `plan` command usage, flags, and basic examples, see the generated [CLI reference § Plan commands](cli-reference.generated.md#plan-commands). The source of truth for that command reference and `plan <subcommand> --help` is [`src/cli/spec/plan.ts`](../src/cli/spec/plan.ts). This section owns the stable semantics: envelopes, exit behavior, mode constraints, diagnostics, and write/lock guarantees.

`plan import` is intentionally documented as an alias, not a separate flag surface: it routes to `phase import`.

### `plan brief`

Interactive wizard that collects project description, target users, and differentiator, then writes `design/brief.md`. Stability: **Stable (v0.2+)**. `--from-file`, `--stdin`, and `--what` / `--who` / `--differentiator` are **Stable (v1.6+)** under P17-T1 / T2 / T3.

Default behaviour requires a TTY; exits 2 with `CONFIG_ERROR` in non-interactive mode. `--force` overwrites an existing file.

`plan brief` supports three pairwise-mutually-exclusive non-interactive input modes plus the default TTY wizard:

| Mode          | Trigger                                                      | Source of content       |
| ------------- | ------------------------------------------------------------ | ----------------------- |
| TTY wizard    | no input flags + stdin is a TTY                              | interactive prompts     |
| `--from-file` | `--from-file <yaml>` (v1.6+, P17-T1)                         | YAML file on disk       |
| `--stdin`     | `--stdin` (v1.6+, P17-T2)                                    | YAML on `process.stdin` |
| flag-driven   | any of `--what`, `--who`, `--differentiator` (v1.6+, P17-T3) | command-line flags      |

Passing any combination of the three non-interactive modes returns `CONFIG_ERROR` (exit 2) with a message listing the modes that were detected.

**`--from-file <yaml>` (v1.6+, P17-T1).** Reads the file at `<yaml>` (repo-root-relative; `assertSafeRelativePath` enforced), validates it against the schema below, and writes `design/brief.md` from the supplied values. Bypasses the TTY check, so non-TTY environments (CI, agent sessions) can author a brief end-to-end.

**`--stdin` (v1.6+, P17-T2).** Reads the same YAML schema from `process.stdin` instead of a file. Useful when the brief content is produced by another process and piped in (`some-tool | code-pact plan brief --stdin --json`). Bypasses the TTY check.

**`--what <text>` / `--who <text>` / `--differentiator <text>` (v1.6+, P17-T3).** Supplies the brief fields directly as command-line strings. Presence of ANY of the three flags triggers flag-driven mode. `--what` and `--who` are required (non-empty strings); `--differentiator` is optional and defaults to the locale placeholder when omitted. Missing or empty-string `--what` / `--who` returns `CONFIG_ERROR` (exit 2) with `data.missing: string[]` naming the missing flags. Bypasses the TTY check. Mirrors the v1.4 `task add` non-interactive flag pattern.

YAML schema:

```yaml
what: <non-empty string, required> # "what we're building"
who: <non-empty string, required> # "who it's for"
differentiator: <string, optional> # defaults to "" (matches wizard empty-input behaviour)
```

Unknown keys are rejected (strict schema). All four failure modes return `CONFIG_ERROR` (exit 2) with the structured envelope:

```json
{
  "ok": false,
  "error": { "code": "CONFIG_ERROR", "message": "..." },
  "data": {
    "detail": "<detail>",
    "path": "<the --from-file value, verbatim>"
  }
}
```

`detail` is one of the [non-interactive input detail enums](#non-interactive-input-detail-enums) shared by the capture commands.

On success, `--json` emits `{ ok: true, data: { path: "..." } }` (same envelope as the wizard path). `design/brief.md` produced via `--from-file` is byte-identical to one produced by the wizard for equivalent input.

`--from-file` is partial-write-safe: any failure (path / read / parse / schema) yields no write to `design/brief.md`.

**`--stdin` envelope (v1.6+, P17-T2).** Failures return the same `CONFIG_ERROR` exit 2, with a parallel envelope shape:

```json
{
  "ok": false,
  "error": { "code": "CONFIG_ERROR", "message": "..." },
  "data": {
    "detail": "<detail>",
    "source": "stdin"
  }
}
```

`detail` is one of the [non-interactive input detail enums](#non-interactive-input-detail-enums) shared by the capture commands.

`source: "stdin"` replaces `--from-file`'s `path` field, so consumers can disambiguate the two input modes from the envelope alone. The `unsafe_path` and `unreadable` details do not apply (stdin has no path). `--stdin` is partial-write-safe: any failure yields no write to `design/brief.md`.

#### Non-interactive input detail enums

`plan brief` and `plan constitution` take the same non-interactive input, so their `--from-file` / `--stdin` failure `data.detail` values (all under `CONFIG_ERROR`, exit 2) are identical:

<!-- @generated:plan-capture-details — DO NOT EDIT by hand; regenerate with `pnpm gen:doc-blocks`. Source: PLAN_CAPTURE_*_DETAILS in src/contracts/plan-capture-details.ts. -->
| Surface | `detail` values |
| --- | --- |
| `plan brief --from-file`, `plan constitution --from-file` | `unsafe_path`, `unreadable`, `invalid_yaml`, `schema_invalid` |
| `plan brief --stdin`, `plan constitution --stdin` | `stdin_read_failed`, `invalid_yaml`, `schema_invalid` |
<!-- @generated:plan-capture-details:end -->

### `plan prompt`

Reads `design/brief.md` and `design/constitution.md` (both optional), assembles a structured AI planning prompt, and writes it to stdout. Add `--clipboard` to also copy to the clipboard (via `pbcopy` on macOS or `xclip` on Linux). Does not require a TTY.

JSON output includes `schema_only`, `has_brief`, `has_constitution`, and `clipboard_copied` flags alongside the prompt string.

**`--schema-only` (v1.x+).** Emits only the YAML format example plus terse output rules — no brief/constitution sections, and `design/brief.md` / `design/constitution.md` are **not read** (`has_brief` / `has_constitution` are always `false`). For agents that already hold the project context in-session and only need the output shape fixed: ask the agent to emit YAML in that format, save it, and `phase import` it. The rules direct the agent to output raw YAML (no Markdown fences) with a top-level `phases:` key using the canonical `verify_commands` field. `data.schema_only` is `true`; `suggested_next_steps` points straight at the import → lint → runbook loop (no brief/constitution capture hint). `data.schema_only` is `false` in normal mode — the field is always present (additive).

The YAML example also shows the optional task **readiness fields** (`depends_on`, `reads`, `writes`, `decision_refs`, `acceptance_refs`) that `phase import` already accepts (v1.21+). The output rules instruct the agent to fill the ones it can determine and omit the rest rather than emit empty arrays. `writes` in particular feeds the `task finalize` declared-writes audit, so setting it where the output paths are known is what makes that audit useful.

**v1.4+ additive field** — `data.suggested_next_steps: string[]` is always present (field-presence-fixed). Names the canonical AI-assisted planning sequence:

1. Run the planning prompt through your AI agent of choice and capture its YAML response into a file (e.g. `design/imports/p1.yaml`).
2. Run `code-pact phase import design/imports/p1.yaml --json` to ingest the YAML.
3. Run `code-pact plan lint --json` to validate the imported phase.
4. Run `code-pact phase runbook <imported-phase-id> --json` to see the per-phase next steps.

When `has_brief` or `has_constitution` is false, a leading step recommends `plan brief` / `plan constitution` first. The field is additive: existing JSON consumers (which read only `prompt` / `has_brief` / `has_constitution` / `clipboard_copied`) see no shape change.

### `plan adopt` (v1.x+)

Deterministically converts an existing plan file into the `phase import` input shape. **Dry-run by default** — it prints the generated YAML and writes nothing. `--write` applies it by reusing the `phase import` validation and write pass (under the same advisory write lock). `--scaffold-decisions` (only meaningful with `--write`) forwards to that same pass, so it scaffolds `proposed` ADR stubs exactly as `phase import --scaffold-decisions` does; the results appear under `data.import_result.scaffolded_decisions` / `scaffold_skipped`. code-pact never calls an LLM here.

For **structured** plans (task bullets under headings). A narrative roadmap whose tasks live in prose or fenced code blocks yields no list items and returns `no_plan_items_detected` — the signal to use `plan prompt --schema-only` + an agent instead. No `--force`: id collisions surface through the existing `phase import` errors.

**Input detection order** (`data.source_type`):

1. `phase_import_yaml` — a top-level `phases:` document already matching the import schema; passed through unchanged (the `verification.commands` mis-shape advisory still fires).
2. `single_phase_yaml` — one Phase-shaped object (`id` / `name` / `objective` plus `tasks` and/or a verify list). Accepts the canonical `verify_commands` **and** the legacy nested `verification.commands` (normalised to `verify_commands`, with an advisory). Wrapped as `{ phases: [entry] }`.
3. `markdown` — a narrow list parser: checkbox / plain / numbered bullets grouped under phase-marker headings (`P1` / `Phase N` / `Milestone` / `Epic` / `Sprint`), or a single inferred phase for a flat list. Phase ids are assigned sequentially past the existing roadmap's `P`-numbers. Tasks get a conservative `type` inference; remaining fields fall to `phase import` defaults. **No semantic filtering** — bullets in a "Risks" / "Non-goals" list become tasks too, so review the dry-run before `--write`.

If none match → `CONFIG_ERROR` (exit 2) with `data.detail: "no_plan_items_detected"`. Other detail values: `unsafe_path`, `file_not_found`, `unreadable`.

**JSON result** (`data`): `kind` (`would_adopt` | `adopted`), `source_path`, `source_type`, `phases_detected`, `tasks_detected`, `generated_import_yaml`, `warnings[]`, `import_result` (the `phase import` result on `--write`, else `null`), and `suggested_next_steps`.

**`warnings[]`** entries are `{ code, message, line? }` — advisory only, never affect the exit code:

- `PHASE_VERIFY_COMMANDS_MISSHAPED` — a nested `verification.commands` block was seen (pass-through / single-phase paths).
- `CHECKED_TASK_SKIPPED` — a `- [x]` done item was skipped (design `done` comes from `task finalize`, not import).
- `PHASE_ID_INFERRED` — no phase-marker heading; a single phase id was inferred.
- `READINESS_FIELDS_NOT_INFERRED` — one per source: `depends_on` / `reads` / `writes` / `acceptance_refs` / `decision_refs` are never inferred from prose.

On `--write`, errors from the import pass (`DUPLICATE_PHASE_ID`, `AMBIGUOUS_TASK_ID`, reserved-id `CONFIG_ERROR`) propagate unchanged.

### `plan constitution`

Interactive wizard that collects a project description and core principles, then writes `design/constitution.md`. Stability: **Stable (v0.2+)**. `--from-file`, `--stdin`, and `--description` / `--principle` are **Stable (v1.6+)** under P17-T4 (parallel to `plan brief` P17-T1 / T2 / T3).

Default behaviour requires a TTY; exits 2 with `CONFIG_ERROR` in non-interactive mode. `--force` overwrites an existing file. Empty input — whether from the wizard, an empty YAML body, or absent flags — falls back to i18n defaults so the file is always a valid starting point.

`plan constitution` supports three pairwise-mutually-exclusive non-interactive input modes plus the default TTY wizard:

| Mode          | Trigger                                               | Source of content                                              |
| ------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| TTY wizard    | no input flags + stdin is a TTY                       | interactive prompts (description + comma-separated principles) |
| `--from-file` | `--from-file <yaml>` (v1.6+, P17-T4)                  | YAML file on disk                                              |
| `--stdin`     | `--stdin` (v1.6+, P17-T4)                             | YAML on `process.stdin`                                        |
| flag-driven   | any of `--description`, `--principle` (v1.6+, P17-T4) | command-line flags (`--principle` may repeat)                  |

Passing any combination of the three non-interactive modes returns `CONFIG_ERROR` (exit 2) with a message listing the modes detected.

YAML schema for `--from-file` and `--stdin`:

```yaml
description: <string, optional, defaults to "">
principles:
  - <string>
  - <string>
  # ... optional, defaults to []
```

Both fields are optional. Empty fields fall through to the locale-specific template defaults — same behaviour as the wizard's empty-input path. Unknown keys are rejected (strict schema).

**`--from-file <yaml>` (v1.6+, P17-T4).** Reads the file at `<yaml>` (repo-root-relative; `assertSafeRelativePath` enforced). Failures return `CONFIG_ERROR` (exit 2) with the structured envelope `{ ok: false, error: { code: "CONFIG_ERROR", message }, data: { detail, path } }`. `detail` is one of the [non-interactive input detail enums](#non-interactive-input-detail-enums) shared by the capture commands.

**`--stdin` (v1.6+, P17-T4).** Reads the same YAML schema from `process.stdin`. Failure envelope mirrors `--from-file` with `source: "stdin"` replacing `path`; `detail` is one of the shared [non-interactive input detail enums](#non-interactive-input-detail-enums) (the `unsafe_path` / `unreadable` details do not apply to stdin).

**`--description <text>` / `--principle <text>` (v1.6+, P17-T4).** Supplies the constitution fields directly as command-line strings. Presence of ANY of the two flags triggers flag-driven mode. Both flags are optional — passing only `--description` uses locale-default principles; passing only `--principle` (one or more occurrences) uses the locale-default description. `--principle` is repeatable (`--principle "First" --principle "Second"`). Empty / absent fields fall back to locale defaults, identical to the wizard's empty-input behaviour.

On success, `--json` emits `{ ok: true, data: { path: "..." } }` (same envelope as the wizard path on all four authoring modes). `design/constitution.md` produced via any non-interactive mode is byte-identical to one produced by the wizard for equivalent input.

All non-interactive modes are partial-write-safe: any failure yields no write to `design/constitution.md`.

### `plan lint` (v0.7)

Read-only static integrity check over `design/roadmap.yaml` and every referenced phase file. Intended as a checkpoint command at phase or PR boundaries, not as a per-task gate.

**Checks (default):**

- `INVALID_YAML` (error) — a file failed to parse
- `SCHEMA_ERROR` (error) — a file failed Zod validation
- `MISSING_PHASE_FILE` (error) — roadmap references a phase file that does not exist on disk (and no valid archive snapshot covers it)
- `PHASE_SNAPSHOT_INVALID` (error | advisory warning) — a phase archive snapshot integrity failure. **Error** (fail-closed): a referenced missing phase whose snapshot cannot release it (corrupt / identity-mismatched / non-terminal), or **any** archived task-id collision against the live+archived graph. **Advisory warning** (`affects_exit:false`, `plan lint` only): an _unreferenced_ snapshot that is itself corrupt / unsafe-named, or an unreadable archive directory — these never fail `--strict` (though their missing ids may surface independent `TASK_DEPENDS_ON_UNRESOLVED` / `ORPHAN_PROGRESS_EVENT`). Dual-surface: an issue here, and a top-level `error.code` — see [Public codes](#public-codes-top-level-error-envelopes) for the full list of top-level emitters and the [Plan diagnostic codes](#plan-diagnostic-codes) row for the full matrix
- `DUPLICATE_TASK_ID` (error) — the same task id appears in more than one phase
- `DUPLICATE_PHASE_ID` (error) — the same phase id appears twice
- `PHASE_ID_MISMATCH` (error) — `phase.id` inside the YAML does not match the id the roadmap uses to reference it
- `ORPHAN_PHASE_FILE` (warning) — a `.yaml` under `design/phases/` is not referenced by the roadmap
- `PHASE_ID_NAMING` (warning) — phase id does not match `P<N>`
- `TASK_ID_PHASE_PREFIX` (warning) — task id does not match `<phase>-T<N>`

**`--include-quality` (opt-in quality/readiness advisories):**

- `WEAK_DOD` (warning) — DoD bullets shorter than 10 chars or matching `/TODO|FIXME|tbd/i`
- `PLACEHOLDER_VERIFICATION` (warning) — verification commands starting with `echo`, `true`, or `noop`
- `TASK_DECISION_UNRESOLVED` (advisory, `affects_exit: false`) — a `requires_decision` task/phase with no resolving ADR in `design/decisions/`
- `ADR_STATUS_UNRECOGNIZED` (advisory, `affects_exit: false`) — an ADR with an explicit but unrecognized status word (likely a typo); `details.status_source` says whether to fix the frontmatter or the bold `**Status:**` line
- `ADR_ACCEPTED_BODY_THIN` (advisory, `affects_exit: false`) — an accepted ADR whose body is an empty stub (below the internal threshold with zero `##` headings); `details.body_chars` / `details.heading_count`
- `ADR_COMMITMENTS_EMPTY` (advisory, `affects_exit: false`) — an accepted ADR that resolves a gated task's gate but records no implementation commitments (no `## Implementation commitments` section, or one with zero checkbox items); `details.has_section` / `details.item_count`
- `PHASE_DOCS_WRITE_NO_DOC_CHECK` (advisory, `affects_exit: false`) — a not-yet-`done` phase that writes a public doc (`docs/**` or a root-level `.md`, excluding CHANGELOG.md) but runs no doc check in `verification.commands`; `details.doc_write`
- `PHASE_CONFIDENCE_LOW` (advisory, `affects_exit: false`) — a `confidence: low` phase
- `TASK_DESCRIPTION_MISSING` (advisory, `affects_exit: false`) — a task with no description
- `TASK_CONTEXT_PACK_LARGE` (v1.30+, P50, advisory, `affects_exit: false`) — the task's natural context pack exceeds the `balanced` budget (60000 bytes); `details.natural_bytes` / `details.threshold_bytes` / `details.recommended_profile`
- `TASK_CONTEXT_BUDGET_UNACHIEVABLE` (v1.30+, P50, advisory, `affects_exit: false`) — the recommended context budget (default-agent same-name override when available, else built-in fallback — matching `recommend`) cannot fit even after maximal eligible elision (`minimum_achievable_bytes > budget_bytes`, the same shared floor `CONTEXT_OVER_BUDGET` uses); `details.profile` / `details.budget_bytes` / `details.minimum_achievable_bytes`
- `TASK_DECLARED_DECISION_LARGE` (v1.30+, P50, advisory, `affects_exit: false`) — a `decision_refs` body exceeds the `tight` budget (30000 bytes); `details.path` / `details.bytes` / `details.threshold_bytes`
- `TASK_READS_MATCH_TOO_MANY` (v1.30+, P50, advisory, `affects_exit: false`) — a `reads` glob matches more than 100 files; `details.glob` / `details.match_count` / `details.threshold_count`

These are off by default so the base lint stays lean. `WEAK_DOD` and `PLACEHOLDER_VERIFICATION` are subjective heuristics; the three P31 codes are readiness advisories (surfacing uncertainty a human should settle).

**Context Fit advisories (v1.30+, P50, Context Fit layer d).** The four `TASK_CONTEXT_*` / `TASK_DECLARED_DECISION_LARGE` / `TASK_READS_MATCH_TOO_MANY` codes above are a **readiness** layer that flags likely context-size risk before a task runs. They appear **only** under `--include-quality`, are **absent** without it, and every one is `affects_exit: false` — `--strict` exit behavior is unchanged for advisory-only cases. Thresholds are **deterministic byte/count values** (60000 / 30000 / 100), sourced from `STANDARD_CONTEXT_BUDGET_PROFILES` where applicable. The pass is **local and deterministic**: it reuses the P49 explain metrics (`natural_bytes` and the shared `minimum_achievable_bytes` floor) and the P48 budget recommendation (honoring the default agent's same-name `context_budget` override when available, else the built-in fallback — the same byte value `recommend` surfaces), builds each task's pack once per run (cached), reads decision files, and expands reads globs against Git tracked filenames only — **no model, tokenizer, summarization, compression, semantic ranking, embeddings, network, or untracked filesystem walk** is used, and no pack content is changed and no budget is automatically applied. These are signals, not correctness failures: a large pack, a large decision reference, or a broad reads glob can all be legitimate.

**`--strict` semantics (binary promotion).** When `--strict` is passed, **exit-relevant** warnings — regardless of code — become failures. Issues marked `affects_exit: false` (the P31 clarify/readiness advisories above, mirroring `plan analyze`'s `done-historical`) stay advisory even under `--strict`: they are visible in output and counted under `advisories`, but never change the exit code. Among exit-relevant warnings this includes P10's `TASK_WRITES_PROTECTED_PATH`: a task that declares `writes: design/roadmap.yaml` is informational under default lint and exit-relevant under `--strict`. Selective per-code promotion ("promote only `TASK_WRITES_PROTECTED_PATH`, leave other warnings advisory") is **not** supported in v1.5+; it remains a P15+ candidate. Choose `--strict` when you want a fail-fast posture on any exit-relevant advisory; omit it when the project legitimately declares advisories you want to keep as warnings (e.g. governance tasks writing to design YAML files — see [`docs/maintainers/operations.md` § Release prep](maintainers/operations.md#release-prep-uses-strict-clean-dogfood-checks-v151-guidance) for the dogfood corpus's posture).

**Configurable protected paths (v1.6+, P15-T3).** The list of patterns that trigger `TASK_WRITES_PROTECTED_PATH` is loaded from `design/rules/protected-paths.md` when the file is present. The file format is one glob per line (P10 supported subset), with `#` comments and blank lines ignored, and end-of-line `# ...` comments stripped. Malformed entries (unsafe paths, glob syntax outside the P10 subset) are silently skipped. When the file is **absent**, code-pact falls back to the hardcoded defaults (`.git/**`, `node_modules/**`, `.code-pact/**`, `design/roadmap.yaml`, `design/phases/*.yaml`) — v1.5 behaviour. When the file is **present but contains zero valid entries** (empty / comment-only / all malformed), the list is treated as explicit "no protected paths"; the loader does NOT silently revert to defaults. Delete the file to return to v1.5 behaviour.

**Exit code:**

- `0` — no errors. Without `--strict`, warnings are also exit 0.
- `1` — errors present, or warnings present with `--strict`.
- `2` — argument / configuration error.

**JSON shape (success):**

```json
{
  "ok": true,
  "data": {
    "errors": 0,
    "warnings": 0,
    "advisories": 0,
    "include_quality": false,
    "strict": false,
    "skipped_checks": [],
    "issues": []
  }
}
```

`warnings` counts only exit-relevant warnings. `advisories` (v1.17+) counts visible issues with `affects_exit: false` — these never change the exit code, even under `--strict`. Such issues carry `"affects_exit": false` inside their `data.issues[]` entry (the field is omitted for exit-relevant issues, mirroring `plan analyze`).

**JSON shape (failure):**

```json
{
  "ok": false,
  "error": { "code": "PLAN_LINT_FAILED", "message": "..." },
  "data": {
    "errors": 1,
    "warnings": 0,
    "advisories": 0,
    "include_quality": false,
    "strict": false,
    "skipped_checks": [],
    "issues": [
      {
        "code": "DUPLICATE_TASK_ID",
        "severity": "error",
        "message": "Task \"SHARED-T1\" appears in both phase \"P1\" (design/phases/P1-a.yaml) and \"P2\" (design/phases/P2-b.yaml)",
        "phase_id": "P2",
        "task_id": "SHARED-T1",
        "file": "design/phases/P2-b.yaml",
        "details": {
          "colliding_files": [
            "design/phases/P1-a.yaml",
            "design/phases/P2-b.yaml"
          ],
          "colliding_phases": ["P1", "P2"]
        },
        "recovery": {
          "manual_action": "Renumber one task to a unique id: change its `id:` under the `tasks:` of phase \"P2\" (design/phases/P2-b.yaml), and update any `depends_on` entry that references the old id \"SHARED-T1\". ...",
          "confirm": "code-pact plan lint",
          "reference": "Task id \"SHARED-T1\" is claimed by phase \"P1\" (design/phases/P1-a.yaml) and phase \"P2\" (design/phases/P2-b.yaml). If the two phases also share an id, fix DUPLICATE_PHASE_ID first. See docs/troubleshooting.md (DUPLICATE_TASK_ID)."
        }
      }
    ]
  }
}
```

**Lenient loader behavior:** when `roadmap.yaml` itself is unparseable, plan lint still scans `design/phases/` directly so duplicate-id and naming checks can run on parseable phase files. Roadmap-dependent checks (`MISSING_PHASE_FILE`, `ORPHAN_PHASE_FILE`) are listed in `data.skipped_checks` so the agent can see exactly which checks were short-circuited.

### `plan normalize` (v0.7)

Conservative, line-based normalization for files under `design/` and the progress log. No YAML parse/re-stringify; the command operates on raw bytes per line so comments, key ordering, and document structure survive untouched.

**Targets:**

- Every `*.yaml` and `*.md` file reachable from `design/` (recursive).
- The legacy `.code-pact/state/progress.yaml`, if present (located via the shared progress IO helper, not hard-coded). Per-event files under `.code-pact/state/events/` are machine-generated and content-addressed, so they are **not** normalized.

**Normalization by file kind:**

| Kind              | CRLF → LF | Trailing whitespace stripped | Final newline = 1 |
| ----------------- | --------- | ---------------------------- | ----------------- |
| `*.yaml`, `*.yml` | ✓         | ✓                            | ✓                 |
| `*.md`            | ✓         | **preserved**                | ✓                 |

Markdown trailing whitespace is preserved because two trailing spaces are a meaningful hard line break. Stripping them would silently change rendered output.

**Modes:**

- No flag → `--check` (safe default; never writes).
- `--check` → dry-run. Lists files that would change and exits 1 when any are found.
- `--write` → applies normalization via the atomic-text helper. Exits 0 even when files were rewritten because writing is the command's purpose.
- `--check` and `--write` together → `PLAN_NORMALIZE_CONFLICT` exit 2.
- Unknown flag (e.g. typo `--wite`) → `CONFIG_ERROR` exit 2 (does NOT silently degrade to `--check`).

**Idempotency:** running `--write` twice in a row is a true no-op — the second invocation skips every file because the content already matches the normalized form. Running `--check` immediately after `--write` reports zero changes.

**Exit code:**

- `0` — `--check` found nothing to do, or `--write` succeeded.
- `1` — `--check` found at least one file that would change.
- `2` — argument conflict or unknown option.
- `3` — unexpected runtime error during a write.

**JSON shape (clean tree):**

```json
{
  "ok": true,
  "data": {
    "mode": "check",
    "changed_count": 0,
    "changes": [],
    "written": []
  }
}
```

**JSON shape (dirty tree under `--check`):**

```json
{
  "ok": false,
  "error": {
    "code": "PLAN_NORMALIZE_REQUIRED",
    "message": "plan normalize: 2 file(s) need normalization"
  },
  "data": {
    "mode": "check",
    "changed_count": 2,
    "changes": [
      {
        "path": "design/phases/P1.yaml",
        "kind": "yaml",
        "reasons": ["trailing whitespace", "final newline"]
      },
      {
        "path": "design/notes.md",
        "kind": "markdown",
        "reasons": ["crlf"]
      }
    ],
    "written": []
  }
}
```

**JSON shape (under `--write`):** identical to the dirty `--check` payload but with `mode: "write"`, `ok: true`, no `error` field, and `written` listing every file that was rewritten.

### `plan sync-paths` (v1.33)

Applies explicit `old=new` path mappings to **exact** entries in `tasks[].reads` / `tasks[].writes` under `design/phases/*.yaml`. The remediation for `TASK_READS_NO_MATCH` after a referenced source file is **renamed or merged**: it keeps the plan-lint reads-match invariant satisfied without hand-editing phase YAML. (A file that is **gone for good** is not a rename — remove the stale entry by hand; sync-paths only maps `old`→`new`.) The map is explicit because a moved file may be a rename, a merge, or a split — none recoverable from git heuristics.

**Scope:** only `tasks[].reads` and `tasks[].writes` under `design/phases/*.yaml`. Never touches other phase fields, the roadmap, CHANGELOG, RFC prose, or any non-phase file. Re-serializes a changed phase in the same canonical form as `task finalize` / `phase reconcile`; for canonical phase YAML this keeps the diff to the touched `reads` / `writes` lines. Hand-written comments or non-canonical formatting in a phase file are not preserved.

**Modes:**

- No flag → check (dry-run): report the changes, write nothing.
- `--write` → apply the changes via the atomic-text helper, under the write lock.
- `--rename` is repeatable. Many `from` → one `to` is a merge (the collapsed duplicates are de-duplicated, first-occurrence order preserved). One `from` → two different `to` is `CONFIG_ERROR`.
- A list with no matching entry is left verbatim — the file is not rewritten (a pre-existing duplicate is never silently removed).
- An unparseable phase file is skipped and surfaced in `data.skipped`, never blocking the rest.

**Exit code:**

- `0` — check completed, or write completed (even when files were rewritten).
- `2` — `CONFIG_ERROR`: missing `--rename`, malformed mapping (no `=`, empty side), identical `old`/`new`, conflicting mappings for one `from`, an unknown flag, or a stray positional.
- `3` — unexpected runtime failure while scanning phase files or writing (e.g. a `readdir` failure), surfaced even in the dry-run check.

**JSON success shape:**

```json
{
  "ok": true,
  "data": {
    "mode": "check",
    "renames": [{ "from": "src/old.ts", "to": "src/new.ts" }],
    "changes": [
      {
        "file": "design/phases/P1.yaml",
        "task_id": "P1-T1",
        "field": "reads",
        "from": "src/old.ts",
        "to": "src/new.ts"
      }
    ],
    "files_changed": ["design/phases/P1.yaml"],
    "written": [],
    "skipped": []
  }
}
```

Under `--write`, `mode` is `"write"` and `written` lists every rewritten file. `skipped` carries `{ file, reason }` for any phase that failed to parse.

### `plan analyze` (v0.7)

Cross-artifact integrity check. Compares design intent (task and phase `status`) against derived progress state (`deriveTaskState` over the progress ledger). Read-only.

**Issue families:**

- `STATUS_DRIFT` (one code, five mutually exclusive kinds in `details.kind`; top-down evaluation guarantees a single task never produces two issues):

  | kind                          | severity | hidden_by_default | affects_exit | trigger                                                                         |
  | ----------------------------- | -------- | ----------------- | ------------ | ------------------------------------------------------------------------------- |
  | `done-blocked-conflict`       | error    | —                 | true         | `design.status == done` && derived state is `blocked`                           |
  | `done-with-incomplete-events` | error    | —                 | true         | `design.status == done` && events exist && derived ∈ {started, resumed, failed} |
  | `done-historical`             | warning  | **true**          | **false**    | `design.status == done` && no progress events for this task                     |
  | `done-but-design-not-done`    | warning  | —                 | true         | derived `done` but `design.status` is `planned` or `in_progress`                |
  | `in-progress-no-events`       | warning  | —                 | true         | `design.status == in_progress` && no events (likely missing `task start`)       |

  **`details.remediation` (v1.2+, additive).** When `details.kind == "done-but-design-not-done"`, the issue's `details` payload also carries a `remediation` string of the form `"code-pact task finalize <task-id>"`. This is the mechanizable drift kind — `task finalize` / `phase reconcile` resolve it deterministically. The other four kinds need human judgement and do not carry a `remediation` field. The addition is additive on a `Record<string, unknown>` payload; existing JSON envelope consumers see no shape change.

- `PHASE_DONE_WITH_OPEN_TASKS` (error) — a phase with `status: done` that still has tasks not in `status: done`.
- `ORPHAN_PROGRESS_EVENT` (warning) — progress event references a `task_id` that does not exist in any phase. Detector is shared with `doctor`; `plan lint` does NOT call it.

**Severity model (no `info` tier):** `done-historical` carries `hidden_by_default: true` and `affects_exit: false` directly on the issue. This keeps the existing `error | warning` severity contract intact while letting analyze hide pre-v0.6 history from default output and from `--strict` exit codes.

**Strictness and visibility semantics.** Strict mode promotes `affects_exit: true` warnings to exit 1, mirroring `validate --strict` and `plan lint --strict`; it does not flip `hidden_by_default`, so historical issues stay hidden. Historical-visibility mode renders issues marked `hidden_by_default: true`; JSON consumers see them in `data.issues`, but the exit code is unchanged because `affects_exit: false` is independent of visibility.

**Exit code:**

- `0` — no `affects_exit: true` errors; under `--strict`, no `affects_exit: true` warnings either.
- `1` — at least one exit-relevant issue, or a schema/parse failure during the strict load.
- `2` — argument / configuration error.

**JSON shape (clean tree):**

```json
{
  "ok": true,
  "data": {
    "summary": {
      "phases": 5,
      "tasks": 20,
      "errors": 0,
      "warnings": 0,
      "hidden": 16
    },
    "strict": false,
    "include_historical": false,
    "issues": []
  }
}
```

**JSON shape (failing tree):**

```json
{
  "ok": false,
  "error": {
    "code": "PLAN_ANALYZE_FAILED",
    "message": "plan analyze failed: 1 error(s), 0 warning(s)"
  },
  "data": {
    "summary": {
      "phases": 1,
      "tasks": 1,
      "errors": 1,
      "warnings": 0,
      "hidden": 0
    },
    "strict": false,
    "include_historical": false,
    "issues": [
      {
        "code": "STATUS_DRIFT",
        "severity": "error",
        "message": "Task \"P1-T1\" is marked done in design but the progress log derives state \"blocked\".",
        "phase_id": "P1",
        "task_id": "P1-T1",
        "file": "design/phases/P1.yaml",
        "details": {
          "kind": "done-blocked-conflict",
          "design_status": "done",
          "derived_state": "blocked"
        }
      }
    ]
  }
}
```

### `plan migrate` (collaboration-safe-state RFC, B4)

Converts a legacy monolithic `.code-pact/state/progress.yaml` into the per-event ledger under `.code-pact/state/events/`. The migration is idempotent and dry-run by default; the legacy file is left in place because readers merge the legacy and per-event sources.

The command reports any task whose derived state changes under the merged `(at, id)` ordering so maintainers can review ordering-sensitive history before committing. A corrupt existing per-event file is wrapped as `PLAN_MIGRATE_FAILED`, matching the public-code contract above: ledger-read integrity diagnostics such as `EVENT_FILE_ID_MISMATCH` never leak as top-level `error.code` values from this command.

## `adapter` (v0.9)

In v0.9 `adapter` becomes a subcommand group. Each subcommand produces a stable
`{ok, data} | {ok:false, error:{code, message}}` JSON envelope under `--json`. The bare form
`code-pact adapter [--agent <name>] ...` (v0.5–v0.8) is **removed** (v1.20+): a bare
`code-pact adapter` with no subcommand now returns `CONFIG_ERROR` (exit 2) with no side
effects, directing the user to `code-pact adapter install <agent>`. `code-pact adapter --help`
(`-h`, `help`) prints usage and exits 0.

For generated adapter flags, usage, and examples, see the generated [CLI reference § Adapter commands](cli-reference.generated.md#adapter-commands). This section owns the stable adapter semantics: manifest model, write/read behavior, JSON envelopes, exit codes, diagnostics, and safety constraints.

### Per-agent manifest

`adapter install` writes `.code-pact/adapters/<agent>.manifest.yaml` recording every file
code-pact generated, its sha256 hash (computed from LF-normalized UTF-8 bytes), and a
fingerprint of the adapter-output-affecting profile fields. The manifest is the source of
truth for `adapter upgrade` / `adapter doctor`. Schema is documented in
`src/core/schemas/adapter-manifest.ts`; see `RelativePosixPath` for the path-safety rules
(no `..`, no leading `/` or `~`, no `\`, no Windows drive letters, no `.` segments).
Dynamic create-only files may carry `ownership: handed_off`: code-pact created
the file once, then treats the existing desired path as user-owned. Normal
install/upgrade/doctor/conformance runs do not read, hash, or overwrite existing
dynamic bytes; they compare only manifest hashes to current desired hashes.
Orphan pruning is the one narrow exception: a manifest-tracked orphan may be
read/hashed and pruned only when `managed: true`, `ownership: handed_off`, the
path is inside the adapter's reserved dynamic namespace, and the bytes still
match the manifest hash. The `code-pact-*` filename prefix alone is not
provenance; it is only one part of that prune authority.

### `--force` semantics — narrowed in v0.9

**Behavior change vs v0.8.** In v0.8, `adapter --force` overwrote every file unconditionally.
In v0.9, `--force` is **unmanaged-adoption only**: it adopts pre-existing files into the
manifest, but it NEVER overwrites a file already recorded in the manifest (`managed-modified`).

| Disk state                                                                                                        | `--force` action                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new` (manifest no, disk no)                                                                                      | always write (`--force` not needed)                                                                                                                                                                                                                                                                                                                                                          |
| `unmanaged × current` (disk matches desired, no manifest entry)                                                   | with `--force`: **adopt** (manifest only, no write)                                                                                                                                                                                                                                                                                                                                          |
| `unmanaged × stale` (disk differs from desired, no manifest entry)                                                | with `--force`: **replace_unmanaged** (overwrite + manifest)                                                                                                                                                                                                                                                                                                                                 |
| `managed-clean × stale` (disk matches the manifest hash but the generator output changed)                         | re-rendered to current output (**update**); `--force` not required. The file is verbatim generator output, so refreshing it loses no edits — and install does **not** trust a project-shipped (possibly forged) manifest hash to preserve stale generated content (security).                                                                                                                |
| `managed-clean × current` / `managed-modified × current` (already in the manifest, content matches the generator) | `skip` — `--force` is ignored. Install never overwrites a recorded file's local modifications.                                                                                                                                                                                                                                                                                               |
| `managed-modified × stale` (disk matches NEITHER the manifest hash NOR the generator output)                      | **`refuse`** — not overwritten (could be a genuine local edit), but **not silently skipped** either: it is surfaced (`result.refused[]`, `files[].action: "refuse"`) and `adapter install` exits **1**. This is the shape a hostile repo ships (malicious content + a forged manifest hash that does not match it); install never passes it over in silence. `--force` does not override it. |

Destructive overwrite of a managed-modified file requires `adapter upgrade --write --accept-modified`.
The `--regen-skills` flag is a role-scoped force: it makes `--force` apply only to files with
`role: skill`. It still cannot override `managed-modified`.

### `adapter list`

Returns one entry per registered adapter:

```json
{
  "ok": true,
  "data": {
    "agents": [
      {
        "name": "claude-code",
        "supported": true,
        "experimental": false,
        "enabled": true,
        "manifestPath": "/abs/path/.code-pact/adapters/claude-code.manifest.yaml",
        "profilePath": "/abs/path/.code-pact/agent-profiles/claude-code.yaml",
        "manifestPresent": true,
        "fileCount": 14,
        "lastGeneratedAt": "2026-05-19T12:00:00.000Z",
        "generatorVersion": "0.9.0-alpha.0"
      }
    ]
  }
}
```

`experimental: true` for `cursor` and `gemini-cli`. `enabled: true` when the agent appears
under `project.yaml`'s `agents:` list with `enabled != false`. `manifestPresent: false` when
no manifest exists yet; `fileCount` / `lastGeneratedAt` / `generatorVersion` are omitted
in that case. When the manifest YAML exists but fails parse or schema validation, the entry
sets `manifestInvalid: true` and omits the detail fields — use `adapter doctor`
for the parse error.

### `adapter install`

Generates the adapter for the named agent and writes the manifest.

`--model <version>` produces a **model-aware** instruction file for the claude-code adapter
with an effort-level and thinking guidance block for a supported Claude version
(`opus-4.8`, `opus-4.7`, `opus-4.6`, `sonnet-4.6`, plus vendor-id aliases such as
`claude-opus-4-8`). The guidance is intentionally generation-resistant — it avoids
per-generation capability claims and defers exact model capabilities to Anthropic's current
documentation. An unknown CLI `--model` value fails with `CONFIG_ERROR` (it is rejected
before anything is written). Takes precedence over `model_version` in the agent profile YAML;
if neither is set, the version-agnostic template is used. (Separately: if an existing profile
already contains an unrecognized `model_version`, generation falls back to the generic
guidance block and `doctor` reports `MODEL_ID_UNKNOWN`.)

`--regen-skills` is the role-scoped `--force` described above (it applies `--force` to skill
files only). It refreshes the **built-in** skills and adopts new ones, but it does **NOT**
overwrite an existing DYNAMIC command-skill: those live in the shared `.claude/skills/` dir
alongside hand-authored user skills, so a forged manifest + a colliding `verification.commands`
name could otherwise replace or hash-classify a user's skill. An existing dynamic skill is
therefore refused without reading its bytes (reason `unowned_generated_path`), regardless of
whether a manifest hash matches; `--accept-modified` does not override it. Safe automatic
re-render of dynamic skills will return with a reserved generated-skill namespace (follow-up).

Result envelope:

```json
{
  "ok": true,
  "data": {
    "agentName": "claude-code",
    "manifestPath": "/abs/.code-pact/adapters/claude-code.manifest.yaml",
    "generatorVersion": "0.9.0-alpha.0",
    "created": ["/abs/CLAUDE.md", "/abs/.claude/skills/context.md"],
    "skipped": [],
    "adopted": [],
    "files": [
      {
        "path": "/abs/CLAUDE.md",
        "relPath": "CLAUDE.md",
        "role": "instruction",
        "action": "write"
      }
    ]
  }
}
```

`created` lists files written (action `write` or `replace_unmanaged`). `adopted` lists files
recorded in the manifest without write (action `adopt`). `skipped` lists files we deliberately
did not touch (action `skip`, e.g. `managed-clean × current` is idempotent). `files[].action`
follows the eight-value enum from `src/core/adapters/file-state.ts`.

Exit codes: `0` ok, `2` config (missing positional / `AGENT_NOT_FOUND`), `3` internal.

### Automatic skill generation

When the claude-code adapter generates files, it reads `verification.commands` from every
phase in `design/roadmap.yaml` and emits a slash-command skill file for each unique command:

| Command          | Skill file                    | Slash command |
| ---------------- | ----------------------------- | ------------- |
| `pnpm test`      | `.claude/skills/test.md`      | `/test`       |
| `pnpm typecheck` | `.claude/skills/typecheck.md` | `/typecheck`  |
| `npm run lint`   | `.claude/skills/lint.md`      | `/lint`       |

Skill names are derived by stripping the package-manager prefix (`pnpm`, `npm run`, `yarn`,
`bun run`) and sanitizing to kebab-case. If `design/roadmap.yaml` does not exist, no dynamic
skills are generated (the three fixed skills — `/context`, `/verify`, `/progress` — are always
written). Duplicate commands across phases produce a single skill file.

### `adapter upgrade`

Inspects or applies adapter drift against the installed manifest. Requires an
existing manifest at `.code-pact/adapters/<agent>.manifest.yaml`; run
`adapter install <agent>` first on fresh projects. `--check` and `--write` are
**mutually exclusive and required** — passing neither (or both) is a
`CONFIG_ERROR` exit 2 so the intent is unambiguous in CI logs.

The generated adapter reference owns the exact flag list. The semantic constraints below are stable: `--check` is read-only, `--write` applies changes, `--accept-modified` is required to overwrite `managed-modified × stale` files, and `--model` has the same model-aware generation semantics as `adapter install --model`.

#### Action enum (8 values)

Each plan entry carries a `local`, `desired`, and `action` field. `action` is one of:

| Value               | Meaning                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `write`             | Create or recreate the file from desired content (managed-missing, new).                                                   |
| `skip`              | Idempotent no-op (managed-clean × current).                                                                                |
| `adopt`             | Record an existing on-disk file in the manifest; no content write (unmanaged × current with `--force`).                    |
| `replace_unmanaged` | Overwrite an unmanaged-but-stale file (unmanaged × stale with `--force`).                                                  |
| `update`            | Overwrite a managed file. Used for `managed-clean × stale` (safe) and `managed-modified × stale` with `--accept-modified`. |
| `update_manifest`   | Refresh the manifest hash only; disk content already matches desired (managed-modified × current).                         |
| `refuse`            | Would destroy local modifications without `--accept-modified` (managed-modified × stale).                                  |
| `warn`              | Surfaceable in `--check` for unmanaged rows regardless of `--force`. `--write` never produces this.                        |

#### Check mode

Fully read-only. Returns the action `--write` WOULD take for each desired file
with two intentional differences:

- **Unmanaged rows always return `warn`** regardless of `--force`, so callers can
  see which files are adoptable before opting in.
- **`managed-modified × stale` always returns `refuse`** regardless of
  `--accept-modified`, so callers see the pending destructive action before
  re-running with `--write --accept-modified`.

```json
{
  "ok": true,
  "data": {
    "agentName": "claude-code",
    "mode": "check",
    "manifestPath": "/abs/.code-pact/adapters/claude-code.manifest.yaml",
    "generatorVersion": "0.9.0-alpha.0",
    "clean": false,
    "plan": [
      {
        "path": "/abs/CLAUDE.md",
        "relPath": "CLAUDE.md",
        "role": "instruction",
        "local": "managed-clean",
        "desired": "stale",
        "action": "update"
      }
    ]
  }
}
```

Exit codes: `0` clean (every entry is `action: skip`), `1` drift detected (any
non-skip action), `2` on `CONFIG_ERROR` (missing positional, mutex flags) /
`AGENT_NOT_FOUND` / `MANIFEST_NOT_FOUND` / adapter transaction recovery or cleanup faults
(`PARTIAL_MUTATION`, `TRANSACTION_CLEANUP_PENDING`, `ADAPTER_TRANSACTION_RECOVERY_FAILED`).

#### Write mode

Executes the action matrix. The new manifest reflects the post-write state:
files written / adopted have their hash refreshed, skipped managed files
preserve their existing hash, refused entries are preserved unchanged.
Writes are applied through a staged transaction with a durable journal in
code-pact's user-private state directory, keyed by the canonical project root
and optionally rooted at absolute `CODE_PACT_STATE_HOME`. The prepared journal
is written before project-side temp files are created. Before a new write begins,
pending adapter journals are recovered; legacy project-local journals under
`.code-pact/state/adapter-transactions/` are rejected rather than executed.
Cleanup failures after the durable commit marker do not roll back committed
final files; they surface as `TRANSACTION_CLEANUP_PENDING`.

**Orphan handling (security — CWE-73).** An orphan is a manifest entry the
generator no longer emits. Because the manifest is project-controlled and
unauthenticated, an orphan is **auto-deleted (`action: "prune"`) only when
static ownership (`ownedPathRoles`) or a reserved dynamic handoff
(`ownership: handed_off` inside the adapter's role-scoped dynamic namespace)
proves code-pact ownership** AND its content still matches the manifest hash.
An owned orphan the user edited is `refuse`d (kept on disk). An orphan outside
those ownership proofs is never deleted — even when clean — but surfaced as
`action: "warn"` (with a machine-readable
`reason: "unowned_orphan_not_pruned"` on the plan entry) and kept tracked, so a
forged manifest entry (any in-project path + that file's real sha256) cannot
turn `upgrade --write` into an arbitrary in-project delete. The human CLI names
each kept file and the manual-removal step; a warn-only `--check` exits 1
without claiming `--write` would clear it. Files left on disk that are not in
the new manifest are surfaced by the next `adapter doctor` run as
`ADAPTER_UNMANAGED_FILE` if they fall under the adapter's `ownedPathRoles`.
An unowned orphan is not statted, read, or hashed; its plan state is always
`local: "unverifiable"`, whether the target is present, missing, hash-matching,
or divergent.

For `claude-code`, `.claude/skills/code-pact-*.md` is the reserved dynamic
namespace for code-pact-generated verification-command skills. User-authored
skills should not use that prefix. Legacy dynamic skills generated before the
reserved prefix existed remain in the shared `.claude/skills/*.md` namespace;
they are intentionally warn-only/manual-removal orphans rather than
auto-pruned, because their path alone cannot distinguish code-pact output from
hand-authored skills.

```json
{
  "ok": true,
  "data": {
    "agentName": "claude-code",
    "mode": "write",
    "manifestPath": "/abs/.code-pact/adapters/claude-code.manifest.yaml",
    "generatorVersion": "0.9.0-alpha.0",
    "clean": false,
    "plan": [
      {
        "path": "/abs/CLAUDE.md",
        "relPath": "CLAUDE.md",
        "role": "instruction",
        "local": "managed-clean",
        "desired": "stale",
        "action": "update"
      }
    ]
  }
}
```

Exit codes: `0` ok (all changes applied or all-skip), `1` when any file was
`refused` (managed-modified × stale without `--accept-modified`), `2` on the
same `CONFIG_ERROR` / `AGENT_NOT_FOUND` / `MANIFEST_NOT_FOUND` conditions as
`--check`.

`adapter upgrade` repairs generator/desired file drift; it deliberately does
**not** rewrite a profile's `model_map` (a pin may be intentional), so a
`MODEL_MAP_STALE` advisory survives a `--write`. To make that non-obvious (run
upgrade, one advisory remains, "why?"), a successful `--write` with no refused
files that leaves the `claude-code` `model_map` pinned to a known-but-not-current
id prints a human-only **"Remaining manual advisory: MODEL_MAP_STALE"** note on
stderr naming the stale tier, the current default, the profile path to hand-edit, and
the `doctor.yaml` silence path. It never advises `--model` (which re-pins
`model_version`, not `model_map`) and never mutates `model_map`. It honors the
same suppression as `doctor` — a project with `disabled_checks: [MODEL_MAP_STALE]`
in `.code-pact/doctor.yaml` gets no hint — and is withheld when any file was
`refused` (there the actionable step is `--accept-modified`, which the hint's
"re-run `--write`" would contradict). The note is human-output only — the
`--json` envelope is unchanged; `doctor --json` remains the machine-readable
source for the advisory.

### `adapter doctor`

Read-only manifest-aware health check. Reports issues per agent without
modifying the manifest or any generated files. With `--agent`, inspects
exactly that adapter regardless of `project.yaml` enabled-state; without
`--agent`, inspects every enabled agent listed under `project.yaml`'s
`agents:` (with `enabled != false`).

```json
{
  "ok": true,
  "data": {
    "ok": false,
    "issues": [
      {
        "code": "ADAPTER_FILE_MISSING",
        "severity": "error",
        "message": "Managed file \"CLAUDE.md\" is missing from disk",
        "agent": "claude-code",
        "path": "/abs/CLAUDE.md"
      }
    ]
  }
}
```

`data.ok` is `false` when any issue has `severity: "error"`; warnings alone
don't fail. Exit code mirrors that: `0` clean or warnings-only, `1` when
any error is present, `2` for `AGENT_NOT_FOUND` (only on explicit
`--agent`). Each issue carries the agent name in `agent`; file-level
issues additionally carry `path` (absolute).

#### Error codes

| Code                        | Severity | Trigger                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADAPTER_MANIFEST_MISSING`  | warning  | Agent is enabled but `.code-pact/adapters/<agent>.manifest.yaml` does not exist. **`adapter doctor` only — never emitted by global `doctor`.**                                                                                                                                                                                                                                                                                                 |
| `ADAPTER_MANIFEST_INVALID`  | error    | Manifest YAML failed to parse or failed schema validation. Aborts further per-agent checks.                                                                                                                                                                                                                                                                                                                                                    |
| `ADAPTER_GENERATOR_STALE`   | warning  | Manifest's `generator_version` differs from the current code-pact package version (simple equality, no semver ordering) **and** the current desired generated adapter output is not byte-identical to the manifest. A stamp-only version lag — the generated files match what the current generator produces — is silent (Issue #340, v1.30.1).                                                                                                |
| `ADAPTER_SCHEMA_DRIFT`      | warning  | Manifest's `adapter_schema_version` is older than the adapter module's declared value.                                                                                                                                                                                                                                                                                                                                                         |
| `ADAPTER_PROFILE_MISSING`   | error    | A manifest exists for the agent, but the configured agent profile file is missing. The adapter cannot regenerate or verify desired output without the profile. Restore `.code-pact/agent-profiles/<agent>.yaml` or update `project.yaml` to an owned profile path.                                                                                                                                                                             |
| `ADAPTER_PROFILE_INVALID`   | error    | The configured agent profile could not be read, parsed, schema-validated, or its declared `name` did not match the requested agent. The profile is not used for generation or diagnostics.                                                                                                                                                                                                                                                     |
| `ADAPTER_PROFILE_DRIFT`     | warning  | Agent profile fields recorded in `profile_fingerprint` (instruction_filename, context_dir, optional skill_dir / hook_dir / resolved_model) have changed since install.                                                                                                                                                                                                                                                                         |
| `ADAPTER_FILE_MISSING`      | error    | A file listed in the manifest is missing from disk (`managed-missing` × `absent`).                                                                                                                                                                                                                                                                                                                                                             |
| `ADAPTER_FILE_PATH_UNSAFE`  | error    | A file listed in the manifest cannot be proven project-contained (for example, it resolves through an external symlink). The file is not read, so external target contents do not appear in human or JSON output.                                                                                                                                                                                                                              |
| `ADAPTER_FILE_DRIFT`        | warning  | A managed file was locally modified AND the generator output also moved on (`managed-modified` × `stale`). Requires `--accept-modified` on `upgrade --write`.                                                                                                                                                                                                                                                                                  |
| `ADAPTER_DESIRED_STALE`     | warning  | A managed file is unchanged locally but the generator now produces different content (`managed-clean` × `stale`). Safe to apply with `upgrade --write` (no `--accept-modified` required).                                                                                                                                                                                                                                                      |
| `ADAPTER_FILE_UNVERIFIABLE` | warning  | A manifest file is in the shared skills namespace (role-scoped `createPathGlobsByRole`) but not in the current exact generated set (`ownedPathRoles`) and is not recorded as `ownership: handed_off` — read-ownership cannot be proven, so it is not read or verified (forged-manifest content/SHA-oracle guard). Handed-off dynamic entries also skip existing-byte reads; doctor may still warn when the manifest entry is missing from current desired output or its recorded hash is stale. Remove the stray file if no longer needed. |
| `ADAPTER_UNMANAGED_FILE`    | warning  | A file under one of the adapter's `ownedPathRoles` (exact static owned paths) exists on disk but is not in the manifest. Narrow scope — does NOT fire for arbitrary user-created files such as `.claude/skills/custom.md`.                                                                                                                                                                                                                     |
| `MODEL_PROFILES_UNSAFE`     | error    | `.code-pact/model-profiles` is a symlink or resolves outside the project root. Profiles were not read; model-unaware output may result. Remove the symlink or restore the directory to a real project-contained path.                                                                                                                                                                                                                          |
| `MODEL_PROFILES_INVALID`    | error    | A present `.code-pact/model-profiles/*.yaml` entry is unreadable, malformed, schema-invalid, or not a regular file. Profiles were not read; fix or remove the bad entry.                                                                                                                                                                                                                                                                       |

`managed-modified × current` (hash drift only) and `managed-clean × current`
(happy path) are intentionally silent.

#### Adapter file drift classification (two-axis)

`adapter doctor` classifies every managed adapter file along **two
independent axes** and emits a per-combination code. The classification has
been stable since v0.9 (P7) and is what `adapter doctor` uses to decide
whether each issue is "the upstream template changed", "the user edited
the file", or both. Understanding the axes makes the imperfectly-named
`ADAPTER_FILE_DRIFT` / `ADAPTER_DESIRED_STALE` codes self-explanatory.

| local state        | what it means                                                                                                                                                                                | source of truth |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `managed-clean`    | The file on disk is byte-identical to what the manifest recorded at install time (disk hash == manifest hash). The user has not edited the file since `adapter install` / `adapter upgrade`. | manifest sha256 |
| `managed-modified` | The disk hash differs from the manifest hash. The user has edited the file (or some non-adapter tool has touched it).                                                                        | manifest sha256 |
| `managed-missing`  | A file the manifest lists is missing from disk.                                                                                                                                              | manifest        |

| desired state | what it means                                                                                                                                                                                                                    | source of truth        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `current`     | The current generator output (i.e. what `adapter install` would produce now, with the current template / model / profile) is byte-identical to the file on disk. The upstream template has not drifted from the on-disk content. | generator output today |
| `stale`       | The current generator output differs from the on-disk content. The upstream template (or a profile field that affects output) has changed since the file was written.                                                            | generator output today |

The doctor's emitted code is determined by the **combination** of the two axes:

| local × desired              | doctor code                         | meaning                                                                                                                         | remediation                                                                                                  |
| ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `managed-clean × current`    | (silent — happy path)               | File untouched, template untouched. Nothing to do.                                                                              | —                                                                                                            |
| `managed-clean × stale`      | `ADAPTER_DESIRED_STALE`             | **Upstream template changed; local file was NOT edited.** Pure upgrade case.                                                    | `code-pact adapter upgrade <agent> --write`                                                                  |
| `managed-modified × current` | (silent — manifest-hash-only drift) | File content already matches current desired output; only the manifest hash entry is out of date. Not a substantive divergence. | No action required. The next `adapter upgrade` will refresh the manifest.                                    |
| `managed-modified × stale`   | `ADAPTER_FILE_DRIFT`                | **Upstream template changed AND local file was edited.** Both axes diverge — overwriting would lose user edits.                 | Review local edits; if overwrite is intended, `code-pact adapter upgrade <agent> --write --accept-modified`. |
| `managed-missing`            | `ADAPTER_FILE_MISSING`              | A managed file in the manifest is missing from disk.                                                                            | Re-run `adapter install` or `adapter upgrade --write`.                                                       |

The naming is imperfect — `ADAPTER_FILE_DRIFT` covers the "both axes diverged" case, not the generic "any drift" case it sounds like. The names predate the two-axis classification's full surface and are locked under the v1.0 stability contract; renaming them is a breaking change to `KNOWN_CODES.public`, so the semantics are documented here instead.

This classification subsumes a `template_signature` field that was once considered for `adapter_schema_version: 2`. The investigation (P22, 2026-05) found the two-axis classification already covers the drift-attribution use case; see the **P22 cancelled-adapter-schema-v2** decision record (retired — in git history / the `.code-pact/state` archive record).

#### Interaction with global `doctor`

The global `code-pact doctor` is **manifest-aware when a manifest exists**
and **byte-identical to v0.8 when no manifest exists**. Specifically:

- No manifest → the legacy `ADAPTER_MISSING` warning fires for each enabled
  agent whose instruction file is missing. The v0.8 contract is preserved
  for projects that have not yet run `adapter install`.
- Manifest present → `ADAPTER_MISSING` is skipped and the more precise
  manifest-aware codes (`ADAPTER_FILE_MISSING`, `ADAPTER_FILE_DRIFT`,
  `ADAPTER_DESIRED_STALE`, `ADAPTER_GENERATOR_STALE`, `ADAPTER_SCHEMA_DRIFT`,
  `ADAPTER_PROFILE_DRIFT`, `ADAPTER_UNMANAGED_FILE`) appear instead.
- `ADAPTER_MANIFEST_MISSING` is **never** emitted by global `doctor`. It is
  an `adapter doctor`-only signal so existing projects don't suddenly
  become noisy on upgrade. Use `adapter doctor` to learn that the
  manifest hasn't been created yet.

Findings from manifest-aware checks appear in global `doctor` output with
a `[agent-name]` prefix on the message so consumers can attribute issues
without changing the global `DoctorIssue` shape.

### Bare-form removed (v1.20+)

The bare form `code-pact adapter [--agent <name>] ...` (which implicitly ran `adapter install`)
is **removed**. A `code-pact adapter` invocation with no subcommand now returns `CONFIG_ERROR`
(exit 2) and performs **no** filesystem mutation — a warning that also installs was exactly the
"warning + side effect" hazard the v1.20 hardening pass closed. Use `code-pact adapter install
<agent>` explicitly. `code-pact adapter --help` / `-h` / `help` prints usage and exits 0.

### `adapter conformance` (v1.11+, P21)

Focused read-only check that the installed adapter satisfies the agent contract. Each check carries a `severity` (`required` | `advisory`); `compliant` is `true` unless a **required** check fails. The CLI exits 0 when compliant, 1 when not. No state is mutated.

Conformance is intentionally narrower than `adapter doctor` — it inspects only the contract shape and per-file integrity. `ADAPTER_GENERATOR_STALE` / `ADAPTER_PROFILE_DRIFT` / `ADAPTER_UNMANAGED_FILE` remain doctor-only diagnostics.

```json
{
  "ok": true,
  "data": {
    "agent": "claude-code",
    "compliant": true,
    "checks": [
      { "id": "manifest_present", "status": "pass", "severity": "required" },
      {
        "id": "instruction_file_present",
        "status": "pass",
        "severity": "required",
        "file": "CLAUDE.md"
      },
      {
        "id": "contract_section_present",
        "status": "pass",
        "severity": "required",
        "file": "CLAUDE.md"
      },
      {
        "id": "axis_when_to_invoke",
        "status": "pass",
        "severity": "required",
        "file": "CLAUDE.md"
      },
      {
        "id": "axis_what_to_verify",
        "status": "pass",
        "severity": "required",
        "file": "CLAUDE.md"
      },
      {
        "id": "axis_how_to_handle",
        "status": "pass",
        "severity": "required",
        "file": "CLAUDE.md"
      },
      {
        "id": "required_cli_surface_mentions",
        "status": "pass",
        "severity": "required",
        "file": "CLAUDE.md",
        "details": {
          "lifecycle_required": [
            "code-pact task prepare",
            "code-pact task start",
            "code-pact task complete",
            "code-pact task finalize"
          ],
          "diagnostic_required": [
            "code-pact task context",
            "code-pact verify",
            "code-pact validate"
          ],
          "missing_lifecycle": [],
          "missing_diagnostic": []
        }
      },
      {
        "id": "required_failure_guidance",
        "status": "pass",
        "severity": "required",
        "file": "CLAUDE.md",
        "details": {
          "required": [
            "blocked dependency",
            "verification failure",
            "adapter drift",
            "missing context pack"
          ],
          "missing": []
        }
      },
      {
        "id": "task_prepare_is_primary",
        "status": "pass",
        "severity": "advisory",
        "file": "CLAUDE.md"
      },
      {
        "id": "no_contract_antipatterns",
        "status": "pass",
        "severity": "advisory",
        "file": "CLAUDE.md"
      },
      {
        "id": "activation_rules_documented",
        "status": "pass",
        "severity": "advisory",
        "file": "CLAUDE.md"
      },
      {
        "id": "file_checksum_match",
        "status": "pass",
        "severity": "required",
        "file": "CLAUDE.md"
      }
    ]
  }
}
```

Every check object carries a `severity` (`required` | `advisory`). The three P30 hardening checks (`task_prepare_is_primary`, `no_contract_antipatterns`, `activation_rules_documented`) show `advisory` above because this example's manifest `generator_version` predates the hardening threshold; on an adapter generated at or after it they are `required`.

#### Checks

| Check id                             | What it asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest_present`                   | `.code-pact/adapters/<agent>.manifest.yaml` exists and parses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `instruction_file_present`           | A manifest entry has `role: instruction` and the file is on disk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `contract_section_present`           | The instruction file contains the verbatim `## Agent contract` heading                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `axis_when_to_invoke`                | The instruction file contains `### When to invoke code-pact`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `axis_what_to_verify`                | The instruction file contains `### What to verify first`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `axis_how_to_handle`                 | The instruction file contains `### How to handle failures`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `required_cli_surface_mentions`      | Every entry in both `lifecycle_required` and `diagnostic_required` (defined in `src/core/adapters/conformance-spec.ts`) is mentioned somewhere in the instruction file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `required_failure_guidance`          | Every failure keyword (`blocked dependency`, `verification failure`, `adapter drift`, `missing context pack`) is mentioned somewhere in the instruction file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `task_prepare_is_primary`            | `code-pact task prepare` appears in the instruction and precedes the first `code-pact recommend` / `code-pact task context` mention (it is the primary per-task entrypoint)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `no_contract_antipatterns`           | The instruction / its examples contain no P29 anti-pattern (e.g. `task finalize ... --agent`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `activation_rules_documented`        | The activation-rule anchors (`task finalize --write`, `wait_for_dependencies`, `CONTEXT_OVER_BUDGET`) are present — verifies documentation presence, not runtime obedience                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `file_checksum_match`                | One per manifest file: the on-disk LF-normalised UTF-8 sha256 equals the manifest's recorded value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `adapter_file_path_unowned`          | A manifest entry (the `role: instruction` file, or any `files[]` entry) names a path this adapter could not have generated, that resolves through a symlink, or whose declared role disagrees with the path's only legitimate static role. The target is NOT read — no `actual_sha256` and no contract-heading inspection are produced — so a forged manifest cannot turn conformance into a file-content/SHA oracle on arbitrary local files (e.g. `.env`). Read authority is the NARROW built-in path set (`ownedPathRoles`) with a matching declared role, NOT the broad create namespace — so a victim's hand-authored `.claude/skills/private.md` is refused too, and a role-swap (e.g. `CLAUDE.md` with `role: skill`) is `unowned` before any filesystem access. Always `required` severity (fail-closed). |
| `file_checksum_skipped_unverifiable` | A manifest entry names a dynamically-generated skill in the shared `.claude/skills/` namespace (matches the role-scoped `createPathGlobsByRole` for role=skill but not the narrow read-authority set `ownedPathRoles`) and is not recorded as `ownership: handed_off`. Its name is attacker-influenceable, so read-ownership cannot be proven: the file is NOT read or checksummed. `advisory` severity. To regenerate, move or delete the file, then run `adapter upgrade <agent> --write`.                                                                                                                                                                                                                                                                              |
| `dynamic_handoff_orphan_unverified`  | A manifest entry is `ownership: handed_off` and names a dynamic skill under the adapter's role-scoped create namespace, but the file is missing. Existing bytes are not read. Conformance compares only the current desired output hash with the manifest hash; when they match, `adapter upgrade <agent> --write` can safely prune the stale manifest entry. `advisory` severity.                                                                                                                                                                                                                                                                                                                                                                          |
| `dynamic_handoff_manifest_stale`     | A manifest entry is `ownership: handed_off` and names a dynamic skill under the adapter's role-scoped create namespace, but the current desired output hash differs from the manifest hash. Existing bytes are not read or checksummed. The stale manifest entry is surfaced as `advisory`; regenerate the adapter or review the handoff before relying on orphan pruning.                                                                                                                                                                                                                                                                                                                                                                             |

#### Severity (v1.x, P30)

Each check carries a `severity`: `required` or `advisory`. `compliant` is `true` unless a **required** check fails; a failing `advisory` check is reported (its `details` carry an `adapter upgrade <agent> --write` remediation) but does not break compliance or change the exit code. Most checks are `required`. The three P30 hardening checks (`task_prepare_is_primary`, `no_contract_antipatterns`, `activation_rules_documented`) resolve severity per install from the manifest `generator_version`: `required` when it is semver >= `ADAPTER_CONTRACT_HARDENING_FROM_VERSION` (defined in `src/core/adapters/conformance-spec.ts`), `advisory` below (or when the version is missing / unparseable). This keeps adapters that predate the P29-aligned templates warning rather than hard-failing until they are re-upgraded. Dynamic read-authority checks that cannot prove safe byte reads (`file_checksum_skipped_unverifiable`, `dynamic_handoff_orphan_unverified`, `dynamic_handoff_manifest_stale`) are always `advisory`.

`adapter conformance` and `adapter doctor` share the module `src/core/adapters/conformance-spec.ts`, but they consume different parts of it and check different things. `adapter conformance` is the only caller that reads the `lifecycle_required` / `diagnostic_required` surface lists and the `REQUIRED_FAILURE_GUIDANCE` keywords (the `required_cli_surface_mentions` and `required_failure_guidance` checks above). `adapter doctor`'s `ADAPTER_CONTRACT_DRIFT` check consumes only the heading constants from the same module (`AGENT_CONTRACT_SECTION_HEADING` and `AGENT_CONTRACT_AXIS_HEADINGS`) — it asserts the `## Agent contract` section and its three axis sub-headings are present, not that the required CLI surface or failure guidance is mentioned. So the shared module guarantees the two callers agree on the contract's _headings_; the required-surface and failure-guidance checks are `adapter conformance`-only.

#### Exit codes

| Code | Condition                                                                             |
| ---- | ------------------------------------------------------------------------------------- |
| 0    | `compliant: true`                                                                     |
| 1    | `compliant: false`                                                                    |
| 2    | `CONFIG_ERROR` (missing `<agent>` positional), `AGENT_NOT_FOUND` (unknown agent name) |

No new error codes are introduced by `adapter conformance`; the existing `ADAPTER_*` and `AGENT_*` family covers every failure mode.

## `task context` — context quality gates (v0.5.1, v1.1 additions)

`code-pact task context <task-id> [--agent <name>] [--json]` generates a context pack whose
content is determined by the task's attributes:

| Attribute       | Value   | Effect on context pack                                                                |
| --------------- | ------- | ------------------------------------------------------------------------------------- |
| `context_size`  | `large` | Includes `design/constitution.md` + **all** decision files                            |
| `context_size`  | `small` | Minimal: phase contract + task definition only (no rules, decisions, or constitution) |
| `ambiguity`     | `high`  | Includes `design/constitution.md` + up to 5 recent `done` events from the same phase  |
| `write_surface` | `high`  | Includes **all** rule files in `design/rules/`, bypassing `applies_to` filters        |

The `char_count` (total characters in the rendered pack) and `included_constitution` flag
are included in the `--json` result. Missing design files are silently skipped.

### P10 declared sections (v1.1+)

When a task declares any of the [P10 Task Readiness Schema fields](#phase-import) (`depends_on`, `decision_refs`, `reads`, `writes`, `acceptance_refs`), the pack body gains the corresponding sections in this fixed order, inserted after the Task Definition block and before the existing "Related Decisions" section:

| Order | Section                     | Contents when declared                                                                                                                                                                                                                                                                                                           |
| ----- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `## Depends on`             | List of declared task ids with derived current state from the progress ledger (`planned` / `started` / `blocked` / `resumed` / `done` / `failed`).                                                                                                                                                                               |
| 2     | `## Declared read surface`  | Each `reads` glob with currently-matched Git tracked repo-relative file paths. `_(no current matches on disk)_` line when the glob matches nothing tracked (mirrors the `TASK_READS_NO_MATCH` lint warning).                                                                                                                     |
| 3     | `## Declared write surface` | Each `writes` glob, declaration-only — no fs lookup because writes are future-tense.                                                                                                                                                                                                                                             |
| 4     | `## Declared decisions`     | Full body of every file referenced by `decision_refs`. Surfaced **regardless** of `context_size` (in addition to, not replacing, the existing `context_size: large` allDecisions path). Files referenced via `decision_refs` are removed from the existing "Related Decisions" section to avoid printing the same content twice. |
| 5     | `## Acceptance references`  | Path list only in P10. No content excerpt; richer rendering is deferred to P11 reconcile.                                                                                                                                                                                                                                        |

When a task declares **none** of the P10 fields, the pack body is byte-identical to v1.0.2. The byte-identical contract is locked by `tests/integration/pack-byte-identical.test.ts` against a checked-in golden fixture (`tests/fixtures/golden/pack-v1.0.2-shaped.md`).

### `--explain` (v1.11+, P21)

`code-pact task context <task-id> [--agent <name>] --explain [--json]` returns the per-section byte breakdown of the rendered context pack and the list of sections that were intentionally excluded.

**Byte-identical guarantee.** The pack `content` returned in `--json` mode is byte-for-byte identical with or without `--explain` — the flag only attaches metadata. The existing byte-identical lock test (`tests/integration/pack-byte-identical.test.ts`) catches regressions.

**JSON additions.** When `--explain --json` is passed, the existing envelope gains:

| Field                | Type    | Notes                                                                                  |
| -------------------- | ------- | -------------------------------------------------------------------------------------- |
| `total_bytes`        | integer | `Buffer.byteLength(content, "utf8")`                                                   |
| `context_pack_bytes` | integer | Alias of `total_bytes` for callers that read this name elsewhere (e.g. `task prepare`) |
| `sections[]`         | array   | One entry per included section; see below                                              |
| `excluded[]`         | array   | Sections that were not emitted, with the reason; see below                             |

**Acceptance invariant.** `sum(sections[].bytes) === total_bytes === context_pack_bytes`. The renderer's inter-section newlines are captured as a synthetic `format_overhead` section so the invariant holds without any unattributed bytes.

**Context Fit explain metrics (v1.30+, P49).** `--explain --json` additionally surfaces byte metrics that make the pack's _fit_ observable. They are **byte-based, not token-based** (every value is `Buffer.byteLength(…, "utf8")`), computed **locally and deterministically** — no tokenizer, summarization, model call, or network access is involved — and they never change the rendered `content`. The fields are additive; the existing fields above are unchanged.

| Field                      | Type    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `natural_bytes`            | integer | The **pre-budget** pack size: the bytes the no-budget builder would render for this task (after the existing deterministic relevance/readiness selection, before any budget-driven elision). Not a whole-repository size, not a token count.                                                                                                                                                                                                                       |
| `final_bytes`              | integer | The post-budget pack size. **Equals `total_bytes` == `context_pack_bytes`.**                                                                                                                                                                                                                                                                                                                                                                                       |
| `budget_bytes`             | integer | Present **only when a budget was applied** (via `--budget-bytes` or `--context-budget`); omitted otherwise. Equals the resolved byte budget (an agent same-name `context_budget` override is reflected here).                                                                                                                                                                                                                                                      |
| `saved_bytes`              | integer | `natural_bytes - final_bytes` — the bytes removed by **budget-driven elision only**. `0` when no section was elided.                                                                                                                                                                                                                                                                                                                                               |
| `saved_ratio`              | number  | `saved_bytes / natural_bytes` (a fraction in `[0, 1]`; `0` when `natural_bytes === 0`). The illustrative value below is rounded for readability — the field is the exact quotient.                                                                                                                                                                                                                                                                                 |
| `minimum_achievable_bytes` | integer | The floor below which no budget can drive this task — the size after every budget-**eligible** section is elided, honoring the P28 conditional eligibility (`related_decisions` elidable only when `context_size: large`; `rules` only when `write_surface: high`). **This is the same floor the [`CONTEXT_OVER_BUDGET`](#--budget-bytes-n-v113-p24) error reports, computed by the same shared helper** — the success path and the error path can never disagree. |
| `elided_sections[]`        | array   | A convenience projection of the **budget-elided** sections only, in actual elision order — `{ "name": string, "bytes": number }`. Mirrors the `budget_reserved_for_later` subset of `excluded[]`. `[]` when no budget elision occurred.                                                                                                                                                                                                                            |

```jsonc
{
  "natural_bytes": 95000,
  "final_bytes": 58720, // == total_bytes == context_pack_bytes
  "budget_bytes": 60000, // present only when a budget was applied
  "saved_bytes": 36280, // natural_bytes - final_bytes (0 with no elision)
  "saved_ratio": 0.381, // saved_bytes / natural_bytes (rounded here for display)
  "minimum_achievable_bytes": 28120,
  "elided_sections": [{ "name": "completed_tasks", "bytes": 1200 }],
}
```

With **no** budget, `natural_bytes === final_bytes`, `saved_bytes === 0`, `saved_ratio === 0`, `elided_sections === []`, and `budget_bytes` is omitted. The metrics make the existing P24/P47 budget behavior observable; they introduce **no new reduction policy** — only an explicit `--budget-bytes` / `--context-budget` invocation can elide sections, and the no-flag pack stays byte-identical. The metrics surface only on `--explain --json` (not on normal `task context` output, and not on `task prepare`).

**`sections[]` entry shape:**

```json
{
  "name": "reads",
  "bytes": 950,
  "reason_code": "glob_match",
  "details": { "glob_count": 3, "match_count": 12 }
}
```

`reason_code` is a closed enum:

| `reason_code`         | Section(s)                                                                                                                                                                                  | Meaning                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `always_included`     | `header`, `phase_contract`, `task_definition`, `verification_commands`, `progress_event_schema`, `rules` (when `write_surface != high`), `related_decisions` (when `context_size != large`) | Unconditionally emitted                                        |
| `context_size_large`  | `constitution` (when `context_size: large`), `related_decisions` (when `context_size: large`)                                                                                               | Emitted because the task's `context_size` is `large`           |
| `ambiguity_high`      | `constitution` (when only `ambiguity: high`), `completed_tasks`                                                                                                                             | Emitted because the task's `ambiguity` is `high`               |
| `write_surface_high`  | `rules` (when `write_surface: high`)                                                                                                                                                        | Emitted because the task's `write_surface` is `high`           |
| `declared_by_task`    | `depends_on`, `writes`, `acceptance_refs`                                                                                                                                                   | Emitted because the task declared the corresponding P10 field  |
| `referenced_decision` | `declared_decisions`                                                                                                                                                                        | Emitted because the task referenced one or more decision files |
| `glob_match`          | `reads`                                                                                                                                                                                     | Emitted because the task declared `reads` globs                |
| `format_overhead`     | `format_overhead`                                                                                                                                                                           | Synthetic section capturing inter-section newlines             |

**`excluded[]` entry shape:**

```json
{
  "name": "constitution",
  "reason_code": "context_size_small_and_ambiguity_low"
}
```

`reason_code` for `excluded[]` is a separate closed enum:

| `reason_code`                          | Emitted when                                                                                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context_size_small_and_ambiguity_low` | A section was excluded because the task's `context_size` is not `large` and `ambiguity` is not `high` (e.g. `constitution`, `completed_tasks`) — or because `context_size` is `small` (e.g. `rules`)                    |
| `not_declared_by_task`                 | A P10 declared section (`depends_on`, `reads`, `writes`, `declared_decisions`, `acceptance_refs`) is absent because the task did not declare the corresponding field                                                    |
| `glob_no_match`                        | Reserved for future per-glob exclusion detail; not emitted in v1.11                                                                                                                                                     |
| `budget_reserved_for_later`            | Emitted by `--budget-bytes` (v1.13+, P24): the section was elided to meet the requested byte budget. In v1.11 / v1.12 the value was reserved and never emitted (a unit test asserts the absence in the no-budget path). |

**Human mode.** `--explain` without `--json` prints a table of included and excluded sections to stdout instead of the pack body.

### `--budget-bytes <N>` (v1.13+, P24)

`code-pact task context <task-id> [--agent <name>] [--json] [--explain] --budget-bytes <N>` enforces a deterministic upper bound on the rendered pack size by progressively eliding sections in a fixed priority order until the rendered UTF-8 byte length falls at or below `N`. When even maximal elision cannot meet the bound, the command fails with the new public error code `CONTEXT_OVER_BUDGET`.

**`N` validation.** `N` must be a positive integer (parsed with `Number.parseInt(value, 10)`). Zero, negative numbers, and non-numeric values are rejected with `CONFIG_ERROR` at flag parse time. The smallest meaningful budget is the size of the minimum-pack composition for the task (header + phase_contract + task_definition + verification_commands + progress_event_schema + format_overhead newlines).

**Elision priority (locked).** Sections drop in this order until the budget is met:

| Order | Section             | Eligible when                                                                                   |
| ----- | ------------------- | ----------------------------------------------------------------------------------------------- |
| 1     | `completed_tasks`   | always (the section is itself gated behind `ambiguity: high`)                                   |
| 2     | `related_decisions` | only when `context_size: large` (the "all decisions" path; `decision_refs` stay)                |
| 3     | `constitution`      | always (project-wide; not task-specific)                                                        |
| 4     | `rules`             | only when `write_surface: high` (the "all rules" path; default applies-to-matched subset stays) |
| 5     | `reads`             | always (declared globs; declaration-only, no inlined bodies)                                    |

Sections NOT in this list are **unelidable**: `header`, `phase_contract`, `task_definition`, `depends_on`, `writes`, `declared_decisions`, `acceptance_refs`, `verification_commands`, `progress_event_schema`, `format_overhead`. These are either always-included or carry task-declared intent the user explicitly opted into.

The locked source of truth is `ELISION_ORDER` in [`src/core/pack/formatters/markdown.ts`](../src/core/pack/formatters/markdown.ts). Changing the order requires an RFC amendment.

**`--explain --json` interaction.** When `--budget-bytes` triggers elision AND `--explain --json` is set, every elided section appears in `excluded[]` with `reason_code: budget_reserved_for_later` and a `details` block:

```json
{
  "excluded": [
    {
      "name": "rules",
      "reason_code": "budget_reserved_for_later",
      "details": {
        "elided_for_budget_bytes": 2000,
        "section_bytes": 4183
      }
    }
  ]
}
```

Sections excluded by the v1.11 inclusion policy (e.g. `not_declared_by_task` for P10 fields the task did not declare) keep their v1.11 reason codes; budget elision applies only to sections that would otherwise have been included.

**`CONTEXT_OVER_BUDGET` envelope.** When maximal elision still exceeds the budget:

```json
{
  "ok": false,
  "error": {
    "code": "CONTEXT_OVER_BUDGET",
    "message": "Context pack cannot be reduced below 1196 bytes; --budget-bytes 100 is unachievable for this task."
  },
  "data": {
    "budget_bytes": 100,
    "minimum_achievable_bytes": 1196,
    "unelidable_sections": [
      "header",
      "phase_contract",
      "task_definition",
      "verification_commands",
      "progress_event_schema"
    ]
  }
}
```

Exit code 2. `data.minimum_achievable_bytes` tells the caller the floor for this task; re-running with `--budget-bytes <minimum_achievable_bytes>` succeeds and produces a pack of exactly that size.

**Byte-identical default.** Without `--budget-bytes`, the rendered `content` is byte-for-byte identical to v1.12 (the existing [`tests/integration/pack-byte-identical.test.ts`](../tests/integration/pack-byte-identical.test.ts) lock test continues to apply). The flag only opts in to elision.

### `--context-budget <profile>` (v1.30+, P47)

`code-pact task context <task-id> [--agent <name>] [--json] [--explain] --context-budget <profile>` and the same flag on `task prepare` are an **ergonomic alias** for a byte budget: the named profile resolves to a `max_bytes` value, which then drives the **unchanged** `--budget-bytes` enforcement path above (same locked elision order, same `CONTEXT_OVER_BUDGET` on an unachievable budget). It is a name for a number — it introduces no new pack behavior, no tokenizer, no summarization, and no network call.

**Built-in profiles.** Three standard names ship with built-in byte fallbacks:

| Profile    | Built-in `max_bytes` |
| ---------- | -------------------- |
| `tight`    | `30000`              |
| `balanced` | `60000`              |
| `wide`     | `120000`             |

`wide` is **not** `full`: it is a generous byte-capped profile, not a promise that every pack fits without elision — a large task can still elide or hit `CONTEXT_OVER_BUDGET` at `wide`.

**Agent-defined profiles.** An agent profile may declare an optional `context_budget` block that **overrides** a standard byte value or names additional custom profiles:

```yaml
context_budget:
  default_profile: balanced # optional; validated, but NOT auto-applied in P47
  profiles:
    tight: { max_bytes: 30000 }
    balanced: { max_bytes: 60000 }
    wide: { max_bytes: 120000 }
    review: { max_bytes: 45000 } # a custom profile
```

`max_bytes` is a positive integer. A missing `context_budget` block is valid (backward compatible). `default_profile`, when present, must reference a declared profile — but it is **not** applied automatically to any command in P47; an invocation with no flag stays byte-identical to the no-flag default above. A malformed, explicitly-configured `context_budget` surfaces as `CONFIG_ERROR` when a `--context-budget` invocation needs to parse it.

**Resolution.** A standard name (`tight` / `balanced` / `wide`) resolves to its built-in byte value even with **no** agent profile in play, so the ergonomic name is usable without forcing `--agent`. An agent profile only _overrides_ the byte value, or supplies a custom name. An unknown profile name fails with `CONFIG_ERROR` (exit 2), naming the missing profile and the agent.

**Mutual exclusion.** `--context-budget` and `--budget-bytes` are mutually exclusive; supplying both is `CONFIG_ERROR` (exit 2):

```json
{
  "ok": false,
  "error": {
    "code": "CONFIG_ERROR",
    "message": "task context: --budget-bytes and --context-budget are mutually exclusive."
  }
}
```

**`commands` dictionary.** Like `--budget-bytes`, `--context-budget` is per-invocation policy, not project state: the `task prepare` `commands` dictionary does **not** echo it.

## `task prepare` — single per-task entry point (v1.11+, P21)

`code-pact task prepare <task-id> [--agent <name>] [--json] [--dry-run]` is a **progress-read-only** compound command that returns everything an agent needs to decide what to do next on a single task: current state, the recommendation envelope, context-pack metadata, a structured `next_action`, and a fully-formed `commands` dictionary for the per-task lifecycle.

The command MUST NOT record a progress event (the ledger is left unchanged) on any code path. It MAY write the deterministic context pack at `<agent-profile>.context_dir/<task-id>.md` unless `--dry-run` is passed.

### Flags

The flag list, value types, and examples live in the generated [CLI reference § `task prepare`](cli-reference.generated.md). Contract notes on specific flags: `--agent` shares `task context`'s validation (`AGENT_NOT_FOUND` / `AGENT_NOT_ENABLED`); `--dry-run` returns `would_write_context_pack_path` instead of `context_pack_path`; `--budget-bytes <N>` (v1.13+, P24) elides sections in the priority order defined in [`task context --budget-bytes`](#--budget-bytes-n-v113-p24) and throws `CONTEXT_OVER_BUDGET` (exit 2) when unachievable, with no progress event recorded on the failure path (the progress-read-only invariant from P21-T3); `--context-budget <profile>` (v1.30+, P47) is the ergonomic alias for `--budget-bytes`, resolving a named profile to bytes before that same path (see [`task context --context-budget`](#--context-budget-profile-v130-p47)), mutually exclusive with `--budget-bytes`, and **not** echoed into the returned `commands` dictionary.

### JSON envelope

```json
{
  "ok": true,
  "data": {
    "task_id": "P21-T4",
    "phase_id": "P21",
    "agent": "claude-code",
    "current_state": "planned",
    "recommendation": {
      /* full v2 RecommendResult, or null */
    },
    "context_pack_path": ".../<task-id>.md",
    "context_pack_bytes": 18422,
    "would_write_context_pack_path": ".../<task-id>.md",
    "dry_run": false,
    "next_action": { "type": "start_task", "message": "..." },
    "commands": {
      "context": "code-pact task context  <task-id> --agent <agent>",
      "start": "code-pact task start    <task-id> --agent <agent>",
      "verify": "code-pact verify --phase <phase> --task <task-id>",
      "complete": "code-pact task complete <task-id> --agent <agent>",
      "finalize": "code-pact task finalize <task-id> --write --json",
      "record-done": "code-pact task record-done <task-id> --agent <agent> --evidence \"<verification you ran>\""
    },
    "blocked_by": [],
    "already_done": true,
    "decision_commitments": [
      {
        "adr": "design/decisions/<file>.md",
        "has_section": true,
        "items": [
          { "text": "Migrate call sites of foo()", "done": false },
          { "text": "Update docs/cli-contract.md", "done": true }
        ]
      }
    ]
  }
}
```

- `would_write_context_pack_path` is present only in `--dry-run` mode when a pack would have been written.
- `already_done` is present (always `true`) only when `current_state === "done"`.
- `commands` (v1.27+, P40) is a complete, **mode-agnostic lookup table** — all keys are present in every `lifecycleMode`. The key is **exactly `record-done`** (hyphen; read it as `commands["record-done"]`, not `record_done`). It is the one entry **not runnable verbatim**: `--evidence` is agent-supplied, so it is emitted as a template with the `"<verification you ran>"` token. `next_action.message` (not `commands`) is the lifecycle-aware "what next" surface — for a `record_only` task it points at `task record-done` (a lighter loop, not lighter verification); for a `decision_loop` task it says to resolve the gating ADR first (it does **not** decide complete-vs-record-done); for `full_loop` it is the standard start→implement→verify→complete wording. Only the workable states (`start_task` / `continue_implementation`) vary by mode.
- `decision_commitments` (v1.27+, P43) is present (possibly `[]`) **only for a `requires_decision` task**; it is omitted entirely for non-gated tasks. Each entry is one **accepted** ADR among those the decision gate _considered_, with its parsed `## Implementation commitments` checkbox items (`{ text, done }`) and a `has_section` flag. `has_section: false` means the ADR has no `## Implementation commitments` section; `has_section: true` with `items: []` means the section is present but has no checkbox items. It is **empty (`[]`)** when the resolver found **no accepted ADR entries**. Note: this surfaces _every accepted considered ADR_ even if the gate as a whole is unresolved — e.g. with explicit `decision_refs` (all-must-be-accepted), if one ref is accepted and another is proposed, the gate is unresolved but the accepted ref's commitments still surface here, because `task prepare` is advisory implementation context, **not** a gate (it never fails, adds no decision-error surface, and does not duplicate `verify` / `task complete` enforcement). This differs deliberately from the `ADR_COMMITMENTS_EMPTY` lint advisory, which fires only when the gate actually **resolves**. Entries preserve the decision resolver's `considered[]` order — consumers must **not** infer chronological, priority, or dependency semantics from the order. `done` semantics: an unchecked item is downstream work still to implement; a checked item is work already satisfied, or an explicit non-work statement. This is an additive `data` field (the JSON output shape already documents that envelopes carry additive fields).

### `next_action.type` enum (closed)

| `type`                    | Reached when                                                      | `recommendation` | `context_pack_*`                          |
| ------------------------- | ----------------------------------------------------------------- | ---------------- | ----------------------------------------- |
| `start_task`              | `current_state === "planned"` and no unmet `depends_on`           | populated        | populated (or `would_write_*` in dry-run) |
| `continue_implementation` | `current_state ∈ {"started", "resumed"}`                          | populated        | populated                                 |
| `wait_for_dependencies`   | `current_state === "blocked"` OR any `depends_on` is not `"done"` | `null`           | `null`, bytes `0`                         |
| `noop_already_done`       | `current_state === "done"`                                        | `null`           | `null`, bytes `0`                         |
| `investigate_failure`     | `current_state === "failed"`                                      | populated        | populated                                 |

The `commands` dictionary is populated in every state — including the early-return states — so the agent can choose to invoke them directly after resolving the blocker.

`recommendation` is `null` **only** in the early-return states (`wait_for_dependencies`, `noop_already_done`) — i.e. `done`, `blocked`, or an unmet `depends_on`. In every workable state (`planned`, `started`, `resumed`, `failed`) it is a populated `RecommendResult` whose `tier` / `effort` / `modelId` an agent can trust without a separate `recommend` call. A `null` here means "nothing to recommend yet", never "recommendation unavailable".

### Exit codes

| Code | Condition                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Envelope returned (including early-return states).                                                                              |
| 2    | `CONFIG_ERROR` (bad flag), `TASK_NOT_FOUND`, `AMBIGUOUS_TASK_ID`, `AMBIGUOUS_PHASE_ID`, `AGENT_NOT_FOUND`, `AGENT_NOT_ENABLED`. |

No new error codes are introduced by `task prepare`; all failure modes reuse existing codes documented above.

## `doctor` — plan quality checks (v0.5.3)

In addition to structural checks (orphan files, schema errors, duplicate IDs), `doctor` now
reports plan quality issues:

| Code                                            | Severity | Condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRIEF_MISSING`                                 | warning  | `design/brief.md` does not exist (only once a real non-`TUTORIAL` phase exists; `brief.md` is optional and not scaffolded by `init`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CONSTITUTION_PLACEHOLDER`                      | warning  | `design/constitution.md` still contains the initial template edit hint (only once a real non-`TUTORIAL` phase exists)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `EMPTY_OBJECTIVE`                               | error    | A phase `objective` is blank or fewer than 10 characters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ADAPTER_STALE`                                 | warning  | An enabled agent profile has no `model_version` set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `CONTROL_PLANE_NOT_DRIVEN` (v1.25+)             | warning  | Scaffold adopted but not driven — a non-TUTORIAL task is planned, the progress ledger has no non-TUTORIAL `started`/`done` event, and git shows uncommitted changes. git-unavailable (or a broken ledger) → silent skip. Advisory only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `CONTROL_PLANE_BRANCH_NOT_DRIVEN` (v1.26+, P34) | warning  | **Branch-diff drift for PR CI.** Runs **only** when `--base-ref <ref>` is supplied. Fires when the branch diff (`merge-base..HEAD`) touched real, non-excluded files but the branch added **no** event that is `started`/`done` AND non-TUTORIAL AND a `task_id` present in the loaded plan — i.e. code changed without driving the loop. A `started` **or** `done` for a known task suppresses it (usage detection, not completion). Silent skip when: no `--base-ref`; git/merge-base unavailable; none of legacy `progress.yaml` / `state/events/**` / `state/archive/event-packs/**` is git-tracked (the committed ledger is what CI audits; after compaction the history can live entirely in packs); or the committed HEAD ledger is unparseable/corrupt (`INVALID_YAML`/`SCHEMA_ERROR`/`EVENT_FILE_ID_MISMATCH`/`EVENT_PACK_INVALID` owns that). Advisory — never affects exit on its own; gate via `validate --strict --base-ref`. Exempt paths via `control_plane_branch_not_driven.exclude_globs`; silence via `disabled_checks`                                                                                                                                                                                |
| `CONTROL_PLANE_GITIGNORED` (v1.32+)             | warning  | **Part of the shared control plane is git-ignored.** A `.gitignore` rule matches one or more shared areas — `project.yaml`, `agent-profiles/`, `model-profiles/`, `state/baselines/`, `state/events/`, `state/archive/event-packs/` (the `message` names which) — so that state never reaches git and stays local (a teammate or clean checkout misses whatever is ignored). **Only when the whole ledger (`state/events/` AND `state/archive/event-packs/`) is ignored** does `CONTROL_PLANE_BRANCH_NOT_DRIVEN` _also_ silently skip (no tracked ledger to read). Usual cause: a blanket `/.code-pact/` ignore (or a file-scoped `state/events/*.yaml`) that overrides the narrow entries `init` writes (`init` never deletes a user's existing lines). Authoritative via `git check-ignore --no-index` over a representative **file** in each area (rule-only, so a force-added file does not mask it; negation re-includes are honoured). Silent skip when git is unavailable / not a repo or `.code-pact/project.yaml` is absent. Advisory — `doctor` / default `validate` do not fail on it; `validate --strict` promotes it (like other doctor warnings). Silence via `disabled_checks: [CONTROL_PLANE_GITIGNORED]` |

Individual checks can be suppressed per project without touching source code by creating
`.code-pact/doctor.yaml`:

```yaml
disabled_checks:
  - BRIEF_MISSING
  - ADAPTER_STALE

# P34: paths whose change does NOT require driving the loop. Default empty —
# there is no built-in docs/config exemption (a repo decides). exclude_globs is
# a team-declared escape hatch for CONTROL_PLANE_BRANCH_NOT_DRIVEN only.
control_plane_branch_not_driven:
  exclude_globs:
    - "docs/**"
    - "**/*.md"
    - ".github/**"
```

This file is optional. When absent, all checks are active.

### `--base-ref` and CI branch-drift gating (v1.26+, P34)

`doctor` and `validate` accept `--base-ref <ref>`. It enables only the
`CONTROL_PLANE_BRANCH_NOT_DRIVEN` check (everything else is unchanged), comparing
the PR branch against `merge-base(HEAD, <ref>)`. Unlike the working-tree
`CONTROL_PLANE_NOT_DRIVEN`, this fires in PR CI (where the checkout is clean).

The check is **advisory** by default. To make it a CI gate, pair `--base-ref`
with `validate --strict` (strict already promotes warnings to exit 1):

In CI, supply `--base-ref origin/${{ github.base_ref }}` (or your provider's
base-ref variable) on a `pull_request` run, with `fetch-depth: 0` so the
merge-base is reachable. Pair it with `--strict` to make the branch-drift
advisory a gate.

> For the copy-paste GitHub Actions workflow — the full recommended gate
> (`validate --strict --base-ref` + `plan lint --include-quality --strict` +
> `plan analyze --strict`), the contributor-vs-maintainer loop split, and the preconditions
> checklist — see [Running code-pact in CI](workflows/ci.md). This section
> documents the `--base-ref` contract and the diagnostic behavior; the runnable
> workflow template lives there.

**Precondition — the ledger _and_ the project config must be in the CI checkout.**
`init` ignores only the machine-local / derived subset of `.code-pact/` —
`/.code-pact/locks/` (advisory locks), `/.code-pact/cache/` (reserved, derived),
plus `/.local/` (private planning notes) and `/.context/` (regenerable context
packs). So by default the **rest** of `.code-pact/` (the project config **and**
the progress ledger — per-event files under `state/events/`, plus the legacy
`state/progress.yaml` if present) is committable, and in the normal case you
commit it (see
[§ State file write guarantees → _Committed vs ignored_](#state-file-write-guarantees)).
Two things must hold for the gate:

- **The ledger is tracked.** The gate reads the _committed_ ledger
  (`state/events/**` merged with any legacy `state/progress.yaml`); if neither
  is git-tracked the check **silently skips** (it never cries wolf at a repo that
  does not commit the ledger). If your repo deliberately gitignores
  `.code-pact/` (or `.code-pact/state/`), force-add just the ledger so CI can
  see it: `git add -f .code-pact/state/`.
- **The project config is available.** `validate` itself reads
  `.code-pact/project.yaml`, `agent-profiles/`, `model-profiles/` (and
  `doctor.yaml` if you use `exclude_globs`). These must be present in the CI
  checkout — committed in the normal case, or force-added if you ignore
  `.code-pact/`. Force-adding only the ledger is not enough when the rest
  of the config is ignored.

## `task add` — append a task to a phase (v0.6, non-interactive in v1.4+)

`code-pact task add <phase-id> [flags]` appends a task to the named phase's `tasks[]` array. Two paths share the same write contract:

- **Wizard path (v0.6+, unchanged)** — TTY-only. The wizard prompts for `description` and `type`; all readiness fields default to `"medium"` and `status` defaults to `"planned"`. Output goes to stderr (or stdout JSON when `--json` is passed).
- **Non-interactive path (v1.4+, Stable)** — flag-driven. Triggered by the presence of `--description`. Bypasses the wizard prompter entirely (no stdin handle is opened), making it safe for CI / scripted bootstrap. JSON envelope is **byte-identical** to the wizard path.

### Mode resolution

The presence of `--description` is the mode switch. Three branches:

| Input                                                                                                  | Behaviour                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--description` provided                                                                               | Non-interactive path. `--type` is required (else CONFIG_ERROR).                                                                                           |
| `--description` absent, no other non-interactive flags, TTY available                                  | Wizard path (unchanged from v0.6).                                                                                                                        |
| `--description` absent, no other non-interactive flags, no TTY                                         | CONFIG_ERROR with non-interactive guidance.                                                                                                               |
| `--description` absent, one or more non-interactive-only flags present (e.g. `--type`, `--depends-on`) | **CONFIG_ERROR**. The CLI never silently enters the wizard or silently ignores the flags — predictable for scripts that lose TTY capability mid-pipeline. |

### Non-interactive flags (v1.4+)

The flag list, value types, repeatability, and examples live in the generated [CLI reference § `task add`](cli-reference.generated.md). Contract notes that the reference does not carry: `--description` is the **mode trigger** (its presence selects the non-interactive path) and `--type` is then required; all readiness fields (`--ambiguity` / `--risk` / `--context-size` / `--write-surface` / `--verification-strength` / `--expected-duration`) default to `medium`; the P10 fields (`--depends-on` / `--decision-ref` / `--read` / `--write` / `--acceptance-ref`) are repeatable — pass multiple flags, not a comma-separated list; enum values are validated (invalid → `CONFIG_ERROR`).

**`--status` is intentionally not exposed.** Newly added tasks are always written with `status: planned`. Historical or already-done tasks must use `phase import` — this preserves the P11/P12 contract that design `done` is the result of `task finalize` / `phase reconcile` after `task complete`, never a starting point declared at creation time.

### P10 field validation responsibility

`task add` stores P10 field flags after **basic string validation only**. Existence checks (file presence on disk), glob validity (P10 supported subset), unsafe-path detection (`assertSafeRelativePath`), and protected-path advisories remain `plan lint`'s responsibility. The dogfood loop (`task add` → `plan lint --json`) provides immediate feedback when a declared field is invalid.

### JSON envelope

Same shape in both modes:

```json
{
  "ok": true,
  "data": {
    "phaseId": "P1",
    "taskId": "P1-T5",
    "phasePath": "design/phases/P1-foundation.yaml"
  }
}
```

### Errors

Reuses existing public codes; phase-id resolution additionally surfaces
`AMBIGUOUS_PHASE_ID`:

| Code                 | Exit | When                                                                                                                                                                                           |
| -------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PHASE_NOT_FOUND`    | 2    | Phase id is not in `design/roadmap.yaml`                                                                                                                                                       |
| `AMBIGUOUS_PHASE_ID` | 2    | The `<phase-id>` appears in more than one `roadmap.yaml` entry; `data.phases[]` lists the colliding files                                                                                      |
| `DUPLICATE_TASK_ID`  | 1    | Task id already exists in the phase (pre-v1.4 exit code preserved)                                                                                                                             |
| `CONFIG_ERROR`       | 2    | Missing positional `<phase-id>`; `--description` absent with no TTY; `--description` provided without `--type`; non-interactive flag without `--description`; invalid enum value; unknown flag |

### Usage examples

See the generated [CLI reference § `task add`](cli-reference.generated.md).

## `verify`

`code-pact verify --phase <phase-id> --task <task-id> [--timeout <ms>] [--dry-run] [--json]` runs deterministic completion checks without recording progress.

`--timeout` is a **per-command** limit in milliseconds. It defaults to `300000` (five minutes) and accepts only decimal integer strings from `1` through `2147483647`. Invalid, fractional, exponential, hexadecimal, whitespace-padded, non-finite, zero, negative, or larger values are `CONFIG_ERROR` (exit 2). `--dry-run` previews shell commands instead of executing them.

Each executed command is preserved under the `commands` check as an ordered `commands[]` entry with stable fields: `command`, `ok`, `exitCode`, `timedOut`, `aborted`, `elapsedMs`, `stdout`, `stderr`, and, when termination was attempted, `termination`. Output remains bounded; truncation is marked in the captured stream. A timeout is reported as `VERIFICATION_FAILED` with a timed-out command result. Cancellation is reported as `VERIFICATION_FAILED` with `error.cause_code: "ABORTED"`.

The first observed `SIGINT` or `SIGTERM` requests clean cancellation. Code Pact terminates the active shell process tree and stops later checks. Programmatic signal delivery is platform-dependent; Windows CI verifies timeout/AbortSignal cancellation and `taskkill` cleanup rather than synthetic `SIGINT` delivery. If the platform cannot confirm complete descendant termination, the command result records `termination.completed: false` and a diagnostic rather than claiming success. Standalone `verify` never writes a progress event.

## `task complete`

`code-pact task complete <task-id> [--agent <name>] [--timeout <ms>] [--json] [--dry-run]` is the deterministic completion entry point for agents.

Order of operations:

1. **Agent validation**. The same checks as `task context`: unknown agent → `AGENT_NOT_FOUND`, disabled agent → `AGENT_NOT_ENABLED`. When `--agent` is omitted, `project.yaml.default_agent` is used.
2. **Task resolution**. The same logic as `task context`: scans every phase referenced by `design/roadmap.yaml`. `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` are raised for missing / duplicate task ids.
3. **State check**. Derived from the append-only progress ledger (per-event files under `state/events/` merged with the legacy `progress.yaml`) via `deriveTaskState`. If the current state is `done`, returns `{ ok: true, data: { already_done: true } }` with exit 0 and **does not re-run verification** (to force re-verification, use `task complete --rerun` — planned for a later release). If the current state is `blocked`, exits 2 with `INVALID_TASK_TRANSITION`: the task must be resumed via `task resume <id>` before it can complete, so the resume event records the unblock decision. Other current states (`planned`, `started`, `resumed`, `failed`) proceed to verification. `planned → done` is permitted at the command layer for v0.5 backwards compatibility, even though the state machine itself does not list that transition.
4. **Verification (preflight mode)**. Runs the deterministic checks from `code-pact verify` — `commands` and `decision` — but skips the state-consistency checks (`progress_event`, `task_status`) because `task complete` is the action that produces that state. `--timeout <ms>` uses the same per-command contract as standalone `verify` (default `300000`; decimal integer string range `1..2147483647`). On failure, timeout, or cancellation, exits 1 with `VERIFICATION_FAILED`; no progress event is recorded (the ledger is unchanged). Standalone `code-pact verify` still runs all four checks for after-the-fact consistency auditing.
5. **Progress record**. On verify pass, records a `done` event with shape `{ task_id, status: "done", at, actor: "agent", agent, evidence, source: "loop", author? }` as **one new file** under `.code-pact/state/events/` (the progress ledger). `author` (Collaboration UX RFC, D1) is the human identity captured at write time (see [§ Author attribution](#author-attribution-collaboration-ux-rfc-d1)); omitted when capture is off or no identity resolves. The write is lock-free by construction: each event is published as a separate no-overwrite file (write a temp file, then `link` it onto the final path, whose name is the event's content id), so two concurrent `task complete` runs produce two distinct files and neither is lost. The legacy `.code-pact/state/progress.yaml` is **not** written. Re-recording the canonically identical event is idempotent (the file already exists).
6. **`--dry-run`**. Skips the progress record. Returns `{ ok: true, data: { dry_run: true, would_append: <event> } }`. No event file is written. **`--dry-run` must not cause side effects**: it does **not** execute the project-controlled `verification.commands` (which run with `shell: true`). The `commands` check is previewed (reported as would-execute, treated as passing) rather than run, so a command that would fail does **not** fail the dry run. The read-only `decision` gate still runs, so an unresolved-decision dry-run still exits 1 with `VERIFICATION_FAILED` (`cause_code: DECISION_REQUIRED`). A non-dry-run completion executes the commands and a failing command exits 1 with `VERIFICATION_FAILED` (`cause_code: COMMANDS_FAILED`).

**Cancellation and commit point.** The first observed `SIGINT` or `SIGTERM` is converted to an `AbortSignal`. Cancellation is checked across verification and again before author resolution, event construction, and the event write. Before `writeEventFile` starts, cancellation produces `VERIFICATION_FAILED` with `error.cause_code: "ABORTED"` and writes no progress event. The atomic `writeEventFile` call is the commit point: once that call starts, it is allowed to finish so cancellation cannot leave a partial event file. A second signal uses Node's default hard-termination behaviour.

**Failure envelope (v1.26+, P32 — additive).** On `VERIFICATION_FAILED`, the `data` object carries three additive fields alongside the unchanged `data.verify.checks`:

- `failed_checks: string[]` — the names of every failing check, in verify's order.
- `first_failure: { name, reason } | null` — the first failing check and its human-readable reason (`null` only when nothing failed).
- `suggested_next_command: string | null` — a deterministic, AI-free command derived from the first failing check.

`suggested_next_command` is a **rerun command to execute _after fixing_ the reported `first_failure`**. It does **not** imply that rerunning without changes will resolve the failure. Human output (non-`--json`) leads with the actionable cause message (see the P39 note below — no longer the generic `Verification failed for …` string) and prints the `cause:` and `rerun after fixing:` lines to stderr below it. `data.verify.checks` is unchanged, so any consumer that ignores unknown fields is unaffected.

**Root cause on the error face (v1.27+, P39 — additive).** `task complete` also sets `error.cause_code` so an agent reading only `error` knows what failed without dropping into `data`, and `error.message` becomes actionable. The actionable message is keyed off the **first failing check's name** and embeds that check's `first_failure.reason`, so an agent reading only `error` learns the concrete root cause:

- `DECISION_REQUIRED` — the decision gate is unresolved (a `requires_decision` task with no accepted ADR). `error.message` names that an accepted ADR is required and embeds the gate's reason (e.g. `… requires an accepted ADR before completion: No accepted ADR found for "P1-T1". …`).
- `COMMANDS_FAILED` — a verification command failed or timed out. `error.message` embeds the failing command's reason (e.g. `… a verification command failed: "pnpm test" exited with code 1.`).
- `ABORTED` — verification or the pre-commit completion flow was cancelled. No progress event is recorded before the event-write commit point.

`error.code` stays `VERIFICATION_FAILED` (exit 1) for backward compatibility; `cause_code` is additive. The P32 `data` fields are **not** duplicated into `error`, and no structured decision block is added. `task complete` runs only the `commands` + `decision` checks, and cancellation may interrupt that flow, so its documented `cause_code` values are `COMMANDS_FAILED`, `DECISION_REQUIRED`, and `ABORTED`. The decision gate runs in `verify` / `task complete` / `task record-done`; `task finalize` does **not** run it, so finalize has no decision `cause_code`. Note the deliberate asymmetry with `task record-done`, whose _top-level_ `error.code` is `DECISION_REQUIRED` at exit 2.

The `agent` field on `ProgressEvent` is optional for backward compatibility with v0.1 logs that predate `task complete`. The `source` field (v1.21+) is `"loop"` for events produced by `task complete` and `"external"` for events produced by `task record-done`; it is optional, and a legacy `done` event with no `source` is treated as `"loop"` by readers.

## `task record-done` — record completion without `task complete` (v1.21+)

`code-pact task record-done <task-id> --evidence "<text>" [--notes "<text>"] [--agent <name>] [--json] [--dry-run]` records a `done` event **without** running the loop's verification commands — the proof is the `--evidence` you supply, and it records `source: "external"`. Two uses:

- **External completion** — already-merged work, or changes that cannot be verified from the current working tree.
- **The `record_only` lane (v1.26+)** — a small, low-risk, strongly-verified docs/test task where `task prepare` recommends `lifecycleMode: record_only`; you run the project's verification yourself, then record the result here. See [`per-task-loop.md` § Recording a done without task complete](per-task-loop.md#recording-a-done-without-task-complete) for the lifecycle explanation (it is a lighter _loop_, not lighter verification).

It is a distinct path from the loop's `task complete`, not a way to skip verification:

- Use `task complete` for work verified inside the loop (it runs verification commands and records `source: "loop"`).
- Use `task record-done` when verification happened outside `task complete` — externally, or because you ran it yourself for a `record_only` task (it does **not** run verification commands; the proof is the `--evidence` you supply, and it records `source: "external"`).
- `source: "external"` is recorded intentionally so future diagnostics can distinguish loop-verified completion from completion asserted via evidence.

Order of operations:

1. **Evidence validation**. `--evidence` is required and must be non-empty / non-whitespace. An empty or whitespace-only value raises `CONFIG_ERROR` (exit 2) **before** any project / roadmap / progress file is read, so an invalid invocation never depends on environment state.
2. **Agent validation**. Same as `task complete`: unknown agent → `AGENT_NOT_FOUND`, disabled agent → `AGENT_NOT_ENABLED`. `--agent` defaults to `project.yaml.default_agent`.
3. **Task resolution**. Same as `task complete`: `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` for missing / duplicate ids.
4. **State check**. Derived via `deriveTaskState`. `done` → idempotent `{ ok: true, data: { already_done: true } }` (exit 0, no duplicate event). `blocked` → exit 2 `INVALID_TASK_TRANSITION` (resume first). Other states (`planned`, `started`, `resumed`, `failed`) proceed.
5. **Decision gate** (status-aware since v1.22, RFC §3-C). The **same** shared resolver as `verify` / `task complete` / `plan lint`. For a `requires_decision` task (on the task or its phase), the gate parses each candidate ADR's status — from YAML frontmatter `status:` (preferred) or the `**Status:** <word>` markdown bold line — and resolves only when an `accepted` ADR is found. `proposed` / `draft` / `rejected` / `superseded` / empty files / explicit unknown status (typos) all fail to resolve. A non-empty ADR with **no** status line resolves as accepted (backward-compat for projects that pre-date status-aware parsing — the **only** lenient case). Resolution semantics: explicit `task.decision_refs` use **all-must-be-accepted** (a single bad ref fails the gate); the filename scan over `design/decisions/` uses **any-accepted-wins** to preserve the substring-collision compat (`P1-T1` matches `P1-T10-*.md`). On failure: exits 2 with `DECISION_REQUIRED` and no progress event is recorded. **No verification commands are run.**
6. **Progress record**. Records `{ task_id, status: "done", at, actor: "agent", agent, evidence: [<--evidence>], notes?, source: "external", author? }` as one new event file under `.code-pact/state/events/`, via the same lock-free per-event write as `task complete`. `author` is captured as in `task complete` (Collaboration UX RFC, D1).
7. **`--dry-run`**. Skips the record; returns `{ ok: true, data: { dry_run: true, would_append: <event> } }`. No event file is written.

`task finalize` works after `task record-done` exactly as it does after `task complete` — finalize never inspects `source`.

## `task finalize` — flip task design status to done (v1.2+, P11)

`code-pact task finalize <task-id> [--write] [--base-ref <ref>] [--audit-strict] [--json]` flips the `status` field of a single task inside `design/phases/<phase>.yaml` from `planned` / `in_progress` to `done`. Stability: **Stable (v1.2+)**. `--base-ref` and `--audit-strict` are **Stable (v1.6+)** under P15-T1 and P15-T6 respectively.

Eligibility: the task's derived state from the progress ledger (via `deriveTaskState`) **must equal `done`**. Any other current state (no events, `started`, `blocked`, `resumed`, `failed`) raises `TASK_FINALIZE_NOT_ELIGIBLE` (`ok: false`, exit 2) in **both** dry-run and `--write` modes. Dry-run means "won't write", not "won't validate" — the dry-run output of a finalize-able task is a faithful preview of what `--write` would do.

Default mode is dry-run. Pass `--write` to apply the mutation. No `--agent` flag — this is a design/progress reconciliation command that never calls an adapter.

Order of operations:

1. **Task resolution.** Scans every phase referenced by `design/roadmap.yaml`. `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` are raised for missing / duplicate task ids (same logic as `task complete`).
2. **Eligibility check.** Reads the progress ledger, derives the task state, raises `TASK_FINALIZE_NOT_ELIGIBLE` if not `done`.
3. **Safe-write classification.** Validates the resolved phase file via `src/core/path-safety.ts` (`assertSafeRelativePath` + `resolveWithinProject`), reads it, parses it as Phase, confirms the task is present. Any failure raises `TASK_FINALIZE_WRITE_REFUSED` (exit 2) with a structured reason in `data.reason` (`unsafe_path` / `outside_design_phases` / `not_yaml` / `symlink_escape` / `unreadable` / `unparseable_phase` / `task_not_found`).
4. **Idempotency check.** If the phase YAML already has `status: done` for this task, returns `kind: "already_finalized"` (exit 0) with no write attempt.
5. **Dry-run or `--write`.** In dry-run, returns `kind: "would_finalize"` with `planned_writes[]`. In `--write`, calls `atomicWriteText` to apply the change and returns `kind: "finalized"` with `applied_writes[]`.

`task finalize` **never** writes to the progress ledger, **never** writes to `design/roadmap.yaml`, and **never** flips the phase's own `status` field. The v1.0 append-only progress contract and the v1.2 narrow-write-target contract are both preserved.

### JSON envelope (success)

```json
{
  "ok": true,
  "data": {
    "kind": "would_finalize" | "finalized" | "already_finalized",
    "task_id": "P1-T1",
    "phase_id": "P1",
    "file": "design/phases/P1-foundation.yaml",
    "current_status": "planned",
    "target_status": "done",
    "planned_writes": [{ "file": "...", "task_id": "...", "before": "planned", "after": "done" }],
    "applied_writes": [],
    "skipped_writes": [],
    "acceptance_refs_check": [{ "path": "docs/cli-contract.md", "exists": true }],
    "declared_writes": ["src/commands/task-finalize.ts"],
    "depends_on_check": [{ "task_id": "P1-T0", "current": "done", "satisfied": true }],
    "write_audit": {
      "git_available": true,
      "base_kind": "working-tree",
      "base_ref": null,
      "files_touched": ["src/commands/task-finalize.ts"],
      "outside_declared": [],
      "declared_unused": [],
      "warnings": []
    }
  }
}
```

Field presence by kind:

| Field                                                                | `would_finalize`  | `finalized`       | `already_finalized` |
| -------------------------------------------------------------------- | ----------------- | ----------------- | ------------------- |
| `task_id`, `phase_id`, `file`                                        | ✓                 | ✓                 | ✓                   |
| `current_status` (pre-write), `target_status`                        | ✓                 | ✓                 | ✓                   |
| `planned_writes[]`                                                   | ✓                 | absent            | absent              |
| `applied_writes[]`, `skipped_writes[]`                               | absent            | ✓                 | absent              |
| `acceptance_refs_check[]`, `declared_writes[]`, `depends_on_check[]` | ✓                 | ✓                 | ✓                   |
| `write_audit` (v1.6+, P15-T1)                                        | ✓ (when `--json`) | ✓ (when `--json`) | ✓ (when `--json`)   |

`skipped_writes[]` is always empty for `task finalize` (it operates on a single task). The field exists for shape parity with `phase reconcile` (P11-T4).

### `write_audit` field (v1.6+, P15-T1)

Read-only advisory comparing the task's declared `writes` globs against the actual filesystem changes reported by git. Present on **all three success kinds** when `--json` is in effect. Human-mode `task finalize` (no `--json`) does **not** compute the audit and does **not** spawn git — the field is JSON-only.

Default range is the **working tree** only: staged (`git diff --cached --name-only`) + unstaged (`git diff --name-only`) + untracked (`git ls-files --others --exclude-standard`), all merged, POSIX-normalized, and sorted. Pass `--base-ref <ref>` to additionally include the branch-level diff (`git diff --name-only $(git merge-base HEAD <ref>) HEAD`). `--base-ref` **requires** `--json`; passing it without `--json` returns `CONFIG_ERROR` (exit 2).

**code-pact runtime state is excluded (v1.21+).** `files_touched` drops the progress ledger (`.code-pact/state/progress.yaml` and everything under `.code-pact/state/events/`) and anything under `.code-pact/locks/` — these are code-pact's own operational log and advisory lock, written by the tool during the very commands an agent runs, never a task's work product. Config files the user edits on purpose (`.code-pact/project.yaml`, `.code-pact/agent-profiles/**`) and design/adapter files are **not** excluded.

Shape (field-presence-fixed — every key is always present):

| Key                | Type                                                  | Notes                                                                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git_available`    | boolean                                               | `false` when git is not on `PATH` or `cwd` is not a git repo                                                                                                                                                                                                 |
| `reason`           | `"not_a_git_repo"` \| `"git_not_on_path"`             | Present only when `git_available === false`                                                                                                                                                                                                                  |
| `base_kind`        | `"working-tree"` \| `"merge-base"` \| `"unavailable"` | `"merge-base"` only when `--base-ref` was supplied and resolved                                                                                                                                                                                              |
| `base_ref`         | string \| null                                        | The ref echoed back when `base_kind === "merge-base"`; otherwise `null`                                                                                                                                                                                      |
| `base_error`       | object                                                | Present **only** when `--base-ref` was supplied but `merge-base` / `rev-parse` failed (graceful fallback to working-tree mode). Shape: `{ code: "MERGE_BASE_NOT_FOUND" \| "REF_NOT_FOUND", message, requested_ref }`. Exit code is **unchanged** (advisory). |
| `files_touched`    | string[]                                              | Sorted, deduplicated POSIX-relative paths                                                                                                                                                                                                                    |
| `outside_declared` | string[]                                              | Files that match no declared glob in the task's `writes`                                                                                                                                                                                                     |
| `declared_unused`  | string[]                                              | Declared globs that matched no file in `files_touched`. Promotes to `TASK_WRITES_AUDIT_DECLARED_UNUSED` warning (v1.6+, P15-T4) when non-empty                                                                                                               |
| `warnings`         | string[]                                              | Advisory warning codes (see Plan diagnostics table)                                                                                                                                                                                                          |

The audit defaults to advisory in v1.6 — it never changes the exit code unless `--audit-strict` is supplied (see below).

### `--audit-strict` flag (v1.6+, P15-T6)

Opt-in promotion of `TASK_WRITES_AUDIT_*` warnings from advisory to exit-relevant. When `--audit-strict` is supplied and the audit emits at least one warning, `task finalize` returns `WRITES_AUDIT_STRICT_FAILED` (exit **1**) instead of the success envelope, and the design YAML is **not** mutated even when `--write` is also set. Default invocations (no `--audit-strict`) are unchanged — warnings stay advisory and exit code stays 0.

`--audit-strict` **requires `--json`** for the same reason `--base-ref` does: the audit it gates is JSON-only. Passing `--audit-strict` without `--json` returns `CONFIG_ERROR` (exit 2).

Distinct from `plan lint --strict`: `--strict` is plan-lint-scoped (promotes plan diagnostics during static analysis); `--audit-strict` is task-finalize-scoped (promotes write_audit warnings at finalize time). Keeping them distinct preserves existing CI consumers of either flag.

Strict-failure envelope:

```json
{
  "ok": false,
  "error": {
    "code": "WRITES_AUDIT_STRICT_FAILED",
    "message": "task finalize \"P9-T5\": --audit-strict and audit emitted warnings: TASK_WRITES_AUDIT_OUTSIDE_DECLARED. No design YAML mutation applied."
  },
  "data": {
    "task_id": "P9-T5",
    "phase_id": "P9",
    "applied": false,
    "write_audit": { ... },
    "failed_checks": ["write_audit"],
    "first_failure": { "name": "write_audit", "reason": "task finalize \"P9-T5\": --audit-strict and audit emitted warnings: ..." },
    "suggested_next_command": null
  }
}
```

`applied: false` is a fixed invariant on the strict-failure path: the gate fires **before** `applyPlannedWrite`, so even `--write` invocations leave the phase YAML byte-identical when the audit refuses.

### Failure clarity fields (v1.26+, P32 — additive)

Every `task finalize` **failure** envelope (`TASK_FINALIZE_NOT_ELIGIBLE`, `TASK_FINALIZE_WRITE_REFUSED`, `WRITES_AUDIT_STRICT_FAILED`) carries the same three additive `data` fields as `task complete` (see [`task complete`](#task-complete)): `failed_checks`, `first_failure: { name, reason } | null`, and `suggested_next_command: string | null`. Because `finalize` produces no verify `checks`, a single pseudo-check is synthesized per failure code — `eligibility` / `write_safety` / `write_audit` respectively — with `reason` set to the error message (the full structured detail stays in the existing fields, e.g. `data.write_audit`). `suggested_next_command` is the deterministic rerun-**after-fixing** command (`code-pact task complete <id>` for `TASK_FINALIZE_NOT_ELIGIBLE`; `null` for the two that require a human edit). Human output prints the cause and (when present) a `rerun after fixing:` line to stderr below the existing message. No new error codes; existing fields (`write_audit`, `current`, `reason`, `file`) are unchanged.

### Errors

| Code                                         | Exit  | When                                                                                                                                                                                                                      |
| -------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TASK_NOT_FOUND`                             | 2     | Task id is not present in any phase                                                                                                                                                                                       |
| `AMBIGUOUS_TASK_ID`                          | 2     | Task id appears in more than one phase                                                                                                                                                                                    |
| `TASK_FINALIZE_NOT_ELIGIBLE`                 | 2     | Derived state from the progress ledger is not `done`. Raised in **both** dry-run and `--write`. `data.current` carries the actual derived state                                                                           |
| `TASK_FINALIZE_WRITE_REFUSED`                | 2     | Safety check failed. `data.reason` carries one of `unsafe_path` / `outside_design_phases` / `not_yaml` / `symlink_escape` / `unreadable` / `unparseable_phase` / `task_not_found`. `data.file` carries the offending path |
| `WRITES_AUDIT_STRICT_FAILED` (v1.6+, P15-T6) | **1** | `--audit-strict` was supplied and the audit emitted at least one `TASK_WRITES_AUDIT_*` warning. Exit code is **1** (not 2): the invocation was well-formed; only the strict gate refused. `data.applied: false` is fixed  |
| `CONFIG_ERROR`                               | 2     | Missing positional task id, unknown flag, `--base-ref` supplied without `--json` (v1.6+, P15-T1), or `--audit-strict` supplied without `--json` (v1.6+, P15-T6)                                                           |

### Usage example

See the generated [CLI reference § `task finalize`](cli-reference.generated.md) for the preview→apply examples. Recommended adoption: stop hand-editing design status in release prep — use `task finalize` (or `phase reconcile`, P11-T4) instead.

## `phase reconcile` — bulk-flip task design statuses for a phase (v1.2+, P11)

For usage, flags, and basic examples, see the generated [CLI reference § `phase reconcile`](cli-reference.generated.md#phase-reconcile).

`phase reconcile` walks every task inside `design/phases/<phase>.yaml`, classifies each one against its derived state from the progress ledger, and (with `--write`) flips the `status` field for every task whose derived state is `done` while its design status is still `planned` / `in_progress`. Stability: **Stable (v1.2+)**.

Default mode is dry-run. Pass `--write` to apply the mutations. No `--agent` flag — like `task finalize`, this is a design/progress reconciliation command that never calls an adapter.

`phase reconcile` **never** auto-flips the phase's own `status` field. It computes a `phase_status_candidate` and surfaces it as advisory only; the phase status itself is flipped by hand in release prep (manual by convention — see [`docs/concepts/governance.md` § Phase status manual-flip convention](concepts/governance.md#4-phase-status-manual-flip-convention)). `phase reconcile` also **never** writes to the progress ledger and **never** writes to `design/roadmap.yaml`.

### Per-task classification

Each task in the phase is classified into one of three actions:

| Action          | When                                                                                                                                              | Effect of `--write`                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `flip`          | Derived state is `done` AND design status is `planned` / `in_progress`                                                                            | Status is rewritten to `done` (atomic write)                    |
| `skip`          | Design status is already `done`, OR derived state is `planned` (no events recorded), OR derived state is `started` / `resumed` (work in progress) | No change                                                       |
| `manual_review` | Derived state is `blocked` or `failed`                                                                                                            | No change. The user is directed to `plan analyze` for diagnosis |

`phase reconcile` never touches `manual_review` tasks even with `--write`. The classifier intentionally narrows the writable set to the unambiguous `done-but-design-not-done` case.

### Order of operations

1. **Phase resolution.** Reads `design/roadmap.yaml`, finds the phase, loads its YAML. `PHASE_NOT_FOUND` is raised if the phase id is unknown; `AMBIGUOUS_PHASE_ID` if it appears in more than one roadmap entry.
2. **Classification.** For each task, derives state via `deriveTaskState` and applies the table above.
3. **Phase status candidate.** Computes a suggested phase status by simulating the post-flip state. Surfaced as `phase_status_candidate` (advisory). Never written.
4. **No eligible writes.** If no task is classified as `flip`, returns `kind: "no_eligible_tasks"` with exit 0 in both dry-run and `--write`. This is **not** an error — it just means there is nothing to reconcile.
5. **Safe-write classification.** Each flip candidate is validated via `src/core/path-safety.ts` and parsed as a Phase. Failures land in `skipped_writes[]` with a structured `reason` (`unsafe_path` / `outside_design_phases` / `not_yaml` / `symlink_escape` / `unreadable` / `unparseable_phase` / `task_not_found`).
6. **Dry-run or `--write`.** In dry-run, returns `kind: "would_reconcile"` with `planned_writes[]`. In `--write`, applies each diff via `atomicWriteText` and returns `kind: "reconciled"` with `applied_writes[]` and any apply-time failures in `skipped_writes[]`.
7. **All-refused error.** When `--write` is requested and **every** eligible write was refused, `PHASE_RECONCILE_WRITE_REFUSED` (exit 2) is raised with `data.skipped_writes[]` carrying the refusal details. Partial successes (one or more applied, one or more refused) return exit 0.

### JSON envelope (success)

```json
{
  "ok": true,
  "data": {
    "kind": "would_reconcile" | "reconciled" | "no_eligible_tasks",
    "phase_id": "P11",
    "file": "design/phases/P11-finalization-reconciliation.yaml",
    "tasks": [
      {
        "task_id": "P11-T1",
        "current_design_status": "planned",
        "derived_state": "done",
        "target_status": "done",
        "action": "flip",
        "reason": null
      }
    ],
    "planned_writes": [{ "file": "...", "task_id": "...", "before": "planned", "after": "done" }],
    "applied_writes": [],
    "skipped_writes": [{ "file": "...", "task_id": "...", "reason": "outside_design_phases", "detail": "..." }],
    "phase_status_candidate": "done",
    "phase_status_note": "advisory — phase status is never written by phase reconcile; flip it by hand in release prep"
  }
}
```

Field presence by kind:

| Field                                         | `would_reconcile` | `reconciled` | `no_eligible_tasks` |
| --------------------------------------------- | ----------------- | ------------ | ------------------- |
| `phase_id`, `file`                            | ✓                 | ✓            | ✓                   |
| `tasks[]` (per-task verdicts)                 | ✓                 | ✓            | ✓                   |
| `phase_status_candidate`, `phase_status_note` | ✓                 | ✓            | ✓                   |
| `planned_writes[]`                            | ✓                 | absent       | absent              |
| `applied_writes[]`, `skipped_writes[]`        | absent            | ✓            | absent              |

`phase_status_candidate` reflects the post-flip simulation. It is `done` only if every task would end up `done`; `in_progress` if any task is `started` / `blocked` / `resumed` / `failed`; otherwise `planned`. Writing the actual phase status remains a manual release-prep step.

### Errors

| Code                            | Exit | When                                                                                                                                                                                                       |
| ------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PHASE_NOT_FOUND`               | 2    | Phase id is not present in `design/roadmap.yaml`                                                                                                                                                           |
| `AMBIGUOUS_PHASE_ID`            | 2    | The phase id appears in more than one `roadmap.yaml` entry; `data.phases[]` lists the colliding files                                                                                                      |
| `PHASE_RECONCILE_WRITE_REFUSED` | 2    | `--write` was requested AND every eligible task write was refused for safety reasons. `data.skipped_writes[]` carries the per-task refusal detail. Not raised when at least one write applied successfully |
| `CONFIG_ERROR`                  | 2    | Missing positional phase id, or unknown flag                                                                                                                                                               |

### Usage example

See the generated [CLI reference § `phase reconcile`](cli-reference.generated.md#phase-reconcile) for the preview and apply examples. Recommended adoption: replace hand-edits of `design/phases/*.yaml` in release prep with a single `phase reconcile` write invocation.

## `decision prune`

For usage, flags, and basic examples, see the generated [CLI reference § `decision prune`](cli-reference.generated.md#decision-prune).

`decision prune` retires a shipped, **accepted** decision record from the live plane. **Dry-run by default** — it deletes nothing, rewrites no links, and appends no `PRUNED.md` row; it reports the eligibility verdict and the complete inbound-link rewrite plan. `--write` **executes** that plan in least-harmful order: it appends the `PRUNED.md` row, rewrites each inbound link, then deletes the record last. The verdict and the plan are produced by code shared between dry-run and `--write` — dry-run never relaxes a gate or shortens the plan, and `--write` re-runs the same collector at apply time (it never re-parses or re-interprets a stored plan). Eligible exits 0; ineligible exits 2 with [`DECISION_PRUNE_NOT_ELIGIBLE`](#public-codes-top-level-error-envelopes) (the verdict is identical for dry-run and `--write`).

The active **retention policy** (`project.yaml: decision_retention` — `keep-full` default \| `compress-on-ship` \| `prune-on-ship`) is surfaced in the envelope as `data.policy` + `data.policy_source` (`"project"` \| `"default"` \| `"override"` \| `"invalid_project"`). `--policy <v>` overrides it for the invocation (an out-of-enum value is a `CONFIG_ERROR`). `"invalid_project"` means the project's `decision_retention` is **present but out of enum** — including a present-but-empty `decision_retention:` (YAML `null`), which is a typo, not an absent field — so `decision prune` falls back to `keep-full`, surfaces this source, and adds a `warnings[]` entry, while `validate` / `doctor` report it as a `SCHEMA_ERROR`. (A `--policy` override is validated up front, so an invalid override never reaches this state.) `policy` / `policy_source` appear on the **dry-run**, **ineligible** (`DECISION_PRUNE_NOT_ELIGIBLE`), and **`--write` success** envelopes; the `DECISION_PRUNE_PLAN_STALE` / `DECISION_PRUNE_WRITE_FAILED` error envelopes do not carry them (no policy was acted on). The policy is **reported, not enacted** — it does not change what is prunable or what gets deleted (deletion stays an explicit `decision prune` action); it gives a project its declared default and lets tooling read the intent. The destructive `compress-on-ship` transform is a later layer (`decision compress`, not yet shipped).

Dry-run success envelope (`--json`):

```json
{
  "ok": true,
  "data": {
    "mode": "dry-run",
    "decision": "design/decisions/foo-rfc.md",
    "eligible": true,
    "blocks": [],
    "referencing_tasks": [
      {
        "task_id": "P1-T1",
        "phase_id": "P1",
        "status": "done",
        "via": "decision_refs"
      }
    ],
    "plan": {
      "remove_file": "design/decisions/foo-rfc.md",
      "append_ledger": true,
      "link_rewrite": { "status": "ready", "items": [] }
    },
    "policy": "keep-full",
    "policy_source": "default",
    "warnings": []
  }
}
```

`plan.link_rewrite.status` is **`"ready"`** — `items[]` is the complete set of inbound references the write plan **considers** (collected once, shared by the dry-run preview and `--write`); each carries a `rewrite_action`. The collector scans the **same** source surface as `check:doc-links` and uses its **same** code-stripping and external-URL rules: root-level `.md` **except `CHANGELOG.md`** (a durable authored record, never rewritten), `docs/**`, `design/**`, and `.github/**` (`.md` + `.yml`). It is line- and column-accurate and resolves each link relative to its **own source file's directory**. Links inside fenced code blocks, inline code, and image embeds (`![]()`), and external / protocol-relative URLs, are **excluded entirely** (blanked exactly as `check:doc-links` ignores them) — they are not live references, so they never enter the plan. The inline-destination grammar is intentionally a **superset** of the checker's (it also matches `<href>`, single-quoted, and parenthesized-title links), so every link the checker would flag broken after the target is deleted is guaranteed to be in the plan; the extra forms only mean valid links the checker happens to miss are cleaned up too. Each `items[]` entry carries everything `--write` needs to act on the exact span without re-parsing:

| Field               | Meaning                                                                                |
| ------------------- | -------------------------------------------------------------------------------------- |
| `source_file`       | repo-relative POSIX path of the file that links to the pruned decision                 |
| `line`              | 1-based line number                                                                    |
| `column`            | 1-based column where the link starts (disambiguates two links on one line)             |
| `raw_link`          | the full matched link exactly as found, e.g. `[A](../x.md "t")`                        |
| `raw_href`          | the **destination token** only — preserves `<foo.md>`, excludes any title              |
| `link_text`         | the visible text — what `delink` keeps                                                 |
| `normalized_target` | the link's normalized repo-relative target (equals the pruned decision path)           |
| `link_kind`         | `inline` (`[t](url)`) \| `index_row` (the `README.md` decision-index row)              |
| `rewrite_action`    | `tombstone` (index row → "(pruned …)" line) \| `delink` (keep the text, drop the link) |

A **reference-style** inbound link (`[t][label]` + `[label]: url`) cannot be rewritten span-locally without touching its usages, and an **unreadable** doc source means the plan would be incomplete — both fail closed as `DECISION_PRUNE_NOT_ELIGIBLE` (`link_rewrite_unsupported` / `link_rewrite_scan_unreadable`), not as silently-dropped items.

`warnings[]` carries advisories (e.g. an eligible target that no task references — prune cannot prove it shipped).

### `decision prune --write`

`--write` executes the plan under the project's [advisory write lock](#public-codes-top-level-error-envelopes) (`LOCK_HELD` on contention). All fallible reads/computes happen in a **preflight** that writes nothing; the commit then runs in least-harmful order:

1. **Preflight (no writes).** The **target itself** must still be a readable, regular file whose **content is byte-identical to what the verdict was computed from** — an in-place edit (accepted → proposed, a new open commitment, a rewritten body) keeps the inode but invalidates the eligibility being acted on, so it is refused (it never deletes a now-ineligible record). This same target check (content + inode/dev) runs again **immediately before the first write** — so a record edited during the multi-read preflight is a zero-write `DECISION_PRUNE_PLAN_STALE`, not a late delete-phase failure — and once more **just before the delete** (reading content then `stat`, so a path swapped for a coincidentally-matching file cannot bypass the inode check). The plan must still describe the live tree exactly — `--write` re-collects inbound links and refuses if anything moved (a shifted span, a link reclassified into code/image, a removed link, a **new** inbound link the plan would not rewrite, or a source that became unreadable / reference-style), then re-reads each source and confirms every span still byte-equals its `raw_link`. The ledger's next content is read+computed. A plan/tree divergence aborts with [`DECISION_PRUNE_PLAN_STALE`](#public-codes-top-level-error-envelopes); an unreadable ledger aborts with [`DECISION_PRUNE_WRITE_FAILED`](#public-codes-top-level-error-envelopes). Either way, **zero writes** (exit 2).
2. **Append the `PRUNED.md` ledger row FIRST** (created with its header when absent; existing ledgers are only appended to). A row for a still-present record is benign — the status-aware ref check only consults the ledger once the file is absent — so a ledger failure here leaves inbound docs **byte-identical**. The decision path is recorded as a **code span**, never a link. `PRUNED.md` is **re-read immediately before this write, and again just before the rename** (`expectedCurrent`) — the same two-point drift guard the source rewrites use — so a concurrent/manual ledger edit is refused, not clobbered. The append is **idempotent**: a decision already recorded is not duplicated, so a re-run after a partial-failure prune does not add a second tombstone (and `ledger_row` then reports the **existing** row as it stands at commit time, even if hand-edited).
3. **Rewrite inbound links.** Each source is **re-read immediately before its write** and refused if it changed since preflight — a concurrent edit (an editor, `git checkout`, another tool; the advisory lock does **not** guard these) is never clobbered with stale rewritten content; it raises `DECISION_PRUNE_WRITE_FAILED` (`rewrite_links`) and the edit survives. Writes use an **existing-file replace** (`atomicReplaceExistingText`) that does not re-create a vanished file/parent.
4. **Delete the record** — the only irreversible step, done last. Immediately before `unlink` the path is re-`stat`ed against the preflight inode/device (a swapped path is refused) **and its content re-read** against the verdict bytes (an in-place edit since the verdict is refused); if the record **disappeared or was edited** before this step, code-pact reports `DECISION_PRUNE_WRITE_FAILED` (`delete_record`) rather than claiming a removal.

Cross-file atomicity is not claimed (a POSIX filesystem cannot transact across files without a journal). The guarantees are: (a) a failure never leaves a **broken-link or `validate`-breaking** intermediate state (the record is deleted last, so a partial rewrite still resolves to a present target); and (b) every commit-time write **re-resolves its path through `resolveWithinProject` and re-checks the destination immediately before acting**, so a concurrent change is refused, not overwritten, and `--write` only ever touches repo-internal files. The exact identity checked differs by surface: the **target** is verified by repo-boundary + **content + inode/dev**; **sources** and the **ledger** by repo-boundary + content/existence (an editor / `git checkout` / `rm -rf` / a directory symlinked out of the repo since preflight is caught). (b) is **not** a filesystem-level compare-and-swap: a write that lands in the final read→`rename` (or `stat`→`unlink`) gap cannot be caught portably, so it is a narrow-window guard, not an absolute guarantee. A commit-time I/O failure raises [`DECISION_PRUNE_WRITE_FAILED`](#public-codes-top-level-error-envelopes) with `data.phase` (`append_ledger` / `rewrite_links` / `delete_record`) and `data.partial_applied` — whether **this invocation** already landed a mutation (the ledger appended this run, or ≥1 source rewritten). `append_ledger` is always `false`; `rewrite_links` / `delete_record` are `true` **except** on an idempotent already-recorded retry that fails before any rewrite lands (then `false`, because nothing was mutated this run).

`--write` success envelope (`--json`):

```json
{
  "ok": true,
  "data": {
    "mode": "write",
    "decision": "design/decisions/foo-rfc.md",
    "removed_file": "design/decisions/foo-rfc.md",
    "link_rewrites_applied": [
      {
        "source_file": "docs/x.md",
        "line": 3,
        "column": 5,
        "rewrite_action": "delink",
        "before": "[d](../design/decisions/foo-rfc.md)",
        "after": "d"
      }
    ],
    "ledger_row": "| `design/decisions/foo-rfc.md` | P1-T1 | 2026-06-09 | git history |",
    "ledger_action": "appended",
    "policy": "prune-on-ship",
    "policy_source": "project",
    "warnings": []
  }
}
```

`ledger_action` is `"appended"` when a new tombstone row was written, or `"already_recorded"` when the decision was already in `PRUNED.md` (an idempotent re-run after a partial-failure prune) — in that case **nothing was appended** and `ledger_row` reports the **existing** row already in the ledger (not a freshly-generated one). The rest of the prune (link rewrites + record deletion) still runs.

Pruning a record that is **already gone** (a second `--write`) exits 2 with `DECISION_PRUNE_NOT_ELIGIBLE` / `target_missing` — fail-closed, not a convergent no-op.

## `phase archive`

For usage, flags, and basic examples, see the generated [CLI reference § `phase archive`](cli-reference.generated.md#phase-archive).

(v2.0, design-docs-ephemeral) — `phase archive` archives a **terminal** phase (status `done` / `cancelled`, every task terminal): it writes a phase-snapshot record under `.code-pact/state/archive/phases/<id>.json`, then deletes the matching `design/phases/*.yaml` file. The archived phase still resolves from the snapshot — **the roadmap ref is kept**, and an active task that depends on one of its tasks keeps resolving. **Dry-run by default** — it writes nothing and deletes nothing; pass `--write` to apply. It never edits the roadmap, rewrites a link, or appends a ledger. See the [`PHASE_ARCHIVE_*` error codes](#public-codes-top-level-error-envelopes) for the fail-closed verdicts.

**Eligibility (a phase is archivable only when its terminal state survives the file).** Every task must have a terminal state established **independently of the YAML** — a `done` derived from `.code-pact/state/events/`, or a `cancelled` recorded as such. A YAML `status: done` **alone is not sufficient**: it disappears with the file, so a task that is `done` in the YAML but has **no `done` event** blocks the archive with `task_done_without_done_event` (older projects whose tasks pre-date the per-event ledger hit this). The narrow escape is `--attest <task-id>=<reason>` (repeatable), which attests a legacy done-task that has no done event — it does **not** let you archive a non-terminal phase or skip the snapshot.

Dry-run success envelope (`--json`):

```json
{
  "ok": true,
  "data": {
    "kind": "would_archive",
    "phase_id": "P1",
    "yaml_path": "design/phases/P1.yaml",
    "snapshot_path": "<repo>/.code-pact/state/archive/phases/P1.json",
    "snapshot_action": "write"
  }
}
```

`--write` success envelope (same shape; `kind` → `"archived"`, `snapshot_action` is the real outcome):

```json
{
  "ok": true,
  "data": {
    "kind": "archived",
    "phase_id": "P1",
    "yaml_path": "design/phases/P1.yaml",
    "snapshot_path": "<repo>/.code-pact/state/archive/phases/P1.json",
    "snapshot_action": "write"
  }
}
```

`--write` writes the snapshot under the [advisory write lock](#public-codes-top-level-error-envelopes) (`LOCK_HELD` on contention), readback-verifies it (the written snapshot must be reader-tolerated and its `source_sha256` must match the live YAML), re-checks the YAML's identity (content + inode/dev; an ancestor symlink escape or an in-place edit between baseline and delete is refused), then deletes the YAML **last** (least-harmful order). Any drift aborts with [`PHASE_ARCHIVE_STALE`](#public-codes-top-level-error-envelopes) (`data.reason`) and **the YAML is untouched**. The `--write` envelope has the **same shape** as the dry-run one, but `kind` becomes `"archived"` and `snapshot_action` reports the **actual** write outcome — `"write"` or `"noop"` (it never reports the dry-run-only preview value `"refresh"`; a planned `refresh` applies as `"write"`). Re-running on an already-archived phase (YAML absent, valid snapshot present) is **not** an error in the readers — but `phase archive` itself exits 2 with `PHASE_ARCHIVE_NOT_ARCHIVED` only when the YAML is absent **and no valid snapshot resolves it** (a broken state, not "already archived").

Examples live in the generated [CLI reference § `phase archive`](cli-reference.generated.md#phase-archive).

## `state compact`

For usage, flags, and basic examples, see the generated [CLI reference § `state compact`](cli-reference.generated.md#state-compact).

(v2.0, event-pack compaction) — `state compact` folds an **archived** phase's loose per-event YAML files (`.code-pact/state/events/<at-compact>-<id>.yaml`) into one content-addressed event pack (`.code-pact/state/archive/event-packs/<id>.json`), then **deletes** the loose files. The pack is the durable record; the loose files become ephemeral. **Dry-run by default** — it writes nothing and deletes nothing; pass `--write` to apply (under the [advisory write lock](#public-codes-top-level-error-envelopes), `LOCK_HELD` on contention). The phase must be fully archived first ([`phase archive <id> --write`](#phase-archive)); a live phase YAML with that id makes it ineligible. See the [`STATE_COMPACT_*` error codes](#public-codes-top-level-error-envelopes) for the fail-closed verdicts.

**Dry-run success shapes** (`data.kind`, no mutation, exit 0). The verdict names mirror what `--write` WOULD do (it cleans, not just packs):

- `would_pack_and_cleanup` — the pack does not exist yet; `--write` would write it and remove `would_leave_loose_count` loose files. Carries `pack_path`, `would_pack_event_count`, `would_leave_loose_count`, `cleanup_pending:true`.
- `would_cleanup_loose` — a valid pack already covers the phase and the loose set matches it exactly; `--write` would remove `loose_remaining_count` loose files. Carries `pack_path`, `cleanup_pending:true`.
- `would_resume_cleanup` — a valid pack covers the phase but a prior cleanup or manual `rm` left a strict, non-empty **subset** of loose files (every remaining loose id is in the pack — a resumable partial cleanup, **not** stale); `--write` would remove the remaining `loose_remaining_count`. Carries `pack_path`, `cleanup_pending:true`.
- `noop_already_cleaned` — a valid pack covers the phase and no loose files remain (fully compacted). Carries `pack_path`, `cleanup_pending:false`.
- `noop_no_events` — no progress events for the archived phase; nothing to pack or clean.

**`--write` success shapes** (`data.kind`, the public `CleanupOutcome`, exit 0):

- `cleaned` — the verified pack is the durable record (written this run if needed) and the gated loose files were removed. `data.loose_deleted_count` is the unlink count, `data.cleanup_remaining_loose:0`, `data.vanished_count` counts files that were already gone (a concurrent remover) — a `cleaned` always satisfies `loose_deleted_count > 0 ∨ vanished_count > 0`.
- `already_cleaned` — a valid pack covers the phase and no loose files remain (idempotent re-run).
- `noop_no_events` — no progress events for the archived phase; nothing to compact.

The failure outcomes map to the four `STATE_COMPACT_*` error codes (exit 2). `STATE_COMPACT_WRITE_FAILED` with `data.phase === "verify_pack"` carries a `data.next_action` that says to inspect the pack **only if it is still present** — a post-write re-prepare race may have removed it — and rerun; no loose file is unlinked on that path, so the durable ledger is intact.

## `state compact-archive`

For usage, flags, and basic examples, see the generated [CLI reference § `state compact-archive`](cli-reference.generated.md#state-compact-archive).

(v2.0, archive-level compaction — Layer 4) — `state compact-archive` **consolidates** a kind's per-item archive records into ONE content-addressed **bundle** (`archive/bundles/<kind>-<hash>.json`) and **deletes** the loose copies it now holds byte-identically. It gathers the kind's full member set (existing bundle members ∪ new loose `archive/phases|event-packs|decisions/*.json`), writes a single consolidated bundle, **retires** the now-superseded smaller bundles, then deletes the bundled loose. So in a **healthy store with no stale/divergent records**, **repeated runs converge to ~one bundle per kind** — the bundle file count stays bounded, not just the loose count. (Fail-closed survivors are **by design**, not a bug: a `bundle_stale` loose that is not adoptable this run, a `bundle_member_invalid` member, or a bundle the consolidated one does not fully cover all leave their file in place to protect truth — they are reported in `skipped` / `would_skip`, never silently dropped.) A bundle is the durable form; readers resolve `loose ∪ bundle` (loose wins), so deleting a bundled loose record strands nothing. It also **supersedes** a stale member: when a loose record DIVERGES from its bundle member, the fresher loose is adopted (the bundle member is replaced in place, then the loose deleted) — but ONLY in the adoption-safe store shape (exactly one bundle of the kind, already at its content address, with nothing new to fold this run). Any other diverging loose is **deferred** as a `bundle_stale` skip; the consolidation still converges the store, so a later run adopts it. (Retire-before-replace for a redundant-survivor store is later Layer-4 work.) This closes the **refresh-after-compaction** loop: refreshing a record whose loose copy was already compacted away now MATERIALISES a fresh loose (the producer's `refresh` plan; it used to return `ineligible compacted_record_refresh_unsupported`), which diverges from the bundle member until the next compaction adopts it. **Dry-run by default** (writes/deletes nothing); `--write` applies under the [advisory write lock](#public-codes-top-level-error-envelopes) (`LOCK_HELD` on contention). The optional positional `<kind>` restricts to one kind (a second positional → `CONFIG_ERROR`); omitting it processes all three. NOTE the ids reported are **logical record ids** — a `deleted` id no longer has a loose file (it lives only in a bundle). This verb does **not** yet apply retention (`keep-latest`) or shard — those are later Layer-4 work. **`--write` REFUSES (`PENDING_DELETE_INTENT`, exit 2) when a delete-intent journal is pending**: compaction is not recovery-first, and its consolidation would retire a crashed bundle-pair removal's reduced survivor bundle as "superseded" — after which recovery could never complete (a permanent wedge). Recover first with [`state archive-maintain --write`](#state-archive-maintain), which recovers the journal before compacting.

**Dry-run success shape** (`data.mode === "dry_run"`, no mutation, exit 0): `data.plans[]`, one entry per kind, each `{ kind, would_bundle[], would_delete[], would_supersede[], would_skip[], would_retire_bundles[] }` — `would_bundle` = loose ids that would be folded into the consolidated bundle; `would_delete` = loose ids a verified bundle already holds byte-identically (would be removed); `would_supersede` = loose ids that DIVERGE from their (single, content-addressed) bundle member and are safely adoptable — the fresher loose would replace the stale bundle member in place, then the loose be deleted; `would_skip` = loose ids that cannot be acted on fail-closed (`{ id, reason }` where reason is `bundle_stale` — a same-id bundle member with different bytes that is NOT safely adoptable this run, e.g. a redundant survivor bundle holds it or new loose is still pending fold, with a `detail` saying which — or `bundle_member_invalid`); `would_retire_bundles` = existing bundle files the consolidation would supersede + delete. NOTE on `bundle_member_invalid`: an existing bundle MEMBER that is not foldable is pulled into the consolidated set, so it usually surfaces EARLIER as a fail-fast `build` fault (`ARCHIVE_BUNDLE_WRITE_FAILED`, `data.phase: build`) for the whole kind rather than a per-record `would_skip` — the `bundle_member_invalid` skip reason is the per-record classification the build fault typically preempts.

**`--write` success shape** (`data.mode === "written"`, exit 0): `data.results[]`, one per kind, each `{ kind, bundle, retired_bundles[], deleted[], skipped[], remaining_loose }` — `bundle` is the consolidated-bundle write outcome (`written` / `superseded` — a stale member was adopted in place — / `noop_already_bundled` / `noop_no_members`), `retired_bundles` the superseded bundle files removed, `deleted` the unlinked loose ids, `skipped` the per-record fail-closed skips, `remaining_loose` the loose records that survived.

**Failure** (exit 2): a build/write/verify/**retire** fault (a non-canonical / Tier-1-invalid member — loose OR an existing bundle member pulled into the consolidation — a write/verify failure, or a superseded-bundle unlink failure) → `ARCHIVE_BUNDLE_WRITE_FAILED` with `data.phase` one of `build` / `write_bundle` / `verify_bundle` / `retire_bundle`; a corrupt bundle **store** (any Tier-1-invalid bundle) → `ARCHIVE_BUNDLE_INVALID`. The command never proceeds past the failing kind. In all-kind `--write` mode, **earlier kinds may already have applied** before a later kind fails — the failure envelope's `data` carries `failed_kind` (the kind being processed when the run stopped — for a corrupt-store `ARCHIVE_BUNDLE_INVALID` this is _where_ it stopped, not a claim that that kind's data is the fault), `data.phase` (`build` / `write_bundle` / `verify_bundle` / `retire_bundle`), `partial_applied`, and `completed_results[]` (the kinds that finished) so "how far it got" is never hidden. The **dry-run predicts the `build` and `write_bundle` faults read-only** — it builds the exact consolidated bundle the write path would (surfacing a non-foldable member as `build`) and checks the content-addressed target for a divergent existing bundle (surfacing it as `write_bundle`) — so a dry-run never promises a `would_bundle` / `would_retire` the `--write` path would reject.

## `state archive-retention`

For usage, flags, and basic examples, see the generated [CLI reference § `state archive-retention`](cli-reference.generated.md#state-archive-retention).

(v2.0, archive-level compaction — Layer 4) — `state archive-retention` does **keep-latest-N retention** of the archive: it bounds the archive's UNREFERENCED tail so a long project's `.code-pact/state/archive` does not grow forever. **Dry-run by default** (mutates nothing); `--write` (under the [advisory write lock](#public-codes-top-level-error-envelopes), `LOCK_HELD` on contention) DELETES old archive truth. It is a SEPARATE verb from `compact-archive` (NOT `compact-archive --retain`) because the safety model differs — compaction relocates truth, retention discards it. It bounds `.code-pact/state/archive` ONLY — it NEVER touches a live `design/` doc. **`--write` scope (this layer):** it RECOVERS any crashed prior pair-delete FIRST (under the write lock — a corrupt delete-intent journal is fail-closed), then deletes each LOOSE-only `would_drop` record:

- an INDEPENDENT record — a `decision_record`, or a `phase_snapshot` with **no** `event_pack` — by a single atomic unlink;
- a loose `phase_snapshot` ↔ loose `event_pack` PAIR — both files **both-or-neither**, crash-safe, via the durable **delete-intent journal** (the two are mutually bound, see below, and a filesystem cannot unlink two files atomically, so the journal makes "both gone" survive a crash).

Immediately before each unlink a per-record gate re-reads the loose file and (a) re-authority-validates it AND (b) confirms its bytes still hash to the `loose_sha256` the plan captured — the **planned-bytes digest gate**: it deletes exactly the bytes the plan decided on, not merely "a valid record at this path", so a record swapped for a different-but-still-valid one under us is kept (`authority_changed`), not deleted. A bundle-backed (`bundle` / `both`) `would_drop` phase + pair PAIR is now removed through the bundle-pair journal (see below) — `deleted` (no copy resolves) or `bundle_member_removed` (a `both` record's loose copy survives); an INDEPENDENT bundle record (a bundle decision, a bundle phase with no pack) is still reported `skipped: needs_bundle_member_removal` (the single-kind apply wiring is a later layer). A LOOSE pair that is not loose-only-removable (a member is bundle-backed but unpairable, a digest is missing, the event store is a partial view, or — `unsupported` — the platform cannot fsync a directory so durable pair deletion is unavailable) is deferred `skipped: requires_atomic_pair_removal`. The plan is **re-run as the delete authority inside the apply** (never a stale dry-run), so a record that became referenced, invalid, or divergent since a prior dry-run is not deleted.

**Conservative model (the gate is fail-closed):** a record still REFERENCED by the live project graph is ALWAYS kept (`blocked`), regardless of age — so retention can never break a surviving reader (`validate` / `plan lint` / resolvers stay green; no gate is softened). `keep-latest N` (default 20, must be ≥ 1) applies **per kind to the UNREFERENCED pool only** (referenced/blocked records are NOT counted in N); of the unreferenced, the latest N by `snapshotted_at` are kept (`would_keep`) and the older dropped (`would_drop`), tie-broken `snapshotted_at` DESC then id ASC. A `phase_snapshot` is referenced by a live roadmap phase id OR a live task `depends_on` one of its archived task ids; a `decision_record` by a live task `decision_refs` / `acceptance_refs`. `event_pack` is **dependent**: a pack is dropped only with its phase snapshot, never on its own. The **planner is the delete authority** (the future write layer consumes this exact plan), so anything it cannot fully reason about — an invalid record, an unreadable store, a failed reference scan (e.g. a missing/unparseable roadmap → the live reference set is unknown), or an ambiguous task-id collision across snapshots — is `blocked`, NEVER silently treated as droppable.

**Dry-run success shape** (`data.mode === "dry_run"`, exit 0): `data.keep_latest` (the resolved N) + `data.retention_plans[]`, one per kind `{ kind, would_keep[], would_drop[], blocked[] }`. Each item is `{ kind, id, snapshotted_at, source: "loose"|"bundle"|"both", action: "would_keep"|"would_drop"|"blocked", reason, references? }` where `reason` is one of `within_keep_latest` / `older_than_keep_latest` / `referenced_by_roadmap` / `referenced_by_live_task_dependency` / `referenced_by_decision_link` / `dependent_on_kept_phase_snapshot` / `invalid` / `bundle_stale` / `ambiguous` / `reference_scan_failed`, and `references[]` (when referenced) names the live edge (`{ type, from, to }`) so "why isn't this dropped?" is answerable. A record present in BOTH loose and a bundle (`source: "both"`) is **strict-reconciled** — both physical copies (the loose AND the shadowed bundle member) must be authority-valid and byte-identical, else it is `blocked: bundle_stale` (a retention delete removes both copies, so a divergent shadow is never droppable on a loose-wins view — reconcile via `state compact-archive` first). Config faults (`--keep-latest 0` / non-integer, a positional) → `CONFIG_ERROR` (exit 2); the SAME `keep-latest ≥ 1` bound is enforced in the core planner, not just the CLI, so the destructive layer cannot bypass it.

**`--write` success shape** (`data.mode === "written"`, exit 0): `data.keep_latest` + `data.results[]`, one per kind `{ kind, deleted[], bundle_member_removed[], recovered[], vanished[], skipped[] }` — `deleted` the ids whose ONLY copy was removed because THIS run's plan decided to drop them (a loose unlink, OR a bundle-member removal of a record with no surviving loose copy — old truth gone); `bundle_member_removed` the ids whose BUNDLE member was removed this run but whose LOOSE copy still resolves (a `source: both` record) — **NOT `deleted`** (old truth still resolves from loose), the loose layer drops it next run (≤ 2-run convergence); `recovered` the records COMPLETED from a pending delete-intent journal (a prior run committed the delete and crashed before finishing) — recovered before this run planned, **distinct from `deleted`** (this run's plan decision) so a recovery-completed drop is never reported silently. `recovered` is `{ id, intent_kind: "loose_pair" | "bundle_pair" }[]` — TAGGED because the two recoveries differ: a `loose_pair` recovery removed both loose files (old truth fully gone), while a `bundle_pair` recovery retired the bundle members but a `source: both` record's loose copy MAY still resolve (do not read a bundle-pair recovery as "fully gone"). `vanished` the ids already gone at gate/unlink time (ENOENT, idempotent — for a half-vanished pair, ONLY the side whose file was actually gone); `skipped` the per-record `{ id, reason }` not deleted (`needs_bundle_member_removal` / `requires_atomic_pair_removal` / `path_escape` / `unreadable` / `authority_changed` / `authority_invalid` / `unlink_failed`) — nothing is ever silently dropped.

**How a phase snapshot ↔ event_pack pair is deleted both-or-neither.** The two are mutually bound: the pack carries the snapshot's `snapshot_sha256` (a pack _without_ its snapshot is structurally broken), AND the snapshot's `progress_events` evidence resolves its `event_ids` from the durable ledger (loose events ∪ validated packs) — once the loose events are compacted into the pack, the pack is that evidence's _only_ durable source, so a snapshot _without_ its pack dangles (`validate` / `plan lint` / `doctor` would flag `unresolved`). A filesystem cannot unlink two files atomically, so the pair is removed through a **write-ahead delete-intent journal** (`.code-pact/state/archive/delete-intent.json`): gate both members → write the intent (a durable `fsync` commit barrier — fsync the temp data + the parent directory, fail-closed) → unlink the pack → unlink the snapshot → clear the intent. The commit is durable _before_ any unlink, so a crash (or a power loss) is rolled either fully back (no journal → both retained) or fully forward — `recoverPendingDeletes`, run first under the write lock, completes both unlinks of any committed-but-incomplete pair. So the pair is always both-deleted or both-retained, never one side. The LOOSE-pair journal names **only loose-only pairs** — `deleteLoosePairsJournaled` refuses a pair whose member also exists as a bundle member (`needs_bundle_member_removal`) — which is what makes the reader-awareness filter (a pending pair reads as logically absent) correct. If the event_pack store is only a **partial view** (the planner emits a `(store)` block — its loose dir or bundle store was unreadable), a phase cannot be paired and is deferred fail-closed. Decisions are independent (an archived snapshot carries no `decision_refs`) and delete last. (`authority_changed` = the loose bytes no longer match the `loose_sha256` the plan captured — swapped under us; `authority_invalid` = the loose file changed and no longer authority-validates. Both fail the planned-bytes gate and are kept.)

**A BUNDLE pair (both members bundle-backed) is removed through the SAME journal, with bundle authority.** When a `would_drop` phase AND its pack are both bundle members (`source: bundle` or `both`), retention rebuilds each kind's consolidated bundle without the removed members, durably writes BOTH reduced bundles, then commits a `bundle_pair` intent (the journal's commit point) and retires both old bundles both-or-neither — a crash before the commit retains both old bundles, after is rolled forward by recovery (which re-verifies each survivor + old bundle digest before the unlink). The pre-commit reverify proves the committed intent is always completable (it never commits a stale retire that recovery could not finish). A pair is removed only when BOTH sides have the SAME loose presence — both bundle-only (→ both `deleted`) or both `source: both` (→ both `bundle_member_removed`, their loose copies dropped by the loose layer next run, ≤ 2-run convergence). A **MIXED** pair (exactly one side has a surviving loose copy — e.g. phase `both` + pack bundle-only) is deferred WHOLE `needs_bundle_member_removal`: removing both bundle members would leave that side resolving from loose while the other is gone — a snapshot-without-pack / orphan-pack half-state, which the both-or-neither invariant forbids (the per-PAIR invariant, not per side). **Resolution policy: run `state compact-archive` first.** Compaction deletes a loose record that its bundle holds byte-identically, so the `both` side becomes bundle-only — both sides are then UNIFORM (both bundle-only), and the next `archive-retention --write` removes them as a clean bundle pair. So a mixed pair is a TRANSIENT state (a mid-refresh artifact), not a permanent leak: the bounded-archive guarantee is "compact-then-retain converges", and a `validate` / `doctor` that wants to assert the archive is bounded must NOT count a mixed-source-pair-unresolved store as bounded without that compact step. **INDEPENDENT bundle records** — a bundle decision, or a bundle phase with NO event_pack (nothing binds to it) — are removed through the SINGLE-KIND bundle-member removal (no journal needed: durable write-the-reduced-bundle-then-retire-the-old ordering, crash-safe by a re-run). Same per-record outcome: `deleted` (no copy resolves) or `bundle_member_removed` (a `both` record's loose copy survives, dropped by the loose layer next run). A bundle phase WITH a pack that is not a clean pair (a loose or mixed pack) stays deferred `needs_bundle_member_removal`.

**Certifying a repo as bounded (the v2.0 "ゴミが溜まらない" gate).** The removal surface is complete — every `would_drop` record kind (loose independent, loose pair, bundle pair, bundle independent) is actually removed, a `source: both` record converges in ≤ 2 runs, and a mixed-source pair is resolved by a prior `state compact-archive`. To certify a repo's archive is bounded: (1) `state compact-archive` (bounds the bundle COUNT and makes any mixed pair uniform); (2) `state archive-retention --keep-latest N --json` (DRY-RUN) and inspect `would_drop` / the per-kind plan; (3) `state archive-retention --keep-latest N --write` and confirm the result has **no unexpected `skipped`** old-truth tail (a `needs_bundle_member_removal` skip means a record the compact step left non-uniform — re-run step 1) and no `requires_atomic_pair_removal` / partial-store deferral; (4) re-run dry-run — a bounded store reports an empty (or only-referenced-blocked) `would_drop`. The reproducible proof of this convergence is `tests/unit/core/archive/bounded-archive-validation.test.ts`. **Scope — what "bounded" means here (no over-claim):** this bounds the archive's FILE COUNT (compaction folds the loose tail into ~one bundle per kind) and removes UNREFERENCED old truth (retention). It does NOT yet bound a single bundle's BYTE SIZE — a kind's bundle grows as the number of REFERENCED records grows, because referenced truth is kept by design (sharding a large bundle is deferred future work). So "garbage doesn't accumulate" holds for loose-file sprawl and unreferenced old truth; bounding total stored bytes (sharding / a referenced-truth lifetime policy) is a separate, later concern.

## `state archive-maintain`

For usage, flags, and basic examples, see the generated [CLI reference § `state archive-maintain`](cli-reference.generated.md#state-archive-maintain).

(v2.0, archive-level compaction) — `state archive-maintain` is the **high-level operator entry** that orchestrates the existing archive primitives in the safe order so an operator runs ONE obvious command instead of remembering (and ordering) the low-level sequence. It mechanizes the "Certifying a repo as bounded" procedure documented under [`state archive-retention`](#state-archive-retention): **recover any pending delete-intent journal → `compact-archive` (all kinds) → `archive-retention` → compact again if a follow-up materialised → re-plan → `validate` → `plan lint`**, then reports the result honestly. It adds **NO new destructive semantics** and **NO new persistent state** — it is a thin orchestration over `compactArchive` / `applyArchiveRetention` and their journal recovery. **Dry-run by default** (read-only, lock-free); `--write` runs the WHOLE orchestration under ONE outer [advisory write lock](#public-codes-top-level-error-envelopes) (`LOCK_HELD` on contention) — never a lock per substep.

**Recovery runs FIRST, before compaction (load-bearing).** A pending delete-intent journal MUST be recovered before any compaction. Compaction is not recovery-first: its readers hide a pending journal's ids from _folding_, but its consolidation would _retire_ a pending **bundle-pair**'s reduced SURVIVOR bundle as "superseded" — after which recovery can never find that survivor again, a permanent wedge (`DELETE_INTENT_RECOVERY_FAILED`). So `archive-maintain --write` recovers the journal first (`journal_recovery` step), then hands the recovery result to `applyArchiveRetention` as `preRecovered` so it does NOT double-recover but STILL defers each recovered `source: both` survivor to the next run (preserving one-bucket-per-id-per-run; a survivor never lands in both `recovered` AND `deleted` the same run). `state archive-retention --write` (which recovers first internally, before its own plan) is unaffected — this ordering hazard is unique to running compaction before retention.

**Why compact-first (after recovery).** Once the journal is healed, compaction runs BEFORE retention so a loose member of a mixed-source pair is folded into a bundle and the pair becomes a uniform bundle pair retention removes atomically THIS run. So **in healthy, compactable cases** `archive-maintain` resolves ordinary mixed-source / `source: both` redundancy in a **single run**, where running the low-level verbs in the wrong order — or `archive-retention` alone — would need a follow-up run. Records it CANNOT make uniform (a `bundle_stale` divergence, an unsupported-platform `fsync`, a partial store view, a missing digest, or a recovered bundle-pair survivor) stay explicitly **not bounded** and are reported with per-record reasons — never silently "resolved".

**Dry-run success shape** (`data.mode === "dry_run"`, exit 0): `data.summary` (current `archive_files` / `loose_records` / `bundles` + `planned_loose_folded` / `planned_loose_deleted` / `planned_drop` / `planned_compact_skipped`), `data.steps` (`journal` = `{ status: "absent"|"present"|"corrupt", pending_before, intent_kinds[], count, plans_are_pre_recovery }` — so the dry-run warns that a `corrupt` journal would FAIL `--write` recovery, names the pending intent kinds (not merely "pending: true"), AND, when a journal is pending, sets `plans_are_pre_recovery: true` because `--write` recovers FIRST (which changes the store) so the `compact` / `retention` plans are CURRENT pre-recovery diagnostics, not the exact post-recovery plan; `compact.plans[]`, `retention.plans[]`, `checks` = validate + plan-lint preview), and `data.bounded_status` (see below). Mutates nothing — no bundle write, no delete, no journal recovery/clear (a dry-run always exits 0).

**`--write` success shape** (`data.mode === "write"`, exit 0 — or **exit 1** if a read-only post-check failed; see below): `data.summary` rolls up the destructive results — `archive_files_before/after`, `loose_records_before/after`, `bundles_before/after`, `deleted`, `bundle_member_removed`, `recovered_loose_pairs`, `recovered_bundle_pairs`, `skipped` (the TOTAL fail-closed skips = `compact_skipped` + `retention_skipped`, both also reported — so `skipped` never hides a compaction skip the way a retention-only count would), `compact_skipped`, `retention_skipped`, `mixed_source_deferred` (the SUM of the two precise deferral counts, kept for back-compat — but NOT all deferrals are "pairs"), `bundle_member_deferred` (a `needs_bundle_member_removal` deferral — also covers an independent bundle record), `atomic_pair_deferred` (a `requires_atomic_pair_removal` deferral — a loose pair held back by an unsupported `fsync` / partial store / missing digest, NOT fixed by `compact-archive`), `source_both_follow_up`. `data.verdict` mirrors the exit verdict INTO the body — `{ exit_code: 0|1, v2_bounded, checks_ok }` — so a consumer reading only stdout JSON sees it (the envelope `ok` is `true` on every success path, even exit 1). `data.steps` is a KEYED object (not an array — so a consumer reads `data.steps.retention.results` by a stable key, never a name search), with the per-step detail: `journal` (`status` / `pending_before` / `intent_kinds` / `count`, plus `recovered[]` tagged by `intent_kind`), `compact_before_retention` (`files_removed`, `bundles_written`, `skipped[]`), `retention` (`results[]` — the same per-kind `{ deleted, bundle_member_removed, recovered, vanished, skipped }` shape as [`state archive-retention --write`](#state-archive-retention)), `compact_after_retention` (`ran`, `reason`, `files_removed`, `bundles_written`, `skipped[]` — runs only when a fresh plan shows foldable loose remains, e.g. a `source: both` survivor), `bounded_status` (`ok` = is the archive v2.0-bounded), and `checks` (`ok` = validate + plan-lint both passed). Each step also carries its own `name`.

Field meanings (the same load-bearing distinctions as the low-level verbs — never conflated):

- **`deleted`** — old truth GONE this run (no copy resolves): a loose unlink, or a bundle-member removal of a record with no surviving loose copy.
- **`bundle_member_removed`** (= `source_both_follow_up`) — a `source: both` record's BUNDLE member was removed but its LOOSE copy still resolves; the loose layer drops it next run (≤ 2-run convergence). **In `archive-maintain` this is normally `0`**: compact-first deletes the loose redundancy BEFORE retention, so a would-drop record is loose-only or bundle-only by the time retention runs.
- **`recovered_loose_pairs` / `recovered_bundle_pairs`** — records COMPLETED from a pending delete-intent journal (a prior crashed pair-delete), recovered FIRST (before any compaction). Kept as TWO fields (never flattened): a loose-pair recovery removed both loose files (fully gone); a bundle-pair recovery retired the bundle members but a `source: both` record's surviving copy may remain. That surviving copy is **excluded from this run's drop** (one bucket per id per run) and dropped on a subsequent run — note it is NOT necessarily still LOOSE: the maintenance compaction pass may re-fold it into a bundle, after which the next run removes it as a bundle member. So read `recovered_bundle_pairs > 0` as "a follow-up run may be needed", not "the survivor is loose".
- **`skipped` / `mixed_source_deferred`** — records NOT removed, per-record reason (fail-closed; never a silent drop). `mixed_source_deferred` counts the `needs_bundle_member_removal` / `requires_atomic_pair_removal` deferrals.

**Bounded-status** (`data.bounded_status`) — the honest, never-over-claiming verdict, derived from a FRESH re-plan of the real on-disk store after the apply (not a projection):

- `file_count_bounded` — the loose tail is folded and no compaction work remains (no foldable loose, no un-foldable `bundle_stale` loose, no superseded bundle to retire). A pending delete-intent journal forces this `false`. The exact drivers are in `file_count_unbounded_reasons` (`would_bundle` / `would_delete` / `would_supersede` / `would_retire_bundles` / `would_skip` / `pending_delete_intent`) — all `0`/`false` ⟺ bounded — so a "not bounded" verdict is never a bare boolean (the human renderer names each non-zero driver).
- `unreferenced_old_truth_bounded` — retention has no `would_drop` record left to remove. A pending journal forces this `false`. Drivers in `unreferenced_old_truth_unbounded_reasons` (`would_drop` / `pending_delete_intent`).
- `referenced_truth_retained` — always `true` (referenced records are kept/blocked, never dropped — by construction).
- `bundle_byte_size_bounded` — **ALWAYS `false`** for v2.0.0. A single bundle's byte size is **not** bounded; `bundle_byte_size_bound_deferred_to` is `"sharding"`. **This is the explicit no-over-claim field**: `archive-maintain` bounds the archive's FILE COUNT and removes UNREFERENCED old truth, but does NOT bound total stored bytes (sharding a large bundle, or a referenced-truth lifetime policy, is later work).

**Exit code.** A maintenance step fault → an error envelope with the SAME code the low-level verb surfaces (`ARCHIVE_BUNDLE_WRITE_FAILED` / `ARCHIVE_BUNDLE_INVALID` / `DELETE_INTENT_RECOVERY_FAILED` / `DELETE_INTENT_DURABILITY_FAILED` / `PENDING_DELETE_INTENT` / `BUNDLE_PAIR_NOT_COMMITTABLE`) plus `data.step` / `data.completed_steps` / `data.partial_applied`, exit 2. Otherwise the maintenance MUTATIONS succeeded → success envelope (`ok: true`); exit is **0** only when the archive is **v2.0-bounded** (`file_count_bounded && unreferenced_old_truth_bounded`) AND the read-only post-checks (`validate` + `plan lint --include-quality --strict`) pass, **1** when the archive is not yet bounded OR a post-check failed. Exit 1 has TWO shapes (read `summary.skipped`): a healthy follow-up (`skipped == 0` — a `source: both` survivor / a recovered bundle-pair survivor) **converges on re-run**; a `skipped > 0` / deferred condition (a `bundle_stale` skip, an unsupported `fsync`, a partial store, an unrecoverable recovery authority) does NOT clear on a blind re-run and must be **inspected** via the per-record reasons. The byte-size NON-goal (`bundle_byte_size_bounded: false`) NEVER makes the exit non-zero — only the bounds the layer actually claims. So a CI that runs only this verb gets a non-zero signal whenever the archive is not yet bounded; the post-checks remain a CONVENIENCE PREVIEW whose authoritative gates are the separate `validate` / `plan lint` runs in the [maintainer checklist](maintainers/operations.md). Config faults (a positional, `--keep-latest 0`/non-integer) → `CONFIG_ERROR` (exit 2). Dry-run is always exit 0 (a read-only preview).

**Mixed-source pair policy** (the load-bearing safety claim). A mixed-source pair (one side has a surviving loose copy, the other does not) is a TRANSIENT mid-refresh artifact, NOT a permanent leak — `archive-maintain`'s compact-first step makes both sides uniform, so the pair is removed as a clean bundle pair the same run. A pair that genuinely cannot be made uniform (a `bundle_stale` divergent record, an unsupported-platform `fsync`) is left in place fail-closed and surfaces as a non-bounded `bounded_status` and a non-empty `skipped` — **never** reported as bounded success.

**PR / branch conflict model** (multi-contributor safety). `archive-maintain` writes **no new tracked file** — no global maintenance ledger, no status/cache file, no timestamps / hostnames / PIDs / absolute paths into archive state. Its only mutation is to `.code-pact/state/archive`, through the existing content-/id-addressed writers (one file per loose record, content-addressed bundles named by the member-id-set hash, with canonical bytes). So two contributors who run it on independent branches over the SAME set of records produce **byte-identical bundle filenames and contents** — it does not introduce a new Git merge hotspot. It does NOT, however, make every independent branch shape auto-merge-conflict-free, and the release claim is narrowed accordingly. Two cases:

- **Different records on each branch → no conflict, re-converges** (proven by `state-archive-maintain.test.ts` "two branches that archive DIFFERENT phases…"): each branch folds its records into a per-kind bundle whose filename is the member-id-set hash, so two branches' bundles have DIFFERENT filenames and a merge adds both files (no Git conflict); a follow-up `archive-maintain` on the merged branch re-consolidates them into one.
- **The SAME phase archived INDEPENDENTLY on two branches → conflicts** (the documented, NOT-claimed-conflict-free case): the phase snapshot carries a `snapshotted_at` minted at archive time, so the two branches produce a same-id record with different bytes — a real merge conflict on the loose snapshot (and, after compaction, on the same-named bundle). This is inherent to the archive layer's per-archive timestamp, NOT introduced OR resolved by `archive-maintain`. Archive each phase once (on one branch) to avoid it.

So the guarantee is precisely: **deterministic output, no new shared-mutable hotspot, and re-convergence on merge for differing records** — NOT "all branch shapes are conflict-free".

## `decision retire`

For usage, flags, and basic examples, see the generated [CLI reference § `decision retire`](cli-reference.generated.md#decision-retire).

(v2.0, design-docs-ephemeral) — `decision retire` retires a decision of **any status**: it writes a decision-state record under `.code-pact/state/archive/decisions/<stem>-<hash8>.json`, then deletes the `design/decisions/**/*.md`. **Dry-run by default.** Unlike [`decision prune`](#decision-prune) (accepted-only, appends `PRUNED.md`, rewrites inbound links), `decision retire` accepts any status, writes **no** `PRUNED.md` row, and rewrites **no** inbound links — a link to the deleted `.md` resolves as _retired_ via the record, so `check:docs` stays green (see the [doc-link checker](maintainers/docs-maintenance.md)). An **accepted** record `may_satisfy_active_gate`; a non-accepted record is a tombstone that **never** releases a gate. See the [`DECISION_RETIRE_*` error codes](#public-codes-top-level-error-envelopes).

**Eligibility.** It refuses ([`DECISION_RETIRE_NOT_ELIGIBLE`](#public-codes-top-level-error-envelopes), exit 2) when an active task still needs the decision in a way the record cannot carry: a **non-accepted `decision_refs` gate**, or **any filename-scan gate** (a gated task with no explicit `decision_refs` has no canonical key to look up, so a record can never carry it — migrate to explicit `decision_refs` first). An `acceptance_refs` is carried by a valid record **only when it points at a `.md` decision record under `design/decisions/`**; an `acceptance_refs` to a non-decision target (e.g. `docs/cli-contract.md`) stays strict and blocks the retire. Integrity gates (open commitments, a live decision dependant, an unreadable scan) also refuse.

Dry-run success envelope (`--json`):

```json
{
  "ok": true,
  "data": {
    "kind": "would_retire",
    "decision": "design/decisions/sample-rfc.md",
    "record_path": "<repo>/.code-pact/state/archive/decisions/sample-rfc-c6e532a1.json",
    "record_action": "write"
  }
}
```

`--write` success envelope (same shape; `kind` → `"retired"`, `record_action` is the real outcome):

```json
{
  "ok": true,
  "data": {
    "kind": "retired",
    "decision": "design/decisions/sample-rfc.md",
    "record_path": "<repo>/.code-pact/state/archive/decisions/sample-rfc-c6e532a1.json",
    "record_action": "write"
  }
}
```

`--write` writes the record under the advisory write lock, readback-verifies it, re-checks the **full external state** (the same eligibility minus the not-accepted check) on current disk immediately before the delete — so an active gate that appeared in the write→delete window aborts with [`DECISION_RETIRE_STALE`](#public-codes-top-level-error-envelopes) (`data.reason`, e.g. `gate_would_orphan`) and **the `.md` is never deleted**. It re-checks the `.md`'s identity (a symlink final/ancestor component, an inode/dev swap, or a content change since baseline all refuse), then deletes the `.md` **last**. The `--write` envelope has the **same shape** as the dry-run one, but `kind` becomes `"retired"` and `record_action` reports the **actual** write outcome — `"write"` or `"noop"` (it never reports the dry-run-only preview value `"refresh"`; a planned `refresh` applies as `"write"`). A truly-absent `.md` with **no valid record** is `DECISION_RETIRE_NOT_RETIRED` (a broken state, not "already retired"), exit 2.

## `task runbook` — read-only guidance for a single task (v1.3+, P12)

`code-pact task runbook <task-id> [--json]` returns a deterministic list of next recommended steps for one task. Stability: **Stable (v1.3+)**.

The command is **read-only**. It emits command strings the user (or an agent) runs separately, or a `manual_action` describing a human checkpoint. There is no `--write` flag, no `--execute` flag, no `--agent` flag — runbook is sequencing guidance, not orchestration. Agent choice belongs to whichever command in the recommended sequence needs an adapter (e.g. `code-pact task context <id> --agent claude-code`).

The command **never** writes to the progress ledger, **never** writes to `design/`, and **never** calls an adapter. It only reads the roadmap, phase YAMLs, and the progress ledger.

### Step generation

Runbook maps `(derived state, design status, drift kind)` → recommended steps using these classifiers:

- `deriveTaskState` from `src/core/progress/task-state.ts` — current state in {planned, started, blocked, resumed, done, failed}
- `classifyTaskDrift` from `src/core/plan/analyze.ts` — drift kind when design and progress disagree
- `resolveDependsOnStates` from `src/core/runbook/depends-on.ts` — per-dependency current state

Mapping table:

| Derived             | Design                | Drift kind                                          | Steps                                                                                  |
| ------------------- | --------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| planned (no events) | planned / in_progress | (none)                                              | `task start` → `task context` → manual implement → `task complete`                     |
| started / resumed   | planned / in_progress | (none)                                              | continue implementation → `task complete`                                              |
| blocked             | planned / in_progress | (none)                                              | manual_action (resolve blocker) → `task resume --reason "..."` — both `blocking: true` |
| failed              | planned / in_progress | (none)                                              | manual_review (diagnose + fix) → `task complete` (re-run)                              |
| done                | planned / in_progress | done-but-design-not-done                            | `task finalize --write` with dry-run safety note                                       |
| done                | done                  | (none)                                              | empty `next_steps` (consistent)                                                        |
| done                | done                  | done-blocked-conflict / done-with-incomplete-events | manual_review pointing at `plan analyze` (blocking)                                    |
| done                | done                  | done-historical                                     | empty `next_steps` (hidden by default)                                                 |

`depends_on` adds a blocking `manual_action` step at the head whenever any dependency's derived state is not `done`.

### JSON envelope (success)

```json
{
  "ok": true,
  "data": {
    "kind": "runbook",
    "task_id": "P9-T5",
    "phase_id": "P9",
    "state_summary": {
      "design_status": "planned",
      "derived_state": "done",
      "drift_kind": "done-but-design-not-done",
      "depends_on": [
        { "task_id": "P9-T4", "current": "done", "satisfied": true }
      ],
      "acceptance_refs_check": [
        { "path": "docs/cli-contract.md", "exists": true }
      ],
      "declared_writes": ["src/commands/task-runbook.ts"],
      "decision_refs": ["design/decisions/lightweight-runbook-rfc.md"]
    },
    "next_steps": [
      {
        "command": "code-pact task finalize P9-T5 --write",
        "manual_action": null,
        "reason": "Task is done in the progress ledger but design status is still planned/in_progress. `task finalize` is the deterministic resolver.",
        "blocking": false,
        "safety_note": "This is a --write operation. Preview first with `code-pact task finalize P9-T5 --json` (dry-run).",
        "expected_result": "design/phases/<phase>.yaml task status flips to done; STATUS_DRIFT done-but-design-not-done clears on next plan analyze."
      }
    ]
  }
}
```

### `RunbookStep` field invariants

Every step in `next_steps[]` has all six fields present in JSON output, with `null` where not applicable. **Exactly one of `command` / `manual_action` is non-null** — never both, never neither. JSON consumers can assume the schema is constant across step kinds and need no field-absence branching.

| Field             | Type             | When non-null                                                               |
| ----------------- | ---------------- | --------------------------------------------------------------------------- |
| `command`         | `string \| null` | Step is a CLI invocation the user runs verbatim                             |
| `manual_action`   | `string \| null` | Step is a human checkpoint with no command                                  |
| `reason`          | `string`         | Always required                                                             |
| `blocking`        | `boolean`        | Always present; `true` means downstream steps assume this is resolved first |
| `safety_note`     | `string \| null` | Non-null for `--write` steps and similar safety concerns                    |
| `expected_result` | `string \| null` | Non-null when a deterministic post-step state is known                      |

### Errors

No new error codes. Reused:

| Code                | Exit | When                                                                        |
| ------------------- | ---- | --------------------------------------------------------------------------- |
| `TASK_NOT_FOUND`    | 2    | Task id is not present in any phase                                         |
| `AMBIGUOUS_TASK_ID` | 2    | Task id appears in more than one phase; `data.phases[]` lists the offenders |
| `CONFIG_ERROR`      | 2    | Missing positional task id, or unknown flag                                 |

### Relationship to `recommend`

`recommend` and `task runbook` are intended to coexist:

- **`recommend`** answers: **"How should this task be executed?"** — model tier, effort, context profile, preflight commands, ambiguity action, budget profile.
- **`task runbook`** answers: **"What should happen next in the task lifecycle?"** — the sequence of `task start` / `task context` / implementation / `task complete` / `task finalize` etc., gated by `depends_on` and drift state.

Both take a task id; neither calls the other. Bundling them is an open question deferred to P13.

### Usage example

See the generated [CLI reference § `task runbook`](cli-reference.generated.md).

## `phase runbook` — read-only guidance for an entire phase (v1.3+, P12)

For usage, flags, and basic examples, see the generated [CLI reference § `phase runbook`](cli-reference.generated.md#phase-runbook).

`phase runbook` returns a deterministic list of next recommended steps for an entire phase. Stability: **Stable (v1.3+)**.

Mirrors `task runbook` at phase level. The command is **read-only**: every recommended step is a CLI invocation the user runs separately, or a `manual_action` describing a human checkpoint. There is no `--write`, no `--execute`, no `--agent` flag, and no multi-phase `--all`.

The command **never** writes to the progress ledger, **never** writes to `design/` (including `design/roadmap.yaml`), and **never** flips the phase's own `status` field. The `phase_status_candidate` reported in `phase_summary` is advisory only — consistent with the v1.2 `phase reconcile` contract.

### Step priority order

For each phase, runbook iterates `phase.tasks[]` and emits steps in this priority order:

1. **Blocked tasks — resume guidance** (`blocking: true`). For each `blocked` task, emit one `manual_action` step describing blocker resolution + a `task resume <id> --reason "..."` command step.
2. **Failed / complex-drift tasks — manual_review** (`blocking: true`). For `failed` state or `done-blocked-conflict` / `done-with-incomplete-events` drift, emit a `manual_action` step pointing at `plan analyze`. These drifts need human judgement; `phase reconcile` intentionally refuses them.
3. **Eligible reconcile batch** (non-blocking). If at least one task is a `flip` candidate, emit exactly one `phase reconcile <id> --write` step. Per-task `task finalize` enumeration is intentionally avoided — reconcile's atomic batch is the whole point.
4. **In-progress task hints** (non-blocking). For each `started` / `resumed` task, emit one `task runbook <task-id>` step. Per-task judgement is delegated to `task runbook`.
5. **Untouched ready tasks** (non-blocking). For each `planned` task with no events AND all `depends_on` satisfied, emit the four-step ready-task sequence: `task start <id>` → `task context <id>` → manual implement → `task complete <id>`. This is the runbook's **Stable (v1.3+)** command output and is intentionally unchanged; `task prepare` is the recommended modern entry point when a human or agent starts work directly (it bundles `task context`), but the runbook keeps emitting `task context` so its `next_steps[].command` strings stay contract-stable.
6. **Phase-status advisory** (non-blocking, `manual_action`). If every task would be `done` post-reconcile and the phase itself isn't already `done`, surface the manual phase-status flip as the final step.

### JSON envelope (success)

```json
{
  "ok": true,
  "data": {
    "kind": "runbook",
    "phase_id": "P12",
    "phase_summary": {
      "task_histogram": {
        "planned": 1,
        "started": 1,
        "blocked": 0,
        "resumed": 0,
        "done": 3,
        "failed": 0
      },
      "drift_histogram": {
        "done-but-design-not-done": 2,
        "manual_review": 0,
        "consistent": 4
      },
      "phase_status_candidate": "in_progress",
      "phase_status_note": "advisory — phase status is never written by phase runbook (or by phase reconcile)"
    },
    "next_steps": [
      {
        "command": "code-pact phase reconcile P12 --write",
        "manual_action": null,
        "reason": "2 task(s) (P12-T1, P12-T2) are done in the progress ledger but design status is still planned/in_progress. `phase reconcile --write` flips them in one atomic batch.",
        "blocking": false,
        "safety_note": "This is a --write operation. Preview first with `code-pact phase reconcile P12 --json` (dry-run).",
        "expected_result": "design/phases/<phase>.yaml task statuses flip planned → done; STATUS_DRIFT done-but-design-not-done clears for each task."
      }
    ]
  }
}
```

`RunbookStep` field invariants are identical to `task runbook` — every field present, exactly one of `command` / `manual_action` non-null. See the `task runbook` section for the field-presence table.

### Errors

Reuses existing codes; phase-id resolution additionally surfaces
`AMBIGUOUS_PHASE_ID`. For `phase runbook <id>` it fires
when the requested id is duplicated; for `--across-phases`, when an _included_
phase id is duplicated during aggregation:

| Code                 | Exit | When                                                                                                  |
| -------------------- | ---- | ----------------------------------------------------------------------------------------------------- |
| `PHASE_NOT_FOUND`    | 2    | Phase id is not present in `design/roadmap.yaml`                                                      |
| `AMBIGUOUS_PHASE_ID` | 2    | The phase id appears in more than one `roadmap.yaml` entry; `data.phases[]` lists the colliding files |
| `CONFIG_ERROR`       | 2    | Missing positional phase id, or unknown flag                                                          |

### Usage example

See the generated [CLI reference § `phase runbook`](cli-reference.generated.md#phase-runbook). Recommended release-prep pattern: inspect the runbook before applying `phase reconcile --write`.

### `--across-phases` (v1.9+, P19)

`phase runbook --across-phases` aggregates per-phase runbook steps across every phase in scope. **No `<phase-id>` positional argument is used in this mode.**

Inclusion rules:

- `phase.status === "in_progress"` — always included.
- Phases that DECLARE a task referenced (via `depends_on`) by an in_progress phase task with derived state != done — pulled in via one level of transitive closure.

Phases with status `done`, `planned`, or `cancelled` are excluded unless pulled in via the dep-driven rule. Order: phase id ascending.

**JSON envelope (success):**

```json
{
  "ok": true,
  "data": {
    "kind": "aggregated_runbook",
    "phases_considered": ["P15", "P19"],
    "phases": [
      { "kind": "runbook", "phase_id": "P15", "phase_summary": { ... }, "next_steps": [...] },
      { "kind": "runbook", "phase_id": "P19", "phase_summary": { ... }, "next_steps": [...] }
    ]
  }
}
```

The `phases: PhaseRunbookResult[]` re-uses the existing per-phase shape — each entry is exactly what `phase runbook <id>` would return on its own.

Default `phase runbook <phase-id>` invocation is **unchanged** — `--across-phases` is purely additive.

### Cross-phase `depends_on` (v1.9+, P19)

A task's `depends_on` may reference a task in a different phase (e.g. `["P15-T5"]` from inside `P19-T1`). The resolver looks same-phase first, cross-phase fallback. Ids that do not appear in any phase still fire `TASK_DEPENDS_ON_UNRESOLVED`.

When a dep resolves to a foreign phase, the runbook's `state_summary.depends_on[i]` JSON envelope entry gains an additive `phase_id` field; same-phase deps omit it. Human-mode output names the foreign phase inline.

Multi-node cycles (length ≥ 2) surface as `TASK_DEPENDS_ON_CYCLE` (error). Self-cycles keep the narrower `TASK_DEPENDS_ON_SELF_REFERENCE`. See [Plan diagnostic codes](#plan-diagnostic-codes).

## `task start` / `task status` / `task block` / `task resume` (v0.6)

These four commands fill the execution-state gap between `task context` and `task complete`. They all read the same progress ledger used by `task complete` and record events to it — one new file per event under `.code-pact/state/events/` (the legacy `.code-pact/state/progress.yaml` is read-merged for compatibility but is no longer written) — and they share the same state-machine rules enforced via `deriveTaskState` and `assertTransition`.

**Allowed transitions:**

```
planned   → started
started   → blocked | done | failed
blocked   → resumed | failed
resumed   → blocked | done | failed
done      → terminal
failed    → started   (internal retry path, not user-facing in v0.6)
```

Any disallowed transition exits 2 with `INVALID_TASK_TRANSITION` and records no progress event.

### `task start <task-id> [--agent <name>] [--json]`

Records a `started` event. Validates `--agent` against `project.yaml` (defaults to `default_agent` when omitted) and emits the standard `AGENT_NOT_FOUND` / `AGENT_NOT_ENABLED` errors.

Idempotency: if the current state is already `started`, the command exits 0 with `{ ok: true, data: { already_started: true, ... } }` and records no progress event.

### `task status <task-id> [--json]`

**Pure read.** Does not accept `--agent` and does not validate agent configuration, so it can be invoked from CI, monitoring, or by a human reviewer without project agent setup. Resolves the task to its phase and returns the derived current state plus the full event history for the task.

JSON envelope:

```json
{
  "ok": true,
  "data": {
    "task_id": "P1-T1",
    "phase_id": "P1",
    "current": "blocked",
    "last_event": {
      "task_id": "P1-T1",
      "status": "blocked",
      "at": "...",
      "actor": "agent",
      "agent": "claude-code",
      "author": "Ada Lovelace",
      "reason": "..."
    },
    "history": [
      /* full chronological history for this task */
    ]
  }
}
```

`current` is one of `planned | started | blocked | resumed | done | failed`. `last_event` and `history` reflect only events whose `task_id` matches.

### `task block <task-id> --reason "<text>" [--agent <name>] [--json]`

Records a `blocked` event. `--reason` is **required** at the CLI layer and stored in the new `ProgressEvent.reason` field (distinct from `notes`, which remains a free-form memo). An empty or whitespace-only reason raises `CONFIG_ERROR` (exit 2). The schema also enforces non-empty `reason` for blocked events via `superRefine`, so the ledger stays honest even under hand-editing.

Allowed only from `started` or `resumed`. Block from `planned`, `blocked`, or `done` returns `INVALID_TASK_TRANSITION` (exit 2).

### `task resume <task-id> [--agent <name>] [--json]`

Records a `resumed` event. Allowed only from `blocked` — any other current state returns `INVALID_TASK_TRANSITION` (exit 2).

## `status` — team activity overview (v1.32+, Collaboration UX RFC D2/D3)

`code-pact status [--json] [--phase <id>] [--mine]`. **Pure read** — no `--agent`, no agent config, no writes, no lock. Aggregates the derived state of every task and answers the sit-down questions: _what is in flight (by whom), what is blocked (why/by whom), what is free to pick up — and, for what isn't, why._ It is an **activity** view, not a structural-diagnostics aggregator: `DUPLICATE_*` / `PHASE_ID_MISMATCH` stay with `doctor` / `plan lint`. It **never reserves or locks** a task — it surfaces overlap so humans coordinate; two people picking the same task is made _visible_, not _prevented_ (if both proceed, `PROGRESS_EVENT_CONFLICT` catches it).

JSON envelope:

```json
{
  "ok": true,
  "data": {
    "filter": { "mine": false },
    "in_flight": [
      {
        "task_id": "P3-T2",
        "phase_id": "P3",
        "since": "2026-06-05T…Z",
        "author": "Ada"
      }
    ],
    "blocked": [
      {
        "task_id": "P4-T1",
        "phase_id": "P4",
        "reason": "waiting on infra",
        "author": "Bo",
        "since": "…"
      }
    ],
    "available": [{ "task_id": "P3-T3", "phase_id": "P3" }],
    "waiting": [
      {
        "task_id": "P4-T2",
        "phase_id": "P4",
        "reasons": [
          { "code": "WAITING_FOR_DEPENDENCY", "task_id": "P3-T1" },
          {
            "code": "MISSING_DECISION",
            "decision_ref": "design/decisions/x.md"
          }
        ]
      }
    ],
    "conflicts": [
      {
        "task_id": "P3-T2",
        "code": "PROGRESS_EVENT_CONFLICT",
        "details": {
          "events": [
            {
              "event_id": "…",
              "status": "done",
              "author": "Ada",
              "at": "2026-06-05T…Z"
            },
            {
              "event_id": "…",
              "status": "done",
              "author": "Bo",
              "at": "2026-06-05T…Z"
            }
          ]
        }
      }
    ],
    "totals": {
      "tasks": 12,
      "by_state": {
        "planned": 5,
        "started": 2,
        "resumed": 0,
        "blocked": 1,
        "done": 4,
        "failed": 0
      }
    }
  }
}
```

- **`in_flight`** — derived `started` / `resumed` (not `done`); `author` / `since` from the latest state-advancing event (D1).
- **`blocked`** — derived `blocked`, with the `reason` (required on `blocked` events), `author`, `since`.
- **`available`** — a `planned`, not-started task that is **ready to pick up**: `depends_on` all `done`, and — if `requires_decision` — an **accepted** decision exists (the shared status-aware gate, as in `verify` / `task record-done`).
- **`waiting`** — a `planned` task that is **not** ready, with **`reasons[]`** (`code` ∈ `WAITING_FOR_DEPENDENCY` (+`task_id`) / `MISSING_DECISION` (+`decision_ref`)). These are **status reason codes**, not error codes — they never become a top-level `error.code` and never affect exit. Every planned task is in exactly one of `available` / `waiting`. `MISSING_DECISION.decision_ref` names the **actually-blocking** ADR (`decision_refs` is all-must-be-accepted, so it is the first _non-accepted_ one, not necessarily `decision_refs[0]`). `status` **collapses any unresolved decision gate into `MISSING_DECISION`** — it does **not** expose structural sub-reasons (e.g. an `unsafe_path` `decision_refs` entry); for those, run `doctor` / `plan lint` / `verify`. When the blocker is a structurally-invalid path, `decision_ref` is **omitted** (a dangerous path is never surfaced as "the ADR to fix"); it is also omitted when no ADR was considered (filename-scan with no match).
- **`conflicts`** (v1.32+, D3) — always present (a healthy project gets `[]`). **`PROGRESS_EVENT_CONFLICT` only** — a task whose merged events form a sequence no single writer would (a second `started`, a `done` after `done`, an event after a terminal `done`), what two branches merging can produce. Each entry carries the structured **`details.events[]`** naming the conflicting side(s) — `{ event_id, status, author?, at }` (usually two: the establishing event and the offender; one when the first event for a task is itself invalid) — the **same shape** the `plan analyze` / `doctor` surfaces emit, so an agent reads _who_ collided without parsing prose (`author` omitted per-event for legacy / capture-off events). `event_id` is the **content id**, the _suffix_ of a per-event filename `.code-pact/state/events/<at-compact>-<event_id>.yaml` (locate it with `.code-pact/state/events/*-<event_id>.yaml` — it is **not** the whole filename); for an event that lives only in a legacy `.code-pact/state/progress.yaml` there is **no** per-event file (reconcile the matching `progress.yaml` entry, or migrate it). One entry per conflicting task (the first divergence). Scoped to the selected tasks (narrowed by `--phase`) and reported at **scope level like `totals` — NOT narrowed by `--mine`** (a conflict is inherently multi-author and a safety signal; hiding one you are a party to would be unsafe). Structural id conflicts (`DUPLICATE_*` / `PHASE_ID_MISMATCH`) are **not** here — they stay with `doctor` / `plan lint`. In human output the section is printed **first and only when non-empty**, so a healthy run stays calm.
- **`totals.by_state`** counts every derived `TaskCurrentState` (`done` / `failed` are counted but not bucketed). `totals` always reflects the **selected scope** (the whole project, or the single phase under `--phase`), **not** the `--mine`-filtered subset.
- **`filter`** — always present. `--mine` narrows only the four **activity** buckets: it filters `in_flight` + `blocked` to your resolved author identity (D1 — `CODE_PACT_AUTHOR`, else `git config user.name`) and empties `available` / `waiting` (unauthored suggestions). `conflicts` and `totals` are **scope-level** and are **never** narrowed by `--mine` (a conflict is a multi-author safety signal — see the `conflicts` bullet). Shapes: `{ "mine": false }`; `{ "mine": true, "supported": true, "author": "Ada" }`; or, when identity can't drive the filter, `{ "mine": true, "supported": false, "reason": "AUTHOR_CAPTURE_DISABLED" | "AUTHOR_UNAVAILABLE" }` with the **four activity buckets empty** (can't-filter ≠ no-work) — `conflicts` still reflects the selected scope. `AUTHOR_CAPTURE_DISABLED` = `collaboration.author: off`; `AUTHOR_UNAVAILABLE` = no identity resolved.

`--phase <id>` restricts to one phase, resolved through the shared phase resolver: an unknown id → `PHASE_NOT_FOUND` (exit 2); a **duplicate** phase id **fails closed** with `AMBIGUOUS_PHASE_ID` (exit 2) and `data.phases[]` listing the colliding files (never a silent union). `--help` / `-h` / `help` print usage and exit 0. Argument errors are **fail-closed** as `CONFIG_ERROR` (exit 2): an unknown flag, a stray positional, or a value-less `--phase` does **not** silently degrade to a whole-project run. Otherwise the command exits 0 on success and has no failure/exit semantics of its own (a corrupt roadmap / phase / ledger follows the existing strict-reader behavior — exit 3).

> **`conflicts[]` and the activity buckets ship together in v1.32.0.** The Collaboration UX RFC decomposed the work into phases — D2 (the four activity buckets) and D3 (`data.conflicts[]`, added once D1 attribution could populate the "who") — but `code-pact status` is new in v1.32.0, so both land in the same release. `conflicts` is additive: a consumer that ignores unknown keys is unaffected. The `details.events[]` shape is shared with the `plan analyze` / `doctor` `PROGRESS_EVENT_CONFLICT` surfaces — see § Plan diagnostic codes.

## `recommend` (v0.8)

`code-pact recommend --phase <id> --task <id> [--agent <name>] [--json]` returns a deterministic execution plan for a given task — model tier, effort, context profile, planning posture, escalation order, preflight commands, a categorical budget profile, and (additively, P48) a recommended context budget profile (`contextFit`) — based on Task metadata (`type`, `ambiguity`, `risk`, `context_size`, `write_surface`, `verification_strength`, `expected_duration`, `requires_decision`).

Since v1.11, `task prepare` is the primary per-task entry point for the agent-facing loop and embeds this recommendation in its response. Call `recommend` directly when you need to inspect the deterministic recommendation in isolation, debug recommendation inputs, or support an older/manual loop — then use its output to decide what to load, how hard to think, and what to verify before implementation. It is read-only and does not fetch or write the context pack.

Read-only. The command does not mutate any state.

**JSON shape:**

All field names are camelCase. Enum / identifier values are snake_case where applicable (matches existing `model_map` keys like `highest_reasoning`).

```json
{
  "ok": true,
  "data": {
    "phaseId": "P6",
    "taskId": "P6-T1",
    "agentName": "claude-code",
    "tier": "highest_reasoning",
    "effort": "high",
    "modelId": "claude-opus-4-8",
    "reasons": ["task type is architecture"],

    "contextProfile": "large",
    "verificationProfile": "strong",
    "planningRequired": true,
    "ambiguityAction": "clarify_before_implementation",
    "allowedEscalation": ["increase_context", "ask_human"],
    "preflight": [
      {
        "id": "plan_lint",
        "command": "plan lint",
        "argv": ["plan", "lint", "--json"],
        "displayCommand": "code-pact plan lint --json",
        "reason": "planning_required",
        "required": false
      },
      {
        "id": "plan_analyze",
        "command": "plan analyze",
        "argv": ["plan", "analyze", "--json"],
        "displayCommand": "code-pact plan analyze --json",
        "reason": "planning_required",
        "required": false
      }
    ],
    "budgetProfile": {
      "toolCalls": "medium",
      "contextFiles": "many",
      "verificationCommands": "full"
    },
    "structuredReasons": [
      {
        "factor": "type",
        "value": "architecture",
        "effect": "tier=highest_reasoning"
      }
    ],
    "lifecycleMode": "full_loop",
    "contextFit": {
      "recommendedProfile": "wide",
      "recommendedBudgetBytes": 120000,
      "reason": "context_size=large -> wide; bytes from built-in fallback"
    }
  }
}
```

The output is zod-validated before return. The contract uses strict mode at every level, so accidental snake_case drift (e.g. `planning_required` next to `planningRequired`) fails loudly instead of producing a silent split contract.

### Field reference

**Existing fields (preserved from earlier versions):**

| Field       | Type     | Notes                                                                                       |
| ----------- | -------- | ------------------------------------------------------------------------------------------- |
| `phaseId`   | string   | Phase ID as passed in `--phase`.                                                            |
| `taskId`    | string   | Task ID as passed in `--task`.                                                              |
| `agentName` | string   | Agent name as passed in `--agent` (defaults to `claude-code`).                              |
| `tier`      | enum     | `highest_reasoning` \| `balanced_coding` \| `cheap_mechanical`. From `recommendTier(task)`. |
| `effort`    | enum     | `low` \| `medium` \| `high`. Tier-dependent.                                                |
| `modelId`   | string   | Concrete vendor model ID resolved via `AgentProfile.model_map[tier]`.                       |
| `reasons`   | string[] | Human-readable rationale strings for the tier choice. Always at least one entry.            |

**v0.8 additive fields:**

| Field                 | Type                                                                | Trigger                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contextProfile`      | `small` \| `medium` \| `large`                                      | Pass-through of `context_size`, bumped up one notch when `ambiguity == high`.                                                                                                                                                                                                        |
| `verificationProfile` | `weak` \| `medium` \| `strong`                                      | Pass-through of `verification_strength`.                                                                                                                                                                                                                                             |
| `planningRequired`    | boolean                                                             | True for `type == architecture`, `ambiguity in {medium, high}`, `risk == high`, or `requires_decision == true`.                                                                                                                                                                      |
| `ambiguityAction`     | `proceed` \| `clarify_before_implementation` \| `split_recommended` | Top-down: `requires_decision == true` → clarify; `ambiguity == high` → clarify; `ambiguity == medium && risk == high` → clarify; `expected_duration == long && write_surface == high && ambiguity == medium && risk != high` → split; else proceed.                                  |
| `allowedEscalation`   | EscalationStep[]                                                    | Tier-driven ordered list of escalation hints. `cheap_mechanical` → `[increase_effort, increase_context, escalate_tier]`; `balanced_coding` → `[increase_context, increase_effort, escalate_tier, ask_human]`; `highest_reasoning` → `[increase_context, ask_human]` (no tier above). |
| `preflight`           | PreflightEntry[]                                                    | Suggested commands to run **before** implementation. Capped at 3 entries. v0.8 emits, in order: `plan lint` and `plan analyze` when `planningRequired == true`; `task status <id>` when `task.status == "in_progress"`. Agent decides whether to run them.                           |
| `budgetProfile`       | BudgetProfile                                                       | Three categorical magnitudes — **not** token / cost / time estimates. See below.                                                                                                                                                                                                     |
| `structuredReasons`   | StructuredReason[]                                                  | Machine-readable mirror of `reasons[]`. Each entry pairs one Task factor with one effect on the output. Always at least one entry.                                                                                                                                                   |

**P33 additive field:**

| Field           | Type                                            | Trigger                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lifecycleMode` | `full_loop` \| `record_only` \| `decision_loop` | The recommended loop for this task (advisory; code-pact's own loop behavior is unchanged). Deterministic switch: `decision_loop` when the task or its phase `requires_decision`; else `record_only` when `type ∈ {docs, test}` AND `ambiguity == low` AND `risk == low` AND `verification_strength == strong`; else `full_loop`. `record_only` means a lighter _loop_ (implement, run verification, then `task record-done`), **not** lighter verification. |

**P48 additive field (Context Fit, layer b):**

| Field        | Type                               | Trigger                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contextFit` | ContextFitRecommendation \| absent | A **recommended** standard context budget profile, derived deterministically from `context_size` / `ambiguity` / `write_surface`. **Optional and additive** — absent on `recommendation: null` early-return states and on existing V2 consumers. It is a _suggestion_, **not** auto-applied: re-sizing the pack stays explicit via [`--context-budget <profile>`](#--context-budget-profile-v130-p47). |

`contextFit` is distinct from `budgetProfile`: `budgetProfile` is a categorical tool-call / context-file / verification magnitude, while `contextFit` names a byte-valued _budget_ profile. Context Fit does not overload `budgetProfile`. No network, model, or tokenizer is consulted to compute it.

**ContextFitRecommendation shape:**

| Field                    | Type                            | Decision rule                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `recommendedProfile`     | `tight` \| `balanced` \| `wide` | A **closed enum** of the three standard names. `context_size == large` OR `ambiguity == high` OR `write_surface == high` → `wide`; else `context_size == medium` → `balanced`; else `tight`. `requires_decision` does **not** shrink it. Custom agent-profile profile names (a `--context-budget` resolution concern only) are **never** emitted here. |
| `recommendedBudgetBytes` | positive integer                | The profile's byte cap: an agent profile's same-named `context_budget.profiles[<profile>].max_bytes` **override** when present, else the built-in fallback (`tight` 30000, `balanced` 60000, `wide` 120000).                                                                                                                                           |
| `reason`                 | string                          | One line recording the driving signal and which byte source was used (e.g. `context_size=medium -> balanced; bytes from built-in fallback`).                                                                                                                                                                                                           |

**PreflightEntry shape:**

| Field            | Type     | Notes                                                                      |
| ---------------- | -------- | -------------------------------------------------------------------------- |
| `id`             | string   | Stable identifier (`plan_lint`, `plan_analyze`, `task_status` in v0.8).    |
| `command`        | string   | Human-readable command name.                                               |
| `argv`           | string[] | argv tail to pass to `code-pact`.                                          |
| `displayCommand` | string   | Full command string for human display.                                     |
| `reason`         | string   | Why this entry was emitted (e.g. `planning_required`, `task_in_progress`). |
| `required`       | boolean  | Always `false` in v0.8 — preflight is advisory, never mandatory.           |

**BudgetProfile shape:**

| Field                  | Type                              | Decision rule                                                                                                                                   |
| ---------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolCalls`            | `low` \| `medium` \| `high`       | `high` if `write_surface == high` OR `expected_duration == long`; `low` if `write_surface == low` (and not the high case above); else `medium`. |
| `contextFiles`         | `few` \| `several` \| `many`      | `small` → `few`; `medium` → `several`; `large` → `many` (mapped from `context_size`).                                                           |
| `verificationCommands` | `minimal` \| `standard` \| `full` | Pass-through of `verification_strength` (`weak` → `minimal`; `medium` → `standard`; `strong` → `full`).                                         |

`budgetProfile` is intentionally **categorical**, not numeric. It is a relative-magnitude hint, not an estimate of actual tokens, cost, or time. Provider-side token estimation is out of scope for v0.8.

**StructuredReason shape:**

| Field    | Type   | Notes                                                                                                                                |
| -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `factor` | string | Task factor that influenced the output (e.g. `type`, `ambiguity`, `requires_decision`).                                              |
| `value`  | string | Observed value of that factor (e.g. `architecture`, `high`, `true`).                                                                 |
| `effect` | string | The output property it drove (e.g. `tier=highest_reasoning`, `planning_required`, `ambiguity_action=clarify_before_implementation`). |

**Exit codes:**

- `0` — success
- `2` — missing `--phase` / `--task`, or unknown phase / task / agent

**Error codes:** `PHASE_NOT_FOUND`, `AMBIGUOUS_PHASE_ID` (duplicate phase id; `data.phases[]` lists the colliding files), `TASK_NOT_FOUND`, `AGENT_NOT_FOUND`, `CONFIG_ERROR`.

## Locale resolution

The active locale is resolved in this priority order:

1. `--locale <code>` flag on the command line
2. `CODE_PACT_LOCALE` environment variable
3. `locale` field in `.code-pact/project.yaml` (read when the project has already been initialized; errors are silently ignored)
4. `LANG` environment variable (checked for a `ja` prefix → `ja-JP`)
5. Default: `en-US`

This means that once a project is initialized with `ja-JP`, all subsequent commands automatically use Japanese without requiring `--locale` or environment variables.

## State file write guarantees

`code-pact` writes a small, well-defined set of state, design, adapter, and regenerable artifact files into the project tree. Every file-content write **listed in the table below** goes through the same atomic primitive, so an interrupted process cannot leave a half-written managed file behind. (Three operations are deliberately outside this guarantee and documented below: directory creation — e.g. an adapter making the `context_dir` — is a separate `mkdir` with no half-written-directory risk; the advisory write lock uses exclusive file creation (`flag: "wx"`) rather than `atomicWriteText`; and `decision prune --write` **deletes** a decision record with `unlink` — a removal, not a content write, so there is no half-written file to guard, and it is ordered last so the deletion only runs after the tombstone row and link rewrites are committed.)

### Files written by `code-pact`

| Path                                                                                                              | Written by                                                                                                                                                                       | Frequency                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.code-pact/project.yaml`                                                                                         | `init`                                                                                                                                                                           | Once at project bootstrap                                                                                                                                                                                                                                                                                                                                                                           |
| `.code-pact/agent-profiles/<agent>.yaml`                                                                          | `init`                                                                                                                                                                           | The default profile, created once at bootstrap                                                                                                                                                                                                                                                                                                                                                      |
| `.code-pact/<agents[].profile>` (default: `agent-profiles/<agent>.yaml`)                                          | `adapter install`, `adapter upgrade --write`, `--model` pinning                                                                                                                  | Reads/writes the profile path configured in `project.yaml`; refreshed when adapter profile fields change                                                                                                                                                                                                                                                                                            |
| `.code-pact/model-profiles/*.yaml`                                                                                | `init`                                                                                                                                                                           | Once at bootstrap (default tier templates)                                                                                                                                                                                                                                                                                                                                                          |
| `.code-pact/state/events/<at>-<id>.yaml` (progress ledger)                                                        | `task start` / `task block` / `task resume` / `task complete` / `task record-done`                                                                                               | One new event file per state transition (the legacy `.code-pact/state/progress.yaml` is read-merged for compatibility but no longer written)                                                                                                                                                                                                                                                        |
| `.code-pact/state/baselines/*.json`                                                                               | `init`, future baseline commands                                                                                                                                                 | Once at bootstrap (`initial.json`)                                                                                                                                                                                                                                                                                                                                                                  |
| `.code-pact/adapters/<agent>.manifest.yaml`                                                                       | `adapter install`, `adapter upgrade --write`                                                                                                                                     | Each install or write-mode upgrade                                                                                                                                                                                                                                                                                                                                                                  |
| `design/brief.md`, `design/constitution.md`                                                                       | `plan brief`, `plan constitution`                                                                                                                                                | Once per wizard run                                                                                                                                                                                                                                                                                                                                                                                 |
| `design/roadmap.yaml`                                                                                             | `init` creates it empty at bootstrap; then `init --sample-phase`, `phase add`, `phase new`, `phase import`, `plan adopt --write` append (all via `createPhase`)                  | Initial create, then one append per phase added                                                                                                                                                                                                                                                                                                                                                     |
| `design/phases/<phase>.yaml`                                                                                      | `init --sample-phase`, `phase add`, `phase new`, `phase import`, `plan adopt --write`, `task add`, `task finalize --write`, `phase reconcile --write`, `plan sync-paths --write` | Phase creation: one write per phase. Task lifecycle: one write per `task add` / status flip. `plan sync-paths --write` rewrites `reads`/`writes` path fields                                                                                                                                                                                                                                        |
| `design/**/*.yaml`, `design/**/*.md`                                                                              | `plan normalize --write`                                                                                                                                                         | Byte-level normalization only (CRLF→LF, trailing-whitespace for YAML, final newline); never parses/re-stringifies YAML or changes roadmap/phase semantics                                                                                                                                                                                                                                           |
| `design/decisions/PRUNED.md`                                                                                      | `decision prune --write`                                                                                                                                                         | Append-only tombstone ledger: a row is appended when the decision is **not** already recorded (file created with a header on the first prune); an idempotent retry **verifies the existing row and appends no duplicate**. The decision path is recorded as a code span, never a link. The write does **not** `mkdir` the parent — a removed `design/decisions/` fails rather than being re-created |
| Inbound `.md` / `.github/*.yml` doc references (root except `CHANGELOG.md`, `docs/**`, `design/**`, `.github/**`) | `decision prune --write`                                                                                                                                                         | Rewrites each inbound reference to the pruned decision (body link → delink, README index row → tombstone); one write per affected file. The pruned `design/decisions/<path>.md` record is **deleted** (an `unlink`, last — see the exception note above)                                                                                                                                            |
| `.code-pact/state/progress.yaml` (legacy)                                                                         | `plan normalize --write`                                                                                                                                                         | Byte-level normalization when the legacy compatibility file exists; the per-event files under `state/events/` are not normalized                                                                                                                                                                                                                                                                    |
| `<agent-profile>.context_dir/<task-id>.md` (context pack; default `.context/<agent>/<task-id>.md`)                | `task prepare` (unless `--dry-run`), `pack`                                                                                                                                      | One write per `task prepare` / `pack` invocation. `task context` does **not** write — it builds and returns/prints the same bytes. The file is regenerable; the default context dir is gitignored (`/.context/`), and a custom `context_dir` should likewise be treated as ignorable agent output. Not tracked in the adapter manifest                                                              |
| `<adapter-owned files>` (e.g. `CLAUDE.md`, `.claude/skills/*.md`)                                                 | `adapter install`, `adapter upgrade --write`                                                                                                                                     | Generated from the agent's `AdapterDescriptor`; manifest tracks every file. `adapter install` / `upgrade` may also create the agent profile's `context_dir` directory (a `mkdir`, not a file-content write), but the per-task packs inside it are written by `task prepare` / `pack` (row above), not the adapter                                                                                   |

**Committed vs ignored.** Everything `code-pact` writes under `.code-pact/` is _shared, version-controlled_ state **except** the machine-local / derived paths: `.code-pact/locks/` (advisory locks — pid/hostname) and `.code-pact/cache/` (reserved, derived). `init` adds exactly those two (plus `/.local/` and `/.context/`) to `.gitignore`; `project.yaml`, `agent-profiles/`, `model-profiles/`, `state/baselines/`, and the progress ledger are committed. **Adapter manifests are conditional:** commit `.code-pact/adapters/<agent>.manifest.yaml` **only together with** the adapter-owned generated files it lists (e.g. `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/skills/*`, `.cursor/**`) — a committed manifest whose managed files are absent fails `adapter doctor` with `ADAPTER_FILE_MISSING` on a clean checkout. A repo that treats adapter output as regenerated/ignored (as code-pact's own repo does) ignores the manifest too. (The progress ledger is **per-event files under `state/events/`** — collaboration-safe-state RFC, B1. The legacy single `state/progress.yaml`, if present, is still read and merged but no longer written. Both forms are committable; only the per-event form is merge-safe, so commit `state/events/**`.)

**An over-broad ignore defeats this policy — and `doctor` catches it.** `init` _merges_ its narrow entries into an existing `.gitignore` and **never deletes a user's lines**, so a pre-existing blanket `/.code-pact/` (or `.code-pact/`) rule — or a file-scoped one like `state/events/*.yaml` — survives and overrides them: the affected shared state is then silently never committed, and a teammate or clean checkout misses whatever is ignored (project config, profiles, baselines, or the ledger). **Only when the ledger itself is ignored** does the `CONTROL_PLANE_BRANCH_NOT_DRIVEN` CI gate _also_ skip (it has no tracked ledger to read). `init` surfaces this as a warning, and `doctor` reports it authoritatively as `CONTROL_PLANE_GITIGNORED` — it asks `git check-ignore --no-index` for a representative **file** in each shared area (`project.yaml`, `agent-profiles/`, `model-profiles/`, `state/baselines/`, `state/events/`), so a file-scoped rule is caught and negation re-includes are honoured. Neither edits your `.gitignore`; narrow the rule yourself — keep only `/.code-pact/locks/` and `/.code-pact/cache/` (plus `/.local/`, `/.context/`) ignored.

### Author attribution (Collaboration UX RFC, D1)

Every progress event (`task start` / `complete` / `block` / `resume` / `record-done`) records an optional **`author`** — the human who ran the verb — so a team's ledger answers _who did what_. It is captured at write time by a fixed precedence (`off` wins first, so a repo opt-out is genuinely "never capture"):

1. `project.yaml` → `collaboration.author: off` → **omit** (capture disabled).
2. else `CODE_PACT_AUTHOR` env var → used **trimmed** (a blank-after-trim value is ignored).
3. else `git config user.name` → used.
4. else → **omit** (never fabricated).

There is **no automatic `user.email` fallback** (an email is PII; set `CODE_PACT_AUTHOR` if you want email-as-identity). `author` is **additive and optional**: legacy events omit it and **hash identically to before** (it joins the content id only when present, so distinct authors recording the same logical transition produce distinct event files — a genuine concurrent-edit, surfaced by `PROGRESS_EVENT_CONFLICT`, not silently merged). It is self-reported coordination metadata (as trustworthy as `git blame`), **not** an audit/security control.

`project.yaml` config:

```yaml
collaboration:
  author: auto # auto (default) | off
```

### Atomic write strategy

Every file-content write listed above goes through `atomicWriteText` (`src/io/atomic-text.ts`):

1. Write content to `<path>.tmp-<pid>-<timestamp>` in the same directory.
2. `fs.rename(tmp, path)` — on POSIX, this is a single inode swap.

`fs.rename` within the same filesystem is atomic on POSIX (the destination either points at the old content or the new content, never a partial file). A rename failure best-effort `unlink`s the temp file, so the failure path does not leave a stray `*.tmp-*` behind. This is sufficient for code-pact's "interrupted-process safety" requirement and is verified end-to-end by the test suite.

`decision prune --write`'s **inbound link rewrites** use a sibling helper, `atomicReplaceExistingText` — identical temp+rename, but it does **not** `mkdir` the parent. Re-creating a directory that was deleted between preflight and write (and resurrecting the file with stale content) would be wrong for a destructive in-place rewrite, so a vanished parent fails instead. The **ledger append** may legitimately create `PRUNED.md`, but likewise passes `atomicWriteText(..., { mkdir: false })` so it never re-creates a removed `design/decisions/` parent — symmetric with the source rewrites; a vanished parent is a `DECISION_PRUNE_WRITE_FAILED` (`append_ledger`, `partial_applied: false`), not a resurrected tree.

The one exception is the **per-event progress ledger** (`.code-pact/state/events/`, collaboration-safe-state RFC B1): each event is published with a temp file plus `fs.link` onto a content-addressed final path (a no-overwrite publish, **not** a rename), so two concurrent writers cannot clobber each other and a re-recorded identical event is an idempotent no-op rather than a partial write.

**What `code-pact` does NOT do** (intentional, documented limits):

- **No `fsync`.** A power loss between the rename and the OS flushing the dirty buffers can lose the most recent write. This is acceptable for a local dev tool — the next run will recover from the prior state.
- **No progress-log write lock — and none is needed.** `task start` / `task complete` etc. write **one file per event** under `.code-pact/state/events/` (collaboration-safe-state RFC, B1): each event is published as a distinct no-overwrite file (temp + `link` onto a content-addressed name), so two concurrent invocations against the same project produce two different files and neither is lost, and two branches that each add events merge cleanly. The legacy monolithic `progress.yaml` (read-the-whole-file-append-rewrite, where a concurrent writer could lose an event) is **no longer written** — it is still read and merged for back-compat. Governance lifecycle mutations are different: v1.5+ serializes the phase/roadmap-creation and phase-YAML-mutation paths (the lock-covered commands below) with the advisory lock.
- **No backup file** (`.bak`). The doctor `BAK_FILE` warning fires if a `.bak` file appears next to a tracked file — it's expected to be a leftover from manual edits, not code-pact output.

### Path safety

The v1.0 path-traversal hardening is intentionally scoped to **adapter-managed generated file writes**, because adapters are the surface that writes user-visible paths derived from generator output (where the manifest, the generator, and the on-disk file all need to agree on a path that a user can reasonably modify).

- `assertSafeRelativePath` (`src/core/adapters/file-state.ts`) rejects absolute paths, leading `~`, backslashes, Windows drive letters, `..`, `.`, and empty path segments at the zod-schema layer.
- `resolveWithinProject` walks ancestor directory realpaths and rejects symlink escape (a directory symlink under `cwd` resolving to a location outside the project root).

Other project state files — the progress ledger, phase YAMLs, the design tree, agent profiles — remain protected by their existing schema validation and atomic-write behaviour. They are written to paths derived from project config or constants, not from user-supplied generator output, so the adapter-style traversal helpers do not currently apply.

Extending the adapter-style helpers to other state-file writes is **deferred unless a concrete risk appears**. It is not a "we don't need validation there" claim — it's a scope statement about what kind of write surface the helpers are designed for.

### Concurrent writers

Running two lock-covered governance lifecycle mutations against the same project in parallel is **detected** in v1.5+ via the advisory write lock (P14 governance — see § Advisory write lock below); the second invocation fails fast with `LOCK_HELD` (exit 2) and a diagnostic envelope. This is **not** a blanket lock over every command that can write under `design/`: bootstrap (`init`) and normalization-style writers (`plan normalize --write`, `plan brief`, `plan constitution`) have their own contracts and take no lock. Read-only commands (`status`, `plan lint`, `plan analyze`, `task runbook`, `phase runbook`, `validate`, `doctor`, `recommend`, `task context`, `task status`) likewise do not acquire the lock and can run concurrently with mutations (observing the project at whatever transitional state is on disk when they read).

### Advisory write lock (v1.5+ / P14)

`.code-pact/locks/write.lock` is created by the lock-covered commands listed in the `LOCK_HELD` row of [§ Public codes](#public-codes-top-level-error-envelopes) above. Acquisition is atomic via `fs.writeFile(..., { flag: "wx" })` (cross-platform exclusive create); release is `unlink`. The lock file content is JSON `{pid, hostname, cmd, created_at}` for diagnostic display.

**Lock acquisition points.** The lock is acquired at the **CLI command-handler level**, not inside `createPhase` or other core services. This lets `phase import` hold a single outer acquisition across its multi-phase apply loop (batch transactionality — every `createPhase` call inside runs under the same lock without re-acquiring). The acquisition points are:

| Command                                | Acquired when                                                                    | Coverage                                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init --sample-phase`                  | The `--sample-phase` flag is set **and** `.code-pact/` already exists            | The whole `runInit` (which calls `writeSamplePhase` → `createPhase`). Fresh bootstrap acquires no lock — the helper would create `.code-pact/` and trip `ALREADY_INITIALIZED` |
| `init` (wizard)                        | Whenever `.code-pact/` already exists (defensive); fresh bootstrap takes no lock | The whole wizard + an optional `writeSamplePhase` call when `--sample-phase` is passed                                                                                        |
| `phase add` (flag-based or wizard)     | After parsing / wizard prompts finish, before `runPhaseAdd`                      | The single `createPhase` call                                                                                                                                                 |
| `phase new` (wizard)                   | At command entry — held through wizard prompts and write                         | The single `createPhase` call                                                                                                                                                 |
| `phase import` / `plan import` (alias) | At command entry, before `runPhaseImport` is called                              | The entire multi-phase apply loop (every `createPhase` inside)                                                                                                                |
| `task add` (wizard or non-interactive) | At command entry                                                                 | Wizard prompts (if any) + phase YAML write                                                                                                                                    |
| `task finalize`                        | Only when `--write`                                                              | The single phase YAML status flip                                                                                                                                             |
| `phase reconcile`                      | Only when `--write`                                                              | The entire reconcile batch (all flips under one acquisition)                                                                                                                  |
| `plan adopt`                           | Only when `--write`                                                              | The generated import applied through `applyParsedPhaseImport` → `createPhase` (one acquisition over the whole apply)                                                          |
| `plan sync-paths`                      | Only when `--write`                                                              | The phase-YAML `reads`/`writes` path rewrites                                                                                                                                 |

`task finalize` and `phase reconcile` **dry-runs do NOT acquire the lock** (they don't write).

`tutorial` (v1.15+) runs entirely inside a throwaway `mkdtemp` sandbox outside the project and **never acquires the project lock** — it writes nothing under the project root.

**`LOCK_HELD` envelope shape.**

```json
{
  "ok": false,
  "error": {
    "code": "LOCK_HELD",
    "message": "Another code-pact mutation is in progress: phase reconcile P14 --write (pid: 12345, host: laptop.local, started: 2026-05-21T10:15:00.000Z). If you are certain no command is running, remove /path/to/.code-pact/locks/write.lock and retry."
  },
  "data": {
    "lock_holder": {
      "pid": 12345,
      "hostname": "laptop.local",
      "cmd": "phase reconcile P14 --write",
      "created_at": "2026-05-21T10:15:00.000Z"
    },
    "lock_path": "/path/to/.code-pact/locks/write.lock"
  }
}
```

When the lock file exists but is unreadable or unparseable (e.g. a partial write from a crashed process, or a hand-edit gone wrong), `data.lock_holder` is `null` and the message text adjusts accordingly. The contender always fails fast; corrupt lock files do NOT auto-clean themselves.

**Stale lock recovery.** v1.5 does NOT auto-detect stale locks (e.g. a crashed process leaving the file behind). The user must:

1. Verify no `code-pact` command is running.
2. Manually delete `.code-pact/locks/write.lock`.
3. Re-run the command.

Automation (PID liveness check, age-based stale detection, a `--force-lock` flag) is deferred to a future RFC. Conservative manual-recovery avoids races where two processes both decide the other is stale.

**Relationship to atomic-text.** The lock is layered ON TOP of the existing atomic-write contract — it does not replace it. Atomic-text gives file-level durability (interrupted writes never leave a half-written file); the lock gives semantic guard against concurrent semantic mutations of the same project. Both are needed.

**The progress ledger is intentionally NOT locked — and does not need a lock.** The lock-free choice keeps these high-frequency commands cheap, and per-event files (collaboration-safe-state RFC, B1) make lock-free _actually_ safe: a new file per event under `state/events/` needs no lock and cannot lose a concurrent write (see _No progress-log write lock_ above). The legacy monolithic `progress.yaml` read-append-rewrite writer — where two concurrent writers could lose an event — is **no longer written** (still read-merged for back-compat). A write lock on the monolithic file would only have papered over the underlying data-model issue, so none was added; the data model was fixed instead.

### Roadmap mutation policy (v1.5+ / P14)

`design/roadmap.yaml` is the project's phase index. `init` creates it (initially empty, `{ phases: [] }`) at bootstrap. After that, every command that **appends a phase** routes through the `createPhase` domain service (`src/core/services/createPhase.ts`), so the id-collision check, slug derivation, file layout, reserved-id block, and roadmap append all live in one place.

| Command                                                                                                                           | Writes `design/roadmap.yaml`?                         | Mechanism                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init` (fresh bootstrap)                                                                                                          | yes                                                   | Creates the initial empty `roadmap.yaml` (`{ phases: [] }`)                                                                                                                   |
| `init --sample-phase` (interactive or non-interactive)                                                                            | yes                                                   | `writeSamplePhase()` → `createPhase` (with internal `_isSampleCreation: true` bypass for the reserved `TUTORIAL` id)                                                          |
| `phase add` (flag-based)                                                                                                          | yes                                                   | `runPhaseAdd` → `createPhase`                                                                                                                                                 |
| `plan adopt --write`                                                                                                              | yes                                                   | `applyParsedPhaseImport` → `createPhase` (per adopted phase)                                                                                                                  |
| `phase new` (TTY wizard)                                                                                                          | yes                                                   | `runPhaseNew` → `createPhase`                                                                                                                                                 |
| `phase import`                                                                                                                    | yes (per imported phase, after reserved-id preflight) | `runPhaseImport` → `createPhase`                                                                                                                                              |
| `task add`                                                                                                                        | no                                                    | Writes phase YAML only (`design/phases/<phase>.yaml`)                                                                                                                         |
| `task complete`                                                                                                                   | no                                                    | Writes one event file under `state/events/` (lock-free per-event; concurrency-safe by construction, see § State file write guarantees)                                        |
| `task finalize --write`                                                                                                           | no                                                    | Writes phase YAML only (flips `tasks[].status`)                                                                                                                               |
| `phase reconcile --write`                                                                                                         | no                                                    | Writes phase YAML only (batch flip of `tasks[].status`)                                                                                                                       |
| `task start` / `task block` / `task resume` / `task status`                                                                       | no                                                    | Writes one event file under `state/events/` only, or read-only (`task status`)                                                                                                |
| `plan normalize`                                                                                                                  | no phase append                                       | `--check` is read-only; `--write` may byte-normalize existing `design/roadmap.yaml` (CRLF→LF, trailing whitespace, final newline) but never adds, removes, or reorders phases |
| `status` / `plan lint` / `plan analyze` / `validate` / `doctor` / `recommend` / `task runbook` / `phase runbook` / `task context` | no                                                    | Read-only                                                                                                                                                                     |

Apart from `init`'s initial bootstrap creation, the `createPhase` callers are the **only** code paths that append to `roadmap.yaml`. This is enforced structurally — no other module calls into the roadmap saver. Future commands that need to append to the roadmap MUST go through `createPhase` (or land an RFC-update that extends this writer list).

### Reserved phase ids (v1.5+ / P14)

The id `TUTORIAL` is **reserved** for the sample-phase artifact created by `code-pact init --sample-phase`. The block fires at creation time:

| Path                                                                         | Outcome                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init --sample-phase` (interactive or non-interactive)                       | **Allowed.** `writeSamplePhase()` passes the internal `_isSampleCreation: true` flag to `createPhase`                                                                                                                                 |
| `phase add --id TUTORIAL ...`                                                | `CONFIG_ERROR` (exit 2). Roadmap is byte-identical (no write)                                                                                                                                                                         |
| `phase new` (TTY wizard) → typing `TUTORIAL` as the id                       | `CONFIG_ERROR` (exit 2). Roadmap is byte-identical                                                                                                                                                                                    |
| `phase import` containing any entry with `id: TUTORIAL`                      | `CONFIG_ERROR` (exit 2) from a **preflight scan** that runs before the first `createPhase` call. The entire import is rejected — no partial-import state where earlier phases are written and the TUTORIAL entry is rejected mid-loop |
| `validate` / `plan lint` / `plan analyze` against an existing TUTORIAL phase | No warning. The block is creation-time only; existing projects with a TUTORIAL phase (whether sample-phase artifact or legacy) are untouched                                                                                          |

The block uses **existing `CONFIG_ERROR`** — no new error code. The error message names the reserved id and points at `init --sample-phase` as the sanctioned path. Configurable reserved-id lists are deferred to a future RFC; in v1.5, `TUTORIAL` is the only reserved id.

### Phase status manual-flip convention (v1.2+, documented in v1.5 / P14)

`phase reconcile <id> --write` flips **task** statuses in batch (`planned`/`in_progress` → `done` for every `flip` candidate) but never writes the phase's own `status` field — `phase_status_candidate` in the JSON envelope is advisory only.

The release-prep convention since v1.2.0 is:

1. Run `code-pact phase reconcile <phase-id> --write` to flip task statuses.
2. Hand-edit the phase's own `status` field in `design/phases/<phase>.yaml` (typically as part of the release-prep PR).

Auto-flip implementation (e.g. a `--phase-status` flag on `phase reconcile`, or a separate `phase finalize` command) is **not part of v1.5** and is deferred to a future RFC. The decision and its rationale are documented in the **governance RFC** § Phase status policy (retired — in git history / the `.code-pact/state` archive record).

## Source layout (CLI wrapper layer)

> v1.14+ / P27. **Not a stability contract** — this section
> documents the on-disk layout so contributors know where new
> commands go. The runtime behaviour of every command is
> locked by the JSON envelope / exit code / error code
> contract documented above, not by file paths.

The CLI wrapper layer owns argv parsing, flag validation, cluster dispatch, and
error-envelope shaping. The pure-function command implementations that the
wrappers call into live separately under [`src/commands/`](../src/commands/).

| Path | Owns |
| --- | --- |
| [`src/cli.ts`](../src/cli.ts) | Top-level dispatch and root commands such as `init`, `doctor`, `validate`, `recommend`, `verify`, `pack`, and `progress`. |
| [`src/cli/commands/<cluster>.ts`](../src/cli/commands/) | Cluster dispatch and command-wrapper behavior for `task`, `plan`, `phase`, `adapter`, `decision`, `state`, and `spec`. |
| [`src/cli/spec/<cluster>.ts`](../src/cli/spec/) | Generated usage/help/reference source for migrated clusters. Parser options, rich help, and [`docs/cli-reference.generated.md`](cli-reference.generated.md) derive from these specs where the cluster has been migrated. |
| [`src/cli/util.ts`](../src/cli/util.ts) | Shared CLI wrapper utilities such as the advisory write lock and JSON envelope helpers. |

### Where new commands go

When adding a new CLI command:

1. **If it extends an existing cluster with a `src/cli/commands/<cluster>.ts` wrapper**, the new `cmd*` function goes in that cluster file. Update the cluster dispatcher to route the new subcommand. For migrated clusters, update the corresponding `src/cli/spec/<cluster>.ts` instead of hand-writing usage/flag/reference lists.

2. **If it is a new top-level command** still hosted in `src/cli.ts` (init, doctor, validate, verify, pack, progress, recommend), the new `cmd*` function goes in `src/cli.ts` next to its peers, and the top-level `main()` dispatch gains a new branch.

3. **If a future top-level command grows into a subcommand cluster**, file a focused follow-up and extract that cluster into `src/cli/commands/<cluster>.ts`. The pure-refactor invariant (existing tests pass without modification) is the safety guarantee.

The pure-function implementation layer that the CLI wrappers call into lives separately under [`src/commands/`](../src/commands/) (e.g. `task-context.ts`, `adapter-conformance.ts`). That layer is intentionally separate from the wrapper/spec ownership above.

## Maintainer-only tooling (NOT part of the CLI surface)

The repository contains internal scripts under `scripts/` that are **not** part of the `code-pact` CLI contract. They are run via `pnpm <script-name>` (NOT through `code-pact ...`), live outside `dist/`, and are never registered in `package.json` `bin`.

The current maintainer-only tools are:

- **`pnpm harness`** (v1.10+, P20) — evidence harness that walks the corpus and emits CSV metrics under `docs/maintainers/measurements/`. See [`docs/concepts/evidence-harness.md`](concepts/evidence-harness.md). This is **not** `code-pact harness` — the command does not exist on the public CLI.

These tools have no stability commitment, no JSON envelope contract, no error code surface. They can change shape between minors without a deprecation cycle. If you find yourself wanting to depend on one from outside the repository, open an issue first to discuss promoting it to a public surface.

## Stability taxonomy (v1.0)

As of v1.0.0, every public command in `code-pact` falls into one of four
stability bands. Future minor releases are allowed to grow the surface
(new commands, new JSON fields, new error codes) without changing band,
but no command may move to a more-restrictive band or change its public
shape without a major version bump.

### Stable (v1.0)

Commands that take `--json`, emit a documented `{ok, data}` envelope on
stdout, have documented exit codes, and have subprocess integration
coverage. Agents and CI may rely on these.

| Command                                                                                                                               | Notes                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--version`                                                                                                                           | Both human and `--json` modes                                                                                         |
| `init`                                                                                                                                | TTY wizard, but `--non-interactive --agent X --locale Y --json` is supported and tested                               |
| `tutorial`                                                                                                                            | v1.15+. Runs the per-task loop in a throwaway sandbox; `--json` emits a step transcript, `--keep` retains the sandbox |
| `doctor`                                                                                                                              |                                                                                                                       |
| `validate`                                                                                                                            |                                                                                                                       |
| `recommend`                                                                                                                           |                                                                                                                       |
| `plan lint` / `plan normalize` / `plan analyze` / `plan prompt` / `plan sync-paths`                                                   |                                                                                                                       |
| `phase add`                                                                                                                           | Flag-only path (`--id`/`--name`/`--objective`/`--weight`/`--verify-command`) is the Stable surface                    |
| `phase ls` / `phase show` / `phase import`                                                                                            |                                                                                                                       |
| `task context` / `task status` / `task start` / `task block` / `task resume` / `task complete` / `task record-done`                   |                                                                                                                       |
| `task prepare` / `task finalize` / `task runbook` / `phase reconcile` / `phase runbook`                                               | `task prepare` is the recommended per-task entry point (it bundles `task context`)                                    |
| `pack`                                                                                                                                | Low-level stable command — `task context` is the preferred agent-facing entry                                         |
| `verify`                                                                                                                              |                                                                                                                       |
| `progress`                                                                                                                            |                                                                                                                       |
| `adapter list` / `adapter install` / `adapter doctor` / `adapter conformance` / `adapter upgrade --check` / `adapter upgrade --write` |                                                                                                                       |

### Stable (human-output)

Commands that are TTY-required wizards by design. They DO accept
`--json` for the failure path (e.g. emitting `CONFIG_ERROR` in
`--non-interactive` mode), but their success path is not driven by a
machine-readable contract.

| Command             | Notes                                         |
| ------------------- | --------------------------------------------- |
| `plan brief`        | Interactive prompt → `design/brief.md`        |
| `plan constitution` | Interactive prompt → `design/constitution.md` |
| `task add`          | Interactive task wizard                       |

`code-pact` will not add JSON-mode success contracts to these commands
solely for v1.0. If a future minor release adds one, it is purely
additive and the human-output path remains supported.

### Experimental

The adapter modules below ship and are usable, but their generated
output formats may shift in minor releases to track upstream tooling
changes. They are intentionally excluded from
`tests/integration/adapter-conformance.test.ts`.

| Adapter      | Notes                                                                                  |
| ------------ | -------------------------------------------------------------------------------------- |
| `cursor`     | Writes `.cursor/rules/code-pact.mdc`. Cursor's `.mdc` format and placement may change. |
| `gemini-cli` | Writes `GEMINI.md`. Gemini CLI's discovery rules may change.                           |

### Deprecated / removed

| Surface                                                              | Replacement                         | Status                                                              |
| -------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| Bare-form `code-pact adapter [--agent X] [--force] [--regen-skills]` | `code-pact adapter install <agent>` | **Removed in v1.20** — now `CONFIG_ERROR` (exit 2), no side effects |

The bare form previously printed a deprecation notice and routed internally to
`adapter install`. As of v1.20 it is removed: a bare `code-pact adapter` returns
`CONFIG_ERROR` and installs nothing.

### What is NOT a stability claim

The following shapes are documented but **not** locked by v1.0:

- Human-readable stdout / stderr text content (translation, phrasing, log line ordering)
- The presence of optional / advisory JSON fields beyond the documented contract — fields can be added; existing fields cannot be removed or change type
- Internal module names, file layouts under `src/`, and TypeScript exported types
- The format of files under `.code-pact/state/` beyond the documented progress-event schema (legacy `progress.yaml` and per-event files under `state/events/`)
- The exact filename pattern of `.code-pact/adapters/<agent>.manifest.yaml` (the directory and schema are stable; the per-agent filename mapping follows `<agent>.manifest.yaml`)

## Stability

The rules documented in this file — JSON envelope shape, exit-code
families, error-code surface, `--json` position equivalence, TTY rules,
and the taxonomy above — are the v1.0 public contract. Changes that
break these rules require a major version bump.
