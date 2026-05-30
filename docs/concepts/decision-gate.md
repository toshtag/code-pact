# The decision gate (v1.22+)

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
| explicit unknown word (e.g. a typo `acceptd`) | does **not** resolve (surfaced as [`ADR_STATUS_UNRECOGNIZED`](../troubleshooting.md#adr_status_unrecognized-from-plan-lint---include-quality-v124)) |
| **no status line** (non-empty body) | resolves as accepted — the only lenient case, kept so projects that predate status-aware parsing (v1.22) are not broken on upgrade |

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
| `task complete` | `error.code: VERIFICATION_FAILED` + `error.cause_code: DECISION_REQUIRED` (v1.27+, exit 1) | At completion time, when the gate can't resolve an accepted ADR | **Yes** (`progress.yaml` untouched) |
| `task record-done` | `error.code: DECISION_REQUIRED` (exit 2) + full `DecisionRequiredData` | At completion time, when the gate can't resolve an accepted ADR | **Yes** (`progress.yaml` untouched) |
| `verify` (standalone) | a failed `decision` check in `data.verify.checks` | At completion time, when the gate can't resolve an accepted ADR | **Yes** (exit non-zero) |
| `plan lint --include-quality` | `TASK_DECISION_UNRESOLVED` | A `requires_decision` task whose gate doesn't resolve (no ADR, or one that is proposed/empty/etc.) | No (advisory) |
| `plan lint --include-quality` | `ADR_STATUS_UNRECOGNIZED` | An ADR whose explicit status word is a typo | No (advisory) — surfaces *why* the gate won't resolve |

## Recommended flow

1. Mark genuinely design-uncertain tasks `requires_decision: true` (rather than guessing a middle value). `plan prompt` guidance encourages this.
2. Run `plan lint --include-quality` to see `TASK_DECISION_UNRESOLVED` early.
3. Write the ADR (or scaffold stubs with `--scaffold-decisions`), settle the decision, and flip **Status** to `accepted`.
4. `verify` / `task complete` now pass; `task record-done` also passes (external completion or a `record_only` task).

## See also

- [`design/decisions/README.md` § ADR status convention](../../design/decisions/README.md) — the canonical status-line format and the `proposed → accepted` lifecycle.
- [`design/decisions/dogfood-trust-hardening-rfc.md`](../../design/decisions/dogfood-trust-hardening-rfc.md) — the RFC (§3 status-aware gate, §3-D scaffolding) behind this feature.
- [`docs/troubleshooting.md`](../troubleshooting.md#decision_required-from-task-record-done-v121) — recovery for `DECISION_REQUIRED` / `ADR_STATUS_UNRECOGNIZED`.
- [`docs/cli-contract.md` § Error codes](../cli-contract.md#error-codes) — the exact `DECISION_REQUIRED` envelope (`via` / `considered` / `current_resolution`).
