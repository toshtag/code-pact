# RFC: Context Fit

**Status:** accepted (P46, 2026-06)
**Scope:** make context pack size controllable, explainable, deterministic, and ergonomic via four additive layers over P24's `--budget-bytes` — (a) named **budget profiles** + `--context-budget <profile>`, (b) a recommended budget surfaced on `recommend` / `task prepare`, (c) **explain fit metrics**, (d) opt-in **plan-lint context-bloat advisories**. The no-flag default pack stays byte-identical; every JSON change is additive; advisories never affect exit code. No new compaction, summarization, tokenizer, proxy, or network behavior.
**Owners:** maintainer
**Related:** [context-budget](context-budget-rfc.md) (P24 — `--budget-bytes`, the fixed `ELISION_ORDER`, `CONTEXT_OVER_BUDGET`; this is the future RFC P24's Non-goals deferred. P24's elision order and byte-measurement are load-bearing here and are **not** changed) · [agent-contract-v2](agent-contract-v2-rfc.md) (P21 — `task context --explain` + per-section `bytes`/`reason_code` the explain metrics extend) · [task-readiness-schema](task-readiness-schema-rfc.md) (P10 — `context_size`/`ambiguity`/`write_surface`/`decision_refs`/`reads` drive the recommended budget and advisories) · [adr-quality-advisory](adr-quality-advisory-rfc.md) (P36 — the `affects_exit: false` pattern the readiness layer reuses).

## Summary

P24 shipped a deterministic byte cap (`--budget-bytes <N>`) enforced by eliding whole sections in a fixed order. Two gaps were left open on purpose: the budget is a raw magic number with no ergonomic name, and `--explain` is descriptive but never reports the pack's **natural** (pre-elision) size, the bytes a budget **saved**, or the achievable **floor** on a successful build. There is also no readiness-time warning that a task will produce a large or unachievable pack. Context Fit closes these with four additive layers, all built on the unchanged P24 path. User principle: **prefer local deterministic computation over agent reasoning** — when the tool can derive a fact, it should, so the agent reads and re-derives less.

## Reduction taxonomy

The central distinction, because the two carry **opposite risk**:

1. **Safe deterministic avoidance (preferred; may be default where it already is).** The tool uses local deterministic logic to avoid asking the agent to do work the tool can compute itself — glob expansion, byte/`write_surface` measurement, schema/validation results, the write audit, pack-size diagnostics, lint advisories, structured command outputs. This cuts agent input **without dropping task-relevant evidence**. "Avoidance" means computing a fact for the agent or skipping work it never needed — it does **not** license dropping declared or included pack evidence on a "looks derivable" heuristic.
2. **Risk-bearing reduction (never hidden, never default-on for the pack).** Any reduction that removes, rewrites, summarizes, ranks, or excerpts *task-relevant evidence* can lower output quality or add follow-up turns — a worse pack can cost *more* total tokens than it saved. Such reductions must be explicit (opt-in), explainable (`--explain`), and measurable, and must never apply silently to the default pack. P24 whole-section elision is the only sanctioned reduction today, opt-in via `--budget-bytes` / `--context-budget`.

The byte-identical default applies to the **pack content** — the agent's evidence base. Safe deterministic avoidance on *non-pack* surfaces (computing a fact in `recommend` / `plan lint` / `task prepare`) is not a "reduction" of the pack at all, and is encouraged.

## Standard profile vocabulary (single source of truth)

Exactly **three** standard profile names with **built-in fallback byte values**, defined here once and referenced by every layer:

| Profile    | Fallback `max_bytes` | Fit (vs. the P26 dogfood baseline) |
| ---------- | -------------------- | ----------------------------------- |
| `tight`    | `30000`              | Above `pack_size_p50_bytes` (20725): most small/medium tasks fit; constrained tiers. |
| `balanced` | `60000`              | Above `pack_size_p90_bytes` (50131): ~90% of tasks fit without elision. |
| `wide`     | `120000`             | Generous margin below the `pack_size_max_bytes` outlier (259650); large/ambiguous tasks. Still byte-capped — **not** a no-elision promise. |

Values bracket the committed P26 baseline (`docs/maintainers/measurements/summary.json`), so each is a real percentile boundary, not a round number. An agent profile may **override** any value by declaring a same-named profile; otherwise the fallback applies. The recommendation layer only ever emits one of these three names. `wide` is deliberately not `full`/`max` (those read as a no-elision guarantee) and not `large` (collides with `context_size: large`).

## Layer (a) — budget profiles + `--context-budget`

The agent profile schema gains an **optional** `context_budget` block: a `profiles` map of `name → { max_bytes }` (positive integer) plus an optional `default_profile` that must name a listed profile. A missing block is valid and backward compatible — it is **not** applied automatically to any command; there is no implicit default-budget behavior. Custom names beyond the standard three are permitted here, but only the standard three carry built-in fallbacks and only they are ever recommended.

`task context` and `task prepare` gain `--context-budget <profile>`:

- Resolves to the profile's `max_bytes`, then uses the **unchanged** P24 enforcement path (same elision order, same `CONTEXT_OVER_BUDGET` on an unachievable budget).
- `--context-budget` and `--budget-bytes` are **mutually exclusive** → `CONFIG_ERROR` (mirrors `plan brief`'s three-mode exclusion).
- An undefined profile name → `CONFIG_ERROR` naming the missing profile and the agent.
- **Agent-less resolution:** `--context-budget tight|balanced|wide` resolves the built-in fallback even with no agent selected; an agent profile only *overrides* the byte value. The ergonomic name stays usable without `--agent`.
- The `commands` dictionary in the `task prepare` envelope does **not** echo `--context-budget` — like `--budget-bytes`, it is per-invocation policy, not project state.

## Layer (b) — recommended budget on `recommend` / `task prepare`

`RecommendResultV2` gains an **optional**, strictly additive `contextFit` object: `recommendedProfile` (enum of the three standard names — never a custom or free string), `recommendedBudgetBytes` (the profile's bytes: agent override else built-in fallback), and `reason` (one line: driving signal + byte source). Optional so existing V2 fixtures and `recommendation: null` early-returns stay valid; promotion to required, or a `RecommendResultV3`, is a future major-boundary concern.

Deterministic total mapping from existing readiness fields:

- `context_size == large` **or** `ambiguity == high` **or** `write_surface == high` → `wide`
- else `context_size == medium` → `balanced`
- else (small + low/medium ambiguity + low/medium write_surface) → `tight`

`requires_decision: true` does **not** shrink the budget — a gated task usually needs *more* context. The existing categorical `budgetProfile` (tool-call/context-file/verification estimate) is unrelated and unchanged; Context Fit does not overload it.

## Layer (c) — explain metrics

`task context --explain --json` gains additive byte metrics beside the unchanged existing fields (`total_bytes`, `context_pack_bytes`, `sections`, `excluded`): `natural_bytes` (pre-elision size), `final_bytes` (== existing `total_bytes`/`context_pack_bytes`), `budget_bytes` (only when a budget applied), `saved_bytes` (`natural − final`), `saved_ratio` (`saved / natural`, 0 when natural is 0), `minimum_achievable_bytes` (the floor after all eligible elisions for this task), and `elided_sections` (convenience projection, in elision order).

Rules:

- With **no** budget: `natural_bytes == final_bytes`, `saved_bytes == 0`, `saved_ratio == 0`, `elided_sections == []`.
- **Invariant (the single most delicate correctness property):** `minimum_achievable_bytes` is the **same floor** the `CONTEXT_OVER_BUDGET` error already reports, computed by the **same** helper, honoring P28 conditional eligibility (`related_decisions` elidable only when `context_size: large`; `rules` only when `write_surface: high`). The success path and the error path must never disagree about the floor.
- Metrics are pure and unit-testable; computing them does **not** change the rendered `content`. The byte-identical no-flag lock (`pack-byte-identical.test.ts`) stays green.
- `elided_sections` mirrors the budget-elided subset already in `excluded[]` (reason `budget_reserved_for_later`), ordered by actual elision order.

`saved_bytes` measures only *budget-driven* elision. Further deterministic observation metrics (bytes the tool computed so the agent did not have to; facts already supplied as structured output) are recorded as direction, **not committed here**, and any such metric must be computed deterministically without agent involvement or estimation — a model-scored or `followup_risk`-style guess is explicitly out.

## Layer (d) — context-fit advisories

`plan lint --include-quality` gains four advisories, all `affects_exit: false` (never change the exit code, even under `--strict`; matches the P36 pattern):

| Code | Fires when | Carries |
| --- | --- | --- |
| `TASK_CONTEXT_PACK_LARGE` | estimated/measured natural pack size exceeds the `balanced` fallback | `natural_bytes`, `threshold_bytes`, `recommended_profile` |
| `TASK_CONTEXT_BUDGET_UNACHIEVABLE` | a declared/recommended profile cannot fit even after maximal eligible elision | `minimum_achievable_bytes` |
| `TASK_DECLARED_DECISION_LARGE` | a `decision_refs` entry inlines a very large ADR body | the referenced file and its bytes |
| `TASK_READS_MATCH_TOO_MANY` | a `reads` glob matches an unusually large number of files | the match count and the glob |

Thresholds are **deterministic byte/count values** (documented with the codes), not subjective text heuristics. The pass caches per-run file reads (no repeated pack rebuilds), makes no network calls, and performs no hidden writes.

## Network stance

The core and default paths are **local and deterministic** — building, recommending, explaining, and linting never touch the network. If external (fetched) context ever becomes necessary it is a **separate future RFC** and must at minimum: be explicit opt-in (flag/config), never run from default `task prepare`, record a cache manifest under `.code-pact/` (URL, `fetched_at`, `sha256`, `byte_count`, TTL), fail deterministically, keep offline mode first-class, make no provider/API calls from core, and keep public docs distinguishing local packs from fetched context.

## Backward compatibility

Every layer is additive; invariants across P46–P50:

- The no-flag context pack `content` is byte-identical to the current release (`pack-byte-identical.test.ts`, `budget.test.ts`).
- JSON changes are additive only: `RecommendResultV2` gains an optional `contextFit`; `--explain --json` gains keys beside existing ones; no field renamed or removed.
- Advisories are `affects_exit: false`; `plan lint` / `--strict` exit semantics unchanged for existing inputs.
- `--budget-bytes` keeps its exact P24 behavior; `--context-budget` is a new spelling resolving to a byte budget over the same enforcement.
- The agent profile schema gains an optional block; existing profiles validate unchanged. No `adapter upgrade` is required.

## Alternatives considered

- **Custom names in the recommendation enum** — rejected; `recommendedProfile` is a closed enum of the three standard names, so `recommend` never emits a name with no standard meaning. Custom profile names live only in layer (a)'s `--context-budget` resolution.
- **Naming the largest profile `full` / `max` / `large`** — rejected; `full`/`max` read as a no-elision guarantee (false — `wide` can still elide / hit `CONTEXT_OVER_BUDGET`), and `large` collides with `context_size: large`. Chose `wide`.
- **Auto-applying `default_profile` to existing commands** — rejected; would change the byte-identical no-flag pack. The block is opt-in and never implicitly applied.
- **Tokens as the budget unit / `--budget-tokens`** — rejected; the unit stays bytes (`Buffer.byteLength`), model-agnostic and already locked by P24. No tokenizer dependency.
- **Prompt/semantic compression, summarization, embeddings, semantic ranking, a proxy** — all rejected as out of scope (the Non-goal fence): Context Fit elides whole sections or not at all, never calls a model in the pack path, and never sits between agent and provider.
- **Two code paths for the floor** — rejected; one shared pure helper computes `minimum_achievable_bytes` for both the success and error paths to prevent divergence (the principal risk).

## Open questions

None at acceptance. Implementation choices (exact advisory threshold constants, where the shared floor helper lives in `src/core/pack/`, the `reason` wording) follow P10/P21/P24/P36 precedent and need no RFC-level decision; the downstream phases may set them provided the [backward-compatibility](#backward-compatibility) invariants hold.

## Roadmap and deferred work

Downstream phases are **accepted direction and implementation guardrails**, not a frozen line-level plan; each ships as its own PR gated on this RFC being `accepted`, and may refine details this RFC does not lock as an invariant: **P47** layer (a), **P48** layer (b), **P49** layer (c), **P50** layer (d).

Deferred to **separate future RFCs**, explicitly not part of Context Fit:

- **Deterministic structural compaction** — only if metrics later prove whole-section elision insufficient; must be opt-in and explainable, with no LLM summaries, embeddings, semantic ranking, tokenizer-dependent behavior, hidden truncation, default-on compaction, or non-reproducible output.
- **External context sources** — network-backed context under the strict opt-in / cache-manifest / `sha256` / TTL / offline-first constraints in [Network stance](#network-stance).

## References

- RFCs: [context-budget](context-budget-rfc.md) (P24) · [agent-contract-v2](agent-contract-v2-rfc.md) (P21) · [task-readiness-schema](task-readiness-schema-rfc.md) (P10) · [adr-quality-advisory](adr-quality-advisory-rfc.md) (P36).
- Baseline: `docs/maintainers/measurements/summary.json` (the P26 percentile values the profile fallbacks bracket).
