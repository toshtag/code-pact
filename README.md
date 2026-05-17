# code-pact

A control plane for AI coding agents. `code-pact` keeps `design/` as the structured source of truth, gives agents a stable command surface for fetching task-specific context, and verifies completion criteria deterministically.

The product idea: agents should not read sprawling `design/` trees themselves and edit progress files by hand. They should call a small set of deterministic CLI commands. `code-pact` provides those commands and the per-agent adapter files that wire them up.

## Status

Alpha. Published on npm as [`code-pact@alpha`](https://www.npmjs.com/package/code-pact). API and command surface may still shift before `v0.1.0`. Stable releases (`latest` tag) will follow after the experimental Cursor / Gemini CLI adapters graduate.

## Install

```sh
# One-off invocation (no install)
npx code-pact@alpha --version

# Global install
npm install -g code-pact@alpha
code-pact --version
```

Contributors can also run from a clone with `pnpm link --global`, or install a local tarball produced by `npm pack` — see [Development](#development).

## Quickstart

```sh
# 1. Initialize an existing project. Run with no flags in your terminal
#    to launch the interactive wizard.
npx code-pact@alpha init

# 2. Add a phase interactively (or use `phase add` with flags — see below).
code-pact phase new

# 3. Generate per-agent instruction files (CLAUDE.md / AGENTS.md /
#    docs/code-pact/agent-instructions.md). The wizard can do this for
#    you; the standalone command is here when you change agents later:
code-pact adapter --agent claude-code

# 4. From the agent: fetch the context pack for a task.
code-pact task context <task-id> --agent <agent>

# 5. After implementation, mark the task complete. This runs verify
#    and, on pass, appends a `done` event to progress.yaml.
code-pact task complete <task-id> --agent <agent>
```

Subsequent commands assume `code-pact` is on `PATH` (`npm install -g code-pact@alpha`). If you prefer not to install globally, prefix each invocation with `npx code-pact@alpha`.

The `init` wizard asks, in order: language (English / 日本語), which agents to support (multi-select from Claude Code / Codex / Generic), the default agent, whether to generate adapter files now, the default verification command, and whether to create a sample first phase.

## Agent-facing usage

Agent adapters (CLAUDE.md, AGENTS.md, docs/code-pact/agent-instructions.md) instruct the agent to do exactly two things per task:

```sh
# Fetch the markdown context pack (writes to stdout, no side effects).
code-pact task context <task-id> --agent <agent>

# After implementation, mark the task complete. This runs verify and,
# on pass, appends a `done` event to progress.yaml.
code-pact task complete <task-id> --agent <agent>
```

`task context` resolves the task id across every phase, so the agent only needs the task id. `task complete` is idempotent — calling it again on an already-done task is a no-op (`already_done: true`). The low-level `code-pact verify --phase <p> --task <t>` is still available if you want to inspect verify output without recording a progress event.

## Supported agents

| Agent | Status | Adapter output |
|---|---|---|
| `claude-code` | stable | `CLAUDE.md`, `.claude/skills/`, `.claude/hooks/`, `.context/claude-code/` |
| `codex` | stable | `AGENTS.md`, `.context/codex/` |
| `generic` | stable | `docs/code-pact/agent-instructions.md`, `.context/generic/` |
| `cursor`, `gemini-cli` | planned (v0.2 experimental) | — |

The `generic` adapter writes one human-readable instructions file that you can copy or symlink into any other agent's expected location (`.cursorrules`, `GEMINI.md`, …) while the dedicated adapters land.

## Low-level mode (automation, CI, agents)

Every interactive flow has a flag-based equivalent. CI and agent contexts use these directly. They are the primitives the wizards are built on.

```sh
# Init without prompts (any --agent / --locale / --force flag, or CI=true,
# or --non-interactive, opts out of the wizard).
code-pact init --non-interactive --agent claude-code,generic --locale en-US

# Add a phase by flags.
code-pact phase add \
  --id P1 \
  --name Foundation \
  --weight 12 \
  --objective "Establish project foundation" \
  --verify-command "pnpm test"

# Inspect phases.
code-pact phase ls
code-pact phase show P1 --json

# Pack context to a file under .context/<agent>/<task>.md.
code-pact pack --phase P1 --task P1-T1 --agent claude-code

# Verify.
code-pact verify --phase P1 --task P1-T1
```

Multi-word verification commands must be quoted, otherwise the trailing tokens raise `CONFIG_ERROR`:

```sh
# Correct
code-pact phase add ... --verify-command "node --version"

# Rejected — the trailing token would be silently lost.
code-pact phase add ... --verify-command node --version
```

## CLI contract

`docs/cli-contract.md` is the canonical reference. Highlights:

- `--json` is accepted before or after the command name and produces JSON-only stdout (`{ ok, data, error? }`). Human-readable logs go to stderr.
- Exit codes: `0` success, `1` verification failed, `2` usage / config error, `3` internal error.
- `isInteractive()` (`process.stdin.isTTY && process.stdout.isTTY && !CI`) is the single source of truth for whether a wizard launches.
- `--non-interactive` is an explicit opt-out for users invoking the CLI from a TTY but wanting flag-only semantics.

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

## Relationship to spec-driven workflows

`code-pact` is complementary to spec-style tools that produce structured spec / plan / task documents for agents to read. The difference in emphasis: spec tools optimize the *documents* an agent reads; `code-pact` optimizes the *command path* an agent uses to retrieve context and confirm completion. Use both if it fits your workflow.
