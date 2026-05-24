# RFC: Spec-conformance remediation + RFC-conformance test convention

**Status:** accepted (P28, 2026-05)
**Scope:** bring the P24 (`--budget-bytes`) and P26 (evidence harness v2) *implementations* into compliance with their already-accepted RFCs, and establish the durable convention that load-bearing RFC clauses are pinned by tests whose names quote the clause. This RFC does **not** amend `context-budget-rfc.md` or `evidence-harness-v2-rfc.md` — those documents are correct; the implementations drifted from them. No new public CLI surface, no new error code, no error-code rename.

> **P28 does not change the accepted P24/P26 contracts; it restores implementation and tests to match them.** Read every change below as spec *conformance*, never spec *revision*.
**Owners:** maintainer
**Related:**
- [design/decisions/context-budget-rfc.md](context-budget-rfc.md) (P24 — the elision-eligibility clauses the implementation must honour).
- [design/decisions/evidence-harness-v2-rfc.md](evidence-harness-v2-rfc.md) (P26 — the byte-measurement and per-agent denominator contracts the harness must honour).

## Status lifecycle

- This document opens at status **proposed** in the P28-T0 PR and flips to **accepted** in a small follow-up commit before P28-T1..T3 implementation lands, per the P21 / P24 / P26 / P27 precedent.
- P28-T0 is done only after a commit with `Status: accepted` has landed.

## Background

An external static review of the v1.13.3 tree found three divergences between accepted RFCs and their implementations. Each was re-verified against the source before this RFC opened:

1. **P24 elision eligibility is unconditional.** `context-budget-rfc.md` locks a *conditional* elision policy:
   - `related_decisions` is elidable **only** via the `context_size: large` "all decisions" expansion; task-id-matched decisions stay.
   - `rules` is elidable **only** via the `write_surface: high` "all rules" expansion; the default `applies_to`-matched subset never elides.

   The implementation's `ELISION_ORDER` (`src/core/pack/formatters/markdown.ts`) lists both unconditionally, and `applyBudgetElision` (`src/core/pack/index.ts`) drops them regardless of `context_size` / `write_surface`. Because `loadRules` returns `applies_to`-matched rules even when `write_surface != high`, and `loadDecisions` returns task-id-matched decisions even when `context_size != large`, `--budget-bytes` can drop context the RFC marks unelidable.

2. **P26 `pack_bytes` is a character count, not a byte count.** `scripts/harness/metrics.ts` computes `pack_bytes: packContent.length`. The metric is named `*_bytes` and the project locks `Buffer.byteLength(..., "utf8")` as the byte measurement everywhere else (core pack rendering already uses it). The values diverge for any non-ASCII pack content.

3. **P26 enabled-agent denominator is derived from observed signals, not declared state.** `scripts/harness/run.ts` builds the enabled-agent set from doctor issues plus progress events. An enabled agent with zero issues and zero events is omitted from `adapter-drift-by-agent.csv`, corrupting the `adapter_drift_rate_percent` denominator. The source of truth is `.code-pact/project.yaml` `agents[]`.

### Honest blast radius (why this is remediation, not a fire)

These shipped in v1.13.3 and none break the CLI for a normal invocation. With the current single enabled agent (`claude-code`) and a predominantly ASCII design corpus, divergences (2) and (3) are **latent** — today's committed baseline numbers are not materially wrong. Only (1) is a *currently observable* behavioural divergence, and only on the opt-in `--budget-bytes` path under budget pressure. P28 fixes all three because correctness and evidence fidelity are this tool's value proposition, but the priority order reflects reality: **T1 (P24) first; T2 (P26) is latent-correctness hygiene; T3 is documentation consistency.**

### The deeper finding

The P24 divergence survived a full test suite and the dogfood harness. The existing budget test (`tests/unit/core/pack/budget.test.ts`) hard-codes the *same* unconditional elidable set as `ELISION_ORDER` and asserts elision *happens* — it validates the bug rather than the RFC. A tool whose purpose is preventing design/implementation drift could not detect drift in itself. That is the gap P28 closes structurally.

## Decision

1. **Implement P24 conditional elision.** `applyBudgetElision` receives the readiness flags (`isLarge`, `isLargeWriteSurface`) and excludes `related_decisions` from the elidable set unless `isLarge`, and `rules` unless `isLargeWriteSurface`. When a non-elidable section keeps the pack over budget, `CONTEXT_OVER_BUDGET` fires with that section in `unelidable_sections` — the RFC-intended outcome. `completed_tasks`, `constitution`, and `reads` remain unconditionally elidable per the RFC order.

2. **Fix P26 byte counting and denominator.** `pack_bytes` uses `Buffer.byteLength(packContent, "utf8")`. The enabled-agent set is read from `.code-pact/project.yaml` (`enabled !== false`); doctor issues are bucketed onto that set so every enabled agent gets exactly one drift row. `scripts/harness/index.ts` re-exports the P26 builders (`buildLifecycleAdherenceRow`, `buildAdapterDriftRow`, `buildSummary`, `lowerPercentile`, `ratePercent`) for surface parity. Baseline artifacts under `design/measurements/` are regenerated from the corrected harness.

3. **Establish the RFC-conformance test convention.** Load-bearing RFC clauses are pinned by tests whose names quote the clause. For P24:
   - `does not elide default applies-to-matched rules under budget pressure (write_surface != high)`
   - `does not elide task-related decisions under budget pressure unless context_size: large`
   - `elides expanded all-rules under budget pressure when write_surface: high`
   - `elides expanded all-decisions under budget pressure when context_size: large`

   The pre-existing overbroad budget test is corrected, not deleted — it keeps asserting the elision *order* and the byte invariant for the cases the RFC genuinely permits.

## Non-goals (out of scope for P28)

- **No RFC amendments.** `context-budget-rfc.md` and `evidence-harness-v2-rfc.md` are correct as written; P28 changes code and tests to match them, not the reverse.
- **No new public CLI surface, flag, or error code; no error-code rename.** `CONTEXT_OVER_BUDGET` keeps its name and envelope.
- **No new feature work.** P25 (Spec Kit Bridge v2) stays unstarted; it is a roadmap item, not a P28 defect. P27's deferred full CLI split stays deferred; P27 shipped its committed task/adapter-cluster scope. T3 records these as documentation honesty, not as bugs.
- **No retroactive rewrite of shipped behaviour beyond RFC compliance.** The no-`--budget-bytes` default path stays byte-identical; `pack-byte-identical.test.ts` continues to pass unmodified.

## Backward compatibility

- `task context` / `task prepare` without `--budget-bytes` — byte-identical; unaffected.
- `task context --budget-bytes` — behaviour changes only for tasks where `related_decisions` / `rules` were previously elided despite not being the large/high expansion. Those sections now survive (or trigger `CONTEXT_OVER_BUDGET` if structurally required), which is the RFC-intended behaviour.
- `KNOWN_CODES.public` — unchanged.
- `design/measurements/` baseline — regenerated; numbers may shift slightly where non-ASCII content exists (none material today, see blast radius).

## Risks

1. **Baseline shift on regeneration.** Mitigation: regenerate in T2 and diff; document any non-trivial delta in CHANGELOG. With the current corpus the delta is expected to be ~0.
2. **T3 touches other phases' YAML.** Editing P21 / P24 / P27 phase YAML to fix nonexistent `writes` and a stale smoke command means writing protected paths. Mitigation: same bootstrap-write precedent as P27-T0 — protected-path edits are not listed in the task's `writes:` block and the audit deviation is documented; `--audit-strict` is dropped for T3 with that rationale recorded.

## Open questions

None at acceptance. The implementation site for the flag plumbing (`buildContextPack` → `applyBudgetElision` signature) follows the existing P24 structure.
