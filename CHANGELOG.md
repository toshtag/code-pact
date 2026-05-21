# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/). The
v0.1.0-alpha through v0.9.0-alpha line used `MAJOR.MINOR.PATCH-alpha.N`
identifiers. Starting with v1.0.0, stable releases use plain
`MAJOR.MINOR.PATCH` and prereleases (if any) use the standard
`-rc.N` / `-beta.N` suffixes.

---

## [Unreleased]

### Added

- **`task finalize --json` emits `data.write_audit`** (v1.6+, P15-T1). Read-only
  advisory comparing the task's declared `writes` globs against the actual
  filesystem changes reported by git. Present on all three success kinds
  (`would_finalize` / `finalized` / `already_finalized`) when `--json` is in
  effect. Default range is the working tree (HEAD vs staged / unstaged /
  untracked); pass `--base-ref <ref>` to opt into branch-level audit via
  `git merge-base HEAD <ref>`. Non-git projects return the canonical
  unavailable shape (`git_available: false`); merge-base failures gracefully
  fall back to working-tree mode with a `base_error` field. Exit code is
  **unchanged** in P15-T1 — the audit is advisory only.
- **`task finalize --base-ref <ref>` flag** (v1.6+, P15-T1). Requires `--json`;
  passing it without `--json` returns `CONFIG_ERROR` (exit 2). The flag is
  additive; existing `task finalize` invocations are byte-identical.
- **`TASK_WRITES_AUDIT_OUTSIDE_DECLARED` warning code** (v1.6+, P15-T1) added
  to `KNOWN_CODES.plan`. Emitted in `data.write_audit.warnings[]` when the
  audit detects a file change outside any declared `writes` glob. Severity:
  warning, never exit-relevant in P15-T1.
- **`src/core/audit/write-audit.ts`** new internal module exposing
  `auditWrites({ cwd, declaredWrites, baseRef? })`. Reused by future P15
  tasks for `phase reconcile --json` (P15-T5) and `--audit-strict` (P15-T6).
- **`TASK_WRITES_OVER_BROAD` plan-lint warning** (v1.6+, P15-T2). Flags
  declared `writes` globs whose root path segment is `**` — patterns that
  match the entire repository (e.g. `**`, `**/*`, `**/*.ts`, `**/foo.ts`).
  Legitimate task-scoped globs (`src/core/audit/**`, `src/**/*.ts`,
  `tests/unit/**`) have a concrete root segment and pass unchanged.
  Severity: warning, advisory in default `plan lint`; exit-relevant under
  `plan lint --strict` per the existing binary promotion. Heuristic-only:
  the goal is to catch obvious "writes everywhere" declarations, not to
  encode a precise breadth metric.
- **`plan brief --stdin`** (v1.6+, P17-T2). Reads the same YAML schema as
  `--from-file` from `process.stdin` instead of a file. Useful for piping
  brief content from another process (`some-tool | code-pact plan brief
  --stdin --json`). Mutually exclusive with `--from-file` — passing both
  returns `CONFIG_ERROR` (exit 2). Failure envelope mirrors `--from-file`
  with `source: "stdin"` replacing the `path` field; detail enum is
  `stdin_read_failed | invalid_yaml | schema_invalid` (the `unsafe_path`
  / `unreadable` details do not apply to stdin). The internal
  YAML-parse / schema-validate pipeline is factored out as
  `parseBriefSource` and shared by both the file and stdin paths;
  loaders supply their own error constructor as a callback. Brief.md
  produced via `--stdin` is byte-identical to one produced by the
  wizard or `--from-file` for equivalent input. The non-TTY guard
  message now mentions both flags. Wizard path unchanged.
- **`plan brief --from-file <yaml>`** (v1.6+, P17-T1). Non-interactive
  input path for `plan brief`. Reads a typed YAML file (`what` / `who` /
  `differentiator`), bypasses the TTY check, and writes `design/brief.md`
  via the existing `generateBriefMd` template — byte-identical to the
  wizard's output for equivalent input. Schema is strict: unknown keys
  rejected; `what` and `who` required non-empty; `differentiator`
  optional (defaults to the wizard's empty-input placeholder). All four
  failure modes (`unsafe_path` / `unreadable` / `invalid_yaml` /
  `schema_invalid`) return `CONFIG_ERROR` (exit 2) with the structured
  envelope `{ ok: false, error: { code: "CONFIG_ERROR", message },
  data: { detail, path } }`. Partial-write-safe: any failure yields
  no write to `design/brief.md`. Wizard path unchanged; the v1.5.1
  contract that non-TTY without `--from-file` returns CONFIG_ERROR is
  preserved. Foundation for P17-T2 (`--stdin`), P17-T3 (flag-driven),
  and P17-T4 (apply the same three paths to `plan constitution`).
- **`TASK_WRITES_AUDIT_DECLARED_UNUSED` warning code** (v1.6+, P15-T4)
  added to `KNOWN_CODES.plan`. Promotes the `declared_unused` data
  field on `task finalize --json`'s `write_audit` envelope from
  data-only to an advisory warning, emitted whenever a declared
  `writes` glob has zero matches in `files_touched`. Fires
  independently of `TASK_WRITES_AUDIT_OUTSIDE_DECLARED` — a single
  audit can emit both. Advisory only: never alters the exit code in
  v1.6 (the `--audit-strict` flag in P15-T6 opts into exit-relevant
  enforcement). Underlying `write_audit` shape is unchanged;
  consumers that only inspect `declared_unused` / `outside_declared`
  / `files_touched` / `base_kind` / `base_ref` see no contract
  change. Signal interpretation: `declared_unused` usually means the
  declaration is stale, the task was partially split across PRs, or
  the planning artifact drifted from reality — exactly the pattern
  P15-T1's audit caught on P15-T2 / P15-T3 in their own PRs.
- **Configurable protected paths via `design/rules/protected-paths.md`**
  (v1.6+, P15-T3). New `src/core/rules/protected-paths.ts` loader reads
  the optional rule file (one glob per line, `#` comments, P10 supported
  subset) and feeds it into `TASK_WRITES_PROTECTED_PATH` lint emission.
  When the file is **absent**, the hardcoded `PROTECTED_PATHS` constant
  in `src/core/glob.ts` remains the fallback — v1.5 behaviour is
  preserved. When the file is **present but contains zero valid
  entries**, the list is treated as explicit "no protected paths" (the
  loader does NOT silently revert to defaults; delete the file instead).
  Malformed entries (unsafe paths, glob syntax outside the P10 subset)
  are silently skipped. `synthesizeSample` is promoted from a private
  helper in `glob.ts` to a named export so the loader can attach
  concrete samples to its entries (consumed by the overlap heuristic).
  Both `findProtectedPathOverlaps` and `detectTaskWritesProtectedPath`
  accept an optional `protectedPaths` parameter; omitting it preserves
  the v1.5 behaviour. The code-pact dogfood corpus now ships
  `design/rules/protected-paths.md` mirroring the defaults — the
  effective lint behaviour is unchanged.

### Changed

- **`docs/cli-contract.md`** documents the new `write_audit` field, the
  `--base-ref` flag, and the new warning code. The field-presence-by-kind
  table for `task finalize` now lists `write_audit` as additive optional.
- **`design/roadmap.yaml`** registers P15 (Declared Writes Audit, weight 25).
- **`design/phases/P15-declared-writes-audit.yaml`** new phase YAML covering
  T1 through T6 (T1 in_progress, T2–T6 planned).

Human-mode `task finalize` (without `--json`) is byte-identical to v1.5.1:
the audit is JSON-only, never spawns git in human mode, and never alters
exit codes or stdout content.

---

## [1.5.1] — 2026-05-21

**Cleanup patch.** Conservative maintenance release: no new public commands,
flags, error codes, or JSON envelope fields.

### Changed

- Enabled unused TypeScript symbol checks in `tsconfig.json` and removed the
  current unused import/helper noise.
- `Roadmap.PhaseRef.path` now accepts only safe project-relative
  `design/phases/*.yaml` paths.
- `verify.commands` now executes documented shell command strings, preserving
  quoted arguments while keeping stdout/stderr captured and bounded.
- CI now runs the full gate on Node 22 and a compatibility smoke path on Node
  24. Unit and integration tests are split, and integration tests consume one
  prebuilt `dist/cli.js` instead of rebuilding inside multiple suites.
- The dogfood corpus is strict-clean for
  `plan lint --include-quality --strict`; stale historical protected-path
  declarations were removed from completed meta-design tasks.
- Docs now distinguish unlocked `progress.yaml` appends from locked design
  mutations, describe `pack` as a low-level stable command with `task context`
  preferred, and clarify that `verify.commands` is trusted local project
  configuration.
- **`package.json`** — version `1.5.0` → `1.5.1`. (this release prep)

---

## [1.5.0] — 2026-05-21

**Governance.** Minor release that closes the "who can write what, and when" question that v1.4 left implicit. Single deliberately small surface: one new public error code (`LOCK_HELD`), one creation-time reservation (`TUTORIAL`), one pure refactor (resolver core), and three docs-only governance decisions (protected-path strict-mode posture, declared writes as a review surface, phase status manual-flip convention). No new commands. No new schema fields. No behavioural changes to existing Stable commands on the success path.

Concurrent design-mutating invocations against the same project now fail fast with `LOCK_HELD` (exit 2) carrying a diagnostic struct (`pid`, `hostname`, `cmd`, `created_at`, lock file path). `phase add --id TUTORIAL` / `phase new` typing `TUTORIAL` / `phase import` containing a TUTORIAL entry now raise `CONFIG_ERROR` (exit 2) at creation time — `init --sample-phase` is the only sanctioned path for the reserved id. Existing v1.4.x projects with a TUTORIAL phase are untouched; the block only fires on new creation.

### CLI behavior changes

The existing Stable surface is unchanged on the success path. The new failure modes are transient + targeted:

- Design-mutating commands (`init --sample-phase`, `init` wizard, `phase add`, `phase new`, `phase import`, `task add`, `task finalize --write`, `phase reconcile --write`) may now return `LOCK_HELD` (exit 2) under concurrent invocation. Single-process users see no change.
- `phase add --id TUTORIAL` / `phase new` wizard typing `TUTORIAL` / `phase import` containing a `TUTORIAL` entry → `CONFIG_ERROR` (exit 2). Reuses the existing error code; no new code for this path.

`tests/integration/json-stdout.test.ts` continues to pass for every Stable command; new entries added for the LOCK_HELD envelope and TUTORIAL reserved-id CONFIG_ERROR paths. `tests/unit/error-code-surface.test.ts` grows by exactly **one** entry (`LOCK_HELD`).

### Added

- **`LOCK_HELD`** as a new public error code (`tests/unit/error-code-surface.test.ts` KNOWN_CODES.public). The envelope is `{ ok: false, error: { code: "LOCK_HELD", message }, data: { lock_holder: { pid, hostname, cmd, created_at } | null, lock_path: string } }`. The single addition to the v1.5 public surface lock. ([#122])
- **`src/core/locks/write-lock.ts`** — new module exposing `acquireWriteLock(cwd, cmd): Promise<LockHandle>` and `isLockHeldError` type guard. Atomic exclusive create via `fs.writeFile(..., { flag: "wx" })` (cross-platform safe; no POSIX flock dependency, no new runtime package). Lock content is JSON `{pid, hostname, cmd, created_at}`. On EEXIST throws `LockHeldError` with `.code === "LOCK_HELD"`, `.lock_holder` (or `null` for corrupt lock files), and `.lock_path`. Test escape: `CODE_PACT_DISABLE_LOCKS=1` short-circuits to a no-op handle — undocumented in public surfaces (test-only). ([#122])
- **`withWriteLock` helper in `src/cli.ts`** — wraps the seven design-mutating CLI handlers. Acquires the lock at the CLI command-handler level (not inside `createPhase` or other core services). `phase import` holds a single outer lock around its multi-phase apply loop (batch transactionality — every `createPhase` call inside runs under the same acquisition). `task finalize` and `phase reconcile` dry-runs do NOT acquire the lock; only `--write` invocations do. Read-only commands (`plan lint`, `plan analyze`, `task runbook`, `phase runbook`, `validate`, `doctor`, `recommend`, `task context`, `task status`) never acquire the lock and can be used to observe state while a mutation is pending. ([#122])
- **`tests/setup.ts` + `vitest.config.ts setupFiles`** — sets `process.env.CODE_PACT_DISABLE_LOCKS = "1"` for the bulk of the suite so unrelated tests don't accidentally acquire real locks. Lock-specific tests (`tests/unit/core/locks/write-lock.test.ts`, the LOCK_HELD integration entry in `tests/integration/json-stdout.test.ts`) delete the env var in `beforeEach` to exercise the real acquisition path. ([#122])
- **`RESERVED_PHASE_IDS = ["TUTORIAL"]` in `src/core/services/createPhase.ts`** + internal-only `_isSampleCreation?: boolean` bypass flag. `writeSamplePhase()` in `src/commands/init.ts` is the single sanctioned call site that may pass the flag. Every other caller (`phase add` flag-based / wizard, `phase new` wizard, `phase import`) is rejected with `CONFIG_ERROR` (exit 2) before any file write. ([#121])
- **`phase import` reserved-id preflight scan** in `src/commands/phase-import.ts` — runs BEFORE any `createPhase` call. If any input phase entry has `id: TUTORIAL` (in any position of the input file), the entire import is rejected with `CONFIG_ERROR` and the roadmap stays byte-identical. `--force` does NOT bypass this; reserved ids are reserved at the governance layer, not the collision-handling layer. ([#121])
- **`src/core/plan/resolve-task.ts`** — new module exposing `resolveTaskInRoadmap(cwd, taskId)` (I/O variant) and `resolveTaskInPlanState(state, taskId)` (pure variant for callers with PlanState already loaded). Consolidates the eight duplicated `resolveTaskPhase` implementations across the task-* commands (P12 RFC § Non-goals explicitly deferred this to P14). Pure refactor — every per-command unit test passes unchanged. ([#123])
- **`design/decisions/governance-rfc.md`** — the accepted RFC capturing the four governance decisions, the LOCK_HELD lock model, the reserved-id policy with the `_isSampleCreation` bypass + `phase import` preflight design, the resolver-extraction shape, the protected-path strict-mode posture, the declared-writes review-surface contract, the roadmap mutation policy matrix, the phase-status manual-flip convention, the alternatives considered, and the eight P15+ deferral items. ([#117], [#118])
- **`design/phases/P14-governance.yaml`** — phase contract registering the work. ([#117])
- **`docs/concepts/governance.md`** — new concept doc mirroring the shape of the runbook / finalization-reconciliation / task-readiness-fields / sample-phase docs. Walks through the four shipped pillars + two docs-only pillars, includes the full LOCK_HELD envelope shape, the lock acquisition matrix, the reserved-id block matrix, the error/diagnostic taxonomy, and an explicit "what's intentionally NOT in v1.5" boundary list. ([#124])
- **§ Roadmap mutation policy (v1.5+ / P14) in `docs/cli-contract.md`** — names the four `createPhase` callers as the only roadmap writers, the non-writers (task lifecycle commands), and the structural-chokepoint statement. § Reserved phase ids (v1.5+ / P14) adds the block matrix. § Advisory write lock (v1.5+ / P14) carries the full LOCK_HELD envelope, the acquisition-point matrix, the stale-lock recovery playbook, and the relationship to atomic-text. ([#121], [#122])
- **`tests/unit/core/locks/write-lock.test.ts`** (9 unit tests) — lock file JSON shape, release, idempotent acquire/release/acquire, EEXIST → LOCK_HELD with full holder, corrupt lock file → `lock_holder: null` + adjusted message, `.code-pact/locks/` created on demand, `CODE_PACT_DISABLE_LOCKS=1` short-circuit, defensive env-value checks, `isLockHeldError` correctness. ([#122])
- **`tests/unit/core/services/createPhase.test.ts` reserved-id block tests** (4 new) — reject when `_isSampleCreation` is omitted (roadmap byte-identical), reject when explicitly `false`, allow when `true`, error message contract (names id + points at `init --sample-phase`). ([#121])
- **`tests/unit/core/plan/resolve-task.test.ts`** (8 new tests) — I/O variant single match / not-found / ambiguous with full `.phases` array / correct phase among many / ENOENT on missing roadmap; PlanState variant single match / not-found / **ambiguity detection where `state.taskIndex` silently returns the first match** (the load-bearing reason the pure variant exists). ([#123])
- **`tests/integration/json-stdout.test.ts` LOCK_HELD + TUTORIAL CONFIG_ERROR entries** (3 new) — `phase add --id TUTORIAL --json` returns CONFIG_ERROR envelope with roadmap byte-identical; `phase import` containing a TUTORIAL entry returns CONFIG_ERROR via preflight with roadmap byte-identical and zero phase YAML files written; `phase reconcile --write --json` against a pre-seeded stale lock returns the LOCK_HELD envelope with data.lock_holder + data.lock_path, AND read-only `validate --json` on the same project succeeds (locks do not block reads). ([#121], [#122])

### Changed

- **`tests/unit/error-code-surface.test.ts` KNOWN_CODES.public** — added `LOCK_HELD: "public"`. The public surface lock contract grows by exactly **one** entry in v1.5. ([#122])
- **`src/commands/task-context.ts`, `task-start.ts`, `task-block.ts`, `task-resume.ts`, `task-complete.ts`, `task-status.ts`, `task-finalize.ts`, `task-runbook.ts`** — all eight private `resolveTaskPhase` implementations removed and replaced with calls to the new `src/core/plan/resolve-task.ts` helpers. `task-finalize.ts` aliases `phasePath` → `file` at the destructuring site to preserve the public `data.file` field. `task-runbook.ts`'s manual ambiguity rescan + `state.taskIndex.get(...)` + internal-invariant guard collapse into a single `resolveTaskInPlanState` call. Pure refactor — `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` emitted identically (same message text, same `.phases` array shape). ([#123])
- **`src/cli.ts`** — adds `withWriteLock` helper and wires it into seven design-mutating handlers. `cmdInit` acquires the lock when `--sample-phase` is set (non-wizard) OR in wizard mode, **but only when `.code-pact/` already exists**. Fresh init bootstraps the directory tree, and acquiring the lock helper's `mkdir -p .code-pact/locks/` would create `.code-pact/` as a side effect and trip the `ALREADY_INITIALIZED` guard. The `codePactDirExists()` gate (added during P14-T8 release-prep validation when the issue surfaced) is the correct fix: fresh init has no possible concurrent code-pact mutation to defend against (no project exists yet), so skipping the lock is semantically correct. Re-init (with `--force` on an existing project) still acquires the lock. `cmdPhase` "add" / "new" / "import" each acquire around their respective `runX` call; "import" holds a single outer lock around the multi-phase apply loop. `cmdTaskAdd` acquires around `runTaskAdd` (covers both wizard and non-interactive). `cmdTaskFinalize` / `cmdPhaseReconcile` acquire only when `--write`. `cmdPhase` "add" + "new" branches also gain `CONFIG_ERROR` catches so the P14-T4 reserved-id block surfaces correctly through the JSON envelope. (this release prep, [#121], [#122])
- **`src/core/services/createPhase.ts`** — exports `RESERVED_PHASE_IDS` and adds the internal-only `_isSampleCreation?: boolean` field on `CreatePhaseInput`. Validation against the reserved list runs before any disk read, so the roadmap stays byte-identical on rejection. ([#121])
- **`src/commands/init.ts`** — `writeSamplePhase()` passes `_isSampleCreation: true` to `createPhase`. The single sanctioned bypass for the reserved `TUTORIAL` id. ([#121])
- **`src/commands/phase-import.ts`** — adds the reserved-id preflight scan documented above. ([#121])
- **`docs/cli-contract.md`** — Public codes table gains the `LOCK_HELD` row. § State file write guarantees → Files written by code-pact: writer columns on `design/roadmap.yaml` and `design/phases/*.yaml` rows now name every writer. § Concurrent writers rewritten — was "not supported" in v1.0; now describes detection via `LOCK_HELD` + lists read-only commands that DON'T acquire the lock. New § Advisory write lock (v1.5+ / P14), § Roadmap mutation policy (v1.5+ / P14), § Reserved phase ids (v1.5+ / P14), § Phase status manual-flip convention. § `phase import` validation pass: reserved-id preflight is step 2 (between schema validation and duplicate-id check). § Plan diagnostic codes documents `--strict` semantics for `TASK_WRITES_PROTECTED_PATH`. ([#119], [#121], [#122])
- **`docs/migration.md`** — new § v1.4.x → v1.5.0 covering shipped surface, recommended adoption per context (single-process / multi-process / CI-strict / TUTORIAL-add / release-prep), stale lock manual recovery, KNOWN_CODES.public growth, and the full backward-compatibility list. § "Deferred beyond v1.4" renamed to § "Deferred beyond v1.5" with closed-in-v1.5 items struck through (advisory locks / TUTORIAL hard reservation / roadmap mutation policy docs / phase status formalization / resolver core extraction). Remaining deferrals reorganized around v1.5's framing. ([#124])
- **`docs/dogfood.md`** — § Troubleshooting gains `LOCK_HELD` and `CONFIG_ERROR from phase add --id TUTORIAL / phase import containing TUTORIAL` entries. v1.5.0 documented non-strict release-prep lint for the then-current dogfood corpus; v1.5.1 supersedes that with strict-clean dogfood guidance. ([#119], [#124])
- **`docs/getting-started.md`** — new § Concurrent processes (v1.5+) introduces LOCK_HELD as a transient failure with the envelope shape and pointer to the dogfood troubleshooting entry + governance concept doc. Next-reading list gains the governance concept doc. Migration link description updated to "v0.6 – v0.9 up through v1.5.0". ([#124])
- **`docs/concepts/sample-phase.md`** — new § "TUTORIAL is a reserved phase id (v1.5+ / P14)" replaces the previous "(Hard reservation of the `TUTORIAL` id is P14 governance scope)" forward-looking note. § "What the sample phase is not" updated: the v1.5 block protects the **id**, not the phase data. Next-reading list gains the governance concept doc. ([#124])
- **`docs/concepts/finalization-reconciliation.md`** — § Phase status remains manual in v1.2 renamed to "formalized as the convention in v1.5+ / P14" and cites the governance RFC. Release-prep loop step 3 marks the manual flip as "manual by convention" with RFC link; step 4 links to the new roadmap mutation policy section. § Declared writes as a governance review surface (v1.4+ / P14) added in P14-T3. ([#120], [#121])
- **`docs/concepts/runbook.md`** — § Declared writes as a governance review surface (v1.4+ / P14) added in P14-T3. ([#120])
- **`design/phases/P14-governance.yaml`** — phase `status: planned` → `status: done`; every P14 task (T1–T8) `status: planned` → `status: done`. **The T1–T7 task-level flips were performed by `code-pact phase reconcile P14 --write` itself** — the **fourth consecutive** release prep PR to dogfood the P11 mechanization. T8 (this release-prep task) was flipped via `task finalize P14-T8 --write` after `task complete P14-T8`, completing the per-task loop on the task that performed the release prep (per the P13-T6 pattern). The phase's own `status` field was flipped by hand per the v1.2 contract — now formalized in v1.5 as the release-prep convention. ([#121], [#122], [#123], [#124], this release prep)
- **`package.json`** — version `1.4.0` → `1.5.0`. (this release prep)

### Dogfood log

A complete end-to-end exercise of every new v1.5.0 governance flag / failure mode was captured in a fresh tmp project before this release prep PR was committed. The full log is in the PR description; verbatim summary:

```
=== STEP 1: init --non-interactive --sample-phase ===
created files: 12 incl. design/phases/TUTORIAL-walkthrough.yaml

=== STEP 2: phase add --id TUTORIAL (P14-T4 reserved-id block) ===
ok: False | code: CONFIG_ERROR | exit: 2
message contains "TUTORIAL" and "init --sample-phase": True
roadmap byte-identical before/after: True

=== STEP 3: phase import containing TUTORIAL (P14-T4 preflight) ===
ok: False | code: CONFIG_ERROR | exit: 2
roadmap byte-identical: True
phase YAML files written: 0  (preflight rejects entire input)

=== STEP 4: concurrent task finalize --write (P14-T5 LOCK_HELD) ===
process A: ok: True | task finalize succeeded
process B (with seeded stale lock): ok: False | code: LOCK_HELD | exit: 2
data.lock_holder.cmd matches A's command: True
data.lock_holder.pid is numeric: True
data.lock_path ends with .code-pact/locks/write.lock: True

=== STEP 5: read-only commands during held lock ===
validate --json:    ok: True (no lock acquired)
task status --json: ok: True (no lock acquired)
plan lint --json:   ok: True (no lock acquired)

=== STEP 6: resolver refactor invisible (P14-T6) ===
task context BOGUS-ID:  exit 2 | TASK_NOT_FOUND  (envelope unchanged)
task start BOGUS-ID:    exit 2 | TASK_NOT_FOUND  (envelope unchanged)
task complete BOGUS-ID: exit 2 | TASK_NOT_FOUND  (envelope unchanged)
```

### Known residuals (not blockers)

- **`TASK_WRITES_PROTECTED_PATH` advisories on the dogfood corpus.** Existing advisories remained in v1.5.0 (P10-T1, P10-T6, P11-T1, P14-T1 declaring writes against `design/roadmap.yaml` and `design/phases/*.yaml`). v1.5.1 removes those stale historical declarations so the dogfood corpus is strict-clean. Actual write enforcement against declared `writes` remains a P15+ candidate (requires runner or VCS integration).
- **Stale lock recovery is manual.** v1.5 ships the advisory lock without automatic stale-lock detection. If a `code-pact` process crashes mid-lock (SIGKILL, OS reboot), the user manually deletes `.code-pact/locks/write.lock` after verifying no process holds it. PID liveness checks + `--force-lock` are P15+ candidates.
- **Configurable protected paths / configurable reserved-id list / RESERVED_ID_USAGE lint on existing TUTORIAL phases / selective per-code `--strict` promotion / progress.yaml write locks** — all remain future work. See `docs/migration.md` § Deferred beyond v1.5 for the full list.
- **`STATUS_DRIFT done-but-design-not-done` warnings** on the dogfood corpus continue to fire for any task whose progress.yaml has a `done` event but whose design status was not yet flipped. This release prep clears every P14 warning that had accumulated across the P14 task PRs into a single coherent reconcile flip (for T1–T7) + a single finalize call (for T8, the release-prep task itself) — **the fourth consecutive release prep where the post-reconcile drift count drops to zero via mechanization**.

[#117]: https://github.com/toshtag/code-pact/pull/117
[#118]: https://github.com/toshtag/code-pact/pull/118
[#119]: https://github.com/toshtag/code-pact/pull/119
[#120]: https://github.com/toshtag/code-pact/pull/120
[#121]: https://github.com/toshtag/code-pact/pull/121
[#122]: https://github.com/toshtag/code-pact/pull/122
[#123]: https://github.com/toshtag/code-pact/pull/123
[#124]: https://github.com/toshtag/code-pact/pull/124

---

## [1.4.0] — 2026-05-21

**Planning UX and init hardening.** Minor release that closes four small frictions in the planning / init / task-creation surface that P9 and P12 explicitly deferred. Every change is additive on the CLI contract — no new commands, no new error codes, no new schema fields, no behavioural changes to `task complete` / `task finalize` / `phase reconcile` / `task runbook` / `phase runbook`.

The sample-phase artifact `init` produces is renamed from `P1-welcome.yaml` (id `P1`, no tasks) to `TUTORIAL-walkthrough.yaml` (id `TUTORIAL`, two tutorial tasks with `TUTORIAL-T2 depends_on: [TUTORIAL-T1]`). A single bootstrap now demos P10 (`depends_on`) + P11 (`task finalize` / `phase reconcile`) + P12 (`task runbook` blocking step) end-to-end. Existing projects with a pre-v1.4 `P1-welcome.yaml` are untouched — the rename only affects NEW `init` runs.

### CLI behavior changes

None for the existing Stable surface. Stable command flags, JSON envelope shape, exit-code semantics, and the existing error-code surface remain unchanged from v1.3.0. The `tests/integration/json-stdout.test.ts` and `tests/unit/error-code-surface.test.ts` regression nets continue to pass; new test entries are additive.

The wizard mode of `init` is unchanged — the default-yes prompt for sample-phase creation still fires for TTY users.

### Added

- **`init --sample-phase`** as Stable (v1.4+). Explicit opt-in flag. In non-interactive mode, enables sample-phase creation (previously wizard-only). In TTY wizard mode, skips the existing "create sample phase?" prompt and forces creation. Makes `init --non-interactive --locale <l> --agent <a> --sample-phase` a single-command scripted bootstrap that produces a complete tutorial artifact ready for the per-task loop. ([#112])
- **`task add` non-interactive flag set** as Stable (v1.4+) (`src/commands/task-add.ts`). Presence of `--description` triggers the flag-driven path; `--type` is required in that mode. Six readiness fields (`--ambiguity` / `--risk` / `--context-size` / `--write-surface` / `--verification-strength` / `--expected-duration`) accept enum values; five P10 fields (`--depends-on` / `--decision-ref` / `--read` / `--write` / `--acceptance-ref`) are repeatable. `--status` is **intentionally not exposed** — newly added tasks are always `status: planned`; historical / migrated tasks use `phase import`, preserving the P11/P12 contract that design `done` is the result of `task finalize` / `phase reconcile`, not a starting point. Partial flags (non-interactive flag without `--description`) raise `CONFIG_ERROR` rather than silently entering the wizard or silently ignoring flags. The wizard path is unchanged. ([#113])
- **`suggested_next_steps: string[]`** as an additive sibling field on `plan prompt --json` and as an additive top-level field on `phase import --json`. Always present (field-presence-fixed per the P12 RunbookStep convention). `plan prompt` emits the canonical 4-step AI-assisted planning flow (prompt → import → lint → phase runbook) with an optional leading brief/constitution-capture hint when either file is missing. `phase import` emits the post-import sequence (lint → phase runbook per imported phase → task runbook on first task) with an optional leading defaults-review hint when `completed_fields[]` is non-empty. The whole array is empty when nothing was imported. ([#114])
- **Sample-phase artifact rewrite**. The `writeSamplePhase()` helper in `src/commands/init.ts` now produces `id: TUTORIAL`, `name: Walkthrough`, with two minimal tutorial tasks. `TUTORIAL-T1` is a feature with no dependencies; `TUTORIAL-T2` is a docs task with `depends_on: [TUTORIAL-T1]` so the tutorial demos `task runbook TUTORIAL-T2 --json` returning a blocking dependency step until `TUTORIAL-T1` is complete. The phase's `objective` text embeds the "Tutorial-only — delete before treating design/ as your source-of-truth" warning since YAML schema forbids comments inside zod-parsed values. The `runPhaseAdd` wrapper does not forward `tasks`, so `writeSamplePhase` was rewritten to call the `createPhase` core service directly. ([#112])
- **`design/decisions/planning-ux-init-hardening-rfc.md`** — the accepted RFC capturing the four UX gaps, proposed changes (with generation-policy table for `init --sample-phase` mode × flag, `task add` flag table + 3-branch partial-flags resolution), the "P14 governance" deferral list, and the P13-T1..T6 implementation slicing. ([#110], [#111])
- **`design/phases/P13-planning-ux-init-hardening.yaml`** — phase contract registering the work. ([#110])
- **`docs/concepts/sample-phase.md`** — rewritten in TUTORIAL terms. Documents both creation paths (wizard yes / `init --sample-phase`), the artifact content with `TUTORIAL-T2 depends_on: [TUTORIAL-T1]`, the three-purpose rationale (smoke-test + working template + tutorial/source-of-truth boundary), the keep/rename/delete decision tree, and explicit upgrade guidance ("existing P1-welcome.yaml is untouched"). ([#115])

### Changed

- **`docs/migration.md`** gains a `v1.3.x → v1.4.0` section with the quick path, what's new (the four additive changes), recommended adoption pattern (replace scripted-bootstrap workarounds with `init --non-interactive --sample-phase`; replace single-task `phase import` deltas with `task add --description --type`), CI implications under `--strict` (no new errors / warnings / codes), and backward-compatibility notes. "Deferred beyond v1.3" → "Deferred beyond v1.4" with the now-shipped P13 items removed and explicit `task add --status` / `--dry-run` / reserved-id hard enforcement / `plan brief` non-TTY deferrals rolled forward. ([#115])
- **`docs/cli-contract.md`** gains a `## task add` section annotated Stable (v0.6 wizard + v1.4+ non-interactive) with the mode-resolution table, full flag table, P10 validation responsibility note ("`task add` stores; `plan lint` validates"), JSON envelope shape, error codes, and four usage examples. The `plan prompt` and `phase import` sections gain a "v1.4+ additive field" subsection describing `suggested_next_steps`. ([#113], [#114])
- **`docs/getting-started.md`** — Path 1 (Tutorial) rewritten in TUTORIAL terms with the full per-task loop on TUTORIAL-T1 + TUTORIAL-T2, the dependency-blocking demo callout, and a v1.4+ CI / non-TTY callout pointing at the single-command scripted bootstrap. Path 2 (Manual) step 4 shows both the interactive `task add` and the new non-interactive `task add --description --type ...` side-by-side. ([#115])
- **`docs/dogfood.md`** — "Adding work" gains the non-interactive `task add` example and the `--status` policy note. New "Tutorial bootstrap (v1.4+)" subsection. ([#115])
- **`design/phases/P13-planning-ux-init-hardening.yaml`** — phase `status: planned` → `status: done`; every P13 task (T1–T6) `status: planned` → `status: done`. **The T1–T5 task-level flips were performed by `code-pact phase reconcile P13 --write` itself** — the third consecutive release prep PR to dogfood the P11 mechanization. T6 (this release-prep task) was flipped via `task finalize P13-T6 --write` after `task complete P13-T6`, completing the per-task loop on the task that performed the release prep. The phase's own `status` field was flipped by hand per the v1.2 contract. ([#113], [#114], [#115], this release prep)
- **`package.json`** — version `1.3.0` → `1.4.0`. (this release prep)

### Dogfood log

A complete end-to-end exercise of every new v1.4.0 flag was captured in a fresh tmp project before this release prep PR was committed. The full log is in the PR description; verbatim summary:

```
=== STEP 1: init --non-interactive --sample-phase ===
created files: 12
TUTORIAL files: ['design/phases/TUTORIAL-walkthrough.yaml']

=== STEP 2: phase show TUTORIAL ===
TUTORIAL-T1 (feature)
TUTORIAL-T2 (docs) depends_on=['TUTORIAL-T1']

=== STEP 3: task runbook TUTORIAL-T2 (P10 + P12 demo) ===
blocking head step: True
manual_action: Wait for TUTORIAL-T1 to reach derived state: done (currently: planned)

=== STEP 4: task add TUTORIAL --description --type --depends-on --read --json ===
ok: True | taskId: TUTORIAL-T3

=== STEP 5: task add TUTORIAL --type docs (no --description) ===
ok: False | code: CONFIG_ERROR

=== STEP 6: plan prompt --json (5 suggested_next_steps) ===
1. plan brief/constitution hint
2-5. AI flow (prompt → phase import → plan lint → phase runbook)

=== STEP 7: phase import --json (4 suggested_next_steps) ===
1. completed_fields review hint
2. plan lint
3. phase runbook P1
4. task runbook P1-T1
completed_fields: 1
```

### Known residuals (not blockers)

- **`TASK_WRITES_PROTECTED_PATH` advisories on the dogfood corpus.** Existing advisories remain (P10-T1, P10-T6, P11-T1 declaring writes against `design/roadmap.yaml` and `design/phases/*.yaml`). P14 governance is the consumer that promotes to error severity with a configurable policy.
- **`task add --status`, `task add --dry-run`, reserved-id (`TUTORIAL`) hard enforcement, `plan brief` / `plan constitution` non-TTY alternatives, multi-phase reconcile / runbook (`--all`), runbook execution (`task runbook --execute`), schema-level `human_gate`, `task next` / `phase next` aliases, bundling `recommend` into `task runbook`, runbook orchestrator (`task run` / `phase close`)** — all remain future work. See `docs/migration.md` § Deferred beyond v1.4 for the full list.
- **`STATUS_DRIFT done-but-design-not-done` warnings** on the dogfood corpus continue to fire for any task whose progress.yaml has a `done` event but whose design status was not yet flipped. This release prep clears every P13 warning that had accumulated across the P13 task PRs into a single coherent reconcile flip (for T1-T5) + a single finalize call (for T6, the release-prep task itself) — the third consecutive release prep where the post-reconcile drift count drops to zero via mechanization.

[#110]: https://github.com/toshtag/code-pact/pull/110
[#111]: https://github.com/toshtag/code-pact/pull/111
[#112]: https://github.com/toshtag/code-pact/pull/112
[#113]: https://github.com/toshtag/code-pact/pull/113
[#114]: https://github.com/toshtag/code-pact/pull/114
[#115]: https://github.com/toshtag/code-pact/pull/115

---

## [1.3.0] — 2026-05-20

**Lightweight Runbook.** Minor release that introduces two new read-only commands for answering the user-facing question "what should I run next?" deterministically. `task runbook <task-id>` returns the recommended sequence of next steps for a single task; `phase runbook <phase-id>` does the same for an entire phase with a 6-priority step list, task/drift histograms, and a phase status candidate. Neither command mutates anything; neither calls an adapter; neither takes a `--write` / `--execute` / `--agent` flag. Every recommended step is a CLI invocation the user runs separately, or a `manual_action` describing a human checkpoint.

### CLI behavior changes

None for the existing Stable surface. Stable command flags, JSON envelope shape, exit-code semantics, and the existing error-code surface remain unchanged from v1.2.0. The `tests/integration/json-stdout.test.ts` and `tests/unit/error-code-surface.test.ts` regression nets continue to pass; the two new commands are additive entries with no new error codes.

### Added

- **`task runbook <task-id> [--json]`** as Stable (v1.3+) (`src/commands/task-runbook.ts`). Returns `{ ok: true, data: { kind: "runbook", task_id, phase_id, state_summary, next_steps: RunbookStep[] } }`. Maps `(derived state, design status, drift kind)` → recommended steps using the lifecycle table from the RFC. `task start` is part of the primary loop for `planned + no events` tasks. `depends_on` emits a blocking dependency-check step at the head when any dep is unsatisfied. No new error codes — reuses `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` / `CONFIG_ERROR`. ([#106])
- **`phase runbook <phase-id> [--json]`** as Stable (v1.3+) (`src/commands/phase-runbook.ts`). Bulk counterpart. Returns the same envelope kind with `phase_summary` (task histogram + drift histogram + `phase_status_candidate` + advisory note) and a 6-priority step list (blocked → manual_review → reconcile batch → in-progress hints → primary loop → phase-status advisory). Reuses `PHASE_NOT_FOUND` / `CONFIG_ERROR`. ([#107])
- **`src/core/runbook/`** — new neutral module owning the pure-function runbook builders. `types.ts` defines the field-presence-fixed `RunbookStep` shape with `assertStepInvariant` (exactly-one-of command/manual_action enforced at construction time). `depends-on.ts` extracts the inline `depends_on` resolution pattern from `task-finalize.ts` into a shared helper. `build-task-runbook.ts` and `build-phase-runbook.ts` are pure functions — commands pass already-loaded `PlanState` / progress events. No I/O in the core helpers. ([#105])
- **`src/core/finalize/reconcile-classifier.ts`** — the reconcile classifier previously private inside `src/commands/phase-reconcile.ts` is extracted into a core module in P11's `src/core/finalize/` namespace. Both `phase-reconcile.ts` and the new `src/core/runbook/build-phase-runbook.ts` import from the core helper. Preserves the `command → core` dependency direction. Pure refactor — existing `tests/unit/commands/phase-reconcile.test.ts` passes unchanged. ([#105])
- **`classifyTaskDrift` export** from `src/core/plan/analyze.ts`. The function was private; runbook needs it to label tasks with their drift kind. Same-module export — analyze.ts is already core layer, so no layering inversion. ([#105])
- **`design/decisions/lightweight-runbook-rfc.md`** — the accepted RFC capturing command semantics, runbook step shape, state-based recommendation rules, the explicit `recommend` vs `task runbook` boundary, layering decisions (classifier extraction, no `--agent` flag on runbook), the `human_gate` deferral to P13/P14, the init/UX polish deferral to P13, alternatives considered (executable runbook, `task next` alias, classifier export from command file, etc.), open questions, and the P12-T1..T5 implementation slicing. ([#103], [#104])
- **`design/phases/P12-lightweight-runbook.yaml`** — phase contract registering the work. ([#103])
- **`docs/concepts/runbook.md`** — agent- and reviewer-facing walkthrough mirroring `docs/concepts/finalization-reconciliation.md`. Covers why runbook exists, the explicit boundary against `recommend` / `task context` / `phase reconcile`, full state → steps mapping table, 6-priority order for phase runbook, RunbookStep field invariants, P10/P11 integration, error codes (none new), what's intentionally NOT in v1.3 (`--execute`, `task next` alias, `human_gate` schema field, `--all`, init UX polish). ([#108])

### Changed

- **`docs/migration.md`** gains a `v1.2.x → v1.3.0` section covering the quick path, what's new (both runbook commands, field-presence-fixed shape, the internal classifier extraction), recommended adoption pattern (use `task runbook` after `plan analyze` flags drift; use `phase runbook` as a sanity check before release-prep `phase reconcile --write`), CI implications under `--strict` (no new errors, no new warnings, KNOWN_CODES.public unchanged), and backward-compatibility notes. "Deferred beyond v1.2" → "Deferred beyond v1.3" with the now-shipped runbook commands removed and the previously-deferred init/UX polish item rolled forward to P13. ([#108])
- **`docs/cli-contract.md`** gains a `task runbook` section + a `phase runbook` section (both annotated Stable (v1.3+)) with full JSON envelope shape, RunbookStep field invariants table, state → steps mapping table, 6-priority order for phase runbook, error codes, usage examples, and the explicit `recommend` vs `task runbook` boundary statement. ([#106], [#107])
- **`docs/getting-started.md`** gains an optional step in the tutorial mentioning `task runbook` and `phase runbook` as read-only sequencing guidance, with a pointer to the concept walkthrough. ([#108])
- **`docs/dogfood.md`** gains a Step 7 in the per-task flow for `task runbook` / `phase runbook`; updates the v1.0 contract section to mention v1.3 read-only counterparts; updates the STATUS_DRIFT expected-warnings note to surface that runbook carries the same recommendation in lifecycle context; adds runbook as a v1.3+ alternative diagnostic step inside the existing `TASK_FINALIZE_NOT_ELIGIBLE` and `PHASE_RECONCILE_WRITE_REFUSED` Troubleshooting entries; section header renamed `(v1.0 / v1.2+)` → `(v1.0 / v1.2+ / v1.3+)`. ([#108])
- **`design/phases/P12-lightweight-runbook.yaml`** — phase `status: planned` → `status: done`; every P12 task (T1–T5) `status: planned` → `status: done`. **The task-level flip was performed by `code-pact phase reconcile P12 --write` itself**, after a sanity-check run of **`code-pact phase runbook P12 --json`** which returned exactly the two-step recommendation the release prep then followed (the reconcile batch + the manual phase-status flip). This is the second release-prep PR to dogfood the P11 mechanization, and the first one to dogfood the P12 read-only sanity-check layer alongside it. ([#105], [#106], [#107], [#108], this release prep)
- **`package.json`** — version `1.2.0` → `1.3.0`. (this release prep)

### Known residuals (not blockers)

- **`TASK_WRITES_PROTECTED_PATH` advisories on the dogfood corpus.** Existing advisories remain (P10-T1, P10-T6, P11-T1 declaring writes against `design/roadmap.yaml` and `design/phases/*.yaml`). These are proof the protected-path lint is working as designed; P14 governance is the consumer that promotes to error severity with a configurable policy.
- **Phase status auto-flip, multi-phase runbook (`--all`), `design/roadmap.yaml` mutation, file-content validation of `acceptance_refs`, actual-write enforcement of declared `writes`, runbook execution (`task runbook --execute`), schema-level `human_gate`, `task next` / `phase next` sugar aliases, bundling `recommend` into `task runbook`, init/wizard/task-add UX polish (P13 scope), runbook orchestrator integration** all remain future work. See `docs/migration.md` § Deferred beyond v1.3 for the full list.
- **`STATUS_DRIFT done-but-design-not-done` warnings** on the dogfood corpus continue to fire for any task whose progress.yaml has a `done` event but whose design status was not yet flipped. This release prep clears every P12 warning that had accumulated across the P12 task PRs into a single coherent reconcile flip — the second time a release prep has used `phase reconcile --write` to mechanize the step, and the first time `phase runbook` was used as the sanity check before it.

[#103]: https://github.com/toshtag/code-pact/pull/103
[#104]: https://github.com/toshtag/code-pact/pull/104
[#105]: https://github.com/toshtag/code-pact/pull/105
[#106]: https://github.com/toshtag/code-pact/pull/106
[#107]: https://github.com/toshtag/code-pact/pull/107
[#108]: https://github.com/toshtag/code-pact/pull/108

---

## [1.2.0] — 2026-05-20

**Finalization & Reconciliation.** Minor release that introduces two new commands for closing the long-standing drift between `progress.yaml` (operational fact) and `design/phases/*.yaml` (design intent). `task finalize <task-id>` flips one task's design status to `done` when its derived state from progress is already `done`; `phase reconcile <phase-id>` is the bulk counterpart. Both default to dry-run; `--write` is the explicit opt-in. Neither command mutates `progress.yaml`, neither writes to `design/roadmap.yaml`, and neither auto-flips the phase's own `status` field — phase status remains a manual release-prep step until P14 governance. The v1.0 contract that `task complete` records progress only and never mutates design YAML is preserved unchanged.

### CLI behavior changes

None for the existing Stable surface. Stable command flags, JSON envelope shape, exit-code semantics, and the existing error-code surface remain unchanged from v1.1.0. The `tests/integration/json-stdout.test.ts` and `tests/unit/error-code-surface.test.ts` regression nets continue to pass; the two new commands are additive entries.

### Added

- **`task finalize <task-id> [--write] [--json]`** as Stable (v1.2+) (`src/commands/task-finalize.ts`). Flips one task's design status to `done` only when `progress.yaml` already shows a `done` event for it. Defaults to dry-run; `--write` is the explicit opt-in. JSON envelope kinds: `would_finalize` / `finalized` / `already_finalized`. Ineligibility raises `TASK_FINALIZE_NOT_ELIGIBLE` (exit 2) in **both** dry-run and `--write` — dry-run means "won't write", not "won't validate". No `--agent` flag: finalize is a design/progress reconciliation command and never calls an adapter. ([#98])
- **`phase reconcile <phase-id> [--write] [--json]`** as Stable (v1.2+) (`src/commands/phase-reconcile.ts`). Bulk counterpart that walks every task in the phase, classifies each as `flip` / `skip` / `manual_review`, and (with `--write`) applies the flips in one shot. JSON envelope kinds: `would_reconcile` / `reconciled` / `no_eligible_tasks`. The `no_eligible_tasks` case is intentionally not an error code — nothing to flip is a normal outcome (exit 0). Partial successes return exit 0 with both `applied_writes[]` and `skipped_writes[]` populated; `PHASE_RECONCILE_WRITE_REFUSED` (exit 2) fires only when every eligible write was refused. Reports `phase_status_candidate` as advisory but never writes the phase's own `status` field. ([#99])
- **`src/core/finalize/`** — shared write-safety + dry-run diff helpers (`safe-write.ts`, `diff.ts`). Owns the load → mutate → atomic-write pattern, the dry-run diff shape (`{file, task_id, before, after}`), and the write-refusal classifier (`unsafe_path` / `outside_design_phases` / `not_yaml` / `symlink_escape` / `unreadable` / `unparseable_phase` / `task_not_found`). Imported by both new commands; namespace deliberately separate from `src/core/adapters/` (adapter-owned writes) and `src/io/` (raw write primitives). ([#97])
- **Three new public error codes** (additive in `KNOWN_CODES.public`): `TASK_FINALIZE_NOT_ELIGIBLE`, `TASK_FINALIZE_WRITE_REFUSED`, `PHASE_RECONCILE_WRITE_REFUSED`. Documented in `docs/cli-contract.md` § Public codes and locked by `tests/unit/error-code-surface.test.ts`. ([#98], [#99])
- **Additive `details.remediation` on `STATUS_DRIFT done-but-design-not-done`** issues emitted by `plan analyze`. Value is the literal string `"code-pact task finalize <task-id>"`. Only this drift kind carries the hint — the other four kinds (`done-blocked-conflict`, `done-with-incomplete-events`, `done-historical`, `in-progress-no-events`) need human judgement and stay unannotated. Additive on the `Record<string, unknown>` `details` payload; existing JSON consumers see no shape change. ([#100])
- **`design/decisions/finalization-reconciliation-rfc.md`** — the accepted RFC capturing command semantics, dry-run / write model, drift taxonomy strategy, safety model, P10 field integration scope, alternatives considered, and the P11-T1..T6 implementation slicing. ([#95], [#96])
- **`design/phases/P11-finalization-reconciliation.yaml`** — phase contract registering the work. ([#95])
- **`docs/concepts/finalization-reconciliation.md`** — agent- and reviewer-facing walkthrough mirroring `docs/concepts/task-readiness-fields.md`. Covers the drift these commands close, command surfaces with JSON envelope kinds, classification table, partial-success semantics, why phase status stays manual in v1.2, before/after release-prep loop, field reference, error code reference, what stays the same. ([#101])

### Changed

- **`docs/migration.md`** gains a `v1.1.x → v1.2.0` section covering the quick path, what's new, recommended adoption pattern (replace hand-edits in release prep with `phase reconcile --write`), CI implications under `--strict` (no new errors), the three new `KNOWN_CODES.public` entries, and backward-compatibility notes. "Deferred beyond v1.1" → "Deferred beyond v1.2" with the now-shipped `task finalize` / `phase reconcile` bullet removed. ([#101])
- **`docs/cli-contract.md`** gains a `task finalize` section + a `phase reconcile` section (both annotated Stable (v1.2+)) with full JSON envelope shape, field-presence-by-kind tables, error tables, and usage examples. The public-codes table is extended with the three new entries. The STATUS_DRIFT kinds table notes the additive `details.remediation` field for `done-but-design-not-done`. ([#98], [#99], [#100])
- **`docs/getting-started.md`** gains an optional Step 5 in the tutorial mentioning `task finalize <task-id> --write`, explicitly labelled as v1.2+ and opt-in, with a pointer to the concept walkthrough. ([#101])
- **`docs/dogfood.md`** gains a Step 6 in the per-task flow for `task finalize` / `phase reconcile`; updates the v1.0 contract section to mention v1.2 mechanization; updates the STATUS_DRIFT expected-warnings note to surface the new `details.remediation` field; adds three new Troubleshooting entries (`TASK_FINALIZE_NOT_ELIGIBLE`, `TASK_FINALIZE_WRITE_REFUSED`, `PHASE_RECONCILE_WRITE_REFUSED`) with per-reason recovery tables; section header renamed `(v1.0)` → `(v1.0 / v1.2+)`. ([#101])
- **`design/phases/P11-finalization-reconciliation.yaml`** — phase `status: planned` → `status: done`; every P11 task (T1–T6) `status: planned` → `status: done`. **The task-level flip was performed by `code-pact phase reconcile P11 --write` itself** — the first release-prep PR in the project's history to mechanize what was previously a hand-edit step in every release prep going back to v1.0.0. The phase's own `status` field was flipped by hand per the v1.2 contract (reconcile's `phase_status_candidate` reported `done`, the advisory was followed). ([#97], [#98], [#99], [#100], [#101], this release prep)
- **`package.json`** — version `1.1.0` → `1.2.0`. (this release prep)

### Known residuals (not blockers)

- **`phase reconcile --write` reflows long YAML lines.** The first `--write` against a phase file goes through `yaml.stringify()` and snaps the file to canonical line-wrap form. P11's RFC PR landed the phase YAML with hand-authored long lines; the reconcile write in this release prep normalizes them. The resulting file is what `plan normalize` considers canonical (`plan normalize --check` reports no further changes), so this is a one-time snap, not a recurring drift. Phase YAMLs written via `phase add` / `phase import` have always been canonical; future P-tasks won't see this reflow.
- **`TASK_WRITES_PROTECTED_PATH` advisories on the dogfood corpus.** Five intentional warnings remain (P10-T1, P10-T6, P11-T1 declaring writes against `design/roadmap.yaml` and `design/phases/*.yaml`). These are proof the protected-path lint is working as designed; P14 governance is the consumer that promotes to error severity with a configurable policy.
- **Phase status auto-flip, multi-phase reconcile, `design/roadmap.yaml` mutation, file-content validation of `acceptance_refs`, actual-write enforcement of declared `writes`, runbook integration (P12), cross-phase `depends_on`** all remain future work. See `docs/migration.md` § Deferred beyond v1.2 for the full list.
- **`STATUS_DRIFT done-but-design-not-done` warnings** on the dogfood corpus continue to fire for any task whose progress.yaml has a `done` event but whose design status was not yet flipped. This release prep clears every P11 warning that had accumulated across the P11 task PRs into a single coherent reconcile flip — the first time a release prep has cleared the drift without hand-editing.

[#95]: https://github.com/toshtag/code-pact/pull/95
[#96]: https://github.com/toshtag/code-pact/pull/96
[#97]: https://github.com/toshtag/code-pact/pull/97
[#98]: https://github.com/toshtag/code-pact/pull/98
[#99]: https://github.com/toshtag/code-pact/pull/99
[#100]: https://github.com/toshtag/code-pact/pull/100
[#101]: https://github.com/toshtag/code-pact/pull/101

---

## [1.1.0] — 2026-05-20

**Task Readiness Schema.** Minor release that introduces five additive optional fields on the task type (`depends_on`, `decision_refs`, `reads`, `writes`, `acceptance_refs`) so a task can declare its own context-pack targets, read / write surface, dependencies, and acceptance references. The change is strictly additive — every v1.0.x phase YAML continues to parse and behave identically.

### CLI behavior changes

None for tasks that declare none of the new fields. Stable command flags, JSON envelope shape, exit-code semantics, and the existing error-code surface remain unchanged from v1.0.2. The `tests/integration/json-stdout.test.ts` and `tests/unit/error-code-surface.test.ts` regression nets are unchanged at the envelope / existing-code level.

### Added

- **Five optional task fields** (`src/core/schemas/task.ts`): `depends_on` (same-phase task ids), `decision_refs` (paths surfaced into the pack), `reads` / `writes` (declared globs in a documented subset), `acceptance_refs` (paths to acceptance criteria). All `.optional()`; pre-v1.1 phase YAML parses unchanged. `phase import` lenient mode forwards them verbatim with no synthetic default. ([#89])
- **Twelve additive `plan` lint codes** validating the new fields when declared. All `TASK_*` prefixed: `TASK_DEPENDS_ON_UNRESOLVED`, `TASK_DEPENDS_ON_SELF_REFERENCE`, `TASK_DECISION_REF_NOT_FOUND`, `TASK_DECISION_REF_UNSAFE_PATH`, `TASK_READS_UNSAFE_PATH`, `TASK_READS_GLOB_INVALID`, `TASK_READS_NO_MATCH`, `TASK_WRITES_UNSAFE_PATH`, `TASK_WRITES_GLOB_INVALID`, `TASK_WRITES_PROTECTED_PATH`, `TASK_ACCEPTANCE_REF_NOT_FOUND`, `TASK_ACCEPTANCE_REF_UNSAFE_PATH`. Documented in `docs/cli-contract.md` § Plan diagnostic codes — Task Readiness Schema diagnostics; locked by `tests/unit/error-code-surface.test.ts`. ([#90])
- **Five new pack sections in `task context`**, rendered in stable order (Depends on → Declared read surface → Declared write surface → Declared decisions → Acceptance references) when the corresponding fields are declared. `decision_refs` content is surfaced regardless of `context_size`. ([#91])
- **`src/core/path-safety.ts`** — neutral module owning `assertSafeRelativePath` / `resolveWithinProject`, promoted from `src/core/adapters/file-state.ts`. The adapter file re-exports both symbols so existing call sites (`adapter-install`, `adapter-upgrade`, `adapter-file-state` tests) remain untouched. Plan lint, future P11 finalize, and future P14 governance import from the neutral module. ([#90])
- **`src/core/glob.ts`** — minimal in-repo glob matcher for the supported subset (literal segments, single-segment `*`, full-segment `**`). No external glob dependency added per the runtime-dependency policy in `CONTRIBUTING.md`. Exports `validateGlobSyntax`, `globToRegex`, `walkAndMatch`, `findProtectedPathOverlaps`, and the `PROTECTED_PATHS` seed set. ([#90])
- **Byte-identical pack regression test** (`tests/integration/pack-byte-identical.test.ts` + `tests/fixtures/golden/pack-v1.0.2-shaped.md`). Locks the contract that `task context` output is unchanged for v1.0.2-shaped tasks (those declaring none of the new fields). ([#91])
- **`design/decisions/task-readiness-schema-rfc.md`** — the accepted RFC capturing field semantics, validation rules, backward-compat contract, alternatives considered, open questions, and the P10-T1..T6 implementation slicing. ([#88])
- **`docs/concepts/task-readiness-fields.md`** — agent- and reviewer-facing walkthrough of the five fields with a full example phase YAML, per-field lint / pack / non-enforcement breakdown, recommended adoption pattern, and the explicit "intentionally not in this release" list. ([#92])
- **`design/phases/P10-task-readiness-schema.yaml`** — phase contract registering the work. ([#88])

### Changed

- **`docs/migration.md`** gains a `v1.0.x → v1.1.0` section covering the additive contract, one-command upgrade (`npm install` + `adapter upgrade --write`), the recommended adoption pattern (declare on new tasks first; retroactive backfill is explicitly discouraged), the supported glob subset, and the protected-path seed set. The previous "Deferred to v1.1+" section is renamed to "Deferred beyond v1.1" and refined to reflect what landed and what is still deferred (cross-phase `depends_on`, file-content inclusion for `reads`, ID-based references, `task finalize` / `phase reconcile`, hard enforcement of `writes`). ([#92])
- **`docs/cli-contract.md`** § `phase import` extends the task shape with the five new optional fields. The `task context` section gains a "P10 declared sections (v1.1+)" subsection documenting the five pack sections, stable order, decision_refs dedupe-with-Related-Decisions rule, and the byte-identical contract. ([#92])
- **`docs/getting-started.md`** gains an "Optional task readiness fields (v1.1+)" subsection with a short example YAML and pointers to the concept doc and the migration story. ([#92])
- **`design/phases/P10-task-readiness-schema.yaml`** — phase `status: planned` → `status: done`; every P10 task (T1–T6) `status: planned` → `status: done`. Also adopts the new fields itself per P10-T6 dogfood scope, which now produces three intentional `TASK_WRITES_PROTECTED_PATH` advisories (P10-T1 writes against `design/roadmap.yaml` + `design/phases/P10-task-readiness-schema.yaml`; P10-T6 writes against `design/phases/P10-task-readiness-schema.yaml`). These are proof the protected-path lint is working as designed; P14 governance will turn them into a configurable error. ([#93], this release prep)
- **`package.json`** — version `1.0.2` → `1.1.0`. (this release prep)

### Known residuals (not blockers)

- **`TASK_WRITES_PROTECTED_PATH` is advisory only.** Three intentional warnings on the dogfood corpus (see above). P14 governance is the consumer that promotes to error severity with a configurable policy.
- **Cross-phase `depends_on`, file-content inclusion for `reads`, ID-based references, `task finalize` / `phase reconcile`** all remain future work. See `docs/migration.md` § Deferred beyond v1.1 for the full list.
- **`STATUS_DRIFT done-but-design-not-done` warnings** on the dogfood corpus continue to fire for any task whose progress.yaml has a `done` event but whose design status was not yet flipped. This release prep flips every P10 task to `done`, clearing the five warnings that had accumulated across the P10 task PRs into a single coherent flip.

[#88]: https://github.com/toshtag/code-pact/pull/88
[#89]: https://github.com/toshtag/code-pact/pull/89
[#90]: https://github.com/toshtag/code-pact/pull/90
[#91]: https://github.com/toshtag/code-pact/pull/91
[#92]: https://github.com/toshtag/code-pact/pull/92
[#93]: https://github.com/toshtag/code-pact/pull/93

---

## [1.0.2] — 2026-05-20

**Onboarding and dogfood documentation baseline.** Patch release that restructures the onboarding entry path and ships the dogfood / sample-phase / community materials that v1.0 left implicit.

### CLI behavior changes

None. Stable command flags, JSON envelope shape, exit-code semantics, and error-code surface remain unchanged from v1.0.1. The `tests/integration/json-stdout.test.ts` and `tests/unit/error-code-surface.test.ts` regression nets are unchanged.

### Added

- **`docs/getting-started.md`** — canonical first-thirty-minutes guide documenting three onboarding paths side by side (tutorial / manual / AI-assisted) plus the per-task agent loop, phase-boundary checkpoints, and adapter management. Replaces the in-README Quickstart. ([#81])
- **`docs/workflows/greenfield.md`** — guidance for projects starting from an empty repo: which onboarding path matches a greenfield project, how to fill `plan brief` / `plan constitution`, the Foundations → Capability → Stabilization phase pattern. ([#82])
- **`docs/workflows/brownfield-feature.md`** — guidance for adopting `code-pact` on an existing project: scope discipline (one feature, not retroactive backfill), three coexistence options for a pre-existing `CLAUDE.md` / `AGENTS.md`, verify-command sizing. ([#82])
- **`docs/concepts/sample-phase.md`** — what the `init` wizard's optional sample phase actually contains (P1 Welcome, no tasks, one verify command), why the default is yes, keep / rename / delete decision matrix. ([#82])
- **`docs/ja/getting-started.md`** — Japanese counterpart to `docs/getting-started.md`. README / migration translations remain English-primary and out of scope for this release. ([#83])
- **`.github/ISSUE_TEMPLATE/bug-report.yml`** and **`.github/ISSUE_TEMPLATE/feature-request.yml`** — structured intake forms that ask for `--json` reproduction, the relevant exit code, and an explicit scope check against the MVP non-goals. ([#84])
- **`.github/pull_request_template.md`** — contract checklist covering Stable (v1.0) surface preservation, atomic-write contract, and the no-new-runtime-dependency policy from `CONTRIBUTING.md`. ([#84])
- **`docs/community.md`** — where to file issues / discussions / PRs, GitHub Discussions intent (with a status note that the tab may not be enabled yet), and the scope-discipline rule that re-introducing items from the MVP non-goals list requires an `rfc`-labelled issue with an explicit scope tradeoff. ([#84])
- **`design/decisions/stability-taxonomy.md`** and **`design/rules/json-output.md`** — seed corpus so the context-quality gate in `src/core/pack/index.ts` has content to surface when a task declares `context_size: large` or `write_surface: high`. Exhaustive backfill remains out of scope. ([#85])
- **`design/phases/P9-post-v1-dogfood-onboarding.yaml`** — phase contract registering the onboarding baseline work. ([#79])

### Changed

- **`README.md`** — reduced from a 269-line monolith to a ~110-line 30-second tour plus a Reference docs link hub. Quickstart, Agent-facing usage, Managing adapters, and Low-level mode all move into `docs/getting-started.md`. ([#81], [#84])
- **`docs/dogfood.md`** — Troubleshooting section gains an "Expected warnings after a non-interactive bootstrap" entry covering `BRIEF_MISSING` / `CONSTITUTION_PLACEHOLDER` / `ADAPTER_STALE`, plus a `STATUS_DRIFT done-but-design-not-done` reminder cross-linked to the v1.0 contract section. ([#86])
- **`design/phases/P4-stabilize.yaml`** — `status: in_progress` → `status: done`. P4 had been the open phase continuously since v0.5; closing it formally now that P9 is the new chapter. ([#80])
- **`design/roadmap.yaml`** — appends P9 entry. ([#79])
- **`design/phases/P9-post-v1-dogfood-onboarding.yaml`** — phase `status: planned` → `status: done`, and every P9 task (`P9-T1` through `P9-T7`) `status: planned` → `status: done`. Clears the seven `STATUS_DRIFT done-but-design-not-done` warnings that accumulated across P9 task PRs into a single coherent release-prep flip, following the v1.0.0 / v1.0.1 release-prep pattern. (this release prep)
- **`package.json`** — version `1.0.1` → `1.0.2`. (this release prep)

### Known residuals (not blockers)

- **Tutorial path requires TTY.** `code-pact init --non-interactive` does not create the sample phase (`createSamplePhase` is wizard-only). Documented in `docs/getting-started.md` Path 1 as expected behaviour. Candidate for a future `init` UX hardening phase.
- **No `task add --non-interactive`.** CI / automation workflows use `code-pact phase import` with tasks declared in the imported YAML. Documented in `docs/getting-started.md` and `docs/dogfood.md`.

[#79]: https://github.com/toshtag/code-pact/pull/79
[#80]: https://github.com/toshtag/code-pact/pull/80
[#81]: https://github.com/toshtag/code-pact/pull/81
[#82]: https://github.com/toshtag/code-pact/pull/82
[#83]: https://github.com/toshtag/code-pact/pull/83
[#84]: https://github.com/toshtag/code-pact/pull/84
[#85]: https://github.com/toshtag/code-pact/pull/85
[#86]: https://github.com/toshtag/code-pact/pull/86

---

## [1.0.1] — 2026-05-19

**Atomic-write contract alignment.** Patch release closing a public-contract gap the v1.0 post-release audit caught: `docs/cli-contract.md` claims every listed state/design write goes through `atomicWriteText`, but six raw `fs.writeFile` call sites remained on listed paths. This release routes all of them through the shared atomic-text helper so the implementation matches the published contract.

### CLI behavior changes

None. JSON envelopes, exit codes, error codes, and human output are unchanged. Output bytes on disk are identical.

### Fixed

- **Atomic-write coverage for listed state/design writes.** Six remaining raw `fs.writeFile` call sites now route through `atomicWriteText` (`src/io/atomic-text.ts`), matching the v1.0 atomic-write guarantee in [`docs/cli-contract.md`](docs/cli-contract.md):
  - `src/core/services/createPhase.ts` — `design/roadmap.yaml` and `design/phases/<phase>.yaml` (covers `phase add` and `phase import`)
  - `src/commands/task-add.ts` — `design/phases/<phase>.yaml` rewrite
  - `src/commands/plan-brief.ts` — `design/brief.md`
  - `src/commands/plan-constitution.ts` — `design/constitution.md`
  - `src/commands/init-wizard.ts` — `design/brief.md` from the interactive `code-pact init` wizard

  An interrupted process can no longer leave any of these files half-written. The v1.0.0 internal note that claimed "every disk write in `src/` now goes through the temp-file + rename primitive" was accurate as a target but premature as a fact; this release makes it actually true for every path listed in the contract.

---

## [1.0.0] — 2026-05-19

**Stable Control Plane / GA Hardening.** Locks the public CLI surface and ships the regression nets that protect it. Every command classified `Stable (v1.0)` in [`docs/cli-contract.md`](docs/cli-contract.md) keeps its flags, exit codes, and JSON envelope shape across the v1.x line. No new commands. Migration guidance from any prior alpha lives in [`docs/migration.md`](docs/migration.md).

### CLI behavior changes

None. v0.6–v0.9 callers parse v1.0 output unchanged, and every previously stable error code retains its name and `error.code` value.

### Release channel changes

- **npm dist-tag moved from `alpha` to `latest`.** New projects can `npm install code-pact` (or `npx code-pact`) and get v1.0. Past alpha releases remain available at `npm install code-pact@alpha` for users who pinned to pre-v1.0 behaviour.

### Added

- **`docs/migration.md`** — v0.6 / v0.7 / v0.8 / v0.9 → v1.0 upgrade paths, plus a dedicated section on the `task complete` vs `design.status` contract (`task complete` records operational progress; it does NOT mutate design YAML). ([#76])
- **`docs/dogfood.md` Troubleshooting section** — recovery actions keyed to the 5 most common diagnostic codes: `MANIFEST_NOT_FOUND`, `INVALID_TASK_TRANSITION`, `PLAN_NORMALIZE_REQUIRED`, `VERIFICATION_FAILED`, `ADAPTER_GENERATOR_STALE`. ([#76])
- **Stability taxonomy in `docs/cli-contract.md`** — `Stable (v1.0)` / `Stable (human-output)` / `Experimental` / `Deprecated` bands. Every command is classified explicitly. The 4-category public error code tables (public 20 / plan 13 / doctor 9 / adapter 10 / internal 1 = 53 codes) replace the previous 11-code summary table. ([#74])
- **State file write guarantees section in `docs/cli-contract.md`** — documents every file `code-pact` writes, the atomic-write strategy (temp file + rename, no fsync), the path-safety scope (adapter-managed file writes only for v1.0), and the single-process-owner assumption for `.code-pact/`. ([#75])
- **`tests/integration/e2e-workflow.test.ts`** — end-to-end smoke for the full agent-facing loop (init → adapter install → recommend → task context → task start → task complete → plan lint → plan analyze → adapter upgrade --check → doctor → validate) plus a pre-v0.9 migration scenario. ([#73])
- **`tests/integration/migration.test.ts`** — 12 scenarios covering v0.6-era (design done, no progress events), v0.8-era (mixed events + historical tasks), and v0.9-era (manifest with stale `generator_version`) project shapes. ([#75])
- **`tests/integration/json-stdout.test.ts`** — 31 tests asserting every `Stable (v1.0)` command emits a single valid JSON document on stdout under `--json`. Catches the `console.log`-on-stdout regression class regardless of which command broke. ([#74])
- **`tests/unit/error-code-surface.test.ts`** — walks `src/` for every `code: "..."` / `.code = "..."` / `outCode = "..."` literal and locks the de-facto error-code surface against a categorized table. Adding a new code in `src/` requires updating both this test and `docs/cli-contract.md`. ([#74])
- **`tests/helpers/cli.ts`** — shared subprocess + JSON-envelope helpers (`createTempProject`, `run`, `expectJsonOk`, `expectJsonErr`, `ensureCliBuilt`). New tests use it; existing tests are intentionally not migrated. ([#73])
- **Subprocess coverage for `validate`, `task add`, `plan brief`, `plan prompt`, `plan constitution`** — 14 new integration tests filling the v1.0 contract-freeze prerequisite of "every Stable command has subprocess coverage". ([#72])

### Changed

- **`README.md`** — Status section rewritten to list the v1.0 stable surface explicitly and call out cursor / gemini-cli as Experimental. Install snippets drop the `@alpha` dist-tag from primary examples (with a one-line note that `@alpha` still resolves to past prereleases). Quickstart aligned with the v0.9 adapter subcommand layout. ([#76])
- **`docs/cli-contract.md`** — Path-safety scope wording reframed to make explicit that "v1.0 path-traversal hardening is scoped to adapter-managed generated file writes" — not "design/progress need no validation". Existing state files remain protected by their schema validation and atomic-write behaviour. ([#76])
- **`CHANGELOG.md` preamble** — switches from "alpha-only" versioning to a SemVer statement covering both the v0.x-alpha history and the upcoming v1.x line. ([#76])
- **`scripts/assert-package-metadata.mjs`** — version regex broadened to accept plain `X.Y.Z` in addition to the v0.x `X.Y.Z-(alpha|beta|rc).N` prerelease form. (this PR)
- **`design/phases/P8-stable-control-plane.yaml`** — new phase covering the v1.0 work end-to-end across six tasks. Each task was a single PR, each green individually. (P8-T1 .. P8-T6)

### Fixed

- **`task add` honors post-command `--json`** like every other `task` subcommand. Pre-v1.0, `code-pact task add P1 --json` silently dropped to the human stderr path because `cmdTaskAdd` only consulted the global pre-form `--json` flag. The fix brings the JSON envelope contract in line across the whole `task` subcommand group ahead of contract freeze. ([#72])

### Internal

- **`src/commands/init.ts`** — last raw `fs.writeFile` call site converted to the shared `atomicWriteText` helper. Every disk write in `src/` now goes through the temp-file + rename primitive; an interrupted `init` cannot leave a half-written project file behind. Behaviour unchanged on the happy path. ([#75])
- **Test suite**: 881 tests at v0.9.0-alpha.0 → 930 tests at v1.0.0 across 66 files. New tests are all subprocess-level integration except `error-code-surface` (unit).

[#72]: https://github.com/toshtag/code-pact/pull/72
[#73]: https://github.com/toshtag/code-pact/pull/73
[#74]: https://github.com/toshtag/code-pact/pull/74
[#75]: https://github.com/toshtag/code-pact/pull/75
[#76]: https://github.com/toshtag/code-pact/pull/76

---

## [0.9.0-alpha.0] — 2026-05-19

### Behavior changes

- **`adapter --force` is narrowed to unmanaged-adoption only.** In v0.8, `code-pact adapter --force` overwrote every file unconditionally. In v0.9, `--force` adopts pre-existing files into the manifest but **NEVER** overwrites a file already recorded in the manifest (`managed-modified`). Destructive overwrite of a locally-modified managed file now requires `code-pact adapter upgrade <agent> --write --accept-modified`. The bare-form `code-pact adapter --agent X [--force] [--regen-skills]` continues to work in v0.9.x with a one-line stderr deprecation notice (suppressed under `--json`) and is internally routed to `adapter install`; it will be removed in v0.10. `--regen-skills` is preserved as a role-scoped force that applies `--force`-equivalent to skill files only and **still** cannot override `managed-modified`. ([#67], [#69])

### Added

- **`adapter` subcommand group.** `code-pact adapter` is promoted from a flat command into a router following the `cmdPlan` / `cmdPhase` pattern. Six subcommands ship:
  - `adapter list [--json]` — enumerate registered adapters with manifest state (enabled / experimental flags, fileCount, lastGeneratedAt, generatorVersion, manifestInvalid surfacing). ([#67])
  - `adapter install <agent> [--force] [--model <v>] [--regen-skills] [--json]` — first-time install, writes the per-agent manifest. Idempotent across re-runs. ([#67])
  - `adapter upgrade <agent> --check [--json]` — read-only drift report. Exit 0 clean / 1 drift detected / 2 config. Never touches disk or manifest. ([#69])
  - `adapter upgrade <agent> --write [--force] [--accept-modified] [--model <v>] [--regen-skills] [--json]` — apply changes. Exit 0 ok / 1 if any file was refused / 2 config. `--check` and `--write` are mutually exclusive and required. ([#69])
  - `adapter doctor [--agent <name>] [--json]` — manifest-aware adapter-scoped diagnostics. ([#68])
  - Bare-form `adapter [--agent <name>] ...` — deprecated v0.5–v0.8 surface; routes to `install`. ([#67])
- **Per-agent manifest at `.code-pact/adapters/<agent>.manifest.yaml`.** Records every file code-pact generated, its sha256 hash (computed from LF-normalized UTF-8 bytes), an `adapter_schema_version`, a `profile_fingerprint` (the adapter-output-affecting profile fields), the `generator_version` at install time, and an ISO-8601 `generated_at`. zod `.strict()` at every level so accidental field drift fails loudly. ([#66])
- **2-axis file-state classifier (`local × desired`).** Local: `new | unmanaged | managed-clean | managed-modified | managed-missing`. Desired: `current | stale | absent`. The 8-value action enum `write | skip | adopt | replace_unmanaged | update | update_manifest | refuse | warn` is derived from `(local, desired, mode, force, acceptModified)` by a pure function. Catches the "manifest hash drifted but content is still current" case (`managed-modified × current`) so re-runs refresh the manifest without touching disk. ([#66])
- **Nine new `ADAPTER_*` error codes** surfaced by `adapter doctor`:
  - `ADAPTER_MANIFEST_MISSING` (warning, **`adapter doctor` only** — never emitted by global doctor)
  - `ADAPTER_MANIFEST_INVALID` (error) — YAML parse or schema failure
  - `ADAPTER_GENERATOR_STALE` (warning) — manifest's `generator_version` differs from current package version (simple equality, no semver ordering)
  - `ADAPTER_SCHEMA_DRIFT` (warning) — manifest's `adapter_schema_version` older than the adapter module declares
  - `ADAPTER_PROFILE_DRIFT` (warning) — `profile_fingerprint` deep-mismatch
  - `ADAPTER_FILE_MISSING` (error) — managed-missing
  - `ADAPTER_FILE_DRIFT` (warning) — `managed-modified × stale`
  - `ADAPTER_DESIRED_STALE` (warning) — `managed-clean × stale`
  - `ADAPTER_UNMANAGED_FILE` (warning) — file under `ownedPathGlobs` but not in manifest ([#68])
- **Path-safety helpers** in `src/core/adapters/file-state.ts`. `assertSafeRelativePath` rejects absolute paths, leading `~`, `\`, Windows drive letters, `..`, `.`, and empty segments at the zod-schema level. `resolveWithinProject` additionally walks ancestors and rejects symlink-escape (a directory symlink under cwd resolving outside the project) before any write. ([#66])
- **Stable-adapter conformance suite** (`tests/integration/adapter-conformance.test.ts`). Per-agent snapshots of the manifest file list at `tests/fixtures/adapters/<agent>/expected-files.txt`. Content invariants assert all four required CLI references (`code-pact recommend`, `code-pact task context`, `code-pact task complete`, `code-pact validate`), `--json` mention, install→install idempotency, zod round-trip, and `generateDesiredFiles` path safety. cursor and gemini-cli are intentionally excluded with an inline comment citing `EXPERIMENTAL_AGENTS`. ([#70])
- **`recommend` and `validate` references in stable adapter instruction templates.** The generated `CLAUDE.md`, `AGENTS.md`, and `docs/code-pact/agent-instructions.md` now open with a step 0 telling the agent to call `code-pact recommend --phase <id> --task <id> --agent <name> --json` first; a `validateNote` below the verify note also points at `code-pact validate --json`. ([#70])

### Changed

- **Global `doctor` is manifest-aware when a manifest exists.** With a manifest, the legacy `ADAPTER_MISSING` warning is skipped in favor of the manifest-aware codes (`ADAPTER_FILE_MISSING`, `ADAPTER_FILE_DRIFT`, `ADAPTER_DESIRED_STALE`, `ADAPTER_GENERATOR_STALE`, `ADAPTER_SCHEMA_DRIFT`, `ADAPTER_PROFILE_DRIFT`, `ADAPTER_UNMANAGED_FILE`); findings carry an `[agent-name]` prefix on the message so consumers can attribute issues without changing the `DoctorIssue` shape. `ADAPTER_MANIFEST_MISSING` is **never** emitted by global `doctor` — it's an `adapter doctor`-only signal so existing projects don't suddenly become noisy after upgrading to v0.9. ([#68])
- **Global `doctor` is byte-identical to v0.8 when no manifest exists.** Projects that have not yet run `adapter install` continue to see the legacy `ADAPTER_MISSING` warning exactly as in v0.8 — no new codes, no new lines, no surprise CI failures. ([#68])
- **`docs/cli-contract.md`** rewrites the v0.5 `adapter` section as v0.9: subcommand list, JSON envelope shapes for every subcommand, the `--force` action table, manifest schema reference, `--regen-skills` role scoping, bare-form deprecation, full 8-row action enum table, full 9-row `ADAPTER_*` error code table, and "Interaction with global doctor" subsection. ([#67], [#68], [#69])
- **`docs/dogfood.md`** adds an "Upgrading an adapter safely (v0.9)" section covering the check/apply split, the `--force` narrowing, the 8-row action enum, and the `adapter doctor` workflow. Quick-reference table updated with `adapter list / install / upgrade / doctor` rows. ([#70])
- **`README.md` agent-facing usage** updated to match the v0.9 subcommand surface. (this PR)

### Internal

- **Pure `AdapterDescriptor` model.** Each of the five adapters now exposes `generateDesiredFiles(input): Promise<DesiredAdapterFile[]>` returning only the file list it would write (LF-normalized UTF-8 content, project-relative POSIX paths). All disk write I/O, force / skip / regenSkills logic, and directory placeholder creation moved into the command layer. Generators are byte-identical to v0.8 output for unchanged inputs. ([#65])
- **Action matrix + classifier are pure functions.** `classifyFileState({manifestHash, diskHash, desiredHash})` and `decideAction({local, desired, mode, force, acceptModified})` live in `src/core/adapters/file-state.ts` and are exhaustively unit-tested across every cell of the 5×3 × 3 modes × flag combinations. ([#66])
- **Atomic manifest I/O.** `writeManifest` validates the input through `AdapterManifest.parse` BEFORE any bytes hit disk, then delegates to the existing `atomicWriteText` helper. `readManifest` returns `null` on ENOENT (fresh project) and throws on parse failure so doctor can surface `ADAPTER_MANIFEST_INVALID`. ([#66])
- **`readPackageVersion` extracted** to `src/lib/package-version.ts` so adapter modules can read the current code-pact version into `generator_version` without duplicating the cli.ts helper. Tries both `..` and `../..` from `import.meta.url` so it works from `dist/cli.js` AND from tsx-driven runs of source files. ([#67])
- **220 new tests** across the v0.9 surface:
  - 30 schema tests (`tests/unit/schemas/adapter-manifest.test.ts`)
  - 22 manifest I/O tests (`tests/unit/core/adapter-manifest.test.ts`)
  - 59 file-state classifier + action matrix tests (`tests/unit/core/adapter-file-state.test.ts`)
  - 7 install unit tests added to `tests/unit/commands/adapter.test.ts`
  - 9 list unit tests (`tests/unit/commands/adapter-list.test.ts`)
  - 23 doctor unit tests (`tests/unit/commands/adapter-doctor.test.ts`)
  - 24 upgrade unit tests (`tests/unit/commands/adapter-upgrade.test.ts`)
  - 21 CLI integration tests (`tests/integration/adapter-cli.test.ts`)
  - 19 conformance tests (`tests/integration/adapter-conformance.test.ts`)
  - 6 global-doctor manifest-aware regression tests added to `tests/unit/commands/doctor.test.ts`
- **`design/phases/P7-adapter-platform.yaml`** — new phase covering the v0.9 work end-to-end across seven tasks. Each task was a single PR, each green individually.
- **Self-dogfood manifest not committed in v0.9.** `.code-pact/` remains gitignored as per-developer state, consistent with how v0.8 shipped. Users running v0.9 on a fresh clone see the legacy `ADAPTER_MISSING` warning from global `doctor` until they run `code-pact adapter install <agent>`. A future release may revisit the gitignore policy.

[#65]: https://github.com/toshtag/code-pact/pull/65
[#66]: https://github.com/toshtag/code-pact/pull/66
[#67]: https://github.com/toshtag/code-pact/pull/67
[#68]: https://github.com/toshtag/code-pact/pull/68
[#69]: https://github.com/toshtag/code-pact/pull/69
[#70]: https://github.com/toshtag/code-pact/pull/70

---

## [0.8.0-alpha.0] — 2026-05-19

### Added

- **`recommend` extended into a deterministic execution-planning contract** — `code-pact recommend --phase <id> --task <id> [--agent <name>] [--json]` now returns a context profile, planning posture, ambiguity action, escalation order, structured preflight commands, categorical budget profile, and machine-readable structured reasons. Strictly additive over v0.7: existing fields (`phaseId / taskId / agentName / tier / effort / modelId / reasons`) are byte-identical for pre-v0.8 fixtures, asserted by an integration regression test.
- **New `recommend` output fields:**
  - `contextProfile` (`small | medium | large`) — derived from `context_size`, bumped up one notch when `ambiguity == high`. ([#62])
  - `verificationProfile` — passthrough of `verification_strength`. ([#62])
  - `planningRequired` (boolean) — true for `architecture` type, medium / high ambiguity, high risk, or `requires_decision == true`. ([#62])
  - `ambiguityAction` (`proceed | clarify_before_implementation | split_recommended`) — top-down evaluation; clarify wins over split when both could fire. ([#62])
  - `allowedEscalation` — tier-driven ordered escalation hints. Cheap tiers lead with `increase_effort`; larger tiers lead with `increase_context`. ([#62])
  - `preflight` — structured array of suggested pre-implementation commands (`plan lint`, `plan analyze`, `task status <id>`), capped at 3 entries. Each entry has `argv` ready to spawn and a `reason` field. Advisory only (`required: false` in v0.8). ([#62])
  - `budgetProfile` — three categorical magnitudes (`toolCalls`, `contextFiles`, `verificationCommands`). Explicitly **not** an estimate of tokens, cost, or time. ([#62])
  - `structuredReasons` — machine-readable mirror of `reasons[]`. Each entry pairs one Task factor with one effect on the output. ([#62])
- **`RecommendResultV2` zod schema** with `.strict()` at every level. Drift-guards the contract — accidental snake_case fields (e.g. `planning_required` next to `planningRequired`) fail loudly instead of producing a silent split contract. ([#59])
- **`formatRecommend()` extended** with Planning / Escalation / Preflight / Budget sections beneath the existing 5-line Task / Agent / Tier / Model / Effort summary. Section/field structure, not a snapshot — tests assert labels and lines, not byte-exact output. ([#62])

### Changed

- **`docs/cli-contract.md` `recommend` section** rewritten with per-field tables (type, allowed values, trigger) plus inline tables for `PreflightEntry`, `BudgetProfile`, and `StructuredReason`. The JSON example now matches the real camelCase shape — the previous example used snake_case keys (`task_id`, `phase_id`, `agent`, `model_id`), but the implementation has always emitted camelCase. This fixes a pre-existing doc drift. ([#63])
- **`docs/dogfood.md` per-task flow** promotes `recommend` from "step 0 (optional)" to the recommended starting point. New "Reading `recommend --json` (v0.8)" section explains which fields drive which agent decisions. ([#63])
- **`README.md` agent-facing usage** updated to match the new dogfood flow. (this PR)

### Internal

- New `src/core/recommend/` modules — pure no-I/O decision functions, each paired with unit tests covering every decision-table row:
  - `context-profile.ts` — `context_size + ambiguity → contextProfile`. ([#60])
  - `planning.ts` — `isPlanningRequired` + `recommendAmbiguityAction`. ([#60])
  - `escalation.ts` — `ModelTier → ordered EscalationStep[]`. ([#60])
  - `budget.ts` — `Task → BudgetProfile`. ([#60])
  - `preflight.ts` — `Task → PreflightEntry[]`, capped at 3, Task-derivable triggers only. ([#61])
- `src/core/schemas/recommend-result.ts` — zod schema with strict mode and inner schemas for `PreflightEntry`, `BudgetProfile`, `StructuredReason`. ([#59])
- `src/commands/recommend.ts` — `runRecommend` composes every decision module and zod-validates the result before return. The public `RecommendResult` type aliases `RecommendResultV2` so callers keep working with stricter inferred field types. ([#62])
- `design/phases/P6-budgeted-execution.yaml` — new phase covering the v0.8 work end-to-end. Phase verification chains `pnpm typecheck / test / build + plan lint + plan normalize --check + plan analyze + recommend` so subsequent phases inherit the v0.8 execution-planning gate. ([#63])
- ~110 new tests across the recommend modules, schemas, and integration suite (`tests/integration/recommend-v2.test.ts`). Includes a back-compat regression that asserts every v0.7 field is byte-identical for the project-a fixture, and a CLI subprocess test confirming the `{ok:true, data:{...}}` envelope shape is preserved.
- Pre-existing local agent profile (`.code-pact/agent-profiles/claude-code.yaml`) is gitignored and absent in CI checkout. Where the v0.8 tests render formatter output, they feed stub `RecommendResult` values directly into `formatRecommend` rather than calling `runRecommend` against the repo's own profile, so CI never hits `AGENT_NOT_FOUND`.

[#59]: https://github.com/toshtag/code-pact/pull/59
[#60]: https://github.com/toshtag/code-pact/pull/60
[#61]: https://github.com/toshtag/code-pact/pull/61
[#62]: https://github.com/toshtag/code-pact/pull/62
[#63]: https://github.com/toshtag/code-pact/pull/63

---

## [0.7.0-alpha.0] — 2026-05-18

### Added

- **`plan lint [--strict] [--include-quality] [--json]`** — read-only static integrity check over `design/roadmap.yaml` and every referenced phase file. Default checks: `INVALID_YAML`, `SCHEMA_ERROR`, `MISSING_PHASE_FILE`, `DUPLICATE_TASK_ID`, `DUPLICATE_PHASE_ID`, `PHASE_ID_MISMATCH`, `ORPHAN_PHASE_FILE` (warning), `PHASE_ID_NAMING` (warning), `TASK_ID_PHASE_PREFIX` (warning). `--include-quality` opt-in adds `WEAK_DOD` and `PLACEHOLDER_VERIFICATION` so subjective heuristics never fail CI by default. `--strict` promotes warnings to exit 1. Lenient loader: a broken `roadmap.yaml` does not stop the run — it falls back to scanning `design/phases/` directly and lists the roadmap-dependent checks it skipped under `data.skipped_checks`. ([#54])
- **`plan normalize [--check | --write] [--json]`** — conservative line-based normalization for files under `design/` plus the progress log. YAML files: CRLF → LF, strip trailing whitespace, single trailing newline. Markdown files: CRLF → LF and final newline only — trailing whitespace is preserved because two trailing spaces are a meaningful hard line break. No YAML parse/re-stringify, so comments survive byte-for-byte. `--check` (default) never writes; `--write` uses an atomic temp-file + rename per file. `--check` + `--write` → `PLAN_NORMALIZE_CONFLICT` exit 2. Typo flags (e.g. `--wite`) are rejected explicitly so they cannot silently degrade to a no-op. ([#55])
- **`plan analyze [--strict] [--include-historical] [--json]`** — cross-artifact drift detection comparing design `status` against derived progress state. One `STATUS_DRIFT` code with five mutually exclusive kinds in `details.kind` (top-down evaluation guarantees a single task never produces two issues): `done-blocked-conflict` (error), `done-with-incomplete-events` (error), `done-historical` (warning, hidden by default, never affects exit), `done-but-design-not-done` (warning), `in-progress-no-events` (warning). Also reports `PHASE_DONE_WITH_OPEN_TASKS` (error) and reuses the shared `ORPHAN_PROGRESS_EVENT` detector (warning). ([#56])
- **`hidden_by_default` and `affects_exit` issue metadata** — analyze issues can now hide themselves from default output and from `--strict` exit codes without inventing a third severity tier. This is the safety property that keeps `plan analyze` from blowing up on pre-v0.7 done tasks that have no progress events. `--include-historical` exposes hidden issues in JSON; the exit code is independent of visibility. ([#56])

### Changed

- **`doctor` and `plan lint` share their duplicate / orphan / missing-reference detectors** through `src/core/plan/checks.ts`, so the two commands cannot drift apart. doctor's `DoctorIssue` shape, codes, and human messages are preserved; only the detector source moved. ([#53])
- **`src/io/atomic-text.ts`** — raw-text atomic writer extracted from `atomicWriteYaml`. `plan normalize --write` uses it directly (no YAML stringify). `atomicWriteYaml` is now a one-line wrapper over the same primitive. ([#53])

### Internal

- New `src/core/plan/` module:
  - `state.ts` — strict (`loadPlanState`) and lenient (`collectPlanArtifacts`) loaders. The lenient loader collects parse / schema / reference issues per file and, when the roadmap is unparseable, falls back to scanning `design/phases/` while reporting the skipped roadmap-dependent checks.
  - `shared.ts` — `PlanIssue` type with optional `hidden_by_default` / `affects_exit` / `details` metadata.
  - `checks.ts` — pure detectors shared with doctor (duplicate task / phase id, phase id mismatch, missing / orphan phase file, orphan progress event) plus naming heuristics used only by lint.
  - `lint.ts` — `plan lint` orchestration (structural checks + opt-in quality heuristics).
  - `normalize.ts` — file walker + pure YAML/Markdown line normalizers.
  - `analyze.ts` — cross-artifact drift detection.
- `design/phases/P5-planning-integrity.yaml` — new phase covering the v0.7 work end-to-end, dogfooded through `task start` / `task complete` for each task (T1-T5). Phase verification chains `pnpm typecheck / test / build + plan lint + plan normalize --check + plan analyze` so subsequent phases inherit the integrity gate.
- `vitest.config.ts` — `fileParallelism: false`. The integration suites all rebuild `dist/cli.js` in `beforeAll`, and concurrent workers raced against tsup's output-dir cleanup. Sequencing test files removes the race; in-file concurrency is unaffected. ([#54])
- ~60 new tests across `src/core/plan/` (state, checks, lint, normalize, analyze) and the three new `tests/integration/plan-*.test.ts` suites, including a dedicated **historical fixture** regression test that asserts `plan analyze` exits 0 on a project mirroring pre-v0.7 history (done tasks with no progress events).

[#53]: https://github.com/toshtag/code-pact/pull/53
[#54]: https://github.com/toshtag/code-pact/pull/54
[#55]: https://github.com/toshtag/code-pact/pull/55
[#56]: https://github.com/toshtag/code-pact/pull/56

---

## [0.6.0-alpha.0] — 2026-05-18

### Added

- **`task start <task-id> [--agent <name>] [--json]`** — records a `started` event in `progress.yaml`. Idempotent: starting an already-started task exits 0 with `{ already_started: true }` and leaves `progress.yaml` byte-identical. ([#51])
- **`task status <task-id> [--json]`** — pure-read inspection of a task's derived current state and full event history. **Agent-neutral**: takes no `--agent` flag and does not validate agent configuration, so CI / monitoring / human reviewers can use it without project agent setup. ([#51])
- **`task block <task-id> --reason "<text>" [--agent <name>] [--json]`** — records a `blocked` event with a required reason. The reason is enforced at both the CLI (`CONFIG_ERROR` for missing / empty) and the Zod schema (`superRefine` rejects `blocked` events without `reason`), so hand-edited progress logs cannot accumulate empty blocks. Allowed only from `started` or `resumed`. ([#51])
- **`task resume <task-id> [--agent <name>] [--json]`** — records a `resumed` event. Allowed only from `blocked`; any other current state returns `INVALID_TASK_TRANSITION`. ([#51])
- **`INVALID_TASK_TRANSITION` error code (exit 2)** — raised by `task start/block/resume/complete` when a requested state transition is not allowed from the current derived state. ([#51])
- **`ProgressEvent.reason?: string` field** — semantically distinct from the existing `notes` field. `reason` records the justification for a state transition (currently used for `blocked` events). ([#51])

### Changed

- **`task complete` rejects `blocked → done`** with `INVALID_TASK_TRANSITION` (exit 2) and leaves `progress.yaml` byte-identical. The task must be `resume`d first so the `resumed` event records the unblock decision. `planned → done` remains permitted at the command layer for v0.5 backwards compatibility. ([#51])
- **`task complete` idempotency** check now routes through the shared `deriveTaskState` helper instead of an inline `events.find` scan. The `kind: "already_done"` and exit-0 semantics are preserved; existing v0.5 integration tests pass unchanged. ([#51])
- **`EventStatus` enum extended** with `blocked` and `resumed` (in-place; `started`, `done`, and `failed` are preserved). Existing `progress.yaml` files remain forward-compatible — no schema migration is performed. ([#51])
- **`recommend` promoted into the agent-facing loop narrative** in README, `docs/dogfood.md`, and `docs/cli-contract.md`. Source code for `recommend` is unchanged; only documentation was updated. The new agent-facing flow is `recommend → task context → task start → implement → task block / resume → task complete`. ([#51])

### Internal

- New module `src/core/progress/`:
  - `io.ts` — `atomicWriteYaml` / `loadProgressLog` / `appendEvent` consolidated from `task-complete.ts`'s inline helpers; shared with all four new task-state commands.
  - `task-state.ts` — `deriveTaskState` (last-event-wins reduction over the append-only log) and `assertTransition` (deterministic state-machine enforcement).
- 35 new unit tests + 5 new integration tests covering the state machine end-to-end.

[#51]: https://github.com/toshtag/code-pact/pull/51

---

## [0.5.0-alpha.0] — 2026-05-18

### Added

- **Model-aware adapter generation (`--model`)** — `adapter --agent claude-code --model <version>` generates a `CLAUDE.md` with a "Model guidance" section containing effort-level and extended-thinking guidance tailored to the specific Claude version. Supported: `opus-4.7`, `opus-4.6`, `sonnet-4.6`. The `model_version` field in the agent profile YAML is used as the default when the flag is omitted. ([#46])
- **`--regen-skills` flag** — forces skill file regeneration without overwriting `CLAUDE.md`. Useful after adding new phases with new `verification.commands`. ([#48])
- **Skill generation from `verification.commands`** — `adapter --agent claude-code` now reads every phase in `design/roadmap.yaml` and auto-generates a `.claude/skills/<name>.md` file for each unique verification command (e.g. `pnpm test` → `/test`). Duplicate commands across phases produce a single skill. ([#48])
- **Context quality gates in `task context`** — the context pack now adapts its content to task attributes: `context_size: large` includes `constitution.md` + all decisions; `context_size: small` is minimal (no rules/decisions/constitution); `ambiguity: high` includes `constitution.md` + recent done events in the phase; `write_surface: high` bypasses the `applies_to` filter and includes all rule files. `PackResult` exposes `includedConstitution`. ([#47])
- **Plan quality `doctor` checks** — four new checks: `BRIEF_MISSING` (warning, `design/brief.md` absent), `CONSTITUTION_PLACEHOLDER` (warning, constitution not yet edited), `EMPTY_OBJECTIVE` (error, phase objective < 10 chars), `ADAPTER_STALE` (warning, no `model_version` in agent profile). ([#49])
- **`disabled_checks` config** — `.code-pact/doctor.yaml` with a `disabled_checks` array suppresses individual doctor checks per project. ([#49])
- **`design/` structure** — `design/brief.md`, `design/constitution.md`, and `design/roadmap.yaml` now ship with real content so the repo can dogfood itself.

### Changed

- `adapter --agent claude-code` always generates dynamic skills in addition to the three fixed skills (`/context`, `/verify`, `/progress`).

[#46]: https://github.com/toshtag/code-pact/pull/46
[#47]: https://github.com/toshtag/code-pact/pull/47
[#48]: https://github.com/toshtag/code-pact/pull/48
[#49]: https://github.com/toshtag/code-pact/pull/49

---

## [0.4.0-alpha.0] — 2026-05-18

### Added

- **`plan` subcommand group** — a new top-level subcommand collects all AI-assisted project planning tools under one roof:
  - `code-pact plan brief [--force]` — interactive wizard that collects project description, target users, and differentiator, then writes `design/brief.md`. ([#41])
  - `code-pact plan prompt [--clipboard]` — reads `design/brief.md` and `design/constitution.md`, then writes a structured AI planning prompt to stdout (optionally copies to clipboard via pbcopy / xclip). ([#42])
  - `code-pact plan constitution [--force]` — interactive wizard that collects a project description and comma-separated core principles, then writes `design/constitution.md`. ([#44])
- **Flexible `phase import`** — `TaskImport` lenient schema now accepts AI-generated YAML where only `id` is required on tasks; missing fields (`type`, `ambiguity`, `risk`, `context_size`, `write_surface`, `verification_strength`, `expected_duration`, `status`) are filled with sensible defaults. The result includes a `completed_fields` report so callers can surface which fields were auto-filled. Add `--strict` to restore the previous behavior (all Task fields required). ([#43])
- **Locale inheritance** — all generated content (adapter files, templates, `init` wizard output) now respects the locale saved in `.code-pact/project.yaml`. After running `init` with `ja-JP`, subsequent commands like `adapter` automatically use Japanese without `--locale`. ([#40])
- **`plan brief` integration in `init` wizard** — the init wizard now offers to collect a project brief as the final step, writing `design/brief.md` immediately after project initialization. ([#41])

### Changed

- `plan` usage line updated to `brief | prompt | constitution`.
- `phase import` JSON result now includes `completed_fields: Array<{ taskId, fields }>`.

### Fixed

- Locale not being inherited by adapter generators after `init` with `ja-JP` (locale was re-detected from env on every command, ignoring the saved project.yaml value). ([#40])

[#40]: https://github.com/toshtag/code-pact/pull/40
[#41]: https://github.com/toshtag/code-pact/pull/41
[#42]: https://github.com/toshtag/code-pact/pull/42
[#43]: https://github.com/toshtag/code-pact/pull/43
[#44]: https://github.com/toshtag/code-pact/pull/44

---

## [0.3.0-alpha.0] — 2026-04-27

### Added

- **`phase add` wizard** — running `code-pact phase add` without flags now launches an interactive wizard in a TTY. `--non-interactive` opts back into flag-only mode. ([#35])
- **`task add <phase-id>`** — interactive wizard that adds a task to an existing phase, with auto-numbering (`<phase-id>-T<n>`) when `--id` is omitted. ([#35])
- **`doctor` health checks** — added `DUPLICATE_TASK_ID` (error), `LOCAL_NOT_GITIGNORED` (warning), and `ADAPTER_MISSING` (warning) checks. ([#36])
- **`validate` command** — CI-friendly variant of `doctor`; exits 1 on errors, 0 on warnings only. Add `--strict` to promote warnings to exit 1. ([#36])
- **Locale persistence** — `init` writes the selected locale to `.code-pact/project.yaml`; subsequent commands resolve locale from that file before falling back to `LANG` / `en-US`. ([#34])
- **Next Steps** — `init` now prints `phase add → task add → task context` reminders to stderr after completion. ([#34])
- **Adapter docs updated** — all five adapter generators now include the full `task context → implement → task complete` standard workflow, with `pack` noted as an internal command. ([#37])

### Changed

- `phase add` now accepts `--non-interactive` to opt out of the wizard.
- `phase-wizard.ts` extracted as shared UI logic used by both `phase new` and `phase add`.
- i18n prompts for weight, confidence, and risk now include inline hints.

[#34]: https://github.com/toshtag/code-pact/pull/34
[#35]: https://github.com/toshtag/code-pact/pull/35
[#36]: https://github.com/toshtag/code-pact/pull/36
[#37]: https://github.com/toshtag/code-pact/pull/37

---

## [0.2.0-alpha.0] — 2026-04-06

### Added

- **`task complete`** — marks a task done by running `verify` and appending a `done` event to `.code-pact/state/progress.yaml`. Idempotent; `--dry-run` previews without writing. ([#20])
- **`phase import <yaml>`** — bulk-imports phases (with tasks) from a YAML file into the roadmap. Detects duplicate phase and task IDs before writing anything. `--force` skips colliding phases. ([#22])
- **`recommend`** — suggests a model tier for a task based on task attributes. ([#24])
- **`doctor`** — reports project structure issues (missing files, schema errors, orphan phase files, …) in human-friendly output. ([#29])
- **Cursor adapter** (experimental) — `.cursor/rules/code-pact.mdc` with `alwaysApply: true`. ([#25])
- **Gemini CLI adapter** (experimental) — `GEMINI.md` at project root. ([#26])
- **`--json` global flag** — all commands emit `{ ok, data, error? }` to stdout when `--json` is present; human-readable output goes to stderr. ([#19])
- **`--non-interactive` flag** — explicit opt-out of wizards even in a TTY. ([#28])

### Changed

- `phase ls` now emits a table by default and JSON with `--json`.
- `task context` resolves task ids across all phases (no `--phase` required).

---

## [0.1.0-alpha.0] — 2026-03-16

Initial alpha release.

### Added

- `init` — interactive wizard to bootstrap `.code-pact/` config and `design/` skeleton.
- `phase add` / `phase new` / `phase ls` / `phase show` — phase lifecycle commands.
- `task add` — add a task to a phase YAML.
- `task context` — generate a context pack for an agent.
- `progress` — show weighted progress against a named baseline snapshot.
- `pack` — write a context pack file to `.context/<agent>/`.
- `verify` — run deterministic completion criteria (verify commands + definition of done).
- `adapter` — generate per-agent instruction files (Claude Code, Codex, Generic).
- Claude Code, Codex, and Generic adapters (stable).
