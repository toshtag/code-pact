# The decision gate

The decision gate is the one thing code-pact **enforces** for design-sensitive tasks: a task marked `requires_decision: true` cannot be completed until an accepted Architecture Decision Record (ADR) exists for it. This page is the user-facing walkthrough. The exact contract (error codes, JSON envelopes) lives in [`cli-contract.md`](../cli-contract.md#error-codes); the rationale and ordering constraints are in [`design/decisions/dogfood-trust-hardening-rfc.md`](../../design/decisions/dogfood-trust-hardening-rfc.md).

## Why it exists

A roadmap often contains tasks whose *how* is genuinely uncertain — they need a human design decision before implementation. Marking such a task `requires_decision: true` (on the task, or on its phase to cover all its tasks) turns that intent into an enforced gate: code-pact will not record the task as `done` until the decision has been written down **and accepted**. It is the single most valuable guard the control plane provides for design work, which is why it is deliberately **not** bypassable — even `task record-done`, which skips verification commands for work recorded without `task complete` (external completion or a `record_only` task), still runs this gate.

## What an ADR looks like

An ADR is a markdown file under `design/decisions/`. Its status is read from a YAML frontmatter `status:` key (preferred) or a `**Status:**` bold line near the top — when both are present, frontmatter wins:

```md
# Decision: P2-T1 — event store choice

**Status:** accepted (P2, 2026-05)

## Context
...
## Decision
...
## Consequences
...
```

The status word governs the gate:

| Status | Gate verdict |
| --- | --- |
| `accepted` | resolves — the task can complete |
| `proposed` / `draft` / `rejected` / `superseded` | does **not** resolve |
| empty file | does **not** resolve |
| explicit unknown word (e.g. a typo `acceptd`) | does **not** resolve (surfaced as [`ADR_STATUS_UNRECOGNIZED`](../troubleshooting.md#adr_status_unrecognized-from-plan-lint---include-quality)) |
| **no status line** (non-empty body) | resolves as accepted — the only lenient case, kept so projects that predate status-aware parsing are not broken on upgrade |

### Implementation commitments

An accepted ADR may carry an optional `## Implementation commitments` section: a GitHub-flavored checkbox list of the concrete downstream work the decision implies.

```md
## Implementation commitments

- [ ] Migrate call sites of foo() to bar()
- [x] Update docs/cli-contract.md
```

`done` semantics: an **unchecked** item (`- [ ]`) is downstream work still to implement; a **checked** item (`- [x]`) is work already satisfied, or an explicit non-work statement (`- [x] No downstream implementation work.`). Use the no-work item **only when the ADR genuinely has no implementation consequences — not merely to silence the [`ADR_COMMITMENTS_EMPTY`](../troubleshooting.md#adr_commitments_empty-from-plan-lint---include-quality) advisory** (the point of recording commitments is to make the downstream consequences deliberate).

`task prepare` echoes these for a gated task as `decision_commitments` (parsed deterministically — checkbox extraction under the fixed heading, no summarization). It is advisory context, not a gate.

## How a task is matched to an ADR

Two resolution paths, by whether the task declares [`decision_refs`](task-readiness-fields.md#decision_refs):

- **Explicit `decision_refs` → all-must-be-accepted.** Every path the task lists must resolve to an `accepted` ADR. A single `proposed` / `empty` / `missing` / unknown-status / unsafe reference fails the gate. A reference that escapes the project root (`..`, an absolute path, or a symlink out of the repo) is **fail-closed**: it is never read and never resolves — so a planted `accepted` ADR outside the repo cannot satisfy the gate. Explicit references are a strong contract — use them when a task depends on more than one decision. (A `decision_refs` path may point at any *safe, repo-relative* decision document; it is not currently restricted to `design/decisions/`.)
- **No `decision_refs` → filename scan (any-accepted-wins).** The gate scans `design/decisions/` for any `.md` whose filename contains the task id (e.g. `P1-T1` matches `design/decisions/P1-T1.md` or `P1-T1-rfc.md`) and resolves if **any** match is accepted. The substring match is a long-standing compatibility quirk (`P1-T1` also matches `P1-T10-*.md`).

## Scaffolding the stubs: `--scaffold-decisions`

Importing an AI-generated roadmap full of `requires_decision` tasks would otherwise leave every one blocked with no ADR to fill. The opt-in flag generates the work-surface:

```sh
code-pact phase import roadmap.yaml --scaffold-decisions      # also: plan adopt --write --scaffold-decisions
```

For each gated task it writes a `**Status:** proposed` stub (at the task's `decision_refs` paths under `design/decisions/`, or the default `design/decisions/<task-id>.md`). A `proposed` stub does **not** pass the gate — filling it in and flipping **Status** to `accepted` is the human act that releases it. Existing ADRs are never overwritten; unsafe paths are rejected; off by default. See [`cli-contract.md` § `phase import`](../cli-contract.md#phase-import).

## Where the gate surfaces

The same shared resolver drives every surface below, so they never disagree on
what "resolved" means. The completion commands enforce the gate; `plan lint`
surfaces it earlier as advisories.

| Surface | Code | When | Blocks? |
| --- | --- | --- | --- |
| `task complete` | `error.code: VERIFICATION_FAILED` + `error.cause_code: DECISION_REQUIRED` (exit 1) | At completion time, when the gate can't resolve an accepted ADR | **Yes** (no progress event recorded) |
| `task record-done` | `error.code: DECISION_REQUIRED` (exit 2) + full `DecisionRequiredData` | At completion time, when the gate can't resolve an accepted ADR | **Yes** (no progress event recorded) |
| `verify` (standalone) | a failed `decision` check in `data.checks` (note: NOT `data.verify.checks`, which is the `task complete` path) | At completion time, when the gate can't resolve an accepted ADR | **Yes** (exit non-zero) |
| `plan lint --include-quality` | `TASK_DECISION_UNRESOLVED` | A `requires_decision` task whose gate doesn't resolve (no ADR, or one that is proposed/empty/etc.) | No (advisory) |
| `plan lint --include-quality` | `ADR_STATUS_UNRECOGNIZED` | An ADR whose explicit status word is a typo | No (advisory) — surfaces *why* the gate won't resolve |
| `plan lint --include-quality` | [`ADR_COMMITMENTS_EMPTY`](../troubleshooting.md#adr_commitments_empty-from-plan-lint---include-quality) | An accepted ADR that **resolves** a gated task's gate, with no/empty `## Implementation commitments` | No (advisory) — unreferenced ADRs and unresolved (partially-accepted) gates never fire |
| `task prepare` | `decision_commitments` | A `requires_decision` task — echoes each accepted **considered** ADR's parsed `## Implementation commitments` (resolved-agnostic) | No (advisory context, not a gate) |

## Recommended flow

1. Mark genuinely design-uncertain tasks `requires_decision: true` (rather than guessing a middle value). `plan prompt` guidance encourages this.
2. Run `plan lint --include-quality` to see `TASK_DECISION_UNRESOLVED` early.
3. Write the ADR (or scaffold stubs with `--scaffold-decisions`), settle the decision, and flip **Status** to `accepted`.
4. `verify` / `task complete` now pass; `task record-done` also passes (external completion or a `record_only` task).

## See also

- [`design/decisions/README.md` § ADR status convention](../../design/decisions/README.md) — the canonical status-line format and the `proposed → accepted` lifecycle.
- [`design/decisions/dogfood-trust-hardening-rfc.md`](../../design/decisions/dogfood-trust-hardening-rfc.md) — the RFC (§3 status-aware gate, §3-D scaffolding) behind this feature.
- [`docs/troubleshooting.md`](../troubleshooting.md#decision_required-from-task-record-done) — recovery for `DECISION_REQUIRED` / `ADR_STATUS_UNRECOGNIZED`.
- [`docs/cli-contract.md` § Error codes](../cli-contract.md#error-codes) — the exact `DECISION_REQUIRED` envelope (`via` / `considered` / `current_resolution`).
