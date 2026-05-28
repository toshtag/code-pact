# RFC: Lightweight lane + recommendation consumption

- Status: accepted
- Phase: P33
- Date: 2026-05-28

## Problem

`task prepare` / `recommend` already return a correct execution profile
(`tier`, `effort`, `planningRequired`, `budgetProfile`, ...), but two gaps
remain:

1. **Every task runs the full loop.** Even a small docs/test change is pushed
   through `prepare → start → complete → finalize`, which is ceremony for
   low-risk, strongly-verified work. There is no signal that says "this one is
   safe to record lightly."
2. **The recommendation is not consumed as a contract.** Nothing in the agent
   adapter instructions tells an agent to read the recommendation and let it
   drive model choice, planning depth, or loop selection — so a correct
   recommendation is information that is produced but not acted on.

These are the same axis: code-pact's value is steering *how* an agent proceeds,
not detecting bugs. This phase adds the steering signal **and** the consumption
contract together.

## Decisions

1. **One field, one phase, no split.** A `lifecycleMode` field
   (`"full_loop" | "record_only" | "decision_loop"`) is added to
   `RecommendResultV2` (additive, `.strict()`-safe), AND the adapter guidance
   that tells agents to consume it ships in the **same task/PR**. Shipping the
   field without the consumption contract would reproduce the exact
   "produced-but-unused information" problem this phase exists to fix. (This is
   the original roadmap's P33 + P35, deliberately merged.)

2. **Conservative, deterministic determination.** `lifecycleMode` is a finite
   switch — no free-form text, no model output:

   ```
   requiresDecision = isDecisionRequiredForTask({ requires_decision: phaseRequiresDecision }, task)

   1. requiresDecision === true                              → "decision_loop"
   2. requiresDecision === false
      AND task.type ∈ {"docs","test"}
      AND task.ambiguity === "low"
      AND task.risk === "low"
      AND task.verification_strength === "strong"            → "record_only"
   3. otherwise                                              → "full_loop"
   ```

   - `architecture` is **not** auto-`decision_loop` — only an explicit
     task/phase `requires_decision` triggers it.
   - The `record_only` branch states `requiresDecision === false` explicitly,
     so a future reorder can never drop a decision task into the light lane.
   - When uncertain, fall to `full_loop`. `record_only` will be widened (e.g.
     to `bugfix` / `refactor`) only after real usage justifies it.
   - Reuses the shared `isDecisionRequiredForTask` predicate
     (`src/core/decisions/adr.ts`) — the same one `verify` / `plan lint` use.

3. **`record_only` is a lighter loop, not lighter verification.** The adapter
   guidance is explicit: do **not** skip the project verification commands —
   implement normally, run verification, then record honest completion with
   `task record-done --evidence ...` (which requires evidence and still honors
   the decision gate). `record_only` is not a free pass.

4. **lifecycle is a recommendation, not enforcement.** code-pact's loop
   behavior (`task complete` / `task record-done`) is unchanged. Enforcement is
   limited to (a) supplying the signal and (b) verifying the guidance is
   *present* in the adapter. An agent's actual compliance cannot be forced; the
   contract therefore also requires that an agent which **cannot switch model**
   report that limitation rather than silently ignore the recommendation.

5. **No `agent_action` JSON field.** A machine-readable `agent_action`
   (`must_acknowledge`, `if_cannot_switch_model`) was considered and rejected:
   it duplicates the prose guidance without adding enforcement (the conformance
   checks verify the prose, not JSON consumption), so it would be more
   produced-but-unused information.

6. **New conformance checks are version-gated on a NEW threshold.** Three
   checks — `recommendation_consumption_guidance_present`,
   `lifecycle_mode_guidance_present`, `cannot_switch_model_fallback_present` —
   verify the guidance is present in the generated instruction file. They are
   gated on a new `RECOMMENDATION_CONSUMPTION_FROM_VERSION` (= P33's release
   version), NOT the existing `ADAPTER_CONTRACT_HARDENING_FROM_VERSION` (1.14.0)
   — reusing the old threshold would make every 1.14–1.25 adapter
   non-conformant at once. Below the new threshold the checks are advisory.
   Anchors are short, stable tokens (`data.recommendation`, `lifecycleMode`,
   `record_only`, `task record-done`, a short English-locked phrase for the
   model-switch fallback) rather than long prose, so i18n wording changes do
   not break them.

## Non-goals

- No `agent_action` JSON field (decision 5).
- No auto-`decision_loop` for `architecture` (decision 2).
- No change to how `task complete` / `task record-done` behave — lifecycle is
  advisory only (decision 4).
- No `record_only` for `bugfix` / `refactor` yet (conservative; revisit with
  usage data).
- No bug-detection capability — this is execution steering.
