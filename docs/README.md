# code-pact documentation

> 🌐 日本語の入口は [docs/ja/](ja/README.md) にあります（一次ドキュメントは英語です）。

The fastest way in is [`getting-started.md`](getting-started.md) — empty project to your first `task complete` in about thirty minutes. If you already know the shape of the work, jump straight to the workflow guide that matches your situation: starting from scratch, or adopting code-pact on an existing repo.

## Start here

| Doc | What it covers |
| --- | --- |
| [getting-started.md](getting-started.md) | First-thirty-minutes guide — onboarding approaches (smoke test / agent-first / plan adopt / code-pact-first / manual) and the per-task loop. |
| [per-task-loop.md](per-task-loop.md) | The canonical per-task lifecycle — the state diagram, the verbs, and a worked example. |
| [glossary.md](glossary.md) | Plain-language definitions for every code-pact term used in these docs. |
| [positioning.md](positioning.md) | What code-pact is, what it deliberately is not, the core CLI surfaces, and the success metrics it measures itself against. |

## Workflows

Pick the guide that matches where you're starting from. Both defer to `getting-started.md` for the exact command sequences and focus on **what to write** and **how to scope the work**.

| Guide | When to use |
| --- | --- |
| [workflows/greenfield.md](workflows/greenfield.md) | **Starting from an empty repo.** What to put in the brief and constitution, how to shape the first phases, the smallest useful first PR. |
| [workflows/brownfield-feature.md](workflows/brownfield-feature.md) | **Adopting code-pact on an existing codebase.** Scoping to one feature, coexisting with an existing `CLAUDE.md` / `AGENTS.md`, choosing a verify command. |
| [workflows/ci.md](workflows/ci.md) | **Running code-pact in CI.** Which checks to run when (contributor vs maintainer loop), a minimal GitHub Actions gate on the pinned binary, and the preconditions checklist. |

## Reference

| Doc | What it covers |
| --- | --- |
| [cli-contract.md](cli-contract.md) | The stable CLI contract: exit codes, JSON envelope, error/cause codes, and the stability taxonomy. |
| [cli-reference.generated.md](cli-reference.generated.md) | Generated command flags, usage, and examples for CommandSpec-backed surfaces. |
| [agent-contract.md](agent-contract.md) | The agent contract and what `adapter conformance` requires of each agent integration. |
| [spec-kit-bridge.md](spec-kit-bridge.md) | Importing an existing Spec Kit `tasks.md` / `spec.md` into a code-pact roadmap. |
| [upgrading.md](upgrading.md) | How to upgrade — additive within a major, with a migration note per major bump; pointers for coming from an earlier alpha. |

## Concepts

These explain how a feature works for users. The *why* behind each — the design decisions — is indexed in [`design/decisions/`](../design/decisions/README.md).

| Doc | What it covers |
| --- | --- |
| [concepts/task-readiness-fields.md](concepts/task-readiness-fields.md) | Optional task schema fields (`depends_on` / `reads` / `writes` / …) and their `plan lint` impact. |
| [concepts/decision-gate.md](concepts/decision-gate.md) | The decision gate — how `requires_decision` tasks are gated on an `accepted` ADR, status-aware resolution, and `--scaffold-decisions`. |
| [concepts/runbook.md](concepts/runbook.md) | `task runbook` / `phase runbook` — dependency gating and finalize-candidate reporting. |
| [concepts/finalization-reconciliation.md](concepts/finalization-reconciliation.md) | `task finalize` / `phase reconcile` — syncing design status with the progress log. |
| [concepts/design-doc-lifecycle.md](concepts/design-doc-lifecycle.md) | Archiving / retiring completed design docs — how a phase YAML or decision file becomes safe to delete, and why a bare `rm` first fails closed. |
| [concepts/governance.md](concepts/governance.md) | The governance layer — write lock, reserved IDs, protected paths. |
| [concepts/sample-phase.md](concepts/sample-phase.md) | The `TUTORIAL` sample phase — keep / rename / delete decision. |

## Project

| Doc | What it covers |
| --- | --- |
| [troubleshooting.md](troubleshooting.md) | Diagnostic code → recovery action for the most common error codes. |
| [dogfood.md](dogfood.md) | Maintainer quick guide — running code-pact on code-pact itself (setup, per-task flow, checkpoints). |
| [maintainers/operations.md](maintainers/operations.md) | Deeper maintainer topics — planning wizards, model-aware adapters, adapter-upgrade internals, Spec Kit import, release-prep posture. |
| [maintainers/docs-maintenance.md](maintainers/docs-maintenance.md) | How these docs are organized and **which doc to update for which change** (the ownership map). |
| [community.md](community.md) | Where to file issues / discussions / PRs and the scope-discipline rule for the Non-goals list. |
