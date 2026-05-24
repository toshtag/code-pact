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
# 0. Start every task here. task prepare is the single per-task entry
#    point — one call returns the current state, the execution
#    recommendation (model tier, effort, planning posture, budget), the
#    context pack metadata, a structured next_action, and a `commands`
#    dictionary with the exact next commands to run. v1.11+.
code-pact task prepare <task-id> --agent claude-code --json

# 1. (Diagnostic) Fetch the context pack directly only if you need it
#    outside task prepare — output goes to stdout, no files written.
#    `recommend` is likewise available standalone (see "Reading
#    recommend --json" below); task prepare runs both for you.
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
#    a `done` event in progress.yaml — `task finalize` is the design-
#    layer counterpart to `task complete`.
code-pact task finalize <task-id> --write

# (v1.6+) Optional: read-only audit of declared `writes` vs the actual
# working tree. JSON-only; advisory; never changes the exit code.
# Pass --base-ref <ref> to widen the audit to a branch-level diff.
code-pact task finalize <task-id> --json | jq .data.write_audit
code-pact task finalize <task-id> --json --base-ref main \
  | jq '.data.write_audit | {outside_declared, declared_unused, warnings}'

# Or, when reconciling many completed tasks at once (e.g. during
# release prep), use the bulk version:
code-pact phase reconcile <phase-id> --write

# 7. (v1.3+) At any point in the loop, ask the CLI for read-only
#    sequencing guidance. Runbook never executes anything — it just
#    returns the recommended next steps as command strings.
code-pact task runbook <task-id> --json     # per-task next steps
code-pact phase runbook <phase-id> --json   # per-phase priority list + histograms
```

`task context` / `task complete` / `task start` / `task block` / `task resume`
all resolve the task id across every phase in `design/roadmap.yaml`, so you
do not need to pass a phase id. `task finalize` and `phase reconcile` (v1.2+)
also resolve task / phase ids from the roadmap. `task runbook` and
`phase runbook` (v1.3+) likewise resolve from the roadmap and take no
`--agent` flag — runbook is agent-independent sequencing guidance.

A task that is currently `blocked` cannot be completed directly — `task complete`
returns `INVALID_TASK_TRANSITION`. Resume it first so the `resumed` event
records the decision that unblocked the task.

### Reading `recommend --json` (v0.8)

The fields most worth wiring into agent behavior:

- `tier` / `effort` / `modelId` — choose which model to invoke and how hard to think.
- `contextProfile` (`small` / `medium` / `large`) — how much surrounding context to pull. `large` includes `design/constitution.md` and decision files.
- `planningRequired` (boolean) — if `true`, plan the implementation before writing code. Combined with `ambiguityAction`, this tells you whether the next step is "go" or "go ask the human."
- `ambiguityAction` (`proceed` / `clarify_before_implementation` / `split_recommended`) — `clarify_before_implementation` means stop and ask; `split_recommended` means the task is too wide for one shot, break it up first.
- `preflight[]` — ordered list of `code-pact` commands to run before implementation. Each entry has `argv` ready to pass to the CLI and a `reason` explaining why it was emitted. `required: false` everywhere in v0.8 — advisory, not mandatory.
- `budgetProfile` — categorical hints (not token counts) for how many tool calls, context files, and verification commands to expect.

The contract is strictly additive — earlier consumers that only read `tier` / `effort` / `modelId` / `reasons` continue to work unchanged.

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

### Non-interactive `plan brief` / `plan constitution` (v1.6+, P17)

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

Passing any combination of the three modes returns `CONFIG_ERROR` (exit 2). `--from-file` failures emit `data: { detail, path }`; `--stdin` failures emit `data: { detail, source: "stdin" }`. See [`docs/cli-contract.md` § `plan brief`](cli-contract.md) and `§ plan constitution` for the full envelope shapes.

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
# → ready for the per-task loop above
```

> The interactive `init` wizard no longer prompts to create the sample phase (removed in v1.15) — pass `--sample-phase` explicitly.

See [`docs/concepts/sample-phase.md`](concepts/sample-phase.md) for the keep / rename / delete decision.

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

See [`docs/spec-kit-bridge.md`](spec-kit-bridge.md) for the full walkthrough including the supported Markdown subset, the mutex constraints, and the explicit non-goals.

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

In practice: the v0.6–v1.1 release-prep PRs flipped the phase YAML `status` fields manually as part of the release-prep commit (see `chore(design): mark P8-T1 as done` and similar). v1.2 keeps the v1.0 contract — `task complete` still records progress only and never mutates design YAML — but adds `task finalize <task-id>` and `phase reconcile <phase-id>` as Stable (v1.2+) commands that flip the design YAML's `status` field explicitly, with default dry-run and `--write` opt-in. v1.3 adds `task runbook <task-id>` and `phase runbook <phase-id>` as Stable (v1.3+) read-only guidance commands that return the recommended next steps (including `task finalize` / `phase reconcile` invocations when drift is present) without executing anything. See [`docs/concepts/finalization-reconciliation.md`](concepts/finalization-reconciliation.md) and [`docs/concepts/runbook.md`](concepts/runbook.md) for the walkthroughs.

## Troubleshooting (v1.0 / v1.2+ / v1.3+ / v1.5+)

When a command surfaces one of the diagnostic codes below, this section maps it to the typical recovery action. The full per-code reference is in [`docs/cli-contract.md` § Error codes](cli-contract.md#error-codes).

### `MANIFEST_NOT_FOUND` from `adapter upgrade --check` / `--write`

You haven't run `adapter install <agent>` yet, or the per-agent manifest at `.code-pact/adapters/<agent>.manifest.yaml` was deleted.

```sh
code-pact adapter install <agent>
# then re-run the upgrade.
```

Distinct from the `ADAPTER_MANIFEST_MISSING` *warning* surfaced by `adapter doctor` for the same root cause — `adapter doctor` is read-only and never fails on a missing manifest; the upgrade commands need a manifest to do their job.

### `INVALID_TASK_TRANSITION` from `task start` / `block` / `resume` / `complete`

The current state derived from `progress.yaml` doesn't allow the requested transition. The most common case is `task complete` against a `blocked` task — the task must be `resume`d first so the `resumed` event records the unblock decision.

```sh
code-pact task status <task-id> --json
# Read data.current; see docs/cli-contract.md § task * for the
# allowed-transitions table.

code-pact task resume <task-id>   # if currently blocked
code-pact task complete <task-id>
```

### `PLAN_NORMALIZE_REQUIRED` from `plan normalize --check`

A file under `design/` or `.code-pact/state/progress.yaml` has trailing whitespace, CRLF line endings, or a missing/extra final newline.

```sh
code-pact plan normalize --write
# Idempotent. Comments and Markdown hard line breaks are preserved.
```

`plan normalize --write` is the apply-mode counterpart to `--check`. Passing both at once is a `PLAN_NORMALIZE_CONFLICT` (exit 2) so the intent is unambiguous in CI scripts.

### `VERIFICATION_FAILED` from `task complete` (or standalone `verify`)

The phase's `verify.commands` did not pass.

```sh
code-pact verify --phase <phase-id> --task <task-id>
# Runs the same commands stand-alone so you can read the failure
# output directly. progress.yaml is NOT mutated when verify fails;
# you can re-run task complete after fixing the underlying issue.
```

If the verify command itself is wrong (typo, dependency missing) rather than the task's implementation, edit `design/phases/<phase>.yaml` `verification.commands` and re-run.

### `TASK_FINALIZE_NOT_ELIGIBLE` from `task finalize` (v1.2+)

The task's derived state from `progress.yaml` is not `done`, so flipping its design YAML status would create a worse drift (design says done, progress says otherwise). The check fires in **both** dry-run and `--write` — dry-run means "won't write", not "won't validate".

```sh
code-pact task status <task-id> --json
# Read data.current. Common cases:
#   - current: "planned" → you forgot to run `task complete` (or
#     `task start` + implementation + `task complete`).
#   - current: "blocked" → resume first, then complete, then finalize.
#   - current: "started" / "resumed" → still in progress; complete
#     the task first.
#   - current: "failed" → the verify failed at task complete; fix
#     the underlying issue, complete again, then finalize.

# v1.3+ alternative: `task runbook` returns the same diagnosis plus
# the recommended next step inline (no manual state interpretation).
code-pact task runbook <task-id> --json
# Read data.state_summary + data.next_steps[0].command.
```

`task finalize` deliberately refuses ineligible cases instead of guessing. Every legitimate path through the state machine ends in a `done` event, which is the precondition for finalization.

### `TASK_FINALIZE_WRITE_REFUSED` from `task finalize --write` (v1.2+)

The phase YAML write was refused by the safety classifier. `data.reason` is one of:

| Reason | Cause | Recovery |
|---|---|---|
| `unsafe_path` | The resolved path failed `assertSafeRelativePath` (traversal, absolute) | Should not happen from normal CLI use; report a bug |
| `outside_design_phases` | The phase file resolves outside `design/phases/` | Same — should not happen via the roadmap-driven resolver |
| `not_yaml` | The phase file does not end in `.yaml` | Rename the phase file to `.yaml` |
| `symlink_escape` | `resolveWithinProject` detected a symlink leaving the project root | Replace the symlink with the actual file inside the project |
| `unreadable` | The phase file could not be read (permissions, missing) | `ls -l design/phases/` and fix file permissions or restore the file |
| `unparseable_phase` | The phase file's YAML failed schema parse | Run `code-pact plan lint --json` — the underlying parse error is reported there |
| `task_not_found` | The task id is not in the phase's `tasks[]` array | The task id and phase do not match; verify the task id against `code-pact phase show <phase-id> --json` |

`task finalize --write` will not partially-modify a phase file. If the safety check fails, no write occurs.

### `PHASE_RECONCILE_WRITE_REFUSED` from `phase reconcile --write` (v1.2+)

Every eligible task write was refused for safety reasons. Partial successes (one or more applied + one or more refused) return exit 0 — this code only fires when the whole batch failed. `data.skipped_writes[]` carries per-task refusal detail in the same `reason` enum as `TASK_FINALIZE_WRITE_REFUSED` above.

```sh
code-pact phase reconcile <phase-id> --json
# Re-run in dry-run mode to inspect the per-task verdicts. Fix the
# underlying cause (unparseable phase file is the most common) and
# re-run with --write.

# v1.3+ alternative: `phase runbook` returns the same per-task verdicts
# plus the recommended next steps (blocked / manual_review / reconcile
# batch / primary loop / phase-status advisory).
code-pact phase runbook <phase-id> --json
```

If `data.tasks[]` shows every flip candidate has the same refusal reason, the issue is the phase file itself, not individual tasks — fix it once and reconcile will proceed for all of them.

### `LOCK_HELD` from a design-mutating command (v1.5+)

Another `code-pact` mutation is in progress on the same project. The advisory write lock (`.code-pact/locks/write.lock`) is held by the process whose details appear in the envelope:

```json
{
  "ok": false,
  "error": { "code": "LOCK_HELD", "message": "Another code-pact mutation is in progress: phase reconcile P14 --write (pid: 12345, host: laptop.local, started: 2026-05-21T10:15:00.000Z). ..." },
  "data": {
    "lock_holder": { "pid": 12345, "hostname": "laptop.local", "cmd": "phase reconcile P14 --write", "created_at": "2026-05-21T10:15:00.000Z" },
    "lock_path": "/path/to/.code-pact/locks/write.lock"
  }
}
```

**Normal case — another command is running.** Wait for the holder to release (the lock is created/released within a single CLI invocation) and re-run. The lock is transient by design; LOCK_HELD belongs in the retry-on-transient list for any orchestration that runs multiple `code-pact` commands in parallel.

**Stale-lock case — the holder is gone.** A prior `code-pact` process crashed (SIGKILL, OOM, OS reboot) without releasing the lock. v1.5 does NOT auto-detect this; recovery is manual and intentionally conservative:

1. Verify no `code-pact` process is running (check `ps` / `pgrep` for the `pid` in `data.lock_holder.pid`; on a different host, check `data.lock_holder.hostname` matches yours).
2. **Only when certain no process holds it**, delete the lock file: `rm .code-pact/locks/write.lock`.
3. Re-run the command.

Do not blindly delete the lock file just because LOCK_HELD fired — if a concurrent mutation IS in progress, deleting the lock undermines the guarantee. The conservative manual-recovery default in v1.5 deliberately favours wait-and-retry over automation, because automated stale detection is subtle (two processes can both decide the other is stale and clobber a real lock).

Read-only commands (`plan lint`, `plan analyze`, `task runbook`, `phase runbook`, `validate`, `doctor`, `recommend`, `task context`, `task status`) do NOT acquire the lock and can be used to observe project state while a mutation is pending.

See [`docs/concepts/governance.md`](concepts/governance.md) for the v1.5 governance walkthrough and [`docs/cli-contract.md` § Advisory write lock](cli-contract.md#advisory-write-lock-v15--p14) for the full acquisition-point matrix.

### `CONFIG_ERROR` from `phase add --id TUTORIAL` / `phase import` containing `TUTORIAL` (v1.5+)

The id `TUTORIAL` is reserved at the governance layer for the sample-phase artifact created by `code-pact init --sample-phase`. The block fires at creation time on every path except the sanctioned bootstrap.

```sh
# Rejected: phase add cannot create a TUTORIAL phase.
code-pact phase add --id TUTORIAL --name ... --weight 1 --objective ...
# → CONFIG_ERROR (exit 2). Roadmap is byte-identical (no write).

# Rejected: phase import containing a TUTORIAL entry (anywhere in the
# file) is preflighted before any createPhase call, so the whole
# import is rejected with the roadmap untouched.
code-pact phase import path/to/import.yaml
# → CONFIG_ERROR (exit 2) if any phase entry has id: TUTORIAL.

# Sanctioned: init --sample-phase is the only allowed creation path.
code-pact init --sample-phase
# → creates design/phases/TUTORIAL-walkthrough.yaml + the roadmap entry.
```

If you genuinely want a phase named `TUTORIAL` for a non-tutorial purpose, **pick a different id**. The block uses the existing `CONFIG_ERROR` envelope — no new error code ships for this. The error message names the reserved id and points back at `init --sample-phase` as the sanctioned path. Existing v1.4.x projects with a TUTORIAL phase are untouched; the block only fires on new creation. See [`docs/concepts/sample-phase.md`](concepts/sample-phase.md#tutorial-is-a-reserved-phase-id-v15--p14) for the user-facing rules.

### `ADAPTER_GENERATOR_STALE` from `adapter doctor` / global `doctor`

Your adapter manifest's `generator_version` field doesn't match the installed code-pact version. This is the expected state after upgrading the CLI (`0.9.0-alpha.0` → `1.0.0` is the v1.0 case).

```sh
code-pact adapter upgrade <agent> --check --json
# Read plan[] — managed-clean files appear as action:update,
# managed-modified files as action:refuse.

code-pact adapter upgrade <agent> --write
# Safe for managed-clean. Refuses managed-modified unless you also
# pass --accept-modified (the only flag that overwrites local edits).
```

See [`docs/migration.md`](migration.md) for the full upgrade path between alpha releases.

### Expected warnings after a non-interactive bootstrap

If you ran `code-pact init --non-interactive --agent <agent> --locale <locale>` from CI or a script, the project skips the brief / constitution wizards and does not pin a model version. `code-pact validate --json` then reports three warnings as expected state:

| Code | Severity | Why it fires |
|---|---|---|
| `BRIEF_MISSING` | warning | `design/brief.md` does not exist — the non-interactive init does not run `plan brief`. **v1.6+**: resolve from CI with `code-pact plan brief --from-file <yaml>`, `--stdin`, or `--what "..." --who "..." [--differentiator "..."]` (see § [Non-interactive `plan brief` / `plan constitution`](#non-interactive-plan-brief--plan-constitution-v16-p17)). Pre-v1.6: edit it manually, or run `code-pact plan brief` in a TTY. |
| `CONSTITUTION_PLACEHOLDER` | warning | `design/constitution.md` still contains the template text from `init`. **v1.6+**: resolve from CI with `code-pact plan constitution --from-file <yaml>`, `--stdin`, or `--description "..." --principle "..."` (repeatable). Pre-v1.6: edit it manually, or run `code-pact plan constitution` in a TTY. |
| `ADAPTER_STALE` | warning | `adapter install <agent>` was called without `--model <version>`, so the model profile is not pinned. Re-run `adapter install <agent> --model <version>` (e.g. `--model opus-4.7`) to silence. |

These are intentionally warnings, not errors — `validate` still exits 0. CI scripts that require a clean run can either fix the underlying state (recommended for `BRIEF_MISSING` / `CONSTITUTION_PLACEHOLDER`) or pass `--strict` only after deciding to treat them as failures.

A separate `STATUS_DRIFT done-but-design-not-done` warning from `plan analyze --json` is also expected after any `task complete` until the design YAML's `status` field is flipped to `done`. `task complete` records progress, but does not mutate design intent. v1.2+ mechanizes the flip via `code-pact task finalize <task-id> --write` (single task) or `code-pact phase reconcile <phase-id> --write` (whole phase); the warning's `details.remediation` field carries the exact command. v1.3+ also exposes the same recommendation via `code-pact task runbook <task-id> --json` (single task) or `code-pact phase runbook <phase-id> --json` (whole phase) — runbook is read-only and never executes anything. See [`task complete` vs `design/` (v1.0 contract)](#task-complete-vs-design-v10-contract) above, [`docs/concepts/finalization-reconciliation.md`](concepts/finalization-reconciliation.md) for the v1.2+ walkthrough, and [`docs/concepts/runbook.md`](concepts/runbook.md) for the v1.3+ walkthrough.

## Quick reference

| Goal | Command |
|---|---|
| Write project brief (TTY wizard) | `code-pact plan brief` |
| Write project brief (CI / non-TTY, v1.6+) | `code-pact plan brief --from-file <yaml>` \| `--stdin` \| `--what "..." --who "..." [--differentiator "..."]` |
| Write project constitution (TTY wizard) | `code-pact plan constitution` |
| Write project constitution (CI / non-TTY, v1.6+) | `code-pact plan constitution --from-file <yaml>` \| `--stdin` \| `--description "..." --principle "..."` (repeatable) |
| Generate AI planning prompt | `code-pact plan prompt [--clipboard]` |
| Bulk-import AI-generated roadmap | `code-pact phase import <yaml> [--strict]` |
| Get the execution plan for a task (tier / planning / preflight / budget) | `code-pact recommend --phase <phase-id> --task <task-id> [--json]` |
| Fetch context for a task (as agent) | `code-pact task context <task-id> --agent <agent>` |
| Mark a task started (as agent) | `code-pact task start <task-id> --agent <agent>` |
| Block a task with a recorded reason | `code-pact task block <task-id> --reason "<text>"` |
| Resume a blocked task | `code-pact task resume <task-id> --agent <agent>` |
| Inspect a task's current state + history | `code-pact task status <task-id> --json` |
| Mark a task done (as agent) | `code-pact task complete <task-id> --agent <agent>` |
| Add a phase interactively | `code-pact phase add` |
| Add a task interactively | `code-pact task add <phase-id>` |
| List registered adapters + manifest state | `code-pact adapter list [--json]` |
| Install adapter (first-time) | `code-pact adapter install <agent> [--model <ver>] [--force]` |
| Check adapter drift (read-only) | `code-pact adapter upgrade <agent> --check [--json]` |
| Apply adapter updates (safe, non-destructive) | `code-pact adapter upgrade <agent> --write` |
| Apply adapter updates, overwriting local edits | `code-pact adapter upgrade <agent> --write --accept-modified` |
| Adapter-scoped health check | `code-pact adapter doctor [--agent <name>] [--json]` |
| Regenerate skills only | `code-pact adapter install <agent> --regen-skills` |
| Show weighted progress | `code-pact progress` |
| Health-check the project | `code-pact doctor` |
| CI validation | `code-pact validate` |
| Static integrity of plan files | `code-pact plan lint [--strict] [--include-quality]` |
| Whitespace / newline normalization (dry-run) | `code-pact plan normalize --check` |
| Whitespace / newline normalization (apply) | `code-pact plan normalize --write` |
| Cross-artifact drift (design vs progress) | `code-pact plan analyze [--strict] [--include-historical]` |
