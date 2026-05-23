# RFC: Evidence Harness v2 — aggregate stats and adherence baselines

**Status:** proposed (P26, 2026-05)
**Scope:** extend the internal-only measurement harness at `scripts/harness/` with two new CSV outputs (`lifecycle-adherence-by-task.csv`, `adapter-drift-by-agent.csv`) and one new aggregate JSON sidecar (`summary.json`) that computes p50 / p90 / max for pack size, percentages for first-pass verification rate and state-machine adherence rate, and a count-by-code histogram for adapter drift. Populate the v1.11 `docs/positioning.md` / `docs/agent-contract.md` baseline numbers from the resulting CSVs. **Not a product feature** — the harness remains maintainer-only, not registered in `package.json` `bin`, never invoked by users, never surfaces in JSON envelopes or CLI help. The v2 work follows the P20 contract: byte-deterministic given the same input git SHA; CSV outputs are committable artifacts for citation in future `design/decisions/*.md`.
**Owners:** maintainer
**Related:**
- [design/decisions/evidence-harness-rfc.md](evidence-harness-rfc.md) (P20 — establishes the harness, the four initial CSVs, the byte-determinism contract, and the "internal-only" non-product stance).
- [design/decisions/agent-contract-v2-rfc.md](agent-contract-v2-rfc.md) (P21 — defines the lifecycle the adherence metric measures conformance to, and locks the success-metric set this RFC populates).
- [design/decisions/task-readiness-schema-rfc.md](task-readiness-schema-rfc.md) (P10 — defines the per-task `writes` field the deferred undeclared-write-rate metric would consume).

## Status lifecycle

- This document opens at status **proposed** in the P26-T0 PR and flips to **accepted** in a small follow-up commit before subsequent implementation work begins, per the P11–P21 precedent.
- P26-T0 is considered done only after a commit with `Status: accepted` has landed on main.
- Subsequent implementation PRs (P26-T1..T4) treat the accepted document as load-bearing.

## Background

[`docs/positioning.md`](../../docs/positioning.md) and [`docs/agent-contract.md`](../../docs/agent-contract.md) (shipped in v1.11.0 / P21) commit the project to five success metrics: context pack p50 / p90 / max bytes, first-pass verification rate, agent command adherence rate, undeclared write rate, and adapter drift detection rate. Both documents list these with baseline numbers marked "populated by P26" — that promise comes due here.

The existing v1 harness (P20) ships four per-task / per-phase CSVs (`pack-size-by-task`, `verify-success-rate`, `task-event-density`, `lint-issue-histogram`) with raw counts. Aggregation into the percentile / percentage / histogram shapes the success-metric set asks for is left to the consumer, and no consumer exists. v2 closes that gap.

## Problem statement

1. **Promised baselines have no source of truth.** The v1.11 docs cite five metrics with no numbers. Anyone reviewing the project can ask "what are the actual values?" and there is no committed answer.
2. **The v1 harness emits raw rows, not aggregates.** `pack-size-by-task.csv` has 107 rows of `pack_bytes` integers but no p50 / p90 / max column. Computing these by hand is fragile and not reproducible.
3. **Two of the five metrics need new instrumentation.** Agent command adherence and adapter drift detection are not computable from the v1 CSVs alone. Both are bounded extensions to the existing harness.
4. **One of the five metrics is genuinely hard to retrofit and must be honestly deferred.** Undeclared write rate requires attributing git commits to tasks. The project does not enforce a formal commit → task link (commits often touch multiple tasks; many tasks have no clean git boundary). A retrofit pass would either over-claim or require new lifecycle instrumentation. P26 documents the deferral instead of shipping a low-quality approximation.

## Goals

- **Ship `lifecycle-adherence-by-task.csv`** — per-task boolean indicators derived from the existing `task-event-density.csv` raw event counts: `started_before_done` (did the task have at least one `started` event before its first `done`?), `had_retry` (any `failed → started` cycle), `had_block` (any `blocked → resumed` cycle), `legacy_planned_to_done_shortcut` (task transitioned `planned → done` without a `started` event — the v0.6 legacy shortcut). The "adherence rate" the docs cite is the percentage of `done` tasks with `started_before_done = true` AND `legacy_planned_to_done_shortcut = false`.
- **Ship `adapter-drift-by-agent.csv`** — for each enabled agent in the corpus, run `adapter doctor` and aggregate the issue codes (`ADAPTER_MANIFEST_MISSING` / `ADAPTER_GENERATOR_STALE` / `ADAPTER_FILE_DRIFT` / `ADAPTER_CONTRACT_DRIFT` / etc.) into columns. One row per agent.
- **Ship `summary.json`** — single aggregate sidecar computed from every existing per-task / per-phase CSV plus the two new ones, producing the success-metric values the v1.11 docs reference: `pack_size_p50_bytes`, `pack_size_p90_bytes`, `pack_size_max_bytes`, `first_pass_verify_rate_percent`, `lifecycle_adherence_rate_percent`, `adapter_drift_rate_percent`, and a `undeclared_write_rate_status: deferred` field documenting the metric is intentionally not computed in v2.
- **Populate the baseline numbers in the v1.11 docs.** `docs/positioning.md` and `docs/agent-contract.md` flip their "populated by P26" placeholders to the actual values from the dogfood corpus run, with a footnote linking the source CSV row in `design/measurements/`.
- **Preserve the v1 harness contract.** Byte-deterministic CSV output for the same input git SHA. Existing column orders unchanged (additive only). The harness remains a `pnpm harness` script, never a `bin` entry. The `--check` default never writes; `--write` opts into `design/measurements/` mutation.

## Non-goals (out of scope for P26)

- **No undeclared-write-rate computation.** P26 documents the deferral and the reason. A future phase (P26+1 or P28) may add a `task finalize --audit-strict` event-write to progress.yaml so the audit result is observable historically, then aggregate that field. The v2 `summary.json` carries `undeclared_write_rate_status: "deferred"` with a `note` field pointing at this RFC.
- **No multi-repo corpus.** P26 measures the dogfood corpus only (the code-pact repo itself). External sample repos are deferred.
- **No time-series CSVs.** Each harness run is a snapshot. Trends over time are out of scope.
- **No web UI / dashboard.** CSVs are for citation in future RFCs and release notes. Visualisation is the consumer's problem.
- **No automatic README badge.** A "first-pass verify rate" or "adherence rate" badge in the README is rejected — these are corpus-specific dogfood numbers, not universal project quality signals.
- **No `summary.json` schema bump for `undeclared_write_rate`.** The field name + `"deferred"` status are part of the v2 shape; when the metric is implemented later, the field flips from `"deferred"` to the actual value without a schema bump.

## Design

### New CSV: `lifecycle-adherence-by-task.csv`

Columns (one row per task):

```
phase_id,task_id,started_before_done,had_retry,had_block,legacy_planned_to_done_shortcut,event_count
```

- `started_before_done` — `true` iff `task-event-density.started >= 1` AND the first `started` event timestamp precedes the first `done` event timestamp. `false` for tasks that have a `done` event without a prior `started` (the v0.6 legacy shortcut, or tasks where the agent skipped the explicit `task start`).
- `had_retry` — `task-event-density.failed >= 1`.
- `had_block` — `task-event-density.blocked >= 1`.
- `legacy_planned_to_done_shortcut` — `task-event-density.started === 0 && task-event-density.done >= 1`. Subset of `!started_before_done`.
- `event_count` — `task-event-density.total_events` (for ease of joining without re-reading the other CSV).

Sort order: `phase_id ASC, task_id ASC` (matches existing CSVs).

### New CSV: `adapter-drift-by-agent.csv`

Columns (one row per enabled agent listed under `project.yaml` `agents:` with `enabled != false`):

```
agent,doctor_ok,issue_count,manifest_missing,manifest_invalid,generator_stale,schema_drift,profile_drift,file_missing,file_drift,desired_stale,contract_drift,unmanaged_file
```

- `agent` — string from `project.yaml`.
- `doctor_ok` — `true` iff `adapter doctor --agent <agent>` returned `ok: true` (no error-severity issues).
- `issue_count` — total length of `data.issues[]`.
- Per-code columns — count of issues with that exact code. Order matches the order codes are documented in `docs/cli-contract.md`.

Sort order: `agent ASC`.

### New JSON: `summary.json`

```json
{
  "harness_version": "0.2.0",
  "summary_schema_version": 1,
  "input_git_sha": "<commit-sha>",
  "code_pact_cli_version": "1.11.0",
  "generated_at": "2026-05-DD",
  "metrics": {
    "pack_size_p50_bytes": 0,
    "pack_size_p90_bytes": 0,
    "pack_size_max_bytes": 0,
    "first_pass_verify_rate_percent": 0.0,
    "lifecycle_adherence_rate_percent": 0.0,
    "adapter_drift_rate_percent": 0.0,
    "undeclared_write_rate_status": "deferred",
    "undeclared_write_rate_note": "Computing this metric requires attributing git commits to tasks. The project does not enforce a formal commit → task link, so a historical retrofit would either over-claim or require new lifecycle instrumentation. Tracked under evidence-harness-v2-rfc.md Non-goals."
  },
  "denominators": {
    "tasks_done": 0,
    "tasks_total": 0,
    "agents_enabled": 0
  }
}
```

- `summary_schema_version: 1` — bumped when the metrics object's field set or units change. Adding a new metric field is NOT a bump; flipping a deferred-status field to a numeric value is NOT a bump.
- Percentile calculation: `pack_size_p50_bytes` is the lower median (the `(n+1)/2`-th value after sorting `pack-size-by-task.pack_bytes` ascending; for even n, take the lower of the two middle values, NOT the average — this preserves integer byte values without rounding).
- `first_pass_verify_rate_percent` = `100.0 * (count of rows where first_pass=true) / (count of rows)` from `verify-success-rate.csv`. Rounded to one decimal place.
- `lifecycle_adherence_rate_percent` = `100.0 * (count of rows where started_before_done=true AND legacy_planned_to_done_shortcut=false) / (count of rows where event_count > 0)` from `lifecycle-adherence-by-task.csv`. Tasks with zero events (never started) are excluded from the denominator — they are not "failures of adherence", they are "not yet attempted".
- `adapter_drift_rate_percent` = `100.0 * (count of rows where doctor_ok=false) / (count of rows)` from `adapter-drift-by-agent.csv`.
- `denominators` — surfaces the n values so consumers can judge statistical weight (the dogfood corpus is small; rates from n < 20 are advisory).

### Determinism

Same input git SHA produces the same `summary.json` bytes. Floating-point rates are computed from integer counts and formatted with one decimal place to avoid platform-specific representation differences. The new CSVs follow the same sort-and-byte-determinism rules the v1 CSVs follow.

### Harness invocation

The existing `pnpm harness --corpus . [--write] [--check] [--json]` surface is unchanged. `--write` now writes the two new CSVs and `summary.json` alongside the v1 outputs. `--check` (default) prints them to stdout in addition to the v1 outputs.

The `harness_version` in `measurements.manifest.json` bumps from `0.1.0` to `0.2.0` to mark the additive output set. The existing v1 outputs are byte-identical to v0.1 — adding the new CSVs and `summary.json` is purely additive.

### Baseline-flipping in v1.11 docs

`docs/positioning.md` and `docs/agent-contract.md` currently carry "populated by P26" placeholders in their metric tables. P26-T4 replaces those placeholders with the values from the committed `summary.json`, plus a footnote of the form:

> Baseline source: `design/measurements/summary.json` (generated against git SHA `<sha>` from the dogfood corpus, n=`<denominator>`).

The placeholders are NOT removed for the deferred undeclared-write-rate row — it stays "deferred (see evidence-harness-v2-rfc.md)" until a future phase ships it.

## Backward compatibility

- v1 CSV outputs (`pack-size-by-task.csv`, `verify-success-rate.csv`, `task-event-density.csv`, `lint-issue-histogram.csv`) are unchanged.
- `measurements.manifest.json` schema is unchanged. `harness_version` bumps `0.1.0 → 0.2.0`.
- `pnpm harness` flag surface is unchanged.
- No public CLI surface affected. The harness remains internal-only.

## Risks

1. **Adherence-rate misinterpretation.** The metric measures state-machine adherence (started before done, no legacy shortcut), not "task prepare invocation" adherence — `task prepare` is not an event in progress.yaml. Mitigation: the v1.11 docs already define adherence broadly; P26 narrows the operational definition explicitly in `docs/positioning.md` so consumers see what is actually counted. A future phase could add prepare-event tracking and refine the metric without a rename.
2. **Adapter doctor cost.** Running `adapter doctor` for every enabled agent during the harness run adds I/O. Acceptable for the dogfood corpus (5 agents max); a future multi-repo corpus might need parallelisation. Out of scope for v2.
3. **Floating-point determinism.** Rounding rates to one decimal place avoids the most common floating-point divergence, but the integer-percentile choice (lower median, not average) is the bigger lever. Locked by a byte-determinism test that runs the harness twice and diffs the outputs.
4. **Summary schema drift.** Future metrics will be added to `summary.json`. The `summary_schema_version` field gives consumers a versioning hook even though additive changes do not bump it.

## Open questions

None at acceptance. Implementation choices (where exactly the harness reads the doctor envelope from, whether to spawn `adapter doctor` as a subprocess or import the runDoctor function directly) follow the existing P20 patterns and do not need RFC-level decisions.
