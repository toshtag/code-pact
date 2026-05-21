# Governance (v1.5+)

This document is the agent- and reviewer-facing walkthrough of the four governance decisions that ship in v1.5.0 (P14). For the full design rationale, read [`design/decisions/governance-rfc.md`](../../design/decisions/governance-rfc.md). For the migration story from v1.4.x, read [`docs/migration.md` § v1.4.x → v1.5.0](../migration.md#v14x--v150).

## Why this layer exists

P10 (task readiness schema), P11 (finalization / reconciliation), P12 (lightweight runbook), and P13 (planning UX + init hardening) built four progressively higher layers on top of v1.0's append-only progress / Stable CLI contract:

- **P10** added optional readiness fields on the Task schema (`depends_on`, `decision_refs`, `reads`, `writes`, `acceptance_refs`) with twelve additive lint codes. `TASK_WRITES_PROTECTED_PATH` shipped as a warning-only advisory against a hardcoded seed set.
- **P11** added `task finalize` / `phase reconcile` as deterministic design-YAML mutations with dry-run-first + `--write` opt-in.
- **P12** added `task runbook` / `phase runbook` as read-only sequencing guidance.
- **P13** added `init --sample-phase` for scripted bootstrap, `task add` non-interactive flags, and `suggested_next_steps[]` additive output. The sample-phase artifact was renamed to `TUTORIAL`.

What was still missing at the end of P13: a deterministic answer to **who can write what, and when**. Two concurrent `task finalize --write` invocations would race on the phase YAML. `phase add --id TUTORIAL` succeeded even though `TUTORIAL` was conceptually a reservation. The task→phase resolver was duplicated across eight commands. Mutation policy was implicit — only `createPhase` wrote `roadmap.yaml`, but the contract was nowhere documented.

P14 closes those four gaps with a deliberately small surface: **one new public error code (`LOCK_HELD`), one creation-time reservation (`TUTORIAL`), one pure refactor (resolver core), and three docs-only governance decisions** (protected-path strict-mode posture, declared writes as a review surface, phase status manual-flip convention). No new commands. No new schema fields. No behavioural changes to existing Stable commands on the success path.

## The four governance pillars

### 1. Advisory write lock (`LOCK_HELD`)

Design-mutating commands acquire `.code-pact/locks/write.lock` at the CLI command-handler level, hold it through any nested writes (notably `phase import`'s multi-phase apply loop), and release on every exit path. Concurrent invocations against the same project fail fast with `LOCK_HELD` (exit 2) and a diagnostic JSON envelope.

```json
{
  "ok": false,
  "error": {
    "code": "LOCK_HELD",
    "message": "Another code-pact mutation is in progress: phase reconcile P14 --write (pid: 12345, host: laptop.local, started: 2026-05-21T10:15:00.000Z). If you are certain no command is running, remove /path/to/.code-pact/locks/write.lock and retry."
  },
  "data": {
    "lock_holder": { "pid": 12345, "hostname": "laptop.local", "cmd": "phase reconcile P14 --write", "created_at": "2026-05-21T10:15:00.000Z" },
    "lock_path": "/path/to/.code-pact/locks/write.lock"
  }
}
```

**Which commands acquire the lock:**

| Command | Lock acquired? |
| --- | --- |
| `init --sample-phase` / `init` (wizard, may create sample phase) | Yes |
| `phase add` (flag-based + wizard) | Yes |
| `phase new` (wizard) | Yes (held through prompts) |
| `phase import` | Yes (single outer acquisition covers the multi-phase apply loop) |
| `task add` (wizard + non-interactive) | Yes |
| `task finalize --write` | Yes (dry-run is lock-free) |
| `phase reconcile --write` | Yes (dry-run is lock-free) |
| `plan lint` / `plan analyze` / `plan normalize --check` | **No** (read-only) |
| `task runbook` / `phase runbook` | **No** (read-only) |
| `task context` / `task status` / `validate` / `doctor` / `recommend` | **No** (read-only) |
| `task complete` / `task start` / `task block` / `task resume` | **No** (progress.yaml is append-only by contract — see [`docs/cli-contract.md`](../cli-contract.md#state-file-write-guarantees)) |

**Stale lock recovery is manual in v1.5.** If a `code-pact` command crashed without releasing the lock, verify no process holds it, manually delete `.code-pact/locks/write.lock`, and re-run. Auto-detection (PID liveness, age thresholds, a `--force-lock` flag) is deferred to a future RFC.

For the full envelope shape, lock acquisition matrix, and the rationale for excluding `progress.yaml`, see [`docs/cli-contract.md` § Advisory write lock (v1.5+ / P14)](../cli-contract.md#advisory-write-lock-v15--p14).

### 2. Reserved phase id (`TUTORIAL`)

The id `TUTORIAL` is reserved at the governance layer for the sample-phase artifact created by `code-pact init --sample-phase`. The block fires at creation time:

| Path | Outcome |
| --- | --- |
| `init --sample-phase` (or `init` wizard → yes) | **Allowed** — internal `_isSampleCreation: true` bypass on `createPhase` |
| `phase add --id TUTORIAL ...` | `CONFIG_ERROR` (exit 2). Roadmap byte-identical |
| `phase new` wizard → typing `TUTORIAL` | `CONFIG_ERROR` (exit 2) |
| `phase import` containing `id: TUTORIAL` (any position) | `CONFIG_ERROR` (exit 2) from a **preflight scan** — the entire import is rejected before any phase YAML is written |
| `validate` / `plan lint` / `plan analyze` against an existing TUTORIAL phase | No warning. The block is creation-time only; existing data is untouched |

The block reuses the existing `CONFIG_ERROR` envelope — **no new error code** ships for this. The error message names the reserved id and points at `init --sample-phase` as the sanctioned path. Configurable reserved-id lists and an advisory `RESERVED_ID_USAGE` plan-lint warning for existing TUTORIAL phases are deferred to a future RFC.

See [`docs/concepts/sample-phase.md` § TUTORIAL is a reserved phase id](sample-phase.md#tutorial-is-a-reserved-phase-id-v15--p14) for the user-facing usage.

### 3. Roadmap mutation policy

`design/roadmap.yaml` is the project's phase index. Every code path that mutates it routes through the `createPhase` domain service (`src/core/services/createPhase.ts`), so the id-collision check, slug derivation, file layout, reserved-id block, and roadmap append all live in one place.

| Command | Writes `roadmap.yaml`? | Mechanism |
| --- | --- | --- |
| `init` (sample-phase path) | Yes | `writeSamplePhase()` → `createPhase` (with bypass for the reserved `TUTORIAL` id) |
| `phase add` / `phase new` / `phase import` | Yes | All route through `createPhase` |
| `task add` | No | Phase YAML only |
| `task complete` | No | `progress.yaml` (append-only) |
| `task finalize --write` / `phase reconcile --write` | No | Phase YAML only (`tasks[].status` flips) |
| `task start` / `task block` / `task resume` / `task status` | No | `progress.yaml` only, or read-only |

The four `createPhase` callers are the **only** code paths that mutate the roadmap. This is enforced structurally — no other module calls into the roadmap saver. Future commands that need to mutate the roadmap must go through `createPhase` (or land an RFC update that extends this writer list).

This is the structural truth in v1.5 and was the structural truth in v1.4 as well; P14's contribution is to **document** it, not to implement new enforcement. See [`docs/cli-contract.md` § Roadmap mutation policy (v1.5+ / P14)](../cli-contract.md#roadmap-mutation-policy-v15--p14) for the canonical matrix.

### 4. Phase status manual-flip convention

`phase reconcile <id> --write` flips **task** statuses in batch but never writes the phase's own `status` field. `phase_status_candidate` in the JSON envelope is advisory only — this contract has held since v1.2.0, and v1.5.0 formalizes it as the convention rather than treating it as transitional state.

Release-prep convention:

1. Run `code-pact phase reconcile <phase-id> --write` to flip task statuses.
2. **Hand-edit** the phase's own `status` field in `design/phases/<phase>.yaml` (typically in the release-prep PR).

Auto-flip implementation (e.g. a `--phase-status` flag on `phase reconcile`, or a separate `phase finalize` command) is **not part of v1.5** and is deferred to a future RFC. The rationale: phase status is often gated by non-task work (release prep, docs, manual cleanup) that no deterministic command can verify; the right home for that judgement call is human review, not the CLI.

See [`docs/concepts/finalization-reconciliation.md` § Phase status remains manual in v1.2 — formalized as the convention in v1.5+ / P14](finalization-reconciliation.md#phase-status-remains-manual-in-v12--formalized-as-the-convention-in-v15--p14) for the user-facing convention.

## Two pillars covered by existing docs

### Protected-path `--strict` posture

P14-T2 documented the existing `plan lint --strict` semantics for `TASK_WRITES_PROTECTED_PATH` without changing any code. The advisory has been a warning since P10 (v1.1+); `--strict`'s pre-existing binary promotion (`errors + warnings === 0`) makes it exit-relevant in CI use.

**Release-prep posture.** As of v1.5.1, the code-pact dogfood corpus is strict-clean: `plan lint --include-quality --strict --json` is expected to pass with zero warnings. Completed historical meta-design tasks do not keep protected design YAML writes declared solely to prove the advisory exists.

See [`docs/cli-contract.md` § Plan diagnostic codes → Task Readiness Schema diagnostics → `--strict`](../cli-contract.md#plan-diagnostic-codes) and [`docs/dogfood.md`](../dogfood.md) (Release prep section) for the canonical guidance.

### Declared writes as a governance review surface

P14-T3 documented that the `writes` field on a task (P10, v1.1+) and the `declared_writes[]` field on `task finalize --json` / `task runbook --json` envelopes (P11/P12, v1.2+/v1.3+) together form a **review surface**, not enforcement.

Today (v1.5):

- The surface IS a declaration of intent + a reviewable signal in CLI output (compare `declared_writes` against `git diff --name-only main...HEAD` in PR review).
- The surface is NOT enforced at runtime. `task complete` / `task finalize` / `phase reconcile` do NOT verify the agent's actual writes match the declaration.
- Actual write enforcement requires either a runner or VCS integration; both are P15+ scope.

See [`docs/concepts/finalization-reconciliation.md` § Declared writes as a governance review surface](finalization-reconciliation.md#declared-writes-as-a-governance-review-surface-v14--p14) and [`docs/concepts/runbook.md` § Declared writes as a governance review surface](runbook.md#declared-writes-as-a-governance-review-surface-v14--p14) for the canonical workflow.

## What's intentionally NOT in v1.5

The RFC § Non-goals enumerates deferrals. The headline items:

- **Configurable protected paths.** `PROTECTED_PATHS` stays hardcoded. A `project.yaml`-driven override is P15+.
- **Actual write enforcement against declared `writes`.** No git-diff comparison, no runner integration. Declared writes remain a review surface only.
- **Phase status auto-flip implementation.** Manual flip remains the release-prep convention. A future RFC may design a `phase reconcile --write --phase-status` flag or a `phase finalize` command; P14 does NOT.
- **`--force-lock` flag for stale lock recovery.** Manual delete is the only mechanism in v1.5.
- **Progress.yaml write locking.** The append-only contract (worst case = event reordering, not corruption) makes lock-free safe; locking the high-frequency `task complete` / `task start` / `task block` / `task resume` paths would add overhead without integrity benefit.
- **Lock TTL / automatic stale detection.** P14 ships manual-recovery; PID liveness checks are P15+.
- **Cross-phase / multi-project locking.** Single project, single lock file.
- **Configurable reserved-id list.** `TUTORIAL` is the only reserved id in v1.5.
- **`RESERVED_ID_USAGE` advisory plan-lint diagnostic on existing TUTORIAL phases.** P14 only blocks creation; existing TUTORIAL phases in user projects are not flagged.
- **New `--strict` semantics.** Existing binary promotion is preserved; selective per-code promotion (e.g. "promote only `TASK_WRITES_PROTECTED_PATH`") is P15+.

## Error / diagnostic taxonomy

One new public error code in v1.5.0:

| Code | Exit | Category | Trigger |
| --- | --- | --- | --- |
| `LOCK_HELD` | 2 | **public** (new) | Another `code-pact` mutation is in progress on the same project. `data.lock_holder` carries `{pid, hostname, cmd, created_at}`; `data.lock_path` is the lock file path. Transient + retryable |

Reused codes in P14 governance contexts:

| Code | Trigger in P14 |
| --- | --- |
| `CONFIG_ERROR` | `phase add --id TUTORIAL` / `phase import` containing TUTORIAL / `phase new` wizard typing TUTORIAL |
| `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` | Now emitted from the shared `src/core/plan/resolve-task.ts` (P14-T6 refactor; same error shape as v1.4) |
| `TASK_WRITES_PROTECTED_PATH` | (unchanged; documented as exit-relevant under `plan lint --strict`) |

`KNOWN_CODES.public` in `tests/unit/error-code-surface.test.ts` grows by exactly **one** entry in v1.5 (`LOCK_HELD`). The full public surface remains additive.

## See also

- [`design/decisions/governance-rfc.md`](../../design/decisions/governance-rfc.md) — the full accepted RFC with alternatives and open questions.
- [`docs/cli-contract.md`](../cli-contract.md) — Public codes table (LOCK_HELD), `§ Advisory write lock`, `§ Roadmap mutation policy`, `§ Reserved phase ids`, `§ Phase status manual-flip convention`.
- [`docs/migration.md` § v1.4.x → v1.5.0](../migration.md#v14x--v150) — adoption pattern, CI implications, backward compatibility.
- [`docs/concepts/sample-phase.md`](sample-phase.md) — the TUTORIAL artifact and the reserved-id rules from the user side.
- [`docs/concepts/finalization-reconciliation.md`](finalization-reconciliation.md) — P11 sibling. The commands P14's lock guards (`task finalize`, `phase reconcile`) live in detail here.
- [`docs/concepts/runbook.md`](runbook.md) — P12 sibling. The runbook is one of the read-only commands that does NOT acquire the lock.
- [`docs/concepts/task-readiness-fields.md`](task-readiness-fields.md) — P10 sibling. `writes` and `acceptance_refs` are the fields the protected-path advisory and the declared-writes review surface operate on.
