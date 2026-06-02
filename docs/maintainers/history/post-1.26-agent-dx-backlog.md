# Post-1.26 agent-DX backlog (P40-P44 intent)

> Historical record — moved here from `design/decisions/` in the decisions
> responsibility cleanup. This is a sequencing/intent backlog, not a design
> decision that any gate references; each phase it scoped (P40-P44) shipped with
> its own accepted RFC under [`design/decisions/`](../../../design/decisions/README.md).

- Status: complete (intent record, not an implementation RFC; P40-P44 all shipped)
- Date: 2026-05-30
- Related: [Root-cause-first completion errors](../../../design/decisions/root-cause-completion-errors-rfc.md) (P39, accepted)

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
structure, a self-referential version file). Where that risk existed it was
called out below as a re-scope, then settled in the phase's RFC.

## Sequence (differentiation-first)

~~P39~~ → ~~P43~~ → ~~P41~~ → ~~P40~~ → ~~P42~~ → ~~P44~~ (all shipped; the
post-1.26 agent-DX backlog is complete). Rationale: after P39 closed the largest
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
- **Follow-on sequence.** P42 then P44 — both since shipped.

## P42 — project-side version pinning — **shipped (docs-first; no new mechanism)**

- **Outcome.** Closed as a docs-first phase, not a build phase
  (RFC: `design/decisions/version-pinning-guidance-rfc.md`, accepted). An audit
  found the CI side already covered (`docs/cli-contract.md` pins the binary and
  says "do NOT track @latest in CI"); the one real gap was the entry point —
  `docs/getting-started.md` offered only global-install / `npx` with no
  `devDependency` pin path. P42 aligned getting-started.md's install-facing
  guidance (Prerequisites + the Install commands + the alpha/stable-line note)
  to the exact `devDependency` pin (recommended for teams/CI; global/`npx` kept
  for one-off use), which also resolves the mild incoherence between the entry
  point and the CI requirement. One file (getting-started.md), three
  install-facing spots aligned.
- **Rejected (explicit non-goal).** The `.code-pact/code-pact.version` file +
  `CODE_PACT_VERSION_MISMATCH` diagnostic — self-referential (a committed version
  file cannot constrain the *running* CLI, and drifts silently in exactly the
  unpinned-consumer case). The pin belongs in the consumer's `package.json` + CI,
  not in a code-pact mechanism. Not built, not deferred — closed.
- **Held scope.** No reconcile of the other docs that mention pinning in passing
  (README / upgrading.md / migration.md) — widening would re-grow the docs
  surface P39/P41 just trimmed.
- **Follow-up (done in P44).** `docs/ja/getting-started.md`'s Install guidance
  was synced to the English devDependency exact-pin path as part of P44 (the ja
  CI page links to it, so the two had to agree).

## P44 — CI / adoption page — **shipped**

- **Outcome.** Shipped as `design/phases/P44-ci-adoption-page.yaml`
  (RFC: `design/decisions/ci-adoption-page-rfc.md`). Added `docs/workflows/ci.md`
  (+ its `docs/ja` mirror) as the single CI adoption home: a thin orchestration
  page that splits a before-a-PR contributor loop from a maintainer/release full
  loop, ships one minimal `pull_request` GitHub Actions workflow on the
  project-local pinned binary, explains the `plan lint --include-quality`
  advisory nuance, and consolidates the CI preconditions into one checklist. The
  copy-paste workflow template is **owned by `ci.md`**; `cli-contract.md`
  documents only the `--base-ref` contract + diagnostics and links to it. A
  `CI / adoption guidance` row was added to the docs ownership map so future CI
  docs do not re-scatter.
- **Held scope.** No new CLI/flag/detector (the detectors exist — P33/P34), no
  `init`-scaffolded workflow file, no matrix/publish automation, no non-GitHub
  provider pages, no duplicated Actions YAML / detector specs.
- **Constraint met.** No external-tool name-drops; English-primary + `docs/ja`
  mirror shipped together (workflows/* is in the ja-sync list).

## Non-goals (this backlog)

- It did not authorize implementing P40-P44 up front. When this backlog was
  written P39 was the only phase registered in `design/roadmap.yaml`; P40-P44
  were each registered with their own accepted RFC at their turn and have since
  shipped.
- It did not lock the re-scopes above; they were the recommended starting
  position for each phase's RFC, confirmed or overridden there as each shipped.
