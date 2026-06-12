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

- **Runtime truth for completed / retired material lives in `.code-pact/state`
  (v2.0 model — implemented).** **Archived / completed phase references and
  retired / settled decision outcomes** resolve from `.code-pact/state` plus
  generated, deterministic control snapshots/records. The **active roadmap and
  not-yet-archived phase / task definitions remain `design/` inputs** — relocating
  *those* into `.code-pact/state` is a separate future step, explicitly out of
  v2.0 scope. `design/` is the human authoring surface for *active* control-plane
  docs; **completed** `design/phases/*.yaml` and **retired** `design/decisions/*.md`
  are **ephemeral** (removable / `.gitignore`-able), with these locked rules:
  - **Completed/retired truth is snapshot/record-backed.** A completed phase's
    terminal state survives in a validated archive snapshot
    (`.code-pact/state/archive/phases/<id>.json`); a retired decision's outcome
    survives in a decision-state record
    (`.code-pact/state/archive/decisions/<stem>-<hash8>.json`). `PRUNED.md` is a
    legacy/prune ledger — a read-only backward-compat input, **not** the durable
    v2.0 retire truth; the decision-state record is.
  - **Hand-delete is allowed only after the snapshot/record exists.** A completed
    `design/phases/*.yaml` or any `design/decisions/*.md` — up to and including the
    whole `design/decisions/` directory — may be deleted by hand (or via the
    `phase archive --write` / `decision retire --write` verbs) **once** its
    snapshot/record is written.
  - **Readers/checkers resolve archived/retired state from `.code-pact/state`,
    live-wins, fail-closed.** When the live doc is present it always wins; the
    record/snapshot is consulted **only on a true (symlink-safe) absence**. A
    record-backed retired decision releases a live gate **only** when it is an
    accepted record that may satisfy that gate. **Missing *active* control docs
    (an active phase YAML, a live decision gate with no satisfying record) still
    fail closed** — never silently swallowed. The doc-link checker resolves a link
    to a hand-deleted, record-backed decision as *retired*, not broken.
  This model **supersedes** the pre-v2.0 rule that "`design/` is the source of
  truth. Always."

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
