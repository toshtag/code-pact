# The sample phase

This document explains the **sample phase** the `init` wizard offers to create, what it actually contains, and how to decide whether to keep it, rename it, or delete it.

For where the sample phase fits in the broader onboarding flow, see [`docs/getting-started.md`](../getting-started.md#path-1--tutorial). For scenario-specific guidance, see [`docs/workflows/greenfield.md`](../workflows/greenfield.md) and [`docs/workflows/brownfield-feature.md`](../workflows/brownfield-feature.md).

## What the wizard creates

When you answer **yes** to the wizard prompt *"Create a sample phase?"*, `code-pact` writes one phase file:

```yaml
# design/phases/P1-welcome.yaml
id: P1
name: Welcome
weight: 1
confidence: high
risk: low
status: planned
objective: Confirm the project structure and verification pipeline.
verification:
  commands:
    - <your verification command>   # default: pnpm test
definition_of_done:
  - The verification command exits with status 0.
```

…and appends a corresponding entry to `design/roadmap.yaml`:

```yaml
phases:
  - id: P1
    path: design/phases/P1-welcome.yaml
    weight: 1
```

The verification command is whatever you answered to the earlier wizard prompt *"Default verification command:"* (pressing Enter accepts `pnpm test`).

**The sample phase has no tasks.** It is a phase contract only — a roadmap entry, an objective, a verify command, and a one-line `definition_of_done`. To exercise the loop end-to-end you still need to run `code-pact task add P1` interactively to attach at least one task.

## Why the wizard offers it

The sample phase exists to do two things:

1. **Smoke-test the project structure.** After `init`, running `code-pact plan lint` / `code-pact validate` should be green. A phase file in the roadmap is what makes that meaningful — an empty roadmap with no phases is also lint-green, but tells you nothing.
2. **Give you a working template.** New users frequently ask "what does a real phase YAML look like?" The sample phase is the answer. You can open it, see every required field, and copy-edit it into your own first phase rather than building the YAML from scratch or learning every required key from `docs/cli-contract.md`.

The default is **yes** because for first-time users the cost of an unwanted extra phase file is low, and the cost of failing the first `code-pact task context` invocation because no phase exists is high.

## Keep, rename, or delete?

| Scenario | Recommendation |
| --- | --- |
| You're running the tutorial path to verify the install works. | **Keep** until `task complete P1-T1` is green. Delete or rename afterward. |
| You're starting a greenfield project and will draft a real `P1` with `plan prompt` + `phase import`. | **Delete** the sample phase before running `phase import` — otherwise the import raises `DUPLICATE_PHASE_ID` because the AI-generated YAML almost certainly also names its first phase `P1`. |
| You're adopting `code-pact` on a brownfield repo to drive one new feature. | **Rename** to match the feature, *or* delete and write `phase add --id P1 --name <feature>` directly. The sample phase's generic name ("Welcome") will not survive review. |
| You answered **no** to the wizard prompt by mistake. | Just write `phase add --id P1 --name <name> --weight 1 --objective "..." --verify-command "<your-command>"` — the sample phase is not load-bearing and the wizard prompt has no special effect beyond running that one command for you. (`init --force` is intentionally a flag-based re-init path that bypasses the wizard; it will not re-prompt you.) |

## How to delete it

```sh
# Remove the phase file
rm design/phases/P1-welcome.yaml

# Edit design/roadmap.yaml and remove the P1 entry. You can do this
# in any text editor; `code-pact` does not ship a `phase remove`
# command in v1.0.

# Confirm the roadmap is still well-formed.
code-pact plan lint --json
code-pact validate
```

There is no need to manipulate `.code-pact/state/progress.yaml` — the sample phase has no tasks, so there are no `started` / `done` events to clean up. If you somehow did record events against a sample task (`task add P1` → `task start P1-T1` → ...) and then delete `P1-welcome.yaml`, the events become orphaned. `code-pact plan analyze` will surface them; the resolution is either to restore the phase file (events remain consistent) or to remove the orphaned events from `progress.yaml` by hand (operational log is append-only by convention, but not enforced).

## How to rename it

```sh
# 1. Move the file. The filename is by convention but is not load-bearing
#    for the CLI — `design/roadmap.yaml` is what binds id → path.
mv design/phases/P1-welcome.yaml design/phases/P1-<your-name>.yaml

# 2. Edit design/roadmap.yaml so the P1 entry's `path:` points at the
#    new filename.

# 3. Edit the phase YAML itself: update `name:`, `objective:`,
#    `weight:`, and `verification.commands` to match your real intent.

# 4. Confirm.
code-pact plan lint --json
code-pact validate
```

## What the sample phase is not

- It is **not a tutorial in the educational sense.** It does not walk you through `code-pact`'s concepts. [`docs/getting-started.md`](../getting-started.md) is the tutorial.
- It is **not protected.** The wizard offers it, the rest of `code-pact` treats it like any other phase. There is no special handling, no warning if you modify it, and no migration path for it.
- It is **not required.** You can answer **no** to the wizard prompt and `init` succeeds; the resulting project simply has zero phases until you add one.

## Next reading

- [`docs/getting-started.md`](../getting-started.md) — the tutorial path uses the sample phase as its starting point.
- [`docs/workflows/greenfield.md`](../workflows/greenfield.md) — when the sample phase helps vs. when to delete it for AI-assisted planning.
- [`docs/workflows/brownfield-feature.md`](../workflows/brownfield-feature.md) — when adopting on an existing repo, the sample phase is usually deleted within ten minutes.
