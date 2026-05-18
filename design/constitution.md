# code-pact — Constitution

This file captures the principles that guide every planning and implementation
decision in this project.

## Core principles

- **CLI contract first.** The `--json` surface, exit codes, and error codes are the
  real public API. Never change them silently. Document breaking changes in CHANGELOG.

- **Agent-agnostic core, agent-aware adapters.** The schemas in `design/` and
  `.code-pact/` are vendor-neutral. Adapter files (CLAUDE.md, AGENTS.md, etc.)
  are generated per-agent and must never leak into core logic.

- **Zero network calls.** code-pact is a planner and a local oracle.
  It reads files and runs shell commands — it never calls AI APIs.

- **Boring file formats.** YAML for human-editable config, JSON for machine output,
  Markdown for context packs. No proprietary formats or binary state.

- **Fail loudly, recover cleanly.** Validation errors block all writes.
  Partial state must never be silently created. Idempotent operations are preferred.

- **`design/` is the source of truth.** Always. `.code-pact/` is internal state
  that agents read but humans can audit. Nothing critical lives only in `.code-pact/`.

- **Small surfaces, clear contracts.** Each command does one thing.
  Options that modify behavior must be explicit flags — no ambient magic.
