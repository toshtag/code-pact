# RFC: Finalization & Reconciliation

**Status:** accepted (P11, 2026-05)
**Scope:** new commands `task finalize` and `phase reconcile`; additive `details.remediation` hint on the existing `STATUS_DRIFT done-but-design-not-done` issue; shared write-safety helpers under `src/core/finalize/`.
**Owners:** maintainer
**Related:** [task-readiness-schema](task-readiness-schema-rfc.md) (P10 — provides the `writes` / `acceptance_refs` / `depends_on` fields P11 reads) · [docs/migration.md](../../docs/migration.md) (the v1.0 contract: `task complete` records progress but does **not** mutate design YAML — P11 preserves it).

## Summary

`task complete` records the operational fact in `progress.yaml` but deliberately never edits design intent, so a phase YAML's `status` drifts until someone hand-edits it. This RFC adds **`task finalize`** (one task) and **`phase reconcile`** (a whole phase) to flip design `status` to `done` safely, plus a `remediation` hint on the existing `STATUS_DRIFT` warning. Both default to **dry-run**; `--write` is the explicit opt-in. User-facing walkthrough: [docs/concepts/finalization-reconciliation.md](../../docs/concepts/finalization-reconciliation.md).

## `task finalize <task-id> [--write] [--json]`

Flips a single task's design status from `planned` / `in_progress` to `done`. Stable (v1.2+). No `--agent` flag — finalize is a design/progress reconciliation command that never calls an adapter.

- **Eligibility:** the task's `current` derived state (via `deriveTaskState` over `progress.yaml`) must equal `done`. Any other state — `planned`, `started`, `blocked`, `resumed`, `failed` — is ineligible and raises `TASK_FINALIZE_NOT_ELIGIBLE` (exit 2) in **both** dry-run and `--write` modes. Dry-run means "won't write", not "won't validate" — so a dry-run of an eligible task is a faithful preview of `--write`.
- **Idempotency:** when design status is already `done`, returns `kind: already_finalized`, exit 0, writes nothing, in both modes.
- **Dry-run output is byte-identical to what `--write` applies:** `planned_writes[]` lists exact file paths and `before` / `after` values; `task complete` is the only thing that changes the derived state between a dry-run and a later `--write`.

JSON `data.kind`: `would_finalize` | `finalized` | `already_finalized`. Common fields: `task_id`, `phase_id`, `file` (`design/phases/<phase>.yaml`), `current_status`, `target_status: "done"`, `acceptance_refs_check[]` (path-exists only — no semantic validation), `declared_writes[]`, `depends_on_check[]`. `planned_writes[]` appears only under `would_finalize`; `applied_writes[]` / `skipped_writes[]` only under `finalized`.

## `phase reconcile <phase-id> [--write] [--json]`

Runs the same eligibility logic against every task in the phase in one pass. Stable (v1.2+). No `--agent` flag (same reasoning). **`phase reconcile --write` is the mechanized replacement for the hand-edited release-prep status flip.**

Per-task action classification:

- **flip** — has a `done` event and `design_status != done`. Eligible for `--write`.
- **skip** — already `design_status: done`, or derived `planned` with no events (genuinely not done, no drift).
- **manual_review** — a drift state other than `done-but-design-not-done` (e.g. `done-blocked-conflict`, `done-with-incomplete-events`). Never touched even with `--write`; user is directed to `plan analyze`.

JSON `data.kind`: `would_reconcile` | `reconciled` | `no_eligible_tasks`. Reports `tasks[]` with per-task verdicts, `planned_writes[]` / `applied_writes[]` / `skipped_writes[]`, and a `phase_status_candidate` advisory.

- **`phase_status_candidate` is never written in P11.** It is computed by simulating the post-flip state: `done` if every task would end `done`, `in_progress` if any is `started` / `blocked` / `resumed`, else `planned`. The accompanying `phase_status_note` says to flip the phase's own status by hand in release prep until P14.
- **Partial success does not error:** `--write` populates both `applied_writes[]` and `skipped_writes[]` and returns exit 0 when some flip and some are skipped. `no_eligible_tasks` is exit 0, not an error. Only `PHASE_RECONCILE_WRITE_REFUSED` (had ≥1 eligible write but every attempted write was refused for safety) raises.

## Safety model

- Writes are restricted to `design/phases/*.yaml` — `phase reconcile` rejects any target that does not resolve via `resolveWithinProject` to a path under `design/phases/` ending in `.yaml`. `design/roadmap.yaml` is never written by P11.
- Path safety uses `assertSafeRelativePath` / `resolveWithinProject` (`src/core/path-safety.ts`); symlink escape is caught there. All writes go through `atomicWriteText` (`src/io/atomic-text.ts`): load → zod-parse → mutate `tasks[].status` in memory → stringify → atomic write. No partial-write code path.
- **Concurrency:** P11 keeps the v1.0 single-process-owner assumption. Two racing `--write` runs are out of scope (no-op or last-writer-wins). Advisory locks are P14 ([governance](governance-rfc.md)).
- The helper module **`src/core/finalize/`** is namespaced apart from `src/core/adapters/` (adapter writes) and `src/io/` (raw primitives); plan lint, P14 governance, and future write-mutating commands import from it.

## CLI contract / error taxonomy

Additive on the existing `{ ok, data, error? }` envelope. v1.2.0, Stable (v1.0/v1.1) compatible: `task complete` is unchanged; `progress.yaml` stays read-only and append-only; `task context` pack output is byte-identical; `plan analyze` shape is unchanged.

New public error codes (additive in `KNOWN_CODES.public`):

| Code | Severity | Triggered by |
| --- | --- | --- |
| `TASK_FINALIZE_NOT_ELIGIBLE` | error | `task finalize` (dry-run **or** `--write`) against a task whose derived state is not `done`. |
| `TASK_FINALIZE_WRITE_REFUSED` | error | `task finalize --write` only: target outside `design/phases/`, fails path safety, or phase YAML unparseable. |
| `PHASE_RECONCILE_WRITE_REFUSED` | error | `phase reconcile --write` had ≥1 eligible write but every attempt was refused for safety. **Not** the "no eligible tasks" case (that is `kind: no_eligible_tasks`, exit 0). |

Exit codes: `0` success (dry-run, write, `already_finalized`, partial reconcile, `no_eligible_tasks`); `2` for the three codes above plus `PHASE_NOT_FOUND` / `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` / `CONFIG_ERROR`. Exit `1` is unused (no user-defined commands run).

**Drift taxonomy:** no new `STATUS_DRIFT.kind`; no existing kind changes name/severity. The `done-but-design-not-done` issue's `details` payload gains an additive `remediation: "code-pact task finalize <task-id>"` key — additive on a `Record<string, unknown>`, no envelope shape change.

## Alternatives considered

- **Make `task complete` mutate design YAML automatically** — rejected; breaks the documented-and-tested v1.0 intent-vs-fact split that CI and agent integrations depend on.
- **Auto-flip phase status in `phase reconcile --write`** — rejected for v1.2.0; phase status involves judgement about non-task work. An explicit `--include-phase-status` opt-in is a future candidate.
- **Mutate `design/roadmap.yaml` in reconcile** — rejected; roadmap is meta-design affecting every phase. Release prep / P14 governance is the better home for a configurable policy.
- **Multi-phase reconcile (`--all`)** — rejected for P11; single-phase keeps the blast radius small. Additive `--all` is a future candidate.
- **Detect actual writes against declared `writes`** — rejected; needs git/snapshot. P11 surfaces declarations for review; enforcement is P14.
- **Semantic validation of `acceptance_refs` content** — rejected; path-existence is enough without coupling to an acceptance-criteria format the project hasn't chosen.
- **`task finalize` writes a `finalized` event to `progress.yaml`** — rejected; finalize is a design-layer command, and a new event type would complicate the append-only contract for no observable gain.
- **Make finalize a flag on `task complete` (`--finalize`)** — rejected; couples two mutations and erodes the v1.0 contract. A shell wrapper covers one-step users.

## Open questions

1. **`phase reconcile --include-phase-status`** — ship the phase-status auto-flip opt-in from day one, or wait for usage signal? P11 ships without it; revisit after one release cycle.
2. **Multi-phase reconcile (`--all`)** — natural extension; P11 is per-phase only.
3. **`design/roadmap.yaml` mutation** — whether release prep can delegate the per-phase weight/status flip to a `roadmap reconcile`; P14 governance is the candidate home.
4. **Terminal-but-not-done tasks (`failed`)** — currently ineligible. A future "abandoned task" convention belongs in a separate command (`task abandon`?), not a flag on finalize.
5. **Remediation for other STATUS_DRIFT kinds** — P11 only adds `details.remediation` for `done-but-design-not-done`; the other kinds each need a different (not-yet-mechanizable) hint.

## References

- RFCs: [task-readiness-schema](task-readiness-schema-rfc.md) (P10 — the `writes` / `acceptance_refs` / `depends_on` fields read here) · [stability-taxonomy](stability-taxonomy.md) (the v1.0 contract this operates under) · [governance](governance-rfc.md) (P14 — advisory locks, protected-path enforcement).
- Code: [task-complete.ts](../../src/commands/task-complete.ts) (kind-union precedent) · [path-safety.ts](../../src/core/path-safety.ts) · [atomic-text.ts](../../src/io/atomic-text.ts) · [task-state.ts](../../src/core/progress/task-state.ts) (`deriveTaskState`) · [analyze.ts](../../src/core/plan/analyze.ts) (`STATUS_DRIFT` classifier).
- Docs: [docs/cli-contract.md](../../docs/cli-contract.md) · [docs/migration.md](../../docs/migration.md) · [docs/concepts/finalization-reconciliation.md](../../docs/concepts/finalization-reconciliation.md).
