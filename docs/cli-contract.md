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
in stderr messages, or as `code` on individual diagnostic issues from
`doctor` / `validate` / `plan lint` / `plan analyze` / `adapter doctor`.
They are stable identifiers that callers can match against.

The full v1.0 surface is anchored by `tests/unit/error-code-surface.test.ts`,
which fails if src/ emits a code that isn't listed below or if a code
listed below is no longer emitted. Codes are partitioned into four
categories — adding a new code in `src/` requires updating both the test
and the appropriate table below.

### Public codes (top-level error envelopes)

These appear in `error.code` of `{ok:false, error}` envelopes returned by
the listed commands. They are the primary failure signal for agents and
CI.

| Code | Raised by | Meaning |
|------|-----------|---------|
| `CONFIG_ERROR` | most commands | Bad flags, missing required input, malformed YAML |
| `UNKNOWN_COMMAND` | top-level dispatch | Unrecognized command name |
| `ALREADY_INITIALIZED` | `init` | `.code-pact/` already exists without `--force` |
| `ALREADY_EXISTS` | `plan brief`, `plan constitution` | Target design file already exists without `--force` |
| `BASELINE_NOT_FOUND` | `progress` | Named baseline snapshot missing |
| `PHASE_NOT_FOUND` | `phase show`, `pack`, `verify`, `recommend` | Phase id not in `roadmap.yaml` |
| `TASK_NOT_FOUND` | `pack`, `verify`, `task context`, `task start/block/resume/complete/status` | Task id not present anywhere |
| `AMBIGUOUS_TASK_ID` | `task context`, `task start/block/resume/complete/status` | Same task id exists in multiple phases |
| `AGENT_NOT_FOUND` | `pack`, `adapter *`, `task context`, `task start/block/resume/complete` | Agent name not in `project.yaml` |
| `AGENT_NOT_ENABLED` | `task context`, `task start/block/resume/complete` | Agent is configured but has `enabled: false` |
| `INVALID_TASK_TRANSITION` | `task start/block/resume/complete` | Requested state transition is not allowed from the current state |
| `DUPLICATE_PHASE_ID` | `phase add`, `phase import` | Phase id collides with an existing or imported phase |
| `MANIFEST_NOT_FOUND` | `adapter upgrade` | `.code-pact/adapters/<agent>.manifest.yaml` does not exist (run `adapter install` first) |
| `VERIFICATION_FAILED` | `verify`, `task complete` | Deterministic completion check did not pass |
| `VALIDATE_FAILED` | `validate` | One or more errors (or, under `--strict`, any issue) detected by the underlying doctor checks |
| `DOCTOR_FAILED` | `doctor` | One or more error-severity doctor issues found |
| `PLAN_LINT_FAILED` | `plan lint` | One or more lint issues found (under `--strict`, includes warnings) |
| `PLAN_NORMALIZE_REQUIRED` | `plan normalize --check` | At least one file needs normalization |
| `PLAN_NORMALIZE_CONFLICT` | `plan normalize` | `--check` and `--write` both passed |
| `PLAN_ANALYZE_FAILED` | `plan analyze` | One or more exit-relevant drift issues found |
| `TASK_FINALIZE_NOT_ELIGIBLE` | `task finalize` | Task's derived state from `progress.yaml` is not `done` (raised in **both** dry-run and `--write`) |
| `TASK_FINALIZE_WRITE_REFUSED` | `task finalize --write` | Safety check refused the phase YAML write (unsafe path, outside `design/phases/`, symlink escape, unparseable, etc.) |
| `PHASE_RECONCILE_WRITE_REFUSED` | `phase reconcile --write` | Every eligible task write in the phase was refused for safety reasons. Partial successes return exit 0; this fires only when **all** writes refused |
| `LOCK_HELD` (v1.5+ / P14) | `init --sample-phase`, `init` wizard, `phase add`, `phase new`, `phase import`, `task add`, `task finalize --write`, `phase reconcile --write` | Another code-pact mutation is in progress on the same project. The envelope's `data.lock_holder` carries `{pid, hostname, cmd, created_at}` for diagnostic display; `data.lock_path` is the lock file path. Transient + retryable — wait for the holder to release, or manually delete the lock file if you are certain no process holds it |
| `INTERNAL_ERROR` | any command | Reserved for unhandled exceptions |

### Plan diagnostic codes

Issue-level codes emitted by `plan lint` and `plan analyze` inside `data.issues[]`. Carry severity `error` or `warning`.

| Code | Severity | Emitter | Meaning |
|------|----------|---------|---------|
| `INVALID_YAML` | error | `plan lint` | A roadmap or phase YAML file failed to parse |
| `SCHEMA_ERROR` | error | `plan lint` | A YAML file parsed but failed Zod schema validation |
| `MISSING_PHASE_FILE` | error | `plan lint` | `roadmap.yaml` references a phase file that does not exist |
| `DUPLICATE_TASK_ID` | error | `plan lint` | The same task id appears in more than one phase |
| `PHASE_ID_MISMATCH` | error | `plan lint` | `phase.id` inside the YAML does not match the roadmap reference |
| `ORPHAN_PHASE_FILE` | warning | `plan lint` | A phase file exists on disk but is not in `roadmap.yaml` |
| `PHASE_ID_NAMING` | warning | `plan lint` | Phase id does not match `P<N>` |
| `TASK_ID_PHASE_PREFIX` | warning | `plan lint` | Task id does not match `<phase>-T<N>` |
| `WEAK_DOD` | warning | `plan lint --include-quality` | DoD entry is suspiciously short or contains `TODO`/`FIXME`/`tbd` |
| `PLACEHOLDER_VERIFICATION` | warning | `plan lint --include-quality` | Verification command starts with `echo`/`true`/`noop` |
| `STATUS_DRIFT` | error/warning | `plan analyze` | Design status disagrees with derived progress state (see `details.kind`) |
| `PHASE_DONE_WITH_OPEN_TASKS` | error | `plan analyze` | Phase marked done but at least one task is still open |
| `ORPHAN_PROGRESS_EVENT` | warning | `plan analyze`, `doctor` | Progress event references a `task_id` that does not exist in any phase |

#### Task Readiness Schema diagnostics (P10, v1.1+)

Issue-level codes emitted by `plan lint` against the optional task fields introduced in v1.1 (`depends_on`, `decision_refs`, `reads`, `writes`, `acceptance_refs`). All twelve are additive — a v1.0.x task that declares none of these fields produces none of these codes. See `design/decisions/task-readiness-schema-rfc.md` for field semantics.

| Code | Severity | Trigger |
|------|----------|---------|
| `TASK_DEPENDS_ON_UNRESOLVED` | error | `depends_on` references a task id not present in the same phase |
| `TASK_DEPENDS_ON_SELF_REFERENCE` | error | A task lists itself in `depends_on` (direct self-cycle; multi-node cycle detection is future work) |
| `TASK_DECISION_REF_NOT_FOUND` | error | `decision_refs` path does not exist on disk |
| `TASK_DECISION_REF_UNSAFE_PATH` | error | `decision_refs` path fails `assertSafeRelativePath` (traversal / absolute / etc.) |
| `TASK_READS_UNSAFE_PATH` | error | `reads` glob fails `assertSafeRelativePath` |
| `TASK_READS_GLOB_INVALID` | error | `reads` glob uses syntax outside the P10 supported subset (see RFC § Supported glob subset) |
| `TASK_READS_NO_MATCH` | warning | `reads` glob matches zero files on disk (likely a typo or a file not yet created) |
| `TASK_WRITES_UNSAFE_PATH` | error | `writes` glob fails `assertSafeRelativePath` |
| `TASK_WRITES_GLOB_INVALID` | error | `writes` glob uses syntax outside the P10 supported subset |
| `TASK_WRITES_PROTECTED_PATH` | warning | `writes` glob covers a protected path. v1.6+ (P15-T3) loads the list from `design/rules/protected-paths.md` when present; when the file is absent, falls back to the hardcoded defaults (`.git/**`, `node_modules/**`, `.code-pact/**`, `design/roadmap.yaml`, `design/phases/*.yaml`). Stays `warning` severity. Under `plan lint --strict`, the warning becomes exit-relevant per the existing binary `--strict` promotion (see § `plan lint` below). The code-pact dogfood corpus is strict-clean as of v1.5.1. Selective per-code promotion is P15-T6 scope |
| `TASK_WRITES_AUDIT_OUTSIDE_DECLARED` (v1.6+, P15-T1) | warning | Real filesystem changes touched a file matched by no declared `writes` glob. Emitted in `data.write_audit.warnings[]` on `task finalize --json` only. Advisory: never changes the exit code in v1.6 (the `--audit-strict` flag in P15-T6 opts into exit-relevant enforcement) |
| `TASK_WRITES_AUDIT_DECLARED_UNUSED` (v1.6+, P15-T4) | warning | A declared `writes` glob matched zero files in the audit's `files_touched` set. Usually signals that the declaration is stale, the task was split across PRs, or the planning artifact drifted from reality. Emitted in `data.write_audit.warnings[]` on `task finalize --json` only. Fires independently of `TASK_WRITES_AUDIT_OUTSIDE_DECLARED` — a single audit can emit both. Advisory: never changes the exit code in v1.6 (the `--audit-strict` flag in P15-T6 opts into exit-relevant enforcement) |
| `TASK_WRITES_OVER_BROAD` (v1.6+, P15-T2) | warning | A declared `writes` glob is too coarse — its root path segment is `**`, meaning the glob matches the entire repository (or huge swaths of it). Heuristic-only. Examples flagged: `**`, `**/*`, `**/*.ts`, `**/foo.ts`. Examples NOT flagged: `src/core/audit/**`, `src/**/*.ts`, `tests/unit/**`, `*.md`. Under `plan lint --strict` the warning becomes exit-relevant per the existing binary promotion |
| `TASK_ACCEPTANCE_REF_NOT_FOUND` | error | `acceptance_refs` path does not exist on disk |
| `TASK_ACCEPTANCE_REF_UNSAFE_PATH` | error | `acceptance_refs` path fails `assertSafeRelativePath` |

### Doctor diagnostic codes

Issue-level codes emitted by `doctor` / `validate` for general project health.

| Code | Severity | Meaning |
|------|----------|---------|
| `MISSING_DIR` | error | A required directory under `.code-pact/` or `design/` is absent |
| `MISSING_MODEL_TIER` | error | An agent profile is missing a required `model_map` tier |
| `EMPTY_OBJECTIVE` | error | A phase `objective` is blank or fewer than 10 characters |
| `BAK_FILE` | warning | A `.bak` file is present alongside a tracked file |
| `LOCAL_NOT_GITIGNORED` | warning | `.code-pact/` is not listed in `.gitignore` |
| `BRIEF_MISSING` | warning | `design/brief.md` does not exist |
| `CONSTITUTION_PLACEHOLDER` | warning | `design/constitution.md` still contains the template edit hint |
| `ADAPTER_STALE` | warning | An enabled agent profile has no `model_version` set |
| `STALE_CONTEXT` | warning | A cached context file is older than its source design files |

### Adapter diagnostic codes

Emitted by `adapter doctor` and (manifest-aware) global `doctor`. See the `adapter doctor` section above for severity rules and the rationale for each code.

| Code | Severity | Meaning |
|------|----------|---------|
| `ADAPTER_MISSING` | warning | (legacy v0.8) Enabled agent has no instruction file AND no manifest. Replaced by manifest-aware codes once a manifest exists. |
| `ADAPTER_MANIFEST_MISSING` | warning | `adapter doctor` only — no manifest for an enabled agent. Never emitted by global `doctor`. |
| `ADAPTER_MANIFEST_INVALID` | error | Manifest YAML failed parse or schema validation |
| `ADAPTER_GENERATOR_STALE` | warning | Manifest's `generator_version` differs from the current package version |
| `ADAPTER_SCHEMA_DRIFT` | warning | Manifest's `adapter_schema_version` is older than the module's declared version |
| `ADAPTER_PROFILE_DRIFT` | warning | Profile fields recorded in `profile_fingerprint` have changed since install |
| `ADAPTER_FILE_MISSING` | error | A file listed in the manifest is missing from disk |
| `ADAPTER_FILE_DRIFT` | warning | A managed file was locally modified AND the generator output also moved on |
| `ADAPTER_DESIRED_STALE` | warning | A managed file is unchanged locally but the generator now produces different content |
| `ADAPTER_UNMANAGED_FILE` | warning | A file under `ownedPathGlobs` exists on disk but is not in the manifest |

### Stability rules for codes (v1.0)

- **Additive changes** (new codes, new severities, new diagnostic categories) may land in minor releases without a major bump.
- **Renaming or removing** a code listed in any of the four tables above is a breaking change.
- **Re-categorizing** a code between Public / Plan / Doctor / Adapter is documentation only — agents that match on `error.code` are unaffected.

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

        # P10 (v1.1+) — Task Readiness Schema. All five fields are
        # optional and have NO synthetic default — absent stays
        # undefined, which means v1.0.x YAML behaviour is unchanged.
        depends_on: [P1-T2]                       # same-phase task ids
        decision_refs: [design/decisions/x.md]    # paths surfaced into the pack
        reads: [src/core/**/*.ts]                 # declared read surface (globs)
        writes: [src/core/foo.ts]                 # declared write surface (globs)
        acceptance_refs: [docs/cli-contract.md]   # acceptance criteria paths
```

**Lenient task schema (v0.4+):** Only `id` is required on each task entry. Missing detail fields are filled with sensible defaults at import time. This allows AI-generated roadmap YAML (which often omits `ambiguity`, `context_size`, etc.) to be imported directly without manual field-filling.

**P10 Task Readiness Schema fields (v1.1+):** `depends_on` / `decision_refs` / `reads` / `writes` / `acceptance_refs` are additive optional fields. They have **no synthetic default** — when omitted from the input they stay `undefined` on the parsed task and the corresponding pack section is omitted. Field semantics, validation rules, the supported glob subset (literal segments, single-segment `*`, full-segment `**` only), and the protected-path seed set live in [`design/decisions/task-readiness-schema-rfc.md`](../design/decisions/task-readiness-schema-rfc.md). The twelve additive lint codes that validate them are listed below under [§ Plan diagnostic codes](#plan-diagnostic-codes) → Task Readiness Schema diagnostics.

Add `--strict` to require every task field to be present explicitly; missing fields raise `CONFIG_ERROR` (exit 2) before any writes.

Validation runs in a single pre-write pass:

1. Malformed YAML or schema violation → `CONFIG_ERROR` (exit 2). No files are written.
2. **Reserved-id preflight (v1.5+ / P14).** Any input phase entry whose `id` is a reserved id (currently `TUTORIAL`) → `CONFIG_ERROR` (exit 2). The check runs **before any `createPhase` call**, so the roadmap stays byte-identical on failure — partial imports with TUTORIAL rejected mid-loop are not possible. `--force` does NOT bypass this; reserved ids are reserved at the governance layer, not the collision-handling layer. The sanctioned path for creating a `TUTORIAL` phase is `code-pact init --sample-phase`.
3. The same phase id appearing twice **within the input** → `DUPLICATE_PHASE_ID` (exit 2). No files are written.
4. An input phase id colliding with an existing `roadmap.yaml` entry, **without `--force`** → `DUPLICATE_PHASE_ID` (exit 2). No files are written.
5. With `--force`, colliding phases are **skipped**; tasks declared inside those skipped phases are not imported either.
6. Across all *kept* import targets, plus the existing kept roadmap phases, every task id must be unique. Any collision → `AMBIGUOUS_TASK_ID` (exit 2). `--force` does **not** bypass this: task-level integrity wins over throughput. No files are written.
7. With `--strict`, any task that is missing one or more required Task fields → `CONFIG_ERROR` (exit 2). No files are written.

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
    ],
    "suggested_next_steps": [
      "Review the `completed_fields` array — every entry is a task field code-pact filled with a default. Confirm each is appropriate before treating the imported tasks as source-of-truth.",
      "Run `code-pact plan lint --json` to validate the imported phase(s).",
      "Run `code-pact phase runbook P1 --json` to see the recommended per-phase next steps (reconcile-batch step is the natural follow-up after the per-task loop starts).",
      "Run `code-pact task runbook P1-T1 --json` to see the per-task lifecycle starting from a fresh task."
    ]
  }
}
```

`completed_fields` is non-empty only when defaults were applied. In strict mode it is always `[]`.

**`suggested_next_steps` (v1.4+ additive field).** Always present, even as `[]`. Names the canonical post-import sequence:

- A leading defaults-review hint is prepended when `completed_fields` is non-empty (lenient mode filled defaults).
- One `phase runbook <id>` step per imported phase.
- One `task runbook <id>` step pointing at the first imported task.
- The whole array is empty when every input phase was skipped (`imported_phases.length === 0`).

The field is additive: existing JSON consumers see no shape change.

The validation pass detects logic errors before any write; ordinary disk failures during the per-phase write loop (disk full, permission denied) are out of scope for v0.2 and may leave a partial result.

## `plan`

`code-pact plan <subcommand>` provides AI-assisted project planning tools that feed into the design directory.

### `plan brief [--force] [--from-file <yaml> | --stdin | --what <s> --who <s> [--differentiator <s>]] [--json]`

Interactive wizard that collects project description, target users, and differentiator, then writes `design/brief.md`. Stability: **Stable (v0.2+)**. `--from-file`, `--stdin`, and `--what` / `--who` / `--differentiator` are **Stable (v1.6+)** under P17-T1 / T2 / T3.

Default behaviour requires a TTY; exits 2 with `CONFIG_ERROR` in non-interactive mode. `--force` overwrites an existing file.

`plan brief` supports three pairwise-mutually-exclusive non-interactive input modes plus the default TTY wizard:

| Mode | Trigger | Source of content |
| --- | --- | --- |
| TTY wizard | no input flags + stdin is a TTY | interactive prompts |
| `--from-file` | `--from-file <yaml>` (v1.6+, P17-T1) | YAML file on disk |
| `--stdin` | `--stdin` (v1.6+, P17-T2) | YAML on `process.stdin` |
| flag-driven | any of `--what`, `--who`, `--differentiator` (v1.6+, P17-T3) | command-line flags |

Passing any combination of the three non-interactive modes returns `CONFIG_ERROR` (exit 2) with a message listing the modes that were detected.

**`--from-file <yaml>` (v1.6+, P17-T1).** Reads the file at `<yaml>` (repo-root-relative; `assertSafeRelativePath` enforced), validates it against the schema below, and writes `design/brief.md` from the supplied values. Bypasses the TTY check, so non-TTY environments (CI, agent sessions) can author a brief end-to-end.

**`--stdin` (v1.6+, P17-T2).** Reads the same YAML schema from `process.stdin` instead of a file. Useful when the brief content is produced by another process and piped in (`some-tool | code-pact plan brief --stdin --json`). Bypasses the TTY check.

**`--what <text>` / `--who <text>` / `--differentiator <text>` (v1.6+, P17-T3).** Supplies the brief fields directly as command-line strings. Presence of ANY of the three flags triggers flag-driven mode. `--what` and `--who` are required (non-empty strings); `--differentiator` is optional and defaults to the locale placeholder when omitted. Missing or empty-string `--what` / `--who` returns `CONFIG_ERROR` (exit 2) with `data.missing: string[]` naming the missing flags. Bypasses the TTY check. Mirrors the v1.4 `task add` non-interactive flag pattern.

YAML schema:

```yaml
what: <non-empty string, required>          # "what we're building"
who: <non-empty string, required>           # "who it's for"
differentiator: <string, optional>          # defaults to "" (matches wizard empty-input behaviour)
```

Unknown keys are rejected (strict schema). All four failure modes return `CONFIG_ERROR` (exit 2) with the structured envelope:

```json
{
  "ok": false,
  "error": { "code": "CONFIG_ERROR", "message": "..." },
  "data": {
    "detail": "unsafe_path" | "unreadable" | "invalid_yaml" | "schema_invalid",
    "path": "<the --from-file value, verbatim>"
  }
}
```

On success, `--json` emits `{ ok: true, data: { path: "..." } }` (same envelope as the wizard path). `design/brief.md` produced via `--from-file` is byte-identical to one produced by the wizard for equivalent input.

`--from-file` is partial-write-safe: any failure (path / read / parse / schema) yields no write to `design/brief.md`.

**`--stdin` envelope (v1.6+, P17-T2).** Failures return the same `CONFIG_ERROR` exit 2, with a parallel envelope shape:

```json
{
  "ok": false,
  "error": { "code": "CONFIG_ERROR", "message": "..." },
  "data": {
    "detail": "stdin_read_failed" | "invalid_yaml" | "schema_invalid",
    "source": "stdin"
  }
}
```

`source: "stdin"` replaces `--from-file`'s `path` field, so consumers can disambiguate the two input modes from the envelope alone. The `unsafe_path` and `unreadable` details do not apply (stdin has no path). `--stdin` is partial-write-safe: any failure yields no write to `design/brief.md`.

### `plan prompt [--clipboard]`

Reads `design/brief.md` and `design/constitution.md` (both optional), assembles a structured AI planning prompt, and writes it to stdout. Add `--clipboard` to also copy to the clipboard (via `pbcopy` on macOS or `xclip` on Linux). Does not require a TTY.

JSON output includes `has_brief`, `has_constitution`, and `clipboard_copied` flags alongside the prompt string.

**v1.4+ additive field** — `data.suggested_next_steps: string[]` is always present (field-presence-fixed). Names the canonical AI-assisted planning sequence:

1. Run the planning prompt through your AI agent of choice and capture its YAML response into a file (e.g. `design/imports/p1.yaml`).
2. Run `code-pact phase import design/imports/p1.yaml --json` to ingest the YAML.
3. Run `code-pact plan lint --json` to validate the imported phase.
4. Run `code-pact phase runbook <imported-phase-id> --json` to see the per-phase next steps.

When `has_brief` or `has_constitution` is false, a leading step recommends `plan brief` / `plan constitution` first. The field is additive: existing JSON consumers (which read only `prompt` / `has_brief` / `has_constitution` / `clipboard_copied`) see no shape change.

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

**`--strict` semantics (binary promotion).** When `--strict` is passed, **all** warnings — regardless of code — become exit-relevant. This includes P10's `TASK_WRITES_PROTECTED_PATH` advisory: a task that declares `writes: design/roadmap.yaml` is informational under default lint and exit-relevant under `--strict`. Selective per-code promotion ("promote only `TASK_WRITES_PROTECTED_PATH`, leave other warnings advisory") is **not** supported in v1.5+; it remains a P15+ candidate. Choose `--strict` when you want a fail-fast posture on any advisory; omit it when the project legitimately declares advisories you want to keep as warnings (e.g. governance tasks writing to design YAML files — see [`docs/dogfood.md` § Release prep](dogfood.md) for the dogfood corpus's posture).

**Configurable protected paths (v1.6+, P15-T3).** The list of patterns that trigger `TASK_WRITES_PROTECTED_PATH` is loaded from `design/rules/protected-paths.md` when the file is present. The file format is one glob per line (P10 supported subset), with `#` comments and blank lines ignored, and end-of-line `# ...` comments stripped. Malformed entries (unsafe paths, glob syntax outside the P10 subset) are silently skipped. When the file is **absent**, code-pact falls back to the hardcoded defaults (`.git/**`, `node_modules/**`, `.code-pact/**`, `design/roadmap.yaml`, `design/phases/*.yaml`) — v1.5 behaviour. When the file is **present but contains zero valid entries** (empty / comment-only / all malformed), the list is treated as explicit "no protected paths"; the loader does NOT silently revert to defaults. Delete the file to return to v1.5 behaviour.

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

  **`details.remediation` (v1.2+, additive).** When `details.kind == "done-but-design-not-done"`, the issue's `details` payload also carries a `remediation` string of the form `"code-pact task finalize <task-id>"`. This is the mechanizable drift kind — `task finalize` / `phase reconcile` resolve it deterministically. The other four kinds need human judgement and do not carry a `remediation` field. The addition is additive on a `Record<string, unknown>` payload; existing JSON envelope consumers see no shape change.

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
it will be removed in v1.1.

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
surprised by an extra stderr line. The bare form will be removed in v1.1.

## `task context` — context quality gates (v0.5.1, v1.1 additions)

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

### P10 declared sections (v1.1+)

When a task declares any of the [P10 Task Readiness Schema fields](#phase-import) (`depends_on`, `decision_refs`, `reads`, `writes`, `acceptance_refs`), the pack body gains the corresponding sections in this fixed order, inserted after the Task Definition block and before the existing "Related Decisions" section:

| Order | Section | Contents when declared |
|---|---|---|
| 1 | `## Depends on` | List of declared task ids with derived current state from `.code-pact/state/progress.yaml` (`planned` / `started` / `blocked` / `resumed` / `done` / `failed`). |
| 2 | `## Declared read surface` | Each `reads` glob with currently-matched repo-relative file paths. `_(no current matches on disk)_` line when the glob matches nothing (mirrors the `TASK_READS_NO_MATCH` lint warning). |
| 3 | `## Declared write surface` | Each `writes` glob, declaration-only — no fs lookup because writes are future-tense. |
| 4 | `## Declared decisions` | Full body of every file referenced by `decision_refs`. Surfaced **regardless** of `context_size` (in addition to, not replacing, the existing `context_size: large` allDecisions path). Files referenced via `decision_refs` are removed from the existing "Related Decisions" section to avoid printing the same content twice. |
| 5 | `## Acceptance references` | Path list only in P10. No content excerpt; richer rendering is deferred to P11 reconcile. |

When a task declares **none** of the P10 fields, the pack body is byte-identical to v1.0.2. The byte-identical contract is locked by `tests/integration/pack-byte-identical.test.ts` against a checked-in golden fixture (`tests/fixtures/golden/pack-v1.0.2-shaped.md`).

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

## `task add` — append a task to a phase (v0.6, non-interactive in v1.4+)

`code-pact task add <phase-id> [flags]` appends a task to the named phase's `tasks[]` array. Two paths share the same write contract:

- **Wizard path (v0.6+, unchanged)** — TTY-only. The wizard prompts for `description` and `type`; all readiness fields default to `"medium"` and `status` defaults to `"planned"`. Output goes to stderr (or stdout JSON when `--json` is passed).
- **Non-interactive path (v1.4+, Stable)** — flag-driven. Triggered by the presence of `--description`. Bypasses the wizard prompter entirely (no stdin handle is opened), making it safe for CI / scripted bootstrap. JSON envelope is **byte-identical** to the wizard path.

### Mode resolution

The presence of `--description` is the mode switch. Three branches:

| Input | Behaviour |
| --- | --- |
| `--description` provided | Non-interactive path. `--type` is required (else CONFIG_ERROR). |
| `--description` absent, no other non-interactive flags, TTY available | Wizard path (unchanged from v0.6). |
| `--description` absent, no other non-interactive flags, no TTY | CONFIG_ERROR with non-interactive guidance. |
| `--description` absent, one or more non-interactive-only flags present (e.g. `--type`, `--depends-on`) | **CONFIG_ERROR**. The CLI never silently enters the wizard or silently ignores the flags — predictable for scripts that lose TTY capability mid-pipeline. |

### Non-interactive flag table (v1.4+)

| Flag | Type | Required? | Default | Notes |
| --- | --- | --- | --- | --- |
| `--description` | string | yes (mode trigger) | — | Required in non-interactive mode |
| `--type` | enum (`architecture` / `feature` / `bugfix` / `refactor` / `docs` / `test` / `mechanical_refactor` / `other`) | yes | — | Wizard prompts; non-interactive requires it |
| `--id` | string | no | auto-generated as `<phaseId>-T<n>` | Valid in both wizard and non-interactive paths |
| `--ambiguity` | enum (`low` / `medium` / `high`) | no | `medium` | Wizard default |
| `--risk` | enum (`low` / `medium` / `high`) | no | `medium` | Wizard default |
| `--context-size` | enum (`small` / `medium` / `large`) | no | `medium` | Wizard default |
| `--write-surface` | enum (`low` / `medium` / `high`) | no | `medium` | Wizard default |
| `--verification-strength` | enum (`weak` / `medium` / `strong`) | no | `medium` | Wizard default |
| `--expected-duration` | enum (`short` / `medium` / `long`) | no | `medium` | Wizard default |
| `--depends-on <id>` | string, **repeatable** | no | (none) | P10 field; pass multiple flags, not a comma-separated list |
| `--decision-ref <path>` | string, **repeatable** | no | (none) | P10 field |
| `--read <glob>` | string, **repeatable** | no | (none) | P10 field |
| `--write <glob>` | string, **repeatable** | no | (none) | P10 field |
| `--acceptance-ref <path>` | string, **repeatable** | no | (none) | P10 field |
| `--json` | boolean | no | false | Valid in both paths |

**`--status` is intentionally not exposed.** Newly added tasks are always written with `status: planned`. Historical or already-done tasks must use `phase import` — this preserves the P11/P12 contract that design `done` is the result of `task finalize` / `phase reconcile` after `task complete`, never a starting point declared at creation time.

### P10 field validation responsibility

`task add` stores P10 field flags after **basic string validation only**. Existence checks (file presence on disk), glob validity (P10 supported subset), unsafe-path detection (`assertSafeRelativePath`), and protected-path advisories remain `plan lint`'s responsibility. The dogfood loop (`task add` → `plan lint --json`) provides immediate feedback when a declared field is invalid.

### JSON envelope

Same shape in both modes:

```json
{
  "ok": true,
  "data": {
    "phaseId": "P1",
    "taskId": "P1-T5",
    "phasePath": "design/phases/P1-foundation.yaml"
  }
}
```

### Errors

No new error codes in v1.4. All paths reuse existing public codes:

| Code | Exit | When |
| --- | --- | --- |
| `PHASE_NOT_FOUND` | 2 | Phase id is not in `design/roadmap.yaml` |
| `DUPLICATE_TASK_ID` | 1 | Task id already exists in the phase (pre-v1.4 exit code preserved) |
| `CONFIG_ERROR` | 2 | Missing positional `<phase-id>`; `--description` absent with no TTY; `--description` provided without `--type`; non-interactive flag without `--description`; invalid enum value; unknown flag |

### Usage examples

```sh
# Wizard path (unchanged from v0.6) — TTY required.
code-pact task add P1

# Non-interactive (v1.4+) — minimal required flags.
code-pact task add P1 --description "Add login form" --type feature

# Non-interactive with explicit id + readiness overrides.
code-pact task add P1 \
  --id P1-AUTH \
  --description "OAuth migration spike" \
  --type architecture \
  --ambiguity high \
  --risk high \
  --verification-strength strong

# Non-interactive with P10 declarations (repeatable flags).
code-pact task add P1 \
  --description "Wire the new flow" \
  --type feature \
  --depends-on P1-AUTH \
  --read "src/auth/**" \
  --read "src/middleware/**" \
  --write "src/handlers/login.ts" \
  --decision-ref design/decisions/auth-oauth-rfc.md \
  --acceptance-ref docs/acceptance/login-flow.md \
  --json
```

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

## `task finalize` — flip task design status to done (v1.2+, P11)

`code-pact task finalize <task-id> [--write] [--base-ref <ref>] [--json]` flips the `status` field of a single task inside `design/phases/<phase>.yaml` from `planned` / `in_progress` to `done`. Stability: **Stable (v1.2+)**. `--base-ref` is **Stable (v1.6+)** under P15-T1.

Eligibility: the task's derived state from `.code-pact/state/progress.yaml` (via `deriveTaskState`) **must equal `done`**. Any other current state (no events, `started`, `blocked`, `resumed`, `failed`) raises `TASK_FINALIZE_NOT_ELIGIBLE` (`ok: false`, exit 2) in **both** dry-run and `--write` modes. Dry-run means "won't write", not "won't validate" — the dry-run output of a finalize-able task is a faithful preview of what `--write` would do.

Default mode is dry-run. Pass `--write` to apply the mutation. No `--agent` flag — this is a design/progress reconciliation command that never calls an adapter.

Order of operations:

1. **Task resolution.** Scans every phase referenced by `design/roadmap.yaml`. `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` are raised for missing / duplicate task ids (same logic as `task complete`).
2. **Eligibility check.** Reads `progress.yaml`, derives the task state, raises `TASK_FINALIZE_NOT_ELIGIBLE` if not `done`.
3. **Safe-write classification.** Validates the resolved phase file via `src/core/path-safety.ts` (`assertSafeRelativePath` + `resolveWithinProject`), reads it, parses it as Phase, confirms the task is present. Any failure raises `TASK_FINALIZE_WRITE_REFUSED` (exit 2) with a structured reason in `data.reason` (`unsafe_path` / `outside_design_phases` / `not_yaml` / `symlink_escape` / `unreadable` / `unparseable_phase` / `task_not_found`).
4. **Idempotency check.** If the phase YAML already has `status: done` for this task, returns `kind: "already_finalized"` (exit 0) with no write attempt.
5. **Dry-run or `--write`.** In dry-run, returns `kind: "would_finalize"` with `planned_writes[]`. In `--write`, calls `atomicWriteText` to apply the change and returns `kind: "finalized"` with `applied_writes[]`.

`task finalize` **never** mutates `progress.yaml`, **never** writes to `design/roadmap.yaml`, and **never** flips the phase's own `status` field. The v1.0 append-only progress contract and the v1.2 narrow-write-target contract are both preserved.

### JSON envelope (success)

```json
{
  "ok": true,
  "data": {
    "kind": "would_finalize" | "finalized" | "already_finalized",
    "task_id": "P1-T1",
    "phase_id": "P1",
    "file": "design/phases/P1-foundation.yaml",
    "current_status": "planned",
    "target_status": "done",
    "planned_writes": [{ "file": "...", "task_id": "...", "before": "planned", "after": "done" }],
    "applied_writes": [],
    "skipped_writes": [],
    "acceptance_refs_check": [{ "path": "docs/cli-contract.md", "exists": true }],
    "declared_writes": ["src/commands/task-finalize.ts"],
    "depends_on_check": [{ "task_id": "P1-T0", "current": "done", "satisfied": true }],
    "write_audit": {
      "git_available": true,
      "base_kind": "working-tree",
      "base_ref": null,
      "files_touched": ["src/commands/task-finalize.ts"],
      "outside_declared": [],
      "declared_unused": [],
      "warnings": []
    }
  }
}
```

Field presence by kind:

| Field | `would_finalize` | `finalized` | `already_finalized` |
| --- | --- | --- | --- |
| `task_id`, `phase_id`, `file` | ✓ | ✓ | ✓ |
| `current_status` (pre-write), `target_status` | ✓ | ✓ | ✓ |
| `planned_writes[]` | ✓ | absent | absent |
| `applied_writes[]`, `skipped_writes[]` | absent | ✓ | absent |
| `acceptance_refs_check[]`, `declared_writes[]`, `depends_on_check[]` | ✓ | ✓ | ✓ |
| `write_audit` (v1.6+, P15-T1) | ✓ (when `--json`) | ✓ (when `--json`) | ✓ (when `--json`) |

`skipped_writes[]` is always empty for `task finalize` (it operates on a single task). The field exists for shape parity with `phase reconcile` (P11-T4).

### `write_audit` field (v1.6+, P15-T1)

Read-only advisory comparing the task's declared `writes` globs against the actual filesystem changes reported by git. Present on **all three success kinds** when `--json` is in effect. Human-mode `task finalize` (no `--json`) does **not** compute the audit and does **not** spawn git — the field is JSON-only.

Default range is the **working tree** only: staged (`git diff --cached --name-only`) + unstaged (`git diff --name-only`) + untracked (`git ls-files --others --exclude-standard`), all merged, POSIX-normalized, and sorted. Pass `--base-ref <ref>` to additionally include the branch-level diff (`git diff --name-only $(git merge-base HEAD <ref>) HEAD`). `--base-ref` **requires** `--json`; passing it without `--json` returns `CONFIG_ERROR` (exit 2).

Shape (field-presence-fixed — every key is always present):

| Key | Type | Notes |
| --- | --- | --- |
| `git_available` | boolean | `false` when git is not on `PATH` or `cwd` is not a git repo |
| `reason` | `"not_a_git_repo"` \| `"git_not_on_path"` | Present only when `git_available === false` |
| `base_kind` | `"working-tree"` \| `"merge-base"` \| `"unavailable"` | `"merge-base"` only when `--base-ref` was supplied and resolved |
| `base_ref` | string \| null | The ref echoed back when `base_kind === "merge-base"`; otherwise `null` |
| `base_error` | object | Present **only** when `--base-ref` was supplied but `merge-base` / `rev-parse` failed (graceful fallback to working-tree mode). Shape: `{ code: "MERGE_BASE_NOT_FOUND" \| "REF_NOT_FOUND", message, requested_ref }`. Exit code is **unchanged** (advisory). |
| `files_touched` | string[] | Sorted, deduplicated POSIX-relative paths |
| `outside_declared` | string[] | Files that match no declared glob in the task's `writes` |
| `declared_unused` | string[] | Declared globs that matched no file in `files_touched`. Promotes to `TASK_WRITES_AUDIT_DECLARED_UNUSED` warning (v1.6+, P15-T4) when non-empty |
| `warnings` | string[] | Advisory warning codes (see Plan diagnostics table) |

The audit **never** changes the exit code in P15-T1. The `--audit-strict` flag (P15-T6) opts into exit-relevant enforcement.

### Errors

| Code | Exit | When |
| --- | --- | --- |
| `TASK_NOT_FOUND` | 2 | Task id is not present in any phase |
| `AMBIGUOUS_TASK_ID` | 2 | Task id appears in more than one phase |
| `TASK_FINALIZE_NOT_ELIGIBLE` | 2 | Derived state from `progress.yaml` is not `done`. Raised in **both** dry-run and `--write`. `data.current` carries the actual derived state |
| `TASK_FINALIZE_WRITE_REFUSED` | 2 | Safety check failed. `data.reason` carries one of `unsafe_path` / `outside_design_phases` / `not_yaml` / `symlink_escape` / `unreadable` / `unparseable_phase` / `task_not_found`. `data.file` carries the offending path |
| `CONFIG_ERROR` | 2 | Missing positional task id, unknown flag, or `--base-ref` supplied without `--json` (v1.6+, P15-T1) |

### Usage example

```sh
# Preview — what would finalize do?
code-pact task finalize P9-T5 --json

# Apply — flip the status in the phase YAML.
code-pact task finalize P9-T5 --write --json

# Recommended adoption: stop hand-editing design status in release prep.
# Use this command (or `phase reconcile`, P11-T4) instead.
```

## `phase reconcile` — bulk-flip task design statuses for a phase (v1.2+, P11)

`code-pact phase reconcile <phase-id> [--write] [--json]` walks every task inside `design/phases/<phase>.yaml`, classifies each one against its derived state from `.code-pact/state/progress.yaml`, and (with `--write`) flips the `status` field for every task whose derived state is `done` while its design status is still `planned` / `in_progress`. Stability: **Stable (v1.2+)**.

Default mode is dry-run. Pass `--write` to apply the mutations. No `--agent` flag — like `task finalize`, this is a design/progress reconciliation command that never calls an adapter.

`phase reconcile` **never** auto-flips the phase's own `status` field in v1.2. It computes a `phase_status_candidate` and surfaces it as advisory only. The phase status itself continues to be flipped by hand in release prep until P14 governance owns the policy. `phase reconcile` also **never** mutates `progress.yaml` and **never** writes to `design/roadmap.yaml`.

### Per-task classification

Each task in the phase is classified into one of three actions:

| Action | When | Effect of `--write` |
| --- | --- | --- |
| `flip` | Derived state is `done` AND design status is `planned` / `in_progress` | Status is rewritten to `done` (atomic write) |
| `skip` | Design status is already `done`, OR derived state is `planned` (no events recorded), OR derived state is `started` / `resumed` (work in progress) | No change |
| `manual_review` | Derived state is `blocked` or `failed` | No change. The user is directed to `plan analyze` for diagnosis |

`phase reconcile` never touches `manual_review` tasks even with `--write`. The classifier intentionally narrows the writable set to the unambiguous `done-but-design-not-done` case.

### Order of operations

1. **Phase resolution.** Reads `design/roadmap.yaml`, finds the phase, loads its YAML. `PHASE_NOT_FOUND` is raised if the phase id is unknown.
2. **Classification.** For each task, derives state via `deriveTaskState` and applies the table above.
3. **Phase status candidate.** Computes a suggested phase status by simulating the post-flip state. Surfaced as `phase_status_candidate` (advisory). Never written.
4. **No eligible writes.** If no task is classified as `flip`, returns `kind: "no_eligible_tasks"` with exit 0 in both dry-run and `--write`. This is **not** an error — it just means there is nothing to reconcile.
5. **Safe-write classification.** Each flip candidate is validated via `src/core/path-safety.ts` and parsed as a Phase. Failures land in `skipped_writes[]` with a structured `reason` (`unsafe_path` / `outside_design_phases` / `not_yaml` / `symlink_escape` / `unreadable` / `unparseable_phase` / `task_not_found`).
6. **Dry-run or `--write`.** In dry-run, returns `kind: "would_reconcile"` with `planned_writes[]`. In `--write`, applies each diff via `atomicWriteText` and returns `kind: "reconciled"` with `applied_writes[]` and any apply-time failures in `skipped_writes[]`.
7. **All-refused error.** When `--write` is requested and **every** eligible write was refused, `PHASE_RECONCILE_WRITE_REFUSED` (exit 2) is raised with `data.skipped_writes[]` carrying the refusal details. Partial successes (one or more applied, one or more refused) return exit 0.

### JSON envelope (success)

```json
{
  "ok": true,
  "data": {
    "kind": "would_reconcile" | "reconciled" | "no_eligible_tasks",
    "phase_id": "P11",
    "file": "design/phases/P11-finalization-reconciliation.yaml",
    "tasks": [
      {
        "task_id": "P11-T1",
        "current_design_status": "planned",
        "derived_state": "done",
        "target_status": "done",
        "action": "flip",
        "reason": null
      }
    ],
    "planned_writes": [{ "file": "...", "task_id": "...", "before": "planned", "after": "done" }],
    "applied_writes": [],
    "skipped_writes": [{ "file": "...", "task_id": "...", "reason": "outside_design_phases", "detail": "..." }],
    "phase_status_candidate": "done",
    "phase_status_note": "advisory — phase status is never written by phase reconcile in v1.2; flip by hand in release prep until P14"
  }
}
```

Field presence by kind:

| Field | `would_reconcile` | `reconciled` | `no_eligible_tasks` |
| --- | --- | --- | --- |
| `phase_id`, `file` | ✓ | ✓ | ✓ |
| `tasks[]` (per-task verdicts) | ✓ | ✓ | ✓ |
| `phase_status_candidate`, `phase_status_note` | ✓ | ✓ | ✓ |
| `planned_writes[]` | ✓ | absent | absent |
| `applied_writes[]`, `skipped_writes[]` | absent | ✓ | absent |

`phase_status_candidate` reflects the post-flip simulation. It is `done` only if every task would end up `done`; `in_progress` if any task is `started` / `blocked` / `resumed` / `failed`; otherwise `planned`. Writing the actual phase status remains a manual release-prep step.

### Errors

| Code | Exit | When |
| --- | --- | --- |
| `PHASE_NOT_FOUND` | 2 | Phase id is not present in `design/roadmap.yaml` |
| `PHASE_RECONCILE_WRITE_REFUSED` | 2 | `--write` was requested AND every eligible task write was refused for safety reasons. `data.skipped_writes[]` carries the per-task refusal detail. Not raised when at least one write applied successfully |
| `CONFIG_ERROR` | 2 | Missing positional phase id, or unknown flag |

### Usage example

```sh
# Preview — what would reconcile do across the whole phase?
code-pact phase reconcile P11 --json

# Apply — flip every eligible task at once.
code-pact phase reconcile P11 --write --json

# Recommended adoption pattern (v1.2.0+):
# Replace hand-edits of design/phases/*.yaml in release prep
# with a single `phase reconcile <phase-id> --write` invocation.
```

## `task runbook` — read-only guidance for a single task (v1.3+, P12)

`code-pact task runbook <task-id> [--json]` returns a deterministic list of next recommended steps for one task. Stability: **Stable (v1.3+)**.

The command is **read-only**. It emits command strings the user (or an agent) runs separately, or a `manual_action` describing a human checkpoint. There is no `--write` flag, no `--execute` flag, no `--agent` flag — runbook is sequencing guidance, not orchestration. Agent choice belongs to whichever command in the recommended sequence needs an adapter (e.g. `code-pact task context <id> --agent claude-code`).

The command **never** mutates `progress.yaml`, **never** writes to `design/`, and **never** calls an adapter. It only reads the roadmap, phase YAMLs, and the progress log.

### Step generation

Runbook maps `(derived state, design status, drift kind)` → recommended steps using these classifiers:

- `deriveTaskState` from `src/core/progress/task-state.ts` — current state in {planned, started, blocked, resumed, done, failed}
- `classifyTaskDrift` from `src/core/plan/analyze.ts` — drift kind when design and progress disagree
- `resolveDependsOnStates` from `src/core/runbook/depends-on.ts` — per-dependency current state

Mapping table:

| Derived | Design | Drift kind | Steps |
| --- | --- | --- | --- |
| planned (no events) | planned / in_progress | (none) | `task start` → `task context` → manual implement → `task complete` |
| started / resumed | planned / in_progress | (none) | continue implementation → `task complete` |
| blocked | planned / in_progress | (none) | manual_action (resolve blocker) → `task resume --reason "..."` — both `blocking: true` |
| failed | planned / in_progress | (none) | manual_review (diagnose + fix) → `task complete` (re-run) |
| done | planned / in_progress | done-but-design-not-done | `task finalize --write` with dry-run safety note |
| done | done | (none) | empty `next_steps` (consistent) |
| done | done | done-blocked-conflict / done-with-incomplete-events | manual_review pointing at `plan analyze` (blocking) |
| done | done | done-historical | empty `next_steps` (hidden by default) |

`depends_on` adds a blocking `manual_action` step at the head whenever any dependency's derived state is not `done`.

### JSON envelope (success)

```json
{
  "ok": true,
  "data": {
    "kind": "runbook",
    "task_id": "P9-T5",
    "phase_id": "P9",
    "state_summary": {
      "design_status": "planned",
      "derived_state": "done",
      "drift_kind": "done-but-design-not-done",
      "depends_on": [
        { "task_id": "P9-T4", "current": "done", "satisfied": true }
      ],
      "acceptance_refs_check": [
        { "path": "docs/cli-contract.md", "exists": true }
      ],
      "declared_writes": ["src/commands/task-runbook.ts"],
      "decision_refs": ["design/decisions/lightweight-runbook-rfc.md"]
    },
    "next_steps": [
      {
        "command": "code-pact task finalize P9-T5 --write",
        "manual_action": null,
        "reason": "Task is done in progress.yaml but design status is still planned/in_progress. `task finalize` is the deterministic resolver.",
        "blocking": false,
        "safety_note": "This is a --write operation. Preview first with `code-pact task finalize P9-T5 --json` (dry-run).",
        "expected_result": "design/phases/<phase>.yaml task status flips to done; STATUS_DRIFT done-but-design-not-done clears on next plan analyze."
      }
    ]
  }
}
```

### `RunbookStep` field invariants

Every step in `next_steps[]` has all six fields present in JSON output, with `null` where not applicable. **Exactly one of `command` / `manual_action` is non-null** — never both, never neither. JSON consumers can assume the schema is constant across step kinds and need no field-absence branching.

| Field | Type | When non-null |
| --- | --- | --- |
| `command` | `string \| null` | Step is a CLI invocation the user runs verbatim |
| `manual_action` | `string \| null` | Step is a human checkpoint with no command |
| `reason` | `string` | Always required |
| `blocking` | `boolean` | Always present; `true` means downstream steps assume this is resolved first |
| `safety_note` | `string \| null` | Non-null for `--write` steps and similar safety concerns |
| `expected_result` | `string \| null` | Non-null when a deterministic post-step state is known |

### Errors

No new error codes. Reused:

| Code | Exit | When |
| --- | --- | --- |
| `TASK_NOT_FOUND` | 2 | Task id is not present in any phase |
| `AMBIGUOUS_TASK_ID` | 2 | Task id appears in more than one phase; `data.phases[]` lists the offenders |
| `CONFIG_ERROR` | 2 | Missing positional task id, or unknown flag |

### Relationship to `recommend`

`recommend` and `task runbook` are intended to coexist:

- **`recommend`** answers: **"How should this task be executed?"** — model tier, effort, context profile, preflight commands, ambiguity action, budget profile.
- **`task runbook`** answers: **"What should happen next in the task lifecycle?"** — the sequence of `task start` / `task context` / implementation / `task complete` / `task finalize` etc., gated by `depends_on` and drift state.

Both take a task id; neither calls the other. Bundling them is an open question deferred to P13.

### Usage example

```sh
# Single task — see what to do next.
code-pact task runbook P9-T5 --json

# After implementation + task complete, runbook recommends finalize.
code-pact task complete P9-T5
code-pact task runbook P9-T5 --json   # → step: task finalize P9-T5 --write
```

## `phase runbook` — read-only guidance for an entire phase (v1.3+, P12)

`code-pact phase runbook <phase-id> [--json]` returns a deterministic list of next recommended steps for an entire phase. Stability: **Stable (v1.3+)**.

Mirrors `task runbook` at phase level. The command is **read-only**: every recommended step is a CLI invocation the user runs separately, or a `manual_action` describing a human checkpoint. There is no `--write`, no `--execute`, no `--agent` flag, and no multi-phase `--all`.

The command **never** mutates `progress.yaml`, **never** writes to `design/` (including `design/roadmap.yaml`), and **never** flips the phase's own `status` field. The `phase_status_candidate` reported in `phase_summary` is advisory only — consistent with the v1.2 `phase reconcile` contract.

### Step priority order

For each phase, runbook iterates `phase.tasks[]` and emits steps in this priority order:

1. **Blocked tasks — resume guidance** (`blocking: true`). For each `blocked` task, emit one `manual_action` step describing blocker resolution + a `task resume <id> --reason "..."` command step.
2. **Failed / complex-drift tasks — manual_review** (`blocking: true`). For `failed` state or `done-blocked-conflict` / `done-with-incomplete-events` drift, emit a `manual_action` step pointing at `plan analyze`. These drifts need human judgement; `phase reconcile` intentionally refuses them.
3. **Eligible reconcile batch** (non-blocking). If at least one task is a `flip` candidate, emit exactly one `phase reconcile <id> --write` step. Per-task `task finalize` enumeration is intentionally avoided — reconcile's atomic batch is the whole point.
4. **In-progress task hints** (non-blocking). For each `started` / `resumed` task, emit one `task runbook <task-id>` step. Per-task judgement is delegated to `task runbook`.
5. **Untouched ready tasks** (non-blocking). For each `planned` task with no events AND all `depends_on` satisfied, emit the four-step primary loop: `task start <id>` → `task context <id>` → manual implement → `task complete <id>`.
6. **Phase-status advisory** (non-blocking, `manual_action`). If every task would be `done` post-reconcile and the phase itself isn't already `done`, surface the manual phase-status flip as the final step.

### JSON envelope (success)

```json
{
  "ok": true,
  "data": {
    "kind": "runbook",
    "phase_id": "P12",
    "phase_summary": {
      "task_histogram": {
        "planned": 1,
        "started": 1,
        "blocked": 0,
        "resumed": 0,
        "done": 3,
        "failed": 0
      },
      "drift_histogram": {
        "done-but-design-not-done": 2,
        "manual_review": 0,
        "consistent": 4
      },
      "phase_status_candidate": "in_progress",
      "phase_status_note": "advisory — phase status is never written by phase runbook (or by phase reconcile in v1.2)"
    },
    "next_steps": [
      {
        "command": "code-pact phase reconcile P12 --write",
        "manual_action": null,
        "reason": "2 task(s) (P12-T1, P12-T2) are done in progress.yaml but design status is still planned/in_progress. `phase reconcile --write` flips them in one atomic batch.",
        "blocking": false,
        "safety_note": "This is a --write operation. Preview first with `code-pact phase reconcile P12 --json` (dry-run).",
        "expected_result": "design/phases/<phase>.yaml task statuses flip planned → done; STATUS_DRIFT done-but-design-not-done clears for each task."
      }
    ]
  }
}
```

`RunbookStep` field invariants are identical to `task runbook` — every field present, exactly one of `command` / `manual_action` non-null. See the `task runbook` section for the field-presence table.

### Errors

No new error codes. Reused:

| Code | Exit | When |
| --- | --- | --- |
| `PHASE_NOT_FOUND` | 2 | Phase id is not present in `design/roadmap.yaml` |
| `CONFIG_ERROR` | 2 | Missing positional phase id, or unknown flag |

### Usage example

```sh
# Inspect phase state at a glance.
code-pact phase runbook P9 --json

# Recommended sanity check before release-prep `phase reconcile --write`.
code-pact phase runbook P9 --json
code-pact phase reconcile P9 --write
```

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

## State file write guarantees

`code-pact` writes a small, well-defined set of files into the project tree. Every disk write goes through the same atomic primitive so an interrupted process cannot leave a half-written file behind.

### Files written by `code-pact`

| Path | Written by | Frequency |
|------|------------|-----------|
| `.code-pact/project.yaml` | `init` | Once at project bootstrap |
| `.code-pact/agent-profiles/<agent>.yaml` | `init`, `adapter install`, `adapter upgrade --write` | Once at bootstrap; refreshed when adapter profile fields change |
| `.code-pact/model-profiles/*.yaml` | `init` | Once at bootstrap (default tier templates) |
| `.code-pact/state/progress.yaml` | `task start` / `task block` / `task resume` / `task complete` | One append per state transition |
| `.code-pact/state/baselines/*.json` | `init`, future baseline commands | Once at bootstrap (`initial.json`) |
| `.code-pact/adapters/<agent>.manifest.yaml` | `adapter install`, `adapter upgrade --write` | Each install or write-mode upgrade |
| `design/brief.md`, `design/constitution.md` | `plan brief`, `plan constitution` | Once per wizard run |
| `design/roadmap.yaml` | `init --sample-phase`, `phase add`, `phase new`, `phase import` (all via `createPhase`) | One append per phase added |
| `design/phases/<phase>.yaml` | `init --sample-phase`, `phase add`, `phase new`, `phase import`, `task add`, `task finalize --write`, `phase reconcile --write` | Phase creation: one write per phase. Task lifecycle: one write per `task add` / status flip |
| `<adapter-owned files>` (e.g. `CLAUDE.md`, `.claude/skills/*.md`, `.context/<agent>/*`) | `adapter install`, `adapter upgrade --write` | Generated from the agent's `AdapterDescriptor`; manifest tracks every file |

### Atomic write strategy

Every write listed above goes through `atomicWriteText` (`src/io/atomic-text.ts`):

1. Write content to `<path>.tmp-<pid>-<timestamp>` in the same directory.
2. `fs.rename(tmp, path)` — on POSIX, this is a single inode swap.

`fs.rename` within the same filesystem is atomic on POSIX (the destination either points at the old content or the new content, never a partial file). This is sufficient for code-pact's "interrupted-process safety" requirement and is verified end-to-end by the test suite.

**What `code-pact` does NOT do** (intentional, documented limits):

- **No `fsync`.** A power loss between the rename and the OS flushing the dirty buffers can lose the most recent write. This is acceptable for a local dev tool — the next run will recover from the prior state.
- **No progress-log write lock.** Two concurrent `task complete` invocations against the same project may interleave appends. The progress log is append-only, so the worst case is event reordering, not corruption. Design mutations are different: v1.5+ serializes roadmap and phase YAML writes with the advisory lock documented below.
- **No backup file** (`.bak`). The doctor `BAK_FILE` warning fires if a `.bak` file appears next to a tracked file — it's expected to be a leftover from manual edits, not code-pact output.

### Path safety

The v1.0 path-traversal hardening is intentionally scoped to **adapter-managed generated file writes**, because adapters are the surface that writes user-visible paths derived from generator output (where the manifest, the generator, and the on-disk file all need to agree on a path that a user can reasonably modify).

- `assertSafeRelativePath` (`src/core/adapters/file-state.ts`) rejects absolute paths, leading `~`, backslashes, Windows drive letters, `..`, `.`, and empty path segments at the zod-schema layer.
- `resolveWithinProject` walks ancestor directory realpaths and rejects symlink escape (a directory symlink under `cwd` resolving to a location outside the project root).

Other project state files — `progress.yaml`, phase YAMLs, the design tree, agent profiles — remain protected by their existing schema validation and atomic-write behaviour. They are written to paths derived from project config or constants, not from user-supplied generator output, so the adapter-style traversal helpers do not currently apply.

Extending the adapter-style helpers to other state-file writes is **deferred unless a concrete risk appears**. It is not a "we don't need validation there" claim — it's a scope statement about what kind of write surface the helpers are designed for.

### Concurrent writers

Running two design-mutating `code-pact` commands against the same project in parallel is **detected** in v1.5+ via the advisory write lock (P14 governance — see § Advisory write lock below). The second invocation fails fast with `LOCK_HELD` (exit 2) and a diagnostic envelope. Read-only commands (`plan lint`, `plan analyze`, `task runbook`, `phase runbook`, `validate`, `doctor`, `recommend`, `task context`, `task status`) do not acquire the lock and can run concurrently with mutations (observing the project at whatever transitional state is on disk when they read).

### Advisory write lock (v1.5+ / P14)

`.code-pact/locks/write.lock` is created by the design-mutating commands listed in the `LOCK_HELD` row of [§ Public codes](#public-codes-top-level-error-envelopes) above. Acquisition is atomic via `fs.writeFile(..., { flag: "wx" })` (cross-platform exclusive create); release is `unlink`. The lock file content is JSON `{pid, hostname, cmd, created_at}` for diagnostic display.

**Lock acquisition points.** The lock is acquired at the **CLI command-handler level**, not inside `createPhase` or other core services. This lets `phase import` hold a single outer acquisition across its multi-phase apply loop (batch transactionality — every `createPhase` call inside runs under the same lock without re-acquiring). The acquisition points are:

| Command | Acquired when | Coverage |
|---------|---------------|----------|
| `init --sample-phase` | The `--sample-phase` flag is set in non-interactive mode | The whole `runInit` (which calls `writeSamplePhase` → `createPhase`) |
| `init` (wizard) | Always (wizard may answer yes to the sample-phase prompt) | The whole wizard + any `writeSamplePhase` call |
| `phase add` (flag-based or wizard) | After parsing / wizard prompts finish, before `runPhaseAdd` | The single `createPhase` call |
| `phase new` (wizard) | At command entry — held through wizard prompts and write | The single `createPhase` call |
| `phase import` | At command entry, before `runPhaseImport` is called | The entire multi-phase apply loop (every `createPhase` inside) |
| `task add` (wizard or non-interactive) | At command entry | Wizard prompts (if any) + phase YAML write |
| `task finalize` | Only when `--write` | The single phase YAML status flip |
| `phase reconcile` | Only when `--write` | The entire reconcile batch (all flips under one acquisition) |

`task finalize` and `phase reconcile` **dry-runs do NOT acquire the lock** (they don't write).

**`LOCK_HELD` envelope shape.**

```json
{
  "ok": false,
  "error": {
    "code": "LOCK_HELD",
    "message": "Another code-pact mutation is in progress: phase reconcile P14 --write (pid: 12345, host: laptop.local, started: 2026-05-21T10:15:00.000Z). If you are certain no command is running, remove /path/to/.code-pact/locks/write.lock and retry."
  },
  "data": {
    "lock_holder": {
      "pid": 12345,
      "hostname": "laptop.local",
      "cmd": "phase reconcile P14 --write",
      "created_at": "2026-05-21T10:15:00.000Z"
    },
    "lock_path": "/path/to/.code-pact/locks/write.lock"
  }
}
```

When the lock file exists but is unreadable or unparseable (e.g. a partial write from a crashed process, or a hand-edit gone wrong), `data.lock_holder` is `null` and the message text adjusts accordingly. The contender always fails fast; corrupt lock files do NOT auto-clean themselves.

**Stale lock recovery.** v1.5 does NOT auto-detect stale locks (e.g. a crashed process leaving the file behind). The user must:

1. Verify no `code-pact` command is running.
2. Manually delete `.code-pact/locks/write.lock`.
3. Re-run the command.

Automation (PID liveness check, age-based stale detection, a `--force-lock` flag) is deferred to a future RFC. Conservative manual-recovery avoids races where two processes both decide the other is stale.

**Relationship to atomic-text.** The lock is layered ON TOP of the existing atomic-write contract — it does not replace it. Atomic-text gives file-level durability (interrupted writes never leave a half-written file); the lock gives semantic guard against concurrent semantic mutations of the same project. Both are needed.

**`progress.yaml` is intentionally NOT locked.** The append-only operational-log contract documented above (worst case is event reordering, not corruption) makes lock-free safe for `task complete` / `task start` / `task block` / `task resume`. Adding a lock to those high-frequency commands would have no integrity benefit and would add per-invocation acquisition overhead.

### Roadmap mutation policy (v1.5+ / P14)

`design/roadmap.yaml` is the project's phase index. Every code path that mutates it routes through the `createPhase` domain service (`src/core/services/createPhase.ts`), so the id-collision check, slug derivation, file layout, reserved-id block, and roadmap append all live in one place.

| Command | Writes `design/roadmap.yaml`? | Mechanism |
|---------|-------------------------------|-----------|
| `init` (sample-phase path: `--sample-phase`, or wizard-yes) | yes | `writeSamplePhase()` → `createPhase` (with internal `_isSampleCreation: true` bypass for the reserved `TUTORIAL` id) |
| `phase add` (flag-based) | yes | `runPhaseAdd` → `createPhase` |
| `phase new` (TTY wizard) | yes | `runPhaseNew` → `createPhase` |
| `phase import` | yes (per imported phase, after reserved-id preflight) | `runPhaseImport` → `createPhase` |
| `task add` | no | Writes phase YAML only (`design/phases/<phase>.yaml`) |
| `task complete` | no | Writes `progress.yaml` (append-only) |
| `task finalize --write` | no | Writes phase YAML only (flips `tasks[].status`) |
| `phase reconcile --write` | no | Writes phase YAML only (batch flip of `tasks[].status`) |
| `task start` / `task block` / `task resume` / `task status` | no | Writes `progress.yaml` only, or read-only |
| `plan lint` / `plan normalize` / `plan analyze` / `validate` / `doctor` / `recommend` / `task runbook` / `phase runbook` / `task context` | no | Read-only |

The four `createPhase` callers are the **only** code paths that mutate `roadmap.yaml`. This is enforced structurally — no other module calls into the roadmap saver. Future commands that need to mutate the roadmap MUST go through `createPhase` (or land an RFC-update that extends this writer list).

### Reserved phase ids (v1.5+ / P14)

The id `TUTORIAL` is **reserved** for the sample-phase artifact created by `code-pact init --sample-phase`. The block fires at creation time:

| Path | Outcome |
|------|---------|
| `init --sample-phase` (or `init` wizard answering yes to the sample-phase prompt) | **Allowed.** `writeSamplePhase()` passes the internal `_isSampleCreation: true` flag to `createPhase` |
| `phase add --id TUTORIAL ...` | `CONFIG_ERROR` (exit 2). Roadmap is byte-identical (no write) |
| `phase new` (TTY wizard) → typing `TUTORIAL` as the id | `CONFIG_ERROR` (exit 2). Roadmap is byte-identical |
| `phase import` containing any entry with `id: TUTORIAL` | `CONFIG_ERROR` (exit 2) from a **preflight scan** that runs before the first `createPhase` call. The entire import is rejected — no partial-import state where earlier phases are written and the TUTORIAL entry is rejected mid-loop |
| `validate` / `plan lint` / `plan analyze` against an existing TUTORIAL phase | No warning. The block is creation-time only; existing projects with a TUTORIAL phase (whether sample-phase artifact or legacy) are untouched |

The block uses **existing `CONFIG_ERROR`** — no new error code. The error message names the reserved id and points at `init --sample-phase` as the sanctioned path. Configurable reserved-id lists are deferred to a future RFC; in v1.5, `TUTORIAL` is the only reserved id.

### Phase status manual-flip convention (v1.2+, documented in v1.5 / P14)

`phase reconcile <id> --write` flips **task** statuses in batch (`planned`/`in_progress` → `done` for every `flip` candidate) but never writes the phase's own `status` field — `phase_status_candidate` in the JSON envelope is advisory only.

The release-prep convention since v1.2.0 is:

1. Run `code-pact phase reconcile <phase-id> --write` to flip task statuses.
2. Hand-edit the phase's own `status` field in `design/phases/<phase>.yaml` (typically as part of the release-prep PR).

Auto-flip implementation (e.g. a `--phase-status` flag on `phase reconcile`, or a separate `phase finalize` command) is **not part of v1.5** and is deferred to a future RFC. The decision and its rationale are documented in [design/decisions/governance-rfc.md](../design/decisions/governance-rfc.md) § Phase status policy.

## Stability taxonomy (v1.0)

As of v1.0.0, every public command in `code-pact` falls into one of four
stability bands. Future minor releases are allowed to grow the surface
(new commands, new JSON fields, new error codes) without changing band,
but no command may move to a more-restrictive band or change its public
shape without a major version bump.

### Stable (v1.0)

Commands that take `--json`, emit a documented `{ok, data}` envelope on
stdout, have documented exit codes, and have subprocess integration
coverage. Agents and CI may rely on these.

| Command | Notes |
|---------|-------|
| `--version` | Both human and `--json` modes |
| `init` | TTY wizard, but `--non-interactive --agent X --locale Y --json` is supported and tested |
| `doctor` | |
| `validate` | |
| `recommend` | |
| `plan lint` / `plan normalize` / `plan analyze` / `plan prompt` | |
| `phase add` | Flag-only path (`--id`/`--name`/`--objective`/`--weight`/`--verify-command`) is the Stable surface |
| `phase ls` / `phase show` / `phase import` | |
| `task context` / `task status` / `task start` / `task block` / `task resume` / `task complete` | |
| `pack` | Low-level stable command — `task context` is the preferred agent-facing entry |
| `verify` | |
| `progress` | |
| `adapter list` / `adapter install` / `adapter doctor` / `adapter upgrade --check` / `adapter upgrade --write` | |

### Stable (human-output)

Commands that are TTY-required wizards by design. They DO accept
`--json` for the failure path (e.g. emitting `CONFIG_ERROR` in
`--non-interactive` mode), but their success path is not driven by a
machine-readable contract.

| Command | Notes |
|---------|-------|
| `plan brief` | Interactive prompt → `design/brief.md` |
| `plan constitution` | Interactive prompt → `design/constitution.md` |
| `task add` | Interactive task wizard |

`code-pact` will not add JSON-mode success contracts to these commands
solely for v1.0. If a future minor release adds one, it is purely
additive and the human-output path remains supported.

### Experimental

The adapter modules below ship and are usable, but their generated
output formats may shift in minor releases to track upstream tooling
changes. They are intentionally excluded from
`tests/integration/adapter-conformance.test.ts`.

| Adapter | Notes |
|---------|-------|
| `cursor` | Writes `.cursor/rules/code-pact.mdc`. Cursor's `.mdc` format and placement may change. |
| `gemini-cli` | Writes `GEMINI.md`. Gemini CLI's discovery rules may change. |

### Deprecated

Surfaces that still work in v1.x but are scheduled for removal.

| Surface | Replacement | Removal target |
|---------|-------------|----------------|
| Bare-form `code-pact adapter [--agent X] [--force] [--regen-skills]` | `code-pact adapter install <agent>` | v1.1 (originally v0.10) |

The bare form currently prints a one-line deprecation notice on stderr
(suppressed under `--json`) and routes internally to `adapter install`.

### What is NOT a stability claim

The following shapes are documented but **not** locked by v1.0:

- Human-readable stdout / stderr text content (translation, phrasing, log line ordering)
- The presence of optional / advisory JSON fields beyond the documented contract — fields can be added; existing fields cannot be removed or change type
- Internal module names, file layouts under `src/`, and TypeScript exported types
- The format of files under `.code-pact/state/` beyond the documented `progress.yaml` schema
- The exact filename pattern of `.code-pact/adapters/<agent>.manifest.yaml` (the directory and schema are stable; the per-agent filename mapping follows `<agent>.manifest.yaml`)

## Stability

The rules documented in this file — JSON envelope shape, exit-code
families, error-code surface, `--json` position equivalence, TTY rules,
and the taxonomy above — are the v1.0 public contract. Changes that
break these rules require a major version bump.
