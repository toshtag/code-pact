# Getting started

This guide takes you from an empty project to a successful `task complete` in about thirty minutes. It documents **three onboarding paths** side by side so you can pick the one that matches how you want to build your roadmap.

If you only want a sixty-second overview of what `code-pact` is, read the [README](../README.md) first.

## Prerequisites

- Node.js **22 or newer** (LTS or current)
- A terminal where you can run `npm install -g code-pact` (or `npx code-pact …`)
- One of the supported agents: `claude-code`, `codex`, or `generic` (Stable). `cursor` and `gemini-cli` work but are Experimental.

## Install

```sh
# Global install
npm install -g code-pact
code-pact --version

# Or use without installing
npx code-pact --version
```

If you have a project with pinned pre-v1.0 behaviour, `npm install -g code-pact@alpha` still works. New projects should use the default `latest` tag.

## Choose your path

Pick the path that matches how you want to bootstrap your roadmap. All three converge on the same per-task agent loop (described at the end), so switching between them later is not painful.

| Path | When to use it | Time to first `task complete` |
| --- | --- | --- |
| **Tutorial** | You want the fastest possible end-to-end smoke test. | ~5 minutes |
| **Manual** | You already know what you want to build and prefer typing the roadmap by hand. | ~15 minutes |
| **AI-assisted** | You want an AI agent to draft the phases and tasks from your project brief. | ~20 minutes |

---

## Path 1 — Tutorial

Use the `init` wizard's built-in sample phase to confirm the full loop works end to end. This path **does not require any planning artifacts** — it exists to verify that your install is healthy.

```sh
# 1. Initialize. The wizard asks: language → agents → default agent →
#    generate adapter files now (yes) → verification command (pnpm test) →
#    create a tutorial sample phase (yes) → collect a project brief (skip).
code-pact init

# 2. The tutorial sample phase TUTORIAL (with TUTORIAL-T1 and TUTORIAL-T2)
#    was created. v1.4+ ships two minimal tutorial tasks; TUTORIAL-T2
#    declares `depends_on: [TUTORIAL-T1]` so you can demo the P10
#    dependency field + the P12 task runbook blocking-step output
#    in one bootstrap.

# 3. Fetch the markdown context pack and implement the first task.
code-pact task context TUTORIAL-T1 --agent claude-code

# 4. After implementation, mark complete. This runs the phase's
#    verify command and, on pass, appends a `done` event to
#    .code-pact/state/progress.yaml. The design YAML's `status` field
#    is NOT mutated by this command — that is the v1.0 contract.
code-pact task complete TUTORIAL-T1 --agent claude-code

# 5. (Optional, v1.2+) Flip the design YAML's `status` field to `done`
#    so design intent matches the operational fact. Defaults to dry-run;
#    pass --write to actually mutate the phase YAML. The bulk
#    counterpart is `code-pact phase reconcile TUTORIAL --write`.
code-pact task finalize TUTORIAL-T1 --write

# 6. Repeat steps 3–5 for TUTORIAL-T2 (depends on TUTORIAL-T1 being done).
code-pact task context TUTORIAL-T2 --agent claude-code
code-pact task complete TUTORIAL-T2 --agent claude-code
code-pact task finalize TUTORIAL-T2 --write

# (Optional, v1.3+) Anywhere in the loop, ask the CLI "what should I
# do next?" instead of guessing. Read-only — runbook never executes
# anything, it just returns the recommended sequence of commands.
code-pact task runbook TUTORIAL-T2 --json   # per-task next steps
code-pact phase runbook TUTORIAL --json     # per-phase next steps (histograms + reconcile candidate)
```

If `pnpm test` is not the right verification command for your repo, choose another one when the wizard prompts for it (step 1) — `node --version` is a safe choice for a smoke test.

> **Try the dependency demo.** After `init`, before completing TUTORIAL-T1, run `code-pact task runbook TUTORIAL-T2 --json`. The first step in `data.next_steps[]` will be a blocking `manual_action` step ("Wait for TUTORIAL-T1 to reach derived state: done"). This is the P10 + P12 integration the tutorial artifact exists to demo.

> Steps 5/6 and the runbook commands are opt-in. v1.0 / v1.1 projects can keep flipping `status` by hand if they prefer; `task finalize` and `phase reconcile` exist to mechanize the step in release-prep PRs. `task runbook` and `phase runbook` (v1.3+) return read-only sequencing guidance — they never execute anything. See [`docs/concepts/finalization-reconciliation.md`](concepts/finalization-reconciliation.md) and [`docs/concepts/runbook.md`](concepts/runbook.md) for the walkthroughs.

> The tutorial artifact is named `TUTORIAL — Walkthrough` (v1.4+) and exists only to confirm the project structure and verification pipeline. Delete it (or its filename `design/phases/TUTORIAL-walkthrough.yaml` plus the roadmap entry) once you have real phases. See [`docs/concepts/sample-phase.md`](concepts/sample-phase.md) for the full keep / rename / delete decision. Pre-v1.4 projects that still have a `P1-welcome.yaml` are untouched by upgrades.

> **CI / non-TTY users (v1.4+).** The tutorial path is also scriptable as a single command: `code-pact init --non-interactive --agent claude-code --locale en-US --sample-phase` produces the same TUTORIAL artifact without a TTY. Before v1.4 the wizard was the only path; pre-v1.4 `init --non-interactive` produces an empty roadmap with no sample phase.

---

## Path 2 — Manual

Use this path when you already know the shape of your roadmap. You will write each phase and task yourself, mixing interactive and flag-based commands.

```sh
# 1. Initialize. You can run the wizard interactively or skip it entirely.
#    Either works; the non-interactive form is shown so you can see the
#    full flag surface.
code-pact init --non-interactive --agent claude-code --locale en-US

# 2. Capture the project's intent. These wizards write design/brief.md
#    and design/constitution.md respectively.
code-pact plan brief
code-pact plan constitution

# 3. Add the first phase with flags (skip the wizard).
code-pact phase add \
  --id P1 \
  --name "Foundation" \
  --weight 20 \
  --objective "Establish the project foundation" \
  --verify-command "pnpm test"

# 4. Add a task to the phase. TWO paths:
#
#    (a) Interactive (existing v0.6 path):
code-pact task add P1
#
#    (b) Non-interactive (v1.4+; `--description` triggers flag-driven mode):
code-pact task add P1 \
  --description "Login form" \
  --type feature \
  --ambiguity medium \
  --risk low \
  --depends-on P1-T0 \
  --read "src/auth/**" \
  --write "src/handlers/login.ts" \
  --json

# 5. Generate the per-agent instruction files. The wizard in step 1 can
#    do this for you; this is the standalone command for later use.
code-pact adapter install claude-code

# 6. Per-task agent loop (described below).
code-pact task context P1-T1 --agent claude-code
code-pact task complete P1-T1 --agent claude-code
```

Multi-word verification commands must be quoted, otherwise the trailing tokens raise `CONFIG_ERROR`:

```sh
# Correct
code-pact phase add ... --verify-command "node --version"

# Rejected — the trailing token would be silently lost
code-pact phase add ... --verify-command node --version
```

> **CI / non-TTY users (v1.6+).** Steps 2, 4(a), and the wizards in general all have non-interactive equivalents now. `plan brief` and `plan constitution` (P17) each accept three modes — `--from-file <yaml>`, `--stdin`, or a flag-driven form (`--what` / `--who` / `--differentiator` for brief; `--description` / `--principle` for constitution). `task add` (v1.4 P13-T3) has had `--description` + readiness flags since v1.4. `phase import` (v0.4+) bulk-loads a YAML roadmap. A fully scripted CI bootstrap looks like:
>
> ```sh
> code-pact init --non-interactive --agent claude-code --locale en-US --json
> code-pact plan brief \
>   --what "What we're building" \
>   --who  "Who it's for" \
>   --differentiator "What makes it different" \
>   --json
> code-pact plan constitution \
>   --description "Project description" \
>   --principle "First principle" \
>   --principle "Second principle" \
>   --json
> # ... then phase add / task add / adapter install as in step 3+.
> ```
>
> Pre-v1.6, `plan brief` and `plan constitution` were TTY-only — after a non-interactive `init`, `code-pact validate` reported `BRIEF_MISSING` / `CONSTITUTION_PLACEHOLDER` warnings that required either a TTY visit or hand-editing the files. v1.6+ resolves both from CI with the modes above. See [`docs/dogfood.md` § Non-interactive `plan brief` / `plan constitution`](dogfood.md) for the full walkthrough and `docs/cli-contract.md` for the envelope shapes.

---

## Path 3 — AI-assisted

Use this path when you want an AI agent to draft your phases and tasks from a project brief. `code-pact` itself never calls an LLM — `plan prompt` builds a prompt string that you paste into your agent (Claude, Codex, Gemini, …), and `phase import` reads the YAML the agent gives back.

```sh
# 1. Initialize.
code-pact init

# 2. Capture the project's intent so the planning prompt has something
#    to ground itself in.
code-pact plan brief
code-pact plan constitution

# 3. Generate the planning prompt and hand it to your agent.
code-pact plan prompt > planning-prompt.txt
#    Open planning-prompt.txt in your agent and ask it to produce a
#    YAML roadmap. Save the agent's reply as draft-roadmap.yaml.

# 4. Bulk-import the agent-generated roadmap. The lenient mode fills
#    in optional task fields with defaults and reports what it filled.
code-pact phase import draft-roadmap.yaml
#    Add --strict to require every field explicitly.
code-pact phase import draft-roadmap.yaml --strict

# 5. Install the adapter for the agent that will implement the tasks.
code-pact adapter install claude-code

# 6. Per-task agent loop (described below).
code-pact task context P1-T1 --agent claude-code
code-pact task complete P1-T1 --agent claude-code
```

The lenient `phase import` mode is intentional. It lets the AI focus on getting `id`s right and trust `code-pact` to fill in the rest; you can audit the filled-in defaults in the JSON response or by running `code-pact plan lint --json`.

> **TTY required for steps 2 and 3.** `plan brief` and `plan constitution` are interactive and need a TTY. `plan prompt` itself runs fine without them — if `design/brief.md` is missing, the generated prompt includes a line *"No design/brief.md found. Add a project description above this section manually."* so the AI agent knows to ask for it. The full AI-assisted path is therefore feasible without ever running the brief / constitution wizards, but you give the AI less to ground on.

---

## The per-task agent loop

Once you have at least one task, every path converges on the same deterministic loop. This is what an agent (or you) runs per task.

```sh
# A. Get the execution plan for the task — model tier, effort, context
#    profile, whether planning is required, preflight commands, budget
#    profile. Strictly additive; safe to ignore fields you don't need.
code-pact recommend --phase P1 --task P1-T1 --json

# B. Fetch the markdown context pack (stdout, no side effects).
#    Content adapts automatically to task attributes (context_size,
#    ambiguity, write_surface).
code-pact task context P1-T1 --agent claude-code

# C. Record that the task is started so handoff and status views know.
code-pact task start P1-T1 --agent claude-code

# D. If the task gets blocked, record why explicitly.
code-pact task block P1-T1 --reason "Waiting for review on PR #42"
code-pact task resume P1-T1 --agent claude-code

# E. Inspect the derived state and full event history at any time.
code-pact task status P1-T1 --json

# F. After implementation, mark the task complete. This runs the phase's
#    verify command and, on pass, appends a `done` event to
#    .code-pact/state/progress.yaml.
code-pact task complete P1-T1 --agent claude-code
```

A few invariants worth knowing:

- `task start` and `task complete` are **idempotent** — re-running on a task that is already started / done returns `already_started: true` / `already_done: true`.
- A `blocked` task cannot complete directly. `task complete` returns `INVALID_TASK_TRANSITION` until the task is resumed, so the `resume` event captures the unblock decision.
- `task complete` records progress, but **does not mutate `design/`**. The design YAML is intent; `progress.yaml` is what actually happened. If they diverge, `code-pact plan analyze` reports a `STATUS_DRIFT` warning.

## Optional task readiness fields (v1.1+)

v1.1.0 adds five optional fields to the task schema that let a task declare its own context-pack targets, dependencies, read / write surface, and acceptance references. They are **fully optional** — pre-v1.1 phase YAML continues to work unchanged, and a task that declares none of these fields produces the same `task context` output it did under v1.0.2.

```yaml
# Excerpt from design/phases/<phase>.yaml
tasks:
  - id: P1-T1
    type: feature
    # ... existing required fields ...
    depends_on: [P1-T0]                       # same-phase task ids
    decision_refs: [design/decisions/x.md]    # files surfaced into the pack
    reads: [src/core/**/*.ts]                 # declared read surface (globs)
    writes: [src/core/foo.ts]                 # declared write surface (globs)
    acceptance_refs: [docs/cli-contract.md]   # acceptance criteria paths
```

When declared, each field adds a corresponding section to the `task context` output: **Depends on** (with derived state from `progress.yaml`), **Declared read surface** (each glob plus matched files), **Declared write surface** (globs only), **Declared decisions** (full body of referenced files), and **Acceptance references** (path list).

`plan lint` validates the new fields automatically when present (twelve additive `TASK_*` codes — see [`docs/cli-contract.md` § Plan diagnostic codes — Task Readiness Schema diagnostics](cli-contract.md#plan-diagnostic-codes)). The recommended adoption pattern is to declare new fields on **new** tasks first; retroactive backfill on existing tasks is unnecessary. For a walkthrough of a phase YAML that uses every field, see [`docs/concepts/task-readiness-fields.md`](concepts/task-readiness-fields.md). For the migration story from v1.0.x, see [`docs/migration.md` § v1.0.x → v1.1.0](migration.md#v10x--v110).

## Checkpoints at phase / PR boundaries

```sh
code-pact plan lint --json          # schema + naming + reference checks
code-pact plan normalize --check    # whitespace/newline drift (--write to apply)
code-pact plan analyze --json       # design status vs progress-log drift
code-pact doctor --json             # human-friendly project health check
code-pact validate                  # CI-friendly, exit 1 on errors
```

Both `plan lint` and `plan analyze` accept `--strict` to fail on warnings. `plan normalize --write` preserves YAML comments and Markdown hard line breaks.

## Concurrent processes (v1.5+)

`code-pact` is designed to be run by a single user (or a single agent) at a time per project. If a workflow ends up running two design-mutating commands in parallel against the same project — for example, an agent calling `task finalize` while a human runs `phase reconcile --write` — the second invocation fails fast with `LOCK_HELD` (exit 2):

```sh
code-pact phase reconcile P1 --write --json
# {"ok":false,"error":{"code":"LOCK_HELD",
#   "message":"Another code-pact mutation is in progress: task finalize P1-T1 --write (pid: 12345, ...). If you are certain no command is running, remove .code-pact/locks/write.lock and retry."},
#  "data":{"lock_holder":{"pid":12345,"hostname":"laptop.local","cmd":"task finalize P1-T1 --write","created_at":"..."},"lock_path":"..."}}
```

This is a **transient** failure: wait for the holding process to finish and re-run. Read-only commands (`plan lint`, `plan analyze`, `task runbook`, `phase runbook`, `validate`, `doctor`, `recommend`, `task context`, `task status`) do NOT acquire the lock and can be used to observe state while a mutation is pending. If a process crashed and left the lock file behind, you can delete `.code-pact/locks/write.lock` manually — but only after confirming no `code-pact` process is actually running.

See [`docs/concepts/governance.md`](concepts/governance.md) for the v1.5 governance walkthrough and [`docs/dogfood.md` § Troubleshooting → `LOCK_HELD`](dogfood.md#lock_held-from-a-design-mutating-command-v15) for the recovery playbook.

## Ingesting external specs (v1.8+, optional)

If you are coming from Spec Kit or a similar spec-driven planning tool and already have a `tasks.md` (or `spec.md` / `plan.md`), the v1.8 **Spec Kit bridge** lets you bootstrap from those artifacts instead of starting from `plan brief`:

```sh
# Generate a draft phase YAML from a Spec Kit tasks.md (dry-run first)
code-pact spec import --from tasks.md --phase-id P-feature --json

# Persist to design/phases/P-feature-imported.yaml
code-pact spec import --from tasks.md --phase-id P-feature --write

# Extract brief / constitution candidates from spec.md without writing
code-pact spec import --suggest-from spec.md --json
```

This is a **read-only one-way bridge** — code-pact does not re-implement Spec Kit and does not sync back. If you do not already have spec-driven planning artifacts, you do not need this command; use `init` + `plan brief` + `plan constitution` instead.

See [`docs/spec-kit-bridge.md`](spec-kit-bridge.md) for the full walkthrough, the supported Markdown subset, and the post-import follow-up sequence.

## Adapter management later

The `init` wizard (or step 5 in the manual / AI-assisted paths) is the only time most projects need to think about adapters. After that, the upgrade path looks like this:

```sh
code-pact adapter list --json                          # show registered adapters
code-pact adapter upgrade claude-code --check --json   # inspect drift, write nothing
code-pact adapter upgrade claude-code --write          # apply safe updates
code-pact adapter doctor --json                        # adapter-scoped health check
```

`--force` is **unmanaged-adoption only** — it never overrides a `managed-modified` file. Destructive overwrite of locally edited managed files is gated behind `adapter upgrade --write --accept-modified` so a stray `--force` in a CI script cannot blow away local edits.

## Next reading

- [`docs/cli-contract.md`](cli-contract.md) — full flag / exit code / JSON envelope / error code reference and the Stability taxonomy.
- [`docs/migration.md`](migration.md) — upgrade guidance from any prior alpha (v0.6 – v0.9) up through v1.5.0.
- [`docs/dogfood.md`](dogfood.md) — the real-project walkthrough, including troubleshooting for the most common error codes.
- [`docs/concepts/governance.md`](concepts/governance.md) — the v1.5 governance layer (advisory write lock, reserved-id block, roadmap mutation policy, phase status manual-flip convention).
- [`docs/spec-kit-bridge.md`](spec-kit-bridge.md) — the v1.8 read-only one-way importer for Spec Kit `tasks.md` / `spec.md` / `plan.md` artifacts.
