# RFC: Context budget enforcement

**Status:** accepted (P24, 2026-05)
**Scope:** add a `--budget-bytes <N>` flag to `code-pact task context` and `code-pact task prepare` that enforces a deterministic upper bound on the rendered context pack size by progressively eliding sections in a fixed priority order. When the bound cannot be met without eliding `always_included` sections, the command fails with the new `CONTEXT_OVER_BUDGET` error code (the only new public code introduced by P24). The pack `content` byte-identical contract from v1.11 is preserved for the no-flag default path. The `excluded[]` array in `task context --explain --json` gains `budget_reserved_for_later` reason-code emissions (the v1.11 reserved value finally activates). Adapter conformance is not affected.
**Owners:** maintainer
**Related:**
- [design/decisions/agent-contract-v2-rfc.md](agent-contract-v2-rfc.md) (P21 — defines the section-level metadata `task context --explain` exposes and reserves `budget_reserved_for_later` for this RFC to activate).
- [design/decisions/task-readiness-schema-rfc.md](task-readiness-schema-rfc.md) (P10 — defines the task readiness fields `context_size` / `ambiguity` / `write_surface` that already drive section inclusion; budget enforcement layers on top, not in place of, those signals).
- [design/decisions/evidence-harness-v2-rfc.md](evidence-harness-v2-rfc.md) (P26 — committed the `pack_size_p50/p90/max_bytes` baseline that motivates this work; the `pack_size_max_bytes: 259650` outlier in `docs/maintainers/measurements/summary.json` is exactly the case `--budget-bytes` targets).

## Status lifecycle

- This document opens at status **proposed** in the P24-T0 PR and flips to **accepted** in a small follow-up commit before subsequent implementation work begins, per the P11–P21 precedent.
- P24-T0 is considered done only after a commit with `Status: accepted` has landed on main.
- Subsequent implementation PRs (P24-T1..T3) treat the accepted document as load-bearing.

## Background

[P21-T4](agent-contract-v2-rfc.md) shipped `code-pact task context --explain` with a per-section `bytes` + `reason_code` breakdown so context pack composition becomes auditable. The RFC explicitly reserved `budget_reserved_for_later` in `ContextExcludedReasonCode` for P24 ("budget enforcement"); a P21 unit test asserts P21 never emits the value, intentionally pressuring this RFC to be the one that activates it.

[P26-T2](../../docs/maintainers/measurements/summary.json) committed the dogfood baseline:

| metric | value |
|---|---|
| `pack_size_p50_bytes` | 20725 |
| `pack_size_p90_bytes` | 50131 |
| `pack_size_max_bytes` | 259650 |

The p50 is comfortable for every model on the supported agent list. The p90 (~49 KB) is fine for Sonnet / Opus / Codex but starts to crowd Haiku-class context windows when the agent has its own system prompt and tool definitions to share the budget with. The max (~254 KB) is a single outlier task (P21-T0, which inlines the full `agent-contract-v2-rfc.md` body via `decision_refs`) — well within any modern frontier model's context but a real cost spike for cheaper tiers.

Two operational gaps follow:

1. **No mechanism to enforce a bound.** Today the pack size is whatever the renderer produces. An agent operating against a context-constrained tier has no way to ask "give me at most N bytes" — it gets the full pack and must truncate downstream or fail in-model. The truncation, when it happens, is opaque to the project; the elision is not recorded anywhere; the agent has no way to know what was dropped.
2. **`--explain` is descriptive, not prescriptive.** The flag tells the consumer what is in the pack and why, but offers no actionable lever. Without enforcement, `--explain` is half a tool — diagnosis without remediation.

## Problem statement

1. **Per-task context bounding has no public surface.** Agents and CI consumers running against constrained models need a deterministic way to cap pack size at invocation time. Today the only path is "post-process the pack after the fact", which loses determinism and requires every consumer to re-implement elision logic.
2. **Elision priority is not specified anywhere.** Even if a consumer DID post-process the pack, there is no documented "which section drops first" order. The choice is policy: get it wrong and you drop the section the agent most needed.
3. **The P21-reserved enum value (`budget_reserved_for_later`) is dead code.** The reserved value exists to mark the forward-compatibility path; without an activator phase it stays asserted-as-absent forever.
4. **The `pack_size_max_bytes: 259650` outlier in the dogfood baseline is a real case.** Future tasks that reference large RFCs will compound. Without a budget mechanism, the only response to "this pack is too big" is to hand-edit the task's `decision_refs` or `reads` globs — which defeats the purpose of declarative readiness fields.

## Goals

- **Ship `--budget-bytes <N>` on `code-pact task context`** (additive flag, default off). When set, the renderer enforces `Buffer.byteLength(content, "utf8") <= N` by eliding sections in the priority order locked below. The default no-flag path is byte-identical to v1.12.
- **Ship `--budget-bytes <N>` on `code-pact task prepare`** (additive flag). When set, the same enforcement applies to the pack that `task prepare` writes (or simulates under `--dry-run`). The `context_pack_bytes` field in the prepare envelope reflects the post-elision size.
- **Define a fixed elision priority.** Sections drop in this order until the budget is met:
  1. `completed_tasks` (only shown under `ambiguity: high`; least task-specific signal)
  2. `related_decisions` when `context_size: large` (the "all decisions" path; declared decisions via `decision_refs` stay)
  3. `constitution` (project-wide, not task-specific)
  4. `rules` (when `write_surface: high` — the "all rules" path; never elides when rules are the default applies-to-matched subset)
  5. `reads` (declared globs with matched paths; declaration-only, no code body — elide last among declared-by-task sections)

  Sections NOT in this list are never elided: `header`, `phase_contract`, `task_definition`, `depends_on`, `writes`, `declared_decisions`, `acceptance_refs`, `verification_commands`, `progress_event_schema`, `format_overhead`. These are either always-included or carry task-declared intent the user explicitly opted into.

- **Emit `CONTEXT_OVER_BUDGET` when the budget cannot be met.** If after eliding every elidable section the pack still exceeds the budget, the command fails with exit code 2 and the new error code `CONTEXT_OVER_BUDGET`. The error envelope's `data.detail` carries `minimum_achievable_bytes` (the byte size of the pack after maximal elision) so the caller can adjust the budget or split the task.
- **Activate `budget_reserved_for_later` in `task context --explain --json`.** When `--explain --json` is invoked with `--budget-bytes`, every section that was elided to meet the budget appears in `excluded[]` with `reason_code: budget_reserved_for_later`. The P21 reserved value finally has a real emission path; the P21 unit test asserting absence stays correct for the no-budget case.
- **Preserve byte-identical default path.** When `--budget-bytes` is not set, the renderer is byte-identical to v1.12. The existing `tests/integration/pack-byte-identical.test.ts` lock continues to pass without modification.

## Non-goals (out of scope for P24)

- **No automatic budget inference from agent profile.** The flag is opt-in per invocation. Wiring agent profiles to declare a default budget is a future RFC — premature here because the agent → context-window mapping is itself a research problem.
- **No section-level truncation.** P24 elides whole sections, never partial section bodies. Truncating mid-section would either break Markdown structure or require per-section "summary" rendering that has no design today.
- **No reordering of sections.** The renderer's output order is fixed by the v1.11 contract. Budget enforcement only drops sections; remaining sections keep their original relative order.
- **No `--budget-tokens` flag.** Token counting requires a tokenizer choice (per model family), which would force code-pact to track tokenizer libraries. Bytes are a model-agnostic proxy; cli-contract.md already locks `Buffer.byteLength(..., "utf8")` as the byte measurement throughout the project.
- **No retroactive harness metric.** P26's `summary.json` records the natural pack size from `task context` without `--budget-bytes`. A `pack_size_after_budget_p50_bytes` metric (parameterised by a fixed budget) is interesting but deferred — the baseline value depends on the chosen budget and would muddy the unconditional pack-size signal.
- **No new flag on `adapter conformance`.** Conformance checks adapter contract surfaces, not pack sizes.

## Design

### Flag surface

```
code-pact task context <task-id> [--agent <name>] [--json] [--explain] [--budget-bytes <N>]
code-pact task prepare <task-id> [--agent <name>] [--json] [--dry-run] [--budget-bytes <N>]
```

- `N` is a positive integer; non-numeric / zero / negative values fail with `CONFIG_ERROR`.
- `--budget-bytes 0` is rejected (a zero-byte pack would not include the header). The smallest meaningful budget is the size of the minimum-pack composition (header + phase_contract + task_definition + verification_commands + progress_event_schema + format_overhead inter-section newlines).
- `--budget-bytes` combines freely with `--explain` and `--dry-run`.

### Elision algorithm

```text
sections = renderSections(ctx)   // P21 structured intermediate form
budget   = options.budgetBytes

let attempt = sections
let totalBytes = computeTotalBytes(attempt)

if (totalBytes <= budget) return attempt   // no elision needed

for (sectionName of ELISION_ORDER) {
  if (attempt.has(sectionName)) {
    attempt.drop(sectionName)
    totalBytes = computeTotalBytes(attempt)
    if (totalBytes <= budget) return attempt
  }
}

// Every elidable section dropped; still over budget.
throw new ContextOverBudgetError({
  budget_bytes: budget,
  minimum_achievable_bytes: totalBytes,
  unelidable_sections: attempt.map(s => s.name),
})
```

The elision order constant lives next to `renderSections` so the renderer's section catalogue and the elision policy stay one file apart.

### Error envelope

New public error code `CONTEXT_OVER_BUDGET` joins `KNOWN_CODES.public`. The error envelope:

```json
{
  "ok": false,
  "error": {
    "code": "CONTEXT_OVER_BUDGET",
    "message": "Context pack cannot be reduced below 18422 bytes; --budget-bytes 12000 is unachievable for this task.",
    "data": {
      "budget_bytes": 12000,
      "minimum_achievable_bytes": 18422,
      "unelidable_sections": ["header", "phase_contract", "task_definition", "verification_commands", "progress_event_schema", "format_overhead"]
    }
  }
}
```

`data.unelidable_sections` is the list of sections that survived maximal elision — it tells the caller what is structurally required and what they could do to fit the budget (split the task, reduce declared decision content, etc.).

Exit code: 2 (mirrors other CONFIG-class failures).

### `--explain --json` interaction

When `--budget-bytes` triggers elision AND `--explain --json` is set, every elided section appears in the existing `excluded[]` array with the previously-reserved reason code:

```json
{
  "excluded": [
    { "name": "constitution", "reason_code": "context_size_small_and_ambiguity_low" },
    { "name": "completed_tasks", "reason_code": "budget_reserved_for_later", "details": { "elided_for_budget_bytes": 12000, "section_bytes": 1024 } },
    { "name": "rules", "reason_code": "budget_reserved_for_later", "details": { "elided_for_budget_bytes": 12000, "section_bytes": 4183 } }
  ]
}
```

A section can appear in `excluded[]` for at most one reason. Budget elision takes precedence over the v1.11 inclusion-policy exclusion: if the section was already going to be excluded by `context_size_small_and_ambiguity_low` (e.g. `constitution` for a `context_size: small` task), it stays with the v1.11 reason; budget elision applies only to sections that would otherwise have been included.

The P21 unit test asserting `budget_reserved_for_later` is never emitted continues to pass — it runs without `--budget-bytes`. A new P24 unit test asserts the value IS emitted when `--budget-bytes` triggers elision.

### `task prepare` interaction

When `task prepare` is invoked with `--budget-bytes`, the budget applies to the pack the command writes (or simulates under `--dry-run`). The `context_pack_bytes` field in the envelope reflects the post-elision size. If `CONTEXT_OVER_BUDGET` fires, the envelope is the error envelope above; no pack is written; `progress.yaml` is not mutated (the progress-read-only invariant from P21-T3 is preserved on every path including this new failure).

The `commands` dictionary in the success envelope does NOT echo the `--budget-bytes` flag back into the suggested next-command strings — the budget is per-invocation policy, not state. A future RFC may revisit this if budget-on-every-invocation patterns emerge.

### Byte-identical default

When `--budget-bytes` is not set, `buildContextPack()` skips the elision pass entirely. The rendered `content` is byte-identical to v1.12. The existing `pack-byte-identical.test.ts` integration test continues to pass without modification.

## Out of scope (deferred)

- **Agent-profile-derived default budget.** Tracked here but deferred to a future RFC.
- **`--budget-tokens` flag.** Tracked here but deferred to a future RFC.
- **Harness metric for post-budget pack size.** Tracked here but deferred to a future RFC.
- **Section-level truncation / summarisation.** Out of scope; whole-section elision only.
- **Budget enforcement on `code-pact pack` (the legacy low-level command).** That command predates `task context` and is not the preferred entry point. Wiring budget there would expand the surface without serving the agent loop.

## Backward compatibility

- `code-pact task context --json` envelope without `--budget-bytes` — byte-identical to v1.12.
- `code-pact task prepare --json` envelope without `--budget-bytes` — byte-identical to v1.12.
- Pack `content` rendered without `--budget-bytes` — byte-identical to v1.12 (lock test continues to pass).
- `task context --explain --json` without `--budget-bytes` — byte-identical to v1.12; no `budget_reserved_for_later` emission.
- `KNOWN_CODES.public` — additive: `CONTEXT_OVER_BUDGET` joins the existing set.
- Adapter manifest schema — unchanged.
- Existing adapter instruction files — unchanged. The new flag is opt-in; no `adapter upgrade` is required.

## Risks

1. **Elision-order disagreement.** Different agents in different contexts might prefer different elision orders. Mitigation: the order is documented and locked; consumers who need a different order can post-process the `--explain --json` output and re-elide. A future RFC can refine the order based on observed usage. The dogfood baseline shows `completed_tasks` and `related_decisions` (the first two elision tiers) are zero-cost to drop on most tasks (most tasks have neither), so the policy is conservative.
2. **Minimum-pack size is task-dependent.** Two tasks with the same `--budget-bytes` value may produce very different post-elision sizes because their `task_definition` block is task-specific. The `minimum_achievable_bytes` field in the error envelope makes the floor observable per task; documentation will recommend running `task context --explain --json` first to see the unconditional size before choosing a budget.
3. **`budget_reserved_for_later` semantic drift.** The P21 RFC said the value was "reserved for budget enforcement"; this RFC defines what "elided for budget" means at the section level. Future RFCs that want to use the same value for a different elision mechanism (e.g. token-budget) need to either re-use the same emission shape or coin a new reason code.
4. **Test surface growth.** Every elision combination is a test case (n sections, 2^n subsets). Mitigation: assert the elision order property (eliding-by-priority) rather than enumerating subsets; pick a representative set of budget values that exercise each elision tier.

## Open questions

None at acceptance. Implementation choices (where the elision pass lives in `buildContextPack`, whether to memoise byte counts during elision, exact i18n message strings for the new error) follow existing P10 / P21 patterns and do not need RFC-level decisions.
