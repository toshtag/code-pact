# RFC: task prepare lifecycle-aware

- Status: accepted
- Phase: P40
- Date: 2026-05-31

## Problem

`task prepare` already returns `recommendation.lifecycleMode` (`full_loop` /
`record_only` / `decision_loop`), but its *guidance* surfaces ignore it:

- The `commands` dict is built by `buildCommands` (`src/commands/task-prepare.ts`)
  with 5 fixed keys (`context, start, verify, complete, finalize`) regardless of
  mode, and has **no `record-done` key**.
- `next_action.message` (`messageFor`) is static per task-state and assumes
  `full_loop` — `start_task` / `continue_implementation` literally say
  "complete".

So an agent on a `record_only` task is told to "complete" when it should run
`task record-done`, and a `decision_loop` task is not told to resolve its ADR
first. P40 closes that gap. It is a **contract-shape change with explicit bloat
risk**, so it is authored as a `decision_loop` phase (P40-T0 is
`requires_decision`, gated on this RFC being accepted).

## Contract-shape decision: Option C (additive)

`commands` stays the **stable, mode-agnostic lookup table** — all 5 existing keys
unchanged — and gains **one always-present `record-done` key** (additive, in
every mode). The single **mode-aware "what next" surface is
`next_action.message`**. No new `recommended_flow` structure; no ordered-key
array; `next_action.type` enum stays closed/unchanged.

### Why C, not the alternatives

The crux is whether `commands` is a stable *lookup table* or *the recommendation*.
It is a lookup table: the contract test iterates `Object.entries(commands)` and
the e2e test indexes `commands.complete` / `commands.start` — nothing consumes it
as an ordered flow, and agent-contract documents it as "every per-task verb
pre-formatted".

- **Option B (filter `commands` per mode)** — removing `complete`/`finalize` for
  `record_only` is a breaking change to a v1-stable, additive-only, `.strict()`
  envelope; it breaks the e2e test and any consumer reading `commands.complete`,
  and forces a deprecation/versioning story. Rejected.
- **Option A (an ordered-key hint array per mode)** — that is a second "what
  next" beside `next_action`, the exact "third representation" the backlog
  rejects ("which is authoritative?"). Rejected.
- **Option C** — grows the contract by exactly one additive key (the same
  discipline `decision_commitments` followed in P43), keeps `commands` a complete
  verb table indexable by name in any mode, and puts guidance in one place
  (`next_action.message`). Honors "small surfaces, clear contracts" + v1
  stability. **Chosen.**

### `record-done` key — name and template

The key is **exactly `record-done`** (hyphen; accessed `commands["record-done"]`,
not `record_done`). It is the **one non-runnable template** in the dict —
`--evidence` is agent-supplied — so it is emitted with an angle-bracket token:

```
code-pact task record-done <id> --agent <agent> --evidence "<verification you ran>"
```

This is honest (the agent must fill `--evidence`), mirrors that `record-done` is
the one verb requiring agent-supplied proof, and the parser raises no
`Unknown option` (`--evidence` is a known flag). docs/cli-contract notes it is
not runnable verbatim. Present in **all** modes (full_loop too) — keeping presence
mode-invariant avoids a "key varies by mode" contract wrinkle.

## next_action.message — the one mode-aware surface

`messageFor` gains a `lifecycleMode` parameter, branched for the **two workable,
pre-completion states only** (`start_task`, `continue_implementation`). The
early-return states (done/blocked/failed) keep static messages — `recommendation`
is `null` on those paths by construction, so the mode is unavailable. The mapping
restates `lifecycle.ts` / `per-task-loop.md` semantics, inventing nothing:

| state | mode | message |
| --- | --- | --- |
| start_task | full_loop | Run task start, then implement, verify, and complete. |
| start_task | record_only | Run task start, implement, run project verification yourself, then record completion with `task record-done --evidence`. This is a lighter loop, not lighter verification. |
| start_task | decision_loop | Resolve/accept the gating ADR first; verification and completion-recording paths block on the decision gate. Then run task start, implement, and verify. |
| continue_implementation | full_loop | Implement, run verification, then complete the task. |
| continue_implementation | record_only | Implement, run project verification yourself, then record completion with `task record-done --evidence`. |
| continue_implementation | decision_loop | Resolve/accept the gating ADR first; verification and completion-recording paths block on the decision gate. Then implement and verify. |

### decision_loop does NOT decide complete-vs-record-done (verified)

`recommendLifecycleMode` (`src/core/recommend/lifecycle.ts:34`) returns
`decision_loop` whenever `requires_decision` is true — **highest priority,
independent of whether the ADR is accepted**. So a gated task stays
`decision_loop` even after its gate resolves; the mode does NOT imply the
post-gate completion path (a gated docs/test task could still be completed via
either path). The `decision_loop` message therefore states only the gate fact
("resolve the ADR; verification and completion-recording paths block on it") and the generic implement→verify
step — it must **not** decide "complete" vs "record-done" for the agent. Advisory
text only; no new gate, no resolved/unresolved branch. The agent already has
`decision_commitments` (P43) for the concrete ADR work; `verify` / `task complete`
remain the enforcers.

## Documentation contract checklist

P40 changes a public JSON surface + agent guidance; drift is the dominant risk.

- **T1** writes: `src/commands/task-prepare.ts`, `src/cli/commands/task.ts`
  (human-summary `Commands:` block), `tests/integration/task-prepare-commands-contract.test.ts`,
  `tests/unit/commands/task-prepare.test.ts`, `CHANGELOG.md`.
- **T2** writes: `docs/cli-contract.md` (the `task prepare` envelope `commands`
  block + the `record-done` key-name/template note + the "next_action.message is
  the mode-aware surface" sentence), `docs/agent-contract.md` (the `task prepare`
  bullet), `CHANGELOG.md`. **Do not redefine** `per-task-loop.md` lifecycle prose
  — link to it for `record_only` (P41 consolidated it). Before finishing T2, grep
  the docs tree for stale full_loop-only `task prepare` guidance (old "then
  complete"-style wording around prepare / record_only); fix or link any found
  (add the file to `writes` if edited).
- Phase `verification.commands` MUST include `pnpm check:docs` (T2 writes public
  docs → the P43 `PHASE_DOCS_WRITE_NO_DOC_CHECK` guard).
- `closes P40` goes ONLY in the finalize step that flips the phase + tasks to
  `status: done` — never in a mid-phase CHANGELOG edit (rule #9 fails a "closes"
  claim while the phase is not done).

## Non-goals

- No `recommended_flow` structure, no ordered-key array, no new `next_action.type`
  value — the three would be the "third representation" / a v1-breaking enum
  growth the backlog rejects.
- No filtering of `commands` by mode (breaking change to a v1-stable envelope).
- No new gate or behavioral change to `task complete` / `task record-done` /
  `verify` — the lifecycleMode stays advisory; P40 only makes prepare's existing
  guidance reflect it.
- No `task context` echo, no JA rewrite of reference contracts.

## Tasks

- **P40-T0** — this RFC + phase registration (bootstrap). `requires_decision: true`
  (decision_loop phase), gated on this accepted RFC.
- **P40-T1** — `record-done` command key + mode-aware `next_action.message` + tests.
- **P40-T2** — docs (cli-contract + agent-contract) + the stale-guidance grep.

## Implementation commitments

The concrete downstream work this decision implies (P40 is itself a
`requires_decision`/decision_loop phase, so this RFC dogfoods the P43
`## Implementation commitments` surface):

- [ ] T1: add the `record-done` key to `TaskPrepareCommands` + `buildCommands`
      (the `--evidence "<verification you ran>"` template), in every mode.
- [ ] T1: thread `recommendation?.lifecycleMode` into `messageFor` for the two
      workable states only; early-return states keep static messages.
- [ ] T1: the `decision_loop` message states only the gate fact + implement/
      verify — it does NOT decide complete-vs-record-done.
- [ ] T1: pin the `record-done` template (task record-done / `--evidence` /
      placeholder / no Unknown option) and the mode-aware messages in tests.
- [ ] T2: cli-contract + agent-contract reflect the additive `record-done` key
      and the mode-aware `next_action.message`; link (don't redefine)
      `per-task-loop.md`; grep the docs tree for stale full_loop-only prepare
      guidance.
