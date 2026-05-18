# CLI Contract

This document is the canonical reference for code-pact's CLI surface
contract. It defines stdout/stderr behavior, JSON output shapes, exit
codes, error codes, TTY/CI detection, and interactive-mode rules.

The contract is part of the public API. Breaking changes here require
a version bump and a migration note.

## Stdout / stderr

- **stdout** carries the primary command result. In human mode, this is
  formatted text. In JSON mode (`--json` set globally or on the command),
  stdout contains exactly one JSON document per invocation, terminated
  by a newline.
- **stderr** carries human-readable progress logs, errors, and any
  output that would otherwise pollute stdout.
- Child processes invoked by `verify` and similar commands have their
  stdout and stderr captured. Captured output is forwarded to stderr in
  human mode or included inside the JSON `data` envelope in JSON mode.
  It is never written directly to stdout.

## JSON output shape

`--json` is accepted both before and after the command name. The two
positions are equivalent:

```sh
code-pact --json phase ls
code-pact phase ls --json
```

In JSON mode, every command emits exactly one of these shapes to stdout:

```json
{ "ok": true, "data": { ... } }
{ "ok": false, "error": { "code": "...", "message": "..." }, "data": { ... } }
```

The `data` field on errors is optional and used when the command was
able to compute partial results before failing (for example, `verify`
returning the failed criteria alongside the error code).

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Verification or check failed (non-fatal command outcome) |
| 2 | Usage or configuration error (bad flags, missing inputs, schema violation) |
| 3 | Internal error (unexpected exception, file system failure, bug) |

A successful operation always exits 0. A command that completes but
reports a logical failure (such as `verify` reporting unmet criteria)
exits 1. Commands invoked with malformed arguments or against an
invalid project structure exit 2. Unhandled exceptions exit 3.

## Error codes

Error codes appear in the `error.code` field of the JSON envelope and
in stderr messages. They are stable identifiers that callers can match
against.

| Code | Raised by | Meaning |
|------|-----------|---------|
| `CONFIG_ERROR` | most commands | Bad flags, missing required input, malformed YAML |
| `ALREADY_INITIALIZED` | `init` | `.code-pact/` already exists without `--force` |
| `BASELINE_NOT_FOUND` | `progress` | Named baseline snapshot missing |
| `PHASE_NOT_FOUND` | `phase show`, `pack`, `verify`, `recommend` | Phase id not in `roadmap.yaml` |
| `TASK_NOT_FOUND` | `pack`, `verify`, `task context` | Task id not present anywhere |
| `AMBIGUOUS_TASK_ID` | `task context` | Same task id exists in multiple phases |
| `AGENT_NOT_FOUND` | `pack`, `adapter`, `task context` | Agent name not in `project.yaml` |
| `AGENT_NOT_ENABLED` | `task context`, `task complete` | Agent is configured but has `enabled: false` |
| `VERIFICATION_FAILED` | `verify`, `task complete` | Deterministic completion check did not pass |
| `INTERNAL_ERROR` | any command | Catch-all for unhandled exceptions |

New error codes may be added without a major version bump. Removing or
renaming an existing code is a breaking change.

## TTY and CI detection

The helper `isInteractive()` in `src/lib/tty.ts` is the single source
of truth. It returns true only when **all** of the following hold:

- `process.stdin.isTTY` is truthy
- `process.stdout.isTTY` is truthy
- `process.env.CI` is unset, empty, `"false"`, or `"0"`

Any other state is treated as non-interactive. Commands that have an
interactive variant (currently `init`, with `phase new` to follow)
fall back to the flag-based code path when `isInteractive()` returns
false.

## --non-interactive

`code-pact <command> --non-interactive` forces the flag-based path
even when stdin and stdout are both TTYs. The semantics match a CI
invocation:

- Interactive prompts are suppressed.
- Required information must come from flags.
- Missing required flags raise `CONFIG_ERROR` (exit 2).

This flag is for automation that runs from an interactive shell but
must not depend on user input (scripts, agent calls, scheduled jobs).

`init` in non-interactive or CI mode (`--non-interactive` or `CI=true`)
specifically requires `--locale` and `--agent`. Running `init` without
these flags in automation mode raises `CONFIG_ERROR` (exit 2) instead
of silently picking defaults.

When `--agent` lists multiple agents (e.g. `--agent claude-code,generic`)
and no dedicated default-agent option is provided, the first agent in
the list becomes `default_agent` in the generated `project.yaml`.

## `phase import`

`code-pact phase import <path> [--force] [--strict] [--json]` bulk-imports a draft roadmap. Input shape:

```yaml
phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: "..."
    # optional phase fields:
    confidence: medium
    risk: low
    verify_commands: ["pnpm test"]
    definition_of_done: ["..."]
    non_goals: ["..."]
    requires_decision: false
    tasks:                # optional; only `id` is required per task (v0.4+)
      - id: P1-T1
        description: "..."   # all other task fields are optional
        type: feature        # defaults to "feature" when omitted
        ambiguity: low       # defaults to "medium" when omitted
        risk: low            # defaults to "medium" when omitted
        context_size: small  # defaults to "medium" when omitted
        write_surface: medium
        verification_strength: strong
        expected_duration: short
        status: planned      # defaults to "planned" when omitted
```

**Lenient task schema (v0.4+):** Only `id` is required on each task entry. Missing detail fields are filled with sensible defaults at import time. This allows AI-generated roadmap YAML (which often omits `ambiguity`, `context_size`, etc.) to be imported directly without manual field-filling.

Add `--strict` to require every task field to be present explicitly; missing fields raise `CONFIG_ERROR` (exit 2) before any writes.

Validation runs in a single pre-write pass:

1. Malformed YAML or schema violation → `CONFIG_ERROR` (exit 2). No files are written.
2. The same phase id appearing twice **within the input** → `DUPLICATE_PHASE_ID` (exit 2). No files are written.
3. An input phase id colliding with an existing `roadmap.yaml` entry, **without `--force`** → `DUPLICATE_PHASE_ID` (exit 2). No files are written.
4. With `--force`, colliding phases are **skipped**; tasks declared inside those skipped phases are not imported either.
5. Across all *kept* import targets, plus the existing kept roadmap phases, every task id must be unique. Any collision → `AMBIGUOUS_TASK_ID` (exit 2). `--force` does **not** bypass this: task-level integrity wins over throughput. No files are written.
6. With `--strict`, any task that is missing one or more required Task fields → `CONFIG_ERROR` (exit 2). No files are written.

On success the JSON envelope returns

```json
{
  "ok": true,
  "data": {
    "imported_phases": [{ "id": "P1", "path": "design/phases/P1-foundation.yaml", "weight": 12 }],
    "imported_tasks": ["P1-T1"],
    "skipped_phases": [],
    "completed_fields": [
      { "taskId": "P1-T1", "fields": ["type", "ambiguity", "risk"] }
    ]
  }
}
```

`completed_fields` is non-empty only when defaults were applied. In strict mode it is always `[]`.

The validation pass detects logic errors before any write; ordinary disk failures during the per-phase write loop (disk full, permission denied) are out of scope for v0.2 and may leave a partial result.

## `plan`

`code-pact plan <subcommand>` provides AI-assisted project planning tools that feed into the design directory.

### `plan brief [--force]`

Interactive wizard that collects project description, target users, and differentiator, then writes `design/brief.md`. Requires a TTY; exits 2 in non-interactive mode. `--force` overwrites an existing file.

### `plan prompt [--clipboard]`

Reads `design/brief.md` and `design/constitution.md` (both optional), assembles a structured AI planning prompt, and writes it to stdout. Add `--clipboard` to also copy to the clipboard (via `pbcopy` on macOS or `xclip` on Linux). Does not require a TTY.

JSON output includes `has_brief`, `has_constitution`, and `clipboard_copied` flags alongside the prompt string.

### `plan constitution [--force]`

Interactive wizard that collects a project description and comma-separated core principles, then writes `design/constitution.md`. Requires a TTY; exits 2 in non-interactive mode. `--force` overwrites an existing file. Empty input falls back to i18n defaults so the file is always a valid starting point.

## `adapter` (v0.5)

`code-pact adapter [--agent <name>] [--force] [--model <version>] [--regen-skills] [--json]`

### `--model <version>`

Generates a **model-aware** instruction file for the claude-code adapter. The file includes a
"Model guidance" section with effort-level and extended-thinking guidance tailored to the
specific Claude model version.

Supported values: `opus-4.7`, `opus-4.6`, `sonnet-4.6`. Unknown values produce a fallback
note instead of an error, so future model names do not break existing pipelines.

The `--model` flag takes precedence over the `model_version` field in the agent profile YAML.
If neither is set, the generic template (no model-specific section) is used.

### `--regen-skills`

Forces all skill files in `.claude/skills/` to be regenerated without overwriting the main
`CLAUDE.md` instruction file. Use after adding new phases with new `verification.commands`.

### Automatic skill generation (v0.5.2)

When `adapter --agent claude-code` runs, it reads `verification.commands` from every phase
in `design/roadmap.yaml` and auto-generates a skill file for each unique command:

| Command | Skill file | Slash command |
|---|---|---|
| `pnpm test` | `.claude/skills/test.md` | `/test` |
| `pnpm typecheck` | `.claude/skills/typecheck.md` | `/typecheck` |
| `npm run lint` | `.claude/skills/lint.md` | `/lint` |

Skill names are derived by stripping the package-manager prefix (`pnpm`, `npm run`, `yarn`,
`bun run`) and sanitizing to kebab-case. If `design/roadmap.yaml` does not exist, no dynamic
skills are generated (the three fixed skills — `/context`, `/verify`, `/progress` — are always
written). Duplicate commands across phases produce a single skill file.

## `task context` — context quality gates (v0.5.1)

`code-pact task context <task-id> [--agent <name>] [--json]` generates a context pack whose
content is determined by the task's attributes:

| Attribute | Value | Effect on context pack |
|---|---|---|
| `context_size` | `large` | Includes `design/constitution.md` + **all** decision files |
| `context_size` | `small` | Minimal: phase contract + task definition only (no rules, decisions, or constitution) |
| `ambiguity` | `high` | Includes `design/constitution.md` + up to 5 recent `done` events from the same phase |
| `write_surface` | `high` | Includes **all** rule files in `design/rules/`, bypassing `applies_to` filters |

The `char_count` (total characters in the rendered pack) and `included_constitution` flag
are included in the `--json` result. Missing design files are silently skipped.

## `doctor` — plan quality checks (v0.5.3)

In addition to structural checks (orphan files, schema errors, duplicate IDs), `doctor` now
reports plan quality issues:

| Code | Severity | Condition |
|---|---|---|
| `BRIEF_MISSING` | warning | `design/brief.md` does not exist |
| `CONSTITUTION_PLACEHOLDER` | warning | `design/constitution.md` still contains the initial template edit hint |
| `EMPTY_OBJECTIVE` | error | A phase `objective` is blank or fewer than 10 characters |
| `ADAPTER_STALE` | warning | An enabled agent profile has no `model_version` set |

Individual checks can be suppressed per project without touching source code by creating
`.code-pact/doctor.yaml`:

```yaml
disabled_checks:
  - BRIEF_MISSING
  - ADAPTER_STALE
```

This file is optional. When absent, all checks are active.

## `task complete`

`code-pact task complete <task-id> [--agent <name>] [--json] [--dry-run]` is the deterministic completion entry point for agents.

Order of operations:

1. **Agent validation**. The same checks as `task context`: unknown agent → `AGENT_NOT_FOUND`, disabled agent → `AGENT_NOT_ENABLED`. When `--agent` is omitted, `project.yaml.default_agent` is used.
2. **Task resolution**. The same logic as `task context`: scans every phase referenced by `design/roadmap.yaml`. `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` are raised for missing / duplicate task ids.
3. **Idempotency check**. If a `done` event already exists for `task_id` in `.code-pact/state/progress.yaml`, `task complete` returns `{ ok: true, data: { already_done: true } }` with exit 0 and **does not re-run verification**. To force re-verification, use `task complete --rerun` (planned for a later release).
4. **Verification (preflight mode)**. Runs the deterministic checks from `code-pact verify` — `commands` and `decision` — but skips the state-consistency checks (`progress_event`, `task_status`) because `task complete` is the action that produces that state. On failure, exits 1 with `VERIFICATION_FAILED`; `progress.yaml` is left byte-identical. Standalone `code-pact verify` still runs all four checks for after-the-fact consistency auditing.
5. **Progress append**. On verify pass, appends a `done` event with shape `{ task_id, status: "done", at, actor: "agent", agent, evidence }` to `progress.yaml`. The write uses best-effort atomic replacement (`writeFile` to a temp file + `rename`) to prevent partial-write corruption. Concurrent `task complete` calls are out of scope for v0.2.
6. **`--dry-run`**. Skips the progress append. Returns `{ ok: true, data: { dry_run: true, would_append: <event> } }`. `progress.yaml` is byte-identical.

The `agent` field on `ProgressEvent` is optional for backward compatibility with v0.1 logs that predate `task complete`.

## Locale resolution

The active locale is resolved in this priority order:

1. `--locale <code>` flag on the command line
2. `CODE_PACT_LOCALE` environment variable
3. `locale` field in `.code-pact/project.yaml` (read when the project has already been initialized; errors are silently ignored)
4. `LANG` environment variable (checked for a `ja` prefix → `ja-JP`)
5. Default: `en-US`

This means that once a project is initialized with `ja-JP`, all subsequent commands automatically use Japanese without requiring `--locale` or environment variables.

## Stability

The shapes documented here — JSON envelope, exit codes, error codes,
`--json` position equivalence, TTY rules — are the public contract.
Pre-1.0, the surface of individual commands may change between minor
versions, but the rules in this file should not.
