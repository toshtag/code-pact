# RFC: Lightweight lane + recommendation consumption

**Status:** accepted (P33, 2026-05)
**Scope:** a `lifecycleMode` field (`"full_loop" | "record_only" | "decision_loop"`) on `RecommendResultV2`, plus the adapter guidance that consumes the recommendation as a contract — shipped together (the original roadmap's P33 + P35, merged). Adds three version-gated conformance checks.
**Owners:** maintainer
**Related:** [P37-deferred-outcome-audit](P37-deferred-outcome-audit.md) · [decisions/README](README.md).

## Summary

`task prepare` / `recommend` already return a correct execution profile (`tier`, `effort`, `planningRequired`, `budgetProfile`), but two gaps remained: every task ran the full `prepare → start → complete → finalize` loop even for low-risk strongly-verified work, and the recommendation was produced but not consumed as a contract. Both are the same axis — code-pact steers *how* an agent proceeds, not bug detection. This phase adds the steering signal (`lifecycleMode`) **and** the consumption contract together.

## Decisions

1. **One field, one phase, no split.** `lifecycleMode` is added to `RecommendResultV2` (additive, `.strict()`-safe), AND the adapter guidance that tells agents to consume it ships in the **same task/PR**. *Rationale:* shipping the field without the consumption contract would reproduce the exact "produced-but-unused information" problem this phase exists to fix.

2. **Conservative, deterministic determination.** `lifecycleMode` is a finite switch — no free-form text, no model output:
   - task/phase `requires_decision` (via the shared `isDecisionRequiredForTask` predicate) is true → `decision_loop`.
   - else, when `requires_decision` is false AND `task.type ∈ {docs, test}` AND `ambiguity === low` AND `risk === low` AND `verification_strength === strong` → `record_only`.
   - otherwise → `full_loop`.

   *Rationale:* `architecture` is **not** auto-`decision_loop` — only an explicit `requires_decision` triggers it. The `record_only` branch states `requiresDecision === false` explicitly so a future reorder can never drop a decision task into the light lane. When uncertain, fall to `full_loop`; `record_only` widens (e.g. to `bugfix`/`refactor`) only after real usage justifies it. Reuses the same `isDecisionRequiredForTask` (`src/core/decisions/adr.ts`) that `verify` / `plan lint` use.

3. **`record_only` is a lighter loop, not lighter verification.** *Rationale:* the adapter guidance is explicit — do **not** skip the project verification commands; implement normally, run verification, then record honest completion with `task record-done --evidence ...` (which requires evidence and still honors the decision gate). Not a free pass.

4. **lifecycle is a recommendation, not enforcement.** Loop behavior (`task complete` / `task record-done`) is unchanged. *Rationale:* enforcement is limited to (a) supplying the signal and (b) verifying the guidance is *present* in the adapter; an agent's actual compliance cannot be forced. The contract therefore also requires that an agent which **cannot switch model** report that limitation rather than silently ignore the recommendation.

5. **No `agent_action` JSON field.** A machine-readable `agent_action` (`must_acknowledge`, `if_cannot_switch_model`) was rejected. *Rationale:* it duplicates the prose guidance without adding enforcement (the conformance checks verify the prose, not JSON consumption) — more produced-but-unused information.

6. **New conformance checks are version-gated on a NEW threshold.** Three checks — `recommendation_consumption_guidance_present`, `lifecycle_mode_guidance_present`, `cannot_switch_model_fallback_present` — verify the guidance is present in the generated instruction file. *Rationale:* gated on a new `RECOMMENDATION_CONSUMPTION_FROM_VERSION` (= P33's release version), NOT the existing `ADAPTER_CONTRACT_HARDENING_FROM_VERSION` (1.14.0) — reusing the old threshold would make every 1.14–1.25 adapter non-conformant at once. Below the new threshold the checks are advisory. Anchors are short stable tokens (`data.recommendation`, `lifecycleMode`, `record_only`, `task record-done`, a short English-locked phrase for the model-switch fallback) rather than long prose, so i18n wording changes do not break them.

## Alternatives considered

- **Split the field (P33) from the consumption contract (P35)** — rejected; ships produced-but-unused information, the exact failure this phase fixes (decision 1).
- **Auto-`decision_loop` for `architecture` type** — rejected; only an explicit `requires_decision` should gate the decision loop (decision 2).
- **A machine-readable `agent_action` JSON field** — rejected; duplicates the prose without adding enforcement (decision 5).
- **`record_only` for `bugfix` / `refactor`** — rejected for now; conservative, revisit with usage data.
- **Reuse `ADAPTER_CONTRACT_HARDENING_FROM_VERSION` for the new checks** — rejected; would retroactively fail every 1.14–1.25 adapter (decision 6).

## Open questions

- Widening `record_only` beyond `{docs, test}` (to `bugfix` / `refactor`) once real usage data justifies it.
- Whether lifecycle should ever move from advisory to partial enforcement — out of scope here (decision 4).

## References

- RFCs: [P37-deferred-outcome-audit](P37-deferred-outcome-audit.md) · [decisions/README](README.md).
- Code: [src/core/decisions/adr.ts](../../src/core/decisions/adr.ts) (`isDecisionRequiredForTask`).
