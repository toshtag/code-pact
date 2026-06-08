# RFC: Deterministic stabilization of AI-assisted roadmap generation

**Status:** accepted (P31, 2026-05-25)
**Scope:** elicitation (prompt) + surfacing (lint) only — no new schema. Adds three advisory lint signals (`TASK_DECISION_UNRESOLVED`, `PHASE_CONFIDENCE_LOW`, `TASK_DESCRIPTION_MISSING`), a separate `advisories` count, and a shared "decision resolved" predicate (`src/core/decisions/adr.ts`) used by both `lint` and `verify`.
**Owners:** maintainer
**Related:** [control-plane-v2](control-plane-v2-rfc.md) (cites this RFC).

## Summary

AI-authored roadmaps were weaker than the schema allows for two reasons: the `plan prompt` example (`YAML_FORMAT_EXAMPLE` in `plan-prompt.ts`) only requested `id`/`description`/`type`, so the attributes that drive `recommend` (tier/effort/budget) and context-pack rule selection were omitted and defaulted to `medium`; and `plan lint` checked structure but never surfaced "this decision is unresolved" / "this phase is low-confidence". Rather than bet on a smarter prompt, this RFC absorbs AI instability downstream with a deterministic, agent-independent surface plus human review — eliciting the missing signals in the prompt and making uncertainty visible (but never gating) in lint.

## Decisions

1. **No new schema.** Every attribute is already optional on `TaskImport` / `PhaseImportEntry`, and `recommend` already exposes `clarify_before_implementation`. The work is elicitation + surfacing, not new model.

2. **Advisory, never a hard gate.** The new signals (`TASK_DECISION_UNRESOLVED`, `PHASE_CONFIDENCE_LOW`, `TASK_DESCRIPTION_MISSING`) ship `affects_exit: false`: visible under `--include-quality` (and in CI logs) but never failing `--strict`. Enforcement is reserved for feeding-correct-information and replacing-AI-with-logic; resolving a design decision is human judgment, so the tool surfaces it rather than blocking. No `--clarify-strict` flag — it would be speculative.

3. **One definition of "decision resolved", shared with `verify`.** `verify` resolves `requires_decision` by checking for an ADR in `design/decisions/` whose filename includes the task id (substring `f.includes(taskId)`). The new lint check reuses that predicate via a shared helper (`src/core/decisions/adr.ts`) so lint and verify can never diverge. The known substring-collision (`P1-T1` matches `P1-T10-*.md`) is preserved as existing-compatible behaviour and pinned by a characterization test.

4. **Prompt asks for six task attributes**: `ambiguity`, `risk`, `context_size`, `write_surface`, `verification_strength`, `requires_decision`. `write_surface` is included because it drives effort, budget, and context-pack rule selection standalone. `expected_duration` is excluded — it drives effort/budget too, but AI wall-clock estimates are noisy, so the `medium` default is acceptable. Phase-level `requires_decision` is left out of the example (phase uncertainty is expressed by `confidence: low`; the task-level marker is `requires_decision`).

5. **`advisories` separated from `warnings`.** `warnings` counts only exit-relevant warnings; advisory (`affects_exit: false`) issues are counted under a new `advisories` field and rendered as `[advisory]`, so human output never shows "0 warnings" above visible advisory lines.

## Alternatives considered

- **A hard `--clarify-strict` gate** — rejected/deferred; add only if a real need appears. Resolving a decision is human judgment, so blocking on it is wrong by default.
- **New schema fields for the elicited attributes** — rejected; all six are already optional on the import types, so the gap was prompt + lint, not model.
- **Change how `verify` enforces decisions at completion** — out of scope; the shared predicate aligns lint *to* the existing `verify` behaviour rather than altering it.
- **A smarter prompt as the primary fix** — rejected as the load-bearing strategy; instability is absorbed downstream (deterministic lint surface + human review) instead of betting on better generation.

## Open questions

1. **`--clarify-strict`** stays deferred; revisit only against a concrete need to fail CI on unresolved decisions.
2. **The `f.includes(taskId)` substring collision** is intentionally preserved for compatibility; a precise task-id match is a future, separately-scoped change.

## References

- RFCs: [control-plane-v2](control-plane-v2-rfc.md).
- Code: [src/core/decisions/adr.ts](../../src/core/decisions/adr.ts) (shared "decision resolved" predicate) · `plan-prompt.ts` (`YAML_FORMAT_EXAMPLE`).
