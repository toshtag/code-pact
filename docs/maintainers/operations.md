# Maintainer operations & history

Detailed, lower-frequency maintainer notes split out of [dogfood.md](../dogfood.md)
(the day-to-day quick guide). This page collects the deeper walkthroughs and the
per-version behaviour that maintainers occasionally need but rarely read top to
bottom.

## Reading `recommend --json` (v0.8)

The fields most worth wiring into agent behavior:

- `tier` / `effort` / `modelId` — choose which model to invoke and how hard to think.
- `contextProfile` (`small` / `medium` / `large`) — how much surrounding context to pull. `large` includes `design/constitution.md` and decision files.
- `planningRequired` (boolean) — if `true`, plan the implementation before writing code. Combined with `ambiguityAction`, this tells you whether the next step is "go" or "go ask the human."
- `ambiguityAction` (`proceed` / `clarify_before_implementation` / `split_recommended`) — `clarify_before_implementation` means stop and ask; `split_recommended` means the task is too wide for one shot, break it up first.
- `preflight[]` — ordered list of `code-pact` commands to run before implementation. Each entry has `argv` ready to pass to the CLI and a `reason` explaining why it was emitted. `required: false` everywhere in v0.8 — advisory, not mandatory.
- `budgetProfile` — categorical hints (not token counts) for how many tool calls, context files, and verification commands to expect.

The contract is strictly additive — earlier consumers that only read `tier` / `effort` / `modelId` / `reasons` continue to work unchanged.

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

## Non-interactive `plan brief` / `plan constitution` (v1.6+, P17)

Both wizard commands now accept three pairwise-mutually-exclusive non-interactive input modes — useful in CI, agent sessions, or any context without a TTY. Without one of these modes, non-TTY invocations still return `CONFIG_ERROR` (v1.5.1 contract preserved).

```sh
# --- plan brief ---

# (1) Read a YAML file (must contain non-empty `what` and `who`).
cat > brief.yaml <<EOF
what: A control plane for AI coding agents.
who: Software teams adopting agentic workflows.
differentiator: Vendor-neutral, deterministic CLI.
EOF
code-pact plan brief --from-file brief.yaml --json

# (2) Read YAML from stdin (e.g. piped from another tool).
echo "what: ...
who: ...
differentiator: ..." | code-pact plan brief --stdin --json

# (3) Pass the three fields as flags.
code-pact plan brief \
  --what "A control plane for AI coding agents." \
  --who  "Software teams adopting agentic workflows." \
  --differentiator "Vendor-neutral, deterministic CLI." \
  --json

# --- plan constitution ---
# Mirror shape, but both schema fields are optional (empty falls back
# to locale defaults via generateConstitutionMd — same as the wizard).

cat > constitution.yaml <<EOF
description: A control plane for AI coding agents.
principles:
  - Vendor neutrality
  - Determinism over plausibility
  - Boundaries over conventions
EOF
code-pact plan constitution --from-file constitution.yaml --json

# Or via stdin, or via flags:
code-pact plan constitution \
  --description "..." \
  --principle "First principle" \
  --principle "Second principle" \
  --json
```

Passing any combination of the three modes returns `CONFIG_ERROR` (exit 2). `--from-file` failures emit `data: { detail, path }`; `--stdin` failures emit `data: { detail, source: "stdin" }`. See [`docs/cli-contract.md` § `plan brief`](../cli-contract.md) and `§ plan constitution` for the full envelope shapes.

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

# Add a task interactively (wizard):
code-pact task add <phase-id>

# Add a task non-interactively (v1.4+; flag-driven path).
# Presence of `--description` triggers the non-interactive mode;
# `--type` is required. Wizard is bypassed entirely (no TTY needed).
code-pact task add <phase-id> \
  --description "..." \
  --type feature \
  --ambiguity medium \
  --risk low \
  --depends-on <upstream-task-id> \
  --read "src/foo/**" \
  --write "src/foo/bar.ts" \
  --json

# Newly added tasks always start as `status: planned`. Historical or
# already-done tasks must use `phase import` — `--status` is
# intentionally NOT exposed in `task add`. Passing a non-interactive
# flag (e.g. `--type`) without `--description` raises CONFIG_ERROR
# rather than silently entering the wizard or silently ignoring the
# flag.
```

### Tutorial bootstrap (v1.4+)

If you just want to *watch* the per-task loop run without writing anything to a project, use the `code-pact tutorial` command (v1.15+) — it runs the whole loop in a throwaway sandbox and deletes it:

```sh
code-pact tutorial          # narrated; nothing written to your repo
code-pact tutorial --json   # machine-readable step transcript
code-pact tutorial --keep   # leave the sandbox on disk to inspect
```

If instead you want a real, editable sample phase scaffolded into a project, the `--sample-phase` flag on `init` creates the TUTORIAL phase + tutorial tasks in one shot:

```sh
code-pact init --non-interactive --agent claude-code --locale en-US --sample-phase
# → design/roadmap.yaml + design/phases/TUTORIAL-walkthrough.yaml
# → TUTORIAL-T1 (no deps) and TUTORIAL-T2 (depends_on: [TUTORIAL-T1])
# → ready for the per-task loop
```

> The interactive `init` wizard no longer prompts to create the sample phase (removed in v1.15) — pass `--sample-phase` explicitly.

See [`docs/concepts/sample-phase.md`](../concepts/sample-phase.md) for the keep / rename / delete decision.

### Ingesting an existing Spec Kit `tasks.md` (v1.8+)

If you already have a `tasks.md` from Spec Kit (or any compatible tool that emits the Heading 3 + `- [ ]` checkbox subset), `spec import` bootstraps a draft phase YAML without re-typing the tasks:

```sh
# 1. Dry-run first — prints the generated YAML to stdout
code-pact spec import --from path/to/tasks.md --phase-id P-imported --json

# 2. Persist
code-pact spec import --from path/to/tasks.md --phase-id P-imported --write

# 3. Edit design/phases/P-imported-imported.yaml to fill in
#    reads / writes / acceptance_refs (the importer writes minimal defaults).

# 4. Explicit P14-governed follow-up: add the phase to design/roadmap.yaml
#    (hand-edit; spec import deliberately does NOT touch roadmap.yaml).

# 5. Validate before starting the per-task loop
code-pact plan lint --include-quality --json
code-pact validate --json
```

For Spec Kit `spec.md` / `plan.md`, the read-only suggestion mode emits brief / constitution candidates that you can pipe into the v1.6 P17 non-interactive paths:

```sh
code-pact spec import --suggest-from spec.md --json \
  | jq '.data.brief_candidates' > /tmp/brief.yaml
code-pact plan brief --from-file /tmp/brief.yaml --json
```

See [`docs/spec-kit-bridge.md`](../spec-kit-bridge.md) for the full walkthrough including the supported Markdown subset, the mutex constraints, and the explicit non-goals.

## Model-aware adapter (v0.5.0)

Pin a Claude model version so the adapter generates effort and extended-thinking guidance
tailored to that model:

```sh
# Generate CLAUDE.md with Opus 4.7–specific guidance:
code-pact adapter install claude-code --model opus-4.7

# Re-run skills only (skill files regenerated, CLAUDE.md left untouched):
code-pact adapter install claude-code --regen-skills
```

Supported values: `opus-4.7`, `opus-4.6`, `sonnet-4.6`. The `model_version` field in
`.code-pact/agent-profiles/claude-code.yaml` is used as the default when `--model` is
not passed on the CLI.

After adapter generation, `.claude/skills/` is populated with:
- Fixed skills: `/context`, `/verify`, `/progress`
- Dynamic skills derived from `verification.commands` in all roadmap phases
  (e.g. `pnpm test` → `/test`, `pnpm typecheck` → `/typecheck`)

## Upgrading an adapter safely (v0.9)

When you bump code-pact, edit the roadmap, or change the agent profile, the adapter
files on disk may drift from what the generator now produces. v0.9's `adapter upgrade`
subcommand has a check/apply split so you never apply destructive changes without
seeing them first.

```sh
# 1. Inspect drift without touching anything.
code-pact adapter upgrade claude-code --check --json
# exit 0: clean. exit 1: drift detected (read the plan[] to see each action).

# 2. Apply non-destructive updates.
code-pact adapter upgrade claude-code --write
# Safe to run anytime — managed files you HAVEN'T edited get refreshed,
# locally-edited managed files are refused and reported in plan[].

# 3. If --write reported `refuse` actions you've decided to overwrite anyway:
code-pact adapter upgrade claude-code --write --accept-modified
# Only this flag overwrites locally-modified managed files.
```

`--force` in v0.9 is **unmanaged-adoption only**. It will NOT override
`managed-modified` files. Destructive overwrite is gated behind `--accept-modified`
specifically so a stray `--force` in a CI script can't blow away local edits.

### Action enum

`adapter upgrade --check` and `--write` return a `plan[]` array where each entry
carries an `action` field. The eight values map to (`local × desired` state):

| Action | Meaning |
|---|---|
| `write` | New file or recreated managed-missing file |
| `skip` | Idempotent no-op (managed-clean × current) |
| `adopt` | Existing on-disk file matches desired — recorded in manifest, no write |
| `replace_unmanaged` | Overwrites an unmanaged stale file with `--force` |
| `update` | Overwrites a managed file. Safe for managed-clean × stale (no `--accept-modified` needed) |
| `update_manifest` | Manifest hash refresh only — disk content already matches desired |
| `refuse` | Would destroy local modifications without `--accept-modified` |
| `warn` | `--check`-only: unmanaged file flagged for adoption review |

### Detect issues with `adapter doctor`

`adapter doctor` is the read-only manifest-aware health check. Run it any time you
suspect drift you can't quite see:

```sh
code-pact adapter doctor --json
# Reports ADAPTER_FILE_MISSING / FILE_DRIFT / DESIRED_STALE / UNMANAGED_FILE /
# GENERATOR_STALE / SCHEMA_DRIFT / PROFILE_DRIFT / MANIFEST_INVALID / MANIFEST_MISSING.
```

Global `code-pact doctor` becomes manifest-aware when a manifest exists: it picks up
the same findings with an `[agent-name]` prefix on the message. With no manifest yet,
it falls back to the legacy `ADAPTER_MISSING` warning — byte-identical to v0.8 so
existing CI doesn't start flagging surprise errors after the v0.9 upgrade.

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

### Release prep uses strict-clean dogfood checks (v1.5.1+ guidance)

`plan lint --strict` promotes every warning to exit-relevant — including `TASK_WRITES_PROTECTED_PATH` advisories. As of v1.5.1, this repo's dogfood corpus is expected to be strict-clean; completed historical meta-design tasks do not keep protected design YAML writes declared solely to prove the advisory exists.

The recommended release-prep posture:

```sh
code-pact plan lint --include-quality --strict --json
code-pact plan analyze --strict --json
code-pact validate --json
code-pact doctor --json
```

Selective per-code promotion ("strict on everything EXCEPT `TASK_WRITES_PROTECTED_PATH`") is **not** supported in v1.5+; it remains a P15+ candidate. Until then, the binary `--strict` flag is your only lever.

### Tracking release prep with `phase runbook --across-phases` (v1.9+)

When a release ships work from several in_progress phases (typical for a roadmap with cross-phase `depends_on` references), the aggregated runbook surfaces every phase still in scope in one shot:

```sh
code-pact phase runbook --across-phases --json
```

The `phases_considered` array is the machine-readable answer to "what's left before vX.Y.Z can ship?". Each entry in `phases[]` is exactly the same shape as a single-phase `phase runbook <id>` envelope — same `phase_summary`, same `next_steps`. Default `phase runbook <id>` invocation is unchanged.

If you use cross-phase `depends_on` (e.g. `P19-T4` depends on `P15-T5`), the aggregator transitively pulls in the declaring phase so its runbook is visible even if its `phase.status` is still `planned`. Cycles (length ≥ 2) surface as `TASK_DEPENDS_ON_CYCLE` (error) when you run `plan lint`; self-cycles stay on the narrower `TASK_DEPENDS_ON_SELF_REFERENCE`.

## `task complete` vs `design/` (v1.0 contract)

`task complete` records an operational fact: this task's verify command passed at this point in time. It writes a `done` event to `.code-pact/state/progress.yaml`. It **does not** modify the task's `status` field in `design/phases/<phase>.yaml`.

This separation is intentional:

- `design/` is the source of truth for **intent** — what the human/agent decided this task should be.
- `.code-pact/state/progress.yaml` is the operational log of **what actually happened** — when it started, blocked, resumed, completed.

When the two diverge, `plan analyze` surfaces a `STATUS_DRIFT` warning so it's visible:

- `done-but-design-not-done` — `task complete` ran, but `design.status` is still `planned` or `in_progress`. Agents and humans should update the design YAML when they truly mean the task is done.
- `done-historical` — `design.status: done` but no progress events exist. Hidden by default (`affects_exit: false`) so legacy projects don't fail CI. Surface them with `plan analyze --include-historical`.

In practice: the v0.6–v1.1 release-prep PRs flipped the phase YAML `status` fields manually as part of the release-prep commit (see `chore(design): mark P8-T1 as done` and similar). v1.2 keeps the v1.0 contract — `task complete` still records progress only and never mutates design YAML — but adds `task finalize <task-id>` and `phase reconcile <phase-id>` as Stable (v1.2+) commands that flip the design YAML's `status` field explicitly, with default dry-run and `--write` opt-in. v1.3 adds `task runbook <task-id>` and `phase runbook <phase-id>` as Stable (v1.3+) read-only guidance commands that return the recommended next steps (including `task finalize` / `phase reconcile` invocations when drift is present) without executing anything. See [`docs/concepts/finalization-reconciliation.md`](../concepts/finalization-reconciliation.md) and [`docs/concepts/runbook.md`](../concepts/runbook.md) for the walkthroughs.
