# RFC: Lightweight Runbook

**Status:** accepted (P12, 2026-05)
**Scope:** new commands `task runbook` and `phase runbook`; shared runbook helpers under `src/core/runbook/`; extraction of the reconcile classifier to `src/core/finalize/reconcile-classifier.ts` and export of `classifyTaskDrift` from `src/core/plan/analyze.ts`.
**Owners:** maintainer
**Related:** [design/decisions/task-readiness-schema-rfc.md](task-readiness-schema-rfc.md) (P10 — provides `depends_on`, `decision_refs`, `acceptance_refs`, `writes` that the runbook reads). [design/decisions/finalization-reconciliation-rfc.md](finalization-reconciliation-rfc.md) (P11 — provides `task finalize` / `phase reconcile` that the runbook proposes as steps).

## Summary

Agents had to infer the next command from raw task/phase state. This RFC adds two **read-only** commands — `task runbook` and `phase runbook` — that return the recommended next steps as command strings and never execute anything, backed by shared helpers under `src/core/runbook/`. User-facing walkthrough: [docs/concepts/runbook.md](../../docs/concepts/runbook.md).

## Status lifecycle

- This document opens at status **proposed** in PR1.
- After review approval, and **before** PR1 merges, the maintainer flips the status line at the top of this file to **accepted**.
- P12-T1 (RFC acceptance) is considered done only after PR1 — with the status line reading `accepted` — has landed on main.
- Subsequent implementation PRs (P12-T2..T5) treat the accepted document as load-bearing. They may not change RFC decisions without a separate RFC-update PR.

## Background

After P10 (task readiness fields) and P11 (finalize / reconcile), `code-pact` has the mechanical tools to keep design intent and operational fact in sync. But the user-facing question "what do I run next?" still requires reading multiple commands' JSON output, the migration docs, and the drift taxonomy. That cognitive load grows as the project does.

In practice the maintainer has been running a memorized command sequence per task: `task start` → `task context` → implement → `task complete` → `task finalize --write`. For a phase the sequence diverges based on how many tasks are in which state, whether any are blocked, whether reconcile is the right tool or hand-edits remain necessary. None of this is enforced by the CLI; all of it is in the maintainer's head and in scattered docs.

## Problem statement

1. The per-task and per-phase command sequence is implicit — it lives in `docs/dogfood.md`'s per-task flow and in the maintainer's muscle memory, not in a CLI-emitted form.
2. Agents and CI consumers cannot read "what to do next" from the existing JSON envelopes without re-implementing the state-machine + drift-classifier + reconcile-classifier logic.
3. `plan analyze` surfaces drift but only points at one command (`task finalize` via P11's `details.remediation`); the broader sequence (start → context → implement → complete → finalize) is invisible.
4. `recommend` returns execution metadata for one task but does not address sequencing across tasks within a phase.

## Goals

- Add `task runbook <task-id>` as a Stable (v1.3+) command that returns a deterministic list of recommended next steps for a single task.
- Add `phase runbook <phase-id>` as a Stable (v1.3+) command that returns the same for an entire phase, including blocked tasks and reconcile candidates.
- Both commands are **read-only**: they emit command strings, never execute. There is no `--write` flag.
- Step shape includes enough metadata (command, reason, blocking flag, safety note, expected result) for an agent or CI tool to act on the runbook without re-deriving state.
- Preserve every existing Stable contract — `task complete`, `task finalize`, `phase reconcile`, `task context`, `task start/block/resume/status`, `plan analyze`, `plan lint`, `validate`, `doctor`, `recommend` — including flag surface, JSON envelope, exit codes, and error codes.
- Introduce zero new error codes. Reuse `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` / `PHASE_NOT_FOUND` / `CONFIG_ERROR`.
- Introduce zero new task or phase schema fields.

## Non-goals

- Executing any runbook step. Both commands are proposal-only. A future RFC may revisit an `--execute` flag, but v1.3 explicitly does not ship one.
- Mutating `progress.yaml`, `design/phases/*.yaml`, or `design/roadmap.yaml` from the runbook commands.
- Auto-flipping phase status. The phase status candidate is surfaced as advisory only (consistent with `phase reconcile`).
- Multi-phase runbook (`--all`, `--every`). Per-phase only.
- Adding a `human_gate` field to the task schema. The concept is expressed as a `RunbookStep` whose `command` is null and `manual_action` is a text description. Schema-level promotion is deferred to P13 or later.
- Init / wizard / task-add UX polish, sample-phase non-interactive mode, plan-brief / plan-constitution non-TTY paths. All deferred to P13.
- Adapter / agent invocation from runbook. Neither command takes `--agent`.
- LLM / RAG / MCP / multi-agent orchestration / scheduler / issue-tracker integration.
- Extracting the duplicated task→phase resolver across 7+ existing commands. Runbook uses `PlanState.taskIndex` directly; the broader refactor is P14 governance candidate.
- A `task next` / `phase next` short-form alias (open question; may ship in P13 as a sugar layer).

## Proposed commands

### `task runbook <task-id> [--json]`

Returns the recommended next steps for the given task.

JSON envelope (success):

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
        "reason": "Task is done in progress.yaml but design status is still planned. `task finalize` is the deterministic resolver.",
        "blocking": false,
        "safety_note": "This is a --write operation. Preview first with `code-pact task finalize P9-T5 --json` (dry-run).",
        "expected_result": "design/phases/P9-*.yaml task status flips planned → done; STATUS_DRIFT done-but-design-not-done clears on next plan analyze."
      }
    ]
  }
}
```

**`RunbookStep` field presence is fixed.** Every field is present in JSON output, with `null` where not applicable. **Exactly one of `command` / `manual_action` is non-null** — never both, never neither. The renderer enforces this invariant; tests assert it.

When the task is already in a `done`/`done` consistent state, `next_steps` is empty and `state_summary` carries `drift_kind: null`.

When `depends_on` contains an unsatisfied dependency, the runbook emits a blocking step **first**, before any other step:

```json
{
  "command": null,
  "manual_action": "Wait for P9-T4 to reach derived state: done (currently: started)",
  "reason": "Task P9-T5 depends on P9-T4 (current: started). All subsequent steps are blocked until the dependency resolves.",
  "blocking": true,
  "safety_note": null,
  "expected_result": null
}
```

No `--agent` flag — task runbook is a guidance command and never calls an adapter. If the runbook recommends `task context`, the user invokes that command with their own `--agent` choice.

### Relationship to `recommend`

`recommend` and `task runbook` answer different questions for the same task and are intended to coexist:

- **`recommend`** answers: **"How should this task be executed?"** — model tier, effort, context profile, preflight commands, ambiguity action, budget profile.
- **`task runbook`** answers: **"What should happen next in the task lifecycle?"** — the sequence of `task start` / `task context` / implementation / `task complete` / `task finalize` etc., gated by `depends_on` and drift state.

Both commands take a task id; neither calls the other. Bundling them (e.g. having `task runbook` include `recommend` output inline) is an open question deferred to P13.

### `phase runbook <phase-id> [--json]`

Returns recommended next steps for the phase as a whole.

JSON envelope (success):

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
      "phase_status_note": "advisory — phase status is never written by phase runbook (or by phase reconcile in v1.2)"
    },
    "next_steps": [
      {
        "command": "code-pact phase reconcile P12 --write",
        "manual_action": null,
        "reason": "Two tasks (P12-T1, P12-T2) are done in progress.yaml but design status is still planned. `phase reconcile --write` flips them in one atomic batch.",
        "blocking": false,
        "safety_note": "This is a --write operation. Preview first with `code-pact phase reconcile P12 --json` (dry-run).",
        "expected_result": "design/phases/P12-*.yaml two task statuses flip planned → done."
      },
      {
        "command": "code-pact task runbook P12-T3 --json",
        "manual_action": null,
        "reason": "Task P12-T3 is in derived state `started` — run its task-level runbook to see the per-task next step.",
        "blocking": false,
        "safety_note": null,
        "expected_result": null
      }
    ]
  }
}
```

Priority order for `next_steps`:

1. **Blocked tasks — resume guidance** (blocking). For each `blocked` task, emit one `manual_action` step describing the blocker resolution, followed by a `task resume <id> --reason "..."` command step. Blocker resolution is a human concern, but the resume command itself is deterministic.
2. **Failed / complex-drift tasks — manual_review** (blocking). For `failed` state or `done-blocked-conflict` / `done-with-incomplete-events` drift, emit a `manual_action` step pointing at `plan analyze` for diagnosis. These drifts need human judgement; `phase reconcile` intentionally refuses them.
3. **Eligible reconcile batch** (non-blocking). If at least one task is a `flip` candidate, emit exactly one `phase reconcile <id> --write` step. Per-task `task finalize` enumeration is intentionally avoided — reconcile's atomic batch is the whole point.
4. **In-progress task hints** (non-blocking). For each `started` / `resumed` task, emit one `task runbook <task-id>` step. Per-task judgement is delegated to task runbook.
5. **Untouched ready tasks** (non-blocking). For each `planned` task with no events and all dependencies satisfied, emit the four-step primary loop: `task start <id>` → `task context <id>` → implementation → `task complete <id>`.
6. **Phase-status advisory** (non-blocking, manual_action). If every task would be `done` post-reconcile, surface the manual phase-status flip as the final step.

## Runbook model

A `RunbookStep` has the following shape:

```typescript
type RunbookStep = {
  command: string | null;        // null when manual_action is set
  manual_action: string | null;  // null when command is set
  reason: string;                // human-readable; required
  blocking: boolean;             // when true, downstream steps assume this is resolved first
  safety_note: string | null;    // null when no safety concern (read-only steps)
  expected_result: string | null;
};
```

**JSON field presence is fixed.** Every `RunbookStep` field is present in JSON output regardless of value. When a field does not apply to the step, it is emitted as `null`. JSON consumers can therefore assume the schema is constant across step kinds; no field-absence branching is required.

**Invariant.** Exactly one of `command` / `manual_action` is non-null — never both, never neither. The builder enforces this; tests assert it.

Stepping over `blocking: true` is the user's call. The runbook never refuses to emit subsequent steps — but it labels which ones depend on the resolution.

## Task lifecycle guidance

Mapping from (derived state, design status, drift kind) → recommended steps. `task start` is the state-machine transition from `planned` → `started`; the runbook includes it explicitly in the primary loop so the progress log records who is working on the task. `task status` is observational and is **not** part of the primary loop:

| Derived state | Design status | Drift kind | Steps |
| --- | --- | --- | --- |
| planned (no events) | planned / in_progress | (none) | `task start <id>` → `task context <id>` → implementation → `task complete <id>` |
| started / resumed | planned / in_progress | (none) | continue implementation → `task complete <id>` |
| blocked | planned / in_progress | (none) | manual_action: resolve the blocker recorded in last `blocked` event → `task resume <id> --reason "..."` (blocking: true) |
| failed | planned / in_progress | (none) | manual_review: diagnose failure → fix → re-run `task complete <id>` (blocking: true) |
| done | planned / in_progress | done-but-design-not-done | `task finalize <id> --write` (with dry-run safety_note) |
| done | done | (none) | empty step list (already consistent) |
| done | done | done-with-incomplete-events / done-blocked-conflict | manual_review step pointing at `plan analyze` for diagnosis. These drifts need human judgement; mechanical flip is intentionally refused |
| done | done | done-historical | empty step list (hidden by default in plan analyze; runbook respects that) |
| planned / in_progress | done | (the "in-progress-no-events" mirror — design says done but progress disagrees) | manual_review step. Runbook does NOT propose flipping design status backward; that requires human review |

`depends_on` adds a blocking step at the head when any dependency is not `done`.

## Phase lifecycle guidance

The phase runbook iterates `phase.tasks[]`, classifies each task using the extracted reconcile classifier (`src/core/finalize/reconcile-classifier.ts`) + `classifyTaskDrift` (from `src/core/plan/analyze.ts`) + `deriveTaskState`, and then assembles steps in the priority order above. The `phase_status_candidate` field is computed by the same simulation logic that `phase reconcile` uses, but is never written.

## Human gate / manual checkpoint handling

P12 does NOT introduce a `human_gate` field on the task schema. The need for a schema-level gate is real — some tasks legitimately require human review before completion — but the precise semantics (when does the gate block? what unblocks it? how does an agent know?) need more usage signal before locking.

Until that signal exists, the runbook expresses manual checkpoints as ordinary `RunbookStep`s with `command: null` and a descriptive `manual_action`. Examples:

- `manual_action: "Review external dependency closure"` — for a task that's done in code but waiting on a non-code signal.
- `manual_action: "Flip P12 phase status to done by hand in design/phases/P12-*.yaml"` — for the phase-status advisory at end of phase runbook.

A future RFC (P13 or later) may promote this to a schema field if the manual_action vocabulary stabilizes.

## Planning UX / init UX boundary

Out of scope. Phase 1 exploration confirmed that every init / wizard / planning-prompt / task-add UX gap is already documented as "future hardening" and is not a runbook prerequisite. P12 ships runbook only; P13 owns init / planning UX polish. The decision is explicitly recorded in `docs/migration.md` § Deferred beyond v1.3.

## JSON envelope / CLI contract

Both commands follow the existing `{ ok, data, error? }` envelope. The `data.kind` is `"runbook"` for both.

Both commands are added to `tests/integration/json-stdout.test.ts` so the Stable (v1.3+) JSON-only stdout regression net covers them from day one.

Exit codes:

- `0` — success (a valid runbook was emitted; `next_steps` may be empty).
- `1` — unused (runbook does no verification work).
- `2` — `TASK_NOT_FOUND`, `AMBIGUOUS_TASK_ID`, `PHASE_NOT_FOUND`, `CONFIG_ERROR`.

## Error / diagnostic taxonomy

No new public error codes. Reused:

| Code | Exit | When |
| --- | --- | --- |
| `TASK_NOT_FOUND` | 2 | `task runbook` — task id is not present in any phase |
| `AMBIGUOUS_TASK_ID` | 2 | `task runbook` — task id appears in more than one phase |
| `PHASE_NOT_FOUND` | 2 | `phase runbook` — phase id is not present in `roadmap.yaml` |
| `CONFIG_ERROR` | 2 | Missing positional id, or unknown flag |

`KNOWN_CODES.public` in `tests/unit/error-code-surface.test.ts` is unchanged.

## Backward compatibility

- `task complete` / `task finalize` / `phase reconcile` / `task context` / `task start` / `task block` / `task resume` / `task status` / `plan analyze` / `plan lint` / `validate` / `doctor` / `recommend` — unchanged. Same flags, same JSON envelope, same exit codes, same error codes.
- `progress.yaml` is read-only for the new commands. The append-only operational-log contract is preserved.
- `task context` pack output is unchanged. The byte-identical pack regression test passes without modification.
- `tests/integration/json-stdout.test.ts` continues to pass for every Stable (v1.0 / v1.1 / v1.2) command. The two new runbook commands are added to the test list at PR3 (`task runbook`) and PR4 (`phase runbook`).
- `KNOWN_CODES.public` is unchanged.
- No new task or phase schema field. v1.2.x phase YAMLs parse and behave identically.
- The reconcile classifier extraction (P12-T2) is a pure refactor of code that has always been an implementation detail of `phase reconcile`; no external consumer was depending on its location. The existing `tests/unit/commands/phase-reconcile.test.ts` regression net continues to pass without modification.

This is a Stable (v1.0 / v1.1 / v1.2) compatible release. In semver terms, it is **v1.3.0** when shipped.

## Migration story

Target: existing projects upgrading from v1.2.x to v1.3.0.

- **No required action.** All v1.2.x projects continue to work unchanged. `task runbook` and `phase runbook` are opt-in.
- **Recommended adoption.** Add `task runbook <id>` to the per-task agent loop after `task context` if the agent needs sequencing guidance. Add `phase runbook <id>` to release-prep workflow as a sanity check before `phase reconcile --write`.
- **CI under `--strict`.** Projects running `plan lint --strict` / `plan analyze --strict` / `validate --strict` see no new errors and no new warnings.
- **Docs.** `docs/migration.md` gains a `v1.2.x → v1.3.0` section. `docs/concepts/runbook.md` is the conceptual walkthrough.

## Alternatives considered

- **Make runbook executable (`task runbook --execute`).** Rejected for v1.3. The mutation commands (`task finalize`, `phase reconcile`) already have well-defined dry-run / `--write` contracts. Letting runbook execute them would either duplicate the contract (footgun) or call them as sub-processes (complexity). The runbook's value is judgement, not orchestration. Revisit if usage signal warrants.
- **Ship `task next` / `phase next` as primary names.** Rejected because `next` overloads conceptually with `task status` ("what's currently happening"). `runbook` is more explicit: "here's the recommended sequence of actions." `task next` may ship as a sugar alias in P13.
- **Add `human_gate` to the task schema in P12.** Rejected. The semantics are not clear enough yet (when does it block? what unblocks it? does it interact with `task complete`?). Runbook expresses manual checkpoints as `RunbookStep` content; a future RFC promotes if needed.
- **Include init / planning UX polish in P12.** Rejected per scope decision. Phase 1 exploration confirmed every init / wizard / planning gap is documented as "future hardening" not "blocker." Bundling them into P12 risks scope creep with no engineering payoff.
- **Emit STATUS_DRIFT remediation hints for all 5 drift kinds (continuation of P11-T5).** Rejected for P12. `done-blocked-conflict` and `done-with-incomplete-events` need different remediation than `done-but-design-not-done` (they require human judgement, not mechanical flip). Runbook surfaces this directly via `manual_review` steps. Adding partial hints to `plan analyze` would conflict with that surface; either runbook OR analyze hints should own the recommendation, not both.
- **Make runbook take `--agent` flag.** Rejected. Runbook is sequencing guidance; the agent choice belongs to whichever command in the sequence needs an adapter (e.g. `task context --agent ...`). Coupling runbook to an agent would push it into the adapter layer's responsibility.
- **Export `classifyTask` directly from `src/commands/phase-reconcile.ts`.** Rejected on layering grounds. The runbook lives in `src/core/runbook/`; importing from `src/commands/` would invert the dependency direction (core depending on command). Instead, P12-T2 extracts the classifier into `src/core/finalize/reconcile-classifier.ts` (P11's existing core namespace), and both `phase-reconcile.ts` and `src/core/runbook/` import from there. `command → core` direction preserved.
- **Extract task→phase resolver in P12 to remove the 7+ duplications.** Rejected per scope. The refactor touches 7+ existing Stable commands, multiplying review surface and regression risk. Runbook uses `PlanState.taskIndex` directly. The broader refactor is P14 governance candidate.
- **Make `phase runbook` emit per-task finalize steps individually instead of a single reconcile.** Rejected. The whole point of `phase reconcile` is the atomic batch flip. Enumerating per-task finalize steps would push the user toward 6 commands when 1 suffices.

## Open questions

1. **`task next` / `phase next` sugar aliases.** Should v1.3.0 ship a short-form alias from day one or wait for usage signal? P12 ships `runbook` only; alias revisit in P13.
2. **`task runbook --execute`.** A future flag that runs each recommended step automatically. Out of scope for v1.3; revisit once `task runbook` / `phase runbook` have been used through one release cycle.
3. **`human_gate` schema field.** P12 expresses manual checkpoints as `RunbookStep` content. Whether a task-schema field is justified depends on whether the manual_action vocabulary stabilizes. P13 / P14 candidate.
4. **Multi-phase `phase runbook --all`.** Natural extension. P12 ships per-phase only.
5. **STATUS_DRIFT remediation hints for the other 4 kinds.** P11-T5 added a hint only for `done-but-design-not-done`. Whether the other 4 kinds (each needing different remediation) get hints in `plan analyze`, or rely entirely on `task runbook` to surface them, is open. P13 candidate.
6. **`recommend` vs `task runbook` integration.** Both commands take a task id and return guidance. `recommend` is execution metadata (model / effort / context); `runbook` is sequencing. Whether to bundle them (e.g. `runbook` calls `recommend` internally and includes the result) is an open UX question for P13.
7. **init / planning UX polish (P13 scope).** All deferred per RFC § Non-goals. P13 RFC should pick up the gap inventory from this RFC's Phase 1 exploration.

## Implementation slicing

This RFC, once accepted, is followed by five implementation PRs. Task numbering matches PR numbering (1:1):

| PR | Task | Scope |
| --- | --- | --- |
| **PR1 (this RFC PR)** | P12-T1 | RFC + design/phases/P12 + roadmap entry. **No src/ changes.** |
| **PR2** | P12-T2 | Shared helpers: (a) export `classifyTaskDrift` from `src/core/plan/analyze.ts` (same-module export; analyze.ts is core layer). (b) Extract the reconcile classifier currently private inside `src/commands/phase-reconcile.ts` into new `src/core/finalize/reconcile-classifier.ts`. `phase-reconcile.ts` becomes a thin command wrapper that imports the core classifier — preserves the `command → core` dependency direction. (c) New `src/core/runbook/` module with `RunbookStep` / `RunbookContext` types, `resolveDependsOnStates`, `buildTaskRunbook`, `buildPhaseRunbook`. Pure functions only (no I/O). Lands BEFORE the command surfaces (T3 / T4 depend on it). Existing `tests/unit/commands/phase-reconcile.test.ts` must continue to pass without changes (pure refactor for the classifier extraction). |
| **PR3** | P12-T3 | `task runbook` command. Reuses TASK_NOT_FOUND / AMBIGUOUS_TASK_ID. No new error codes. tests/integration/json-stdout.test.ts grows by one. docs/cli-contract.md gains a `task runbook` section annotated Stable (v1.3+). |
| **PR4** | P12-T4 | `phase runbook` command. Reuses PHASE_NOT_FOUND. No new error codes. Same sync targets as PR3. |
| **PR5** | P12-T5 | docs/migration.md v1.2.x → v1.3.0 section + Deferred beyond v1.3 with explicit init/UX polish defer; docs/getting-started.md per-task loop mention; docs/dogfood.md Per-task flow step; docs/concepts/runbook.md walkthrough. |

## References

- [design/decisions/task-readiness-schema-rfc.md](task-readiness-schema-rfc.md) — P10. Provides `depends_on`, `decision_refs`, `acceptance_refs`, `writes`.
- [design/decisions/finalization-reconciliation-rfc.md](finalization-reconciliation-rfc.md) — P11. Provides `task finalize` / `phase reconcile` and the `src/core/finalize/` namespace where the extracted reconcile classifier will live.
- [design/decisions/stability-taxonomy.md](stability-taxonomy.md) — Stability bands the runbook ships under.
- [src/core/progress/task-state.ts](../../src/core/progress/task-state.ts) — `deriveTaskState` (already exported).
- [src/core/plan/analyze.ts](../../src/core/plan/analyze.ts) — `classifyTaskDrift` (currently private, exported by P12-T2 in place since analyze.ts is already core layer).
- [src/commands/phase-reconcile.ts](../../src/commands/phase-reconcile.ts) — `classifyTask` (currently private; P12-T2 extracts it to `src/core/finalize/reconcile-classifier.ts` and rewires `phase-reconcile.ts` to import the core helper, preserving the `command → core` dependency direction).
- [src/commands/task-finalize.ts](../../src/commands/task-finalize.ts) — `depends_on` resolver pattern (P12-T2 extracts as `resolveDependsOnStates`).
- [src/core/plan/state.ts](../../src/core/plan/state.ts) — `loadPlanState` + `PlanState.taskIndex` for direct task→phase lookup.
- [tests/unit/error-code-surface.test.ts](../../tests/unit/error-code-surface.test.ts) — `KNOWN_CODES.public` (unchanged in P12).
- [tests/integration/json-stdout.test.ts](../../tests/integration/json-stdout.test.ts) — Stable JSON-only-stdout regression net (extended by P12-T3 / T4).
- [docs/cli-contract.md](../../docs/cli-contract.md) — destination for the new command sections.
- [docs/migration.md](../../docs/migration.md) — destination for the v1.2.x → v1.3.0 section.
