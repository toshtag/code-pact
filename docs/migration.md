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

- **`init --sample-phase`** (Stable v1.4+) — explicit opt-in flag. In non-interactive mode, enables sample-phase creation (which was previously wizard-only). In TTY wizard mode, skips the "create sample phase?" prompt and forces creation. The existing TTY-wizard default-yes behaviour is preserved unchanged. _(Superseded in v1.15: the wizard prompt was removed entirely; `--sample-phase` is now the only way to create the sample phase. See § v1.14.0 → v1.15.0.)_
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
- `init` TTY wizard prompts and default-yes behaviour are unchanged. The `--sample-phase` flag, when passed to a TTY-wizard invocation, only skips the existing prompt (the wizard's default behaviour without the flag is identical to v1.3.x). _(Superseded in v1.15: the sample-phase prompt was removed; see § v1.14.0 → v1.15.0.)_
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

## v1.14.0 → v1.15.0

**Minor release.** Adds the `code-pact tutorial` command and removes the
interactive sample-phase prompt from the `init` wizard. No breaking
change — `--sample-phase` is unchanged, and non-interactive / CI `init`
was already opt-in.

```sh
npm install -g code-pact@1.15.0
```

### What changed

- **New command `code-pact tutorial`.** Runs the per-task loop end to end
  in a throwaway sandbox (deleted afterward) and narrates each step.
  Nothing is written to your project. `--json` emits a step transcript;
  `--keep` retains the sandbox. Stable (v1.15+).
- **The `init` wizard no longer asks "Create a tutorial sample phase?".**
  The prompt is gone. To scaffold the `TUTORIAL` sample phase into your
  project, pass `--sample-phase` explicitly (interactive or not) — exactly
  as before. To just watch the loop run, use `code-pact tutorial`. After
  `init` the wizard now prints two footer hints pointing at both.

### Do you need to do anything?

- **No.** If you scripted `init --sample-phase`, it behaves identically.
- If you relied on the interactive wizard creating the sample phase by
  answering "yes", add the `--sample-phase` flag to your `init`
  invocation, or run `code-pact tutorial` instead.

In semver terms, v1.15.0 is a minor release.

## v1.13.3 → v1.14.0

**Minor release.** The `task prepare` primary contract is now
documented and mechanically checked, and `adapter conformance` gains new
checks plus a `severity` field. No breaking change — older installs keep
working and warn rather than hard-fail.

```sh
npm install -g code-pact@1.14.0
```

### What changed

- **`task prepare` is the primary per-task entrypoint (P29).** The
  README, both getting-started guides, and the generated adapter
  guidance now lead with `task prepare`; `recommend` and `task context`
  are diagnostics that `task prepare` already runs for you.
- **Fixed the `task prepare` finalize command (P29).**
  `commands.finalize` emitted `task finalize <id> --agent <agent>`,
  which the CLI rejects with `CONFIG_ERROR` (finalize takes no
  `--agent`). It now emits `task finalize <id> --write --json`.
- **`adapter conformance` hardening (P30).** Three new checks —
  `task_prepare_is_primary`, `no_contract_antipatterns` (rejects the
  `task finalize ... --agent` anti-pattern), and
  `activation_rules_documented` (documentation presence, not runtime
  obedience). Each check now carries a `severity` (`required` |
  `advisory`); `compliant` is false only when a *required* check fails.
- **Hybrid version gating (P30).** The new checks are `required` for
  adapters whose manifest `generator_version` is semver >= `1.14.0` and
  `advisory` below, so installs predating the P29-aligned templates warn
  (with an `adapter upgrade` remediation) rather than hard-fail.
- **Metric wording.** "Agent command adherence rate" → "Task lifecycle
  adherence rate" — it measures state-machine `started`→`done`
  adherence; `task prepare` is read-only and prepare-adherence is not
  measured.

### Recommended action

```sh
code-pact adapter upgrade <agent> --write
```

Re-upgrading picks up the P29-aligned guidance and moves the new
conformance checks to the `required` tier. It is optional — a pre-1.14.0
install keeps working and reports the new checks as advisory warnings.

### What did NOT change

- `progress.yaml` schema, `adapter_schema_version`, and the
  `ManifestFile` schema — unchanged. No data migration.
- No public error code added or renamed; the conformance exit codes
  (0 compliant / 1 not) are unchanged.
- `task prepare` stays read-only — no `--record`, emits no progress
  event.

### Why a minor release

P30 adds new public surface to the `adapter conformance` envelope (the
`severity` field and three new check ids) and P29 changes the
`task prepare` `commands.finalize` value. The changes are additive and
gated to avoid breaking older installs, so minor is the correct semver
position.

## v1.13.2 → v1.13.3

**Documentation patch.** No code change. No CLI surface
change. Upgrade is a no-op for project state:

```sh
npm install -g code-pact@1.13.3
```

### What changed

- **P22 (Adapter schema v2) formally cancelled.** The
  v1.11-era roadmap's last item is closed as
  "investigated, no shippable scope" rather than
  shipped. The originally-proposed
  `adapter_schema_version: 2` + `template_signature` +
  lifecycle hooks scope had no shippable value — the
  drift-attribution use case is already satisfied by the
  existing v1 manifest plus the `adapter doctor`
  two-axis classification. Decision recorded in
  `design/decisions/P22-cancelled-adapter-schema-v2.md`
  (status: accepted). `design/phases/P22-adapter-schema-v2.yaml`
  carries `status: cancelled` for both the phase and its
  single investigation task, matching the v1.4 P15-T5
  cancellation precedent.
- **`docs/cli-contract.md` `### adapter doctor` section**
  gains a `#### Adapter file drift classification
  (two-axis)` subsection documenting the existing local
  state × desired state matrix and the per-combination
  doctor code (`ADAPTER_DESIRED_STALE`,
  `ADAPTER_FILE_DRIFT`, `ADAPTER_FILE_MISSING`). The
  semantics have been stable since v0.9 (P7); the
  documentation finally makes them self-explanatory.

### What did NOT change

- `dist/cli.js` — byte-identical to v1.13.2.
- Every public command, flag, JSON envelope, exit code,
  and error code — byte-identical to v1.13.2.
- `adapter_schema_version` — stays at 1.
- `ManifestFile` schema — unchanged. **No
  `template_signature` field added.**
- Public error code names (`ADAPTER_DESIRED_STALE`,
  `ADAPTER_FILE_DRIFT`, etc.) — unchanged. Rename was
  considered and rejected as a breaking change to
  `KNOWN_CODES.public`.
- Adapter manifest schema — unchanged. **No `adapter
  upgrade` needed.**
- `progress.yaml` schema — unchanged.

### Why a documentation patch (not 1.14.0)

This release ships only documentation and a design
decision artefact. No new commands, no new flags, no new
error codes, no envelope changes, no manifest schema
change. The v1.10.1 / v1.13.1 / v1.13.2 precedent for
behaviour-preserving releases applies — patch is the
correct semver position.

In semver terms, v1.13.3 is a patch release.

## v1.13.1 → v1.13.2

**Dogfood baseline refresh patch.** No code change. No
CLI surface change. Upgrade is a no-op for project state:

```sh
npm install -g code-pact@1.13.2
```

### What changed

- `design/measurements/` artefacts (the v1 + v2 CSVs and
  `summary.json`) regenerated against git SHA `7743d4f`
  (v1.13.1 release commit). The values P26-T2 committed
  against git SHA `4627858` (v1.11.0 era) were 18 PR
  merges and 9 additional `done` events stale.
- `docs/positioning.md` "Baseline values" table and
  `docs/agent-contract.md` "Measurement" table cite the
  refreshed numbers.
- `measurements.manifest.json` `input_git_sha` /
  `code_pact_cli_version` / `generated_at` refresh.

### What did NOT change

- `dist/cli.js` — byte-identical to v1.13.1.
- Every public command, flag, JSON envelope, exit code,
  and error code — byte-identical to v1.13.1.
- Adapter manifest schema — unchanged. No `adapter
  upgrade` needed.
- `progress.yaml` schema — unchanged.

### Baseline shifts

| metric | v1.11 baseline | v1.13.2 baseline | Δ |
|---|---|---|---|
| `pack_size_p50_bytes` | 20725 | 22072 | +1347 |
| `pack_size_p90_bytes` | 50131 | 49654 | −477 |
| `pack_size_max_bytes` | 259650 | 290791 | +31141 |
| `first_pass_verify_rate_percent` | 100.0 | 100.0 | unchanged |
| `lifecycle_adherence_rate_percent` | 81.3 | 81.8 | +0.5 |
| `adapter_drift_rate_percent` | 0.0 | 0.0 | unchanged |
| `tasks_done` | 79 | 88 | +9 |
| `tasks_total` | 116 | 123 | +7 |

In semver terms, v1.13.2 is a patch release — no
behaviour change, only measurement data freshness.

## v1.13.0 → v1.13.1

**Internal refactor patch.** No user-visible product
surface change. Upgrade is a no-op for project state:

```sh
npm install -g code-pact@1.13.1
```

### What changed

- `src/cli.ts` (4559 → 2388 lines, −48%) — the `task` and
  `adapter` subcommand clusters move to dedicated files
  under `src/cli/commands/`. The P14 advisory-write-lock
  wrapper (`withWriteLock`) is promoted to a shared
  `src/cli/util.ts` module.
- `dist/cli.js` grows from 447.82 KB to 452.96 KB
  (+5.14 KB) due to the new module boundaries. Runtime
  behaviour is byte-identical.
- `docs/cli-contract.md` gains a `## Source layout (CLI
  wrapper layer)` contributor-facing section documenting
  where new commands go.

### What did NOT change

- Every public command, flag, JSON envelope, exit code,
  and error code — byte-identical to v1.13.0.
- The existing 1262 unit + 333 integration tests pass
  WITHOUT MODIFICATION (the safety guarantee the
  refactor operated under).
- The published tarball still contains only `LICENSE` /
  `README.md` / `dist/cli.js` / `dist/cli.js.map` /
  `package.json` — the new `src/cli/commands/` directory
  is not shipped to users.
- Adapter manifest schema — unchanged. No `adapter
  upgrade` needed.
- `progress.yaml` schema — unchanged.

In semver terms, v1.13.1 is a patch release — the v1.10.1
precedent applies (behaviour-preserving change with
internal restructuring).

## v1.12.x → v1.13.0

**Context budget enforcement.** v1.13.0 closes P24 and
adds the `--budget-bytes <N>` flag to `code-pact task
context` and `code-pact task prepare`. The flag is
additive and opt-in; the no-flag default path is
byte-identical to v1.12.

### Quick path

```sh
npm install -g code-pact@1.13.0
code-pact --version    # 1.13.0
```

No project-side action required. No `adapter upgrade`
needed.

### New: `--budget-bytes <N>` on `task context` and `task prepare`

```sh
# Cap the rendered pack at N UTF-8 bytes
code-pact task context <task-id> --agent claude-code --budget-bytes 8000 --json
code-pact task prepare <task-id> --agent claude-code --budget-bytes 8000 --json
```

`N` must be a positive integer (zero / negative /
non-numeric values fail with `CONFIG_ERROR` at flag parse
time).

**Elision priority (locked).** When the rendered pack
exceeds `N`, sections drop in this order until the bound
is met:

1. `completed_tasks` (gated by `ambiguity: high`)
2. `related_decisions` (only when `context_size: large`)
3. `constitution`
4. `rules` (only when `write_surface: high`)
5. `reads` (declared globs; declaration-only)

Sections NOT in this list are unelidable: `header`,
`phase_contract`, `task_definition`, `depends_on`,
`writes`, `declared_decisions`, `acceptance_refs`,
`verification_commands`, `progress_event_schema`,
`format_overhead`. These are either always-included or
carry task-declared intent.

The locked source of truth is `ELISION_ORDER` in
`src/core/pack/formatters/markdown.ts`. Changing the
order requires an RFC amendment.

### New: `CONTEXT_OVER_BUDGET` error code

When maximal elision still exceeds the budget, the command
fails with the new public error code:

```json
{
  "ok": false,
  "error": {
    "code": "CONTEXT_OVER_BUDGET",
    "message": "Context pack cannot be reduced below 1196 bytes; --budget-bytes 100 is unachievable for this task.",
    "data": {
      "budget_bytes": 100,
      "minimum_achievable_bytes": 1196,
      "unelidable_sections": ["header", "phase_contract", "task_definition", "verification_commands", "progress_event_schema"]
    }
  }
}
```

Exit code 2. `data.minimum_achievable_bytes` is the
post-maximal-elision floor — re-running with this value as
the budget succeeds and produces a pack of exactly that
size.

### Activates `budget_reserved_for_later` in `--explain --json`

P21-T4 reserved `budget_reserved_for_later` in
`ContextExcludedReasonCode` for this work. In v1.13, when
`task context --explain --json` is invoked with
`--budget-bytes`, every elided section appears in the
`excluded[]` array with this reason code:

```json
{
  "excluded": [
    {
      "name": "rules",
      "reason_code": "budget_reserved_for_later",
      "details": {
        "elided_for_budget_bytes": 2000,
        "section_bytes": 4183
      }
    }
  ]
}
```

The P21 unit test asserting the value is never emitted in
the no-budget case continues to pass — the new emission
path is gated behind `--budget-bytes`.

### What did NOT change

- `dist/cli.js` JSON envelope for `task context` and `task
  prepare` without `--budget-bytes` — byte-identical to
  v1.12.
- Pack `content` without `--budget-bytes` — byte-identical
  to v1.12 (the existing
  `tests/integration/pack-byte-identical.test.ts` lock
  test continues to pass).
- Every other public command, flag, JSON envelope, and
  error code — unchanged.
- Adapter manifest schema (`schema_version: 1`,
  `adapter_schema_version: 1`) — unchanged.
- Existing adapter instruction files — unchanged. No
  `adapter upgrade` needed.
- `progress.yaml` schema — unchanged.

### Progress-read-only invariant preserved

`task prepare --budget-bytes` does NOT mutate
`.code-pact/state/progress.yaml` on the
`CONTEXT_OVER_BUDGET` failure path. Verified by a
dedicated unit test.

### What's NOT in v1.13

- **No `--budget-tokens` flag.** Token counting requires a
  per-model-family tokenizer; bytes are the model-agnostic
  proxy.
- **No section-level truncation.** Whole-section elision
  only; partial-body truncation is out of scope.
- **No automatic budget inference from the agent profile.**
  The flag is opt-in per invocation; a default-budget RFC
  is deferred.
- **No retroactive harness metric.** `summary.json` keeps
  the unconditional `pack_size_*` stats; a
  `pack_size_after_budget_*` metric (parameterised by a
  fixed budget) is deferred.

In semver terms, v1.13.0 is a minor release — additive
only (new flag, new public error code; existing v1.12
envelopes byte-identical).

## v1.11.x → v1.12.0

**Evidence Harness v2 + baseline numbers in v1.11 docs.**
v1.12.0 closes P26 and populates the five success-metric
baselines `docs/positioning.md` and
`docs/agent-contract.md` committed to in v1.11.0. No
user-visible CLI surface change; `dist/cli.js` is
unchanged from v1.11.0.

### Quick path

```sh
npm install -g code-pact@1.12.0
code-pact --version    # 1.12.0
```

No project-side action required.

### What changed

- **`docs/positioning.md` "Success metrics" + `docs/agent-contract.md` "Measurement"** flip from
  "populated by P26" placeholders to the committed
  baseline values from `design/measurements/summary.json`
  (against git SHA `4627858`). Both docs now cite
  reproducible numbers with a `pnpm harness --corpus .
  --check` hint.
- **`docs/concepts/evidence-harness.md`** updates for
  v1.12 — the "What it measures" table grows from four
  to six CSV files, gains a `summary.json` shape callout,
  and documents the percentile rule, rate rounding, the
  adherence numerator/denominator semantics, the adapter
  drift gate, and the undeclared-write-rate deferral.
- **`scripts/harness/`** gains two new CSV outputs
  (`lifecycle-adherence-by-task.csv`,
  `adapter-drift-by-agent.csv`) and one aggregate JSON
  sidecar (`summary.json`). The harness remains
  maintainer-only (not registered in `package.json`
  `bin`).
- **`measurements.manifest.json`** `harness_version` bumps
  `0.1.0 → 0.2.0`. v1 CSV column shapes are unchanged
  (additive only).

### What did NOT change

- `dist/cli.js` bundle — byte-identical to v1.11.0.
- Every public command, flag, JSON envelope, and error
  code — unchanged.
- `recommend` / `task context` / `task context --explain`
  / `task prepare` / `adapter conformance` JSON envelopes
  — byte-identical to v1.11.0.
- Adapter manifest schema (`schema_version: 1`,
  `adapter_schema_version: 1`) — unchanged.
- Existing adapter instruction files — unchanged; no
  `adapter upgrade` needed.
- `progress.yaml` schema — unchanged.

### What's NOT in v1.12

- **`undeclared_write_rate` is deferred, not computed.**
  `summary.json` carries
  `undeclared_write_rate_status: "deferred"` with a
  pointer to `evidence-harness-v2-rfc.md` Non-goals. A
  future phase may add lifecycle instrumentation to make
  this metric observable.
- **`task prepare` adherence tracking.** The lifecycle
  adherence metric measures state-machine adherence
  (`started` before `done`, no legacy shortcut). `task
  prepare` is read-only and emits no event, so its
  invocation cannot be counted. A future phase may add
  prepare-event tracking.

In semver terms, v1.12.0 is a minor release — additive
only (no user-visible CLI surface change, but a meaningful
phase close and a new committed repo artefact set future
RFCs can cite, matching the v1.10.0 precedent).

## v1.10.x → v1.11.0

**Agent Contract v2.** v1.11.0 introduces three new
public CLI surfaces and refreshes the stable adapter
instruction templates. Upgrade is opt-in for new features;
the existing `task context` / `recommend` envelopes are
byte-identical to v1.10.

### Quick path

```sh
npm install -g code-pact@1.11.0
code-pact --version    # 1.11.0
```

### Required: refresh installed adapters

The instruction templates for `claude-code`, `codex`, and
`generic` now embed the v1.11+ lifecycle and diagnostic
surface mentions and the failure-guidance keywords that
`code-pact adapter conformance` requires. Existing installs
will surface `ADAPTER_FILE_DRIFT` in `code-pact adapter
doctor` until refreshed:

```sh
# See the drift
code-pact adapter upgrade <agent> --check
# Apply the v1.11 template; --accept-modified preserves user edits
code-pact adapter upgrade <agent> --write --accept-modified
```

After upgrading, `code-pact adapter conformance <agent>`
returns `compliant: true` (exit 0).

### New: `code-pact task prepare <task-id>`

Single progress-read-only per-task entry point. Returns
current state, recommendation, context pack metadata, a
structured `next_action`, and a `commands` dictionary with
every per-task verb pre-formatted. Replaces manual
`recommend → task context → state check` stitching:

```sh
code-pact task prepare <task-id> --agent claude-code --json
```

Flags: `--agent <name>`, `--json`, `--dry-run`. The
`--dry-run` form builds the context pack in memory but skips
the write; the envelope returns
`would_write_context_pack_path` instead of
`context_pack_path`. `task prepare` MUST NOT mutate
`.code-pact/state/progress.yaml` on any code path.

Closed enum for `next_action.type`: `start_task` /
`continue_implementation` / `wait_for_dependencies` /
`noop_already_done` / `investigate_failure`.

### New: `code-pact task context --explain`

Per-section byte breakdown of the rendered context pack:

```sh
code-pact task context <task-id> --agent claude-code --explain --json
```

The envelope gains `total_bytes`, `context_pack_bytes`,
`sections[]`, and `excluded[]`. Each section carries a
closed-enum `reason_code` (`always_included` /
`declared_by_task` / `referenced_decision` / `glob_match` /
`write_surface_high` / `context_size_large` /
`ambiguity_high` / `format_overhead`); each excluded entry
carries an `excluded_reason_code` from a separate closed
enum (`context_size_small_and_ambiguity_low` /
`not_declared_by_task` / `glob_no_match` /
`budget_reserved_for_later`).

Acceptance invariant: `sum(sections[].bytes) ===
total_bytes === context_pack_bytes`. The pack `content` is
byte-identical to v1.10 — the flag only attaches metadata.

`budget_reserved_for_later` is reserved for P24 (budget
enforcement). v1.11 NEVER emits it; a unit test asserts the
absence.

### New: `code-pact adapter conformance <agent>`

Focused read-only check that the installed adapter
satisfies the v1.11+ agent contract:

```sh
code-pact adapter conformance <agent> --json
echo $?    # 0 if compliant, 1 if not
```

Conformance is intentionally narrower than `adapter doctor`
— it inspects only the contract shape and per-file integrity.
`ADAPTER_GENERATOR_STALE` / `ADAPTER_PROFILE_DRIFT` /
`ADAPTER_UNMANAGED_FILE` remain doctor-only diagnostics.

Check ids: `manifest_present`, `instruction_file_present`,
`contract_section_present`, `axis_when_to_invoke`,
`axis_what_to_verify`, `axis_how_to_handle`,
`required_cli_surface_mentions`,
`required_failure_guidance`, `file_checksum_match` (one
per manifest file). The required-surface and
required-failure-guidance lists live in
`src/core/adapters/conformance-spec.ts` and are shared with
`adapter doctor`'s contract drift check — the two callers
cannot disagree.

### No new error codes

Every P21 failure mode reuses an existing public code
(`TASK_NOT_FOUND`, `AMBIGUOUS_TASK_ID`, `PHASE_NOT_FOUND`,
`AGENT_NOT_FOUND`, `AGENT_NOT_ENABLED`, `CONFIG_ERROR`, the
`ADAPTER_*` family).

### No adapter manifest schema bump

`adapter_schema_version` stays at 1. The manifest layout is
unchanged; only the instruction body text evolved, which is
why a re-install is enough to refresh.

### What's NOT in v1.11

- **Budget enforcement.** `--budget-bytes` and related
  truncation policy are deferred to P24.
- **CLI module split.** `src/cli.ts` continues to dispatch
  every command from one file. Splitting is deferred.
- **Automatic conformance repair.** `adapter conformance` is
  read-only — re-run `adapter install` / `adapter upgrade`
  to remediate.
- **Phase-level status flips in `phase reconcile`.** Task
  status flips continue to be reconciled; the phase-level
  `status:` field is still flipped by hand in release prep.

In semver terms, v1.11.0 is a minor release — additive only.

## v1.10.0 → v1.10.1

Doc-only patch. No code change to the user-facing product
surface. Upgrade is a no-op for project state:

```sh
npm install -g code-pact@1.10.1
```

If you have an adapter installed (claude-code / codex /
generic), the instruction-file body that v1.10.0 emitted
carries the old CI recommendation `task finalize
--audit-strict --write --json`. v1.10.1 replaces that with
the `--base-ref <default-branch>` pair documented below. To
refresh the instruction file body, run:

```sh
code-pact adapter upgrade <agent> --check     # see the drift
code-pact adapter upgrade <agent> --write --accept-modified
```

`--accept-modified` preserves any user edits to other parts
of the file.

### What changed in the docs

- The `phase reconcile --audit-strict` surface that v1.10.0
  CHANGELOG / migration / P15 phase YAML referred to **does
  not exist**. P15-T6 scope-reduced during implementation to
  `task finalize --audit-strict` only. v1.10.1 corrects the
  metadata.
- CI examples now pair `--audit-strict` with `--base-ref
  <default-branch>`. The bare `task finalize --audit-strict
  --write --json` invocation works for local pre-commit
  review (uncommitted working tree is the audit target) but
  fails for CI (clean working tree → `DECLARED_UNUSED`
  fires).
- `docs/concepts/task-readiness-fields.md` is brought up to
  date with P19 (cross-phase `depends_on` + multi-node cycle
  detection) and P15 (configurable protected paths +
  `write_audit` + `OVER_BROAD` lint).

### CI recommendation matrix

| Working tree state | Recommended invocation |
| --- | --- |
| Clean (CI / committed branches) | `task finalize <id> --audit-strict --write --json --base-ref origin/main` |
| Dirty (local pre-commit) | `task finalize <id> --audit-strict --write --json` |

In semver terms, v1.10.1 is a patch release.

## v1.9.x → v1.10.0

### Quick path

```sh
# 1. Upgrade the CLI.
npm install -g code-pact@1.10.0

# 2. No project-side action is required. v1.10 changes nothing
#    in the user-facing product surface — no new commands, no
#    new flags, no new error codes, no JSON envelope changes.
code-pact validate --json
```

### What's new

- **Internal-only evidence harness** at `scripts/harness/`,
  invoked via `pnpm harness --corpus . [--write] [--json]`.
  Walks the corpus and emits four CSV metric files +
  `measurements.manifest.json` under `design/measurements/`.
  See [`docs/concepts/evidence-harness.md`](concepts/evidence-harness.md).
- **The harness is NOT a product feature.** It is not
  registered in `package.json` `bin`, never invoked through
  `code-pact ...`, and has no stability commitment. End
  users of the published npm package see nothing new.
- **P15-T5 closed as `cancelled`.** The originally-deferred
  `write_audit` field on `phase reconcile --json` will not
  ship. The use case is already served by the v1.6+v1.9
  combination of `task finalize --audit-strict` +
  `phase runbook --across-phases`. `task finalize
  --audit-strict` (P15-T6, v1.6+, the only `--audit-strict`
  surface that ever shipped) is unaffected.
- **P15 phase status** flips from `in_progress` to `done`
  in v1.10 as a consequence of the P15-T5 closure.

### Why this is a minor (1.10.0, not 1.9.1)

Strictly, the user-visible product surface is unchanged.
We still cut a minor (not a patch) because cancelling
P15-T5 is a meaningful design statement and the committed
baseline CSVs are a new repository artifact that future
RFCs will depend on. See the v1.10.0 CHANGELOG entry for
the longer rationale.

### What stayed the same

- Every public command, every flag, every JSON envelope,
  every error code — unchanged.
- `KNOWN_CODES.public` — unchanged.
- `progress.yaml` schema and contract — unchanged.
- `task context` pack output — byte-identical with v1.9.0
  (the harness reads packs but does not mutate them).
- Existing adapter manifests — unchanged. No re-install /
  upgrade required for the v1.10 release.
- `dist/cli.js` bundle — size unchanged at 419.71 KB; the
  harness is excluded from `tsup` build.

In semver terms, v1.10.0 is a minor release.

## v1.8.x → v1.9.0

### Quick path

```sh
# 1. Upgrade the CLI.
npm install -g code-pact@1.9.0

# 2. No project-side action is required. v1.9 is purely
#    additive — no schema changes, no breaking flag changes,
#    no error code renames, no existing-command behaviour
#    changes.
code-pact validate --json

# 3. (Optional) once any task uses cross-phase depends_on,
#    re-run strict lint to confirm no cycles slipped in.
code-pact plan lint --include-quality --strict --json
```

### What's new

- **`code-pact phase runbook --across-phases [--json]`** —
  aggregated runbook envelope that emits one per-phase
  `PhaseRunbookResult` for every `in_progress` phase plus
  any phase pulled in via one level of transitive dep-driven
  inclusion (`depends_on` from an in_progress task to a task
  declared in another phase, with the dep still unsatisfied).
- **Cross-phase `depends_on`** is now resolved. A task may
  declare `depends_on: ["P15-T5"]` from inside `P19-T1`; the
  resolver looks same-phase first, cross-phase fallback. An
  id absent from the entire roadmap still surfaces
  `TASK_DEPENDS_ON_UNRESOLVED`.
- **`TASK_DEPENDS_ON_CYCLE`** new plan-lint code (severity
  error) catches multi-node cycles (length ≥ 2). Self-cycles
  keep their narrower `TASK_DEPENDS_ON_SELF_REFERENCE`
  diagnostic.
- New `phase_id` field on `task runbook`'s
  `depends_on_check[i]` JSON entries — populated only for
  cross-phase resolutions; same-phase deps omit it.
- New docs section: [`docs/cli-contract.md → phase runbook
  → --across-phases`](cli-contract.md#-across-phases-v19-p19);
  new dogfood subsection: ["Tracking release prep with
  phase runbook --across-phases"](dogfood.md).

### Why this is a minor (1.9.0, not 1.8.1)

The release adds a new top-level Stable v1.0 flag
(`--across-phases`) and a new plan-lint code
(`TASK_DEPENDS_ON_CYCLE`). Patch releases are reserved for
bug fixes and doc-only changes; new flags and codes move the
minor.

### What stayed the same

- The `depends_on` schema type — still `string[]`.
- `task finalize` eligibility semantics — the gate is still
  "every dep's derived state is done"; the resolver just
  finds cross-phase deps too.
- `KNOWN_CODES.public` — unchanged. The new code goes under
  `KNOWN_CODES.plan` per the v1.0 additive-growth contract.
- Every existing diagnostic name, severity, and message
  shape (one message string changed from "not in the same
  phase" to "not in any phase" — no existing test asserts it).
- Default `phase runbook <id>` invocation — unchanged. The
  new `--across-phases` flag is purely additive.
- `progress.yaml` schema and contract — unchanged.
- `task context` pack output — byte-identical with v1.8.0
  (the cycle detection lives in `plan lint`, not in pack).
- Existing adapter manifests — unchanged. No re-install /
  upgrade required for the v1.9 release.

In semver terms, v1.9.0 is a minor release.

## v1.7.x → v1.8.0

### Quick path

```sh
# 1. Upgrade the CLI.
npm install -g code-pact@1.8.0

# 2. No project-side action is required. The v1.8 release is
#    purely additive — no schema changes, no breaking flag
#    changes, no error code renames, no existing-command
#    behaviour changes.
code-pact validate --json
```

### What's new

- **`code-pact spec import`** — the new top-level **Spec Kit
  bridge** command. Read-only, one-way importer for external
  spec-driven planning artifacts. Two modes:
  - `spec import --from <tasks.md> --phase-id <id> [--write]
    [--force] [--json]` parses a Heading 3 + `- [ ]` checkbox
    subset of Markdown into a draft phase YAML (printed to
    stdout on dry-run, persisted to `design/phases/<id>-
    imported.yaml` with `--write`).
  - `spec import --suggest-from <spec.md|plan.md> --json`
    extracts brief / constitution candidates without writing
    any file; the user pipes them into `plan brief --from-file`
    / `plan constitution --from-file` (v1.6 P17 non-interactive
    paths) if they accept them.
- **The importer does NOT add the generated phase to
  `design/roadmap.yaml`.** That stays an explicit follow-up
  governed by P14 (the chokepoint contract is preserved).
- **No new public error codes.** Failures all reuse
  `CONFIG_ERROR` with a structured `data.detail` enum
  (`unsafe_path` / `file_not_found` / `unreadable` /
  `phase_id_invalid` / `phase_yaml_exists` / `no_sections_parsed`
  / `mutex_violation` / `missing_phase_id`).
- **No schema changes.** Generated phase YAML is valid
  existing phase YAML. `plan lint`, `validate`, and every
  downstream consumer see imported phases as just another
  phase file.
- New docs: [`docs/spec-kit-bridge.md`](spec-kit-bridge.md)
  for the full walkthrough; the `## spec import (v1.8+)`
  section in [`docs/cli-contract.md`](cli-contract.md) for the
  envelope reference.

### Why this is a minor (1.8.0, not 1.7.1)

The release adds a new top-level Stable v1.0 command. Patch
releases (`1.x.y`) are reserved for bug fixes and doc-only
changes; new commands move the minor.

### What stayed the same

- `phase import`, `plan brief`, `plan constitution`, every
  other v1.0+ Stable command — **unchanged**. Same flags,
  same JSON envelopes, same exit codes, same error codes.
- `KNOWN_CODES.public` is unchanged.
- `progress.yaml` schema and contract — **unchanged**.
- `task context` pack output — **byte-identical** with v1.7.0
  (the spec-import module is tree-shaken until you actually
  invoke `spec import`).
- Existing adapter manifests — **unchanged**. No re-install /
  upgrade required for the v1.8 release.

In semver terms, v1.8.0 is a minor release.

## v1.6.x → v1.7.0

### Quick path

```sh
# 1. Upgrade the CLI.
npm install -g code-pact@1.7.0

# 2. (Optional) re-render every installed adapter's instruction file
#    to take the v1.7 agent-contract section. Use --accept-modified to
#    preserve any user edits to the file body.
code-pact adapter upgrade claude-code --check --json
code-pact adapter upgrade claude-code --write --accept-modified --json
# Repeat for codex / generic if installed.

# 3. (Optional) re-run adapter doctor to confirm no remaining
#    ADAPTER_CONTRACT_DRIFT warnings.
code-pact adapter doctor --json
```

### What's new

- **`## Agent contract` section in every stable adapter's
  instruction file** (claude-code, codex, generic). New
  load-bearing Markdown section between the per-task workflow
  and the next adapter-specific section. Names three axes
  verbatim (`### When to invoke code-pact`, `### What to verify
  first`, `### How to handle failures`) and references every
  v1.6 audit / non-interactive surface inline. Heading strings
  are English-locked across all locales; body text is localised
  in en-US and ja-JP.
- **Adapter conformance test extended.** `tests/integration/
  adapter-conformance.test.ts` gains four new assertions per
  stable adapter (section heading + 3 axis sub-headings +
  v1.6 surface references with body-slice scope + placement
  check). Test count moved from 21 to 31 adapter conformance
  assertions.
- **New `ADAPTER_CONTRACT_DRIFT` diagnostic** in
  `adapter doctor`. Soft signal (severity: warning, does NOT
  gate exit code). Independent of `ADAPTER_FILE_DRIFT` — both
  can fire on the same file with different remediations.
  Emitted when an instruction file is present but lacks the
  agent-contract section heading
  (`details: { kind: "section_missing" }`) or one of the three
  axis sub-headings
  (`details: { kind: "axes_incomplete", missing_axes: string[] }`).
- **`AdapterDoctorIssue` gains `details?: Record<string,
  unknown>`** field. Additive on the existing shape — consumers
  that read only `code` / `severity` / `message` / `agent` /
  `path` see no shape change. Mirrors the `PlanIssue.details`
  convention used by plan lint.

### Adoption pattern

The minimum action is **none**. Existing CI pipelines, agents,
and human workflows continue to behave byte-identically. The
new diagnostic is advisory; the conformance regex only fires
on adapter source changes.

To take the new agent-contract section into your installed
adapters:

```sh
# Preview the regen for each stable adapter you have installed.
code-pact adapter upgrade claude-code --check --json
code-pact adapter upgrade codex --check --json
code-pact adapter upgrade generic --check --json

# Apply. --accept-modified preserves any user edits to the body.
code-pact adapter upgrade claude-code --write --accept-modified --json
```

After upgrading, an agent that re-reads `CLAUDE.md` (or
`AGENTS.md` / `docs/code-pact/agent-instructions.md` for codex /
generic) will see the new `## Agent contract` section listing
the v1.6 surfaces it didn't previously know about
(`--audit-strict`, `--from-file`, `--stdin`, `write_audit`).

### Deferred to v1.8+

- **P15-T5 — `phase reconcile --json` write_audit exposure** —
  unchanged from v1.6.0 deferred status. Still pending a
  diff-attribution-across-tasks semantics RFC.
- **Auto-injection of the contract section on `adapter upgrade
  --write --accept-modified`** — currently the diagnostic
  surfaces missing sections but the user must rerun without
  `--accept-modified` (or hand-edit the section back) to apply.
  Surgical injection is a future refinement.
- **cursor / gemini-cli stable promotion** — both stay
  experimental.

### Backward-compatibility notes

- **Default invocations are byte-identical to v1.6.0** for every
  existing command.
- **No CLI flag changes, no schema changes, no exit-code
  changes.** The new diagnostic is severity: warning and never
  gates `adapter doctor`'s exit code.
- **The `ADAPTER_FILE_DRIFT` warning will fire** on
  `adapter upgrade --check` for every previously-installed
  stable adapter, since the instruction file body changed. This
  is expected — `--write` clears it.
- **Hand-edited instruction files**: `--accept-modified`
  continues to preserve user edits exactly as it did in v0.9+.
  The new `ADAPTER_CONTRACT_DRIFT` diagnostic surfaces
  separately if the user's edits removed the agent-contract
  section.
- **`tests/integration/json-stdout.test.ts`** continues to pass.

In semver terms, v1.7.0 is a minor release.

## v1.5.x → v1.6.0

### Quick path

```sh
# 1. Upgrade the CLI.
npm install -g code-pact@1.6.0

# 2. No mandatory action. Every new surface is opt-in and additive.
code-pact validate --json   # expect: ok
code-pact plan lint --json  # expect: ok (or new advisory warnings only)
```

### Two feature areas

v1.6.0 ships two independent feature phases:

- **P15 — Declared Writes Audit** (5 of 6 tasks): a read-only audit
  layer that compares a task's declared `writes` globs against the
  actual filesystem changes reported by git, surfaced via
  `task finalize --json`. Plus three new plan-lint advisories.
- **P17 — Non-interactive Authoring** (5 of 5 tasks, feature-complete):
  `plan brief` and `plan constitution` (previously TTY-only) gain
  three pairwise-mutually-exclusive non-interactive input modes
  apiece.

Both areas are **purely additive**. Existing CI pipelines, agents,
and human workflows continue to behave byte-identically until you
opt in to the new flags.

### P15 — Declared Writes Audit (what's new)

- **`task finalize --json` envelope gains `data.write_audit`.**
  Field-presence-fixed shape (`git_available`, `reason?`, `base_kind`,
  `base_ref`, `base_error?`, `files_touched`, `outside_declared`,
  `declared_unused`, `warnings`). Present on all three success kinds
  (`would_finalize` / `finalized` / `already_finalized`) when `--json`
  is in effect. Default range is the working tree; pass `--base-ref
  <ref>` for branch-level audit via `git merge-base`. Non-git projects
  return the canonical unavailable shape.
- **`task finalize --base-ref <ref>` flag** (Stable v1.6+). Requires
  `--json`; merge-base failures gracefully fall back to working-tree
  mode with a `base_error` field. Exit code unchanged in either path.
- **`task finalize --audit-strict` flag** (Stable v1.6+). Opt-in
  promotion: warnings present + `--audit-strict` set → exit **1**
  with `WRITES_AUDIT_STRICT_FAILED`, and **no design YAML mutation**
  (even with `--write`). Requires `--json`. Default invocations
  (no flag) stay advisory.
- **Three new advisory plan-lint warning codes**:
  - `TASK_WRITES_AUDIT_OUTSIDE_DECLARED` — real filesystem changes
    touched a file matched by no declared `writes` glob. Emitted in
    `data.write_audit.warnings[]`.
  - `TASK_WRITES_AUDIT_DECLARED_UNUSED` — a declared glob matched no
    file in `files_touched`. Same emission path.
  - `TASK_WRITES_OVER_BROAD` — declared glob's root segment is `**`
    (matches the entire repo). Emitted by `plan lint`.
- **One new public error code**: `WRITES_AUDIT_STRICT_FAILED`
  (exit 1, `task finalize --audit-strict` only).
- **Configurable protected paths** via `design/rules/protected-paths.md`.
  Optional file; absent file → hardcoded v1.5 defaults (no change for
  existing projects). When present, the file is the source of truth
  (defaults are NOT layered on top). One glob per line, P10 supported
  subset, `#` comments. Affects `TASK_WRITES_PROTECTED_PATH` lint
  emission.

### P17 — Non-interactive Authoring (what's new)

- **`plan brief` and `plan constitution`** each gain three
  non-interactive input modes (Stable v1.6+):
  - `--from-file <yaml>` — read typed YAML from disk.
  - `--stdin` — read typed YAML from `process.stdin`.
  - Flag-driven — `--what` / `--who` / `--differentiator` for brief;
    `--description` / `--principle` (repeatable) for constitution.
  All three are pairwise mutually exclusive; passing any combination
  returns `CONFIG_ERROR` (exit 2). Output is byte-identical to the
  TTY wizard for equivalent input.
- **Schema differences between brief and constitution**:
  - `BriefFileSchema`: `what` and `who` required (non-empty);
    `differentiator` optional. Empty required-field values are
    rejected.
  - `ConstitutionFileSchema`: both `description` and `principles[]`
    are optional. Empty values fall through to the locale template
    defaults — same as the wizard's empty-input behaviour.
- **Failure envelopes** are parallel across both commands:
  `--from-file` failures carry `data: { detail, path }`; `--stdin`
  failures carry `data: { detail, source: "stdin" }`; flag-driven
  failures (brief only) carry `data: { missing: string[] }`.
- **TTY wizards are unchanged.** Non-TTY without one of the new
  flags continues to return `CONFIG_ERROR` exactly as in v1.5.1;
  the guidance message now lists the three v1.6+ alternatives.

### Adoption patterns

**Audit (opt-in)**:

```sh
# Single-task review at finalize time (working-tree mode).
code-pact task finalize <task-id> --json | jq .data.write_audit

# Branch-level review (compares against main's merge-base).
code-pact task finalize <task-id> --json --base-ref main \
  | jq .data.write_audit

# Strict gate for CI — exit 1 if audit emits any warning.
# In CI (working tree is clean / commits are pushed), combine with
# --base-ref <default-branch> so the audit compares against the
# merge-base; without --base-ref the audit only sees uncommitted
# changes and `TASK_WRITES_AUDIT_DECLARED_UNUSED` will fire for any
# task that declares writes the working tree doesn't currently dirty.
code-pact task finalize <task-id> --json --audit-strict --write --base-ref origin/main

# Local pre-commit review (uncommitted working tree is the audit target):
code-pact task finalize <task-id> --json --audit-strict --write
```

**CI bootstrap (opt-in)**:

```sh
code-pact init --non-interactive --agent claude-code --locale en-US --json
code-pact plan brief \
  --what "What we're building" \
  --who  "Who it's for" \
  --differentiator "What makes it different" \
  --json
code-pact plan constitution \
  --description "Project description" \
  --principle "First principle" \
  --principle "Second principle" \
  --json
```

### Deferred to v1.7+

- **P15-T5 — `phase reconcile --json` write_audit exposure.** The
  "diff attribution across multiple tasks" problem (a single
  working-tree diff cannot be sharded across tasks deterministically)
  needs its own semantics RFC. The use case overlaps with running
  `task finalize --audit-strict` per task — the marginal value beyond
  per-task strictness is unclear. P15 phase status stays
  `in_progress` until this ships or is explicitly closed.

### Backward-compatibility notes

- **Default invocations are byte-identical to v1.5.1.** Human-mode
  `task finalize` does not spawn git, does not compute the audit,
  produces the same stdout / stderr.
- **`task complete` is unchanged.** The hot path is deliberately
  not augmented — `verify` remains the single failure signal there.
- **`phase reconcile --json` is unchanged.** P15-T5 deferred.
- **TTY wizards for `plan brief` / `plan constitution` are
  unchanged.** Same prompts, same locale fallbacks, same output.
- **The dogfood corpus may surface `TASK_WRITES_AUDIT_OUTSIDE_DECLARED`
  / `_DECLARED_UNUSED` advisories.** This is the expected behaviour,
  not a breakage — releases that touch files outside the active
  task's declared writes will see them flagged. The exit code stays
  0 unless `--audit-strict` is opted into.
- **`progress.yaml` schema is unchanged.** No new event types, no
  SHA recording at task start. That schema change stays deferred
  (the append-only contract vs rebase invariance trade-off needs
  its own RFC).
- **`KNOWN_CODES.public` extension is additive: one new code**
  (`WRITES_AUDIT_STRICT_FAILED`). `KNOWN_CODES.plan` gains three
  new advisory warning codes. Every existing code is unchanged.
- **`tests/integration/json-stdout.test.ts` continues to pass.**
  Every new envelope field is additive on the v1.0 contract.

In semver terms, v1.6.0 is a minor release.

## v1.4.x → v1.5.0

### Quick path

```sh
# 1. Upgrade the CLI.
npm install -g code-pact@1.5.0

# 2. No mandatory action for single-process users. All existing flag
#    invocations, JSON envelopes, and error codes are preserved on
#    the success path. The new failure modes (LOCK_HELD on concurrent
#    invocations; CONFIG_ERROR on `phase add --id TUTORIAL`) only fire
#    in genuinely new conditions.
code-pact validate --json   # expect: ok
code-pact plan analyze --json
```

### What's new in v1.5.0

P14 (Governance) closes the "who can write what, and when" question that v1.4 left implicit. The full design rationale lives in [`design/decisions/governance-rfc.md`](../design/decisions/governance-rfc.md); the agent- and reviewer-facing walkthrough is [`docs/concepts/governance.md`](concepts/governance.md). The headline shipped surface:

- **Advisory write lock** at `.code-pact/locks/write.lock`, acquired by every design-mutating command (`init --sample-phase`, `init` wizard, `phase add`, `phase new`, `phase import`, `task add`, `task finalize --write`, `phase reconcile --write`). Concurrent invocations against the same project fail fast with the **new public error code `LOCK_HELD`** (exit 2) and a diagnostic envelope carrying `data.lock_holder` (`{pid, hostname, cmd, created_at}`) + `data.lock_path`. Read-only commands (`plan lint`, `plan analyze`, `task runbook`, `phase runbook`, `validate`, `doctor`, `recommend`, `task context`, `task status`) do NOT acquire the lock. `phase import` holds a single outer lock around its multi-phase apply loop (batch transactionality).
- **Reserved phase id `TUTORIAL`** at the governance layer. `init --sample-phase` is the only sanctioned creation path; `phase add --id TUTORIAL`, `phase new` typing `TUTORIAL`, and `phase import` containing a `TUTORIAL` entry all raise `CONFIG_ERROR` (exit 2) at creation time. Existing TUTORIAL phases in v1.4.x projects are untouched.
- **Roadmap mutation policy** documented. The four `createPhase` callers (`init` sample-phase path, `phase add`, `phase new`, `phase import`) are the only code paths that mutate `design/roadmap.yaml`. This was structurally true in v1.4 too; v1.5 documents it.
- **Phase status manual-flip convention** formalized. `phase reconcile --write` flips task statuses; the phase's own `status` field is hand-edited in the release-prep PR. Auto-flip is deferred to a future RFC.
- **Protected-path strict-mode posture** documented (no code change). `plan lint --strict` already promotes `TASK_WRITES_PROTECTED_PATH` to exit-relevant via the existing binary promotion. v1.5.1 later tightens this repo's own dogfood posture to strict-clean by removing stale historical protected-path declarations.
- **Declared writes as a governance review surface** documented (no code change). `declared_writes[]` in `task finalize --json` / `task runbook --json` envelopes is a review signal for `git diff`-style PR comparison, not runtime enforcement. Actual write enforcement requires a runner or VCS integration; P15+ scope.
- **Internal refactor:** the task→phase resolver (TASK_NOT_FOUND / AMBIGUOUS_TASK_ID) is extracted to `src/core/plan/resolve-task.ts` and shared across all eight `task-*` commands. Same error codes, same message shape, same `.phases` array on ambiguity — pure refactor, invisible to consumers.

### Recommended adoption pattern

**Single-process users:** no action. Continue using `code-pact` exactly as in v1.4.x. The lock is created and released within a single command invocation and is invisible from the outside.

**Multi-process / agent-orchestration automation:** add `LOCK_HELD` to the transient-retry list. The envelope's `data.lock_holder` is the right signal for backoff (the human-readable cmd field can be logged for debugging; the `pid` + `created_at` pair lets a sufficiently old lock be flagged for manual recovery, though P14 itself does NOT auto-detect stale locks). Example handling:

```sh
code-pact phase reconcile P14 --write --json
# If exit 2 + envelope.error.code === "LOCK_HELD":
#   - Inspect envelope.data.lock_holder.cmd to decide whether to wait or
#     report a stuck process.
#   - On wait + retry, the second invocation succeeds once the holder
#     releases.
```

**CI under `plan lint --strict`:** no new errors and no new warnings. v1.5.0 introduces **zero new plan diagnostic codes** and **zero new severity changes**. The single new public error code (`LOCK_HELD`) only fires on concurrent invocations, which CI typically does not run.

**`phase add --id TUTORIAL` / `phase import` containing `TUTORIAL`:** now returns `CONFIG_ERROR` exit 2. If you genuinely want a phase named `TUTORIAL`, pick a different id — the recommended sanctioned path is `init --sample-phase`. Existing v1.4.x projects with a TUTORIAL phase (whether sample-phase artifact or otherwise) are untouched; the block only fires on new creation.

**Release prep:** continue using the v1.4 release-prep mechanization. The v1.5 governance additions do NOT change the release-prep loop:

1. Bump version + write CHANGELOG.
2. `code-pact phase reconcile <phase-id> --write --json` — flips every eligible task in one shot. Now serialized by the lock against any concurrent mutations.
3. Hand-edit the phase's own `status` field — formalized as the convention in v1.5 (auto-flip deferred to future RFC).
4. Hand-edit `design/roadmap.yaml` if a phase weight or status moved.
5. Commit + PR.
6. Run strict self-checks in v1.5.1+ release prep: `plan lint --include-quality --strict --json`, `plan analyze --strict --json`, `validate --json`, and `doctor --json`.

### Stale lock recovery (manual in v1.5)

If a `code-pact` command crashes without releasing the lock (e.g. SIGKILL, OS-level crash), the lock file persists. v1.5 does NOT auto-detect this. Manual recovery:

1. Verify no `code-pact` command is running (check process list).
2. Delete `.code-pact/locks/write.lock`.
3. Re-run the command.

Automation (PID liveness check, age-based stale detection, a `--force-lock` flag) is deferred to a future RFC. The conservative manual-recovery default in v1.5 avoids races where two processes both decide the other is stale.

### New `KNOWN_CODES.public` entries (additive)

v1.5.0 grows the public error-code surface by exactly **one** entry:

| Code | Exit | Description |
| --- | --- | --- |
| `LOCK_HELD` | 2 | Another `code-pact` mutation is in progress on the same project. Diagnostic data in `data.lock_holder` + `data.lock_path`. Transient + retryable |

No existing code is renamed, recategorized, or has its severity changed. The full public surface remains additive.

### Backward compatibility

- `init` / `phase add` / `phase new` / `phase import` / `task add` / `task complete` / `task finalize` / `phase reconcile` / `task context` / `task start` / `task block` / `task resume` / `task status` / `task runbook` / `phase runbook` / `plan lint` / `plan analyze` / `plan normalize` / `plan prompt` / `validate` / `doctor` / `recommend` — **success-path behaviour unchanged**. Same flags, JSON envelope, exit codes.
- **New failure modes (transient + targeted):**
  - Design-mutating commands may now return `LOCK_HELD` (exit 2) under concurrent invocation. Single-process users see no change.
  - `phase add --id TUTORIAL` / `phase new` typing `TUTORIAL` / `phase import` containing `TUTORIAL` → `CONFIG_ERROR` (exit 2). Existing projects with TUTORIAL phases are untouched.
- **`progress.yaml`** remains read-only for the new lock. The append-only operational-log contract is preserved unchanged; `task complete` / `task start` / `task block` / `task resume` do NOT acquire the lock.
- **`task context` pack output** is unchanged. The byte-identical pack regression test passes without modification.
- **`tests/integration/json-stdout.test.ts`** continues to pass for every Stable command. New entries added for the LOCK_HELD envelope and TUTORIAL reserved-id `CONFIG_ERROR` paths.
- **`KNOWN_CODES.public`** gains exactly one new entry (`LOCK_HELD`). No existing code is renamed or recategorized.
- **No new task or phase schema field.** v1.4.x phase YAMLs parse and behave identically.
- **The task→phase resolver refactor is invisible.** Existing per-command unit tests pass unchanged — that's the load-bearing safety check.

In semver terms, v1.5.0 is a **minor** release.

## Deferred beyond v1.5

The following remain on the backlog after v1.5.0:

- Removal of bare-form `code-pact adapter`.
- Multi-agent orchestration / MCP / GitHub-Linear-Jira sync.
- **Auto-detection of stale advisory write locks** (PID liveness check, age-based stale detection, a `--force-lock` flag). v1.5.0 ships the lock with manual-recovery only — if a process crashes mid-lock, the user manually deletes `.code-pact/locks/write.lock`. Auto-detection is subtle (two processes can both decide the other is stale) and was deferred to a future RFC.
- **Enforcement of declared `writes` against actual file-system writes.** v1.1+ surfaces `TASK_WRITES_PROTECTED_PATH` as a warning against a hardcoded seed set. v1.2+/v1.3+ display declared `writes` in `task finalize` / `task runbook` JSON envelopes; v1.5 (P14-T3) explicitly framed this as a review surface, not enforcement. Actual enforcement requires either a runner that observes file-system writes during command execution or a VCS-diff integration; both are significant scope expansions and remain P15+.
- **Configurable protected paths.** `PROTECTED_PATHS` (`.git/**`, `node_modules/**`, `.code-pact/**`, `design/roadmap.yaml`, `design/phases/*.yaml`) stays hardcoded in v1.5. A `project.yaml`-driven override is a P15+ candidate.
- **Configurable reserved-id list.** v1.5 reserves `TUTORIAL` and only `TUTORIAL`. Configurable lists require schema design and are deferred.
- **`RESERVED_ID_USAGE` advisory plan-lint diagnostic on existing TUTORIAL phases.** v1.5 only blocks creation time; existing TUTORIAL phases in user projects are not flagged. An advisory warning for existing data is a future-RFC candidate.
- **Selective per-code `--strict` promotion.** v1.5 uses the existing binary promotion (`errors + warnings === 0`). A future flag like `--strict-code TASK_WRITES_PROTECTED_PATH` (promote one specific code without promoting all warnings) is P15+ if signal emerges.
- **Cross-phase `depends_on`.** v1.1+ ships same-phase only; cross-phase task ordering is a future extension. v1.3.0 surfaces `depends_on` in `task runbook` blocking steps but does not extend the same-phase restriction.
- **File-content inclusion for `reads` and `acceptance_refs`.** v1.1+ renders both as path lists only; v1.5 keeps that surface unchanged.
- **Phase status auto-flip.** v1.2+ reports `phase_status_candidate` as advisory but never writes the phase's own `status` field. v1.3.0 `phase runbook` surfaces the same candidate plus a `manual_action` recommending the flip; it does not write either. v1.5 formalized manual-flip as the convention (see [`docs/concepts/finalization-reconciliation.md`](concepts/finalization-reconciliation.md#phase-status-remains-manual-in-v12--formalized-as-the-convention-in-v15--p14) and [design/decisions/governance-rfc.md](../design/decisions/governance-rfc.md) § Phase status policy). An `--include-phase-status` opt-in (or a separate `phase finalize` command) is a future RFC candidate.
- **Multi-phase reconcile / runbook (`--all`).** v1.2 / v1.3 / v1.4 / v1.5 ship per-phase only.
- **`design/roadmap.yaml` mutation beyond `createPhase`.** v1.5 documents the four `createPhase` callers as the only roadmap writers (P14 § Roadmap mutation policy). Whether release prep should be able to delegate per-phase weight / status flips to a `roadmap reconcile` command remains a future RFC.
- **Cross-phase / multi-project locking.** v1.5 ships single project, single lock file. Coordinating mutations across multiple `code-pact` projects on the same machine is not addressed.
- **Progress.yaml write locks.** v1.5 leaves `task complete` / `task start` / `task block` / `task resume` lock-free because the append-only contract makes them safe under interleaving (worst case = event reordering, not corruption). Adding a lock to those high-frequency paths would have overhead without integrity benefit; future work would need a different motivation.
- **Semantic validation of `acceptance_refs` content.** v1.2+ only checks the path exists; richer validation would couple finalize to acceptance-criteria format choices the project has not yet made.
- **Runbook execution (`task runbook --execute`).** v1.3.0 is proposal-only by design. A future RFC may revisit a flag that runs each recommended step automatically, but only after the proposal-only contract has been used through more release cycles.
- **Schema-level `human_gate` field.** v1.3.0 expresses manual checkpoints as `RunbookStep` content (`command: null` + `manual_action: "..."`). Promotion to a task-schema field requires more usage signal.
- **`task next` / `phase next` sugar aliases.** v1.3.0+ ships `runbook` as the explicit primary name. Short-form aliases remain a future candidate.
- **Bundling `recommend` into `task runbook`.** v1.3.0+ keeps them as separate commands answering different questions. Bundling remains a future candidate once usage signal emerges.
- **`task add --status` flag.** P13 explicitly does not expose `--status`. Newly added tasks are always `status: planned`. Historical / migrated tasks must use `phase import`. Preserves the P11/P12 contract that design `done` is the result of `task finalize` / `phase reconcile`, not a starting point.
- **`task add --dry-run`.** Not enough signal yet; revisit if needed.
- **`plan brief` / `plan constitution` non-TTY alternatives.** Designed as interactive by intent; non-TTY users can hand-edit `design/brief.md` / `design/constitution.md`. Code-level alternatives remain future scope.
- **Init / wizard / task-add UX polish beyond P13.** P13 closed the scripted-bootstrap gap and the partial-flags / silent-fallthrough footgun; further polish (e.g. `init --mode tutorial` sugar alias, `task add --dry-run`) remains future scope.
- **Runbook integration with a runbook orchestrator (`task run` / `phase close`).** v1.5 keeps `task runbook` / `phase runbook` as user-callable read-only commands. A future runbook orchestrator that consumes them is out of scope.
- Semver-aware `ADAPTER_GENERATOR_STALE` (current implementation is simple equality).
- Conformance test inclusion for `cursor` / `gemini-cli` adapters — they remain Experimental.

**Closed in v1.5 (P14):**

- ~~Advisory write locks for concurrent process safety~~ — shipped as `LOCK_HELD` (see § v1.4.x → v1.5.0).
- ~~Hard reservation of `TUTORIAL` id~~ — shipped as creation-time `CONFIG_ERROR` block.
- ~~Roadmap mutation policy documentation~~ — shipped in [`docs/cli-contract.md` § Roadmap mutation policy](cli-contract.md#roadmap-mutation-policy-v15--p14) + [`docs/concepts/governance.md`](concepts/governance.md).
- ~~Phase status manual-flip formalization~~ — shipped in [`docs/concepts/finalization-reconciliation.md` § Phase status remains manual…](concepts/finalization-reconciliation.md#phase-status-remains-manual-in-v12--formalized-as-the-convention-in-v15--p14).
- ~~Task→phase resolver core extraction~~ — shipped as internal-only refactor (`src/core/plan/resolve-task.ts`); pure refactor with no observable behaviour change.

A previously deferred item, **promoting `assertSafeRelativePath` / `resolveWithinProject` to a neutral module**, was partially closed in v1.1.0 (P10-T3): the helpers now live at `src/core/path-safety.ts` and are imported by plan lint for the new `decision_refs` / `reads` / `writes` / `acceptance_refs` validation. The adapter file re-exports them so existing call sites are unchanged. Extension of these helpers to the broader project state tree (design / progress file writes) remains future scope.

See [`docs/cli-contract.md` § Stability taxonomy](cli-contract.md#stability-taxonomy-v10) for the full list of stability bands per command and the criteria a v1.x command must meet to move between them.
