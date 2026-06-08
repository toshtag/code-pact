# RFC: ADR downstream commitments

**Status:** accepted (P43, 2026-05)
**Scope:** an optional `## Implementation commitments` checkbox section in ADRs; an additive `decision_commitments` field on `task prepare`; two advisory `plan lint` diagnostics — `ADR_COMMITMENTS_EMPTY` and `PHASE_DOCS_WRITE_NO_DOC_CHECK`.
**Owners:** maintainer
**Related:** decision gate (P21/P39 — `requires_decision` task gated on an accepted ADR) · [docs/concepts/decision-gate.md](../../docs/concepts/decision-gate.md) (the concept page commitments fold into; no new page) · [docs/cli-contract.md](../../docs/cli-contract.md) · [docs/agent-contract.md](../../docs/agent-contract.md) · [docs/troubleshooting.md](../../docs/troubleshooting.md).

## Summary

The decision gate is enforced (a `requires_decision` task can't complete until an **accepted** ADR resolves it), but the ADR's *downstream consequences* — the migrations, call-site updates, and doc changes the decision implies — live only as free prose the agent never re-reads. This RFC makes those consequences first-class, **deterministically surfaced, advisory-only** — never an LLM free-summary (rejected: non-deterministic, un-pinnable, contrary to the enforcement philosophy). Three pieces: author them in the ADR, surface them on `task prepare`, advise on the empty case in `plan lint`.

## Decisions

### 1. Authoring — `## Implementation commitments`

An ADR may carry a `## Implementation commitments` section: a GitHub-flavored checkbox list (`- [ ]` / `- [x]`) under that exact h2 heading. Optional, human-authored. An unchecked item is downstream work still to implement; a checked item is work already satisfied, or an explicit non-work statement (`- [x] No downstream implementation work.`). The no-work item is for ADRs with genuinely no consequences — not a way to silence the advisory.

**Rationale:** the commitment is a *consequence of the decision*, so it belongs with the decision (one source of truth), reusing the existing ADR resolution — not duplicated onto every gated task's YAML.

### 2. Surfacing — `decision_commitments` on `task prepare`

`task prepare` gains an additive `decision_commitments` field. For a gated task (`isDecisionRequiredForTask` — the same predicate `verify` uses, honoring task- and phase-level `requires_decision`), it resolves the gate and, for each **accepted considered** ADR (every accepted ADR the resolver considered, whether or not the gate as a whole resolves — prepare is advisory context, not a gate), re-reads the file and parses its commitments.

Envelope addition (additive; existing fields unchanged):

- `decision_commitments`: array of `{ adr: "<path>", has_section: bool, items: [{ text, done }] }`, one entry per accepted considered ADR, in the resolver's `considered[]` order.
- Order carries **no** chronological / priority / dependency meaning; consumers must not read priority into it.
- Present (possibly `[]`) **only for gated tasks**; omitted for non-gated tasks (field-presence parity with existing optional fields / the P39 additive-field discipline). `[]` when no accepted ADR was considered.
- `has_section` distinguishes "no section" from "section present, zero items".
- The early-return states (done / blocked / unmet-deps) are untouched and do no new I/O; gate resolution is read-only, so the progress-read-only invariant holds.

**Rationale:** prepare is the one per-task entry point an agent always calls, so the surface goes there. It is **not** a gate: a gated task with no accepted ADR returns `[]` and does not fail or add a decision-error field — it never duplicates the `verify` / `task complete` gate enforcement.

### 3. Advisory — `ADR_COMMITMENTS_EMPTY`

`plan lint --include-quality` emits `ADR_COMMITMENTS_EMPTY` (`severity: warning`, `affects_exit: false` **even under `--strict`**): an **accepted** ADR that **resolves** a `requires_decision` task's gate has no `## Implementation commitments` section, or the section is present with zero checkbox items. `file: <adr path>`, plus `task_id` / `phase_id`; `path` is **omitted** (its subject is ADR content, not a plan-YAML field — matching the two existing ADR-centric advisories); `details: { has_section, item_count }`. First task wins → one issue per ADR.

The advisory is **gate-resolved-only** (narrower than the prepare surface): a proposed/draft/empty/unknown ADR never fires; an accepted ADR no gated task references never fires (historical ADRs stay silent); and an accepted ref inside an **unresolved** explicit `decision_refs` set (all-must-be-accepted) never fires — the message says the ADR "resolves the gate", so it must actually resolve. The unresolved case is `TASK_DECISION_UNRESOLVED`'s job.

**Rationale:** surfaces "you recorded a decision but committed to nothing" without ever failing the build. The resolved-gate scope keeps it signal, not noise.

### 4. `PHASE_DOCS_WRITE_NO_DOC_CHECK` (docs-drift guard)

P43's dominant risk is docs drift (the P39 lesson). `plan lint --include-quality` also emits `PHASE_DOCS_WRITE_NO_DOC_CHECK` (`severity: warning`, `affects_exit: false`): a **not-yet-`done`** phase whose task `writes` a public doc that `check:docs` guards, but whose `verification.commands` run no doc check. `file` is the phase YAML, `path` is `verification.commands`, `details.doc_write`.

Scoped to avoid false positives: **CHANGELOG.md is excluded** (it is in `check:docs`'s `ROOT_SOURCE_SKIP`); **`design/**` is excluded** (validated by `validate` / `plan lint`, not the public-docs checker); **`done` phases are excluded** (frozen history — flagging them is pure noise). Structural (phase-YAML only, no free-text parsing).

**Rationale:** the generalized, mechanical form of the P39/P43 docs-drift lesson — catch a phase editing public docs without a doc check, instead of leaving it to manual review.

## Non-goals

- **No new gate.** Commitments never block `task complete` / `verify` / `record-done`. The decision gate is unchanged.
- **No completion tracking / checkbox mutation.** code-pact parses checkbox state for surfacing; it never edits the ADR to tick boxes. Done-state is the author's record.
- **No `task context` echo (this phase).** Commitments surface on `task prepare` only; echoing them in `task context` would duplicate the surface for no decided benefit — deferred.
- **No LLM summarization.** The parse is a literal checkbox extraction under a fixed heading (a small regex) — no paraphrase, no inference, no Markdown AST.
- **No new concept page.** The concept folds into `docs/concepts/decision-gate.md`.

## Parse contract

`parseAdrCommitments(content) → { hasSection, items: [{ text, done }] }` — pure, deterministic, no I/O, mirroring `parseAdrStatus`:

- Strip frontmatter first so a `status:` key can't be mistaken for body.
- Match the first heading `/^\s*##\s+implementation commitments\s*$/i` — exact `##` level, case-insensitive title (`###` does not match). None → `{ hasSection: false, items: [] }`.
- Section bounds: from after the heading to the next h2 (`/^\s*##\s/`) or EOF.
- Items: per line `/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/` → `{ text, done }`, `done = group[1].toLowerCase() === "x"`. Non-checkbox lines (prose, blanks) ignored.

## Alternatives considered

- **A `commitments` field on the task schema (YAML), not the ADR** — rejected; duplicates the consequence onto every gated task instead of keeping one source of truth in the ADR.
- **Hard-gating completion on un-done commitments** — rejected; done-state is a human record code-pact does not own. Gating would force agents to tick boxes to proceed (checkbox theater), inverting the advisory philosophy.
- **LLM-summarized "what this decision implies"** — rejected outright; non-deterministic, un-pinnable, contrary to the enforcement philosophy.
- **Pure file-centric advisory (every accepted ADR, like P36)** — rejected; no existing ADR carries the section, so it would warn on the whole `design/decisions/` corpus the moment `--include-quality` runs. The resolved-gate scope keeps it signal.

## Open questions (resolved at acceptance)

- **Commitment syntax** — a checkbox list under the fixed `## Implementation commitments` heading (no richer schema).
- **`task context` echo** — no; commitments are prepare-only this phase.

## References

- Concept: [docs/concepts/decision-gate.md](../../docs/concepts/decision-gate.md) (ADR shape, `## Implementation commitments`, `done` semantics, no-work anti-abuse note, `ADR_COMMITMENTS_EMPTY` scope).
- Contract: [docs/cli-contract.md](../../docs/cli-contract.md) (the `task prepare` envelope + both diagnostic-table rows) · [docs/agent-contract.md](../../docs/agent-contract.md) (`decision_commitments` is advisory context, not a gate) · [docs/troubleshooting.md](../../docs/troubleshooting.md) (both diagnostics: warning not blocker + recovery).
