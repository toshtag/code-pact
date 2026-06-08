# RFC: Agent Contract v2 — task prepare, context explain, adapter conformance

**Status:** accepted (P21, 2026-05)
**Scope:** new compound command `task prepare`; new flag `task context --explain`; new command `adapter conformance <agent>`; pure-function `src/core/recommend/` extracted from the `recommend` command; shared `src/core/adapters/conformance-spec.ts` consumed by both `adapter doctor` and `adapter conformance`; refresh of the stable adapter templates (`claude-code`, `codex`, `generic`) to embed the v2 surface. Additive on every envelope; introduces **no new error codes** (reuses `TASK_NOT_FOUND`, `AMBIGUOUS_TASK_ID`, `PHASE_NOT_FOUND`, `AGENT_NOT_FOUND`, `AGENT_NOT_ENABLED`, `CONFIG_ERROR`, and the `ADAPTER_*` family).
**Owners:** maintainer
**Related:** [task-readiness-schema](task-readiness-schema-rfc.md) (P10 — task fields that drive context-pack section selection; `--explain` reports on them) · [agent-contract](agent-contract-rfc.md) (P16 — the v1 contract v2 extends; keeps the three contract axes, adds lifecycle/diagnostic surface requirements) · [lightweight-runbook](lightweight-runbook-rfc.md) (P12 — `task runbook`; `task prepare` differs by being a per-task entry point returning recommendation + pack metadata in one envelope) · [evidence-harness](evidence-harness-rfc.md) (P20 — `--explain` per-section bytes feed later evidence work).

## Summary

A single deterministic per-task entry point and an auditable context pack. `task prepare <task-id>` collapses the `recommend → task context → task start → … → task complete → task finalize` sequence into one read-only envelope (current state, recommendation, pack path/bytes, a structured `next_action`, and a `commands` dictionary). `task context --explain` exposes per-section byte provenance. `adapter conformance <agent>` gives a focused read-only pass/fail on the agent contract surface, sharing its required-surface lists with `adapter doctor`. User-facing walkthrough: [docs/agent-contract.md](../../docs/agent-contract.md).

## Decisions

1. **`task prepare <task-id> [--agent] [--json] [--dry-run]` is Stable (v1.11+) and progress-read-only.** It MUST NOT mutate `.code-pact/state/progress.yaml`. It MAY write the context pack at `.context/<agent>/<task-id>.md` unless `--dry-run`. *Rationale:* one entry point removes the "which command for this state?" guesswork that drives agent operation errors; read-only keeps it a safe check-in.
2. **Early-return states (`done`, `blocked`, unmet dependencies) skip pack writing.** Their envelope returns `recommendation: null`, `context_pack_path: null`, `context_pack_bytes: 0`, but still populates `commands` so the agent can re-run after resolving the blocker. *Rationale:* consumers branch on `next_action.type`, not on field presence.
3. **`task context --explain [--json]` is Stable (v1.11+) and MUST NOT alter the pack markdown.** Section metadata is computed alongside and never injected into `content`; the byte-identical lock test (`tests/integration/pack-byte-identical.test.ts`) protects this. *Rationale:* the contract that the pack is byte-stable is more valuable than co-locating the metadata.
4. **Reason codes are closed enums** (`ContextSectionReasonCode`, `ContextExcludedReasonCode`); variable detail lives in a sibling `details` object. *Rationale:* the enum stays machine-friendly across versions while detail evolves freely.
5. **`adapter conformance <agent> [--json]` is Stable (v1.11+), read-only, exit 0/1.** Remediation is re-running `adapter install` / `adapter upgrade`. *Rationale:* a focused conformance surface that CI can consume without parsing-and-filtering `adapter doctor` output.
6. **Conformance and doctor share one source of truth** — `src/core/adapters/conformance-spec.ts`. Both `adapter doctor`'s `ADAPTER_CONTRACT_DRIFT` check and `adapter conformance` import the required-surface lists; stable adapter `generateDesiredFiles()` references them. *Rationale:* adding/removing a required mention happens in one place, so the two callers cannot diverge.
7. **`resolveRecommendation()` extracted to `src/core/recommend/` as a pure function;** the `recommend` command becomes a thin wrapper with byte-identical (snapshot-locked) JSON output. *Rationale:* `task prepare` needs the recommendation without duplicating logic or shelling out.
8. **No new error codes.** The existing taxonomy covers all P21 failure modes.

## Contract surface

### `task prepare` envelope

Success returns: `task_id`, `phase_id`, `agent`; `current_state` ∈ `planned` / `started` / `resumed` / `blocked` / `done` / `failed`; `recommendation` (full `resolveRecommendation()` output, or `null` for early-return states); `context_pack_path` (string when written, else `null`); `context_pack_bytes` (integer, `0` when no pack); `dry_run` (boolean); `next_action` = `{ type, message }` with `type` ∈ `start_task` / `continue_implementation` / `wait_for_dependencies` / `noop_already_done` / `investigate_failure`; `commands` (dictionary keyed `context` / `start` / `verify` / `complete` / `finalize`, each a shell-safe command string); `blocked_by` (array of task IDs, possibly empty).

### `task context --explain` envelope additions

With `--explain --json`, the existing envelope grows `sections[]` (each `{ name, bytes, reason_code, details? }`, `reason_code` ∈ `ContextSectionReasonCode`) and `excluded[]` (each `{ name, reason_code, details? }`, `reason_code` ∈ `ContextExcludedReasonCode`). Existing fields (`content`, `charCount`, `includedRules`, `includedDecisions`, `includedConstitution`) are unchanged. Bytes use `Buffer.byteLength(content, "utf8")`. Invariant: `total_bytes === context_pack_bytes === sum(sections[].bytes)` — any byte not attributable to a content section is summed into a `format_overhead` section. Without `--json`, `--explain` prints a human-readable table. `ContextExcludedReasonCode` reserves `budget_reserved_for_later` for P24 budget enforcement; P21 MUST NOT emit it (a unit test asserts its absence).

### `adapter conformance` envelope

`{ ok, data: { agent, compliant, checks: [{ id, status, file?, details? }] } }`, `status` ∈ `pass` / `fail`, exit code derived from `compliant`. Checks: `## Agent contract` section present; three axis sub-headings (`### When to invoke code-pact`, `### What to verify first`, `### How to handle failures`); `required_cli_surface_mentions` split into `lifecycle_required` (`task prepare` / `task start` / `task complete` / `task finalize`) and `diagnostic_required` (`task context` / `verify` / `validate`) — ALL members of each list must be mentioned; `required_failure_guidance` (`blocked dependency` / `verification failure` / `adapter drift` / `missing context pack`); per-file checksum match against the manifest. For the surface-mentions check, `details` carries `lifecycle_required`, `diagnostic_required`, `missing_lifecycle`, `missing_diagnostic`. Stable templates (`claude-code`, `codex`, `generic`) carry the full surface and pass by construction; experimental adapters (`cursor`, `gemini-cli`) are not required to.

### Recommended lifecycle

`task prepare` → on `planned`: `task start` → implement → `verify` → `task complete` → `task finalize`; on `started`: implement onward; on `blocked`: resolve dependencies → re-run `task prepare`; on `done`: noop. Documented in `docs/agent-contract.md`.

### Backward compatibility

`adapter_schema_version` / manifest schema stay at 1. Existing `recommend`, `task context` (no `--explain`), and `adapter doctor` JSON envelopes are byte-identical (the shared conformance spec is a refactor, not an output change). Adapter template *bodies* evolve to mention `task prepare` and the diagnostic surface, so existing installs WILL show `ADAPTER_FILE_DRIFT` against the new desired content — users re-run `adapter install` / `adapter upgrade` to refresh (the v1.7 P16 precedent). File paths and fingerprint algorithm are unchanged.

## Alternatives considered

- **Enforce a `task prepare --execute` flag** — rejected; the command returns intent only and the agent invokes the next command itself. Execution coupling is left to a future RFC.
- **Inject section metadata into the pack `content`** — rejected; would break the byte-identical pack lock. Metadata routes through a separate channel the renderer never writes back.
- **Let `adapter doctor` and `adapter conformance` each carry their own required-surface lists** — rejected; they would drift. A shared spec module is the single import source (enforced by a unit test).
- **Ship budget enforcement / `--budget-bytes` here** — rejected; deferred to P24. `budget_reserved_for_later` is reserved but unused in P21.
- **Bump the adapter schema / split `src/cli.ts`** — rejected as out of scope; deferred to P22 (schema v2) and P27 (CLI maintainability) respectively.

## Open questions

None at acceptance. Implementation details (i18n message keys, CLI flag ordering, JSON field ordering) follow the precedents in `docs/cli-contract.md` and need no RFC-level decision. Deferred follow-on work: P22 (agent schema v2), P24 (context budget enforcement + elision order), P26 (Evidence Harness v2 adherence metrics), P27 (CLI maintainability split).

## References

- RFCs: [task-readiness-schema](task-readiness-schema-rfc.md) (P10) · [agent-contract](agent-contract-rfc.md) (P16) · [lightweight-runbook](lightweight-runbook-rfc.md) (P12) · [evidence-harness](evidence-harness-rfc.md) (P20) · [stability-taxonomy](stability-taxonomy.md).
- Docs: [docs/agent-contract.md](../../docs/agent-contract.md) · [docs/cli-contract.md](../../docs/cli-contract.md).
