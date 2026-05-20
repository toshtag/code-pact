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

## Deferred beyond v1.1

The following remain on the backlog after v1.1.0:

- Removal of bare-form `code-pact adapter`.
- Multi-agent orchestration / MCP / GitHub-Linear-Jira sync.
- Advisory write locks for concurrent process safety.
- **Enforcement of declared `writes` against actual file-system writes.** v1.1.0 surfaces `TASK_WRITES_PROTECTED_PATH` as a warning against a narrow built-in seed set (`.git/**`, `node_modules/**`, `.code-pact/**`, `design/roadmap.yaml`, `design/phases/*.yaml`). Configurable governance and warning → error promotion are P14 work.
- **Cross-phase `depends_on`.** v1.1.0 ships same-phase only; cross-phase task ordering is a future extension.
- **File-content inclusion for `reads` and `acceptance_refs`.** v1.1.0 renders both as path lists only; the content-inclusion path is a future RFC.
- **`task finalize` / `phase reconcile`.** The "design YAML is intent; progress.yaml is fact" split documented in [§ `task complete` records progress, but does NOT mutate design YAML](#task-complete-records-progress-but-does-not-mutate-design-yaml) is preserved. v1.1.0 does not yet ship a command that mutates design status from progress evidence. P11 owns that work.
- Semver-aware `ADAPTER_GENERATOR_STALE` (current implementation is simple equality).
- Conformance test inclusion for `cursor` / `gemini-cli` adapters — they remain Experimental.

A previously deferred item, **promoting `assertSafeRelativePath` / `resolveWithinProject` to a neutral module**, was partially closed in v1.1.0 (P10-T3): the helpers now live at `src/core/path-safety.ts` and are imported by plan lint for the new `decision_refs` / `reads` / `writes` / `acceptance_refs` validation. The adapter file re-exports them so existing call sites are unchanged. Extension of these helpers to the broader project state tree (design / progress file writes) remains P14 governance scope.

See [`docs/cli-contract.md` § Stability taxonomy](cli-contract.md#stability-taxonomy-v10) for the full list of stability bands per command and the criteria a v1.x command must meet to move between them.
