# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow `MAJOR.MINOR.PATCH-alpha.N` while the project is in alpha.

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
