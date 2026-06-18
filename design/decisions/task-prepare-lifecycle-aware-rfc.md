# RFC: task prepare lifecycle-aware

**Status:** accepted (P40, 2026-05)
**Scope:** make `task prepare`'s guidance surfaces honor `recommendation.lifecycleMode` (`full_loop` / `record_only` / `decision_loop`) — an additive `commands["record-done"]` key (every mode) plus a mode-aware `next_action.message`. No envelope-shape break, no new `next_action.type`, no behavioral change to `task complete` / `record-done` / `verify`.
**Owners:** maintainer
**Related:** `adr-downstream-commitments-rfc.md` (retired — P43; the `## Implementation commitments` surface this RFC dogfoods; the additive-one-key discipline). Authored as a `decision_loop` phase (P40-T0 `requires_decision`, gated on this RFC).

## Summary

`task prepare` already returns `recommendation.lifecycleMode`, but its guidance surfaces ignore it: the `commands` dict had 5 fixed keys and no `record-done`, and `next_action.message` was static per task-state and assumed `full_loop` ("complete"). So a `record_only` task was told to "complete" when it should run `task record-done`, and a `decision_loop` task was not told to resolve its ADR first. P40 closes that gap as a contract-shape change with explicit bloat risk.

## Decision: Option C (additive)

`commands` stays the **stable, mode-agnostic lookup table** — all 5 existing keys unchanged — and gains **one always-present `record-done` key** (additive, in every mode). The single **mode-aware "what next" surface is `next_action.message`**. No `recommended_flow` structure, no ordered-key array; `next_action.type` enum stays closed/unchanged.

**Rationale.** The crux is whether `commands` is a stable lookup table or the recommendation. It is a lookup table — the contract test iterates `Object.entries(commands)`, the e2e test indexes `commands.complete` / `commands.start`, and agent-contract documents it as "every per-task verb pre-formatted". Option C grows the contract by exactly one additive key (the same discipline `decision_commitments` followed in P43), keeps `commands` a complete verb table indexable by name in any mode, and puts guidance in one place. Honors "small surfaces, clear contracts" + v1 stability.

### `record-done` key — name and template

The key is **exactly `record-done`** (hyphen; accessed `commands["record-done"]`, not `record_done`). It is the **one non-runnable template** in the dict — `--evidence` is agent-supplied — emitted with an angle-bracket token:

```
code-pact task record-done <id> --agent <agent> --evidence "<verification you ran>"
```

This is honest (the agent must fill `--evidence`), mirrors that `record-done` is the one verb requiring agent-supplied proof, and raises no `Unknown option` (`--evidence` is a known flag). Present in **all** modes (full_loop too) — keeping presence mode-invariant avoids a "key varies by mode" contract wrinkle. docs/cli-contract notes it is not runnable verbatim.

### next_action.message — the one mode-aware surface

`messageFor` gains a `lifecycleMode` parameter, branched for the **two workable, pre-completion states only** (`start_task`, `continue_implementation`). The early-return states (done/blocked/failed) keep static messages — `recommendation` is `null` on those paths by construction, so the mode is unavailable. The mapping restates `lifecycle.ts` / `per-task-loop.md` semantics, inventing nothing:

| state | mode | message |
| --- | --- | --- |
| start_task | full_loop | Run task start, then implement, verify, and complete. |
| start_task | record_only | Run task start, implement, run project verification yourself, then record completion with `task record-done --evidence`. This is a lighter loop, not lighter verification. |
| start_task | decision_loop | Resolve/accept the gating ADR first; verification and completion-recording paths block on the decision gate. Then run task start, implement, and verify. |
| continue_implementation | full_loop | Implement, run verification, then complete the task. |
| continue_implementation | record_only | Implement, run project verification yourself, then record completion with `task record-done --evidence`. |
| continue_implementation | decision_loop | Resolve/accept the gating ADR first; verification and completion-recording paths block on the decision gate. Then implement and verify. |

**decision_loop does NOT decide complete-vs-record-done (verified).** `recommendLifecycleMode` returns `decision_loop` whenever `requires_decision` is true — highest priority, **independent of whether the ADR is accepted**. So a gated task stays `decision_loop` even after its gate resolves; the mode does NOT imply the post-gate completion path. The `decision_loop` message therefore states only the gate fact + the generic implement→verify step — it must **not** decide "complete" vs "record-done" for the agent. Advisory text only; no new gate, no resolved/unresolved branch. `verify` / `task complete` remain the enforcers; `decision_commitments` (P43) carries the concrete ADR work.

## Alternatives considered

- **Option B (filter `commands` per mode)** — rejected; removing `complete`/`finalize` for `record_only` is a breaking change to a v1-stable, additive-only, `.strict()` envelope, breaks any consumer reading `commands.complete`, and forces a deprecation/versioning story.
- **Option A (ordered-key hint array per mode)** — rejected; a second "what next" beside `next_action`, the exact "third representation" the backlog rejects ("which is authoritative?").
- **No-ops by design (non-goals):** no `recommended_flow` / ordered-key array / new `next_action.type` value (third representation / v1-breaking enum growth); no behavioral change to `task complete` / `record-done` / `verify` (lifecycleMode stays advisory); no `task context` echo; no JA rewrite of reference contracts.

## Open questions

- Stale full_loop-only `task prepare` guidance elsewhere in the docs tree: T2 greps for old "then complete"-style wording around prepare / record_only and fixes or links it. `per-task-loop.md` is **linked, not redefined** (P41 consolidated the lifecycle prose).

## Implementation commitments

The concrete downstream work this decision implies (P40 is itself a `requires_decision`/decision_loop phase, so this RFC dogfoods the P43 `## Implementation commitments` surface):

- [ ] T1: add the `record-done` key to `TaskPrepareCommands` + `buildCommands` (the `--evidence "<verification you ran>"` template), in every mode.
- [ ] T1: thread `recommendation?.lifecycleMode` into `messageFor` for the two workable states only; early-return states keep static messages.
- [ ] T1: the `decision_loop` message states only the gate fact + implement/verify — it does NOT decide complete-vs-record-done.
- [ ] T1: pin the `record-done` template (task record-done / `--evidence` / placeholder / no Unknown option) and the mode-aware messages in tests.
- [ ] T2: cli-contract + agent-contract reflect the additive `record-done` key and the mode-aware `next_action.message`; link (don't redefine) `per-task-loop.md`; grep the docs tree for stale full_loop-only prepare guidance. Phase `verification.commands` MUST include `pnpm check:docs` (T2 writes public docs).

## References

- RFCs: `adr-downstream-commitments-rfc.md` (retired; P43).
- Docs: [docs/cli-contract.md](../../docs/cli-contract.md) · [docs/agent-contract.md](../../docs/agent-contract.md) · per-task-loop.md (linked for `record_only` semantics).
