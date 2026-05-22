# RFC: Agent Contract v2 — task prepare, context explain, adapter conformance

**Status:** accepted (P21, 2026-05)
**Scope:** new compound CLI command `code-pact task prepare`; new flag `code-pact task context --explain`; new CLI command `code-pact adapter conformance <agent>`; new pure-function module `src/core/recommend/` extracted from the existing `recommend` command; refresh of stable adapter instruction templates (`claude-code`, `codex`, `generic`) to embed the v2 contract surface; new shared spec module `src/core/adapters/conformance-spec.ts` consumed by both `adapter doctor` and `adapter conformance`; two new docs (`docs/positioning.md`, `docs/agent-contract.md`); two new CLI references (`docs/cli/task-prepare.md`, `docs/cli/adapter-conformance.md`). Adds metadata fields to the context pack JSON envelope (`--explain` mode only) without altering the markdown pack content (byte-identical contract preserved). Introduces no new public error codes; reuses `TASK_NOT_FOUND`, `AMBIGUOUS_TASK_ID`, `PHASE_NOT_FOUND`, `AGENT_NOT_FOUND`, `AGENT_NOT_ENABLED`, `CONFIG_ERROR`, and the `ADAPTER_*` family.
**Owners:** maintainer
**Related:**
- [design/decisions/task-readiness-schema-rfc.md](task-readiness-schema-rfc.md) (P10 — task-level fields that drive context pack section selection; `--explain` reports on them).
- [design/decisions/agent-contract-rfc.md](agent-contract-rfc.md) (P16 — the v1 agent contract surface that v2 extends; v2 keeps the three contract axes and adds lifecycle/diagnostic surface requirements).
- [design/decisions/lightweight-runbook-rfc.md](lightweight-runbook-rfc.md) (P12 — `task runbook` already returns next-step sequences; `task prepare` differs by being a per-task entry point that also returns recommendation + context pack metadata in one envelope).
- [design/decisions/evidence-harness-rfc.md](evidence-harness-rfc.md) (P20 — measurement harness; `--explain` exposes per-section bytes that will feed future P26 evidence work).

## Status lifecycle

- This document opens at status **proposed** in the P21-T0 PR.
- After review approval, and **before** the P21-T0 PR merges (or in a small follow-up commit per the P11–P20 precedent), the maintainer flips the status line at the top of this file to **accepted**.
- P21-T0 is considered done only after a commit with the status line reading `accepted` has landed on main.
- Subsequent implementation PRs (P21-T1..T6) treat the accepted document as load-bearing; they may not change decisions in this RFC without a separate RFC-update PR.

## Background

The agent loop today is split across several entry points: `recommend` returns model tier and effort; `task context` builds the pack; `task start` records a `started` event; the agent implements; `task complete` runs verify and appends a `done` event; `task finalize` reconciles declared writes. Each entry point is itself stable and well-tested, but agents stitching them together have to remember the sequence and the right flags, and they have no single read-only check-in that says "where am I, what should I do next, here is the context."

Three operational gaps follow from that:

1. **Agent operation errors.** Agents occasionally invoke the wrong command for the current task state (e.g. `task complete` before implementing because `recommend` was the last thing they saw). The split entry surface invites this.
2. **Context minimisation is unverifiable.** The measurement harness (P20) tracks per-task pack byte size, but cannot answer "why is this section included" at the agent or maintainer level. Future work that wants to budget or trim context (P24) has no per-section ground truth to operate against.
3. **Adapter contract checks are buried.** `adapter doctor` (v1.7 P16-T5) already detects `ADAPTER_CONTRACT_DRIFT` when the three axis headings are missing, but the result is mixed with manifest, generator, and ownership checks. There is no focused, machine-friendly read-only surface that answers "does this agent's installed adapter satisfy the contract."

## Problem statement

1. **No single deterministic entry point per task.** Agents must remember the sequence `recommend → task context → task start → ... → task complete → task finalize` and the right `--agent` / `--json` flags. There is no compound command that, given a task ID, returns both the recommendation and the next concrete action in one structured envelope.
2. **Context pack lacks per-section provenance.** The `task context` output is a deterministic markdown blob plus a byte count. Section-level inclusion logic (driven by `context_size`, `ambiguity`, `write_surface`, `depends_on`, `reads`, `writes`, `decision_refs`, `acceptance_refs`) is computable but never surfaced. Without it, future budget work and any audit of "did this task receive the right context" is impossible.
3. **No focused conformance surface for adapters.** `adapter doctor` mixes contract drift with manifest/generator/ownership concerns. CI consumers and agents that want to verify only "does the agent contract surface render correctly" must parse doctor output and filter manually.
4. **`recommend` logic is CLI-bound.** The recommendation computation lives inside `src/commands/recommend.ts` with input parsing and JSON envelope construction. It cannot be called from another command (e.g. `task prepare`) without duplicating the logic or shelling out.

## Goals

- **Ship `code-pact task prepare <task-id> [--agent <name>] [--json] [--dry-run]`** as a Stable (v1.11+) command. Returns a single structured envelope containing current task state, recommendation, context pack path + bytes, structured `next_action` (`start_task` / `continue_implementation` / `wait_for_dependencies` / `noop_already_done` / `investigate_failure`), and a `commands` dictionary listing all per-task lifecycle and diagnostic commands.
- **`task prepare` is progress-read-only.** It MUST NOT mutate `.code-pact/state/progress.yaml`. It MAY write the deterministic context pack at `.context/<agent>/<task-id>.md` unless `--dry-run` is passed. The early-return states (`done`, `blocked`, unmet dependencies) skip context pack writing entirely; their JSON envelope returns `context_pack_path: null` and `context_pack_bytes: 0` so consumers can branch on type, not on field presence.
- **Ship `code-pact task context --explain [--json]`** as a Stable (v1.11+) flag. In `--json` mode, the envelope adds a `sections` array (each entry with `name`, `bytes`, `reason_code`, optional `details`) and an `excluded` array (each entry with `name`, `reason_code`). Byte counts use `Buffer.byteLength(content, "utf8")`. The acceptance invariant `sum(sections[].bytes) === total_bytes === context_pack_bytes` holds — any byte not attributable to a content section is summed into a `format_overhead` section.
- **Include/exclude reason codes are closed enums** (`ContextSectionReasonCode`, `ContextExcludedReasonCode`). Variable detail (`glob`, `match_count`, `ref`, `rule_count`) lives in a sibling `details` object so the enum stays machine-friendly across versions.
- **`task context --explain` MUST NOT alter the pack markdown content.** Section metadata is computed alongside but never injected into `content`. The existing byte-identical lock test (`tests/integration/pack-byte-identical.test.ts`) protects this contract.
- **Ship `code-pact adapter conformance <agent> [--json]`** as a Stable (v1.11+) command. Exit code 0 when compliant, 1 when not. Checks: `## Agent contract` section present; three axis sub-headings (`### When to invoke code-pact`, `### What to verify first`, `### How to handle failures`); `required_cli_surface_mentions` split into `lifecycle_required` (`task prepare` / `task start` / `task complete` / `task finalize`) and `diagnostic_required` (`task context` / `verify` / `validate`) — ALL members of each list must be mentioned; `required_failure_guidance` (`blocked dependency` / `verification failure` / `adapter drift` / `missing context pack`); per-file checksum match against the manifest.
- **Conformance and doctor share one source of truth.** A new module `src/core/adapters/conformance-spec.ts` exports the required surface lists. `adapter doctor`'s contract drift check and `adapter conformance` both import from it, so adding or removing a required mention happens in one place.
- **Stable adapter templates carry the v2 contract surface.** `claude-code`, `codex`, and `generic` adapter `generateDesiredFiles()` output is refreshed so that newly-installed adapters pass conformance by construction. Experimental adapters (`cursor`, `gemini-cli`) SHOULD carry the same surface but are not required by conformance.
- **Extract `resolveRecommendation()` to `src/core/recommend/`** as a pure function with no I/O beyond what the caller passes. The existing `code-pact recommend` command becomes a thin wrapper. Existing JSON envelope output is preserved byte-for-byte (snapshot-locked).
- **Reuse existing error codes only.** `TASK_NOT_FOUND`, `AMBIGUOUS_TASK_ID`, `PHASE_NOT_FOUND`, `AGENT_NOT_FOUND`, `AGENT_NOT_ENABLED`, `CONFIG_ERROR`, and the existing `ADAPTER_*` family cover all P21 failure modes. No new error codes ship.

## Non-goals

- **No budget enforcement.** `--budget-bytes` and related truncation policy is deferred to P24. `ContextExcludedReasonCode` includes a reserved `budget_reserved_for_later` value for forward compatibility, but the P21 implementation MUST NOT emit it. A unit test asserts the absence.
- **No adapter schema bump.** `adapter_schema_version` stays at 1. Any breaking shape change to the manifest is deferred to a later phase.
- **No automatic conformance repair.** `adapter conformance` is read-only. Remediation is handled by re-running `adapter install` / `adapter upgrade`.
- **No CLI module split.** `src/cli.ts` continues to dispatch all commands. The P21 commands extend the existing dispatch surface minimally; a structural CLI split is deferred.
- **No multi-agent orchestration.** `task prepare` operates on a single task for a single agent. Coordinating across agents or tasks is out of scope.
- **No `task prepare --execute` flag.** The command returns intent only; the agent invokes the next command itself. A future RFC may revisit execution coupling, but P21 explicitly does not ship it.

## Design

### `task prepare` envelope

The success envelope returns:

- `task_id`, `phase_id`, `agent`
- `current_state` — one of `planned` / `started` / `resumed` / `blocked` / `done` / `failed`
- `recommendation` — full `resolveRecommendation()` output, or `null` for early-return states
- `context_pack_path` — string when written, `null` for early-return states
- `context_pack_bytes` — integer; `0` when no pack written
- `dry_run` — boolean
- `next_action` — `{ type, message }` where `type` is one of `start_task` / `continue_implementation` / `wait_for_dependencies` / `noop_already_done` / `investigate_failure`
- `commands` — dictionary keyed by `context` / `start` / `verify` / `complete` / `finalize`, each value a fully-formed shell-safe command string
- `blocked_by` — array of task IDs (possibly empty)

Early-return states emit `recommendation: null`, `context_pack_path: null`, `context_pack_bytes: 0`. The `commands` dictionary is still populated so the agent can choose to re-run after resolving the blocker.

### `task context --explain` envelope additions

When `--explain --json` is passed, the existing envelope grows two arrays:

- `sections[]` — each entry `{ name, bytes, reason_code, details? }`. `reason_code` ∈ `ContextSectionReasonCode`.
- `excluded[]` — each entry `{ name, reason_code, details? }`. `reason_code` ∈ `ContextExcludedReasonCode`.

The existing `content`, `charCount`, `includedRules`, `includedDecisions`, `includedConstitution` fields are unchanged. `total_bytes` and `context_pack_bytes` MUST equal `sum(sections[].bytes)`.

Without `--json`, `--explain` prints a human-readable table to stdout using the existing CLI formatting helpers.

### `adapter conformance` envelope

```
{
  ok: true,
  data: {
    agent: "claude-code",
    compliant: boolean,
    checks: [
      { id, status, file?, details? }
    ]
  }
}
```

`status` ∈ `pass` / `fail`. Exit code derived from `compliant`. `details` shape is check-specific; for `required_cli_surface_mentions`, it carries `lifecycle_required`, `diagnostic_required`, `missing_lifecycle`, `missing_diagnostic`.

### Shared conformance spec

```ts
// src/core/adapters/conformance-spec.ts
export const LIFECYCLE_REQUIRED_SURFACES = [
  "code-pact task prepare",
  "code-pact task start",
  "code-pact task complete",
  "code-pact task finalize",
] as const;

export const DIAGNOSTIC_REQUIRED_SURFACES = [
  "code-pact task context",
  "code-pact verify",
  "code-pact validate",
] as const;

export const REQUIRED_FAILURE_GUIDANCE = [
  "blocked dependency",
  "verification failure",
  "adapter drift",
  "missing context pack",
] as const;
```

`adapter doctor`'s `ADAPTER_CONTRACT_DRIFT` logic imports these constants. Adapter `generateDesiredFiles()` for stable agents references them so the template body is kept in sync.

### Lifecycle visualisation

The recommended per-task flow is documented in `docs/agent-contract.md`:

```
task prepare ─┬─► (planned) ──► task start ──► implement ──► verify ──► task complete ──► task finalize
              ├─► (started) ──► implement ──► verify ──► task complete ──► task finalize
              ├─► (blocked) ──► resolve dependencies ──► task prepare (retry)
              └─► (done)    ──► noop
```

## Out of scope (deferred work)

- **P22 — Agent schema v2.** Manifest shape bump, lifecycle command hooks (`prepare_command` / `finish_command`), adapter capability descriptor expansion.
- **P24 — Context budget enforcement.** `--budget-bytes`, deterministic truncation policy, eviction order (recent events → rules → constitution → declared decisions).
- **P26 — Evidence Harness v2.** Per-task adherence metrics, first-pass verification rate, undeclared write rate, drift detection rate.
- **P27 — CLI maintainability hardening.** Structural split of `src/cli.ts` into per-command files.

## Backward compatibility

- Existing `recommend` JSON envelope: unchanged (byte-identical, snapshot-locked).
- Existing `task context` JSON envelope (without `--explain`): unchanged (byte-identical pack content lock preserved).
- Existing `adapter doctor` JSON envelope: unchanged; the shared conformance spec is a refactor, not an output change.
- Existing adapter manifest schema: unchanged (`schema_version: 1`).
- Existing adapter instruction templates: body content evolves to include `task prepare` and the diagnostic surface, but the file paths, manifest fingerprint algorithm, and `adapter_schema_version` are unchanged. Existing installs WILL show `ADAPTER_FILE_DRIFT` against the new desired content; users re-run `adapter install` to refresh, per the v1.7 P16 precedent.

## Risks

1. **Byte-identical pack content lock.** The `--explain` work must not alter `content`. Mitigation: route section metadata through a separate channel that the renderer never writes back into the pack string. The existing lock test catches regressions.
2. **`recommend` extraction byte-identical guarantee.** The pure function refactor must not change the existing JSON envelope by even one byte. Mitigation: snapshot the current envelope before the refactor; assert byte equality after.
3. **Adapter template refresh causes drift on existing installs.** Mitigation: this is expected and matches the v1.7 P16 precedent (`ADAPTER_CONTRACT_DRIFT` was introduced by template change); document the re-install step in CHANGELOG and migration docs.
4. **Doctor / conformance reason-code divergence.** If the shared spec module is bypassed by one of the two callers, they will report differently. Mitigation: enforce import via a unit test that walks both modules' source and asserts the spec is the single import source.

## Open questions

None at acceptance. Implementation details (i18n message keys, exact CLI flag ordering, JSON field ordering within the envelope) follow the existing precedents documented in `docs/cli-contract.md` and need no RFC-level decision.
