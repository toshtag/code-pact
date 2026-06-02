# Evidence harness

> code-pact v1.10+ (v2 outputs added in v1.12 / P26). **Maintainer tooling, not a product feature.** The harness lives at `scripts/harness/` and is invoked via `pnpm harness`. It is never registered in `package.json` `bin`, never surfaces in JSON envelopes, and never appears in `code-pact --help`.

## Why this exists

Every design decision in code-pact through v1.9 was made on qualitative judgement: "this feels safer", "this feels noisier", "this is the natural break-point". The qualitative posture carried the project through P1–P19 without major regressions, but two recent calls hit its limits — the cycle severity in P19-T2 and the strict-clean dogfood scope in P15-T3 both turned on questions that quantitative evidence could have settled deterministically.

The harness is the path out. It captures a small set of deterministic metrics from the corpus and emits CSV that future RFCs can cite as "the v1.10 baseline shows X". Move design judgement from "感覚" to "measurement", one row at a time.

See [`design/decisions/evidence-harness-rfc.md`](../../design/decisions/evidence-harness-rfc.md) for the full rationale and alternatives considered.

## What it measures

Six CSV files plus a manifest and an aggregate summary, under `docs/maintainers/measurements/`:

| File | One row per | What it tells you |
| --- | --- | --- |
| `pack-size-by-task.csv` | task | The "context bandwidth" each task asks of an agent (byte count + line count + section count of the `task context` pack). Cardinalities of `reads` / `writes` / `decision_refs` / `acceptance_refs` give a sense of how richly each task is wired into the corpus. |
| `verify-success-rate.csv` | task with a `done` event | First-pass vs retry counts. Quantifies how strong verification commands are at catching real failures vs how often agents have to retry. |
| `task-event-density.csv` | task with ≥ 1 event | Progress event histogram (started / blocked / resumed / done / failed) + `event_span_days`. Quantifies how often tasks bounce vs flow linearly. |
| `lint-issue-histogram.csv` | (phase, code) pair | Count of each `plan lint --include-quality` diagnostic across the corpus. Quantifies the "noise floor" of the lint surface — a row count of 0 means the strict-clean dogfood regime is holding. |
| `lifecycle-adherence-by-task.csv` *(v1.12+ / P26)* | task with ≥ 1 event | Per-task booleans: `started_before_done` (earliest started precedes earliest done), `had_retry`, `had_block`, `legacy_planned_to_done_shortcut`. Quantifies how often the recommended lifecycle is followed. |
| `adapter-drift-by-agent.csv` *(v1.12+ / P26)* | agent referenced in any issue or progress event | `doctor_ok` + per-`ADAPTER_*`-code counts. Quantifies how often `adapter doctor` surfaces real drift. |

The sibling `measurements.manifest.json` records the harness version, the corpus git SHA, the cli version, the generation date (date only, no clock time), and the CSV file list.

`summary.json` *(v1.12+ / P26)* is an aggregate sidecar with `summary_schema_version: 1`. It computes the five success metrics the v1.11 [`docs/positioning.md`](../positioning.md) and [`docs/agent-contract.md`](../agent-contract.md) cite from the rows of the CSVs above. Shape:

```json
{
  "harness_version": "0.2.0",
  "summary_schema_version": 1,
  "input_git_sha": "<commit>",
  "code_pact_cli_version": "<version>",
  "generated_at": "YYYY-MM-DD",
  "metrics": {
    "pack_size_p50_bytes": 0,
    "pack_size_p90_bytes": 0,
    "pack_size_max_bytes": 0,
    "first_pass_verify_rate_percent": 0.0,
    "lifecycle_adherence_rate_percent": 0.0,
    "adapter_drift_rate_percent": 0.0,
    "undeclared_write_rate_status": "deferred",
    "undeclared_write_rate_note": "..."
  },
  "denominators": {
    "tasks_done": 0,
    "tasks_total": 0,
    "agents_enabled": 0
  }
}
```

### Computation rules

- **Percentiles use the lower-percentile rule** (no floating-point average). The `Math.ceil((p/100) × n)`-th element of the sorted ascending array, clamped to `[1, n]`. For `n=4`, `p=50` returns the second element, not the average of the two middle elements. This preserves integer byte values without rounding.
- **Rates round to one decimal place.** `Math.round(100 × num / den × 10) / 10`. A `0/0` rate emits `0.0`, not `NaN`.
- **Adherence numerator** = rows where `started_before_done && !legacy_planned_to_done_shortcut`. **Adherence denominator** = rows where `event_count > 0`. Tasks with zero events are excluded from the denominator — they are "not yet attempted", not "failures of adherence". `task prepare` emits no progress event, so the metric measures state-machine adherence only.
- **Adapter drift gate** = `doctor_ok` is `false` iff at least one issue has `severity: "error"`. Warning-only states (e.g. `ADAPTER_GENERATOR_STALE` alone) keep `doctor_ok: true`.

### Undeclared-write-rate deferral

`summary.json` carries `undeclared_write_rate_status: "deferred"` (never `"computed"` in v1.12). The metric is defined in `docs/positioning.md` but is intentionally not computed because the project does not enforce a formal commit → task link — commits often touch multiple tasks; many tasks have no clean git boundary. A historical retrofit would either over-claim or require new lifecycle instrumentation.

A future phase may add an event-on-finalize that records the `task finalize --audit-strict` audit result to `progress.yaml`, making the metric observable historically without git attribution. The deferral is documented in [`design/decisions/evidence-harness-v2-rfc.md` Non-goals](../../design/decisions/evidence-harness-v2-rfc.md#non-goals-out-of-scope-for-p26).

## Running it

```sh
# Default: print all six CSVs + summary.json to stdout with
# `# filename` headers. Writes nothing.
pnpm harness --corpus .

# Persist to docs/maintainers/measurements/<eight files>
pnpm harness --corpus . --write

# Machine-readable envelope (for CI dashboards)
pnpm harness --corpus . --json
pnpm harness --corpus . --write --json
```

The harness operates on any path that has a `design/` directory and (optionally) a `.code-pact/state/progress.yaml`. v1.10 / v1.12 ships baseline measurements for the dogfood corpus only.

## Byte-determinism

The harness is deterministic given the same input artifacts:

- Phase entries are sorted by `phase_id ASC` before iteration.
- Tasks within a phase are sorted by `task_id ASC`.
- The lint histogram is sorted `phase_id ASC, code ASC` and rows with `count: 0` are omitted.
- `measurements.manifest.json`'s `generated_at` is a **date only** (`YYYY-MM-DD`) — never a clock time. Running the harness twice on the same day against the same corpus SHA produces byte-identical files.

This determinism is asserted by an integration test (`tests/integration/harness.test.ts`).

## Citing rows in RFCs

Once the CSVs are committed under `docs/maintainers/measurements/`, future `design/decisions/*.md` can reference specific rows verbatim:

```markdown
> The v1.10 baseline shows P14-T5 has the largest context pack
> in the corpus at 59,346 bytes
> ([`docs/maintainers/measurements/pack-size-by-task.csv`](../../docs/maintainers/measurements/pack-size-by-task.csv)).
> A task whose pack exceeds 80KB would be an outlier worth
> reviewing for over-scope.
```

The committed CSV becomes the evidence the reader can audit. **This is the whole point** of the harness — without committable, deterministic-input CSVs, "I measured this once locally" is the same as "I felt it was bad", and we lose the move from 感覚 to evidence.

## Adding a new metric

Adding a new CSV requires a follow-up RFC amendment because the column shapes are part of the contract (other PR descriptions / decision docs may cite specific column names verbatim). The process:

1. Update `design/decisions/evidence-harness-rfc.md` with the new file's column shape under "CSV format specifications".
2. Add a new `buildXxxRow()` helper to `scripts/harness/metrics.ts` (pure, no I/O).
3. Wire it into `scripts/harness/run.ts`'s `buildHarnessOutput`, `serializeOutputs`, and the manifest's `csv_files` array.
4. Add a unit test in `tests/unit/scripts/harness/metrics.test.ts`.
5. Re-run `pnpm harness --corpus . --write` to update the committed baseline.

## What this is NOT

- **Not a public CLI command.** `code-pact harness` does not exist and will not. The harness is invoked via `pnpm harness` (a `package.json` `scripts` entry, not a `bin`).
- **Not telemetry.** Nothing is sent over the network. Nothing is collected from end users.
- **Not an OpenTelemetry / Prometheus / Grafana adapter.** Output is CSV files on disk. Period.
- **Not a trend tracker.** v1.10 ships single-snapshot CSVs only. Diffing two manifests by SHA is a manual exercise; an automated trend tool is deferred to a future RFC.
- **Not an LLM cost / latency tracker.** Out of charter — requires a model API and breaks the deterministic-input rule.
- **Not promotion-ready as a product.** If a future maintainer / fork wants to promote the harness to a public command, that requires its own RFC and a stability commitment we are deliberately not making today.
