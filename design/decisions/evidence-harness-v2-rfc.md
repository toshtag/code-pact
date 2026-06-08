# RFC: Evidence Harness v2 — aggregate stats and adherence baselines

**Status:** accepted (P26, 2026-05)
**Scope:** extend the internal-only measurement harness at `scripts/harness/` with two new CSV outputs (`lifecycle-adherence-by-task.csv`, `adapter-drift-by-agent.csv`) and one aggregate JSON sidecar (`summary.json`) computing p50/p90/max for pack size, first-pass-verify and lifecycle-adherence rates, and an adapter-drift histogram. Populate the v1.11 `docs/positioning.md` / `docs/agent-contract.md` baseline numbers from the resulting CSVs. **Not a product feature** — the harness stays maintainer-only (no `package.json` `bin`, never in JSON envelopes or CLI help), follows the P20 byte-determinism contract (same input git SHA → same bytes), and its CSV outputs are committable artifacts for citation in future `design/decisions/*.md`.
**Owners:** maintainer
**Related:** [evidence-harness](evidence-harness-rfc.md) (P20 — establishes the harness, the four initial CSVs, the byte-determinism contract, the internal-only stance) · [agent-contract-v2](agent-contract-v2-rfc.md) (P21 — defines the lifecycle adherence measures conformance to, and the success-metric set this RFC populates) · [task-readiness-schema](task-readiness-schema-rfc.md) (P10 — the per-task `writes` field the deferred undeclared-write-rate metric would consume).

## Summary

The v1.11 docs commit to five success metrics with baselines marked "populated by P26": context-pack p50/p90/max bytes, first-pass verify rate, agent command adherence rate, undeclared write rate, and adapter drift rate. The v1 (P20) harness emits raw rows, not aggregates, and two metrics need new instrumentation. P26 ships the two new CSVs plus `summary.json`, computes the values from the dogfood corpus, and flips the doc placeholders. **One metric — undeclared write rate — is honestly deferred**, not faked. User-facing walkthrough: [docs/concepts/evidence-harness.md](../../docs/concepts/evidence-harness.md).

## Decisions

- **New CSV `lifecycle-adherence-by-task.csv`** (one row/task; columns `phase_id,task_id,started_before_done,had_retry,had_block,legacy_planned_to_done_shortcut,event_count`; sort `phase_id ASC, task_id ASC`). Derived from `task-event-density.csv` raw counts:
  - `started_before_done` — `true` iff `started >= 1` AND the first `started` timestamp precedes the first `done`. `false` for a `done` with no prior `started`.
  - `had_retry` — `failed >= 1`; `had_block` — `blocked >= 1`.
  - `legacy_planned_to_done_shortcut` — `started === 0 && done >= 1` (the v0.6 `planned → done` shortcut; a subset of `!started_before_done`).
  - `event_count` — `total_events` (for joining without re-reading the other CSV).
  - **Rationale:** all four indicators are computable from existing raw counts, so no new event instrumentation is needed; the boolean shape is what the percentage metric aggregates over.
- **New CSV `adapter-drift-by-agent.csv`** (one row per enabled agent — `project.yaml` `agents:` with `enabled != false`; sort `agent ASC`; columns `agent,doctor_ok,issue_count,manifest_missing,manifest_invalid,generator_stale,schema_drift,profile_drift,file_missing,file_drift,desired_stale,contract_drift,unmanaged_file`). `doctor_ok` = `adapter doctor --agent <agent>` returned `ok: true`; `issue_count` = `data.issues[]` length; per-code columns count issues with that exact code, ordered as documented in `docs/cli-contract.md`. **Rationale:** the drift metric is not computable from v1 CSVs; per-code columns preserve the histogram the docs cite.
- **New JSON `summary.json`** — single aggregate sidecar over every per-task/per-phase CSV plus the two new ones. Carries `harness_version`, `summary_schema_version: 1`, `input_git_sha`, `code_pact_cli_version`, `generated_at`, a `metrics` object, and a `denominators` object (`tasks_done`, `tasks_total`, `agents_enabled` — surfaced so consumers can judge statistical weight; rates from n < 20 are advisory). `summary_schema_version` bumps only when the metrics field set or units change; **adding a metric field or flipping a deferred-status field to a numeric value is NOT a bump.**

### `summary.json` metric contract (load-bearing — pinned by P28 tests)

- `pack_size_p50_bytes` / `_p90_bytes` / `_max_bytes` — percentiles over `pack-size-by-task.pack_bytes`. **p50 is the lower median**: the `(n+1)/2`-th value after ascending sort; for even n take the *lower* of the two middle values, NOT the average — preserves integer bytes without rounding.
- `first_pass_verify_rate_percent` = `100.0 * (rows where first_pass=true) / (rows)` from `verify-success-rate.csv`, rounded to one decimal.
- `lifecycle_adherence_rate_percent` = `100.0 * (rows where started_before_done=true AND legacy_planned_to_done_shortcut=false) / (rows where event_count > 0)` from `lifecycle-adherence-by-task.csv`. **Zero-event tasks are excluded from the denominator** — they are "not yet attempted", not adherence failures.
- `adapter_drift_rate_percent` = `100.0 * (rows where doctor_ok=false) / (rows)` from `adapter-drift-by-agent.csv`.
- `undeclared_write_rate_status: "deferred"` plus an `undeclared_write_rate_note` pointing at this RFC. **Rationale:** computing it requires attributing git commits to tasks; the project enforces no formal commit → task link, so a retrofit would over-claim or need new lifecycle instrumentation.

### Determinism & invocation

Same input git SHA → same `summary.json` bytes. Rates are computed from integer counts and formatted to one decimal to avoid platform float divergence (the lower-median integer percentile is the bigger determinism lever). Locked by a test that runs the harness twice and diffs outputs. The existing `pnpm harness --corpus . [--write] [--check] [--json]` surface is unchanged and additive: `--write` now also writes the two CSVs + `summary.json`; `--check` (default) also prints them; v1 outputs stay byte-identical. `harness_version` bumps `0.1.0 → 0.2.0`. `measurements.manifest.json` schema and the public CLI surface are untouched.

### Baseline-flipping in v1.11 docs

P26-T4 replaces the "populated by P26" placeholders in `docs/positioning.md` and `docs/agent-contract.md` metric tables with values from the committed `summary.json`, each footnoted `Baseline source: design/measurements/summary.json (generated against git SHA <sha> from the dogfood corpus, n=<denominator>)`. The undeclared-write-rate row stays "deferred (see evidence-harness-v2-rfc.md)" until a future phase ships it.

## Non-goals (out of scope for P26)

- **No undeclared-write-rate computation.** P26 documents the deferral and reason; `summary.json` carries `undeclared_write_rate_status: "deferred"` with a `note` pointing here. A future phase may add a `task finalize --audit-strict` event-write to progress.yaml so the audit is historically observable, then aggregate that field.
- **No multi-repo corpus.** Dogfood corpus only (the code-pact repo). External sample repos deferred.
- **No time-series CSVs.** Each run is a snapshot; trends are out of scope.
- **No web UI / dashboard.** CSVs are for citation in RFCs and release notes; visualisation is the consumer's problem.
- **No automatic README badge.** Corpus-specific dogfood numbers are not universal project-quality signals.
- **No `summary.json` schema bump for `undeclared_write_rate`.** The field name + `"deferred"` status are part of the v2 shape; implementing the metric later flips the value without a schema bump.

## Alternatives considered

- **Ship a low-quality undeclared-write-rate approximation in v2** — rejected; without a formal commit → task link it would over-claim or demand new instrumentation. Honest deferral with a documented status field instead.
- **Compute aggregates in the consumer rather than the harness** — rejected; hand-computing p50/p90 over 100+ rows is fragile and not reproducible. `summary.json` makes the success-metric values a committed source of truth.
- **Average (not lower median) for p50** — rejected; averaging two middle bytes loses integer determinism. Lower median keeps byte values exact and platform-stable.
- **README adherence/verify-rate badge** — rejected as a non-goal; these are corpus-specific, not universal signals.

## Open questions

None at acceptance. Implementation choices (where the harness reads the doctor envelope; subprocess vs. importing `runDoctor` directly) follow existing P20 patterns and need no RFC-level decision.

One interpretation risk is noted for consumers: the adherence metric measures state-machine adherence (started before done, no legacy shortcut), not `task prepare` invocation — `task prepare` is not a progress.yaml event. `docs/positioning.md` narrows the operational definition explicitly; a future phase could add prepare-event tracking without a rename.

## References

- RFCs: [evidence-harness](evidence-harness-rfc.md) (P20) · [agent-contract-v2](agent-contract-v2-rfc.md) (P21) · [task-readiness-schema](task-readiness-schema-rfc.md) (P10) · [spec-conformance](spec-conformance-rfc.md) (P28 — pins these clauses to named tests).
- Docs: [docs/concepts/evidence-harness.md](../../docs/concepts/evidence-harness.md) · [docs/positioning.md](../../docs/positioning.md) · [docs/agent-contract.md](../../docs/agent-contract.md) · [docs/cli-contract.md](../../docs/cli-contract.md).
