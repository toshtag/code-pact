# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow `MAJOR.MINOR.PATCH-alpha.N` while the project is in alpha.

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
