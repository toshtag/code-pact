# Dogfood guide

How to run `code-pact` against the `code-pact` repository itself.

The repo is already initialized (`.code-pact/` is committed), so `init` is not needed. The `design/` directory containing phases and tasks is the source of truth for work in progress.

## One-time setup

Build the CLI and expose it on `PATH`:

```sh
pnpm install
pnpm build
pnpm link --global       # exposes `code-pact` globally from this clone
```

Confirm the binary resolves to your local build:

```sh
which code-pact
code-pact --version
```

Run a health check to confirm the project structure is clean:

```sh
code-pact doctor
code-pact validate       # exits 1 if any errors exist
```

## Per-task flow

```sh
# 0. (Optional) Ask code-pact which model tier and effort fit the task,
#    based on the task's attributes (type / ambiguity / risk / etc.).
code-pact recommend --phase <phase-id> --task <task-id>

# 1. Pick a task from the current phase and fetch its context pack.
#    Output goes to stdout — no files written.
code-pact task context <task-id> --agent claude-code

# 2. Mark the task started so handoff and downstream tools can see who's on it.
code-pact task start <task-id> --agent claude-code

# 3. Implement the task. If you have to wait on a decision or review,
#    capture the reason explicitly so the log records why you stopped:
code-pact task block <task-id> --reason "Waiting for schema decision"

# When the blocker clears:
code-pact task resume <task-id> --agent claude-code

# 4. Inspect state any time — task status is a pure read and does not
#    require an --agent flag, so CI and monitoring can use it freely.
code-pact task status <task-id> --json

# 5. Mark the task complete. This runs verify and, on pass,
#    records a done event in .code-pact/state/progress.yaml.
code-pact task complete <task-id> --agent claude-code
```

`task context` / `task complete` / `task start` / `task block` / `task resume`
all resolve the task id across every phase in `design/roadmap.yaml`, so you
do not need to pass a phase id.

A task that is currently `blocked` cannot be completed directly — `task complete`
returns `INVALID_TASK_TRANSITION`. Resume it first so the `resumed` event
records the decision that unblocked the task.

## Inspecting state

```sh
code-pact phase ls
code-pact phase show <phase-id> --json
code-pact progress --baseline initial
```

## Planning (v0.4+)

```sh
# Write a project brief (what/who/why → design/brief.md):
code-pact plan brief

# Write project principles (→ design/constitution.md):
code-pact plan constitution

# Generate a planning prompt for an AI agent and print to stdout:
code-pact plan prompt

# Copy the prompt directly to clipboard:
code-pact plan prompt --clipboard
```

Feed the AI agent's YAML response to `phase import` to bulk-import all phases and tasks:

```sh
code-pact phase import draft-roadmap.yaml
# AI-generated YAML only needs task `id`; missing fields get sensible defaults.
# Add --strict to require every task field explicitly.
code-pact phase import draft-roadmap.yaml --strict
```

## Adding work

```sh
# Add a phase interactively (wizard):
code-pact phase add

# Add a phase by flags (CI/scripted):
code-pact phase add --id P2 --name "..." --weight 10 --objective "..."

# Add a task interactively:
code-pact task add <phase-id>
```

## Resetting to a clean state in a temp dir

Do **not** run `code-pact init` inside this repository — `.code-pact/` already exists
and the command will refuse without `--force`. To experiment with a fresh project:

```sh
mkdir /tmp/cp-fresh && cd /tmp/cp-fresh
code-pact init
```

## Model-aware adapter (v0.5.0)

Pin a Claude model version so the adapter generates effort and extended-thinking guidance
tailored to that model:

```sh
# Generate CLAUDE.md with Opus 4.7–specific guidance:
code-pact adapter --agent claude-code --model opus-4.7

# Re-run skills only (skill files regenerated, CLAUDE.md left untouched):
code-pact adapter --agent claude-code --regen-skills
```

Supported values: `opus-4.7`, `opus-4.6`, `sonnet-4.6`. The `model_version` field in
`.code-pact/agent-profiles/claude-code.yaml` is used as the default when `--model` is
not passed on the CLI.

After adapter generation, `.claude/skills/` is populated with:
- Fixed skills: `/context`, `/verify`, `/progress`
- Dynamic skills derived from `verification.commands` in all roadmap phases
  (e.g. `pnpm test` → `/test`, `pnpm typecheck` → `/typecheck`)

## Context quality (v0.5.1)

`task context` automatically adjusts what it includes based on task attributes.
No flags are needed — the task YAML drives the behavior:

| Task attribute | Effect |
|---|---|
| `context_size: large` | Includes `design/constitution.md` + all decision files |
| `context_size: small` | Minimal output (no rules, decisions, or constitution) |
| `ambiguity: high` | Includes `design/constitution.md` + recent done events in phase |
| `write_surface: high` | All rule files included, bypassing `applies_to` filter |

## Plan quality (v0.5.3)

`doctor` now reports plan quality issues alongside structural checks:

```sh
code-pact doctor
```

New warning/error codes:
- `BRIEF_MISSING` — `design/brief.md` not created yet
- `CONSTITUTION_PLACEHOLDER` — constitution.md still contains the template edit hint
- `EMPTY_OBJECTIVE` — a phase objective is blank or very short
- `ADAPTER_STALE` — an agent profile has no `model_version` pinned

To suppress specific checks, create `.code-pact/doctor.yaml`:

```yaml
disabled_checks:
  - ADAPTER_STALE
```

## Planning integrity (v0.7) — checkpoint commands

`plan lint`, `plan normalize`, and `plan analyze` are **checkpoint commands**, not per-task gates. Run them at phase boundaries, PR boundaries, or before handoff — not before every `task complete`.

```sh
# Static integrity: schemas, naming, duplicate / missing / orphan refs.
# Default ignores subjective heuristics so CI does not fail on style.
code-pact plan lint --json

# Stricter: warnings also fail.
code-pact plan lint --strict --json

# Opt in to subjective heuristics (WEAK_DOD, PLACEHOLDER_VERIFICATION):
code-pact plan lint --include-quality --json

# Formatting normalization — safe dry-run by default. Reports files
# that would change but writes nothing.
code-pact plan normalize --json          # equivalent to --check
code-pact plan normalize --check --json

# Apply (atomic per-file write; YAML comments and Markdown hard line
# breaks are preserved):
code-pact plan normalize --write --json

# Cross-artifact drift: compares design status against derived
# progress state. Pre-v0.6 done tasks (no progress events) are
# hidden from default output so historical phases do not break
# self-dogfooding.
code-pact plan analyze --json

# Show every drift, including historical:
code-pact plan analyze --include-historical --json

# Promote warnings to exit 1 in CI:
code-pact plan analyze --strict --json
```

A typical phase-boundary checkpoint:

```sh
code-pact plan lint --json && \
code-pact plan normalize --check --json && \
code-pact plan analyze --json
```

If any of the three fails, fix the underlying issue (or run `plan normalize --write`) before declaring a phase done.

## Quick reference

| Goal | Command |
|---|---|
| Write project brief | `code-pact plan brief` |
| Write project constitution | `code-pact plan constitution` |
| Generate AI planning prompt | `code-pact plan prompt [--clipboard]` |
| Bulk-import AI-generated roadmap | `code-pact phase import <yaml> [--strict]` |
| Recommend model tier / effort for a task | `code-pact recommend --phase <phase-id> --task <task-id>` |
| Fetch context for a task (as agent) | `code-pact task context <task-id> --agent <agent>` |
| Mark a task started (as agent) | `code-pact task start <task-id> --agent <agent>` |
| Block a task with a recorded reason | `code-pact task block <task-id> --reason "<text>"` |
| Resume a blocked task | `code-pact task resume <task-id> --agent <agent>` |
| Inspect a task's current state + history | `code-pact task status <task-id> --json` |
| Mark a task done (as agent) | `code-pact task complete <task-id> --agent <agent>` |
| Add a phase interactively | `code-pact phase add` |
| Add a task interactively | `code-pact task add <phase-id>` |
| Generate / refresh adapter files | `code-pact adapter --agent <agent> [--model <ver>] [--force]` |
| Regenerate skills only | `code-pact adapter --agent <agent> --regen-skills` |
| Show weighted progress | `code-pact progress` |
| Health-check the project | `code-pact doctor` |
| CI validation | `code-pact validate` |
| Static integrity of plan files | `code-pact plan lint [--strict] [--include-quality]` |
| Whitespace / newline normalization (dry-run) | `code-pact plan normalize --check` |
| Whitespace / newline normalization (apply) | `code-pact plan normalize --write` |
| Cross-artifact drift (design vs progress) | `code-pact plan analyze [--strict] [--include-historical]` |
