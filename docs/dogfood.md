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
# 1. Pick a task from the current phase and fetch its context pack.
#    Output goes to stdout — no files written.
code-pact task context <task-id> --agent claude-code

# 2. Implement the task.

# 3. Mark the task complete. This runs verify and, on pass,
#    records a done event in .code-pact/state/progress.yaml.
code-pact task complete <task-id> --agent claude-code
```

`task context` resolves the task id across every phase in `design/roadmap.yaml`,
so you do not need to pass a phase id.

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

## Quick reference

| Goal | Command |
|---|---|
| Write project brief | `code-pact plan brief` |
| Write project constitution | `code-pact plan constitution` |
| Generate AI planning prompt | `code-pact plan prompt [--clipboard]` |
| Bulk-import AI-generated roadmap | `code-pact phase import <yaml> [--strict]` |
| Fetch context for a task (as agent) | `code-pact task context <task-id> --agent <agent>` |
| Mark a task done (as agent) | `code-pact task complete <task-id> --agent <agent>` |
| Add a phase interactively | `code-pact phase add` |
| Add a task interactively | `code-pact task add <phase-id>` |
| Generate / refresh adapter files | `code-pact adapter --agent <agent> --force` |
| Show weighted progress | `code-pact progress` |
| Health-check the project | `code-pact doctor` |
| CI validation | `code-pact validate` |
