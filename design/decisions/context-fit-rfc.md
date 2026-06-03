# RFC: Context Fit

**Status:** accepted (P46, 2026-06)
**Scope:** make context pack size *controllable, explainable, deterministic, and ergonomic* by building four additive layers on top of the existing P24 `--budget-bytes` mechanism — (1) named **budget profiles** on the agent profile plus a `--context-budget <profile>` flag, (2) a recommended budget surfaced additively on `recommend` / `task prepare`, (3) **explain metrics** that make the natural size, the saved bytes, and the achievable floor observable, and (4) opt-in **plan-lint advisories** that flag context-bloat risk before a task runs. The no-flag default context pack stays byte-identical to the current release; every JSON change is additive; advisories never affect exit code. No new compaction, summarization, tokenizer, proxy, or network behavior is introduced.
**Owners:** maintainer
**Related:**
- [design/decisions/context-budget-rfc.md](context-budget-rfc.md) (P24 — `--budget-bytes`, the fixed elision order, and `CONTEXT_OVER_BUDGET`. Context Fit is the **future RFC that P24's Non-goals explicitly deferred**: P24 §Non-goals says "No automatic budget inference from agent profile … a future RFC" and "Agent-profile-derived default budget. Tracked here but deferred to a future RFC." This is that RFC. The P24 elision order and byte-measurement are load-bearing here and are **not** changed.)
- [design/decisions/agent-contract-v2-rfc.md](agent-contract-v2-rfc.md) (P21 — `task context --explain` and the per-section `bytes` + `reason_code` breakdown that the explain metrics extend).
- [design/decisions/task-readiness-schema-rfc.md](task-readiness-schema-rfc.md) (P10 — the `context_size` / `ambiguity` / `write_surface` / `decision_refs` / `reads` readiness fields that drive both the recommended budget and the advisories).
- [design/decisions/adr-quality-advisory-rfc.md](adr-quality-advisory-rfc.md) (P36 — the `affects_exit: false` advisory pattern the readiness layer reuses).

## Status lifecycle

- This document opens at status **proposed** in the P46-T0 PR. It flips to **accepted** (P46-T1) only after local validation passes **and** a reviewer confirms the document carries no implementation claim for unshipped behavior, no public/private leakage of any non-`code-pact` lineage, and no over-binding "committed plan" language — see [Roadmap](#roadmap-and-deferred-work). P46 is done only after a commit with `Status: accepted` has landed.
- The downstream phases (P47–P50) treat the accepted document as **accepted direction and implementation guardrails**, not a frozen line-level plan: a better design found during implementation may revise the details below, provided it preserves the [invariants](#backward-compatibility) and updates this RFC.
- **P46 implementation risk is low** because it changes design artifacts only (this RFC, a phase file, a roadmap entry, the decisions index). Downstream implementation risk is real but is tracked per future phase; the phase-level `confidence: high` on P46 reflects the bootstrap, not the whole arc.

## Background

P24 shipped `code-pact task context --budget-bytes <N>` and `task prepare --budget-bytes <N>`: a deterministic byte cap enforced by eliding whole sections in a fixed priority order ([`ELISION_ORDER`](../../src/core/pack/formatters/markdown.ts)), failing with `CONTEXT_OVER_BUDGET` when the cap cannot be met without dropping always-included sections. P21 had already shipped `task context --explain` with a per-section `bytes` + `reason_code` breakdown.

Two gaps were left open *on purpose*:

1. **The budget is a raw byte count with no ergonomic layer.** Every consumer must know and pass an exact `N`. P24 §Non-goals deferred "automatic budget inference from agent profile" to "a future RFC", because the agent → context-window mapping was an unsolved research problem at the time. The practical consequence: an agent cannot say "give me the *tight* pack for this tier" — only "give me at most 31200 bytes", a magic number it has to source from somewhere.
2. **`--explain` is descriptive, not quantitative about *fit*.** It reports what each included section costs and why each excluded section was dropped, but it does not report the pack's **natural** (pre-elision) size, how many bytes a budget **saved**, or the **floor** below which no budget can go for this task. The floor exists today only inside the `CONTEXT_OVER_BUDGET` *error* envelope (`minimum_achievable_bytes`); a successful build never surfaces it, so a caller choosing a budget is flying blind about how low it could reasonably set one.

There is also no readiness-time signal: a task whose declared `decision_refs` inline a very large ADR body, or whose `reads` globs fan out to hundreds of files, will produce a large pack, but nothing warns the author before the task is run.

## Problem statement

1. **Named, reusable budgets have no surface.** Bytes are the right unit (model-agnostic, already locked by P24), but a raw integer is a poor ergonomic primitive. A project should be able to name a small set of budgets once and refer to them by name.
2. **`recommend` says nothing about budget.** `recommend` / `task prepare` already derive an execution profile from task readiness fields (tier, effort, planning, a categorical `budgetProfile`), but they do not suggest a context byte budget — the one number an agent needs to ask for a right-sized pack.
3. **The fit of a pack is not observable.** Natural size, saved bytes, saved ratio, and the achievable floor are all computable from data the builder already has, but none are exposed on a successful `--explain` build.
4. **Context-bloat risk is invisible until run time.** A task can be authored such that its pack will be large or its budget unachievable, with no advisory at `plan lint` time.

## Goals

Context Fit rests on one product principle: **prefer local deterministic computation over agent reasoning** — when the tool can derive a fact itself, it should, so the agent reads and re-derives less. Avoiding unnecessary agent input is the *safest* form of token/cost reduction because it removes *work*, not *evidence*. The four additive layers below apply that principle to the budget surface (the [Reduction taxonomy](#reduction-taxonomy) below scopes what "reduction" is allowed to mean):

- **(a) Ergonomic layer — named budget profiles.** The agent profile may declare an optional `context_budget` block naming a few byte budgets; `task context` / `task prepare` gain `--context-budget <profile>` which resolves to that profile's `max_bytes` and then uses the *unchanged* P24 enforcement path. `--budget-bytes <N>` keeps working exactly as today.
- **(b) Recommendation layer — a suggested budget.** `recommend` (and therefore `task prepare`) gains an additive `contextFit` field naming a recommended standard profile, its byte value, and a one-line reason, derived deterministically from existing readiness fields.
- **(c) Audit layer — explain metrics.** `task context --explain --json` gains additive byte metrics: `natural_bytes`, `final_bytes`, `saved_bytes`, `saved_ratio`, `minimum_achievable_bytes`, and a convenience `elided_sections` projection.
- **(d) Readiness layer — advisories.** `plan lint --include-quality` gains opt-in, non-exit-affecting advisories that flag likely context bloat or an unachievable declared budget before a task runs.

The default no-flag context **pack content** stays **byte-identical** to the current release: Context Fit never silently drops task-relevant evidence from the pack (see [Reduction taxonomy](#reduction-taxonomy)). What it adds is ergonomic budgets, a recommended budget, and observable/lint-able pack size — plus the recorded principle that future deterministic work belongs *before* the agent, not as hidden pack shrinkage.

## Reduction taxonomy

Context Fit distinguishes two fundamentally different ways to cut tokens/cost, because they carry **opposite risk**:

1. **Safe deterministic avoidance (preferred; may be default where it already is).** The tool uses local deterministic logic to *avoid asking the agent to do work the tool can compute itself* — glob expansion, byte / `write_surface` measurement, schema and validation results, the write audit, pack-size diagnostics, lint advisories, and structured command outputs. This reduces agent input and reasoning burden **without dropping task-relevant evidence**. Much of it is already how Code Pact works (the P10 readiness fields, `plan lint`, `recommend`, and the deterministic relevance rules the pack builder already applies); the principle here is to *keep leaning into it*. "Avoidance" means computing a fact for the agent, or skipping work the agent never needed — it does **not** license dropping declared or included pack evidence on a "looks derivable" heuristic.
2. **Risk-bearing reduction (never hidden, never default-on for the pack).** Any reduction that removes, rewrites, summarizes, ranks, or excerpts *task-relevant evidence* can lower output quality or add follow-up turns — and a worse pack that triggers a wrong premise, an extra clarifying round, or a re-run can cost *more* total tokens than it saved. These reductions must be explicit (opt-in), explainable (`--explain`), and measurable, and must never be applied silently to the default pack. P24 whole-section elision is the only sanctioned reduction today, and it is opt-in via `--budget-bytes` / `--context-budget`.

The byte-identical default applies to the **pack content** — the agent's evidence base. Safe deterministic avoidance on *non-pack* surfaces (computing a fact in `recommend` / `plan lint` / `task prepare` so the agent does not have to) is not a "reduction" of the pack at all, and is encouraged.

## Non-goals

These are out of scope for Context Fit and must not drift in during implementation. They are stated as the explicit "we do not do this" fence:

- **No prompt compression and no semantic compression.** Context Fit never rewrites or shortens a section's body. It elides whole sections (P24) or it does not — there is no lossy text reduction.
- **No automatic summarization and no LLM summarization** of any kind. Nothing in the pack path calls a model.
- **No embeddings, no semantic ranking, no tokenizer-dependent behavior.** Section selection and ordering remain exactly the P10/P21/P24 deterministic rules. The unit stays bytes (`Buffer.byteLength(…, "utf8")`), never tokens.
- **No proxy and no provider wrapping.** Context Fit does not sit between an agent and any model API.
- **No hidden loss-bearing reduction.** Context Fit must not silently remove, rewrite, summarize, rank, or excerpt *task-relevant evidence* in a way that can lower task quality; the default no-flag **pack content** stays byte-identical. This fences *loss-bearing* reduction — **not** [safe deterministic avoidance](#reduction-taxonomy): replacing agent reasoning with local computation, while preserving the evidence contract, is allowed and preferred.
- **No network in the core/default path.** Building, recommending, explaining, and linting a context pack is local and offline. External context sources, if ever needed, are a separate future RFC (see [Deferred](#roadmap-and-deferred-work)).
- **No change to the P24 elision order or eligibility, and no `--budget-tokens`.** The fixed `ELISION_ORDER` and its P28 conditional eligibility stay as locked; Context Fit reads them, it does not rewrite them.
- **No new gate.** Every Context Fit advisory is `affects_exit: false`. Nothing here can fail `verify` / `task complete` / `task finalize`.

## Design

### Standard profile vocabulary and fallback bytes (single source of truth)

Context Fit defines exactly **three standard profile names** and their **built-in fallback byte values**. These values are defined **here, once**, and are the single source of truth that every layer references:

| Profile   | Fallback `max_bytes` | Intended fit (against the P26 dogfood baseline) |
| --------- | -------------------- | ------------------------------------------------ |
| `tight`   | `30000`              | Above the `pack_size_p50_bytes` (20725): most small/medium tasks fit; constrained tiers. |
| `balanced`| `60000`              | Above the `pack_size_p90_bytes` (50131): ~90% of tasks fit without elision. |
| `wide`    | `120000`             | Generous headroom below the `pack_size_max_bytes` outlier (259650); large/ambiguous tasks. Still a byte-capped profile — **not** a promise every pack fits without elision. |

Rationale is observable, not guessed: the values bracket the committed P26 baseline (`docs/maintainers/measurements/summary.json`), so each is a real percentile boundary rather than a round number. An agent profile (layer **a**) may **override** any of these byte values by declaring a profile of the same name; when it does not, the fallback above applies. The recommendation layer (**b**) only ever emits one of these three names. `wide` is intentionally **not** named `full`: it is a generous byte-capped profile, not a promise that every context pack fits without elision (a large task can still elide or hit `CONTEXT_OVER_BUDGET` at `wide`). `large` / `max` / `full` were rejected — `large` collides with the `context_size: large` value, and `max` / `full` read as a no-elision guarantee.

### Layer (a) — agent-profile budget profiles + `--context-budget` (P47)

The agent profile schema gains an **optional** `context_budget` block:

```yaml
context_budget:
  default_profile: balanced        # optional; if present must name a listed profile
  profiles:
    tight:   { max_bytes: 30000 }
    balanced:{ max_bytes: 60000 }
    wide:    { max_bytes: 120000 }
```

- `max_bytes` is a positive integer. `default_profile`, when present, must reference a profile that exists in `profiles`.
- A missing `context_budget` block is valid (backward compatible). The block is **not** applied automatically to any existing command — there is no implicit default-budget behavior. `--budget-bytes`-free invocations stay byte-identical.
- Custom profile names beyond the three standard ones are permitted in this block, but only the standard three carry built-in fallbacks and only they are ever recommended (layer **b**).

CLI: `task context` and `task prepare` gain `--context-budget <profile>`.

- It resolves to the named profile's `max_bytes` and then uses the **unchanged** P24 enforcement path (same elision order, same `CONTEXT_OVER_BUDGET` on an unachievable budget).
- `--context-budget` and `--budget-bytes` are **mutually exclusive** — supplying both is `CONFIG_ERROR` (mirroring the existing `plan brief` three-mode exclusion).
- An undefined profile name is `CONFIG_ERROR`; the message names the missing profile and the agent.
- **Agent-less resolution:** `--context-budget tight|balanced|wide` resolves the built-in standard fallback even when no agent profile is selected; an agent profile only *overrides* the byte value when an agent is in play. This keeps the ergonomic name usable without forcing `--agent`.
- The `commands` dictionary in the `task prepare` envelope does **not** echo `--context-budget` — like `--budget-bytes` (P24), it is per-invocation policy, not project state.

### Layer (b) — recommended budget on `recommend` / `task prepare` (P48)

`RecommendResultV2` gains an **optional**, strictly additive field:

```ts
contextFit?: {
  recommendedProfile: "tight" | "balanced" | "wide";   // enum — recommend only ever emits a standard name
  recommendedBudgetBytes: number;                       // the profile's bytes (agent override → built-in fallback)
  reason: string;                                        // one line: which signal drove it, which byte source
};
```

`recommendedProfile` is an **enum** of the three standard names, not a free string: the recommendation is deterministic and only speaks the standard vocabulary. (Custom agent-profile names live only in layer **a**'s `--context-budget` resolution namespace; conflating them with the recommendation would let `recommend` emit a name with no standard meaning.) The field is `optional` so existing V2 fixtures/consumers are unaffected and `recommendation: null` early-return states stay valid; promotion to required, or a `RecommendResultV3`, is deferred to a future major boundary.

Deterministic mapping from existing readiness fields (total function):

```
if (context_size == "large" || ambiguity == "high" || write_surface == "high") -> "wide"
else if (context_size == "medium")                                             -> "balanced"
else                                                                            -> "tight"   // small + low/medium ambiguity + low/medium write_surface
```

`requires_decision: true` does **not** shrink the budget — a gated task usually needs *more* context, not less. `recommendedBudgetBytes` is the agent profile's same-named profile bytes when present, else the built-in fallback; `reason` records both the driving signal and which byte source was used. The existing `budgetProfile` (categorical tool-call / context-file / verification estimate) is unrelated and unchanged — Context Fit does not overload it.

### Layer (c) — explain metrics (P49)

`task context --explain --json` gains additive byte metrics. Existing fields (`total_bytes`, `context_pack_bytes`, `sections`, `excluded`) are unchanged.

```jsonc
{
  "natural_bytes": 95000,            // pre-elision pack size
  "final_bytes": 58720,              // == existing total_bytes == context_pack_bytes
  "budget_bytes": 60000,             // present only when a budget was applied
  "saved_bytes": 36280,              // natural_bytes - final_bytes (0 with no elision)
  "saved_ratio": 0.381,              // saved_bytes / natural_bytes (0 when natural_bytes == 0)
  "minimum_achievable_bytes": 28120, // floor after all ELIGIBLE elisions for THIS task
  "elided_sections": [               // convenience projection, in elision order
    { "name": "completed_tasks", "bytes": 1200 }
  ]
}
```

Rules:

- `final_bytes` equals the existing `total_bytes` / `context_pack_bytes` (kept for compatibility); with **no** budget, `natural_bytes == final_bytes`, `saved_bytes == 0`, `saved_ratio == 0`, `elided_sections == []`.
- **`minimum_achievable_bytes` is the same floor the `CONTEXT_OVER_BUDGET` error already reports**, computed by the **same** helper, honoring the P28 conditional eligibility (`related_decisions` elidable only when `context_size: large`; `rules` only when `write_surface: high`). The success path and the error path must never disagree about the floor — this is the single most delicate correctness property of Context Fit, so it is stated as an invariant, not an implementation note.
- The metrics are pure and unit-testable; computing them does **not** change the rendered `content`. The byte-identical no-flag lock (`tests/integration/pack-byte-identical.test.ts`) continues to pass unmodified.
- `elided_sections` is a convenience mirror of the budget-elided subset already present in `excluded[]` (reason `budget_reserved_for_later`), ordered by actual elision order.

**Future deterministic observation candidates (not P49; recorded as direction).** `saved_bytes` measures only *budget-driven* elision. The [Reduction taxonomy](#reduction-taxonomy) points at further metrics worth surfacing later — e.g. bytes the tool computed so the agent did not have to, duplicate/again-stated bytes avoided, or facts already supplied as structured deterministic output by `recommend` / `plan lint` / `task prepare` that the agent would otherwise have re-derived. These count **non-pack work avoided**, never silent removal of task-relevant evidence as "avoidance". **Constraint:** any such metric must be computed *deterministically and without agent involvement or estimation* — measuring savings with a model would be self-defeating. Non-deterministic guesses (a `followup_risk`-style score) are explicitly out: they belong to neither layer of the taxonomy. These are candidates for a later phase, not committed here.

### Layer (d) — context-fit advisories (P50)

`plan lint --include-quality` gains four advisories. Every one sets `affects_exit: false` — they never change the exit code, even under `--strict`, matching the P36 advisory pattern.

| Code | Fires when | Carries |
| --- | --- | --- |
| `TASK_CONTEXT_PACK_LARGE` | the task's estimated/measured natural pack size exceeds the `balanced` fallback budget | `natural_bytes`, `threshold_bytes`, `recommended_profile` |
| `TASK_CONTEXT_BUDGET_UNACHIEVABLE` | a declared/recommended profile cannot fit even after maximal eligible elision | `minimum_achievable_bytes` |
| `TASK_DECLARED_DECISION_LARGE` | a `decision_refs` entry inlines a very large ADR body | the referenced file and its bytes |
| `TASK_READS_MATCH_TOO_MANY` | a `reads` glob matches an unusually large number of files | the match count and the glob |

Thresholds are **deterministic byte/count values** (documented with the codes), not subjective text heuristics. The pass avoids rebuilding every context pack repeatedly (it caches per-run file reads), makes no network calls, and performs no hidden writes.

## Network stance

The core and default paths of Context Fit are **local and deterministic**. Building, recommending, explaining, and linting never touch the network. If external (fetched) context ever becomes necessary, it is a **separate future RFC** and must, at minimum: be explicit opt-in (flag/config), never run from default `task prepare`, record a cache manifest under `.code-pact/` (URL, `fetched_at`, `sha256`, `byte_count`, TTL), fail deterministically, keep offline mode first-class, make no AI/provider API calls from core, and keep public docs clearly distinguishing local context packs from fetched context.

## Backward compatibility

Every layer is additive; the following invariants hold across all of P46–P50:

- The no-flag context pack `content` is byte-identical to the current release (`pack-byte-identical.test.ts`, `budget.test.ts` byte-identical contract).
- JSON changes are additive only: `RecommendResultV2` gains an *optional* `contextFit`; `--explain --json` gains new keys beside the existing ones; no field is renamed or removed.
- Advisories are `affects_exit: false`; `plan lint` / `plan lint --strict` exit semantics are unchanged for existing inputs.
- `--budget-bytes` keeps its exact P24 behavior; `--context-budget` is a new alternative spelling that resolves to a byte budget and reuses the same enforcement.
- The agent profile schema gains an *optional* block; existing profiles validate unchanged.
- Adapter manifest schema and existing adapter instruction files are unchanged; no `adapter upgrade` is required to keep current behavior.

## Risks

1. **Floor divergence (the principal risk).** If the success-path `minimum_achievable_bytes` and the `CONTEXT_OVER_BUDGET` floor are computed by two code paths, they can drift. Mitigation: one shared pure helper; a test asserts both report the same floor for the same task.
2. **Profile-byte source ambiguity.** Two sources of byte values exist (agent profile override vs. built-in fallback). Mitigation: the precedence (override → fallback) and the fallback table are fixed here in one place; `reason` records which source was used.
3. **Recommendation vs. custom names.** Allowing arbitrary agent-profile profile names while `recommend` speaks only the standard three could confuse consumers. Mitigation: `recommendedProfile` is a closed enum; custom names are explicitly a layer-(a) resolution concern only.
4. **Advisory noise / cost.** Over-eager thresholds or rebuilding packs per task would make `--include-quality` slow or noisy. Mitigation: deterministic documented thresholds, per-run read caching, and `affects_exit: false` so the advisories never block.

## Roadmap and deferred work

The downstream phases are **accepted direction and implementation guardrails**, not a frozen committed plan. Each ships as its own PR, gated on this RFC being `accepted`, and may refine details that this RFC does not lock as an invariant.

- **P47 — Context budget profiles.** Layer (a): the agent-profile `context_budget` block + `--context-budget` on `task context` / `task prepare`.
- **P48 — Recommendation integration.** Layer (b): the optional `contextFit` field on `RecommendResultV2`, surfaced through `task prepare`.
- **P49 — Explain metrics.** Layer (c): the additive `--explain --json` byte metrics with the shared-floor invariant.
- **P50 — Context fit advisories.** Layer (d): the four `affects_exit: false` advisories under `plan lint --include-quality`.

Deferred to **separate future RFCs**, explicitly not part of Context Fit:

- **P51 — Deterministic structural compaction (deferred).** Only if metrics later prove whole-section elision insufficient. Any such work must be opt-in and explainable, and must *not* introduce LLM summaries, embeddings, semantic ranking, tokenizer-dependent behavior, hidden truncation, default-on compaction, or non-reproducible output.
- **P52 — External context sources (deferred).** Network-backed context, under the strict opt-in / cache-manifest / `sha256` / TTL / offline-first constraints in [Network stance](#network-stance).

## Open questions

None at acceptance. Implementation choices (exact advisory threshold constants, where the shared floor helper lives in `src/core/pack/`, the `reason` string wording) follow the P10 / P21 / P24 / P36 precedents and do not need RFC-level decisions; P47–P50 may set them as long as the [invariants](#backward-compatibility) hold.
