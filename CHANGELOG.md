# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow `MAJOR.MINOR.PATCH-alpha.N` while the project is in alpha.

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
