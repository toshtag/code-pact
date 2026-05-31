# RFC: ADR downstream commitments

- Status: accepted
- Phase: P43
- Date: 2026-05-31

## Problem

code-pact's proven, differentiating effect in 1.26.0 use is the
ADR→downstream link: a `requires_decision` task cannot be completed until an
**accepted** ADR resolves its decision gate (P21/P39). That makes the *decision*
first-class. But the ADR's **downstream consequences** — "given this decision,
these concrete things must be done" — live only as free prose in the ADR body.
Nothing surfaces them to the agent at work time, and nothing flags an accepted
ADR that records a decision but commits to no follow-through.

The observed gap: an agent runs `task prepare`, sees the task is gated on an
ADR, writes/accepts the ADR, and proceeds — but the ADR's implementation
consequences (migrations, call-site updates, doc changes the decision implies)
are buried in prose the agent never re-reads. The decision is enforced; its
commitments are not even surfaced.

## Goal

Make the ADR's downstream commitments first-class, **deterministically surfaced,
advisory-only** — never an LLM free-summary (that would be non-deterministic and
is explicitly rejected, per the enforcement philosophy: scripts supply
information and encode the AI-free logic; human-judgement areas stay advisory and
are surfaced, not hard-blocked).

Three pieces:

1. **Authoring.** An ADR may carry a `## Implementation commitments` section: a
   GitHub-flavored checkbox list (`- [ ]` / `- [x]`) under that exact h2 heading.
   Free, optional, human-authored. `done` semantics: an unchecked item is
   downstream work still to implement; a checked item is work already satisfied
   by the ADR/task, or an explicit non-work statement
   (`- [x] No downstream implementation work.`). The no-work item is for ADRs that
   genuinely have no implementation consequences — not a way to silence the
   advisory.

2. **Surfacing.** `task prepare` adds an additive `decision_commitments` field:
   for the accepted ADR(s) that resolve the task's decision gate, the parsed
   commitment items (text + done state + a `has_section` flag, per source ADR).
   Deterministic parse, no summarization. The array preserves the decision
   resolver's `considered[]` order — it carries no chronological / priority /
   dependency meaning.

3. **Advisory.** `plan lint` gains `ADR_COMMITMENTS_EMPTY` (`affects_exit: false`,
   even under `--strict`): an **accepted** ADR that resolves a `requires_decision`
   task's gate has no `## Implementation commitments` section, or the section is
   present with zero checkbox items. Surfaces "you recorded a decision but
   committed to nothing"; never fails the build.

## Non-goals

- **No new gate.** Commitments never block `task complete` / `verify` /
  `record-done`. The decision gate stays exactly as it is (an accepted ADR
  resolves it); commitments are surfaced and advised, not enforced.
- **No decision-error surface on `task prepare`.** `task prepare` is an
  implementation-support surface, not a gate. For a gated task with no accepted
  ADR it returns `decision_commitments: []` and does **not** fail, does **not**
  add a decision-error field, and does **not** duplicate the verify / task
  complete gate enforcement.
- **No `task context` echo (this phase).** Commitments surface on `task prepare`
  only — the one per-task entry point an agent always calls. Echoing them in
  `task context` too would duplicate the surface for no decided benefit;
  deferred.
- **No completion tracking / checkbox mutation.** code-pact parses the checkbox
  state for surfacing; it never edits the ADR to tick boxes. Done-state is the
  author's record, not a code-pact-managed state.
- **No LLM summarization.** The parse is a literal checkbox extraction under a
  fixed heading. No paraphrase, no inference, no Markdown AST — a small regex.
- **No new concept page.** The commitments concept folds into the existing
  `docs/concepts/decision-gate.md` (it already documents the ADR shape and where
  the gate surfaces); we do not scatter docs into a new file.

## Design

### Parse (`src/core/decisions/adr.ts`)

Add `parseAdrCommitments(content: string): AdrCommitments` alongside the existing
`parseAdrStatus` / `classifyAdr`. Pure, deterministic, no I/O, mirroring
`parseAdrStatus`:

```ts
export type AdrCommitment = { text: string; done: boolean };
export type AdrCommitments = { hasSection: boolean; items: AdrCommitment[] };
```

- `normalizeNewlines`, then `parseFrontMatter` to strip frontmatter so a `status:`
  key cannot be mistaken for body (the `detectAdrAcceptedBodyThin` pattern).
- Locate the first heading matching `/^\s*##\s+implementation commitments\s*$/i`
  (exact `##` level, case-insensitive title; `###` does not match). None →
  `{ hasSection: false, items: [] }`.
- Section bounds: from after the heading to the next `/^\s*##\s/` (any h2) or EOF.
- Items: per line `/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/` → `{ text, done }` where
  `done = group[1].toLowerCase() === "x"`. Non-checkbox lines (prose, blanks) are
  ignored.
- `hasSection` distinguishes "no section" from "section present, zero items" — the
  lint needs both. `classifyAdr` is left untouched (avoids perturbing its tests).

### Surface (`src/commands/task-prepare.ts`)

`task prepare` does **not** currently resolve the decision gate — it passes only a
`phaseRequiresDecision` boolean to `resolveRecommendation`. So T1 adds the
resolution. For a gated task (`isDecisionRequiredForTask(phase, task)` — the same
predicate `verify` uses, honoring task- and phase-level `requires_decision`), call
`resolveDecisionGate(cwd, taskId, task.decision_refs)`. `DecisionResolution.considered[]`
carries only `{ path, status, accepted, acceptance }` — **no content** — so for
each `accepted` entry, re-read the file by its `path` and `parseAdrCommitments` it.

Envelope addition (additive — existing fields unchanged):

```json
"decision_commitments": [
  { "adr": "design/decisions/<file>.md", "has_section": true, "items": [
    { "text": "Migrate call sites of foo() to bar()", "done": false },
    { "text": "Update docs/cli-contract.md", "done": true }
  ] }
]
```

`decision_commitments` is present (possibly `[]`) only for gated tasks; omitted
for non-gated tasks (field-presence parity with existing optional fields and the
P39 additive-error-field discipline). The early-return states
(done/blocked/unmet-deps) are untouched, so they do no new I/O; the
progress-read-only invariant holds (`resolveDecisionGate` is read-only). Entries
follow `considered[]` order; consumers must not read priority into the order.

### Advisory (`src/core/plan/lint.ts`)

Add `detectAdrCommitmentsEmpty(cwd, phases)` beside `ADR_STATUS_UNRECOGNIZED` and
the P36 empty-stub advisory, wired into the quality block under `includeQuality`.
Using `makeDecisionResolver(cwd)` (the memoized resolver `detectUnresolvedDecision`
already uses): for each `requires_decision` task (task- or phase-level), resolve
and collect `considered[].path where accepted` into a map keyed by ADR path (first
referencing task wins → one issue per ADR). For each unique accepted+referenced
ADR, read it, `parseAdrCommitments`, and if `!hasSection || items.length === 0`
emit `ADR_COMMITMENTS_EMPTY` (`severity: warning`, `affects_exit: false`,
`file: <adr path>`, `task_id`, `phase_id`, `details: { has_section, item_count }`).

Only **accepted** ADRs are considered (proposed/draft/empty/unknown never fire),
and only those referenced by a gated task (so historical ADRs that no task
references never warn — the noise-control guard; without it, every accepted ADR
in the repo would warn, since none carry the section yet).

`PlanIssue.path` is, in every existing use, a field position inside a plan YAML
(`definition_of_done[i]`, `requires_decision`, `confidence`, …). The two existing
ADR-centric advisories set `file: <adr path>` and **omit `path`**. This advisory
does the same: its subject is ADR content, not a plan-YAML field, so `path` is
omitted; `file` is the ADR and `task_id`/`phase_id` name the referencing task.

### Contract docs (and the P39 anti-drift guard)

`decision_commitments` and `ADR_COMMITMENTS_EMPTY` are additive surface. The
JSON-output-shape section already states envelopes may carry additive fields
(P39 / the `check-doc-invariants` rule #8), so only per-command/per-code docs
change.

## Documentation contract checklist

P43's dominant risk is contract/agent-doc drift, not code (the P39 lesson). Each
task MUST update these docs (verified to exist; a new `adr-commitments.md` is
deliberately NOT created — the concept folds into `decision-gate.md`):

- **T1** must update: `docs/cli-contract.md` (the `task prepare` envelope +
  `decision_commitments` shape, gated-only presence, empty-`[]` unresolved case,
  `done` semantics, order note), `docs/agent-contract.md` (the `task prepare`
  entry reads `decision_commitments` as advisory context, not a gate),
  `docs/concepts/decision-gate.md` (the `## Implementation commitments` section in
  the ADR shape + `done` semantics + no-work anti-abuse note), `CHANGELOG.md`.
- **T2** must update: `docs/cli-contract.md` (the `ADR_COMMITMENTS_EMPTY` row:
  advisory-only incl. under `--strict`, `file` is the ADR, no `path`,
  `details.has_section`/`item_count`), `docs/troubleshooting.md` (warning not
  blocker; fix; no-work anti-abuse note), `docs/concepts/decision-gate.md` (the
  advisory's scope: accepted + gated-task-referenced only), `CHANGELOG.md`.

## Alternatives considered

- **A `commitments` field on the task schema (YAML), not the ADR.** Rejected: the
  commitment is a *consequence of the decision*, so it belongs with the decision
  (the ADR), not duplicated onto every gated task. Keeping it in the ADR keeps one
  source of truth and reuses the existing ADR resolution.
- **Hard-gating completion on un-done commitments.** Rejected: commitment
  done-state is a human record code-pact does not own; gating on it would force
  agents to tick boxes to proceed, inverting the advisory philosophy and creating
  a checkbox-theater incentive.
- **LLM-summarized "what this decision implies".** Rejected outright:
  non-deterministic, un-pinnable, contrary to the enforcement philosophy.
- **Pure file-centric advisory (every accepted ADR, like P36).** Rejected:
  no existing ADR carries the section, so it would warn on the entire
  `design/decisions/` corpus the moment `--include-quality` runs. The
  gated-task-referenced scope keeps it signal, not noise.
