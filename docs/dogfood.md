# Dogfood guide

How to run `code-pact` against the `code-pact` repository itself. The repo is already initialized (`.code-pact/` and `design/` are committed), so you mostly skip `init` and verify the existing structure.

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

When the binary is in place, `doctor` should report a clean project (the repo carries the necessary state — if you removed `.code-pact/` mid-experiment, expect `CONFIG_ERROR` and re-run from a fresh checkout):

```sh
code-pact doctor
```

## Per-task flow (matches the agent adapter instructions)

```sh
# 1. Fetch the context pack. Output goes to stdout, no files written.
code-pact task context P5-T1 --agent claude-code

# 2. Implement the task.

# 3. Verify the deterministic completion criteria.
code-pact verify --phase P5 --task P5-T1
```

`task context` resolves the task id across every phase in `design/roadmap.yaml` so you do not need to pass a phase id.

## Inspecting state without changing it

```sh
code-pact phase ls
code-pact phase show P5 --json
code-pact progress --baseline initial
code-pact pack --phase P5 --task P5-T1 --agent claude-code   # writes to .context/
```

`pack` is the low-level primitive — it writes a Markdown file under `.context/<agent>/`. `task context` is the read-only equivalent agents call from their adapter instructions.

## Adding work via the wizards

```sh
code-pact phase new "Implement billing"
```

The wizard prompts for ID, weight, objective, confidence, risk, verify commands, and done criteria. The flag-based `phase add` is still available for scripted bulk work.

## Resetting to a clean state

If you want to throw away local state and re-init from scratch in a temp dir:

```sh
mkdir /tmp/cp-fresh && cd /tmp/cp-fresh
code-pact init                    # interactive wizard
```

Do **not** run `code-pact init` inside the `code-pact` repository — `.code-pact/` already exists and the command refuses without `--force`, but `--force` would clobber the committed fixtures.

## When to use which command

| Goal | Command |
|---|---|
| Start a new task as an agent | `code-pact task context <task-id> --agent <agent>` |
| Confirm a task is done | `code-pact verify --phase <p> --task <t>` |
| Add a phase by hand (CI / scripts) | `code-pact phase add --id ... --name ... --weight ... --objective ...` |
| Add a phase interactively | `code-pact phase new [<name>]` |
| Generate/refresh adapter files | `code-pact adapter --agent <agent> --force` |
| Show weighted progress | `code-pact progress` |
| Health-check the project layout | `code-pact doctor` |
