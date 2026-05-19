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
| `AGENT_NOT_FOUND` | `pack`, `adapter`, `task context`, `task start/block/resume/complete` | Agent name not in `project.yaml` |
| `AGENT_NOT_ENABLED` | `task context`, `task start/block/resume/complete` | Agent is configured but has `enabled: false` |
| `INVALID_TASK_TRANSITION` | `task start/block/resume/complete` | Requested state transition is not allowed from the current state |
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

### `plan lint [--strict] [--include-quality] [--json]` (v0.7)

Read-only static integrity check over `design/roadmap.yaml` and every referenced phase file. Intended as a checkpoint command at phase or PR boundaries, not as a per-task gate.

**Checks (default):**
- `INVALID_YAML` (error) — a file failed to parse
- `SCHEMA_ERROR` (error) — a file failed Zod validation
- `MISSING_PHASE_FILE` (error) — roadmap references a phase file that does not exist on disk
- `DUPLICATE_TASK_ID` (error) — the same task id appears in more than one phase
- `DUPLICATE_PHASE_ID` (error) — the same phase id appears twice
- `PHASE_ID_MISMATCH` (error) — `phase.id` inside the YAML does not match the id the roadmap uses to reference it
- `ORPHAN_PHASE_FILE` (warning) — a `.yaml` under `design/phases/` is not referenced by the roadmap
- `PHASE_ID_NAMING` (warning) — phase id does not match `P<N>`
- `TASK_ID_PHASE_PREFIX` (warning) — task id does not match `<phase>-T<N>`

**`--include-quality` (opt-in heuristics):**
- `WEAK_DOD` (warning) — DoD bullets shorter than 10 chars or matching `/TODO|FIXME|tbd/i`
- `PLACEHOLDER_VERIFICATION` (warning) — verification commands starting with `echo`, `true`, or `noop`

Quality heuristics are intentionally off by default so `--strict` does not fail CI on subjective judgments.

**Exit code:**
- `0` — no errors. Without `--strict`, warnings are also exit 0.
- `1` — errors present, or warnings present with `--strict`.
- `2` — argument / configuration error.

**JSON shape (success):**
```json
{
  "ok": true,
  "data": {
    "errors": 0,
    "warnings": 0,
    "include_quality": false,
    "strict": false,
    "skipped_checks": [],
    "issues": []
  }
}
```

**JSON shape (failure):**
```json
{
  "ok": false,
  "error": { "code": "PLAN_LINT_FAILED", "message": "..." },
  "data": {
    "errors": 1,
    "warnings": 0,
    "include_quality": false,
    "strict": false,
    "skipped_checks": [],
    "issues": [
      {
        "code": "DUPLICATE_TASK_ID",
        "severity": "error",
        "message": "Task \"SHARED-T1\" appears in both phase \"P1\" and \"P2\"",
        "phase_id": "P2",
        "task_id": "SHARED-T1"
      }
    ]
  }
}
```

**Lenient loader behavior:** when `roadmap.yaml` itself is unparseable, plan lint still scans `design/phases/` directly so duplicate-id and naming checks can run on parseable phase files. Roadmap-dependent checks (`MISSING_PHASE_FILE`, `ORPHAN_PHASE_FILE`) are listed in `data.skipped_checks` so the agent can see exactly which checks were short-circuited.

### `plan normalize [--check | --write] [--json]` (v0.7)

Conservative, line-based normalization for files under `design/` and the progress log. No YAML parse/re-stringify; the command operates on raw bytes per line so comments, key ordering, and document structure survive untouched.

**Targets:**
- Every `*.yaml` and `*.md` file reachable from `design/` (recursive).
- `.code-pact/state/progress.yaml` (located via the shared progress IO helper, not hard-coded).

**Normalization by file kind:**

| Kind | CRLF → LF | Trailing whitespace stripped | Final newline = 1 |
|---|---|---|---|
| `*.yaml`, `*.yml` | ✓ | ✓ | ✓ |
| `*.md` | ✓ | **preserved** | ✓ |

Markdown trailing whitespace is preserved because two trailing spaces are a meaningful hard line break. Stripping them would silently change rendered output.

**Modes:**
- No flag → `--check` (safe default; never writes).
- `--check` → dry-run. Lists files that would change and exits 1 when any are found.
- `--write` → applies normalization via the atomic-text helper. Exits 0 even when files were rewritten because writing is the command's purpose.
- `--check` and `--write` together → `PLAN_NORMALIZE_CONFLICT` exit 2.
- Unknown flag (e.g. typo `--wite`) → `CONFIG_ERROR` exit 2 (does NOT silently degrade to `--check`).

**Idempotency:** running `--write` twice in a row is a true no-op — the second invocation skips every file because the content already matches the normalized form. Running `--check` immediately after `--write` reports zero changes.

**Exit code:**
- `0` — `--check` found nothing to do, or `--write` succeeded.
- `1` — `--check` found at least one file that would change.
- `2` — argument conflict or unknown option.
- `3` — unexpected runtime error during a write.

**JSON shape (clean tree):**
```json
{
  "ok": true,
  "data": {
    "mode": "check",
    "changed_count": 0,
    "changes": [],
    "written": []
  }
}
```

**JSON shape (dirty tree under `--check`):**
```json
{
  "ok": false,
  "error": {
    "code": "PLAN_NORMALIZE_REQUIRED",
    "message": "plan normalize: 2 file(s) need normalization"
  },
  "data": {
    "mode": "check",
    "changed_count": 2,
    "changes": [
      {
        "path": "design/phases/P1.yaml",
        "kind": "yaml",
        "reasons": ["trailing whitespace", "final newline"]
      },
      {
        "path": "design/notes.md",
        "kind": "markdown",
        "reasons": ["crlf"]
      }
    ],
    "written": []
  }
}
```

**JSON shape (under `--write`):** identical to the dirty `--check` payload but with `mode: "write"`, `ok: true`, no `error` field, and `written` listing every file that was rewritten.

### `plan analyze [--strict] [--include-historical] [--json]` (v0.7)

Cross-artifact integrity check. Compares design intent (task and phase `status`) against derived progress state (`deriveTaskState` over `.code-pact/state/progress.yaml`). Read-only.

**Issue families:**

- `STATUS_DRIFT` (one code, five mutually exclusive kinds in `details.kind`; top-down evaluation guarantees a single task never produces two issues):

  | kind | severity | hidden_by_default | affects_exit | trigger |
  |---|---|---|---|---|
  | `done-blocked-conflict` | error | — | true | `design.status == done` && derived state is `blocked` |
  | `done-with-incomplete-events` | error | — | true | `design.status == done` && events exist && derived ∈ {started, resumed, failed} |
  | `done-historical` | warning | **true** | **false** | `design.status == done` && no progress events for this task |
  | `done-but-design-not-done` | warning | — | true | derived `done` but `design.status` is `planned` or `in_progress` |
  | `in-progress-no-events` | warning | — | true | `design.status == in_progress` && no events (likely missing `task start`) |

- `PHASE_DONE_WITH_OPEN_TASKS` (error) — a phase with `status: done` that still has tasks not in `status: done`.
- `ORPHAN_PROGRESS_EVENT` (warning) — progress event references a `task_id` that does not exist in any phase. Detector is shared with `doctor`; `plan lint` does NOT call it.

**Severity model (no `info` tier):** `done-historical` carries `hidden_by_default: true` and `affects_exit: false` directly on the issue. This keeps the existing `error | warning` severity contract intact while letting analyze hide pre-v0.6 history from default output and from `--strict` exit codes.

**Flags:**
- `--strict` — promote `affects_exit: true` warnings to exit 1. Mirrors `validate --strict` and `plan lint --strict`. Does NOT flip `hidden_by_default`; historical issues stay hidden.
- `--include-historical` — render issues marked `hidden_by_default: true`. JSON consumers see them in `data.issues`. Exit code is unchanged because `affects_exit: false` is independent of visibility.

**Exit code:**
- `0` — no `affects_exit: true` errors; under `--strict`, no `affects_exit: true` warnings either.
- `1` — at least one exit-relevant issue, or a schema/parse failure during the strict load.
- `2` — argument / configuration error.

**JSON shape (clean tree):**
```json
{
  "ok": true,
  "data": {
    "summary": {
      "phases": 5,
      "tasks": 20,
      "errors": 0,
      "warnings": 0,
      "hidden": 16
    },
    "strict": false,
    "include_historical": false,
    "issues": []
  }
}
```

**JSON shape (failing tree):**
```json
{
  "ok": false,
  "error": {
    "code": "PLAN_ANALYZE_FAILED",
    "message": "plan analyze failed: 1 error(s), 0 warning(s)"
  },
  "data": {
    "summary": { "phases": 1, "tasks": 1, "errors": 1, "warnings": 0, "hidden": 0 },
    "strict": false,
    "include_historical": false,
    "issues": [
      {
        "code": "STATUS_DRIFT",
        "severity": "error",
        "message": "Task \"P1-T1\" is marked done in design but the progress log derives state \"blocked\".",
        "phase_id": "P1",
        "task_id": "P1-T1",
        "file": "design/phases/P1.yaml",
        "details": {
          "kind": "done-blocked-conflict",
          "design_status": "done",
          "derived_state": "blocked"
        }
      }
    ]
  }
}
```

## `adapter` (v0.9)

In v0.9 `adapter` becomes a subcommand group. Each subcommand produces a stable
`{ok, data} | {ok:false, error:{code, message}}` JSON envelope under `--json`. The bare-form
`code-pact adapter [--agent <name>] ...` (v0.5–v0.8) continues to work and routes internally
to `adapter install` with a one-line stderr deprecation notice (suppressed under `--json`);
it will be removed in v0.10.

- `adapter list [--json]` — enumerate registered adapters with manifest state
- `adapter install <agent> [--force] [--model <v>] [--regen-skills] [--json]` — first-time install + writes manifest
- `adapter upgrade <agent> --check [--json]` — read-only drift report
- `adapter upgrade <agent> --write [--force] [--accept-modified] [--model <v>] [--regen-skills] [--json]` — apply changes
- `adapter doctor [--agent <name>] [--json]` — adapter-scoped diagnostics

### Per-agent manifest

`adapter install` writes `.code-pact/adapters/<agent>.manifest.yaml` recording every file
code-pact generated, its sha256 hash (computed from LF-normalized UTF-8 bytes), and a
fingerprint of the adapter-output-affecting profile fields. The manifest is the source of
truth for `adapter upgrade` / `adapter doctor`. Schema is documented in
`src/core/schemas/adapter-manifest.ts`; see `RelativePosixPath` for the path-safety rules
(no `..`, no leading `/` or `~`, no `\`, no Windows drive letters, no `.` segments).

### `--force` semantics — narrowed in v0.9

**Behavior change vs v0.8.** In v0.8, `adapter --force` overwrote every file unconditionally.
In v0.9, `--force` is **unmanaged-adoption only**: it adopts pre-existing files into the
manifest, but it NEVER overwrites a file already recorded in the manifest (`managed-modified`).

| Disk state | `--force` action |
|---|---|
| `new` (manifest no, disk no) | always write (`--force` not needed) |
| `unmanaged × current` (disk matches desired, no manifest entry) | with `--force`: **adopt** (manifest only, no write) |
| `unmanaged × stale` (disk differs from desired, no manifest entry) | with `--force`: **replace_unmanaged** (overwrite + manifest) |
| `managed-*` (already in the manifest) | `--force` is ignored — install is hands-off |

Destructive overwrite of a managed-modified file requires `adapter upgrade --write --accept-modified`.
The `--regen-skills` flag is a role-scoped force: it makes `--force` apply only to files with
`role: skill`. It still cannot override `managed-modified`.

### `adapter list [--json]`

Returns one entry per registered adapter:

```json
{
  "ok": true,
  "data": {
    "agents": [
      {
        "name": "claude-code",
        "supported": true,
        "experimental": false,
        "enabled": true,
        "manifestPath": "/abs/path/.code-pact/adapters/claude-code.manifest.yaml",
        "profilePath": "/abs/path/.code-pact/agent-profiles/claude-code.yaml",
        "manifestPresent": true,
        "fileCount": 14,
        "lastGeneratedAt": "2026-05-19T12:00:00.000Z",
        "generatorVersion": "0.9.0-alpha.0"
      }
    ]
  }
}
```

`experimental: true` for `cursor` and `gemini-cli`. `enabled: true` when the agent appears
under `project.yaml`'s `agents:` list with `enabled != false`. `manifestPresent: false` when
no manifest exists yet; `fileCount` / `lastGeneratedAt` / `generatorVersion` are omitted
in that case. When the manifest YAML exists but fails parse or schema validation, the entry
sets `manifestInvalid: true` and omits the detail fields — use `adapter doctor`
for the parse error.

### `adapter install <agent> [--force] [--model <v>] [--regen-skills] [--json]`

Generates the adapter for `<agent>` (positional, required) and writes the manifest.

`--model <version>` produces a **model-aware** instruction file for the claude-code adapter
with effort-level and extended-thinking guidance tailored to a specific Claude version
(`opus-4.7`, `opus-4.6`, `sonnet-4.6`). Unknown values produce a fallback note rather than
an error. Takes precedence over `model_version` in the agent profile YAML; if neither is
set, the version-agnostic template is used.

`--regen-skills` is the role-scoped `--force` described above; documented separately because
it's the common way users handle stale dynamic skill files after the roadmap's
`verification.commands` changes.

Result envelope:

```json
{
  "ok": true,
  "data": {
    "agentName": "claude-code",
    "manifestPath": "/abs/.code-pact/adapters/claude-code.manifest.yaml",
    "generatorVersion": "0.9.0-alpha.0",
    "created": ["/abs/CLAUDE.md", "/abs/.claude/skills/context.md"],
    "skipped": [],
    "adopted": [],
    "files": [
      { "path": "/abs/CLAUDE.md", "relPath": "CLAUDE.md", "role": "instruction", "action": "write" }
    ]
  }
}
```

`created` lists files written (action `write` or `replace_unmanaged`). `adopted` lists files
recorded in the manifest without write (action `adopt`). `skipped` lists files we deliberately
did not touch (action `skip`, e.g. `managed-clean × current` is idempotent). `files[].action`
follows the eight-value enum from `src/core/adapters/file-state.ts`.

Exit codes: `0` ok, `2` config (missing positional / `AGENT_NOT_FOUND`), `3` internal.

### Automatic skill generation

When the claude-code adapter generates files, it reads `verification.commands` from every
phase in `design/roadmap.yaml` and emits a slash-command skill file for each unique command:

| Command | Skill file | Slash command |
|---|---|---|
| `pnpm test` | `.claude/skills/test.md` | `/test` |
| `pnpm typecheck` | `.claude/skills/typecheck.md` | `/typecheck` |
| `npm run lint` | `.claude/skills/lint.md` | `/lint` |

Skill names are derived by stripping the package-manager prefix (`pnpm`, `npm run`, `yarn`,
`bun run`) and sanitizing to kebab-case. If `design/roadmap.yaml` does not exist, no dynamic
skills are generated (the three fixed skills — `/context`, `/verify`, `/progress` — are always
written). Duplicate commands across phases produce a single skill file.

### `adapter upgrade <agent> --check | --write [flags] [--json]`

Inspects or applies adapter drift against the installed manifest. Requires an
existing manifest at `.code-pact/adapters/<agent>.manifest.yaml`; run
`adapter install <agent>` first on fresh projects. `--check` and `--write` are
**mutually exclusive and required** — passing neither (or both) is a
`CONFIG_ERROR` exit 2 so the intent is unambiguous in CI logs.

Common flags:

- `--force` — adopt unmanaged files only. **Never** overrides `managed-modified`.
- `--accept-modified` — required to overwrite `managed-modified × stale` files. Available only on `--write`.
- `--regen-skills` — role-scoped force: applies `--force`-equivalent to `role: skill` files only. Still cannot override `managed-modified`.
- `--model <version>` — same semantics as `adapter install --model`; affects Claude `CLAUDE.md` generation.

#### Action enum (8 values)

Each plan entry carries a `local`, `desired`, and `action` field. `action` is one of:

| Value | Meaning |
|---|---|
| `write` | Create or recreate the file from desired content (managed-missing, new). |
| `skip` | Idempotent no-op (managed-clean × current). |
| `adopt` | Record an existing on-disk file in the manifest; no content write (unmanaged × current with `--force`). |
| `replace_unmanaged` | Overwrite an unmanaged-but-stale file (unmanaged × stale with `--force`). |
| `update` | Overwrite a managed file. Used for `managed-clean × stale` (safe) and `managed-modified × stale` with `--accept-modified`. |
| `update_manifest` | Refresh the manifest hash only; disk content already matches desired (managed-modified × current). |
| `refuse` | Would destroy local modifications without `--accept-modified` (managed-modified × stale). |
| `warn` | Surfaceable in `--check` for unmanaged rows regardless of `--force`. `--write` never produces this. |

#### `adapter upgrade <agent> --check`

Fully read-only. Returns the action `--write` WOULD take for each desired file
with two intentional differences:

- **Unmanaged rows always return `warn`** regardless of `--force`, so callers can
  see which files are adoptable before opting in.
- **`managed-modified × stale` always returns `refuse`** regardless of
  `--accept-modified`, so callers see the pending destructive action before
  re-running with `--write --accept-modified`.

```json
{
  "ok": true,
  "data": {
    "agentName": "claude-code",
    "mode": "check",
    "manifestPath": "/abs/.code-pact/adapters/claude-code.manifest.yaml",
    "generatorVersion": "0.9.0-alpha.0",
    "clean": false,
    "plan": [
      {
        "path": "/abs/CLAUDE.md",
        "relPath": "CLAUDE.md",
        "role": "instruction",
        "local": "managed-clean",
        "desired": "stale",
        "action": "update"
      }
    ]
  }
}
```

Exit codes: `0` clean (every entry is `action: skip`), `1` drift detected (any
non-skip action), `2` on `CONFIG_ERROR` (missing positional, mutex flags) /
`AGENT_NOT_FOUND` / `MANIFEST_NOT_FOUND`.

#### `adapter upgrade <agent> --write`

Executes the action matrix. The new manifest reflects the post-write state:
files written / adopted have their hash refreshed, skipped managed files
preserve their existing hash, refused entries are preserved unchanged, and
orphans (manifest entries no longer emitted by the generator) drop out. Files
on disk that are no longer in the new manifest remain where they are; the next
`adapter doctor` run surfaces them as `ADAPTER_UNMANAGED_FILE` if they fall
under the adapter's `ownedPathGlobs`.

```json
{
  "ok": true,
  "data": {
    "agentName": "claude-code",
    "mode": "write",
    "manifestPath": "/abs/.code-pact/adapters/claude-code.manifest.yaml",
    "generatorVersion": "0.9.0-alpha.0",
    "clean": false,
    "plan": [
      { "path": "/abs/CLAUDE.md", "relPath": "CLAUDE.md", "role": "instruction",
        "local": "managed-clean", "desired": "stale", "action": "update" }
    ]
  }
}
```

Exit codes: `0` ok (all changes applied or all-skip), `1` when any file was
`refused` (managed-modified × stale without `--accept-modified`), `2` on the
same `CONFIG_ERROR` / `AGENT_NOT_FOUND` / `MANIFEST_NOT_FOUND` conditions as
`--check`.

### `adapter doctor [--agent <name>] [--json]`

Read-only manifest-aware health check. Reports issues per agent without
modifying the manifest or any generated files. With `--agent`, inspects
exactly that adapter regardless of `project.yaml` enabled-state; without
`--agent`, inspects every enabled agent listed under `project.yaml`'s
`agents:` (with `enabled != false`).

```json
{
  "ok": true,
  "data": {
    "ok": false,
    "issues": [
      {
        "code": "ADAPTER_FILE_MISSING",
        "severity": "error",
        "message": "Managed file \"CLAUDE.md\" is missing from disk",
        "agent": "claude-code",
        "path": "/abs/CLAUDE.md"
      }
    ]
  }
}
```

`data.ok` is `false` when any issue has `severity: "error"`; warnings alone
don't fail. Exit code mirrors that: `0` clean or warnings-only, `1` when
any error is present, `2` for `AGENT_NOT_FOUND` (only on explicit
`--agent`). Each issue carries the agent name in `agent`; file-level
issues additionally carry `path` (absolute).

#### Error codes

| Code | Severity | Trigger |
|---|---|---|
| `ADAPTER_MANIFEST_MISSING` | warning | Agent is enabled but `.code-pact/adapters/<agent>.manifest.yaml` does not exist. **`adapter doctor` only — never emitted by global `doctor`.** |
| `ADAPTER_MANIFEST_INVALID` | error | Manifest YAML failed to parse or failed schema validation. Aborts further per-agent checks. |
| `ADAPTER_GENERATOR_STALE` | warning | Manifest's `generator_version` differs from the current code-pact package version (simple equality, no semver ordering). |
| `ADAPTER_SCHEMA_DRIFT` | warning | Manifest's `adapter_schema_version` is older than the adapter module's declared value. |
| `ADAPTER_PROFILE_DRIFT` | warning | Agent profile fields recorded in `profile_fingerprint` (instruction_filename, context_dir, optional skill_dir / hook_dir / resolved_model) have changed since install. |
| `ADAPTER_FILE_MISSING` | error | A file listed in the manifest is missing from disk (`managed-missing` × `absent`). |
| `ADAPTER_FILE_DRIFT` | warning | A managed file was locally modified AND the generator output also moved on (`managed-modified` × `stale`). Requires `--accept-modified` on `upgrade --write`. |
| `ADAPTER_DESIRED_STALE` | warning | A managed file is unchanged locally but the generator now produces different content (`managed-clean` × `stale`). Safe to apply with `upgrade --write` (no `--accept-modified` required). |
| `ADAPTER_UNMANAGED_FILE` | warning | A file under one of the adapter's `ownedPathGlobs` exists on disk but is not in the manifest. Narrow scope — does NOT fire for arbitrary user-created files such as `.claude/skills/custom.md`. |

`managed-modified × current` (hash drift only) and `managed-clean × current`
(happy path) are intentionally silent.

#### Interaction with global `doctor`

The global `code-pact doctor` is **manifest-aware when a manifest exists**
and **byte-identical to v0.8 when no manifest exists**. Specifically:

- No manifest → the legacy `ADAPTER_MISSING` warning fires for each enabled
  agent whose instruction file is missing. The v0.8 contract is preserved
  for projects that have not yet run `adapter install`.
- Manifest present → `ADAPTER_MISSING` is skipped and the more precise
  manifest-aware codes (`ADAPTER_FILE_MISSING`, `ADAPTER_FILE_DRIFT`,
  `ADAPTER_DESIRED_STALE`, `ADAPTER_GENERATOR_STALE`, `ADAPTER_SCHEMA_DRIFT`,
  `ADAPTER_PROFILE_DRIFT`, `ADAPTER_UNMANAGED_FILE`) appear instead.
- `ADAPTER_MANIFEST_MISSING` is **never** emitted by global `doctor`. It is
  an `adapter doctor`-only signal so existing projects don't suddenly
  become noisy on upgrade. Use `adapter doctor` to learn that the
  manifest hasn't been created yet.

Findings from manifest-aware checks appear in global `doctor` output with
a `[agent-name]` prefix on the message so consumers can attribute issues
without changing the global `DoctorIssue` shape.

### Bare-form back-compat (deprecated)

`code-pact adapter [--agent <name>] [--force] [--model <v>] [--regen-skills] [--json]`
continues to work in v0.9 and is internally routed to `adapter install`. When `--agent` is
omitted, it defaults to `claude-code`. A one-line deprecation notice is printed to stderr;
the notice is suppressed under `--json` so agents reading the JSON envelope are not
surprised by an extra stderr line. The bare form will be removed in v0.10.

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
3. **State check**. Derived from the append-only progress log via `deriveTaskState`. If the current state is `done`, returns `{ ok: true, data: { already_done: true } }` with exit 0 and **does not re-run verification** (to force re-verification, use `task complete --rerun` — planned for a later release). If the current state is `blocked`, exits 2 with `INVALID_TASK_TRANSITION`: the task must be resumed via `task resume <id>` before it can complete, so the resume event records the unblock decision. Other current states (`planned`, `started`, `resumed`, `failed`) proceed to verification. `planned → done` is permitted at the command layer for v0.5 backwards compatibility, even though the state machine itself does not list that transition.
4. **Verification (preflight mode)**. Runs the deterministic checks from `code-pact verify` — `commands` and `decision` — but skips the state-consistency checks (`progress_event`, `task_status`) because `task complete` is the action that produces that state. On failure, exits 1 with `VERIFICATION_FAILED`; `progress.yaml` is left byte-identical. Standalone `code-pact verify` still runs all four checks for after-the-fact consistency auditing.
5. **Progress append**. On verify pass, appends a `done` event with shape `{ task_id, status: "done", at, actor: "agent", agent, evidence }` to `progress.yaml`. The write uses best-effort atomic replacement (`writeFile` to a temp file + `rename`) to prevent partial-write corruption. Concurrent `task complete` calls are out of scope for v0.2.
6. **`--dry-run`**. Skips the progress append. Returns `{ ok: true, data: { dry_run: true, would_append: <event> } }`. `progress.yaml` is byte-identical.

The `agent` field on `ProgressEvent` is optional for backward compatibility with v0.1 logs that predate `task complete`.

## `task start` / `task status` / `task block` / `task resume` (v0.6)

These four commands fill the execution-state gap between `task context` and `task complete`. They all read and append to the same `.code-pact/state/progress.yaml` log used by `task complete`, and they share the same state-machine rules enforced via `deriveTaskState` and `assertTransition`.

**Allowed transitions:**

```
planned   → started
started   → blocked | done | failed
blocked   → resumed | failed
resumed   → blocked | done | failed
done      → terminal
failed    → started   (internal retry path, not user-facing in v0.6)
```

Any disallowed transition exits 2 with `INVALID_TASK_TRANSITION` and leaves `progress.yaml` byte-identical.

### `task start <task-id> [--agent <name>] [--json]`

Appends a `started` event. Validates `--agent` against `project.yaml` (defaults to `default_agent` when omitted) and emits the standard `AGENT_NOT_FOUND` / `AGENT_NOT_ENABLED` errors.

Idempotency: if the current state is already `started`, the command exits 0 with `{ ok: true, data: { already_started: true, ... } }` and `progress.yaml` is byte-identical.

### `task status <task-id> [--json]`

**Pure read.** Does not accept `--agent` and does not validate agent configuration, so it can be invoked from CI, monitoring, or by a human reviewer without project agent setup. Resolves the task to its phase and returns the derived current state plus the full event history for the task.

JSON envelope:

```json
{
  "ok": true,
  "data": {
    "task_id": "P1-T1",
    "phase_id": "P1",
    "current": "blocked",
    "last_event": { "task_id": "P1-T1", "status": "blocked", "at": "...", "actor": "agent", "agent": "claude-code", "reason": "..." },
    "history": [ /* full chronological history for this task */ ]
  }
}
```

`current` is one of `planned | started | blocked | resumed | done | failed`. `last_event` and `history` reflect only events whose `task_id` matches.

### `task block <task-id> --reason "<text>" [--agent <name>] [--json]`

Appends a `blocked` event. `--reason` is **required** at the CLI layer and stored in the new `ProgressEvent.reason` field (distinct from `notes`, which remains a free-form memo). An empty or whitespace-only reason raises `CONFIG_ERROR` (exit 2). The schema also enforces non-empty `reason` for blocked events via `superRefine`, so progress.yaml stays honest even under hand-editing.

Allowed only from `started` or `resumed`. Block from `planned`, `blocked`, or `done` returns `INVALID_TASK_TRANSITION` (exit 2).

### `task resume <task-id> [--agent <name>] [--json]`

Appends a `resumed` event. Allowed only from `blocked` — any other current state returns `INVALID_TASK_TRANSITION` (exit 2).

## `recommend` (v0.8)

`code-pact recommend --phase <id> --task <id> [--agent <name>] [--json]` returns a deterministic execution plan for a given task — model tier, effort, context profile, planning posture, escalation order, preflight commands, and a categorical budget profile — based on Task metadata (`type`, `ambiguity`, `risk`, `context_size`, `write_surface`, `verification_strength`, `expected_duration`, `requires_decision`).

This is the entry point of the agent-facing loop: agents should call `recommend` first, **before** fetching the context pack or marking the task started, then use its output to decide what to load, how hard to think, and what to verify before implementation.

Read-only. The command does not mutate any state.

**JSON shape:**

All field names are camelCase. Enum / identifier values are snake_case where applicable (matches existing `model_map` keys like `highest_reasoning`).

```json
{
  "ok": true,
  "data": {
    "phaseId": "P6",
    "taskId": "P6-T1",
    "agentName": "claude-code",
    "tier": "highest_reasoning",
    "effort": "high",
    "modelId": "claude-opus-4-7",
    "reasons": ["task type is architecture"],

    "contextProfile": "large",
    "verificationProfile": "strong",
    "planningRequired": true,
    "ambiguityAction": "clarify_before_implementation",
    "allowedEscalation": ["increase_context", "ask_human"],
    "preflight": [
      {
        "id": "plan_lint",
        "command": "plan lint",
        "argv": ["plan", "lint", "--json"],
        "displayCommand": "code-pact plan lint --json",
        "reason": "planning_required",
        "required": false
      },
      {
        "id": "plan_analyze",
        "command": "plan analyze",
        "argv": ["plan", "analyze", "--json"],
        "displayCommand": "code-pact plan analyze --json",
        "reason": "planning_required",
        "required": false
      }
    ],
    "budgetProfile": {
      "toolCalls": "medium",
      "contextFiles": "many",
      "verificationCommands": "full"
    },
    "structuredReasons": [
      { "factor": "type", "value": "architecture", "effect": "tier=highest_reasoning" }
    ]
  }
}
```

The output is zod-validated before return. The contract uses strict mode at every level, so accidental snake_case drift (e.g. `planning_required` next to `planningRequired`) fails loudly instead of producing a silent split contract.

### Field reference

**Existing fields (preserved from earlier versions):**

| Field | Type | Notes |
|---|---|---|
| `phaseId` | string | Phase ID as passed in `--phase`. |
| `taskId` | string | Task ID as passed in `--task`. |
| `agentName` | string | Agent name as passed in `--agent` (defaults to `claude-code`). |
| `tier` | enum | `highest_reasoning` \| `balanced_coding` \| `cheap_mechanical`. From `recommendTier(task)`. |
| `effort` | enum | `low` \| `medium` \| `high`. Tier-dependent. |
| `modelId` | string | Concrete vendor model ID resolved via `AgentProfile.model_map[tier]`. |
| `reasons` | string[] | Human-readable rationale strings for the tier choice. Always at least one entry. |

**v0.8 additive fields:**

| Field | Type | Trigger |
|---|---|---|
| `contextProfile` | `small` \| `medium` \| `large` | Pass-through of `context_size`, bumped up one notch when `ambiguity == high`. |
| `verificationProfile` | `weak` \| `medium` \| `strong` | Pass-through of `verification_strength`. |
| `planningRequired` | boolean | True for `type == architecture`, `ambiguity in {medium, high}`, `risk == high`, or `requires_decision == true`. |
| `ambiguityAction` | `proceed` \| `clarify_before_implementation` \| `split_recommended` | Top-down: `requires_decision == true` → clarify; `ambiguity == high` → clarify; `ambiguity == medium && risk == high` → clarify; `expected_duration == long && write_surface == high && ambiguity == medium && risk != high` → split; else proceed. |
| `allowedEscalation` | EscalationStep[] | Tier-driven ordered list of escalation hints. `cheap_mechanical` → `[increase_effort, increase_context, escalate_tier]`; `balanced_coding` → `[increase_context, increase_effort, escalate_tier, ask_human]`; `highest_reasoning` → `[increase_context, ask_human]` (no tier above). |
| `preflight` | PreflightEntry[] | Suggested commands to run **before** implementation. Capped at 3 entries. v0.8 emits, in order: `plan lint` and `plan analyze` when `planningRequired == true`; `task status <id>` when `task.status == "in_progress"`. Agent decides whether to run them. |
| `budgetProfile` | BudgetProfile | Three categorical magnitudes — **not** token / cost / time estimates. See below. |
| `structuredReasons` | StructuredReason[] | Machine-readable mirror of `reasons[]`. Each entry pairs one Task factor with one effect on the output. Always at least one entry. |

**PreflightEntry shape:**

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable identifier (`plan_lint`, `plan_analyze`, `task_status` in v0.8). |
| `command` | string | Human-readable command name. |
| `argv` | string[] | argv tail to pass to `code-pact`. |
| `displayCommand` | string | Full command string for human display. |
| `reason` | string | Why this entry was emitted (e.g. `planning_required`, `task_in_progress`). |
| `required` | boolean | Always `false` in v0.8 — preflight is advisory, never mandatory. |

**BudgetProfile shape:**

| Field | Type | Decision rule |
|---|---|---|
| `toolCalls` | `low` \| `medium` \| `high` | `high` if `write_surface == high` OR `expected_duration == long`; `low` if `write_surface == low` (and not the high case above); else `medium`. |
| `contextFiles` | `few` \| `several` \| `many` | `small` → `few`; `medium` → `several`; `large` → `many` (mapped from `context_size`). |
| `verificationCommands` | `minimal` \| `standard` \| `full` | Pass-through of `verification_strength` (`weak` → `minimal`; `medium` → `standard`; `strong` → `full`). |

`budgetProfile` is intentionally **categorical**, not numeric. It is a relative-magnitude hint, not an estimate of actual tokens, cost, or time. Provider-side token estimation is out of scope for v0.8.

**StructuredReason shape:**

| Field | Type | Notes |
|---|---|---|
| `factor` | string | Task factor that influenced the output (e.g. `type`, `ambiguity`, `requires_decision`). |
| `value` | string | Observed value of that factor (e.g. `architecture`, `high`, `true`). |
| `effect` | string | The output property it drove (e.g. `tier=highest_reasoning`, `planning_required`, `ambiguity_action=clarify_before_implementation`). |

**Exit codes:**
- `0` — success
- `2` — missing `--phase` / `--task`, or unknown phase / task / agent

**Error codes:** `PHASE_NOT_FOUND`, `TASK_NOT_FOUND`, `AGENT_NOT_FOUND`, `CONFIG_ERROR`.

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
