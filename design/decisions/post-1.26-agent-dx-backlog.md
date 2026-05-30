# Post-1.26 agent-DX backlog (P40-P44 intent)

- Status: planning (intent record, not an implementation RFC)
- Date: 2026-05-30
- Related: [Root-cause-first completion errors](root-cause-completion-errors-rfc.md) (P39, accepted)

## What this is

A sequencing record for the agent-facing DX work that follows P39. It captures
intent only — each phase below ships with its **own** accepted RFC authored at
its turn, not from this file. The source is the 1.26.0 real-use feedback (an AI
agent driving `task complete` on `requires_decision` tasks) plus a proposed
external roadmap. The headline finding the feedback **proved**: an ADR's
pre-commitments propagated into the downstream implementation/tests (P2-T1 →
P2-T2). That is code-pact's demonstrated differentiator, and it shapes the order.

The theme across all of these is the same as P39: **do not add value the agent
can't find — make the control surface carry it.** Several of the proposed
phases, taken literally, would *widen* the contract (a third "what next"
structure, a self-referential version file). Where that risk exists it is called
out below as a re-scope to settle in the phase's RFC.

## Sequence (differentiation-first)

P39 → **P43 → P41 → P40 → P42 → P44**. Rationale: after P39 closes the largest
current pain, lead with the one capability the feedback empirically validated
(P43), bank the cheap trust fill (P41), then take the contract-shape decisions
(P40, P42) deliberately. A pain-first ordering (P40 before P43) was considered
and rejected for now: P40 is a contract-shape change that needs its own ADR and
carries a real bloat risk, whereas P43 strengthens a proven win.

## P43 — ADR downstream commitments (next after P39)

- **Goal.** Make the proven ADR→downstream effect first-class: a structured
  `## Implementation commitments` checklist in the ADR, surfaced by
  `task prepare` as `decision_commitments`, plus a `plan lint` advisory
  `ADR_COMMITMENTS_EMPTY` when an accepted ADR referenced by a task has no
  commitments block.
- **Why first.** It doubles down on the single thing 1.26.0 use proved unique.
  It also fits the enforcement philosophy: deterministic surfacing, advisory
  (`affects_exit: false`), never an LLM free-summary (that would be
  non-deterministic — explicitly rejected).
- **Open at RFC time.** Exact commitment syntax (checkbox list under a fixed
  heading) and whether `task context` echoes commitments too.

## P41 — leaf help + docs straightening (cheap fill)

- **Goal.** Bring every lifecycle verb's leaf `--help` to parity (the feedback
  flagged `task add --help` as a stub while `task complete --help` is rich), and
  pin it with a help-coverage test (same mechanism as P38-T3's record-done
  required-term test). Straighten the duplicated `record_only` explanation across
  docs into one home and link to it.
- **Why cheap.** Agents use `--help` as an exploration surface; the test makes
  coverage mechanical. Low risk, independent of the contract work.
- **Constraints.** Honor the docs structure (English-primary + `docs/ja` mirror,
  hub aggregation; do not bloat README). Any new concept page (e.g. a
  lifecycle-modes page) follows that layout.

## P40 — task prepare lifecycle-aware (contract decision)

- **Verified premise.** `task prepare`'s `commands` dict is built once and is
  identical regardless of `recommendation.lifecycleMode`; `next_action.message`
  is static per task-state, not mode-aware. So the gap is real.
- **Re-scope (settle in RFC).** The proposed fix adds a NEW `recommended_flow`
  structure. That would be a **third** "what next" representation alongside the
  existing `commands` and `next_action` — ambiguous (which is authoritative?)
  and contrary to "small surfaces, clear contracts", i.e. it works against the
  very goal of not making the agent guess. Prefer making the **existing**
  surfaces mode-aware: filter/order `commands` by `lifecycleMode` and reflect
  the mode in `next_action.message`. If a `recommended_flow` is still wanted,
  `next_action` must be derived from it (one source of truth), not added beside
  it. This is a contract-shape decision → author as a `decision_loop` phase.

## P42 — project-side version pinning (re-scope to docs-first)

- **Re-scope (settle in RFC).** The feedback itself says this is the
  *consumer's* responsibility (pin the `devDependency`; stop following
  `npx code-pact@latest`). A `.code-pact/code-pact.version` file + a
  `CODE_PACT_VERSION_MISMATCH` diagnostic is self-referential: it cannot
  guarantee the *running* CLI matches, and it drifts silently in exactly the
  case it is meant to catch (an unpinned consumer). Lead with docs — drop
  `npx @latest` as the default recommendation, document `devDependency` pin + CI
  using the pinned binary — and consider only a lightweight `validate` advisory.
  The full `.version` mechanism is lower priority and may not be built.

## P44 — CI / adoption kit (docs + template, last)

- **Goal.** Lower adoption friction: a `docs/` CI page (the `validate --strict`
  / `doctor --base-ref` / `plan lint --strict` sequence) and a GitHub Actions
  template. The detectors it documents (`CONTROL_PLANE_*`, branch-drift) already
  exist (P33/P34), so this is purely docs + template.
- **Constraints.** No external-tool name-drops in public docs; English-primary +
  `docs/ja` mirror.

## Non-goals (this backlog)

- It does not authorize implementing P40-P44 now. P39 is the only phase
  registered in `design/roadmap.yaml`; each of P40-P44 is registered with its own
  accepted RFC when its turn comes.
- It does not lock the re-scopes above; they are the recommended starting
  position for each phase's RFC, to be confirmed or overridden there.
