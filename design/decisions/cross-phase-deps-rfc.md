# RFC: Cross-phase dependencies + aggregated runbook

**Status:** accepted (P19, 2026-05)
**Scope:** extend `depends_on` to accept cross-phase task references (e.g. `P15-T6`) so a phase can wait on work in another phase; add cycle detection covering the new edge set; add `--across-phases` to `phase runbook` for release-prep-style multi-phase sequencing.
**Owners:** maintainer
**Related:**
- [design/decisions/task-readiness-schema-rfc.md](task-readiness-schema-rfc.md) (P10 — the task schema where `depends_on` lives).
- [design/decisions/lightweight-runbook-rfc.md](lightweight-runbook-rfc.md) (P12 — the runbook semantics this RFC extends).
- [design/decisions/governance-rfc.md](governance-rfc.md) (P14 — the chokepoint contract that constrains cross-phase ordering).

## Status lifecycle

- This document opens at status **proposed** in PR1 (the P19-T1 PR), and the status line flips to **accepted** in a follow-up commit before merge, per the P11–P18 lifecycle precedent.
- P19-T1 is considered done only after PR1 — with the status line reading `accepted` — has landed on main.
- Subsequent implementation PRs (P19-T2..T4) treat the accepted document as load-bearing.

## Background

`depends_on` lives on each task and lists task ids that must reach derived state `"done"` before the depending task is finalize-eligible. Today (v1.8.0) the field is restricted to **same-phase ids**:

- `TASK_DEPENDS_ON_UNRESOLVED` (warning) fires when a `depends_on` entry references an id not found in the same phase's `tasks[]`.
- `TASK_DEPENDS_ON_SELF_REFERENCE` (warning) fires when a task lists its own id.
- Multi-node cycle detection (A → B → A) is **not** implemented — explicitly deferred per a code comment in [src/core/plan/checks.ts:237-238](../../src/core/plan/checks.ts#L237-L238).

This restriction is fine when a phase is fully self-contained, but breaks down for two common patterns observed in our own dogfood corpus:

1. **Release prep depends on every feature task in the same release window.** v1.8.0 release prep (PR #149) implicitly waited on P18-T1..T5; the chain was tracked by hand in PR descriptions, not in the schema. There was no machine-readable way to ask "what's left before v1.8.0 can ship?"
2. **A phase legitimately blocks on an earlier phase's leftover task.** Example: P15-T5 was deferred from the P15 cluster and is being closed later — but consumers (e.g. P19 aggregated runbook) need to know that closure happens before another phase can proceed past a certain point.

Today both patterns force the maintainer to encode cross-phase ordering in prose (PR descriptions, release notes, CHANGELOG) rather than in `depends_on`. That is fragile and unverifiable.

## Decision

1. **Accept cross-phase `depends_on` references.** The schema field stays `z.array(z.string().min(1)).optional()` — no type change. The resolver and lint detectors are extended to look across phases when a same-phase lookup fails.
2. **Add multi-node cycle detection.** A new lint code `TASK_DEPENDS_ON_CYCLE` (error, plan category — matches the existing `TASK_DEPENDS_ON_SELF_REFERENCE` severity for consistency) detects A → B → A, A → B → C → A, and any longer cycle. Self-cycles continue to fire the existing `TASK_DEPENDS_ON_SELF_REFERENCE` (we do not collapse them into the new code — they are a distinct, narrower diagnostic).
3. **Add `phase runbook --across-phases [--json]`.** The flag aggregates the existing per-phase runbook steps across every phase whose status is `in_progress` or whose tasks have unsatisfied cross-phase dependencies on `in_progress` phases. Default (no flag) behavior is unchanged.
4. **Update `task runbook` cross-phase display.** When a task's `depends_on` includes a cross-phase reference, the per-dependency line in the runbook output names the foreign phase (e.g. `P15-T5 (P15, in_progress, derived: planned)`) so the agent reading the runbook knows which phase to consult.

## What this does NOT change

- **The `depends_on` schema type.** Still `string[]`. No new field, no new shape.
- **Existing detector behavior for same-phase refs.** Same-phase resolution is tried first; cross-phase resolution is the fallback. A typo like `P15-T44` that doesn't exist in any phase still surfaces `TASK_DEPENDS_ON_UNRESOLVED`.
- **`task finalize` eligibility semantics.** `derived state === "done"` for every dep stays the gate. Cross-phase deps participate in the same gate — the resolver now finds them.
- **`KNOWN_CODES.public`.** One new diagnostic (`TASK_DEPENDS_ON_CYCLE`) goes under the existing `KNOWN_CODES.plan` bucket; the public-error surface stays size-stable.
- **Phase YAML shape.** No additions, no removals.
- **`phase runbook` default invocation.** Existing flag set + JSON envelope unchanged; `--across-phases` is purely additive.

## Cross-phase id format

A cross-phase reference is just a normal task id. The resolver does NOT enforce a particular naming scheme — id collisions across phases are already prevented by `TASK_DUPLICATE_ID_GLOBAL` (plan lint). In practice the convention is `P<n>-T<m>` because that's what `init` / `task add` produce, but the resolver works for any unique id.

## Lookup algorithm

```
For each task T in phase P:
  For each dep D in T.depends_on:
    if D appears in P.tasks[].id → resolve in P (same-phase, current behavior)
    else if D appears uniquely in some other phase Q.tasks[].id → resolve in Q (cross-phase)
    else → emit TASK_DEPENDS_ON_UNRESOLVED
```

The "uniquely" guard is enforced by the existing `TASK_DUPLICATE_ID_GLOBAL` check. If a duplicate slips through, the cross-phase resolver picks the first match deterministically (sorted by phase id) and the duplicate diagnostic is what alerts the user — we do not stack a second warning here.

## Cycle detection algorithm

Build a directed graph where nodes are task ids (across all phases) and edges are `from_task.id → dep` for each `dep` in `from_task.depends_on`. Then:

- Self-cycles (`a → a`) keep their existing dedicated diagnostic.
- For multi-node cycles, run a standard DFS-based detection (iterative implementation to avoid stack overflow on deep chains). For each strongly connected component of size > 1, emit one `TASK_DEPENDS_ON_CYCLE` per task in the component, with `details.cycle: ["A", "B", "C"]` listing the cycle in traversal order.

Severity: **error**. This matches the existing `TASK_DEPENDS_ON_SELF_REFERENCE` severity (also error), keeping the dep-graph diagnostic family internally consistent. The pragmatic concern that a multi-PR refactor might temporarily exhibit a cycle is real but rare — when it happens the maintainer either fixes the cycle in the same PR or ships a temporary `_skip` annotation (`plan analyze --skip <code>`); we do not pre-emptively demote to warning because a silently-introduced cycle in a roadmap with real cross-phase deps would be a costly footgun.

## `phase runbook --across-phases`

Aggregates the existing per-phase runbook steps into one stream:

```sh
code-pact phase runbook --across-phases --json
```

JSON envelope (success):

```json
{
  "ok": true,
  "data": {
    "kind": "aggregated_runbook",
    "phases_considered": ["P19", "P20"],
    "steps": [
      {
        "phase_id": "P19",
        "step_kind": "task_runbook",
        "task_id": "P19-T1",
        "summary": "..."
      },
      ...
    ]
  }
}
```

Steps are ordered by:

1. Phase id ascending.
2. Within a phase, by the existing single-phase runbook order (P12 contract).

Phases included: any phase whose status is `in_progress` AND any phase whose tasks are dependencies of an `in_progress` phase task (transitive closure, one level deep enough for release-prep semantics).

Phases excluded: `done`, `planned`, `cancelled`.

Default (no flag) behavior is **unchanged** — `phase runbook <id>` keeps emitting a single-phase runbook with the existing shape.

## `task runbook` cross-phase display

When `task.depends_on` references a cross-phase id, the runbook's dependency line names the foreign phase. The JSON envelope's `depends_on_check[]` entry gains an optional `phase_id` field (only present for cross-phase resolutions, omitted for same-phase — additive, field-presence-by-kind preserved).

```json
{
  "depends_on_check": [
    { "task_id": "P19-T1", "current": "done", "satisfied": true },
    { "task_id": "P15-T5", "current": "planned", "satisfied": false, "phase_id": "P15" }
  ]
}
```

## Backward compatibility

- Single-phase dogfood corpora keep working with no schema changes, no flag changes, no envelope changes.
- The `phase_id` field on `depends_on_check[]` entries is purely additive and only appears for cross-phase resolutions. JSON consumers that ignore unknown fields (the v1.0 expectation) are unaffected.
- The new `TASK_DEPENDS_ON_CYCLE` diagnostic is added to `KNOWN_CODES.plan` (which the v1.0 contract allows to grow additively — see [docs/cli-contract.md → Stability rules for codes](../../docs/cli-contract.md#stability-rules-for-codes-v10)).
- No existing diagnostic is renamed, demoted, or removed. `TASK_DEPENDS_ON_UNRESOLVED` continues to fire for true typos; it just stops firing when the missing id is actually present in another phase.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Add a `cross_phase_depends_on: string[]` field separate from `depends_on` | Two fields for the same concept invites drift and complicates every consumer (`recommend`, `runbook`, `finalize`). The schema is more honest with a single field whose resolver is smarter. |
| Promote cycles to plan-lint errors | Dogfood may exhibit temporary cycles during multi-PR refactors. Hard-fail would block legitimate WIP and incentivise people to delete `depends_on` rather than fix the cycle. Warning surfaces the issue without blocking. |
| Build a full-graph `phase runbook` of every roadmap phase | Too noisy. Done phases have no actionable steps; planned phases have no committed scope yet. Limiting to `in_progress` + their dependents keeps the output relevant to "what's left right now". |
| Encode cross-phase deps in PR descriptions / CHANGELOG only (status quo) | Unverifiable. No machine-readable way to ask "what's left before v1.9.0 ships?" Hand-tracking has already drifted twice during the v1.5 / v1.7 release prep PRs. |

## Open questions

None at proposal time. The cycle severity (warning vs error), the cross-phase resolver lookup order (same-phase first), the `--across-phases` inclusion criteria (in_progress + transitive deps), and the `phase_id` field placement (additive on `depends_on_check[]` entries) were all settled during P19-T1 drafting. Implementation may surface edge cases that warrant a follow-up amendment.

## Deferred to a later phase / RFC

- **`task runbook --across-phases`** (per-task aggregated runbook spanning every task this one transitively depends on). The phase-scoped aggregation in P19-T3 covers the release-prep use case; per-task aggregation can wait.
- **A `--auto-fix-cycles` mode** that proposes deletions to break the cycle. Too opinionated for v1.9; left for future RFC if cycles become common.
- **Cross-phase `acceptance_refs`** (referencing an acceptance artifact from a sibling phase). Out of scope for P19; reads / writes / decision_refs / acceptance_refs continue to work file-path-wise across phases without schema changes.

## Acceptance criteria

- This document carries `Status: accepted` before any P19-T2/T3/T4 implementation PR opens.
- `TASK_DEPENDS_ON_CYCLE` appears in `KNOWN_CODES.plan` and is documented in [docs/cli-contract.md](../../docs/cli-contract.md).
- `phase runbook --across-phases [--json]` ships with integration test coverage of the multi-phase aggregation behavior and the `done` / `planned` exclusion.
- `tests/integration/json-stdout.test.ts` continues to pass.
- No existing diagnostic is renamed, demoted, or removed.
- Phase YAML schema is unchanged.
- `task finalize` eligibility semantics are unchanged (the gate is still "every dep's derived state is `done`"); the only difference is the resolver now finds cross-phase deps.
