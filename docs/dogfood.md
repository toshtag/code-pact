# Dogfood guide

How to run `code-pact` against the `code-pact` repository itself.

The repo is already initialized (`.code-pact/` is committed), so `init` is not needed. The `design/` directory containing phases and tasks is the source of truth for work in progress.

This page is the **day-to-day quick guide**. Deeper, lower-frequency maintainer topics — planning wizards, model-aware adapters, adapter-upgrade internals, Spec Kit import, release-prep posture, and the design-vs-progress contract — live in [maintainers/operations.md](maintainers/operations.md).

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
# 0. Start every task here. task prepare is the single per-task entry
#    point — one call returns the current state, the execution
#    recommendation (model tier, effort, planning posture, budget), the
#    context pack metadata, a structured next_action, and a `commands`
#    dictionary with the exact next commands to run. v1.11+.
code-pact task prepare <task-id> --agent claude-code --json

# 1. (Diagnostic) Fetch the context pack directly only if you need it
#    outside task prepare — output goes to stdout, no files written.
#    `recommend` is likewise available standalone (see operations.md
#    § Reading recommend --json); task prepare runs both for you.
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
#    Does NOT mutate the task's `status` field in the phase YAML —
#    that is the v1.0 contract (design intent vs operational fact).
code-pact task complete <task-id> --agent claude-code

# 6. (v1.2+) Flip the phase YAML's `status` field for the completed task.
#    Defaults to dry-run; pass --write to apply. Eligibility requires
#    a `done` event in progress.yaml.
code-pact task finalize <task-id> --json          # preview
code-pact task finalize <task-id> --write --json  # apply

# Or, when reconciling many completed tasks at once (e.g. during
# release prep), use the bulk version:
code-pact phase reconcile <phase-id> --write

# 7. (v1.3+) At any point in the loop, ask the CLI for read-only
#    sequencing guidance. Runbook never executes anything — it just
#    returns the recommended next steps as command strings.
code-pact task runbook <task-id> --json     # per-task next steps
code-pact phase runbook <phase-id> --json   # per-phase priority list + histograms
```

The task / phase verbs all resolve the id across every phase in `design/roadmap.yaml`, so you do not need to pass a phase id. `task runbook` / `phase runbook` (v1.3+) take no `--agent` flag — runbook is agent-independent sequencing guidance.

A task that is currently `blocked` cannot be completed directly — `task complete` returns `INVALID_TASK_TRANSITION`. Resume it first so the `resumed` event records the decision that unblocked the task.

> The `(v1.6+)` declared-writes audit (`task finalize --json | jq .data.write_audit`, optionally with `--base-ref main`) is documented in [`cli-contract.md` § `task finalize`](cli-contract.md#task-finalize--flip-task-design-status-to-done-v12-p11).

## Inspecting state

```sh
code-pact phase ls
code-pact phase show <phase-id> --json
code-pact progress --baseline initial
```

## Checkpoints before a PR / release

`plan lint`, `plan normalize`, and `plan analyze` are **checkpoint commands**, not per-task gates. Run them at phase / PR boundaries:

```sh
code-pact plan lint --include-quality --strict --json   # schema + naming + quality
code-pact plan analyze --strict --json                  # design status vs progress drift
code-pact plan normalize --check --json                 # whitespace/newline drift (--write to apply)
code-pact validate --json                               # CI-friendly, exit 1 on errors
code-pact doctor --json                                 # human-friendly health check
```

For the full flag detail, the strict-clean release-prep posture, and `phase runbook --across-phases` release tracking, see [maintainers/operations.md § Planning integrity](maintainers/operations.md#planning-integrity-v07--checkpoint-commands).

## Resetting to a clean state in a temp dir

Do **not** run `code-pact init` inside this repository — `.code-pact/` already exists and the command will refuse without `--force`. To experiment with a fresh project:

```sh
mkdir /tmp/cp-fresh && cd /tmp/cp-fresh
code-pact init
```

## Troubleshooting

Error-code recovery lives on its own page: **[troubleshooting.md](troubleshooting.md)**. It maps each diagnostic code to a recovery action — `MANIFEST_NOT_FOUND`, `INVALID_TASK_TRANSITION`, `PLAN_NORMALIZE_REQUIRED`, `VERIFICATION_FAILED`, `TASK_FINALIZE_NOT_ELIGIBLE`, `TASK_FINALIZE_WRITE_REFUSED`, `PHASE_RECONCILE_WRITE_REFUSED`, `LOCK_HELD`, the reserved-`TUTORIAL` `CONFIG_ERROR`, `ADAPTER_GENERATOR_STALE`, and the expected warnings after a non-interactive bootstrap.

## Quick reference

The per-task loop (see [per-task-loop.md](per-task-loop.md) for the lifecycle diagram):

| Goal | Command |
|---|---|
| **Prepare a task** (entry point) | `code-pact task prepare <task-id> --agent claude-code --json` |
| Mark a task started | `code-pact task start <task-id> --agent claude-code` |
| Verify without recording an event | `code-pact verify --phase <phase-id> --task <task-id>` |
| Mark a task complete | `code-pact task complete <task-id> --agent claude-code` |
| Finalize design status (preview → apply) | `code-pact task finalize <task-id> --json` then `--write --json` |
| Block / resume a task | `code-pact task block <task-id> --reason "<text>"` / `code-pact task resume <task-id> --agent claude-code` |
| Inspect a task's state + history | `code-pact task status <task-id> --json` |
| Read-only next-step guidance | `code-pact task runbook <task-id> --json` / `code-pact phase runbook <phase-id> --json` |

Checkpoints & health:

| Goal | Command |
|---|---|
| Static integrity + quality | `code-pact plan lint --include-quality --strict --json` |
| Design-vs-progress drift | `code-pact plan analyze --strict --json` |
| CI validation | `code-pact validate --json` |
| Human-friendly health check | `code-pact doctor --json` |
| Check / apply adapter drift | `code-pact adapter upgrade <agent> --check --json` / `--write` |

Planning wizards, model-aware adapter install, Spec Kit import, and release-prep detail → [maintainers/operations.md](maintainers/operations.md).
