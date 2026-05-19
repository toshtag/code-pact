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

## Deferred to v1.1+

The following are **not** addressed by v1.0 and remain on the backlog:

- Removal of bare-form `code-pact adapter`.
- Multi-agent orchestration / MCP / GitHub-Linear-Jira sync.
- Advisory write locks for concurrent process safety.
- Extending adapter-style path-safety helpers (`assertSafeRelativePath` / `resolveWithinProject`) to the broader project state tree. The v1.0 path-safety hardening is intentionally scoped to adapter-managed generated file writes, because adapters are the surface that writes user-visible paths derived from generator output. Existing design / progress files remain protected by their existing schema validation and atomic-write behaviour; extending the adapter-style helpers to them is deferred unless a concrete risk appears.
- Semver-aware `ADAPTER_GENERATOR_STALE` (current implementation is simple equality).
- Conformance test inclusion for `cursor` / `gemini-cli` adapters — they remain Experimental.

See [`docs/cli-contract.md` § Stability taxonomy](cli-contract.md#stability-taxonomy-v10) for the full list of stability bands per command and the criteria a v1.x command must meet to move between them.
