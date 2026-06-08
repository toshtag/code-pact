# RFC: Context budget enforcement

**Status:** accepted (P24, 2026-05)
**Scope:** add a `--budget-bytes <N>` flag to `code-pact task context` and `code-pact task prepare` that enforces a deterministic upper bound on the rendered context pack by progressively eliding sections in a fixed priority order. When the bound cannot be met without eliding always-included sections, the command fails with the new public error code `CONTEXT_OVER_BUDGET` (the only new code P24 introduces). The no-flag default path preserves the v1.11 byte-identical pack `content` contract. The `excluded[]` array in `task context --explain --json` gains `budget_reserved_for_later` emissions (the v1.11-reserved value finally activates). Adapter conformance is unaffected.
**Owners:** maintainer
**Related:** [agent-contract-v2](agent-contract-v2-rfc.md) (P21 — defines the section-level `bytes`/`reason_code` metadata `--explain` exposes and reserves `budget_reserved_for_later` for this RFC to activate) · [task-readiness-schema](task-readiness-schema-rfc.md) (P10 — `context_size`/`ambiguity`/`write_surface` already drive section inclusion; budget enforcement layers on top, not in place) · [evidence-harness-v2](evidence-harness-v2-rfc.md) (P26 — committed the `pack_size_*_bytes` baseline; the `pack_size_max_bytes: 259650` outlier is exactly what `--budget-bytes` targets).

## Summary

A deterministic, opt-in way to cap per-task context-pack size at invocation time. `--budget-bytes <N>` (additive, default off) enforces `Buffer.byteLength(content, "utf8") <= N` by dropping whole sections in a fixed priority order until the bound is met; if even maximal elision cannot fit, the command fails with `CONTEXT_OVER_BUDGET` and reports `minimum_achievable_bytes`. Motivated by the P26 dogfood baseline (`pack_size_p90_bytes` ~50 KB crowds Haiku-class windows; a single `pack_size_max_bytes` outlier of ~254 KB inlines a full RFC body). Bytes, not tokens, keep the measure model-agnostic and consistent with the project-wide `Buffer.byteLength(..., "utf8")` convention.

## Decisions

1. **`--budget-bytes <N>` on `task context` and `task prepare`** — additive flag, default off, combines freely with `--explain` and `--dry-run`. When set, the renderer enforces `Buffer.byteLength(content, "utf8") <= N`. `N` must be a positive integer; non-numeric / zero / negative values fail with `CONFIG_ERROR` (zero is rejected because the smallest meaningful pack is the minimum-pack composition — header + phase_contract + task_definition + verification_commands + progress_event_schema + format_overhead). On `task prepare`, the envelope's `context_pack_bytes` reflects the post-elision size; the suggested `commands` strings do **not** echo `--budget-bytes` back (it is per-invocation policy, not state).

   *Rationale:* agents/CI on context-constrained tiers need a deterministic cap at invocation time; the only alternative is each consumer re-implementing elision after the fact, losing determinism. Token budgets would force a per-model tokenizer dependency; bytes are a model-agnostic proxy already locked by `cli-contract.md`.

2. **Fixed elision priority (load-bearing — pinned by spec-conformance / context-fit RFCs).** Sections drop in this order until the budget is met:
   1. `completed_tasks` (only present under `ambiguity: high`; least task-specific signal)
   2. `related_decisions` when `context_size: large` (the "all decisions" path; decisions declared via `decision_refs` stay)
   3. `constitution` (project-wide, not task-specific)
   4. `rules` when `write_surface: high` (the "all rules" path; never elides the default applies-to-matched subset)
   5. `reads` (declared globs with matched paths — declaration only, no code body; elided last among declared-by-task sections)

   Sections **never** elided: `header`, `phase_contract`, `task_definition`, `depends_on`, `writes`, `declared_decisions`, `acceptance_refs`, `verification_commands`, `progress_event_schema`, `format_overhead`. These are always-included or carry task-declared intent the user opted into. The order is policy, not implementation detail: the elision-order constant lives next to `renderSections` so catalogue and policy stay one file apart.

   *Rationale:* drop least-task-specific signal first; protect task-declared intent last. The baseline shows the first two tiers (`completed_tasks`, `related_decisions`) are zero-cost on most tasks (most have neither), so the policy is conservative. The conditions (`ambiguity: high`, `context_size: large`, `write_surface: high`) are part of the contract — a section is only an elision candidate when its inclusion condition holds.

3. **`CONTEXT_OVER_BUDGET` when the budget is unachievable.** If every elidable section is dropped and the pack still exceeds the budget, the command fails with exit code **2** (mirrors CONFIG-class failures) and the new public code `CONTEXT_OVER_BUDGET` (joins `KNOWN_CODES.public`). `data` carries `budget_bytes`, `minimum_achievable_bytes` (size after maximal elision — the per-task floor), and `unelidable_sections` (what survived, so the caller knows what is structurally required and can split the task or trim declared decisions).

   *Rationale:* the floor is task-dependent (`task_definition` is task-specific), so it must be observable per invocation rather than assumed. `minimum_achievable_bytes` lets the caller adjust the budget or split the task deterministically.

4. **Activate `budget_reserved_for_later` in `--explain --json`.** When `--budget-bytes` triggers elision and `--explain --json` is set, each elided section appears in `excluded[]` with `reason_code: budget_reserved_for_later` and `details` (`elided_for_budget_bytes`, `section_bytes`). A section appears for at most one reason: budget elision applies only to sections that would otherwise have been included — a section already excluded by v1.11 inclusion policy (e.g. `constitution` for a `context_size: small` task) keeps its v1.11 reason. The P21 unit test asserting the value is never emitted stays correct (it runs without `--budget-bytes`); a P24 test asserts it IS emitted when elision triggers.

   *Rationale:* `--explain` was descriptive but not prescriptive; activating the reserved value turns it into an actionable, audited lever and retires the P21 dead-code reservation.

5. **Byte-identical default path.** Without `--budget-bytes`, `buildContextPack()` skips the elision pass; rendered `content` is byte-identical to v1.12 and `tests/integration/pack-byte-identical.test.ts` passes unmodified. On every path including `CONTEXT_OVER_BUDGET`, no pack is written and `progress.yaml` is not mutated (the P21-T3 progress-read-only invariant holds).

## Non-goals / deferred (out of scope for P24)

- **Agent-profile-derived default budget** — the flag stays opt-in per invocation. The agent → context-window mapping is itself a research problem. Deferred to a future RFC.
- **`--budget-tokens`** — would require per-model-family tokenizer libraries. Bytes are the model-agnostic proxy. Deferred.
- **Harness metric for post-budget pack size** — `pack_size_after_budget_*` depends on the chosen budget and would muddy the unconditional pack-size signal. Deferred.
- **Section-level truncation / summarisation** — P24 elides whole sections only; partial bodies would break Markdown or need per-section summaries that have no design.
- **No section reordering** — remaining sections keep their v1.11 relative order; budget only drops.
- **Budget enforcement on the legacy `code-pact pack` command** — not the preferred entry point; wiring it would expand surface without serving the agent loop.
- **No new flag on `adapter conformance`** — conformance checks adapter contract surfaces, not pack sizes.

## Alternatives considered

- **Post-process the pack downstream instead of a flag** — rejected; loses determinism and forces every consumer to re-implement elision with no documented order.
- **`--budget-tokens` instead of bytes** — rejected; needs a per-model tokenizer dependency. Bytes are model-agnostic and already the project's measurement unit.
- **Partial / mid-section truncation** — rejected; breaks Markdown structure or needs summary rendering that has no design. Whole-section elision only.
- **A configurable / agent-derived elision order** — rejected for P24; a single locked, documented order is conservative and auditable. Consumers needing a different order can re-elide from `--explain --json`; refinement is a future RFC.

## Open questions

None at acceptance. Implementation choices (where the elision pass sits in `buildContextPack`, whether to memoise byte counts during elision, exact i18n strings for the new error) follow existing P10 / P21 patterns and need no RFC-level decision. Known follow-on risk: future RFCs reusing `budget_reserved_for_later` for a different mechanism (e.g. token-budget) must either reuse this emission shape or coin a new reason code.

## References

- RFCs: [agent-contract-v2](agent-contract-v2-rfc.md) (P21) · [task-readiness-schema](task-readiness-schema-rfc.md) (P10) · [evidence-harness-v2](evidence-harness-v2-rfc.md) (P26 — baseline) · [stability-taxonomy](stability-taxonomy.md) (`CONTEXT_OVER_BUDGET` joins the public surface).
- Docs: [docs/cli-contract.md](../../docs/cli-contract.md) · [docs/migration.md](../../docs/migration.md) · [summary.json](../../docs/maintainers/measurements/summary.json) (the `pack_size_*_bytes` baseline).
