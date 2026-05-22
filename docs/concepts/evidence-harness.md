# Evidence harness

> code-pact v1.10+. **Maintainer tooling, not a product feature.** The harness lives at `scripts/harness/` and is invoked via `pnpm harness`. It is never registered in `package.json` `bin`, never surfaces in JSON envelopes, and never appears in `code-pact --help`.

## Why this exists

Every design decision in code-pact through v1.9 was made on qualitative judgement: "this feels safer", "this feels noisier", "this is the natural break-point". The qualitative posture carried the project through P1–P19 without major regressions, but two recent calls hit its limits — the cycle severity in P19-T2 and the strict-clean dogfood scope in P15-T3 both turned on questions that quantitative evidence could have settled deterministically.

The harness is the path out. It captures a small set of deterministic metrics from the corpus and emits CSV that future RFCs can cite as "the v1.10 baseline shows X". Move design judgement from "感覚" to "measurement", one row at a time.

See [`design/decisions/evidence-harness-rfc.md`](../../design/decisions/evidence-harness-rfc.md) for the full rationale and alternatives considered.

## What it measures

Four CSV files, plus a manifest, under `design/measurements/`:

| File | One row per | What it tells you |
| --- | --- | --- |
| `pack-size-by-task.csv` | task | The "context bandwidth" each task asks of an agent (byte count + line count + section count of the `task context` pack). Cardinalities of `reads` / `writes` / `decision_refs` / `acceptance_refs` give a sense of how richly each task is wired into the corpus. |
| `verify-success-rate.csv` | task with a `done` event | First-pass vs retry counts. Quantifies how strong verification commands are at catching real failures vs how often agents have to retry. |
| `task-event-density.csv` | task with ≥ 1 event | Progress event histogram (started / blocked / resumed / done / failed) + `event_span_days`. Quantifies how often tasks bounce vs flow linearly. |
| `lint-issue-histogram.csv` | (phase, code) pair | Count of each `plan lint --include-quality` diagnostic across the corpus. Quantifies the "noise floor" of the lint surface — a row count of 0 means the strict-clean dogfood regime is holding. |

The sibling `measurements.manifest.json` records the harness version, the corpus git SHA, the cli version, the generation date (date only, no clock time), and the CSV file list.

## Running it

```sh
# Default: print all four CSVs to stdout with `# filename` headers.
# Writes nothing.
pnpm harness --corpus .

# Persist to design/measurements/<five files>
pnpm harness --corpus . --write

# Machine-readable envelope (for CI dashboards)
pnpm harness --corpus . --json
pnpm harness --corpus . --write --json
```

The harness operates on any path that has a `design/` directory and (optionally) a `.code-pact/state/progress.yaml`. v1.10 ships baseline measurements for the dogfood corpus only.

## Byte-determinism

The harness is deterministic given the same input artifacts:

- Phase entries are sorted by `phase_id ASC` before iteration.
- Tasks within a phase are sorted by `task_id ASC`.
- The lint histogram is sorted `phase_id ASC, code ASC` and rows with `count: 0` are omitted.
- `measurements.manifest.json`'s `generated_at` is a **date only** (`YYYY-MM-DD`) — never a clock time. Running the harness twice on the same day against the same corpus SHA produces byte-identical files.

This determinism is asserted by an integration test (`tests/integration/harness.test.ts`).

## Citing rows in RFCs

Once the CSVs are committed under `design/measurements/`, future `design/decisions/*.md` can reference specific rows verbatim:

```markdown
> The v1.10 baseline shows P14-T5 has the largest context pack
> in the corpus at 59,346 bytes
> ([`design/measurements/pack-size-by-task.csv`](../measurements/pack-size-by-task.csv)).
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
