# Agent contract

> **Audience: agent integrators and maintainers.** If you just want to _use_
> code-pact with an already-supported agent, you can skip this — start with
> [getting-started.md](getting-started.md). Read on if you are integrating a
> new agent, reviewing an adapter, or judging whether a feature is in scope.

This document defines the contract between `code-pact` and any AI
coding agent that drives work in a code-pact project. It pairs with
[`docs/positioning.md`](positioning.md) (what the project is and is
not) and [`docs/cli-contract.md`](cli-contract.md) (the CLI semantic
contract). Generated command usage, flags, and examples live in
[`docs/cli-reference.generated.md`](cli-reference.generated.md). Read this when
integrating a new agent, when reviewing adapter changes, or when judging
whether a proposed feature is in scope.

The contract has three sides:

1. What `code-pact` guarantees to agents.
2. What agents must do to satisfy `adapter conformance`.
3. The recommended per-task lifecycle the contract is shaped around.

A short section on measurement follows; it defines the project's
evaluation criteria and points to focused feature-specific evidence
where such evidence is maintained.

## 1. What `code-pact` guarantees

These guarantees hold within a major version. Breaking any of them
requires a major-version bump.

### CLI surface stability

Every command listed under the `Stable (v1.0)` entry of the
[Stability taxonomy](cli-contract.md#stability-taxonomy-v10) has a
frozen flag surface, JSON envelope shape, exit code contract, and
error code set. New optional flags and new envelope fields are
additive; existing flags, fields, and codes do not change meaning
within a major.

`task prepare`, `task context --explain`, and `adapter conformance`
join the stable set and carry the same guarantee.

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

| Exit code | Meaning                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| 0         | Success, or diagnostic finished with no error-severity issues                                                      |
| 1         | Verification failed, or a diagnostic returned at least one error / non-compliant result                            |
| 2         | Configuration error — bad flag combination, missing positional, agent not found, task not found, ambiguous task id |
| 3         | Internal error — unexpected exception in the CLI; please file an issue                                             |

Commands that do not return `--json` mirror the same exit codes; the
human-readable output is informative only.

### Error code stability

Public error codes are listed in
[`docs/cli-contract.md`](cli-contract.md#error-codes). New error
codes are additive within a major; existing codes do not change meaning.
The `code` field of an error envelope is the contract — agents may
branch on the value.

`task context --explain` and `adapter conformance` deliberately ship **no new
public error codes**. `task prepare` reuses the same task/agent/configuration
codes as `task context`; when budgeted deferred context materialization fails,
it surfaces the context-specific public codes documented in
[`docs/cli-contract.md`](cli-contract.md#error-codes), including
`CONTEXT_WRITE_FAILED`.

### Collaboration conflicts: fail closed, then recover

When two contributors work on separate branches, the dangerous failures are
**id collisions that git merges cleanly** — two branches each mint the same
`P<N>` / `P<N>-T<M>` id in separate files, so there is no git conflict and the
corruption is invisible until a check runs. An agent must treat these as
**fix-before-proceed**, never work around them:

- `DUPLICATE_PHASE_ID` / `DUPLICATE_TASK_ID` / `PHASE_ID_MISMATCH` (errors from
  `plan lint` / `doctor`, `data.issues[]`) — each carries a structured
  `recovery` object. The fix is a manual id rename, so it is `recovery.manual_action`
  (the exact edit — **not** a shell command) + `recovery.confirm` (the re-verify
  command, `code-pact plan lint`); `recovery.reference` names what collides and
  where. Apply `manual_action` (renumber one side + update the things that
  reference it), then run `confirm`.
- `AMBIGUOUS_PHASE_ID` / `AMBIGUOUS_TASK_ID` (top-level `error.code`, **exit 2**)
  — a resolver **failed closed** rather than guessing which duplicate you meant.
  `data.phases[]` lists the colliding locations
  (`AMBIGUOUS_PHASE_ID`: the phase **file paths**; `AMBIGUOUS_TASK_ID`: the **phase
  ids** that both define the task). Do **not** retry the same id; resolve the
  underlying duplicate first (the `plan lint` errors above), then re-run the
  original command.
- `PROGRESS_EVENT_CONFLICT` (warning from `plan analyze` / `doctor`, and the
  `code-pact status` overview as `data.conflicts[]`) — two contributors recorded
  **incompatible lifecycle events** for one task (a `done` after `done`, a second
  `started`, an event after a terminal `done`). The reducer stays total, so this
  is advisory by default — but it is a real concurrent edit. It carries a
  structured `details.events[]` (`{ event_id, status, author?, at }`, D3) naming
  _who_ produced each side, so you do not parse prose: read it from
  `code-pact status --json | jq '.data.conflicts[]'` (or `doctor --json`),
  decide which event is correct, and remove/correct the other. `event_id` is the
  content id — the _suffix_ of a per-event filename `<at-compact>-<event_id>.yaml`,
  so locate the file with the `.code-pact/state/events/*-<event_id>.yaml` glob
  (the filename has an `<at-compact>-` prefix, so the id alone is not the name);
  for an event that lives only in a legacy `.code-pact/state/progress.yaml` there
  is no per-event file (reconcile `progress.yaml`, or migrate it, instead). Do
  **not** auto-pick a winner.

The tool deliberately surfaces these rather than auto-resolving them — picking a
winner silently is how a teammate's work gets overwritten. Full per-code recovery
steps: [`docs/troubleshooting.md` § Id collisions & mismatches](troubleshooting.md#id-collisions--mismatches-collaboration)
and [§ `PROGRESS_EVENT_CONFLICT`](troubleshooting.md#progress_event_conflict-from-doctor--plan-analyze).

### Determinism

For the same git SHA and the same inputs:

- `task context` produces byte-identical pack content (locked by
  `tests/integration/pack-byte-identical.test.ts`).
- `recommend` produces a byte-identical JSON envelope.
- `task context --explain --json` attaches metadata but the
  `content` string is byte-identical to non-explain mode. The
  Context Fit explain metrics it adds — `natural_bytes`, `final_bytes`,
  `saved_bytes`, `saved_ratio`, `minimum_achievable_bytes`, `elided_sections`,
  and `budget_bytes` (only when a budget was applied) — are byte-based and
  deterministic (no tokenizer, summarization, model, or network), and
  `minimum_achievable_bytes` is the same floor `CONTEXT_OVER_BUDGET` reports.
- Full-detail `task prepare` (or any explicit budget flag, which forces full detail) writes the same context pack bytes that `task context` produces for the same task. Default minimal `task prepare` does not build or write a pack.
- When an explicit context budget defers sections, `task context`, full-detail `task prepare`, and `task prepare --dry-run` (in full detail) compute the same rendered Markdown bytes and the same `context:sha256:<digest>` manifest reference for the same task, agent, and resolved byte budget. Only the full-detail `task prepare` materializes the derived manifest and returns a non-null retrieval command; default minimal `task prepare` does not build or write a pack.
- When an explicit context budget would otherwise exceed the resolved byte cap,
  the pack may first use deterministic structural projections for safe content
  types before fully deferring sections. Projection is not summarization: read
  glob matches can be replaced by exact parent-directory counts, and only
  `context_size: large` related decisions can be reduced to accepted ADR
  `Implementation commitments`. Declared decisions are never projected. The
  manifest reference is deterministic on read-only paths, but exact original
  sections become retrievable only after a writing command materializes the
  manifest. No-budget packs and budgeted packs that naturally fit stay
  byte-identical to the unprojected form.

| Path                         | Reference calculated | Artifact persisted | `retrieve_command` |
| ---------------------------- | -------------------: | -----------------: | -----------------: |
| `task context`               |                  yes |                 no |             `null` |
| `task prepare --dry-run`     |                  yes |                 no |             `null` |
| `task prepare --detail full` |                  yes |                yes |           non-null |

Agents must not infer retrieval availability from the manifest reference alone.
Use the returned `deferred_context.retrieve_command` when present.
The current public `pack` CLI writes an unbudgeted context pack and exposes no
context-budget option, so it does not enter the deferred-context manifest flow.

Where a command writes deterministic artifacts (context pack, adapter
files), the same input produces the same on-disk bytes.

### Local loop memory

Code Pact may write bounded local loop-memory episodes under
`.code-pact/cache/loop-memory/`. This cache is advisory and disposable. It is
not part of the shared control plane, is not committed, and is not a source of
truth for task status, verification, decisions, write audit, Evidence, Context
artifacts, or Failure Capsules.

Agents must not rely on local memory for correctness. In P58, `task prepare`,
`task context`, and `recommend` do not read loop memory, and no memory content is
added to the context pack. If the cache is absent or corrupt, the normal
lifecycle still runs from the design files, progress ledger, and verification
commands.

Episode files are bounded to 8 KiB, validated against their filename identity,
and use UTC `Date.prototype.toISOString()` timestamps. Corrupt, oversized, or
identity-mismatched cache files are reported as local cache problems; they are
not promoted into agent context and are not deleted by `doctor`.

### Progress is an append-only event log

The progress ledger is an append-only event log — code-pact never edits a past
event. Each event is its own file under `.code-pact/state/events/` (a legacy
monolithic `.code-pact/state/progress.yaml`, if present, is still read and
merged). The only verbs that record an event are `task start`, `task block`,
`task resume`, `task complete`, and `task record-done` (which records
a `done` event with `source: external` — either for work completed
outside the loop or for the `record_only` lane after you ran the
project's verification by hand). Read-only verbs — including `task
prepare` — never touch
it, and `task finalize` writes only the design YAML status, never
the progress ledger. The progress-read-only invariant is locked by unit tests.

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

| Check id                                       | Asserts                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest_present`                             | Adapter manifest exists and parses                                                                                                                                                                                                                                                                                                              |
| `instruction_file_present`                     | Manifest declares an `instruction` role file and that file is on disk                                                                                                                                                                                                                                                                           |
| `contract_section_present`                     | Verbatim `## Agent contract` heading present                                                                                                                                                                                                                                                                                                    |
| `axis_when_to_invoke`                          | `### When to invoke code-pact` present                                                                                                                                                                                                                                                                                                          |
| `axis_what_to_verify`                          | `### What to verify first` present                                                                                                                                                                                                                                                                                                              |
| `axis_how_to_handle`                           | `### How to handle failures` present                                                                                                                                                                                                                                                                                                            |
| `required_cli_surface_mentions`                | Every lifecycle and diagnostic surface mentioned                                                                                                                                                                                                                                                                                                |
| `required_failure_guidance`                    | Every failure keyword mentioned                                                                                                                                                                                                                                                                                                                 |
| `task_prepare_is_primary`                      | `code-pact task prepare` appears and precedes the first `recommend` / `task context` mention (it is the primary per-task entrypoint, not the older diagnostic-first loop)                                                                                                                                                                       |
| `no_contract_antipatterns`                     | The guidance is free of contract anti-patterns (e.g. `task finalize ... --agent`, which takes no `--agent`)                                                                                                                                                                                                                                     |
| `activation_rules_documented`                  | The activation rules are documented — `task finalize --write` only after `task complete`, `wait_for_dependencies`, `CONTEXT_OVER_BUDGET`. Verifies **documentation presence, not runtime obedience**                                                                                                                                            |
| `recommendation_consumption_guidance_present`  | The guidance tells the agent to consume the recommendation (anchored on `data.recommendation`). Verifies **documentation presence, not runtime obedience**                                                                                                                                                                                      |
| `lifecycle_mode_guidance_present`              | The guidance documents `lifecycleMode` and the `record_only` lane (anchored on `lifecycleMode` + `record_only`)                                                                                                                                                                                                                                 |
| `cannot_switch_model_fallback_present`         | The guidance tells the agent to report a limitation when it `cannot switch model` rather than ignore the recommendation                                                                                                                                                                                                                         |
| `repair_policy_guidance_present`               | The guidance documents bounded repair policy basics (`repairPolicy`, `maxRepairAttempts`, `command_failed`)                                                                                                                                                                                                                                     |
| `repair_policy_json_paths_present`             | The guidance documents the command-specific JSON paths for `repairPolicy` and `allowedEscalation`                                                                                                                                                                                                                                               |
| `bounded_repair_runtime_constraints_present`   | The guidance says the first bounded repair keeps the same model, effort, and context, and uses the failure delta                                                                                                                                                                                                                                |
| `bounded_repair_stop_guidance_present`         | The guidance documents repeated-fingerprint stopping and allowed escalation after exhaustion                                                                                                                                                                                                                                                    |
| `bounded_repair_nonretryable_guidance_present` | The guidance documents the closed list of nonretryable failure kinds                                                                                                                                                                                                                                                                            |
| `file_checksum_match`                          | Per-file: on-disk sha256 equals manifest                                                                                                                                                                                                                                                                                                        |
| `adapter_file_path_unowned`                    | Manifest entry names a path this adapter could not have generated (narrow built-in read authority, not the broad write namespace — so `.claude/skills/private.md` is refused), or one resolving through a symlink. Target is not read (no `actual_sha256`, no heading inspection) — forged-manifest content/SHA-oracle guard. Always `required` |
| `file_checksum_skipped_unverifiable`           | Manifest entry is a dynamic skill in the shared `.claude/skills/` namespace without `ownership: handed_off` — read-ownership cannot be proven, so it is not read/checksummed. Always `advisory`                                                                                                                                                 |
| `dynamic_handoff_orphan_unverified`            | Manifest entry is `ownership: handed_off` and names a dynamic skill under the adapter's create namespace, but the file is missing. Existing bytes are not read; conformance compares only current desired output hash with manifest hash. Always `advisory`                                                                                     |
| `dynamic_handoff_manifest_stale`               | Manifest entry is `ownership: handed_off` and names a dynamic skill under the adapter's create namespace, but current desired output hash differs from manifest hash. Existing bytes are not read/checksummed. Always `advisory`                                                                                                                |

**Severity.** Each check carries a `severity` of `required`
or `advisory`. `compliant` is `true` unless a **required** check fails;
a failing `advisory` check is surfaced (with an `adapter upgrade`
remediation) but does not break compliance. The three hardening checks
above (`task_prepare_is_primary`, `no_contract_antipatterns`,
`activation_rules_documented`) are `required` for adapters whose manifest
`generator_version` is semver >= the hardening threshold
(`ADAPTER_CONTRACT_HARDENING_FROM_VERSION`) and `advisory` below, so an
adapter generated before the hardened templates warns rather than
hard-fails until it is re-upgraded. The three consumption-guidance checks
(`recommendation_consumption_guidance_present`,
`lifecycle_mode_guidance_present`, `cannot_switch_model_fallback_present`)
are gated the same way but on their **own** threshold
(`RECOMMENDATION_CONSUMPTION_FROM_VERSION`), so an adapter generated after
the hardening threshold but before the consumption templates stays
advisory rather than failing all at once. Bounded-repair checks are also
gated on their own first-shipped version
(`BOUNDED_REPAIR_GUIDANCE_FROM_VERSION`): adapters generated before that
version report missing repair anchors as advisory; adapters generated at
or after that version require them. Dynamic read-authority checks
that cannot prove safe byte reads (`file_checksum_skipped_unverifiable`,
`dynamic_handoff_orphan_unverified`, `dynamic_handoff_manifest_stale`) are
always `advisory`. All other checks are `required`. Exit is 0 when
`compliant`, 1 otherwise.

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
              ├─► (blocked, dep) ──► resolve dependencies ──► task prepare (retry)
              ├─► (blocked, manual) ──► resolve block reason ──► task prepare (retry)
              ├─► (requires_decision) ──► inspect decision (full-detail prepare) ──► task start
              └─► (done)    ──► noop
```

The verbs in detail:

- **`task prepare <task-id>`** — single per-task entry point.
  Default (`--detail minimal`) returns a **Minimum Sufficient Work Order**:
  the task's `goal`, `read_scope`, `write_scope`, `done_when`, `verify`,
  `decision_required`/`decision_refs`, a single `next` action (`start_task` /
  `continue_implementation` / `wait_for_dependencies` / `resolve_block` /
  `inspect_decision` / `noop_already_done` / `investigate_failure`), `blocked_by`,
  honest `failure` info for `failed` states, `block.summary` for manual blocks
  (bounded to 512 UTF-8 bytes), and a `more` command that fetches the full detail
  envelope. It does **not** build or write a context pack, resolve the
  recommendation, read decision bodies, or scan memory. Progress-read-only.
  Any explicit budget flag (`--budget-bytes`, `--context-budget`, `--recommended-context-budget`)
  forces `--detail full`, ignoring `--detail minimal`.
  Use `--detail full` (or any explicit budget flag) to receive the historical
  contract: `recommendation`, full `commands` dictionary, context pack
  metadata, `decision_commitments`, and `applied_context_budget`/`deferred_context`.
  `--dry-run` is honored only in `--detail full`; in minimal mode there is
  nothing to preview.
  For a `requires_decision` task the default minimal output returns `next.type:
inspect_decision` with a `next.command` that points to the full-detail
  `task prepare`; run it to fetch `decision_commitments` before starting.
  `commands.verify` and `commands.complete` include `--json --detail agent`;
  use those strings verbatim so verification failures arrive as compact
  capsules instead of duplicated raw stdout/stderr.

- **`task start <task-id>`** — record a `started` event. The agent
  invokes this exactly once per implementation pass for a task; the
  command is idempotent — a second call from `started` state returns
  `kind: "already_started"` without appending a duplicate event.

- **Implement the task.** This is the agent's own work. `code-pact`
  does not run during this phase; it is invoked again only at the
  next verb boundary.

- **Declare regression evidence for bugfixes.** When a task is
  `type: bugfix`, prefer declaring one static regression artifact in
  the plan before completion. New artifacts belong in `writes`:

  ```yaml
  writes:
    - tests/session-expiry.test.ts
  ```

  Existing artifacts belong in `acceptance_refs`:

  ```yaml
  acceptance_refs:
    - tests/session-expiry.test.ts
  ```

  Accepted evidence forms are tests, fixtures, and reproduction
  artifacts. A passing command, manual test, screenshot, log, comment,
  PR description, or Failure Capsule is useful context, but it is not a
  static regression-evidence declaration by itself.

  Examples that count:

  ```yaml
  writes:
    - src/parser/reproductions/missing-token.md
    - src/parser/__tests__/missing-token.test.ts
  acceptance_refs:
    - fixtures/parser/missing-token.json
  ```

  Examples that do not count:

  ```yaml
  writes:
    - src/parser/**
  acceptance_refs:
    - docs/reproduction.md
    - https://example.test/issue/123
  ```

  In the user-facing completion summary, list the path(s) briefly:

  ```text
  Regression evidence:
  - tests/session-expiry.test.ts
  ```

  Do not paste full test logs, duplicate Failure Capsule stdout/stderr,
  store evidence-cache bodies in progress events, or claim that the mere
  presence of a test proves the bug can never recur.

- **`verify --phase <p> --task <id>`** — run the task's deterministic
  checks (the declared verification commands **and** the
  `requires_decision` decision gate) without recording a progress event.
  Useful as a pre-flight before `task complete`. Returns
  `VERIFICATION_FAILED` (exit 1) when any check fails — a verification
  command or the decision gate — with the per-check results (including
  the failing check) in `data.checks` (standalone `verify` uses this path; `task complete` failure places its checks under `data.verify.checks`).
  Prefer the `--json --detail agent` form emitted by `task prepare`:
  read `data.failure.kind`, `data.failure.check`, `data.failure.reason`,
  `data.failure.fingerprint` (when present), stderr/stdout excerpts (when
  present), then `data.failure.retrieve_command` only for command-output
  failures when the excerpts are insufficient. Standalone `verify` can report
  `invalid_state` for state-consistency checks such as `progress_event` or
  `task_status`; in that case `check` and `reason` are the actionable fields.
  Fingerprints, excerpts, evidence refs, and retrieve commands are optional and
  normally exist only for command-output failures. Do not fetch full evidence by
  default.

  On `task complete --json --detail agent`, `data.prior_local_signal` means
  only that the same failure fingerprint is retained in the bounded local store
  (`exact_match_count`, `last_observed_at`). It does not describe previous
  repair attempts or hypotheses, so agents must not infer them. If the current
  conversation or diff proves the same change is being rerun unchanged, avoid
  that rerun. If `stopOnRepeatedFingerprint` is true, the stop contract takes
  precedence.

### Bounded repair recommendation

Code Pact does not repair a failed task, restart an agent, schedule retries, call
a model API, or append progress events after a verification failure. It reports
deterministic repair guidance on the existing recommendation object.

The JSON path depends on the command:

- `task prepare --json --detail full`: `data.recommendation.repairPolicy`
- `recommend --json`: `data.repairPolicy`

The same distinction applies after repair exhaustion when the policy says to use
the existing escalation guidance:

- `task prepare --json --detail full`: `data.recommendation.allowedEscalation`
- `recommend --json`: `data.allowedEscalation`

The disabled shape is:

```json
{
  "mode": "disabled",
  "reasonCode": "decision_loop"
}
```

`reasonCode` is one of `decision_loop`, `record_only`, `architecture`,
`high_ambiguity`, `high_risk`, `high_write_surface`, or `weak_verification`.

The bounded shape is:

```json
{
  "mode": "bounded",
  "maxRepairAttempts": 1,
  "retryableFailureKinds": ["command_failed"],
  "nonRetryableFailureKinds": [
    "timed_out",
    "aborted",
    "decision_required",
    "unsafe_write",
    "invalid_state",
    "unknown"
  ],
  "retryContext": "failure_delta",
  "firstRetry": "same_model_same_effort_same_context",
  "stopOnRepeatedFingerprint": true,
  "afterExhaustion": "use_allowed_escalation"
}
```

Agents may attempt bounded repair only for `command_failed`, at most once, and
with the same model, effort, and context. The only extra input is the Failure
Capsule plus the current diff; do not rerun `task prepare`, `task context`, or
repository-wide discovery just to widen context. Fetch full evidence only when
the capsule excerpts are insufficient. If the same fingerprint recurs, or the
single repair attempt fails, stop and follow the existing `allowedEscalation`
guidance. Non-retryable kinds are terminal for bounded repair.

The user-facing lifecycle summary is in
[`docs/per-task-loop.md`](per-task-loop.md); this section is the adapter-facing
contract shape.

- **`task complete <task-id>`** — runs verification and, on pass,
  appends a `done` event (`source: loop`). Idempotent — a second call
  from `done` state returns success without appending a duplicate event.
  If any `depends_on` task is not `done`, exits 2 with
  `error.code: TASK_DEPENDENCY_INCOMPLETE` and lists the incomplete
  dependency ids in `data.deps`. On verification failure it exits 1 with
  `error.code: VERIFICATION_FAILED`; read `error.cause_code` **first** to
  know what to fix: `COMMANDS_FAILED` → fix the failing verification command;
  `DECISION_REQUIRED` → write or accept the required ADR; `ABORTED` →
  retry only after the interruption is resolved. With
  `--json --detail agent`, `error.message` is intentionally short. Read
  the compact failure capsule in this order: `data.failure.kind`,
  `data.failure.check`, `data.failure.reason`, `data.failure.fingerprint`
  (when present), `data.failure.stderr_excerpt` (when present),
  `data.failure.stdout_excerpt` (when present),
  `data.failure.evidence_available`, `data.failure.evidence_error`, then
  `data.failure.retrieve_command`. Fingerprints, excerpts, evidence refs, and
  retrieve commands are optional and normally exist only for command-output
  failures. Do not fetch full evidence by default; use `retrieve_command` only
  when command-output excerpts are insufficient to decide the fix.
  `data.prior_local_signal` means only that the same failure fingerprint is
  retained in the bounded local store. It does not identify prior repair
  attempts. Do not infer prior repairs from it; avoid an unchanged rerun only
  when the current conversation or diff proves the change is the same, and honor
  `stopOnRepeatedFingerprint` first when it is true.

- **`task record-done <task-id> --evidence "<text>"`** —
  records a `done` event with `source: external` **without** running
  verification commands; the proof is `--evidence`. Two uses: work
  completed **outside** the loop (already merged / not verifiable from
  the tree), and the `record_only` lane. If any `depends_on` task is
  not `done`, exits 2 with `error.code: TASK_DEPENDENCY_INCOMPLETE` and
  lists the incomplete dependency ids in `data.deps`. The decision gate
  still applies — a `requires_decision` task with no resolvable ADR
  returns `DECISION_REQUIRED` (exit 2) and records no progress event
  (the ledger is unchanged). It is a distinct path from `task complete`, not a way to
  skip verification. See
  [`per-task-loop.md` § Recording a done without task complete](per-task-loop.md#recording-a-done-without-task-complete)
  for the lifecycle explanation (a lighter loop, not lighter verification).

- **`task execute <task-id> --executor-file <project-relative-posix-path>
[--agent <a>] [--timeout <ms>] [--json]`** — experimental single-file
  one-shot execution. The task must read and write one existing source file,
  HEAD and the git index must be unchanged, and the working tree must be
  clean. The executor file must be given as the raw project-relative POSIX path
  exactly as stored in the project: no leading `/` or `~`, no `..` or `.`
  segments, no empty segments, and no backslashes. It must resolve to a regular,
  non-symlink, executable file inside the project. The executor is a trusted
  executable: it runs with `cwd` set to an OS temporary directory, a sanitized
  environment (known repository-path variables such as `PWD`, `INIT_CWD`,
  `npm_package_json`, etc. are removed), and the same process privileges as
  code-pact. It is **not** an OS sandbox. The executor receives a JSON input
  with the task goal, `source_path`, source content, and verification command; it
  must emit either a `replace_exact` payload (`expected_file_sha256` is 64
  lowercase hex, `old_text` is non-empty, `new_text` is a string) or a `blocked`
  reason. The runtime validates the executor output at the controller boundary,
  applies the replacement atomically, and re-runs the verification command. The
  resulting source file is also bounded to `MAX_SOURCE_BYTES` (`8192` bytes),
  producing `EDIT_REJECTED` with reason `RESULTING_SOURCE_TOO_LARGE` if exceeded.
  The runtime records `done` only when HEAD, the git index, and the working tree
  contain exactly the expected source-file change. Scope auditing covers HEAD,
  the index, and Git-visible tracked/untracked paths; ignored paths and
  repository-external side effects are not prevented. On `EXECUTOR_FAILED` or
  `EDIT_REJECTED` the public envelope carries `data.reason`. On
  `EXECUTOR_MUTATED_WORKTREE` and `EXECUTION_SCOPE_VIOLATION` the runtime attempts
  a compare-and-swap rollback of the source file and reports `data.rollback`
  (`complete`/`incomplete`/`stale`), `data.head_changed`, and `data.index_changed`;
  it never resets HEAD or unstages changes. Rollback distinguishes known edits
  applied by Code Pact (CAS against the captured applied content) from unknown
  executor mutations (current content is re-read before rollback). The rollback
  is best-effort and not guaranteed. All public failure reasons and path lists
  are bounded to 2,048 UTF-8 bytes.

- **`task finalize <task-id> --json [--write] [--audit-strict] [--base-ref
<ref>]`** — reports the task's design-YAML finalization candidate and
  emits the declared-writes audit. Without `--write` it is a dry-run that
  reports what would change; add `--write` to flip the task's design YAML
  status to `done` on the clean path. `--audit-strict` makes audit
  warnings exit-relevant, and `--base-ref <ref>` switches the audit from
  working-tree mode to merge-base branch mode. Both `--audit-strict` and
  `--base-ref` require `--json`. In CI, use `--audit-strict --base-ref
<default-branch> --write --json` when the audit should gate the
  mutation.

The early-return states in the diagram correspond to `task prepare`
short-circuits — the command does not build a context pack, returns
`recommendation: null`, and points the agent at the resolution path
(resolve the dependency / nothing to do).

## 4. Measurement

The success metrics defined in
[`docs/positioning.md`](positioning.md) are how the project measures
whether the contract is working. The metric definitions remain stable,
but the former generic Evidence Harness is retired: this repository no
longer keeps release-refreshed aggregate CSV/JSON snapshots for metrics
that currently have no live task corpus to measure. Do not reintroduce a
general measurement substrate unless a specific feature needs a narrow
fixture.

The compact agent-detail evidence envelope still has a fixed byte fixture at
[`docs/maintainers/evidence/agent-detail-evidence.json`](maintainers/evidence/agent-detail-evidence.json),
reproduced with `pnpm exec tsx scripts/measure-agent-detail.ts --write`.

| Metric                        | Definition                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context pack p50 bytes        | Per-task pack size, lower-median percentile across the dogfood corpus                                                                                                                                                                                                                                                                                                      |
| Context pack p90 bytes        | Per-task pack size, lower 90th percentile                                                                                                                                                                                                                                                                                                                                  |
| Context pack max bytes        | Largest single task's pack size                                                                                                                                                                                                                                                                                                                                            |
| First-pass verification rate  | Percentage of `task complete` invocations whose declared verification passes on the first attempt                                                                                                                                                                                                                                                                          |
| Task lifecycle adherence rate | State-machine adherence: among tasks that have any progress events, the percentage with at least one `started` event before the first `done` event AND no legacy `planned → done` shortcut. `task prepare` emits no progress event, so prepare-adherence is **not** measured. Historical dogfood baselines can sit below 100% because older tasks used the legacy shortcut |
| Undeclared write rate         | Files changed by a task whose paths are not covered by the task's declared `writes` globs. Currently not computed; historical rationale lives in git history / the archive record for the retired evidence-harness-v2 RFC                                                                                                                                                  |
| Adapter drift detection rate  | Percentage of enabled agents where `adapter doctor` returns at least one error-severity issue                                                                                                                                                                                                                                                                              |

These metrics evaluate the contract — they are not part of the
contract. A drop in first-pass verification rate, for example, is a
signal that the context pack or the agent instructions need work; it
is not itself a contract violation.

## Reference

- [`docs/positioning.md`](positioning.md) — what code-pact is, what
  it deliberately is not, the core CLI surfaces, the success
  metrics.
- [`docs/cli-reference.generated.md`](cli-reference.generated.md) —
  generated command usage, flags, and examples.
- [`docs/cli-contract.md`](cli-contract.md) — exit codes, JSON
  envelopes, error codes, and semantic guarantees.
- [`src/core/adapters/conformance-spec.ts`](../src/core/adapters/conformance-spec.ts)
  — single source of truth for the required surfaces and headings;
  imported by `adapter doctor`, `adapter conformance`, and the
  integration test suite.
- The **agent-contract v2 RFC** — the RFC that locked the agent-contract
  decisions; retired, so its text is in git history and the `.code-pact/state`
  archive record.
