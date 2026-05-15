# code-pact

Design control plane for AI coding agents. Keep design as a structured source of truth, pack only the right context to agents, and verify completion criteria deterministically.

`code-pact` is not a competitor of Spec Kit. It is meant to sit alongside spec-driven workflows as an agent execution control layer.

## Status

Pre-alpha. The CLI surface below is the MVP target; only `--version` and `--help` are wired today.

## MVP scope (v0.1)

- `code-pact init` — scaffold project control structure
- `code-pact phase add | ls | show` — manage phase contracts
- `code-pact progress` — weighted progress against an explicit baseline snapshot
- `code-pact pack` — emit a context pack (Markdown) for a specific agent + task
- `code-pact verify` — deterministic completion check (event-based, no mtime)

All commands support `--json`. JSON responses follow `{ ok, data, error? }`. Exit codes: `0` success, `1` verification failed, `2` usage/config error, `3` internal error.

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
