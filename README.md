# code-pact

A control plane for AI coding agents. `code-pact` keeps `design/` as the structured source of truth, gives agents a stable command surface for fetching task-specific context, and verifies completion criteria deterministically.

The product idea: agents should not read sprawling `design/` trees themselves and edit progress files by hand. They should call a small set of deterministic CLI commands. `code-pact` provides those commands and the per-agent adapter files that wire them up.

## Status

Alpha. Published on npm as [`code-pact@alpha`](https://www.npmjs.com/package/code-pact) (current: `0.5.0-alpha.0`). API and command surface may still shift while the Cursor and Gemini CLI adapters are experimental. Stable releases (`latest` tag) will follow once those adapters graduate and `task start` / `npm create code-pact` land.

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

# 2. (Optional) Build the planning artifacts that feed AI-assisted roadmapping.
#    Run these once at the start of the project:
code-pact plan brief        # collect what/who/why → design/brief.md
code-pact plan constitution  # collect principles   → design/constitution.md
code-pact plan prompt        # generate a planning prompt for an AI agent

# 3. Add a phase interactively (or pass flags to skip the prompts).
#    Tip: if an AI agent answered `plan prompt`, pipe its YAML to
#    `phase import <path>` to bulk-import all phases and tasks at once.
code-pact phase add
code-pact phase import draft-roadmap.yaml   # bulk import from AI-generated YAML

# 4. Add tasks to the phase interactively.
code-pact task add <phase-id>

# 5. Generate per-agent instruction files (CLAUDE.md / AGENTS.md /
#    docs/code-pact/agent-instructions.md). The wizard can do this for
#    you; the standalone command is here when you change agents later:
code-pact adapter --agent claude-code

# 6. (Optional) Pin a Claude model version for effort/thinking guidance in CLAUDE.md:
code-pact adapter --agent claude-code --model opus-4.7

# 7. From the agent: fetch the context pack for a task.
#    Content adapts automatically to task attributes (context_size, ambiguity, write_surface).
code-pact task context <task-id> --agent <agent>

# 8. After implementation, mark the task complete. This runs verify
#    and, on pass, appends a `done` event to progress.yaml.
code-pact task complete <task-id> --agent <agent>
```

Subsequent commands assume `code-pact` is on `PATH` (`npm install -g code-pact@alpha`). If you prefer not to install globally, prefix each invocation with `npx code-pact@alpha`.

The `init` wizard asks, in order: language (English / 日本語), which agents to support (multi-select from Claude Code / Codex / Generic), the default agent, whether to generate adapter files now, the default verification command, whether to create a sample first phase, and whether to collect a project brief (writes `design/brief.md`). After completing, it prints **Next Steps** reminders to stderr. Once initialized, the selected locale is saved in `.code-pact/project.yaml` so subsequent commands automatically use that language without `--locale`.

Use `code-pact doctor` to check project health at any time (invalid YAML, orphan phase files, duplicate task ids, missing adapter files, …). The CI-friendly `code-pact validate` variant exits 1 on errors; add `--strict` to promote warnings to errors as well.

At phase or PR boundaries, run the v0.7 **planning integrity** checkpoints:

```sh
code-pact plan lint --json          # schema + naming + missing/orphan references
code-pact plan normalize --check    # whitespace/newline drift (--write to apply)
code-pact plan analyze --json       # design status vs progress-log drift
```

`plan lint` and `plan analyze` accept `--strict` to fail on warnings. `plan normalize --write` preserves YAML comments and Markdown hard line breaks. Pre-v0.7 done tasks (no progress events) are hidden from `plan analyze` by default; pass `--include-historical` to surface them without affecting the exit code.

## Agent-facing usage

Agent adapters (CLAUDE.md, AGENTS.md, docs/code-pact/agent-instructions.md) drive a small, deterministic per-task loop:

```sh
# (Optional) Ask code-pact which Claude model tier and effort suit the task.
code-pact recommend --phase <phase-id> --task <task-id>

# Fetch the markdown context pack (writes to stdout, no side effects).
code-pact task context <task-id> --agent <agent>

# Mark the task started so handoff and status views know who's on it.
code-pact task start <task-id> --agent <agent>

# If the task gets blocked, record why explicitly. The CLI requires a reason.
code-pact task block <task-id> --reason "Waiting for review on PR #42"

# When the blocker clears:
code-pact task resume <task-id> --agent <agent>

# Inspect the derived state and full event history at any time (pure read).
code-pact task status <task-id> --json

# After implementation, mark the task complete. This runs verify and,
# on pass, appends a `done` event to progress.yaml.
code-pact task complete <task-id> --agent <agent>
```

`task context` resolves the task id across every phase, so the agent only needs the task id. `task complete` and `task start` are idempotent — calling them again on a task already in that state is a no-op (`already_done: true` / `already_started: true`). A `blocked` task cannot complete directly: `task complete` returns `INVALID_TASK_TRANSITION` until the task is `resume`d, so the resume event records the unblock decision. The low-level `code-pact verify --phase <p> --task <t>` is still available if you want to inspect verify output without recording a progress event.

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

The `generic` adapter writes one human-readable instructions file that you can copy or symlink into any other agent's expected location (`GEMINI.md`, …) while the dedicated adapters land.

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

# Bulk-import phases from AI-generated YAML (lenient: only task `id` is required;
# missing fields are filled with defaults and reported in the result).
# Add --strict to require all task fields explicitly.
code-pact phase import draft-roadmap.yaml
code-pact phase import draft-roadmap.yaml --strict

# Inspect phases.
code-pact phase ls
code-pact phase show P1 --json

# Pack context to a file under .context/<agent>/<task>.md.
# NOTE: pack is an internal command used by `task context` — prefer
# `code-pact task context <task-id>` in agent and CI workflows.
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

`code-pact` is complementary to spec-style tools that produce structured spec / plan / task documents for agents to read. The difference in emphasis: spec tools optimize the _documents_ an agent reads; `code-pact` optimizes the _command path_ an agent uses to retrieve context and confirm completion. Use both if it fits your workflow.
