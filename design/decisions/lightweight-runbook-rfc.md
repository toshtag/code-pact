# RFC: Lightweight Runbook

**Status:** accepted (P12, 2026-05)
**Scope:** new commands `task runbook` and `phase runbook`; shared runbook helpers under `src/core/runbook/`; extraction of the reconcile classifier to `src/core/finalize/reconcile-classifier.ts` and export of `classifyTaskDrift` from `src/core/plan/analyze.ts`.
**Owners:** maintainer
**Related:** [task-readiness-schema](task-readiness-schema-rfc.md) (P10 — provides `depends_on` / `decision_refs` / `acceptance_refs` / `writes` the runbook reads) · [finalization-reconciliation](finalization-reconciliation-rfc.md) (P11 — provides `task finalize` / `phase reconcile` the runbook proposes as steps).

## Summary

Agents had to infer the next command from raw task/phase state. This RFC adds two **read-only** commands — `task runbook <task-id>` and `phase runbook <phase-id>`, Stable (v1.3+) — that return the recommended next steps as command strings and **never execute anything** (no `--write`, no `--execute`, no `--agent`), backed by pure helpers under `src/core/runbook/`. Zero new error codes; zero new schema fields. User-facing walkthrough: [docs/concepts/runbook.md](../../docs/concepts/runbook.md).

## Decisions

1. **Two read-only proposal commands.** `task runbook` (single task) and `phase runbook` (whole phase, including blocked tasks and reconcile candidates) emit command strings only. *Rationale:* the mutation commands (`task finalize`, `phase reconcile`) already own well-defined dry-run/`--write` contracts; the runbook's value is judgement, not orchestration. An `--execute` flag would duplicate that contract (footgun) or shell out (complexity).
2. **No `--agent` flag.** Runbook is sequencing guidance; the agent choice belongs to whichever step needs an adapter (e.g. `task context --agent ...`). Coupling runbook to an agent would push it into the adapter layer.
3. **Zero new error codes; zero new schema fields.** Reuse `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` / `PHASE_NOT_FOUND` / `CONFIG_ERROR`. `KNOWN_CODES.public` is unchanged. No `human_gate` task-schema field (see below).
4. **Manual checkpoints are `RunbookStep` content, not a schema field.** A gate is expressed as a step with `command: null` and a descriptive `manual_action`. *Rationale:* the gate semantics (when does it block? what unblocks it?) need more usage signal before locking into the schema. A future RFC may promote it if the `manual_action` vocabulary stabilizes.
5. **Phase status is never written.** `phase_status_candidate` is computed by the same simulation `phase reconcile` uses but surfaced as advisory only (consistent with `phase reconcile` in v1.2).
6. **Runbook uses `PlanState.taskIndex` directly** rather than extracting the task→phase resolver duplicated across 7+ commands. That broader refactor is deferred to P14 governance.
7. **Classifier layering.** P12-T2 extracts the reconcile classifier (private in `src/commands/phase-reconcile.ts`) into `src/core/finalize/reconcile-classifier.ts` and exports `classifyTaskDrift` from `src/core/plan/analyze.ts`; both `phase-reconcile.ts` and `src/core/runbook/` import from core. This preserves the `command → core` dependency direction (a pure refactor — the existing reconcile regression net passes unchanged).

This is a Stable-compatible **v1.3.0** release: every existing command (`task complete` / `finalize`, `phase reconcile`, `task context`, `task start`/`block`/`resume`/`status`, `plan analyze` / `lint`, `validate`, `doctor`, `recommend`) keeps its flags, envelope, exit codes, and error codes. `progress.yaml` is read-only for the new commands (append-only contract preserved). No required migration action; both commands are opt-in.

## Runbook model

A `RunbookStep` carries: `command` (`string | null`), `manual_action` (`string | null`), `reason` (required, human-readable), `blocking` (`boolean`), `safety_note` (`string | null` — null for read-only steps), `expected_result` (`string | null`).

Two invariants the builder enforces and tests assert:

- **JSON field presence is fixed.** Every field is present in JSON output regardless of value; a non-applicable field is emitted as `null`. Consumers need no field-absence branching.
- **Exactly one of `command` / `manual_action` is non-null** — never both, never neither.

Stepping over a `blocking: true` step is the user's call; the runbook never refuses to emit subsequent steps, it only labels which ones depend on the resolution.

## CLI contract

Both commands follow the existing `{ ok, data, error? }` envelope with `data.kind: "runbook"`. `task runbook` data carries `state_summary` (`design_status`, `derived_state`, `drift_kind`, resolved `depends_on`, `acceptance_refs_check`, `declared_writes`, `decision_refs`) plus ordered `next_steps`. `phase runbook` data carries `phase_summary` (`task_histogram`, `drift_histogram`, `phase_status_candidate`, advisory `phase_status_note`) plus `next_steps`.

Exit codes: `0` success (`next_steps` may be empty); `1` unused (no verification work); `2` for the reused error codes below. Both commands are added to `tests/integration/json-stdout.test.ts` so the JSON-only-stdout regression net covers them.

| Code | Exit | When |
| --- | --- | --- |
| `TASK_NOT_FOUND` | 2 | `task runbook` — task id not present in any phase |
| `AMBIGUOUS_TASK_ID` | 2 | `task runbook` — task id appears in more than one phase |
| `PHASE_NOT_FOUND` | 2 | `phase runbook` — phase id not in `roadmap.yaml` |
| `CONFIG_ERROR` | 2 | Missing positional id, or unknown flag |

### `recommend` vs `task runbook`

They answer different questions for the same task and coexist. **`recommend`**: *how* should this task be executed — model tier, effort, context profile, preflight commands, budget. **`task runbook`**: *what* should happen next in the lifecycle — the `task start` / `context` / implement / `complete` / `finalize` sequence, gated by `depends_on` and drift. Neither calls the other; bundling them is an open question (below).

## Task lifecycle guidance

Mapping from (derived state, design status, drift kind) → steps. `task start` is included explicitly in the primary loop so the progress log records who is working; `task status` is observational and not part of the loop.

| Derived state | Design status | Drift kind | Steps |
| --- | --- | --- | --- |
| planned (no events) | planned / in_progress | (none) | `task start` → `task context` → implement → `task complete` |
| started / resumed | planned / in_progress | (none) | continue implementation → `task complete` |
| blocked | planned / in_progress | (none) | manual_action: resolve recorded blocker → `task resume --reason "..."` (blocking) |
| failed | planned / in_progress | (none) | manual_review: diagnose → fix → re-run `task complete` (blocking) |
| done | planned / in_progress | done-but-design-not-done | `task finalize --write` (with dry-run safety_note) |
| done | done | (none) | empty step list (already consistent) |
| done | done | done-with-incomplete-events / done-blocked-conflict | manual_review pointing at `plan analyze`; mechanical flip intentionally refused |
| done | done | done-historical | empty step list (hidden by default in plan analyze; runbook respects that) |
| planned / in_progress | done | (design says done, progress disagrees) | manual_review; runbook does NOT propose flipping design status backward |

When `depends_on` has any non-`done` dependency, a **blocking step is emitted first**, before all others.

## Phase lifecycle guidance

`phase runbook` iterates `phase.tasks[]`, classifies each via the extracted reconcile classifier + `classifyTaskDrift` + `deriveTaskState`, then assembles `next_steps` in this priority order:

1. **Blocked tasks** (blocking) — per `blocked` task: a `manual_action` describing blocker resolution, then a deterministic `task resume <id> --reason "..."` step.
2. **Failed / complex-drift tasks** (blocking) — `failed`, or `done-blocked-conflict` / `done-with-incomplete-events`: a `manual_action` pointing at `plan analyze`. `phase reconcile` intentionally refuses these.
3. **Eligible reconcile batch** (non-blocking) — if ≥1 `flip` candidate, exactly one `phase reconcile <id> --write` step. Per-task `finalize` enumeration is intentionally avoided; the atomic batch is the point.
4. **In-progress hints** (non-blocking) — per `started` / `resumed` task, one `task runbook <id>` step; per-task judgement is delegated.
5. **Untouched ready tasks** (non-blocking) — per `planned` task with no events and satisfied deps, the four-step primary loop.
6. **Phase-status advisory** (non-blocking, manual_action) — if every task would be `done` post-reconcile, surface the manual phase-status flip as the final step.

## Alternatives considered

- **Executable runbook (`--execute`)** — rejected for v1.3; would duplicate the mutation commands' dry-run/`--write` contract or shell out. Revisit on usage signal.
- **Ship `task next` / `phase next` as primary names** — rejected; `next` overloads with `task status` ("what's happening now"). `runbook` is explicit. `task next` may ship as a sugar alias in P13.
- **Add `human_gate` to the task schema in P12** — rejected; gate semantics not settled. Expressed as `RunbookStep` content meanwhile.
- **Include init / planning UX polish in P12** — rejected per scope; Phase 1 confirmed every init/wizard/planning gap is "future hardening," not a runbook blocker. Deferred to P13 (recorded in `docs/migration.md` § Deferred beyond v1.3).
- **Emit STATUS_DRIFT hints for all 5 drift kinds in `plan analyze`** — rejected; the complex drifts need human judgement, not mechanical flip. Runbook surfaces them via `manual_review`; one surface should own the recommendation, not both.
- **`--agent` flag on runbook** — rejected; the agent choice belongs to the downstream command that needs an adapter.
- **Export `classifyTask` from `src/commands/phase-reconcile.ts`** — rejected; core importing from commands inverts the dependency. Extracted to `src/core/finalize/` instead.
- **Extract the task→phase resolver in P12** — rejected per scope (touches 7+ Stable commands). Runbook uses `PlanState.taskIndex`; the refactor is a P14 governance candidate.
- **`phase runbook` emits per-task finalize steps instead of one reconcile** — rejected; reconcile's atomic batch is the whole point (1 command vs 6).

## Open questions

1. **`task next` / `phase next` sugar aliases** — ship from day one or wait for usage signal? P13 candidate.
2. **`task runbook --execute`** — revisit after one release cycle of the read-only commands.
3. **`human_gate` schema field** — justified only if the `manual_action` vocabulary stabilizes. P13/P14 candidate.
4. **Multi-phase `phase runbook --all`** — natural extension; v1.3 ships per-phase only.
5. **STATUS_DRIFT hints for the other 4 drift kinds** — owned by `plan analyze` or left to `task runbook`? P13 candidate.
6. **`recommend` vs `task runbook` integration** — whether to bundle execution metadata into the sequencing runbook is an open UX question for P13.

## References

- RFCs: [task-readiness-schema](task-readiness-schema-rfc.md) (P10) · [finalization-reconciliation](finalization-reconciliation-rfc.md) (P11 — the `src/core/finalize/` namespace the extracted classifier joins) · [stability-taxonomy](stability-taxonomy.md) (the bands the runbook ships under).
- Code: [analyze.ts](../../src/core/plan/analyze.ts) (`classifyTaskDrift`) · [phase-reconcile.ts](../../src/commands/phase-reconcile.ts) (classifier extracted to `src/core/finalize/reconcile-classifier.ts`) · [task-state.ts](../../src/core/progress/task-state.ts) (`deriveTaskState`) · [state.ts](../../src/core/plan/state.ts) (`PlanState.taskIndex`).
- Docs: [docs/cli-contract.md](../../docs/cli-contract.md) · [docs/migration.md](../../docs/migration.md) · [docs/concepts/runbook.md](../../docs/concepts/runbook.md).
