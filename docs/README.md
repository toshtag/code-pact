# code-pact documentation

> 🌐 日本語のドキュメント一覧は [docs/ja/](ja/README.md) にあります。

The fastest way in is [`getting-started.md`](getting-started.md) — empty project to your first `task complete` in about thirty minutes. If you already know the shape of the work, jump straight to the workflow guide that matches your situation: starting from scratch, or adopting code-pact on an existing repo.

## Start here

| Doc | What it covers |
| --- | --- |
| [getting-started.md](getting-started.md) | First-thirty-minutes guide — three onboarding paths (tutorial / manual / AI-assisted) and the per-task loop. |
| [positioning.md](positioning.md) | What code-pact is, what it deliberately is not, the core CLI surfaces, and the success metrics it measures itself against. |

## Workflows

Pick the guide that matches where you're starting from. Both defer to `getting-started.md` for the exact command sequences and focus on **what to write** and **how to scope the work**.

| Guide | When to use |
| --- | --- |
| [workflows/greenfield.md](workflows/greenfield.md) | **Starting from an empty repo.** What to put in the brief and constitution, how to shape the first phases, the smallest useful first PR. |
| [workflows/brownfield-feature.md](workflows/brownfield-feature.md) | **Adopting code-pact on an existing codebase.** Scoping to one feature, coexisting with an existing `CLAUDE.md` / `AGENTS.md`, choosing a verify command. |

## Reference

| Doc | What it covers |
| --- | --- |
| [cli-contract.md](cli-contract.md) | Full flag / exit code / JSON envelope / error code reference and the stability taxonomy. |
| [agent-contract.md](agent-contract.md) | The v1.11+ agent contract and what `adapter conformance` requires of each agent integration. |
| [spec-kit-bridge.md](spec-kit-bridge.md) | Importing an existing Spec Kit `tasks.md` / `spec.md` into a code-pact roadmap. |
| [migration.md](migration.md) | Upgrade guidance from any prior alpha (v0.6 – v0.9) to v1.0. |

## Concepts

| Doc | What it covers |
| --- | --- |
| [concepts/task-readiness-fields.md](concepts/task-readiness-fields.md) | Optional task schema fields (`depends_on` / `reads` / `writes` / …) and their `plan lint` impact. |
| [concepts/runbook.md](concepts/runbook.md) | `task runbook` / `phase runbook` — dependency gating and finalize-candidate reporting. |
| [concepts/finalization-reconciliation.md](concepts/finalization-reconciliation.md) | `task finalize` / `phase reconcile` — syncing design status with the progress log. |
| [concepts/governance.md](concepts/governance.md) | The governance layer — write lock, reserved IDs, protected paths. |
| [concepts/sample-phase.md](concepts/sample-phase.md) | The `TUTORIAL` sample phase — keep / rename / delete decision. |
| [concepts/evidence-harness.md](concepts/evidence-harness.md) | Maintainer tooling (not a product feature) — the deterministic metrics harness behind design decisions. |

## Project

| Doc | What it covers |
| --- | --- |
| [dogfood.md](dogfood.md) | Real-project walkthrough and troubleshooting for the most common error codes. |
| [community.md](community.md) | Where to file issues / discussions / PRs and the scope-discipline rule for the Non-goals list. |
