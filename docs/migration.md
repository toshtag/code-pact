# Migration guide: v0.6 / v0.7 / v0.8 / v0.9 → v1.0

`code-pact` v1.0.0 freezes the public CLI contract. There are **no breaking changes** to the surfaces classified `Stable (v1.0)` in [`docs/cli-contract.md`](cli-contract.md). Projects that worked on any prior alpha (v0.6, v0.7, v0.8, v0.9) continue to work without code changes.

This document explains what each prior release shipped, what — if anything — you need to do, and what diagnostic codes you may see during the first run on v1.0.

## Quick path: from any v0.9.x release

```sh
# 1. Upgrade the CLI.
npm install -g code-pact   # or @latest, see README "Status"

# 2. Refresh the adapter manifest you committed at v0.9.
code-pact adapter upgrade claude-code --check --json
# Expected: ADAPTER_GENERATOR_STALE warning (manifest's generator_version
# is "0.9.0-alpha.0", current is "1.0.0").

# 3. Apply the refresh. Safe for managed-clean files; refuses
#    managed-modified ones unless you also pass --accept-modified.
code-pact adapter upgrade claude-code --write

# 4. Confirm clean.
code-pact adapter doctor --json
code-pact doctor --json
code-pact validate
```

No CLI flags or JSON envelope shapes changed between v0.9 and v1.0. The only on-disk delta is the bumped `generator_version` field inside `.code-pact/adapters/<agent>.manifest.yaml`.

## What stays the same in v1.0

- **Every Stable (v1.0) command** in `docs/cli-contract.md` keeps the same flags, exit codes, JSON envelope shape, and human-mode output. Field additions are additive only.
- **Every existing error code** keeps its name and `error.code` value. The full surface is locked by `tests/unit/error-code-surface.test.ts`.
- **`.code-pact/state/progress.yaml`** is forward-compatible. Logs written by v0.6–v0.9 parse and resolve correctly under v1.0's `task status` / `task complete` state machine.
- **Bare-form `code-pact adapter [--agent X]`** still works (with a one-line stderr deprecation notice). Removal is targeted for v1.1, not v1.0.
- **Atomic write strategy** (temp file + rename, no fsync, single-process owner) is documented in [`docs/cli-contract.md` § State file write guarantees](cli-contract.md#state-file-write-guarantees).

## What's actually new in v1.0

- Stability taxonomy in `docs/cli-contract.md` (`Stable (v1.0)`, `Stable (human-output)`, `Experimental`, `Deprecated`).
- Four-category public error-code tables in `docs/cli-contract.md`, anchored by `tests/unit/error-code-surface.test.ts`.
- End-to-end workflow smoke test (`tests/integration/e2e-workflow.test.ts`).
- JSON-stdout regression net (`tests/integration/json-stdout.test.ts`).
- Migration safety test for v0.6 / v0.8 / v0.9 shapes (`tests/integration/migration.test.ts`).
- This document.

No new commands. No new flags on existing commands. The `init.ts` write path was unified onto the shared `atomicWriteText` helper (internal refactor, behaviour unchanged).

## A v1.0 contract worth knowing about

### `task complete` records progress, but does NOT mutate design YAML

This has been the behaviour since v0.6 and is locked for v1.0:

- `code-pact task complete <task-id>` runs the phase's `verify.commands`, and on pass appends a `done` event to `.code-pact/state/progress.yaml`.
- It does **NOT** change the task's `status` field in `design/phases/<phase>.yaml`.

`design/` is the source of truth for plan intent; `progress.yaml` is the operational log of what actually happened. These are intentionally separate.

When they diverge — task has a `done` event but design still says `status: planned` — `code-pact plan analyze` surfaces a `STATUS_DRIFT` warning with `details.kind: "done-but-design-not-done"`. The agent or release-prep flow should intentionally update the design YAML when a task is truly complete (see the existing P7-T1 → P7-done patterns in `design/phases/P7-adapter-platform.yaml` for examples).

## Path-by-path migration

### v0.6 → v1.0

v0.6 introduced the task state machine (`task start` / `block` / `resume` / `complete`). Projects from this era may have:

- Tasks with `status: done` in design YAML but **no progress events** (set by hand-editing before v0.6).
- No adapter manifest under `.code-pact/adapters/`.

**Action**: none required for the core workflow. After upgrade:

```sh
code-pact doctor --json          # Expect: ADAPTER_MISSING (warning), no errors.
code-pact validate               # Expect: exit 0.
code-pact plan analyze --json    # Expect: no visible issues. Historical done
                                 # tasks are hidden_by_default via the
                                 # done-historical kind.
code-pact plan analyze --include-historical --json
                                 # Surfaces the historical tasks so you can see
                                 # what's being suppressed.
```

When you're ready to take adapters out of legacy mode:

```sh
code-pact adapter install claude-code --json
# After this, doctor switches to manifest-aware checks. ADAPTER_MISSING
# stops firing.
```

### v0.7 → v1.0

v0.7 added `plan lint` / `plan normalize` / `plan analyze`. There is no on-disk state owned by v0.7 — it was checks only. Migration is identical to the v0.6 path above.

If your CI ran `plan analyze` with `--strict`, that still works. If you want to suppress historical done-tasks from blocking CI under `--strict`, the v0.7 `--include-historical` flag is intentionally orthogonal — it shows the issues but does not affect exit code (hidden issues have `affects_exit: false`).

### v0.8 → v1.0

v0.8 extended `recommend` with the planning posture / preflight / budget profile output. The contract is strictly additive — every v0.7 caller still parses v1.0 output unchanged. The new fields (`contextProfile`, `planningRequired`, `ambiguityAction`, `allowedEscalation`, `preflight`, `budgetProfile`, `structuredReasons`) are documented in `docs/cli-contract.md` § `recommend`.

**Action**: none required. If you were ignoring the new fields, keep ignoring them — they're zod-strict on the schema side but additive on the consumption side.

### v0.9 → v1.0

v0.9 introduced the adapter platform: per-agent manifest, `adapter list / install / doctor / upgrade --check / upgrade --write`, the 8-value action enum, and the `--force` narrowing (force is now unmanaged-adoption only).

After upgrade:

```sh
code-pact adapter doctor --json
# Expect: ADAPTER_GENERATOR_STALE (warning) because every existing
# manifest's generator_version is "0.9.0-alpha.0" while current is
# "1.0.0". Not an error.

code-pact adapter upgrade <agent> --check --json
# Expect: plan[] mostly action:skip, possibly some action:update or
# action:update_manifest if the v1.0 templates diverge from v0.9.

code-pact adapter upgrade <agent> --write
# Safe for managed-clean files. Refuses managed-modified files unless
# you also pass --accept-modified. After this, generator_version is
# refreshed to "1.0.0".
```

If you scripted around the v0.5–v0.8 bare-form `code-pact adapter [--agent X]` interface, that surface still works in v1.0 (with a one-line stderr deprecation notice). The shim is scheduled for removal in v1.1 — migrate scripts to:

```diff
- code-pact adapter --agent claude-code --force
+ code-pact adapter install claude-code
```

`--force` semantics differ between the bare form (v0.8: overwrite everything) and `adapter install --force` (v0.9: unmanaged-adoption only). Destructive overwrite of managed-modified files now requires `adapter upgrade --write --accept-modified`.

## v1.0.x → v1.1.0

v1.1.0 ships the **Task Readiness Schema** — five optional fields on the task type that let a task declare its own context-pack targets, read / write surface, dependencies, and acceptance references. The change is strictly additive: every v1.0.x phase YAML continues to parse and behave identically, and every Stable (v1.0) command keeps the same flags, exit codes, JSON envelope shape, and error code surface.

```sh
# 1. Upgrade the CLI.
npm install -g code-pact   # or @latest

# 2. Refresh the local adapter manifest. The first run after upgrade
#    reports ADAPTER_GENERATOR_STALE (warning) because the manifest's
#    generator_version is "1.0.x" while the installed CLI is "1.1.0".
code-pact adapter upgrade claude-code --write

# 3. Confirm clean.
code-pact adapter doctor --json
code-pact doctor --json
code-pact validate
```

No other action is required. Projects that do not declare any of the new fields see no change in behaviour or output.

### What's new in v1.1.0

Five optional fields are added to the task schema (`src/core/schemas/task.ts`). Each one is `.optional()`, defaults to `undefined`, and is reported through additive `plan lint` codes only when declared.

| Field | Element type | Purpose |
|---|---|---|
| `depends_on` | task id string | Same-phase task ordering. P10 ships same-phase only; cross-phase references are deferred to a future extension. |
| `decision_refs` | repo-root-relative path | Force-surface specific decision files into `task context` regardless of `context_size`. |
| `reads` | repo-root-relative glob | Declared read surface. P10 renders the path list only — file contents are not inlined. |
| `writes` | repo-root-relative glob | Declared write surface. Future P11 `task finalize` will use this to detect writes outside the declaration; future P14 governance will enforce protected paths against it. |
| `acceptance_refs` | repo-root-relative path | Path references to acceptance criteria. P10 renders the path list only; richer rendering is deferred to P11 reconcile. |

The full RFC lives in [`design/decisions/task-readiness-schema-rfc.md`](../design/decisions/task-readiness-schema-rfc.md). For a quick walkthrough of a phase YAML that uses every field end to end, see [`docs/concepts/task-readiness-fields.md`](concepts/task-readiness-fields.md).

### Recommended adoption pattern

- **Declare new fields on new tasks first.** Leave existing tasks alone unless you have a concrete reason to retro-declare. Full backfill is not necessary and is explicitly discouraged.
- **Start with `depends_on` and `decision_refs`.** These produce the most immediately visible effect on `task context` output (a "Depends on" section with derived state from `progress.yaml`, and a "Declared decisions" section that pulls referenced decisions into the pack).
- **Use `reads` / `writes` sparingly until you find them load-bearing.** P10 surfaces them as declarations in the pack but does not enforce them; P11 / P14 are where they start to gate behaviour.
- **Skip `acceptance_refs` until you have a real acceptance criteria layout.** P10 ships path references only; P11 reconcile is the consumer.

### New `plan lint` codes (additive, `plan` category)

Twelve new codes ship in `plan lint` to validate the new fields when declared. A task that declares none of the new fields produces none of these codes. The full list (severity + trigger condition) is in [`docs/cli-contract.md` § Plan diagnostic codes — Task Readiness Schema diagnostics (P10, v1.1+)](cli-contract.md#plan-diagnostic-codes).

Highlights:

- `TASK_DEPENDS_ON_UNRESOLVED` (error), `TASK_DEPENDS_ON_SELF_REFERENCE` (error)
- `TASK_DECISION_REF_NOT_FOUND` (error), `TASK_DECISION_REF_UNSAFE_PATH` (error)
- `TASK_READS_UNSAFE_PATH` (error), `TASK_READS_GLOB_INVALID` (error), `TASK_READS_NO_MATCH` (warning)
- `TASK_WRITES_UNSAFE_PATH` (error), `TASK_WRITES_GLOB_INVALID` (error), `TASK_WRITES_PROTECTED_PATH` (warning in P10; configurable / error in P14)
- `TASK_ACCEPTANCE_REF_NOT_FOUND` (error), `TASK_ACCEPTANCE_REF_UNSAFE_PATH` (error)

The error-code surface is locked by `tests/unit/error-code-surface.test.ts`. Projects running `plan lint --strict` on existing v1.0.x corpora see no new errors unless they start declaring the new fields with invalid values.

### Supported `reads` / `writes` glob subset

Because v1.1.0 keeps the runtime dependency policy from `CONTRIBUTING.md` (only `yaml` and `zod`), the in-repo glob matcher supports only:

- literal path segments (e.g. `src/commands/init.ts`)
- `*` within a single segment (e.g. `src/commands/task-*.ts`)
- `**` as a full path segment only (e.g. `tests/**/integration.ts`)

Brace expansion, extglob, negation, character classes, and backslash escapes are **not** supported. `TASK_READS_GLOB_INVALID` / `TASK_WRITES_GLOB_INVALID` fire when a declared glob steps outside the subset. If real usage shows the subset is too narrow, adopting an external glob library is a separate runtime-dependency RFC.

### `task context` pack output

The pack rendered by `task context` gains five new sections when the corresponding fields are declared, in this order:

1. **Depends on** — each dependency id with its current derived state.
2. **Declared read surface** — each glob plus the set of currently-matched files. A `_(no current matches on disk)_` note appears when the glob matches nothing.
3. **Declared write surface** — declared globs only, no fs lookup.
4. **Declared decisions** — full body of each referenced decision file, surfaced regardless of `context_size`.
5. **Acceptance references** — path list only.

When a task declares none of the new fields, the pack body is byte-identical to v1.0.2 (locked by `tests/integration/pack-byte-identical.test.ts` against a checked-in golden fixture).

## v1.1.x → v1.2.0

### Quick path

```sh
# 1. Upgrade the CLI.
npm install -g code-pact@1.2.0

# 2. No mandatory action. Existing v1.1.x projects continue to work
#    unchanged — `task finalize` and `phase reconcile` are opt-in.
code-pact validate --json   # expect: ok
code-pact plan analyze --json
# Existing STATUS_DRIFT done-but-design-not-done warnings now carry an
# additive `details.remediation` hint. Existing JSON consumers see no
# shape change (details is a Record<string, unknown> payload).
```

### What's new in v1.2.0

Two new commands ship as **Stable (v1.2+)**. Both default to dry-run; `--write` is the explicit opt-in to mutate `design/phases/*.yaml`. Neither command mutates `progress.yaml` (append-only contract preserved), `design/roadmap.yaml` (still manual until P14), or the phase's own `status` field (advisory only via `phase_status_candidate`). Neither command takes `--agent` — they never call an adapter.

- **`task finalize <task-id>`** — flips one task's `status: planned` / `in_progress` → `done` in its phase YAML, but only when `progress.yaml` already shows a `done` event for that task. Ineligible tasks raise `TASK_FINALIZE_NOT_ELIGIBLE` (exit 2) in both dry-run and `--write` — dry-run means "won't write", not "won't validate". JSON envelope kinds: `would_finalize` / `finalized` / `already_finalized`.
- **`phase reconcile <phase-id>`** — bulk version. Walks every task in the phase, classifies each as `flip` / `skip` / `manual_review`, and (with `--write`) applies the flips in one shot. Partial successes (some flips applied, some refused for safety reasons) return exit 0 with `applied_writes[]` + `skipped_writes[]` both populated. `PHASE_RECONCILE_WRITE_REFUSED` (exit 2) fires only when **every** eligible write was refused. JSON envelope kinds: `would_reconcile` / `reconciled` / `no_eligible_tasks`. The `no_eligible_tasks` case is intentionally not an error — nothing to flip is a normal outcome.

The `plan analyze` `STATUS_DRIFT done-but-design-not-done` warning now also carries an additive `details.remediation` field of the form `"code-pact task finalize <task-id>"`. Only this kind carries the hint — the other four kinds need human judgement, not a mechanizable fix.

For the full design rationale, read [`design/decisions/finalization-reconciliation-rfc.md`](../design/decisions/finalization-reconciliation-rfc.md). For the agent- and reviewer-facing walkthrough, read [`docs/concepts/finalization-reconciliation.md`](concepts/finalization-reconciliation.md).

### Recommended adoption pattern

**Stop hand-editing design status in release-prep PRs.** Through v1.1.x, every release-prep PR included a step that hand-edited `design/phases/*.yaml` to flip completed tasks from `status: planned` to `status: done`. v1.2.0 replaces that step with a single command:

```sh
# 1. Bump version + write CHANGELOG.
# 2. Flip completed tasks for the phase being released.
code-pact phase reconcile <phase-id> --write --json
# 3. Hand-edit the phase's own status field if every task is now done
#    (advisory only via `phase_status_candidate`; phase status auto-flip
#    is P14 work).
# 4. Hand-edit design/roadmap.yaml if a phase weight or status moved
#    (still manual until P14).
# 5. Commit + PR.
```

Step 2 is the high-leverage change. The other steps remain manual on purpose: phase status and roadmap entries often depend on non-task work (release prep, docs, manual cleanup) that no deterministic command can verify, and P14 governance is the right home for opt-in policies that would let them be auto-managed.

For single-task finalization (e.g. closing one task mid-phase without affecting siblings), `task finalize <task-id> --write` is the per-task counterpart.

### CI implications under `--strict`

Projects running `plan lint --strict` or `plan analyze --strict` see **no new errors** in v1.2.0. The new fields are additive on existing diagnostic payloads, not new kinds. The `STATUS_DRIFT done-but-design-not-done` warning continues to fire pre-reconcile; once `phase reconcile --write` (or `task finalize --write`) has flipped a task, the warning clears on the next `plan analyze` run.

### New `KNOWN_CODES.public` entries (additive)

Three new public error codes ship in v1.2.0. The error-code surface lock at `tests/unit/error-code-surface.test.ts` is updated accordingly. Existing codes are unchanged.

| Code | Severity | Trigger |
| --- | --- | --- |
| `TASK_FINALIZE_NOT_ELIGIBLE` | error | `task finalize` against a task whose derived state is not `done` (raised in both dry-run and `--write`) |
| `TASK_FINALIZE_WRITE_REFUSED` | error | `task finalize --write` failed the path-safety / phase-parse classification |
| `PHASE_RECONCILE_WRITE_REFUSED` | error | `phase reconcile --write` was unable to apply any of the eligible writes |

### Backward compatibility

- `task complete` is unchanged. Same flags, same JSON envelope, same exit codes, same error codes. The v1.0 contract — `task complete` records progress only and never mutates design YAML — is preserved unchanged.
- `progress.yaml` remains append-only and is read-only for the new commands.
- `task context` pack output is unchanged. The byte-identical pack regression test against the golden fixture passes without modification.
- `tests/integration/json-stdout.test.ts` continues to pass for every Stable (v1.0) and Stable (v1.1) command; the two new commands are added to the test list and pass from day one.
- No existing error code is removed, renamed, or recategorized.

In semver terms, v1.2.0 is a minor release.

## v1.2.x → v1.3.0

### Quick path

```sh
# 1. Upgrade the CLI.
npm install -g code-pact@1.3.0

# 2. No mandatory action. Existing v1.2.x projects continue to work
#    unchanged — `task runbook` and `phase runbook` are opt-in.
code-pact validate --json   # expect: ok
code-pact plan analyze --json
# Every Stable contract from v1.0 / v1.1 / v1.2 is preserved. No
# new error codes, no new schema fields, no new mutation surface.
```

### What's new in v1.3.0

Two new **read-only guidance commands** ship as **Stable (v1.3+)**. Neither command mutates anything; neither calls an adapter; neither takes an `--agent` / `--write` / `--execute` flag. Both return a deterministic list of next recommended steps as command strings the user (or an agent) runs separately.

- **`task runbook <task-id>`** — answers "what should happen next in this task's lifecycle?". Returns the sequence of `task start` / `task context` / implementation / `task complete` / `task finalize` etc., gated by `depends_on` and drift state. JSON envelope is `{ ok: true, data: { kind: "runbook", task_id, phase_id, state_summary, next_steps: RunbookStep[] } }`. Reuses existing error codes (`TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` / `CONFIG_ERROR`).
- **`phase runbook <phase-id>`** — answers "what should happen next across the whole phase?". Returns a 6-priority step list (blocked → manual_review → reconcile batch → in-progress hints → primary loop → phase-status advisory) plus task/drift histograms and a `phase_status_candidate` (advisory only — `phase runbook` continues the v1.2 contract that phase status is never written automatically). Reuses `PHASE_NOT_FOUND` / `CONFIG_ERROR`.

The `RunbookStep` shape is **field-presence-fixed**: every field (`command`, `manual_action`, `reason`, `blocking`, `safety_note`, `expected_result`) is always present in JSON output, with `null` where not applicable. Exactly one of `command` / `manual_action` is non-null. JSON consumers can assume the schema is constant across step kinds.

Internally, v1.3.0 also extracts the reconcile classifier from `src/commands/phase-reconcile.ts` into `src/core/finalize/reconcile-classifier.ts` so both `phase reconcile` and the new runbook builders can import from the same core helper. This is a pure refactor — `tests/unit/commands/phase-reconcile.test.ts` passes unchanged.

For the full design rationale, read [`design/decisions/lightweight-runbook-rfc.md`](../design/decisions/lightweight-runbook-rfc.md). For the agent- and reviewer-facing walkthrough, read [`docs/concepts/runbook.md`](concepts/runbook.md).

### Recommended adoption pattern

**Use `task runbook` after `plan analyze` flags drift.** When `plan analyze` reports a `STATUS_DRIFT done-but-design-not-done` warning, the additive `details.remediation` field (added in v1.2.0 P11-T5) points at the exact `task finalize <id>` command. `task runbook <id>` is the broader counterpart: it surfaces the same recommendation in context, alongside the rest of the task's lifecycle state.

**Use `phase runbook` as a sanity check before release-prep `phase reconcile --write`.** v1.2.0's release-prep dogfood used `phase reconcile P11 --write` directly; v1.3.0 release prep should run `phase runbook P12 --json` first to inspect the histogram and verify the recommended reconcile batch matches expectations.

```sh
# Single-task drift recovery:
code-pact plan analyze --json   # → STATUS_DRIFT remediation hint points at task finalize
code-pact task runbook P9-T5 --json   # → same finalize step + full lifecycle context

# Release-prep adoption (v1.3.0+):
code-pact phase runbook <phase-id> --json   # sanity check; inspect histogram + candidate
code-pact phase reconcile <phase-id> --write   # apply the batch flip
```

### CI implications under `--strict`

Projects running `plan lint --strict` / `plan analyze --strict` / `validate --strict` see **no new errors and no new warnings**. v1.3.0 introduces zero new lint codes, zero new analyze codes, zero new error codes. The `KNOWN_CODES.public` surface lock at `tests/unit/error-code-surface.test.ts` is unchanged from v1.2.0.

### Backward compatibility

- `task complete` / `task finalize` / `phase reconcile` / `task context` / `task start` / `task block` / `task resume` / `task status` / `plan analyze` / `plan lint` / `validate` / `doctor` / `recommend` — **unchanged**. Same flags, same JSON envelope, same exit codes, same error codes.
- `progress.yaml` remains read-only for the new commands. The append-only operational-log contract is preserved.
- `task context` pack output is unchanged. The byte-identical pack regression test against the golden fixture passes without modification.
- `tests/integration/json-stdout.test.ts` continues to pass for every Stable (v1.0 / v1.1 / v1.2) command; the two new runbook commands are added to the test list and pass from day one.
- `KNOWN_CODES.public` is unchanged.
- No new task or phase schema field. v1.2.x phase YAMLs parse and behave identically.
- The reconcile classifier extraction (P12-T2) is a pure refactor of code that has always been an implementation detail of `phase reconcile`; no external consumer was depending on its location. The existing `tests/unit/commands/phase-reconcile.test.ts` regression net continues to pass without modification.

In semver terms, v1.3.0 is a minor release.

## v1.3.x → v1.4.0

### Quick path

```sh
# 1. Upgrade the CLI.
npm install -g code-pact@1.4.0

# 2. No mandatory action. All existing flag invocations, JSON envelopes,
#    and error codes are preserved. The new flags are opt-in.
code-pact validate --json   # expect: ok
code-pact plan analyze --json
# Existing P1-welcome.yaml artifacts in projects that initialised with
# v1.3.x or earlier are NOT touched by the upgrade. Only NEW `init` runs
# produce the renamed TUTORIAL artifact.
```

### What's new in v1.4.0

P13 (Planning UX & init hardening) closes four small frictions in the planning / init / task-creation surface that P9 and P12 explicitly deferred. Every change is additive on the CLI contract — no new commands, no new error codes, no new schema fields, no behavioural changes to `task complete` / `task finalize` / `phase reconcile` / `task runbook` / `phase runbook`.

- **`init --sample-phase`** (Stable v1.4+) — explicit opt-in flag. In non-interactive mode, enables sample-phase creation (which was previously wizard-only). In TTY wizard mode, skips the "create sample phase?" prompt and forces creation. The existing TTY-wizard default-yes behaviour is preserved unchanged.
- **`task add` non-interactive flags** (Stable v1.4+) — `--description` triggers a flag-driven path that bypasses the wizard entirely (no TTY required). `--type` is required in that mode. Six readiness fields (`--ambiguity` / `--risk` / `--context-size` / `--write-surface` / `--verification-strength` / `--expected-duration`) accept enum values; five P10 fields (`--depends-on` / `--decision-ref` / `--read` / `--write` / `--acceptance-ref`) are repeatable. `--status` is **intentionally not exposed** — newly added tasks are always `status: planned`; historical / migrated tasks use `phase import`. Partial flags (non-interactive flag without `--description`) raise `CONFIG_ERROR`. Wizard path is unchanged.
- **`suggested_next_steps: string[]`** on `plan prompt --json` and `phase import --json` (Stable v1.4+) — additive field naming the canonical post-command sequence. `plan prompt` emits the 4-step AI-assisted planning flow (prompt → import → lint → phase runbook). `phase import` emits the post-import validation flow (lint → phase runbook per imported phase → task runbook on the first task) plus a defaults-review hint when `completed_fields[]` is non-empty.
- **Sample-phase artifact renamed `P1-welcome.yaml` → `TUTORIAL-walkthrough.yaml`** with two minimal tutorial tasks added (`TUTORIAL-T1`, `TUTORIAL-T2`; the latter `depends_on: [TUTORIAL-T1]`). One bootstrap artifact now demos P10 (`depends_on`) + P11 (`task finalize` / `phase reconcile`) + P12 (`task runbook` blocking step) end-to-end. **This is the only behavioural change for new init runs.** Existing v1.3.x projects with a `P1-welcome.yaml` are untouched.

For the full design rationale, read [`design/decisions/planning-ux-init-hardening-rfc.md`](../design/decisions/planning-ux-init-hardening-rfc.md). For the agent- and reviewer-facing walkthrough of the sample phase, read [`docs/concepts/sample-phase.md`](concepts/sample-phase.md).

### Recommended adoption pattern

**Replace scripted-bootstrap workarounds with `init --non-interactive --sample-phase`.**

Pre-v1.4 scripted bootstrap required either dropping into a TTY for `init` (impossible in CI) or running `init --non-interactive` followed by a hand-built `phase import` to seed a smoke-test artifact. v1.4 replaces both:

```sh
# v1.3.x and earlier (CI without sample phase):
code-pact init --non-interactive --locale en-US --agent claude-code
# → empty roadmap, no smoke-test artifact

# v1.3.x + hand-built phase import (heavyweight scripted bootstrap):
code-pact init --non-interactive --locale en-US --agent claude-code
cat > /tmp/seed.yaml <<EOF
phases:
  - id: P1
    name: Smoke
    weight: 1
    objective: ...
    tasks:
      - id: P1-T1
        description: ...
EOF
code-pact phase import /tmp/seed.yaml

# v1.4.0+ (single command):
code-pact init --non-interactive --locale en-US --agent claude-code --sample-phase
# → roadmap with TUTORIAL phase + TUTORIAL-T1 / TUTORIAL-T2 ready for the per-task loop
```

**Replace `phase import` of single-task deltas with `task add` non-interactive flags.** When you only need to add one task in CI:

```sh
# v1.3.x and earlier (heavyweight):
cat > /tmp/delta.yaml <<EOF
phases:
  - id: P1
    name: ...
    weight: ...
    objective: ...
    tasks:
      - id: P1-T5
        type: feature
        description: ...
EOF
code-pact phase import /tmp/delta.yaml --force

# v1.4.0+ (single command):
code-pact task add P1 --description "..." --type feature
```

Both produce byte-identical phase YAML output.

### CI implications under `--strict`

Projects running `plan lint --strict` / `plan analyze --strict` / `validate --strict` see **no new errors and no new warnings**. v1.4.0 introduces zero new lint codes, zero new analyze codes, zero new error codes. `KNOWN_CODES.public` in `tests/unit/error-code-surface.test.ts` is unchanged from v1.3.0.

### Backward compatibility

- `init` flag surface gains `--sample-phase` (additive); all existing flags unchanged.
- `init` JSON envelope unchanged.
- `init` TTY wizard prompts and default-yes behaviour are unchanged. The `--sample-phase` flag, when passed to a TTY-wizard invocation, only skips the existing prompt (the wizard's default behaviour without the flag is identical to v1.3.x).
- **`init` generated artifact is renamed** (`P1-welcome.yaml` → `TUTORIAL-walkthrough.yaml`; phase id `P1` → `TUTORIAL`; two tutorial tasks added). This affects only NEW init runs. Existing projects with a v1.3.x-or-earlier `P1-welcome.yaml` are untouched.
- `task add` flag surface gains the non-interactive flag set (additive); existing positional + `--id` behaviour unchanged.
- `task add` JSON envelope unchanged (`{ phaseId, taskId, phasePath }`).
- `plan prompt` output gains `data.suggested_next_steps` (additive); existing fields (`prompt`, `has_brief`, `has_constitution`, `clipboard_copied`) unchanged.
- `phase import` output gains `data.suggested_next_steps` (additive); existing fields (`imported_phases`, `imported_tasks`, `skipped_phases`, `completed_fields`) unchanged.
- `task complete` / `task finalize` / `phase reconcile` / `task runbook` / `phase runbook` / `task context` / `task start` / `task block` / `task resume` / `task status` / `plan analyze` / `plan lint` / `validate` / `doctor` / `recommend` — **unchanged**. Same flags, JSON envelope, exit codes, error codes.
- `progress.yaml` remains read-only for the new commands. The append-only operational-log contract is preserved.
- `task context` pack output is unchanged. The byte-identical pack regression test against the golden fixture passes without modification.
- `tests/integration/json-stdout.test.ts` continues to pass for every Stable command. Three new entries added for `init --sample-phase`, `task add --description`, and `task add` partial-flags CONFIG_ERROR.
- `KNOWN_CODES.public` unchanged.
- No new task or phase schema field. v1.3.x phase YAMLs parse and behave identically.

In semver terms, v1.4.0 is a minor release.

## Deferred beyond v1.4

The following remain on the backlog after v1.4.0:

- Removal of bare-form `code-pact adapter`.
- Multi-agent orchestration / MCP / GitHub-Linear-Jira sync.
- Advisory write locks for concurrent process safety.
- **Enforcement of declared `writes` against actual file-system writes.** v1.1+ surfaces `TASK_WRITES_PROTECTED_PATH` as a warning against a narrow built-in seed set (`.git/**`, `node_modules/**`, `.code-pact/**`, `design/roadmap.yaml`, `design/phases/*.yaml`). Configurable governance and warning → error promotion are P14 work. v1.2+ displays declared `writes` in the `task finalize` / `phase reconcile` / `task runbook` JSON payload but does **not** verify them against actual file-system writes.
- **Cross-phase `depends_on`.** v1.1+ ships same-phase only; cross-phase task ordering is a future extension. v1.3.0 surfaces `depends_on` in `task runbook` blocking steps but does not extend the same-phase restriction.
- **File-content inclusion for `reads` and `acceptance_refs`.** v1.1+ renders both as path lists only; v1.4.0 keeps that surface unchanged.
- **Phase status auto-flip.** v1.2+ reports `phase_status_candidate` as advisory but never writes the phase's own `status` field. v1.3.0 `phase runbook` surfaces the same candidate plus a `manual_action` recommending the flip; it does not write either. An `--include-phase-status` opt-in is a candidate once the per-task flip path has been used through one release cycle.
- **Multi-phase reconcile / runbook (`--all`).** v1.2 / v1.3 / v1.4 ship per-phase only.
- **`design/roadmap.yaml` mutation.** Whether release prep should be able to delegate the per-phase weight / status flip to a `roadmap reconcile` command is P14 governance scope.
- **Semantic validation of `acceptance_refs` content.** v1.2+ only checks the path exists; richer validation would couple finalize to acceptance-criteria format choices the project has not yet made.
- **Runbook execution (`task runbook --execute`).** v1.3.0 is proposal-only by design. A future RFC may revisit a flag that runs each recommended step automatically, but only after the proposal-only contract has been used through one release cycle.
- **Schema-level `human_gate` field.** v1.3.0 expresses manual checkpoints as `RunbookStep` content (`command: null` + `manual_action: "..."`). Promotion to a task-schema field requires more usage signal; P14 candidate.
- **`task next` / `phase next` sugar aliases.** v1.3.0 ships `runbook` as the explicit primary name. Short-form aliases remain a future candidate.
- **Bundling `recommend` into `task runbook`.** v1.3.0 keeps them as separate commands answering different questions. Bundling remains a future candidate once usage signal emerges.
- **`task add --status` flag.** P13 explicitly does not expose `--status`. Newly added tasks are always `status: planned`. Historical / migrated tasks must use `phase import`. Preserves the P11/P12 contract that design `done` is the result of `task finalize` / `phase reconcile`, not a starting point.
- **`task add --dry-run`.** Not enough signal yet; revisit if needed.
- **Reserved-id (`TUTORIAL`) hard enforcement.** P13 only changes the sample-phase default; users can still hand-edit roadmap.yaml to add their own `TUTORIAL`-named phase. Existing `DUPLICATE_PHASE_ID` catches the practical case. Hard reservation is P14 governance.
- **`plan brief` / `plan constitution` non-TTY alternatives.** Designed as interactive by intent; non-TTY users can hand-edit `design/brief.md` / `design/constitution.md`. Code-level alternatives are P14 or later.
- **Init / wizard / task-add UX polish beyond P13.** P13 closed the scripted-bootstrap gap and the partial-flags / silent-fallthrough footgun; further polish (e.g. `init --mode tutorial` sugar alias, `task add --dry-run`) remains future scope.
- **Runbook integration with a runbook orchestrator (`task run` / `phase close`).** v1.4.0 keeps `task runbook` / `phase runbook` as user-callable read-only commands. A future runbook orchestrator that consumes them is out of scope.
- Semver-aware `ADAPTER_GENERATOR_STALE` (current implementation is simple equality).
- Conformance test inclusion for `cursor` / `gemini-cli` adapters — they remain Experimental.

A previously deferred item, **promoting `assertSafeRelativePath` / `resolveWithinProject` to a neutral module**, was partially closed in v1.1.0 (P10-T3): the helpers now live at `src/core/path-safety.ts` and are imported by plan lint for the new `decision_refs` / `reads` / `writes` / `acceptance_refs` validation. The adapter file re-exports them so existing call sites are unchanged. Extension of these helpers to the broader project state tree (design / progress file writes) remains P14 governance scope.

See [`docs/cli-contract.md` § Stability taxonomy](cli-contract.md#stability-taxonomy-v10) for the full list of stability bands per command and the criteria a v1.x command must meet to move between them.
