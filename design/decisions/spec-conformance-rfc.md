# RFC: Spec-conformance remediation + RFC-conformance test convention

**Status:** accepted (P28, 2026-05)
**Scope:** bring the P24 (`--budget-bytes`) and P26 (evidence harness v2) *implementations* into compliance with their already-accepted RFCs, and establish the durable convention that load-bearing RFC clauses are pinned by tests whose names quote the clause. No RFC amendment, no new public CLI surface, no new error code, no error-code rename.
**Owners:** maintainer
**Related:** [context-budget](context-budget-rfc.md) (P24 — the elision-eligibility clauses the implementation must honour) · [evidence-harness-v2](evidence-harness-v2-rfc.md) (P26 — the byte-measurement and per-agent denominator contracts the harness must honour).

## Summary

P28 restores implementation and tests to the accepted P24/P26 contracts — it is spec *conformance*, never spec *revision*. An external static review of v1.13.3 found three divergences (all re-verified against source):

1. **P24 elision is unconditional but the RFC is conditional.** `ELISION_ORDER` (`markdown.ts`) and `applyBudgetElision` (`pack/index.ts`) drop `related_decisions` and `rules` regardless of `context_size` / `write_surface`. The RFC makes `related_decisions` elidable **only** via the `context_size: large` "all decisions" expansion (task-id-matched decisions stay) and `rules` elidable **only** via the `write_surface: high` "all rules" expansion (the default `applies_to`-matched subset never elides). So `--budget-bytes` can drop context the RFC marks unelidable.
2. **P26 `pack_bytes` is a char count, not a byte count.** `metrics.ts` uses `packContent.length`; the project locks `Buffer.byteLength(..., "utf8")` everywhere else. Values diverge for any non-ASCII content.
3. **P26 enabled-agent denominator is derived from observed signals, not declared state.** `run.ts` builds the enabled-agent set from doctor issues + progress events, omitting an enabled agent with zero of each and corrupting `adapter_drift_rate_percent`. The source of truth is `.code-pact/project.yaml` `agents[]`.

Blast radius: all shipped in v1.13.3; with the current single agent (`claude-code`) and a mostly-ASCII corpus, (2) and (3) are latent and committed baselines are not materially wrong. Only (1) is observably divergent, and only on the opt-in `--budget-bytes` path under budget pressure. The deeper finding motivating the test convention: the existing budget test hard-coded the *same* unconditional elidable set and asserted elision *happens* — it validated the bug, so a drift-prevention tool could not detect drift in itself.

## Decision

1. **Implement P24 conditional elision.** `applyBudgetElision` receives the readiness flags (`isLarge`, `isLargeWriteSurface`) and excludes `related_decisions` from the elidable set unless `isLarge`, and `rules` unless `isLargeWriteSurface`. When a non-elidable section keeps the pack over budget, `CONTEXT_OVER_BUDGET` fires with that section in `unelidable_sections` — the RFC-intended outcome. `completed_tasks`, `constitution`, and `reads` remain unconditionally elidable per the RFC order.

2. **Fix P26 byte counting and denominator.** `pack_bytes` uses `Buffer.byteLength(packContent, "utf8")`. The enabled-agent set is read from `.code-pact/project.yaml` (`enabled !== false`); doctor issues are bucketed onto that set so every enabled agent gets exactly one drift row. `scripts/harness/index.ts` re-exports the P26 builders (`buildLifecycleAdherenceRow`, `buildAdapterDriftRow`, `buildSummary`, `lowerPercentile`, `ratePercent`) for surface parity. Baselines under `design/measurements/` are regenerated from the corrected harness.

3. **Establish the RFC-conformance test convention.** Load-bearing RFC clauses are pinned by tests whose names quote the clause. For P24:
   - `does not elide default applies-to-matched rules under budget pressure (write_surface != high)`
   - `does not elide task-related decisions under budget pressure unless context_size: large`
   - `elides expanded all-rules under budget pressure when write_surface: high`
   - `elides expanded all-decisions under budget pressure when context_size: large`

   The pre-existing overbroad budget test is corrected, not deleted — it keeps asserting the elision *order* and the byte invariant for the cases the RFC genuinely permits.

## Contract surface

- `CONTEXT_OVER_BUDGET` keeps its name and envelope; `unelidable_sections` now carries non-elidable sections that hold the pack over budget. `KNOWN_CODES.public` unchanged.
- `task context` / `task prepare` without `--budget-bytes` is byte-identical and unaffected (`pack-byte-identical.test.ts` passes unmodified).
- `task context --budget-bytes` changes behaviour only where `related_decisions` / `rules` were previously elided despite not being the large/high expansion: those sections now survive, or trigger `CONTEXT_OVER_BUDGET` if structurally required — the RFC-intended behaviour.
- `design/measurements/` baselines are regenerated; numbers may shift slightly only where non-ASCII content exists (none material today).

## Non-goals

- **No RFC amendments.** `context-budget-rfc.md` and `evidence-harness-v2-rfc.md` are correct as written; P28 changes code and tests to match them, not the reverse.
- **No new public CLI surface, flag, or error code; no error-code rename.**
- **No new feature work.** Spec Kit Bridge v2 stays unstarted (an unscheduled future capability, not a numbered phase — `design/roadmap.yaml` enumerates no `P25` — and not a P28 defect); P27's deferred full CLI split stays deferred. These are recorded as documentation honesty, not bugs.

## Alternatives considered

- **Amend the RFCs to match the shipped code** — rejected; the RFCs are the correct contract and the value proposition is preventing exactly this drift. Fix code, not spec.
- **Delete the overbroad budget test** — rejected; correct it instead, so it still asserts the elision order and byte invariant for the cases the RFC permits.
- **Keep deriving the enabled-agent denominator from observed signals** — rejected; declared state (`project.yaml` `agents[]`) is the only source that counts a clean enabled agent.

## Open questions

None at acceptance. The flag-plumbing site (`buildContextPack` → `applyBudgetElision` signature) follows the existing P24 structure.

## References

- RFCs: [context-budget](context-budget-rfc.md) (P24) · [evidence-harness-v2](evidence-harness-v2-rfc.md) (P26) · [cli-maintainability](cli-maintainability-rfc.md) (P27).
- Code: `src/core/pack/index.ts` (`applyBudgetElision`) · `src/core/pack/formatters/markdown.ts` (`ELISION_ORDER`) · `scripts/harness/{metrics,run,index}.ts`.
