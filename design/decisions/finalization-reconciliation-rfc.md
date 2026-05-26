# RFC: Finalization & Reconciliation

**Status:** accepted (P11, 2026-05)
**Scope:** new commands `task finalize` and `phase reconcile`; additive `details.remediation` hint on the existing `STATUS_DRIFT done-but-design-not-done` issue; shared write-safety helpers under `src/core/finalize/`.
**Owners:** maintainer
**Related:** [design/decisions/task-readiness-schema-rfc.md](task-readiness-schema-rfc.md) (P10 — provides the `writes` and `acceptance_refs` fields P11 reads). [docs/migration.md § task complete records progress, but does NOT mutate design YAML](../../docs/migration.md) (the v1.0 contract P11 explicitly preserves).

## Summary

`task complete` records the operational fact in `progress.yaml` but deliberately never edits design intent, so a phase YAML's `status` field drifted until someone hand-edited it. This RFC adds `task finalize` (one task) and `phase reconcile` (a whole phase) to flip design `status` to `done` safely, plus a `remediation` hint on the existing `STATUS_DRIFT` warning. User-facing walkthrough: [docs/concepts/finalization-reconciliation.md](../../docs/concepts/finalization-reconciliation.md).

## Status lifecycle

- This document opens at status **proposed** in PR1.
- After review approval, and **before** PR1 merges, the maintainer flips the status line at the top of this file to **accepted**.
- P11-T1 (RFC acceptance) is considered done only after PR1 — with the status line reading `accepted` — has landed on main.
- Subsequent implementation PRs (P11-T2..T6) treat the accepted document as load-bearing. They may not change RFC decisions without a separate RFC-update PR.

## Background

`code-pact` ships an intentional split between **design intent** (`design/phases/*.yaml`) and **operational fact** (`.code-pact/state/progress.yaml`). `task complete` writes only to `progress.yaml`; the design YAML is never mutated by the v1.0 / v1.1 CLI. This is the explicit contract documented in `docs/migration.md` and tested by absence of writes from `src/commands/task-complete.ts` to any phase YAML.

The cost of that split is **design-vs-progress drift**: a task can be `done` in `progress.yaml` while its design YAML still reads `status: planned`. `code-pact plan analyze` reports this as `STATUS_DRIFT done-but-design-not-done` (warning). The dogfood corpus accumulates the drift every time a P-task PR lands, and the v1.0.0 / v1.0.1 / v1.0.2 / v1.1.0 release-prep PRs have all hand-edited design YAML statuses to clear it.

That hand-editing is exactly the kind of structured, repeatable mutation that should not be a manual maintainer step. P11 mechanizes it.

## Problem statement

1. Closing a task's design status after `task complete` is a manual YAML edit. It is easy to forget, easy to do wrong, and produces no audit trail beyond a regular commit.
2. Closing a phase's design status when all its tasks are done is also a manual YAML edit, with the same problems plus a small "is every task really done?" pre-check.
3. `plan analyze`'s `STATUS_DRIFT done-but-design-not-done` warning surfaces the drift but offers no remediation hint other than the migration-doc reference.
4. P10's `writes` and `acceptance_refs` declarations exist but have no consumer in the running CLI — they were always going to be P11 / P14 inputs.

## Goals

- Add `task finalize <task-id>` as a Stable (v1.2+) command that flips a single task's design status from `planned` / `in_progress` to `done` **only when a `done` event for that task already exists in `progress.yaml`**.
- Add `phase reconcile <phase-id>` as a Stable (v1.2+) command that runs `task finalize` for every task in the phase that is eligible, reporting partial successes via `applied_writes[]` / `skipped_writes[]` without failing the command on a partial write.
- Both commands default to **dry-run**; the `--write` flag is the explicit opt-in to mutate design YAML.
- Surface `task finalize` as the recommended remediation in the `done-but-design-not-done` STATUS_DRIFT issue, **additively** via `details.remediation`.
- Preserve the `task complete` contract, the `progress.yaml` append-only contract, the existing Stable (v1.0) flag / exit-code / JSON envelope / error-code surface, and the byte-identical `task context` pack for v1.0 / v1.1 tasks.

## Non-goals

- Changing `task complete` in any way.
- Mutating `progress.yaml`. P11 only ever reads it.
- Mutating `design/roadmap.yaml`. v1.2's release prep continues to flip P-status entries by hand in `design/roadmap.yaml`. P14 governance is the candidate consumer for an `--include-roadmap` opt-in.
- Auto-flipping a phase's `status` field. `phase reconcile` reports a `phase_status_candidate` suggestion but does not write it.
- Multi-phase reconcile (`--all`, `--every`, etc.). Per-phase only.
- Semantic validation of `acceptance_refs` content. P11 only checks the path exists.
- Detection of actual file writes against declared `writes`. No git dependency.
- Protected-section enforcement or configurable governance policy. P14 owns that.
- Advisory locks or concurrent-reconcile safety. P11 keeps the v1.0 single-process-owner assumption.
- Runbook integration (`task run` / `phase close`). P12 will consume `task finalize` / `phase reconcile` from the runbook layer; P11 keeps the commands user-callable only.
- Introducing `human_gate`. P12 RFC owns that field's design.
- LLM / RAG / MCP / issue-tracker integration.

## Proposed commands

### `task finalize <task-id> [--write] [--json]`

(No `--agent` flag — `task finalize` is a design/progress reconciliation command that never calls an adapter. Agent context belongs to the `task context` / `task complete` per-task loop, not here. If runbook integration in P12 needs to know which agent triggered a finalize, that lives on the runbook side.)

Default mode: **dry-run**. Returns the planned mutation without writing anything.

Eligibility: the task's `current` derived state from `progress.yaml` (via `deriveTaskState`) must equal `done`. Any other current state is treated as ineligible — including `planned` (no events), `started`, `blocked`, `resumed`, and `failed`. Ineligibility raises `TASK_FINALIZE_NOT_ELIGIBLE` (`ok: false`, exit 2) in **both** dry-run and `--write` modes. Dry-run means "won't write" — the eligibility validation is identical to the `--write` path so the dry-run output of a finalize-able task is a faithful preview of what `--write` would do.

Idempotency: when the task's design status is already `done`, the command returns `kind: already_finalized` with exit 0 in both modes.

JSON envelope (success):

```json
{
  "ok": true,
  "data": {
    "kind": "would_finalize" | "finalized" | "already_finalized",
    "task_id": "...",
    "phase_id": "...",
    "file": "design/phases/<phase>.yaml",
    "current_status": "planned" | "in_progress" | "done",
    "target_status": "done",
    "planned_writes": [{ "file": "...", "task_id": "...", "before": "planned", "after": "done" }],
    "applied_writes": [],
    "skipped_writes": [],
    "acceptance_refs_check": [{ "path": "...", "exists": true }],
    "declared_writes": ["..."],
    "depends_on_check": [{ "task_id": "...", "current": "done", "satisfied": true }]
  }
}
```

The fields are additive between kinds: `planned_writes` only appears under `would_finalize`; `applied_writes` / `skipped_writes` only appear under `finalized`; the rest appear under all kinds.

### `phase reconcile <phase-id> [--write] [--json]`

(No `--agent` flag — same reasoning as `task finalize`.)

Default mode: **dry-run**. Runs the same eligibility logic as `task finalize` against every task in the phase, in a single pass. Reports `tasks[]` with per-task verdicts; reports `phase_status_candidate` as a suggestion (computed from the post-flip state, **never written** in P11).

JSON envelope (success):

```json
{
  "ok": true,
  "data": {
    "kind": "would_reconcile" | "reconciled" | "no_eligible_tasks",
    "phase_id": "...",
    "file": "design/phases/<phase>.yaml",
    "tasks": [
      {
        "task_id": "...",
        "current_design_status": "planned",
        "derived_state": "done",
        "target_status": "done",
        "action": "flip",
        "reason": null
      }
    ],
    "planned_writes": [],
    "applied_writes": [],
    "skipped_writes": [{ "file": "...", "task_id": "...", "reason": "..." }],
    "phase_status_candidate": "done",
    "phase_status_note": "advisory — phase status is never written by phase reconcile in v1.2; flip by hand in release prep until P14"
  }
}
```

Partial success: `--write` mode does **not** raise an error when some tasks are flipped successfully and others are skipped. Both arrays are populated; exit 0 is returned. Only a complete failure (`PHASE_RECONCILE_WRITE_REFUSED`: had at least one eligible write but every attempted write was refused for safety reasons) raises an error. The "no eligible tasks in this phase" case is represented as `data.kind: "no_eligible_tasks"` with exit 0 — it is not an error.

## Dry-run / write model

- `--write` is always the **explicit opt-in** to mutate disk. Default is always dry-run.
- Dry-run output is **byte-identical** to what `--write` would have applied — `planned_writes[]` lists exactly the file paths and `before` / `after` values, and a subsequent `--write` execution starts from the same derived state (because `task complete` is the only thing that changes that state).
- `--write` is **idempotent**: re-running it on a task already in `status: done` returns `already_finalized` and writes nothing. Running it on a task whose `done` event has been removed from `progress.yaml` raises `TASK_FINALIZE_NOT_ELIGIBLE`.

## Reconciliation model

`phase reconcile <phase-id>` walks `phase.tasks[]` once and classifies each task into one of three actions:

- **flip** — the task has a `done` event in `progress.yaml` and `design_status != done`. Eligible for `--write`.
- **skip** — the task is already `design_status: done` (no change needed) OR derived state is `planned` with no events (genuinely not done, no drift). No action needed.
- **manual_review** — the task is in a drift state other than `done-but-design-not-done` — e.g. `done-blocked-conflict`, `done-with-incomplete-events`. `phase reconcile` will **not** touch these even with `--write`. The user is directed to `plan analyze` for diagnosis.

The `phase_status_candidate` field is computed by simulating the post-flip phase state and choosing `done` if every task would end up `done`, `in_progress` if any task is `started` / `blocked` / `resumed`, otherwise `planned`. It is **never written**.

## Drift taxonomy changes

- No new `STATUS_DRIFT.kind` is added.
- No existing kind changes name, severity, or `hidden_by_default`.
- The `done-but-design-not-done` issue's `details` payload gains an additive `remediation` field:

  ```json
  {
    "code": "STATUS_DRIFT",
    "severity": "warning",
    "details": {
      "kind": "done-but-design-not-done",
      "design_status": "planned",
      "derived_state": "done",
      "remediation": "code-pact task finalize <task-id>"
    }
  }
  ```

  The new key is additive on a `Record<string, unknown>` payload; existing JSON envelope consumers see no shape change.

## Safety model

- Writes are restricted to `design/phases/*.yaml`. `phase reconcile` rejects any write target that does not resolve via `resolveWithinProject` to a path under `design/phases/` whose basename ends in `.yaml`.
- `design/roadmap.yaml` is never written by P11.
- Path safety uses the existing `assertSafeRelativePath` / `resolveWithinProject` helpers from `src/core/path-safety.ts` (promoted in P10-T3).
- All writes go through `atomicWriteText` from `src/io/atomic-text.ts`. The pattern is: load phase YAML → zod-parse → mutate `tasks[].status` in memory → YAML stringify → atomic write. There is no partial-write code path.
- Symlink escape is caught by `resolveWithinProject`.
- Concurrency: P11 keeps the v1.0 single-process-owner assumption. Two concurrent `phase reconcile --write` runs on the same project are out of scope; the second one would either no-op (if the first finished) or last-writer-wins (if both raced the `rename` step). Advisory locks are P14.
- The new helper module `src/core/finalize/` is named to keep the namespace separate from `src/core/adapters/` (adapter-owned writes) and `src/io/` (raw write primitives). Plan lint, future P14 governance, and any future write-mutating command import from `src/core/finalize/`.

## JSON envelope / CLI contract

Both commands follow the existing `{ ok, data, error? }` envelope. The kind union under `data.kind` is a new pattern for these commands but matches the precedent set by `task complete` (`done` / `already_done` / `dry_run`).

Both commands are added to `tests/integration/json-stdout.test.ts` so the Stable (v1.2+) JSON-only stdout regression net covers them from day one.

Exit codes:

- `0` — success (dry-run or write), including `already_finalized`, partial success of `phase reconcile --write`, and `no_eligible_tasks` (which is informational, not failure).
- `1` — unused in P11 (verification failure does not apply here; finalize/reconcile do not run any user-defined commands).
- `2` — `TASK_FINALIZE_NOT_ELIGIBLE`, `TASK_FINALIZE_WRITE_REFUSED`, `PHASE_RECONCILE_WRITE_REFUSED`, `PHASE_NOT_FOUND`, `TASK_NOT_FOUND`, `AMBIGUOUS_TASK_ID`, `CONFIG_ERROR`.

## Error / diagnostic taxonomy

New public error codes (additive in `KNOWN_CODES.public`):

| Code | Severity | Triggered by |
| --- | --- | --- |
| `TASK_FINALIZE_NOT_ELIGIBLE` | error | `task finalize` in **either dry-run or `--write`** against a task whose derived state is not `done` (no done event, or stuck `blocked` / `started` / `resumed` / `failed`). Validation is identical between modes — dry-run is "won't write", not "won't validate". |
| `TASK_FINALIZE_WRITE_REFUSED` | error | the resolved write target is outside `design/phases/`, fails path safety (`resolveWithinProject`), or the phase YAML is not parseable as a Phase. Raised by `task finalize --write` only (dry-run has nothing to refuse). |
| `PHASE_RECONCILE_WRITE_REFUSED` | error | `phase reconcile --write` had **at least one eligible write** but every attempted write was refused for safety reasons (unsafe path, symlink escape, target outside `design/phases/`, unparseable phase YAML). **Not** raised for the "no eligible tasks in the phase" case — that is `data.kind: "no_eligible_tasks"` with exit 0. |

No existing error code is renamed or changes severity. The error-code surface contract (`tests/unit/error-code-surface.test.ts`) is updated to register the three new codes in the `public` category. `docs/cli-contract.md` gains rows for them in the public-codes table.

## Backward compatibility

- `task complete` is unchanged. Same flags, same JSON envelope, same exit codes, same error codes.
- `progress.yaml` is read-only for the new commands. The append-only operational-log contract is preserved.
- `plan analyze` JSON envelope shape is unchanged. The only addition is a new key under `details` on one existing kind — additive on a `Record<string, unknown>` payload, no break.
- `task context` pack output is unchanged. The byte-identical regression test against the golden fixture passes without modification.
- `tests/integration/json-stdout.test.ts` continues to pass for every existing Stable (v1.0) and Stable (v1.1) command. The two new commands are added to the test list at PR3 (`task finalize`) and PR4 (`phase reconcile`).
- `KNOWN_CODES.public` is extended (additive). No existing entry is removed or recategorized.

This is a Stable (v1.0 / v1.1) compatible release. In semver terms, it is **v1.2.0** when shipped.

## Migration story

Target: existing projects upgrading from v1.1.x to v1.2.0.

- **No required action.** All v1.1.x projects continue to work unchanged. `task finalize` and `phase reconcile` are opt-in.
- **Recommended adoption.** Stop hand-editing design YAML status fields in release-prep PRs. Use `code-pact phase reconcile <phase-id> --write` instead. The release-prep workflow becomes: bump version → write CHANGELOG → `code-pact phase reconcile <phase-id> --write` to flip task statuses → commit. The phase status itself continues to be flipped by hand in release prep (P11 does not auto-flip phase status; that may become a future opt-in).
- **CI under `--strict`.** Projects running `plan lint --strict` see no new errors. The `STATUS_DRIFT done-but-design-not-done` warning continues to fire pre-reconcile; once reconcile has flipped a task, the warning clears on the next `plan analyze` run.
- **Docs.** `docs/migration.md` gains a `v1.1.x → v1.2.0` section documenting the adoption pattern, the new error codes, and the dry-run/write contract.

## Alternatives considered

- **Make `task complete` mutate design YAML automatically.** Rejected. Breaks the v1.0 contract (intent vs fact split) which is documented and tested. Existing CI scripts and agent integrations depend on `task complete` being side-effect-free at the design layer.
- **Auto-flip phase status in `phase reconcile --write`.** Rejected for v1.2.0. Phase status is a coarser declaration than task status and often involves judgement calls about whether non-task work (release prep, manual cleanup, post-release fixes) is "done". An explicit opt-in (`--include-phase-status`) is a candidate for a future release once the v1.2.0 task-flip path has been used at scale.
- **Mutate `design/roadmap.yaml` in `phase reconcile --write`.** Rejected for P11. `roadmap.yaml` is meta-design surface that affects every phase; release prep is the natural place for it. P14 governance is a better home for a configurable mutation policy.
- **Multi-phase reconcile (`--all`).** Rejected for P11. Single-phase keeps the blast radius small. Once the per-phase flow is proven, an additive `--all` flag is a candidate.
- **Detect actual writes against declared `writes`.** Rejected. Requires a git dependency or a snapshot mechanism, both of which are out of scope. P11 surfaces the declarations as documentation; actual-write enforcement is P14 governance work.
- **Semantic validation of `acceptance_refs` content.** Rejected for P11. Path existence + display is enough to make the field useful; richer validation would couple finalize to acceptance-criteria format choices the project has not yet made.
- **`task finalize` writes to `progress.yaml` too** (e.g., a `finalized` event). Rejected. `progress.yaml` is the operational log of what `task complete` recorded; finalize is a design-layer command. Adding a new event type would complicate the v1.0 append-only contract for no observable gain.
- **Make `task finalize` a flag on `task complete` (`task complete --finalize`).** Rejected. Would couple two different mutations into one command and erode the v1.0 contract. Users who want one-step behaviour can write a tiny shell wrapper; the CLI keeps the actions separate.

## Open questions

1. **`phase reconcile` phase status flip flag.** Should v1.2.0 ship an `--include-phase-status` flag from day one (opt-in to phase status auto-flip after all tasks are done) or wait for usage signal? P11 ships without it; revisit once `task finalize` / `phase reconcile` have been used through one release cycle.
2. **Multi-phase reconcile.** `phase reconcile --all` is a natural extension. P11 ships per-phase only.
3. **`design/roadmap.yaml` mutation.** Whether release prep should be able to delegate the per-phase weight / status flip to a `roadmap reconcile` command is a future question. P14 governance is the candidate home.
4. **`task finalize` for tasks that have no `done` event but are in a terminal state via `failed`.** Currently treated as ineligible. If the project develops a convention for "abandoned tasks", a separate command (`task abandon`?) is the right home, not a flag on finalize.
5. **`plan analyze` other-kind remediation.** P11 only adds `details.remediation` for `done-but-design-not-done`. Whether the other four STATUS_DRIFT kinds also gain remediation hints is open — `done-blocked-conflict` and `done-with-incomplete-events` would each need a different hint, and none of them are mechanizable yet.

## Implementation slicing

This RFC, once accepted, is followed by six implementation PRs. Task numbering matches PR numbering (1:1) so the roadmap is readable in implementation order:

| PR | Task | Scope |
| --- | --- | --- |
| **PR1 (this RFC PR)** | P11-T1 | RFC + design/phases/P11 + roadmap entry. **No src/ changes.** |
| **PR2** | P11-T2 | Shared `src/core/finalize/` helpers (safe-write pattern, dry-run diff shape, write-refusal classifier). Lands BEFORE the command surfaces (T3 and T4 depend on these helpers). |
| **PR3** | P11-T3 | `task finalize` dry-run + `--write`. Error codes (`TASK_FINALIZE_NOT_ELIGIBLE`, `TASK_FINALIZE_WRITE_REFUSED`) ship here. KNOWN_CODES.public + docs/cli-contract.md sync. tests/integration/json-stdout.test.ts target list grows by one. |
| **PR4** | P11-T4 | `phase reconcile` dry-run + `--write`. `PHASE_RECONCILE_WRITE_REFUSED` ships here. `no_eligible_tasks` is a normal `data.kind` (exit 0), not an error code. Same sync targets as PR3. |
| **PR5** | P11-T5 | `plan analyze` additive `details.remediation` on `done-but-design-not-done`. Unit test asserts the new key. docs/cli-contract.md notes the additive field. |
| **PR6** | P11-T6 | docs/migration.md v1.1.x → v1.2.0 section. docs/getting-started.md per-task loop mention. docs/dogfood.md Troubleshooting entry for the new codes. docs/concepts/finalization-reconciliation.md walkthrough. |

The 6 tasks map to 6 PRs after the briefing's "PR2 dry-run + PR3 write" split was consolidated. The split made sense as a design heuristic — dry-run is the safer half — but in implementation the `task finalize` dry-run code path is structurally identical to the `--write` path with the final `atomicWriteText` call replaced by `data.kind = "would_finalize"`. Shipping them as one PR is small, reviewable, and avoids landing a half-command on main between PR3 and PR4. Same logic for `phase reconcile`.

## References

- [design/decisions/task-readiness-schema-rfc.md](task-readiness-schema-rfc.md) — P10 RFC. Provides the `writes` / `acceptance_refs` / `depends_on` fields that finalize / reconcile read.
- [design/decisions/stability-taxonomy.md](stability-taxonomy.md) — the v1.0 contract this RFC operates under.
- [src/commands/task-complete.ts](../../src/commands/task-complete.ts) — the model for "command that resolves task id without touching phase YAML body". Sets the JSON envelope kind-union precedent.
- [src/core/path-safety.ts](../../src/core/path-safety.ts) — the neutral path-safety helpers (P10-T3).
- [src/io/atomic-text.ts](../../src/io/atomic-text.ts) — atomic-write contract.
- [src/core/progress/task-state.ts](../../src/core/progress/task-state.ts) — `deriveTaskState`, the source of "is this task derivable-as-done?".
- [src/core/plan/analyze.ts](../../src/core/plan/analyze.ts) — `STATUS_DRIFT` classifier; receives the additive `details.remediation` hint in PR5.
- [tests/unit/error-code-surface.test.ts](../../tests/unit/error-code-surface.test.ts) — `KNOWN_CODES.public` contract.
- [tests/integration/json-stdout.test.ts](../../tests/integration/json-stdout.test.ts) — Stable (v1.x) JSON-only-stdout regression net.
- [docs/cli-contract.md](../../docs/cli-contract.md) — destination for the new command sections and the additive STATUS_DRIFT details note.
- [docs/migration.md](../../docs/migration.md) — destination for the v1.1.x → v1.2.0 section.
