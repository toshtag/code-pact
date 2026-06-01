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

~~P39~~ → ~~P43~~ → ~~P41~~ → ~~P40~~ → ~~P42~~ → **P44** (P39, P43, P41, P40, and
P42 shipped; remaining is P44). Rationale: after P39 closed the largest
current pain, we led with the one capability the feedback empirically validated
(P43 — shipped), banked the cheap trust fill (P41 — shipped), then took the first
contract-shape decision (P40 — shipped, the most bloat-prone, done conservatively
via Option C). A pain-first ordering (P40 before P43) was considered and rejected:
P40 is a contract-shape change that needs its own ADR and carries a real bloat
risk, whereas P43 strengthened a proven win.

## P43 — ADR downstream commitments — **shipped**

- **Outcome.** Shipped as `design/phases/P43-adr-downstream-commitments.yaml`
  (RFC: `design/decisions/adr-downstream-commitments-rfc.md`). An ADR may carry a
  `## Implementation commitments` checkbox list. `task prepare` surfaces the
  parsed commitments of the **accepted ADRs the decision resolver considered** as
  an additive `decision_commitments` field (advisory context, not gate
  enforcement — an unresolved explicit `decision_refs` gate may still surface its
  accepted refs). `plan lint --include-quality` emits `ADR_COMMITMENTS_EMPTY`
  (`affects_exit: false`) only for an accepted ADR that **resolves** a
  `requires_decision` task's gate and records no implementation commitments.
- **Also shipped:** `PHASE_DOCS_WRITE_NO_DOC_CHECK` — a forward-looking
  docs-drift guard (a not-`done` phase that writes public docs but runs no doc
  check in its verification), generalizing the P39/P43 docs-drift lesson.
- **Fit with the enforcement philosophy:** deterministic surfacing, advisory
  only, never an LLM free-summary (explicitly rejected). Resolved open questions:
  commitment syntax is a checkbox list under the fixed `## Implementation
  commitments` heading; `task context` does **not** echo commitments (prepare-only).
- **Follow-on sequence:** remaining backlog is P42 → P44 (P41 and P40 have since shipped).

## P41 — leaf help + docs straightening — **shipped**

- **Outcome.** Shipped as `design/phases/P41-leaf-help-docs-straightening.yaml`
  (RFC: `design/decisions/leaf-help-docs-straightening-rfc.md`). The 7 stubbed
  task lifecycle verbs (`add`, `context`, `start`, `status`, `block`, `resume`,
  `runbook`) now have rich leaf `--help`, pinned by a unit suite
  (`task-lifecycle-help-terms.test.ts`, all 11 rich task verbs) and the
  integration `cli-help` table. The `record_only` lifecycle explanation is
  consolidated to its canonical home `docs/per-task-loop.md`; `cli-contract.md`
  and `agent-contract.md` link out for the concept while keeping their
  role-specific contract/agent facts. No new docs page; aliases (`next`/
  `reconcile`) intentionally stay stubs (a later task).
- **Scope held:** `--help` parity was limited to the 7 task verbs (plan/phase/
  adapter stubs deferred); docs were reduced (duplication removed), not grown.

## P40 — task prepare lifecycle-aware — **shipped**

- **Outcome.** Shipped as `design/phases/P40-task-prepare-lifecycle-aware.yaml`
  (RFC: `design/decisions/task-prepare-lifecycle-aware-rfc.md`), authored as the
  mandated `decision_loop` phase (P40-T0 `requires_decision`, gated on its RFC).
  `task prepare` keeps `commands` as a complete, **mode-agnostic lookup table**
  and adds the additive `commands["record-done"]` template (every mode; the one
  non-runnable entry — `--evidence` is agent-supplied). `next_action.message`
  became the **single** lifecycle-aware guidance surface (workable states only):
  `record_only` points at `task record-done`, `decision_loop` says resolve the
  gating ADR first (without deciding complete-vs-record-done), `full_loop` keeps
  the standard wording.
- **Contract decision — Option C (the bloat-avoiding choice).** The original
  re-scope considered making the existing surfaces mode-aware by *filtering/
  ordering* `commands` by `lifecycleMode`. That was **rejected during the RFC**:
  filtering `commands` is a v1-breaking change, and any ordered-key hint is the
  same "third what-next representation" the proposed `recommended_flow` would be.
  Final: **no command filtering, no ordered array, no `recommended_flow`, no new
  `next_action.type`** — only one additive `commands` key + a mode-aware
  `next_action.message`.
- **Remaining sequence.** P44.

## P42 — project-side version pinning — **shipped (docs-first; no new mechanism)**

- **Outcome.** Closed as a docs-first phase, not a build phase
  (RFC: `design/decisions/version-pinning-guidance-rfc.md`, accepted). An audit
  found the CI side already covered (`docs/cli-contract.md` pins the binary and
  says "do NOT track @latest in CI"); the one real gap was the entry point —
  `docs/getting-started.md` offered only global-install / `npx` with no
  `devDependency` pin path. P42 added that one Install block (pin as a
  `devDependency`, recommended for teams/CI; global/`npx` kept for one-off use),
  which also resolves the mild incoherence between the entry point and the CI
  requirement. Single-file docs change.
- **Rejected (explicit non-goal).** The `.code-pact/code-pact.version` file +
  `CODE_PACT_VERSION_MISMATCH` diagnostic — self-referential (a committed version
  file cannot constrain the *running* CLI, and drifts silently in exactly the
  unpinned-consumer case). The pin belongs in the consumer's `package.json` + CI,
  not in a code-pact mechanism. Not built, not deferred — closed.
- **Held scope.** No reconcile of the other docs that mention pinning in passing
  (README / upgrading.md / migration.md) — widening would re-grow the docs
  surface P39/P41 just trimmed.
- **Follow-up.** Sync `docs/ja/getting-started.md`'s Install guidance to match the
  English devDependency exact-pin path (the ja getting-started is linked from the
  English page, so ja readers currently see the older install guidance). Not done
  in P42 — translation work would defeat the close-small intent.

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
