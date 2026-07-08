# code-pact

[![npm version](https://img.shields.io/npm/v/code-pact)](https://www.npmjs.com/package/code-pact)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js version](https://img.shields.io/node/v/code-pact)](package.json)

**A vendor-neutral control plane for AI coding agents.**

Claude Code writes `CLAUDE.md`. Codex writes `AGENTS.md`. Cursor writes `.cursor/rules/`. Each AI coding agent has its own conventions for instruction files, skills, and progress tracking. Switching between them — or running more than one against the same project — means hand-editing parallel state.

`code-pact` gives any supported agent the same deterministic CLI for fetching task context, recording progress, and verifying completion criteria. The agent calls a small set of commands; `code-pact` keeps **active** plans in `design/` (roadmap, active phase YAML, decisions, rules) and records operational progress under `.code-pact/state/events/`. **Completed** phases and **retired** decisions are ephemeral: a completed phase's runtime truth lives in a `.code-pact/state` archive snapshot, a retired decision's in a `.code-pact/state` decision record, so each historical design doc can be hand-deleted once its snapshot (for a phase) or record (for a decision) exists. Adapters generate the per-agent instruction files so each agent sees its own world without the project state diverging.

code-pact ships **stable** adapters for `claude-code`, `codex`, and `generic`. The `cursor` and `gemini-cli` adapters are **experimental** — they ship, they work, but their generated file formats may shift in minor releases to track upstream tooling changes.

```sh
# 30-second tour — runs the whole loop in a throwaway sandbox, writes nothing to your repo:
npx code-pact tutorial
```

Want to drive the loop yourself in a real project? Scaffold the sample `TUTORIAL` phase, then walk it command by command:

```sh
npx code-pact init --non-interactive --agent claude-code --locale en-US --sample-phase
code-pact adapter install claude-code --json
code-pact task prepare TUTORIAL-T1 --agent claude-code --json  # single per-task entry: state + recommendation + the exact commands to run
code-pact task start TUTORIAL-T1
# ... agent implements ...
code-pact verify --phase TUTORIAL --task TUTORIAL-T1           # run the phase's verification commands
code-pact task complete TUTORIAL-T1                            # re-runs verify, appends a done event
code-pact task finalize TUTORIAL-T1 --json                    # preview the design-status flip (dry-run is the default)
code-pact task finalize TUTORIAL-T1 --write --json            # apply it
code-pact validate                                            # CI-friendly health check
```

> [!IMPORTANT]
> Verification commands are trusted project shell configuration. Review imported or agent-generated plans before running `verify` or `task complete`. Each command is bounded to five minutes by default; use `--timeout <milliseconds>` with a decimal integer when a reviewed command legitimately needs a different limit. If `SIGINT`/`SIGTERM` is observed before the documented event-write commit point, Code Pact cancels the active verification process tree and does not record task completion. Programmatic signal delivery is platform-dependent; Windows CI verifies timeout/AbortSignal cancellation and `taskkill` cleanup rather than synthetic `SIGINT` delivery.

`task prepare` is the recommended per-task entry point: one call returns the current state, the execution recommendation, the context pack metadata, and a `commands` dictionary with the exact next commands. `recommend` and `task context` remain available as standalone diagnostics. (A plain `init` without `--sample-phase` starts with an empty roadmap — you add your own phases; see [getting-started](docs/getting-started.md).)

## Status

Within a major version the public CLI surface — flags, exit codes, JSON envelope shapes, and error codes — is stable; changing any of them is what bumps the major. The full stability taxonomy (`Stable (v1.0)` / `Stable (human-output)` / `Experimental` / `Deprecated`) lives in [`docs/cli-contract.md`](docs/cli-contract.md#stability-taxonomy-v10).

Release notes live in [`CHANGELOG.md`](CHANGELOG.md). Upgrade guidance lives in [`docs/upgrading.md`](docs/upgrading.md) (within a major an upgrade is just a version bump; each major bump's migration is noted there; the earlier alpha notes are archived in [`docs/migration.md`](docs/migration.md)).

## Install

```sh
# One-off invocation (no install)
npx code-pact --version

# Global install
npm install -g code-pact
code-pact --version
```

Past alpha releases remain available under the `alpha` dist-tag (`npm install code-pact@alpha`) for users who pinned to the earlier alpha behaviour. New projects should use the default (`latest`) tag.

Contributors can also run from a clone with `pnpm link --global`, or install a local tarball produced by `npm pack` — see [Development](#development).

## Getting started

[`docs/getting-started.md`](docs/getting-started.md) is the canonical first-thirty-minutes guide. It walks several onboarding approaches side by side:

- **Smoke test** — `code-pact tutorial` runs the whole loop end to end in a throwaway sandbox (nothing is written to your repo); or scaffold a real sample phase with `init --sample-phase`.
- **Agent-first** — `plan prompt --schema-only` gives your agent the output shape; it emits a roadmap YAML you ingest with `phase import`.
- **Existing-plan adoption** — already have a `roadmap.md` / `TODO.md` / draft YAML? `plan adopt` converts it into phases and tasks deterministically, no AI round-trip.
- **Code-pact-first** — capture a brief + constitution, then `plan prompt` and have your agent draft the full roadmap from them.
- **Manual** — write the roadmap by hand with a mix of interactive wizards and flag-based commands.

They all converge on the same per-task agent loop, entered through `task prepare` (`task prepare` → `task start` → implement → `verify` → `task complete` → `task finalize`). `task prepare` also returns a `lifecycleMode` (`full_loop` / `record_only` / `decision_loop`) recommending how heavy that loop should be — e.g. `record_only` lets a small, strongly-verified task record completion via `task record-done` instead of the full loop. See [`docs/per-task-loop.md`](docs/per-task-loop.md) for the lifecycle diagram and a worked example. `recommend` and `task context` remain available as standalone diagnostics — `task prepare` surfaces both for you in one call.

New to the terms used here (context pack, envelope, derived state, …)? The [`docs/glossary.md`](docs/glossary.md) defines them in plain language.

**Starting fresh, or adopting on an existing repo?** Two workflow guides cover each case — [greenfield](docs/workflows/greenfield.md) and [brownfield](docs/workflows/brownfield-feature.md). The full documentation index lives at [`docs/`](docs/README.md). Japanese readers: a [日本語の入口](docs/ja/README.md) links into the English docs (the primary source).

## Reference docs

| Doc | What it covers |
| --- | --- |
| [`docs/per-task-loop.md`](docs/per-task-loop.md) | The canonical per-task lifecycle — state diagram, the verbs, and a worked example. |
| [`docs/glossary.md`](docs/glossary.md) | Plain-language definitions for every `code-pact` term used in the docs. |
| [`docs/positioning.md`](docs/positioning.md) | What `code-pact` is, what it deliberately is not, the core CLI surfaces, and the success metrics the project measures itself against. |
| [`docs/agent-contract.md`](docs/agent-contract.md) | The agent contract: what `code-pact` guarantees, what `adapter conformance` requires of each agent integration, and the recommended per-task lifecycle. |
| [`docs/getting-started.md`](docs/getting-started.md) | First-thirty-minutes guide (onboarding approaches + the per-task loop). |
| [`docs/cli-contract.md`](docs/cli-contract.md) | Full flag / exit code / JSON envelope / error code reference and the Stability taxonomy. |
| [`docs/upgrading.md`](docs/upgrading.md) | How to upgrade — additive within a major, with a migration note per major bump; pointers for coming from an earlier alpha. |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Diagnostic code → recovery action for the most common error codes. |
| [`docs/community.md`](docs/community.md) | Where to file issues / discussions / PRs, the GitHub Discussions intent, and the scope-discipline rule for the Non-goals list. |

Maintainers: see [`docs/dogfood.md`](docs/dogfood.md) (quick guide) and [`docs/maintainers/operations.md`](docs/maintainers/operations.md) (deeper operations) for running `code-pact` on `code-pact` itself.

## Supported agents

| Agent         | Status           | Adapter output                                                            |
| ------------- | ---------------- | ------------------------------------------------------------------------- |
| `claude-code` | stable           | `CLAUDE.md`, `.claude/skills/`, `.claude/hooks/`, `.context/claude-code/` |
| `codex`       | stable           | `AGENTS.md`, `.context/codex/`                                            |
| `generic`     | stable           | `docs/code-pact/agent-instructions.md`, `.context/generic/`               |
| `cursor`      | **experimental** | `.cursor/rules/code-pact.mdc` (`alwaysApply: true`), `.context/cursor/`   |
| `gemini-cli`  | **experimental** | `GEMINI.md`, `.context/gemini-cli/`                                       |

The `cursor` adapter writes a [Cursor Project Rule](https://cursor.com/docs/context/rules) — `.cursor/rules/code-pact.mdc` with `alwaysApply: true` so the agent always sees code-pact's workflow. `.cursorrules` (the legacy single-file format, deprecated in Cursor 0.43) is **not** written. The adapter is marked experimental because the .mdc format and placement may shift across Cursor releases.

The `gemini-cli` adapter writes [`GEMINI.md`](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md) at the project root. Gemini CLI auto-discovers `GEMINI.md` files hierarchically (CWD → parent dirs up to `.git`, plus `~/.gemini/GEMINI.md`). Install Gemini CLI only from the official `google-gemini` org — typosquat packages have been reported on npm.

The `generic` adapter writes one human-readable instructions file that you can copy or symlink into any other agent's expected location while the dedicated adapters land.

## Non-goals (MVP)

These are deliberate, permanent boundaries — not a backlog. `code-pact` will not add them; each is ruled out to keep the "agent calls one stable CLI" promise (see [`docs/positioning.md`](docs/positioning.md#what-code-pact-is-not)).

- **No LLM API calls** — your agent does the inference; `code-pact` never calls a model.
- **No web UI, daemon, or vector database** — it runs as a CLI and exits.
- **No GitHub / Linear / Jira integration** — you wire those into your own agent or CI.
- **No multi-agent orchestration** — one task, one agent per invocation.
- **No RAG / semantic search** — context selection is deterministic, not embedding-based.

## Requirements

- Node.js >= 22 (LTS or current)
- pnpm (for contributors building from source)

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
node dist/cli.js --version
```

For dogfooding `code-pact` against `code-pact` itself, see [`docs/dogfood.md`](docs/dogfood.md).
