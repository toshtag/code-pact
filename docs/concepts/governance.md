# Governance

This document is the agent- and reviewer-facing walkthrough of code-pact's **governance layer** — the deterministic rules for *who can write what, and when*. For the full design rationale, read [`design/decisions/governance-rfc.md`](../../design/decisions/governance-rfc.md).

## Why this layer exists

On top of the append-only progress ledger and the Stable CLI contract, code-pact adds readiness fields on the Task schema, deterministic design-YAML mutations (`task finalize` / `phase reconcile`), read-only sequencing guidance (`task runbook` / `phase runbook`), and scripted bootstrap (`init --sample-phase`). Those raise a question none of them answers on its own: **who can write what, and when.**

The governance layer answers it:

- Two concurrent `task finalize --write` invocations must not race on the same phase YAML.
- `phase add --id TUTORIAL` must not succeed — `TUTORIAL` is a reserved sample-phase id.
- The task→phase resolver must be one shared code path, not duplicated per command.
- Roadmap mutation must have a single, documented writer.

It does this with a deliberately small surface: **one public error code (`LOCK_HELD`), one creation-time reservation (`TUTORIAL`), one shared resolver core, and three documented policy conventions** (protected-path strict-mode posture, declared writes as a review surface, phase-status manual-flip convention). No new schema fields; no behavioural change to existing Stable commands on the success path.

## The four governance pillars

### 1. Advisory write lock (`LOCK_HELD`)

The governance lifecycle mutations — phase creation and import, `task add`, the `--write` forms of `task finalize` / `phase reconcile`, and the `plan adopt` / `plan sync-paths` write paths — acquire `.code-pact/locks/write.lock` at the CLI command-handler level, hold it through any nested writes (notably `phase import`'s multi-phase apply loop), and release on every exit path. A concurrent invocation against the same project fails fast with `LOCK_HELD` (exit 2) and a diagnostic JSON envelope.

```json
{
  "ok": false,
  "error": {
    "code": "LOCK_HELD",
    "message": "Another code-pact mutation is in progress: phase reconcile P3 --write (pid: 12345, host: laptop.local, started: 2026-05-21T10:15:00.000Z). If you are certain no command is running, remove /path/to/.code-pact/locks/write.lock and retry."
  },
  "data": {
    "lock_holder": { "pid": 12345, "hostname": "laptop.local", "cmd": "phase reconcile P3 --write", "created_at": "2026-05-21T10:15:00.000Z" },
    "lock_path": "/path/to/.code-pact/locks/write.lock"
  }
}
```

The lock is scoped to those governance lifecycle mutations — it is **not** a blanket lock over everything that can write under `design/` (normalization and bootstrap-style writers such as `init` have their own contracts). Read-only commands and dry-run `task finalize` / `phase reconcile` take no lock, and the progress ledger is lock-free by construction (a separate no-overwrite file per event under `state/events/`, so concurrent writers cannot lose an event). The authoritative, per-command acquisition matrix lives in `docs/cli-contract.md` (linked below) — this doc states the policy, not a second copy of the table.

**Stale lock recovery is manual.** If a `code-pact` command crashed without releasing the lock, verify no process holds it, manually delete `.code-pact/locks/write.lock`, and re-run. There is no automatic PID-liveness / age-based detection and no `--force-lock` flag (see [Intentionally out of scope](#intentionally-out-of-scope)).

For the full envelope shape, lock acquisition matrix, and the rationale for not locking the progress ledger, see [`docs/cli-contract.md` § Advisory write lock](../cli-contract.md#advisory-write-lock-v15--p14).

### 2. Reserved phase id (`TUTORIAL`)

The id `TUTORIAL` is reserved at the governance layer for the sample-phase artifact created by `code-pact init --sample-phase`. The block fires at creation time:

| Path | Outcome |
| --- | --- |
| `init --sample-phase` (interactive or non-interactive) | **Allowed** — internal `_isSampleCreation: true` bypass on `createPhase` |
| `phase add --id TUTORIAL ...` | `CONFIG_ERROR` (exit 2). Roadmap byte-identical |
| `phase new` wizard → typing `TUTORIAL` | `CONFIG_ERROR` (exit 2) |
| `phase import` containing `id: TUTORIAL` (any position) | `CONFIG_ERROR` (exit 2) from a **preflight scan** — the entire import is rejected before any phase YAML is written |
| `validate` / `plan lint` / `plan analyze` against an existing TUTORIAL phase | No warning. The block is creation-time only; existing data is untouched |

The block reuses the existing `CONFIG_ERROR` envelope — **no new error code** ships for this. The error message names the reserved id and points at `init --sample-phase` as the sanctioned path.

See [`docs/concepts/sample-phase.md` § TUTORIAL is a reserved phase id](sample-phase.md#tutorial-is-a-reserved-phase-id) for the user-facing usage.

### 3. Roadmap mutation policy

`design/roadmap.yaml` is the project's phase index. `init` creates it (initially empty) at bootstrap; after that, every command that **appends a phase** routes through the `createPhase` domain service (`src/core/services/createPhase.ts`), so the id-collision check, slug derivation, file layout, reserved-id block, and roadmap append all live in one place.

Those phase-appending paths are `phase add` / `phase new` / `phase import`, `plan adopt --write` (which applies its generated import through the same path), and the `init --sample-phase` artifact. No other module appends to the roadmap — a structural guarantee, documented here rather than separately enforced. (Task-level commands — `task add`, `task finalize --write`, `phase reconcile --write` — touch phase YAML only, never the roadmap; progress commands write per-event files under `state/events/`.)

See [`docs/cli-contract.md` § Roadmap mutation policy](../cli-contract.md#roadmap-mutation-policy-v15--p14) for the canonical per-command matrix.

### 4. Phase status manual-flip convention

`phase reconcile <id> --write` flips **task** statuses in batch but never writes the phase's own `status` field. `phase_status_candidate` in the JSON envelope is advisory only.

Release-prep convention:

1. Run `code-pact phase reconcile <phase-id> --write` to flip task statuses.
2. **Hand-edit** the phase's own `status` field in `design/phases/<phase>.yaml` (typically in the release-prep PR).

Auto-flip is intentionally not provided — there is no `--phase-status` flag on `phase reconcile` and no `phase finalize` command. The rationale: phase status is often gated by non-task work (release prep, docs, manual cleanup) that no deterministic command can verify; the right home for that judgement call is human review, not the CLI.

See [`docs/concepts/finalization-reconciliation.md` § Phase status remains a manual flip](finalization-reconciliation.md#phase-status-remains-a-manual-flip) for the user-facing convention.

## Two pillars covered by existing docs

### Protected-path `--strict` posture

`TASK_WRITES_PROTECTED_PATH` is a warning-level advisory raised when a task's `writes` glob covers a protected design path. `plan lint --strict`'s binary promotion (`errors + warnings === 0`) makes it exit-relevant in CI use, without any per-code configuration.

The protected-path list is configurable: code-pact loads it from `design/rules/protected-paths.md` when that file is present (one glob per line), and falls back to a hardcoded default set (`.git/**`, `node_modules/**`, `.code-pact/**`, `design/roadmap.yaml`, `design/phases/*.yaml`) when it is absent.

**Release-prep posture.** The code-pact dogfood corpus is strict-clean: `plan lint --include-quality --strict --json` is expected to pass with zero warnings. Completed historical meta-design tasks do not keep protected design YAML writes declared solely to prove the advisory exists.

See [`docs/cli-contract.md` § Plan diagnostic codes → Task Readiness Schema diagnostics → `--strict`](../cli-contract.md#plan-diagnostic-codes) and [`docs/maintainers/operations.md`](../maintainers/operations.md#release-prep-uses-strict-clean-dogfood-checks-v151-guidance) (Release prep section) for the canonical guidance.

### Declared writes as a governance review surface

The `writes` field on a task and the `declared_writes[]` field on `task finalize --json` / `task runbook --json` envelopes together form a **review surface**, not enforcement:

- The surface IS a declaration of intent + a reviewable signal in CLI output.
- `task finalize` **audits** it: with `--base-ref <ref>` it compares the declared `writes` against the files the branch actually changed and reports `TASK_WRITES_AUDIT_OUTSIDE_DECLARED` (a changed file no glob covers) and `TASK_WRITES_AUDIT_DECLARED_UNUSED` (a glob that matched nothing). The audit is advisory by default; `--audit-strict` promotes it to exit-relevant (`WRITES_AUDIT_STRICT_FAILED`, exit 1, with `applied: false`).
- What is NOT done is blocking a write *as it happens*: the audit runs at finalize time against git, not as a pre-write runner, and `task complete` / `phase reconcile` do not check writes.

See [`docs/concepts/finalization-reconciliation.md` § Declared writes as a governance review surface](finalization-reconciliation.md#declared-writes-as-a-governance-review-surface) and [`docs/concepts/runbook.md` § Declared writes as a governance review surface](runbook.md#declared-writes-as-a-governance-review-surface-v14--p14) for the canonical workflow.

## Intentionally out of scope

The governance RFC enumerates the non-goals. The headline items:

- **Pre-write enforcement of declared `writes`.** The `task finalize` write-audit compares declarations against git after the fact (advisory, or exit-relevant under `--audit-strict`), but nothing blocks a write *as it happens* — that would need a runner or VCS hook.
- **Phase status auto-flip.** Manual flip is the release-prep convention; a `phase reconcile --write --phase-status` flag or a `phase finalize` command is out of scope.
- **`--force-lock` flag for stale lock recovery.** Manual delete is the only mechanism.
- **Progress-ledger write locking.** Progress writes stay lock-free for the high-frequency `task complete` / `task start` / `task block` / `task resume` paths — and need no lock to be concurrency-safe: each event is a separate no-overwrite file under `state/events/`, so a concurrent writer cannot lose an event. (The legacy monolithic read-append-rewrite `progress.yaml` writer, which could, is no longer written.) A write lock would only paper over the data model; per-event files fix it at the source.
- **Lock TTL / automatic stale detection.** Recovery is manual; PID-liveness checks are out of scope.
- **Cross-phase / multi-project locking.** Single project, single lock file.
- **Configurable reserved-id list.** `TUTORIAL` is the only reserved id, and only its creation is blocked — existing `TUTORIAL` phases in a project are never flagged.
- **Selective `--strict` promotion.** The binary promotion is the only mode; per-code promotion (e.g. "promote only `TASK_WRITES_PROTECTED_PATH`") is out of scope.

## Error / diagnostic taxonomy

Public error code for the governance layer:

| Code | Exit | Category | Trigger |
| --- | --- | --- | --- |
| `LOCK_HELD` | 2 | **public** | Another `code-pact` mutation is in progress on the same project. `data.lock_holder` carries `{pid, hostname, cmd, created_at}`; `data.lock_path` is the lock file path. Transient + retryable |

Reused codes in governance contexts:

| Code | Trigger |
| --- | --- |
| `CONFIG_ERROR` | `phase add --id TUTORIAL` / `phase import` containing TUTORIAL / `phase new` wizard typing TUTORIAL |
| `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` | Emitted from the shared `src/core/plan/resolve-task.ts` |
| `TASK_WRITES_PROTECTED_PATH` | Warning-level; exit-relevant under `plan lint --strict` |

`LOCK_HELD` is part of `KNOWN_CODES.public` in `tests/unit/error-code-surface.test.ts`; the full public surface remains additive.

## See also

- [`design/decisions/governance-rfc.md`](../../design/decisions/governance-rfc.md) — the full accepted RFC with alternatives and open questions.
- [`docs/cli-contract.md`](../cli-contract.md) — Public codes table (`LOCK_HELD`), § Advisory write lock, § Roadmap mutation policy, § Reserved phase ids, § Phase status manual-flip convention.
- [`docs/migration.md`](../migration.md#v14x--v150) — governance adoption pattern, CI implications, backward compatibility.
- [`docs/concepts/sample-phase.md`](sample-phase.md) — the TUTORIAL artifact and the reserved-id rules from the user side.
- [`docs/concepts/finalization-reconciliation.md`](finalization-reconciliation.md) — `task finalize` / `phase reconcile`, the commands the write lock guards.
- [`docs/concepts/runbook.md`](runbook.md) — `task runbook` / `phase runbook`, read-only commands that do NOT acquire the lock.
- [`docs/concepts/task-readiness-fields.md`](task-readiness-fields.md) — `writes` and `acceptance_refs`, the fields the protected-path advisory and the declared-writes review surface operate on.
