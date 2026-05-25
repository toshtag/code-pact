# RFC: Deterministic stabilization of AI-assisted roadmap generation

- Status: accepted
- Phase: P31
- Date: 2026-05-25

## Problem

The AI-assisted planning loop (`plan prompt` → `phase import` → `plan lint`
→ runbook) has two gaps that make AI-authored roadmaps weaker than the
schema allows:

1. **The prompt does not elicit the signals the tool runs on.** The
   `YAML_FORMAT_EXAMPLE` in `plan-prompt.ts` only shows `id` / `description`
   / `type` for tasks. The schema-supported attributes that drive
   `recommend` (tier/effort/budget) and context-pack rule selection —
   `ambiguity`, `risk`, `context_size`, `write_surface`,
   `verification_strength`, `requires_decision` — are never requested, so
   AI output omits them and `phase import` defaults them all to `medium`.
   The result: attribute-driven recommendation barely fires on the exact
   path (AI assistance) where it would help most.

2. **`plan lint` never surfaces uncertainty.** It checks structural
   integrity but not "this decision is unresolved" / "this phase is
   low-confidence". The principled fix (mirroring spec-driven tooling) is
   not to bet on a smarter prompt but to absorb instability downstream with
   a deterministic, agent-independent surface plus human review.

## Decisions

1. **No new schema.** Every attribute is already optional on `TaskImport` /
   `PhaseImportEntry`; `recommend` already exposes
   `clarify_before_implementation`. The work is elicitation (prompt) +
   surfacing (lint), not new model.

2. **Advisory, never a hard gate.** The new lint signals
   (`TASK_DECISION_UNRESOLVED`, `PHASE_CONFIDENCE_LOW`,
   `TASK_DESCRIPTION_MISSING`) ship `affects_exit: false`. They are visible
   under `--include-quality` (and in CI logs) but never fail `--strict`.
   Enforcement is reserved for feeding-correct-information and
   replacing-AI-with-logic; resolving a design decision is human judgment,
   so the tool surfaces it rather than blocking. No `--clarify-strict`
   flag — it would be speculative.

3. **One definition of "decision resolved", shared with `verify`.** `verify`
   already resolves `requires_decision` by checking for an ADR in
   `design/decisions/` whose filename includes the task id (substring
   match `f.includes(taskId)`). The new lint check reuses that predicate via
   a shared helper (`src/core/decisions/adr.ts`) so lint and verify can
   never diverge. The known substring-collision (`P1-T1` matches
   `P1-T10-*.md`) is preserved as existing-compatible behaviour and pinned
   by a characterization test.

4. **Prompt asks for six task attributes**: `ambiguity`, `risk`,
   `context_size`, `write_surface`, `verification_strength`,
   `requires_decision`. `write_surface` is included because it drives
   effort, budget, and context-pack rule selection standalone.
   `expected_duration` is excluded — it drives effort/budget too, but AI
   wall-clock estimates are noisy, so `medium` default is acceptable.
   Phase-level `requires_decision` is left out of the prompt example
   (phase uncertainty is expressed by `confidence: low`; the task-level
   marker is `requires_decision`).

5. **`advisories` separated from `warnings`.** `warnings` counts only
   exit-relevant warnings; advisory (`affects_exit: false`) issues are
   counted under a new `advisories` field and rendered as `[advisory]` so
   human output never shows "0 warnings" above visible advisory lines.

## Non-goals

- No hard `--clarify-strict` gate (deferred; add only if a real need
  appears).
- No new schema fields.
- No change to how `verify` enforces decisions at completion.
