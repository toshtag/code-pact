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

- **Runtime truth lives in `.code-pact/state` (v2.0).** The control plane that
  active tasks resolve against is `.code-pact/state` plus generated, deterministic
  control snapshots. `design/` is the human authoring surface and *historical
  working docs*: the roadmap and **active** phase YAML stay required, but
  **completed** `design/phases/*.yaml` and **retired** `design/decisions/*.md` are
  **ephemeral** — removable / `.gitignore`-able once their active-task-needed state
  is snapshotted into `.code-pact/state` (otherwise the read paths fail closed).
  Missing *archived/historical* docs are tolerated and resolved from the snapshot;
  missing *active* control docs that are not yet snapshotted fail closed. This
  **supersedes** the pre-v2.0 rule that "`design/` is the source of truth. Always."
  Transition is governed by
  [`design/decisions/design-docs-ephemeral-directive.md`](decisions/design-docs-ephemeral-directive.md)
  (transitional — retire after v2.0 lands).

- **Small surfaces, clear contracts.** Each command does one thing.
  Options that modify behavior must be explicit flags — no ambient magic.

- **Enforce mechanics, surface judgment.** The CLI's enforcing power (anything
  that `fail`s / blocks / changes exit code) is spent on exactly two things:
  (1) supplying the right information, and (2) replacing steps that need no human
  judgment with deterministic logic. Anything that genuinely needs human judgment
  — a design decision, a confidence level, an intentionally low-confidence phase —
  is surfaced deterministically as **advisory** (`affects_exit: false`), never
  hard-blocked. code-pact's value is absorbing an agent's instability with a thin
  deterministic control plane, not making the agent smarter; hard-blocking a
  judgment call contradicts that and would constrain legitimate authoring. New
  features decide "enforce vs. surface" by this test: if it is (1) or (2), enforce;
  otherwise surface. No speculative strict flags (e.g. a `--clarify-strict`).
