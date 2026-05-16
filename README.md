# code-pact

Design control plane for AI coding agents. Keep design as a structured source of truth, pack only the right context to agents, and verify completion criteria deterministically.

`code-pact` is not a competitor of Spec Kit. It is meant to sit alongside spec-driven workflows as an agent execution control layer.

## Status

Pre-alpha. All MVP commands below are wired; the CLI contract is stabilizing.

## MVP scope (v0.1)

- `code-pact init` — scaffold project control structure
- `code-pact phase add | ls | show` — manage phase contracts
- `code-pact progress` — weighted progress against an explicit baseline snapshot
- `code-pact pack` — emit a context pack (Markdown) for a specific agent + task
- `code-pact verify` — deterministic completion check (event-based, no mtime)

Supplementary commands: `adapter`, `recommend`, `doctor`.

Supported agents: `claude-code`, `codex`.

All commands support `--json`. The flag is accepted both before and after the command name. JSON responses follow `{ ok, data, error? }`. Exit codes: `0` success, `1` verification failed, `2` usage/config error, `3` internal error.

## Quickstart

```sh
# 1. Scaffold a project.
code-pact init --locale en-US --agent claude-code

# 2. Declare a phase. --objective is required.
code-pact phase add \
  --id P1 \
  --name Foundation \
  --weight 12 \
  --objective "Establish project foundation" \
  --verify-command "pnpm test"

# 3. Inspect phases.
code-pact phase ls
code-pact phase show P1 --json

# 4. Pack context for an agent + task (writes to .context/<agent>/<task>.md).
code-pact pack --phase P1 --task P1-T1 --agent claude-code

# 5. After completing the task, run verification.
code-pact verify --phase P1 --task P1-T1
```

Multi-word verification commands must be quoted:

```sh
# Correct
code-pact phase add ... --verify-command "node --version"

# Rejected with CONFIG_ERROR — the trailing token would be silently lost.
code-pact phase add ... --verify-command node --version
```

## Non-goals (MVP)

- No LLM API calls
- No web UI, daemon, or vector database
- No GitHub / Linear / Jira integrations
- No multi-agent orchestration
- No HTML reports (planned later via a separate `report` command)

## Requirements

- Node.js >= 24 (LTS)
- pnpm

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
node dist/cli.js --version
```
