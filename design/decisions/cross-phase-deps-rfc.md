# RFC: Cross-phase dependencies + aggregated runbook

**Status:** accepted (P19, 2026-05)
**Scope:** extend `depends_on` to accept cross-phase task references (e.g. `P15-T6`) so a phase can wait on work in another phase; add multi-node cycle detection over the new edge set; add `--across-phases` to `phase runbook` for release-prep-style multi-phase sequencing.
**Owners:** maintainer
**Related:** [task-readiness-schema](task-readiness-schema-rfc.md) (P10 — the task schema where `depends_on` lives) · [lightweight-runbook](lightweight-runbook-rfc.md) (P12 — the runbook semantics this extends) · [governance](governance-rfc.md) (P14 — the chokepoint contract constraining cross-phase ordering).

## Summary

Today `depends_on` ids must resolve **within the same phase**. That forces cross-phase ordering (release prep waiting on every feature task; a phase blocking on an earlier phase's leftover task) into prose — PR descriptions, CHANGELOG — which is fragile and unverifiable. This RFC makes the resolver and lint detectors look across phases, adds whole-graph cycle detection, and adds an aggregated runbook for "what's left before the next release ships". No schema-type change, no Phase YAML change, no public-error-surface growth.

## Decisions

1. **Accept cross-phase `depends_on` references.** The schema field stays `string[]` (`z.array(z.string().min(1)).optional()`) — no type change. Resolver and lint detectors look across phases when a same-phase lookup fails. **Rationale:** one honest field with a smarter resolver beats a second `cross_phase_depends_on` field that every consumer (`recommend`/`runbook`/`finalize`) would have to special-case.
2. **Add multi-node cycle detection** as `TASK_DEPENDS_ON_CYCLE` (severity **error**, `KNOWN_CODES.plan` bucket). Detects A→B→A, A→B→C→A, and longer cycles; emits one diagnostic per task in each SCC of size > 1, with `details.cycle: ["A","B","C"]` in traversal order. Self-cycles keep firing the existing, narrower `TASK_DEPENDS_ON_SELF_REFERENCE` (not collapsed into the new code). **Rationale:** error matches the existing self-reference severity, keeping the dep-graph family consistent; a silently-introduced cycle in a roadmap with real cross-phase deps is a costly footgun. A temporary cycle during a multi-PR refactor is handled by `plan analyze --skip <code>`, not by demoting to warning.
3. **Add `phase runbook --across-phases [--json]`.** Aggregates the existing per-phase runbook steps into one stream. Default (no flag) `phase runbook <id>` is unchanged. **Rationale:** a full-graph runbook of every phase is too noisy (done phases have no actionable steps; planned phases have no committed scope) — scoping to `in_progress` + their dependents keeps output relevant to "what's left right now".
4. **Update `task runbook` cross-phase display.** When `depends_on` references a cross-phase id, the dependency line names the foreign phase (e.g. `P15-T5 (P15, in_progress, derived: planned)`) so the agent knows which phase to consult.

## What this does NOT change

- The `depends_on` schema type (still `string[]`), `task finalize` eligibility (derived state `done` for every dep stays the gate — the resolver now also finds cross-phase deps), Phase YAML shape, and the `phase runbook` default invocation + JSON envelope.
- Same-phase detector behavior: same-phase resolution is tried **first**, cross-phase is the fallback. A typo like `P15-T44` present in no phase still surfaces `TASK_DEPENDS_ON_UNRESOLVED`.
- `KNOWN_CODES.public` size — the one new diagnostic lands in the `plan` bucket, which the v1.0 contract allows to grow additively (see [docs/cli-contract.md → Stability rules for codes](../../docs/cli-contract.md#stability-rules-for-codes-v10)).

## Contract surface

- **Id format:** a cross-phase reference is a normal task id; the resolver enforces no naming scheme. Uniqueness across phases is already guaranteed by `TASK_DUPLICATE_ID_GLOBAL`; if a duplicate slips through, the resolver picks the first match deterministically (sorted by phase id) and the duplicate diagnostic — not a stacked second warning — alerts the user.
- **`TASK_DEPENDS_ON_CYCLE`** — error, `KNOWN_CODES.plan`. `details.cycle` lists the cycle in traversal order. Iterative DFS (avoids stack overflow on deep chains).
- **`phase runbook --across-phases` envelope:** `data.kind: "aggregated_runbook"`, `data.phases_considered: string[]`, `data.steps[]` (each: `phase_id`, `step_kind`, `task_id`, `summary`). Steps ordered by phase id ascending, then by the existing single-phase runbook order (P12 contract). Phases included: status `in_progress`, plus phases whose tasks are dependencies of an `in_progress` phase task (one-level transitive closure). Excluded: `done`, `planned`, `cancelled`.
- **`task runbook` JSON:** `depends_on_check[]` entries gain an **optional** `phase_id`, present only for cross-phase resolutions (omitted for same-phase). Purely additive; consumers ignoring unknown fields are unaffected. No existing diagnostic is renamed, demoted, or removed.

## Alternatives considered

- **Separate `cross_phase_depends_on: string[]` field** — rejected; two fields for one concept invites drift and complicates every consumer. One field with a smarter resolver is more honest.
- **Promote cycles to *warning*** — rejected; a silently-introduced cycle is a costly footgun, and demoting incentivises deleting `depends_on` over fixing the cycle. Temporary refactor cycles use `plan analyze --skip`.
- **Full-graph `phase runbook` of every roadmap phase** — rejected; too noisy. Scope to `in_progress` + dependents.
- **Keep cross-phase deps in PR descriptions / CHANGELOG only (status quo)** — rejected; unverifiable and already drifted twice during v1.5 / v1.7 release prep.

## Open questions

None at acceptance. Cycle severity (error), resolver lookup order (same-phase first), `--across-phases` inclusion (in_progress + transitive deps), and `phase_id` placement (additive on `depends_on_check[]`) were all settled during P19-T1 drafting; implementation may surface edge cases warranting a follow-up amendment.

Deferred to a later RFC: `task runbook --across-phases` (per-task transitive aggregation); a `--auto-fix-cycles` mode (too opinionated for v1.9); cross-phase `acceptance_refs` (out of P19 scope — reads/writes/decision_refs/acceptance_refs already work file-path-wise across phases without schema changes).

## References

- RFCs: [task-readiness-schema](task-readiness-schema-rfc.md) (P10) · [lightweight-runbook](lightweight-runbook-rfc.md) (P12) · [governance](governance-rfc.md) (P14).
- Docs: [docs/cli-contract.md](../../docs/cli-contract.md) (`TASK_DEPENDS_ON_CYCLE`; stability rules for codes).
