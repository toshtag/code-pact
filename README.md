# code-pact

[![npm version](https://img.shields.io/npm/v/code-pact)](https://www.npmjs.com/package/code-pact)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js version](https://img.shields.io/node/v/code-pact)](package.json)

**A vendor-neutral control plane for AI coding agents.**

Claude Code writes `CLAUDE.md`. Codex writes `AGENTS.md`. Cursor writes `.cursor/rules/`. Each AI coding agent has its own conventions for instruction files, skills, and progress tracking. Switching between them — or running more than one against the same project — means hand-editing parallel state.

`code-pact` gives any supported agent the same deterministic CLI for fetching task context, recording progress, and verifying completion criteria. The agent calls a small set of commands; `code-pact` keeps `design/` as the structured source of truth and `.code-pact/state/progress.yaml` as the operational log. Adapters generate the per-agent instruction files so each agent sees its own world without the project state diverging.

v1.0 ships **stable** adapters for `claude-code`, `codex`, and `generic`. The `cursor` and `gemini-cli` adapters are **experimental** — they ship, they work, but their generated file formats may shift in minor releases to track upstream tooling changes.

```sh
# 30-second tour
npx code-pact init --non-interactive --agent claude-code --locale en-US
code-pact adapter install claude-code --json
code-pact recommend --phase P1 --task P1-T1 --json    # deterministic execution plan
code-pact task context P1-T1 --agent claude-code      # markdown context pack for the agent
code-pact task start P1-T1
# ... agent implements ...
code-pact task complete P1-T1                          # runs verify, appends a done event
code-pact validate                                     # CI-friendly health check
```

## Status

v1.0 freezes the public CLI surface — flags, exit codes, JSON envelope shapes, and error codes are stable across the v1.x line. The full stability taxonomy (`Stable (v1.0)` / `Stable (human-output)` / `Experimental` / `Deprecated`) lives in [`docs/cli-contract.md`](docs/cli-contract.md#stability-taxonomy-v10).

Release notes live in [`CHANGELOG.md`](CHANGELOG.md). Migration guidance for projects upgrading from v0.6 / v0.7 / v0.8 / v0.9 lives in [`docs/migration.md`](docs/migration.md).

## Install

```sh
# One-off invocation (no install)
npx code-pact --version

# Global install
npm install -g code-pact
code-pact --version
```

Past alpha releases remain available under the `alpha` dist-tag (`npm install code-pact@alpha`) for users who pinned to pre-v1.0 behaviour. New projects should use the default (`latest`) tag.

Contributors can also run from a clone with `pnpm link --global`, or install a local tarball produced by `npm pack` — see [Development](#development).

## Getting started

[`docs/getting-started.md`](docs/getting-started.md) is the canonical first-thirty-minutes guide. It walks three onboarding paths side by side:

- **Tutorial path** — fastest way to confirm the loop works end to end against the wizard's sample phase.
- **Manual path** — write the roadmap by hand with a mix of interactive wizards and flag-based commands.
- **AI-assisted path** — generate a planning prompt with `plan prompt`, have your agent draft the YAML, then bulk-import with `phase import`.

All three converge on the same per-task agent loop (`recommend` → `task context` → `task start` → implement → `task complete`).

## Reference docs

| Doc | What it covers |
| --- | --- |
| [`docs/positioning.md`](docs/positioning.md) | What `code-pact` is, what it deliberately is not, the core CLI surfaces, and the success metrics the project measures itself against. |
| [`docs/agent-contract.md`](docs/agent-contract.md) | The v1.11+ agent contract: what `code-pact` guarantees, what `adapter conformance` requires of each agent integration, and the recommended per-task lifecycle. |
| [`docs/getting-started.md`](docs/getting-started.md) | First-thirty-minutes guide (three onboarding paths + the per-task loop). |
| [`docs/cli-contract.md`](docs/cli-contract.md) | Full flag / exit code / JSON envelope / error code reference and the Stability taxonomy. |
| [`docs/migration.md`](docs/migration.md) | Upgrade guidance from any prior alpha (v0.6 – v0.9) to v1.0. |
| [`docs/dogfood.md`](docs/dogfood.md) | Real-project walkthrough and troubleshooting for the most common error codes. |
| [`docs/community.md`](docs/community.md) | Where to file issues / discussions / PRs, the GitHub Discussions intent, and the scope-discipline rule for the Non-goals list. |

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

- No LLM API calls
- No web UI, daemon, or vector database
- No GitHub / Linear / Jira integrations
- No multi-agent orchestration
- No RAG / semantic search

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
