# The sample phase

This document explains the **sample phase** that `code-pact init --sample-phase` creates, what it actually contains, and how to decide whether to keep it, rename it, or delete it.

> Just want to watch the per-task loop run, without writing anything to your project? Use [`code-pact tutorial`](../getting-started.md#path-1--tutorial) instead — it runs the loop in a throwaway sandbox and deletes it. The sample phase described here is for when you want a real, editable phase in your own repo.

For where the sample phase fits in the broader onboarding flow, see [`docs/getting-started.md`](../getting-started.md#path-1--tutorial). For the per-task / per-phase guidance commands it demos, see [`docs/concepts/runbook.md`](runbook.md).

## How to create it

The sample phase is opt-in via the `--sample-phase` flag, in both interactive and non-interactive `init`:

```sh
code-pact init --sample-phase
# non-interactive / CI:
code-pact init --non-interactive --locale en-US --agent claude-code --sample-phase
```

Without `--sample-phase`, `init` produces an empty `roadmap.yaml` and no sample phase. The "just show me the loop" case is covered by [`code-pact tutorial`](../getting-started.md#path-1--tutorial), which runs in a throwaway sandbox with no cleanup.

## What gets created

When you create the sample phase, `code-pact` writes one phase file:

```yaml
# design/phases/TUTORIAL-walkthrough.yaml
id: TUTORIAL
name: Walkthrough
weight: 1
confidence: high
risk: low
status: planned
objective: |
  Confirm the project structure and verification pipeline by walking
  through the per-task loop end-to-end. Tutorial-only — delete this
  phase (and its roadmap entry) before treating design/ as your
  project's source-of-truth.
definition_of_done:
  - The verification command exits with status 0.
  - Every TUTORIAL-T* task has been completed and finalized.
verification:
  commands:
    - <your verification command>   # default: pnpm test
tasks:
  - id: TUTORIAL-T1
    type: feature
    # readiness fields all default to "low" / "small" / "medium" / "short"
    status: planned
    description: |
      Tutorial-only task. Run `code-pact task context TUTORIAL-T1` to
      see the context pack, then `code-pact task complete TUTORIAL-T1`
      to mark it done.
  - id: TUTORIAL-T2
    type: docs
    status: planned
    depends_on:
      - TUTORIAL-T1
    description: |
      Tutorial-only task. Demonstrates `task finalize TUTORIAL-T2 --write`
      after `task complete`. The depends_on chain lets the tutorial demo
      the dependency field + the task runbook blocking-step output.
```

…and appends a corresponding entry to `design/roadmap.yaml`:

```yaml
phases:
  - id: TUTORIAL
    path: design/phases/TUTORIAL-walkthrough.yaml
    weight: 1
```

The verification command is whatever the wizard's *"Default verification command"* step recorded when you ran `init --sample-phase` in a TTY (pressing Enter accepts `pnpm test`). The non-interactive path uses `pnpm test` as the default.

## Why the sample phase exists

The tutorial artifact exists to do three things:

1. **Smoke-test the project structure end-to-end.** Running `code-pact plan lint --json` / `validate --json` / `doctor --json` after `init --sample-phase` should all be green. A phase file with tasks in the roadmap is what makes that meaningful — an empty roadmap is also lint-green but tells you nothing.
2. **Give you a working template that exercises every layer.** Because `TUTORIAL-T2 depends_on: [TUTORIAL-T1]`, you can demo:
   - The per-task loop: `task context` → implementation → `task complete` → `task finalize`.
   - Readiness fields (`depends_on` is declared).
   - Runbook guidance: `task runbook TUTORIAL-T2 --json` returns a blocking dependency step until `TUTORIAL-T1` is complete; `phase runbook TUTORIAL --json` returns the priority-ordered phase view.
   - Reconciliation: once both TUTORIAL-T* tasks are complete, `phase reconcile TUTORIAL --write` flips both design statuses in one atomic batch.
3. **Make the tutorial-vs-source-of-truth boundary explicit.** The `TUTORIAL` id avoids colliding with your real phases: user phases are virtually always `P1`, `P2`, etc., never `TUTORIAL`, so you can leave the sample in place during early development and `phase import` a real roadmap without a clash.

## Keep, rename, or delete?

| Scenario | Recommendation |
| --- | --- |
| You're running the tutorial path to verify the install works. | **Keep** until `task complete TUTORIAL-T1` and `task complete TUTORIAL-T2` are both green. Delete afterward. |
| You're starting a greenfield project and will draft a real `P1` with `plan prompt` + `phase import`. | **Delete** the TUTORIAL phase whenever you like — there is no collision with `P1` (TUTORIAL's id and filename are deliberately separate). You can also leave it in place during early development and remove it before your first release. |
| You're adopting `code-pact` on a brownfield repo to drive one new feature. | **Delete** the TUTORIAL phase once you've confirmed `validate` / `doctor` are green. Then write `phase add --id P1 --name <feature> ...` (or use `phase import`) directly. |
| You ran `init` without `--sample-phase` but want the sample now. | Re-run `code-pact init --sample-phase` to recreate it — that is the only sanctioned creation path (`phase add --id TUTORIAL ...` is rejected with `CONFIG_ERROR`; see [§ `TUTORIAL` is a reserved phase id](#tutorial-is-a-reserved-phase-id)). **OR** skip the sample artifact entirely and start with your own phase — it is not load-bearing. |

## How to delete it

```sh
# Remove the phase file
rm design/phases/TUTORIAL-walkthrough.yaml

# Edit design/roadmap.yaml and remove the TUTORIAL entry. You can do this
# in any text editor; `code-pact` does not ship a `phase remove`
# command.

# Confirm the roadmap is still well-formed.
code-pact plan lint --json
code-pact validate --json
```

If you have already started or completed any TUTORIAL-T* tasks before deleting, `code-pact plan analyze` will surface them as `ORPHAN_PROGRESS_EVENT` warnings (events for task ids no longer in any phase). The resolution is either to restore the phase file (events become consistent) or to delete the orphaned event files from `.code-pact/state/events/` by hand (or remove them from a legacy `.code-pact/state/progress.yaml`) — the operational log is append-only by convention, but not enforced, so for a tutorial cleanup that's fine.

## How to rename it

The TUTORIAL artifact is intended to be deleted rather than renamed, but renaming is supported:

```sh
# 1. Move the file. The filename is by convention but is not load-bearing
#    for the CLI — design/roadmap.yaml is what binds id → path.
mv design/phases/TUTORIAL-walkthrough.yaml design/phases/<new-id>-<slug>.yaml

# 2. Edit design/roadmap.yaml so the entry's id and path point at the
#    new values.

# 3. Edit the phase YAML itself: update id, name, objective, weight,
#    and verification.commands to match your real intent. Update
#    tasks[].id to match the new phase id (e.g. P1-T1 / P1-T2 if you
#    renamed the phase to P1). depends_on values must be updated to
#    point at the new task ids.

# 4. Confirm.
code-pact plan lint --json
code-pact validate --json
```

For most cases, deleting the TUTORIAL artifact + running `phase add` (or `phase import`) with your real intent is cleaner than renaming. The TUTORIAL tasks' descriptions explicitly mark them as tutorial-only and won't survive review.

## `TUTORIAL` is a reserved phase id

The id `TUTORIAL` is **reserved at the governance layer** for the sample-phase artifact. `init --sample-phase` is the only sanctioned creation path; every other creation route is rejected:

| Path | Outcome |
| --- | --- |
| `init --sample-phase` (interactive or non-interactive) | **Allowed.** The bootstrap path passes an internal `_isSampleCreation: true` bypass to `createPhase` |
| `phase add --id TUTORIAL ...` | `CONFIG_ERROR` (exit 2). Roadmap byte-identical (no write) |
| `phase new` wizard → typing `TUTORIAL` as the id | `CONFIG_ERROR` (exit 2) |
| `phase import` containing any entry with `id: TUTORIAL` | `CONFIG_ERROR` (exit 2) from a preflight scan — the entire import is rejected before any phase YAML is written |
| `validate` / `plan lint` / `plan analyze` against an existing TUTORIAL phase | No warning. The block is creation-time only; existing data is untouched |

**Practical implication.** If you want to recreate the sample phase after deleting it, run `code-pact init --sample-phase` again (in a project that already has `.code-pact/`, the bootstrap is idempotent for the sample phase — it will be re-added). Don't try to recreate it via `phase add --id TUTORIAL ...`; the block fires unconditionally outside the sanctioned bootstrap path.

The block uses the existing `CONFIG_ERROR` envelope; no new error code ships for this. The error message names the reserved id and points back at `init --sample-phase`. See [docs/concepts/governance.md](governance.md) for the broader governance surface.

## What the sample phase is not

- It is **not a tutorial in the educational sense.** It does not walk you through `code-pact`'s concepts. [`docs/getting-started.md`](../getting-started.md) is the tutorial; the TUTORIAL artifact is the *fixture* the tutorial uses.
- It is **not protected from your edits.** The `--sample-phase` flag creates it; the rest of `code-pact` treats it like any other phase. There is no special handling, no warning if you modify the phase contents, and no migration path for it. The reserved-id block protects only the **id**; the phase data itself is yours to edit, delete, or rename.
- It is **not required.** Omit `--sample-phase` and `init` succeeds; the resulting project simply has zero phases until you add one.
- It is **not source-of-truth.** The tutorial-only framing is embedded in the phase's `objective` text, the task descriptions, and the console output after creation. Delete it before you treat `design/` as your project's design source-of-truth.

## Next reading

- [`docs/getting-started.md`](../getting-started.md) — the tutorial path uses the TUTORIAL artifact as its starting point.
- [`docs/concepts/runbook.md`](runbook.md) — the per-task / per-phase guidance the TUTORIAL artifact lets you demo end-to-end.
- [`docs/concepts/task-readiness-fields.md`](task-readiness-fields.md) — the readiness fields TUTORIAL-T2 declares (`depends_on`).
- [`docs/concepts/finalization-reconciliation.md`](finalization-reconciliation.md) — the commands the tutorial walks through (`task finalize` / `phase reconcile`).
- [`docs/concepts/governance.md`](governance.md) — the governance layer that hardens the TUTORIAL reservation and serializes design-mutating commands behind the advisory write lock.
