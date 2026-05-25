# Agent contract

This document defines the contract between `code-pact` and any AI
coding agent that drives work in a code-pact project. It pairs with
[`docs/positioning.md`](positioning.md) (what the project is and is
not) and [`docs/cli-contract.md`](cli-contract.md) (the full CLI
reference). Read this when integrating a new agent, when reviewing
adapter changes, or when judging whether a proposed feature is in
scope.

The contract has three sides:

1. What `code-pact` guarantees to agents.
2. What agents must do to satisfy `adapter conformance`.
3. The recommended per-task lifecycle the contract is shaped around.

A short section on measurement follows; numbers there are populated by
the Evidence Harness v2 work (P26).

## 1. What `code-pact` guarantees

These guarantees hold across the v1.x line. Breaking any of them
requires a major-version bump.

### CLI surface stability

Every command listed under the **Stable (v1.0)** entry of the
[Stability taxonomy](cli-contract.md#stability-taxonomy-v10) has a
frozen flag surface, JSON envelope shape, exit code contract, and
error code set. New optional flags and new envelope fields are
additive; existing flags, fields, and codes do not change meaning
within v1.x.

The v1.11+ surfaces added by P21 (`task prepare`, `task context
--explain`, `adapter conformance`) join the stable set and carry the
same guarantee from v1.11 onwards.

### JSON envelope shape

Every command that accepts `--json` returns one of:

```
{ "ok": true,  "data": { ... } }
{ "ok": false, "error": { "code": "<CODE>", "message": "..." } }
```

The envelope is one line of JSON on stdout, terminated by a single
newline. Diagnostics (`plan lint`, `doctor`, `validate`, `adapter
doctor`, `adapter conformance`) follow the same shape — `data`
carries an `issues[]` or `checks[]` array, never a different
top-level form.

The full per-command envelope reference is
[`docs/cli-contract.md`](cli-contract.md).

### Exit code contract

| Exit code | Meaning |
|---|---|
| 0 | Success, or diagnostic finished with no error-severity issues |
| 1 | Verification failed, or a diagnostic returned at least one error / non-compliant result |
| 2 | Configuration error — bad flag combination, missing positional, agent not found, task not found, ambiguous task id |
| 3 | Internal error — unexpected exception in the CLI; please file an issue |

Commands that do not return `--json` mirror the same exit codes; the
human-readable output is informative only.

### Error code stability

Public error codes are listed in
[`docs/cli-contract.md`](cli-contract.md#error-codes). New error
codes are additive within v1.x; existing codes do not change meaning.
The `code` field of an error envelope is the contract — agents may
branch on the value.

The P21 commands (`task prepare`, `task context --explain`, `adapter
conformance`) deliberately ship **no new public error codes**. Every
failure mode reuses an existing code (`TASK_NOT_FOUND`,
`AMBIGUOUS_TASK_ID`, `PHASE_NOT_FOUND`, `AGENT_NOT_FOUND`,
`AGENT_NOT_ENABLED`, `CONFIG_ERROR`, the existing `ADAPTER_*`
family).

### Determinism

For the same git SHA and the same inputs:

- `task context` produces byte-identical pack content (locked by
  `tests/integration/pack-byte-identical.test.ts`).
- `recommend` produces a byte-identical JSON envelope.
- `task context --explain --json` (v1.11+) attaches metadata but the
  `content` string is byte-identical to non-explain mode.
- `task prepare` (v1.11+) writes the same context pack bytes that
  `task context` would write for the same task.

Where a command writes deterministic artifacts (context pack, adapter
files), the same input produces the same on-disk bytes.

### Progress is append-only

`.code-pact/state/progress.yaml` is an append-only event log. The
only verbs that mutate it are `task start`, `task block`, `task
resume`, `task complete`, and `task finalize`. Read-only verbs —
including `task prepare` (v1.11+) — never touch it. The progress-read
-only invariant is locked by unit tests.

## 2. What agents must do

The CLI contract above lives in `code-pact` source. The
**conformance** contract lives in the per-agent instruction file that
the adapter generates. `code-pact adapter conformance <agent>` is the
read-only gate that verifies the instruction file satisfies the
contract.

The required-surface lists are the single source of truth in
[`src/core/adapters/conformance-spec.ts`](../src/core/adapters/conformance-spec.ts).
`adapter doctor`'s contract drift check and `adapter conformance`
both import from this module; the integration test suite imports
from it too. If you add a new required surface, the diff lands in
one place and every consumer follows.

### Required structural sections

The instruction file MUST contain these headings, byte-for-byte (the
strings are English-locked across all locales):

- `## Agent contract`
- `### When to invoke code-pact`
- `### What to verify first`
- `### How to handle failures`

### Required CLI surface mentions (lifecycle)

The instruction file MUST mention every lifecycle surface — at least
once each, anywhere in the body:

- `code-pact task prepare`
- `code-pact task start`
- `code-pact task complete`
- `code-pact task finalize`

### Required CLI surface mentions (diagnostic)

The instruction file MUST also mention every supporting diagnostic
surface — at least once each, anywhere in the body:

- `code-pact task context`
- `code-pact verify`
- `code-pact validate`

### Required failure guidance

The instruction file MUST mention every named failure mode — at
least once each, anywhere in the body:

- `blocked dependency`
- `verification failure`
- `adapter drift`
- `missing context pack`

### Per-file integrity

Every file declared in `.code-pact/adapters/<agent>.manifest.yaml`
MUST have an on-disk LF-normalised UTF-8 sha256 equal to the
manifest's recorded value. Drift is reported per file by
`file_checksum_match` checks in the conformance envelope.

### Conformance check ids (closed enum)

The `checks[]` array in the conformance envelope uses these ids; new
ids require an RFC and an entry in `src/core/adapters/conformance-spec.ts`.

| Check id | Asserts |
|---|---|
| `manifest_present` | Adapter manifest exists and parses |
| `instruction_file_present` | Manifest declares an `instruction` role file and that file is on disk |
| `contract_section_present` | Verbatim `## Agent contract` heading present |
| `axis_when_to_invoke` | `### When to invoke code-pact` present |
| `axis_what_to_verify` | `### What to verify first` present |
| `axis_how_to_handle` | `### How to handle failures` present |
| `required_cli_surface_mentions` | Every lifecycle and diagnostic surface mentioned |
| `required_failure_guidance` | Every failure keyword mentioned |
| `task_prepare_is_primary` | `code-pact task prepare` appears and precedes the first `recommend` / `task context` mention (it is the primary per-task entrypoint, not the pre-P29 loop) |
| `no_contract_antipatterns` | The guidance is free of P29 anti-patterns (e.g. `task finalize ... --agent`, which takes no `--agent`) |
| `activation_rules_documented` | The activation rules are documented — `task finalize --write` only after `task complete`, `wait_for_dependencies`, `CONTEXT_OVER_BUDGET`. Verifies **documentation presence, not runtime obedience** |
| `file_checksum_match` | Per-file: on-disk sha256 equals manifest |

**Severity (v1.x, P30).** Each check carries a `severity` of `required`
or `advisory`. `compliant` is `true` unless a **required** check fails;
a failing `advisory` check is surfaced (with an `adapter upgrade`
remediation) but does not break compliance. The three hardening checks
above (`task_prepare_is_primary`, `no_contract_antipatterns`,
`activation_rules_documented`) are `required` for adapters whose manifest
`generator_version` is semver >= the hardening threshold
(`ADAPTER_CONTRACT_HARDENING_FROM_VERSION`) and `advisory` below, so
installs that predate the P29-aligned templates warn rather than
hard-fail until re-upgraded. All other checks are `required`. Exit is 0
when `compliant`, 1 otherwise.

## 3. Recommended lifecycle

`code-pact` does not enforce a lifecycle at the CLI layer — `task
complete` does not require `task start` to have run first, for
example. The contract instead recommends a single deterministic
sequence per task. Adapters generate instruction files that walk the
agent through this sequence; `adapter conformance` confirms the
agent has been told about every verb in it.

```
task prepare ─┬─► (planned) ──► task start ──► implement ──► verify ──► task complete ──► task finalize
              ├─► (started) ──► implement ──► verify ──► task complete ──► task finalize
              ├─► (blocked) ──► resolve dependencies ──► task prepare (retry)
              └─► (done)    ──► noop
```

The verbs in detail:

- **`task prepare <task-id>`** — single per-task entry point.
  Returns current state, recommendation, context pack metadata, a
  structured `next_action` (`start_task` / `continue_implementation`
  / `wait_for_dependencies` / `noop_already_done` /
  `investigate_failure`), and a `commands` dictionary with every
  per-task verb pre-formatted. Progress-read-only. Optional
  `--dry-run` skips the context pack write.

- **`task start <task-id>`** — record a `started` event. The agent
  invokes this exactly once per implementation pass for a task; the
  command is idempotent — a second call from `started` state returns
  `kind: "already_started"` without appending a duplicate event.

- **Implement the task.** This is the agent's own work. `code-pact`
  does not run during this phase; it is invoked again only at the
  next verb boundary.

- **`verify --phase <p> --task <id>`** — run the task's declared
  verification commands without recording a progress event. Useful
  as a pre-flight before `task complete`. Returns
  `VERIFICATION_FAILED` (exit 1) on the first failing command, with
  full stdout / stderr in the JSON envelope.

- **`task complete <task-id>`** — runs verification and, on pass,
  appends a `done` event. Idempotent — a second call from `done`
  state returns success without appending a duplicate event.

- **`task finalize <task-id> [--write] [--audit-strict] [--base-ref
  <ref>]`** — flips the task's design YAML status to `done` and
  performs the declared-writes audit. Without `--write`, the command
  is a dry-run that reports what would change. In CI, pair
  `--audit-strict` with `--base-ref <default-branch>` so the audit
  compares against the merge-base of the working branch.

The early-return states in the diagram correspond to `task prepare`
short-circuits — the command does not build a context pack, returns
`recommendation: null`, and points the agent at the resolution path
(resolve the dependency / nothing to do).

## 4. Measurement

The success metrics defined in
[`docs/positioning.md`](positioning.md) are how the project measures
whether the contract is working. The metric set is locked here; the
Evidence Harness v2 (P26) computes the baseline values shown below
and recomputes them on every harness run.

| Metric | Definition | Baseline |
|---|---|---|
| Context pack p50 bytes | Per-task pack size, lower-median percentile across the dogfood corpus | 19275 |
| Context pack p90 bytes | Per-task pack size, lower 90th percentile | 49555 |
| Context pack max bytes | Largest single task's pack size | 314774 |
| First-pass verification rate | Percentage of `task complete` invocations whose declared verification passes on the first attempt | 100.0% |
| Task lifecycle adherence rate | State-machine adherence: percentage of `done` tasks with at least one `started` event before the first `done` event AND no legacy `planned → done` shortcut. `task prepare` is read-only and emits no event, so prepare-adherence is **not** measured | 80.6% |
| Undeclared write rate | Files changed by a task whose paths are not covered by the task's declared `writes` globs | deferred ([rationale](../design/decisions/evidence-harness-v2-rfc.md#non-goals-out-of-scope-for-p26)) |
| Adapter drift detection rate | Percentage of enabled agents where `adapter doctor` returns at least one error-severity issue | 0.0% |

Source: [`design/measurements/summary.json`](../design/measurements/summary.json),
measured against dogfood corpus git SHA `28b4df1` (the v1.17.1
release commit) with denominators `tasks_done: 108`,
`tasks_total: 144`, `agents_enabled: 1`. Reproduce:
`pnpm harness --corpus . --check`.

These metrics evaluate the contract — they are not part of the
contract. A drop in first-pass verification rate, for example, is a
signal that the context pack or the agent instructions need work; it
is not itself a contract violation.

## Reference

- [`docs/positioning.md`](positioning.md) — what code-pact is, what
  it deliberately is not, the core CLI surfaces, the success
  metrics.
- [`docs/cli-contract.md`](cli-contract.md) — full flag / exit code
  / JSON envelope / error code reference.
- [`src/core/adapters/conformance-spec.ts`](../src/core/adapters/conformance-spec.ts)
  — single source of truth for the required surfaces and headings;
  imported by `adapter doctor`, `adapter conformance`, and the
  integration test suite.
- [`design/decisions/agent-contract-v2-rfc.md`](../design/decisions/agent-contract-v2-rfc.md)
  — the RFC that locks the P21 contract decisions.
