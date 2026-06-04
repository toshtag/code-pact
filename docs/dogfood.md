# Dogfood guide

How to run `code-pact` against the `code-pact` repository itself.

The repo is already initialized (`.code-pact/` exists as the maintainer's working state). This repo **commits the per-event progress ledger** under `state/events/`, exactly as a user project does: it is shared, merge-safe operational state (the collaboration-safe-state RFC made event files conflict-free), and tracking it is what lets code-pact dogfood its own CI branch-drift gate — an ignored ledger would make that gate silently skip. Until the first real event file is committed, `.code-pact/state/events/.gitkeep` keeps the ledger path tracked so the gate does not silently skip; the ledger readers ignore any name that is not an `<at-compact>-<id>.yaml` event file, so the sentinel never affects derived state. The `.gitignore` ignores only the machine-local / derived paths under `.code-pact/`: `locks/`, `cache/`, `adapters/`, and the **legacy monolithic `state/progress.yaml`** — the maintainer's pre-event-file history, read-merged locally; per RFC A3 it stays ignored until per-event files replace it (committing the monolithic file would reintroduce the merge problem the event ledger fixes). The shared config (`project.yaml`, profiles, `state/baselines/`) is tracked. The **adapter manifest** (`.code-pact/adapters/`) is **intentionally ignored** here: this repo regenerates and ignores the adapter-owned output (`CLAUDE.md`, `.claude/skills/*`), so manifest and its generated files travel together or not at all. `design/` remains the committed source of truth for phases and tasks, so `init` is not needed.

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

> A **fresh clone** may report an `ADAPTER_MISSING` advisory (`claude-code` is enabled but `CLAUDE.md` / `.claude/skills/*` are absent) until you regenerate the adapter output with `code-pact adapter install claude-code`. This is **expected** for this repo — the adapter output is regenerated and gitignored (see above) — and it is **warning-only**: plain `validate` does not fail on it. Note that `validate --strict` *does* promote this warning to a failure, so for strict validation regenerate the adapter output first (`adapter install`) or use non-strict `validate` for the dogfood health check.

## Daily path

Copy this for normal task work. It is the canonical loop (see [per-task-loop.md](per-task-loop.md)):

```sh
code-pact task prepare <task-id> --agent claude-code --json   # entry point: state + recommendation + next commands
code-pact task start <task-id> --agent claude-code
# ... implement ...
code-pact verify --phase <phase-id> --task <task-id>          # optional pre-flight
code-pact task complete <task-id> --agent claude-code         # runs verify, records `done`
code-pact task finalize <task-id> --json                      # preview the design-status flip
code-pact task finalize <task-id> --write --json              # apply it
```

`task complete` records progress but does **not** mutate `design/` — `task finalize` is what flips the design `status`. The verbs resolve the id across every phase in `design/roadmap.yaml`, so no phase id is needed.

## Optional diagnostics

Use these only when you need them — none are part of the normal flow:

| Need | Command |
|---|---|
| See the raw context pack | `code-pact task context <task-id> --agent claude-code` |
| Check current state + history | `code-pact task status <task-id> --json` |
| Ask "what should I do next?" (read-only) | `code-pact task runbook <task-id> --json` / `code-pact phase runbook <phase-id> --json` |
| Record a blocker | `code-pact task block <task-id> --reason "..."` |
| Resume after a blocker | `code-pact task resume <task-id> --agent claude-code` |
| Record done without `task complete` (external completion or a `record_only` task verified by hand) | `code-pact task record-done <task-id> --evidence "PR #123"` (records `done` with `source: external`; the decision gate still applies) |
| Reconcile a whole phase at once | `code-pact phase reconcile <phase-id> --write` |
| Audit declared vs actual writes | `code-pact task finalize <task-id> --json \| jq .data.write_audit` ([detail](cli-contract.md#task-finalize--flip-task-design-status-to-done-v12-p11)) |

> [!NOTE]
> A `blocked` task cannot complete directly — `task complete` returns `INVALID_TASK_TRANSITION`. Resume it first so the `resumed` event records the unblock decision.

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
