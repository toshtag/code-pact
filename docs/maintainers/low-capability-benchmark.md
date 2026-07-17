# Low-Capability Execution Benchmark

This benchmark measures provider-neutral, low-capability execution: a fixed
fixed corpus of small tasks, a deterministic evaluator, and a paired scorer that
compares an external baseline executor against the Code Pact harness.

It never calls a model API and does not hardcode a provider.

## Files

- `benchmarks/low-capability/corpus.json` — fixed corpus of five cases.
- `benchmarks/low-capability/schemas/` — JSON schemas for run manifests,
  executor results, and score summaries.
- `benchmarks/low-capability/README.md` — short benchmark overview.
- `scripts/benchmark-low-capability.mjs` — benchmark harness (prepare, evaluate,
  finalize, validate-result, score, prepare-pilot, corpus-check).
- `tests/fixtures/low-capability-benchmark/` — fixture projects, one per case.
- `tests/unit/scripts/benchmark-low-capability.test.ts` — unit tests.

## Corpus cases

| case | task type | expected outcome |
|------|-----------|------------------|
| `bounded-feature` | feature | `verified_success` |
| `regression-repair` | bugfix | `verified_success` |
| `scope-boundary` | bugfix | `verified_success` (no writes outside allowed list) |
| `decision-stop` | explicit stop | `expected_stop_success` |
| `explicit-context` | feature with context files | `verified_success` |

Each case defines:

- `task_id`
- `fixture` path
- `allowed_writes`
- `verification` commands (usually `node --test`)
- `expected_outcome`
- `requires_explicit_stop`
- `max_rounds` (3, set globally)

## Running the harness

### Validate the corpus

```sh
pnpm benchmark:low-capability:corpus-check
```

### Prepare a single run

```sh
node scripts/benchmark-low-capability.mjs prepare \
  --case bounded-feature \
  --variant baseline \
  --executor-id E1 \
  --replicate 1 \
  --output .local/benchmarks/low-capability \
  --json
```

`--variant` is `baseline` (external executor) or `code_pact` (Code Pact
lifecycle). For `code_pact`, `dist/cli.js` must exist (`pnpm build`).

### Evaluate a round

An external executor edits `workspace/` and then the harness evaluates it:

```sh
node scripts/benchmark-low-capability.mjs evaluate \
  --run <run_dir> \
  --round 1 \
  --json
```

Round results are written to `<run_dir>/rounds/round-N.json` and the latest
aggregate to `<run_dir>/result.json`.

### Import telemetry

After an executor reports token/cost metadata, import it:

```sh
node scripts/benchmark-low-capability.mjs finalize \
  --run <run_dir> \
  --telemetry telemetry.json \
  --json
```

`telemetry.json` format:

```json
{
  "schema_version": 1,
  "input_tokens": 100,
  "output_tokens": 50,
  "billed_amount": 0.001,
  "currency": "USD",
  "manual_intervention_count": 0
}
```

`manual_intervention_count > 0` excludes the run from paired scoring.

### Score paired runs

```sh
node scripts/benchmark-low-capability.mjs score \
  --results <results_root> \
  --json
```

It pairs baseline and `code_pact` runs by case, executor, replicate, fixture
digest, and task contract digest, then emits a score summary to
`<results_root>/score-summary.json`.

### Pilot runs

Generate manifests for a staged pilot (e.g. two executors, one replicate each):

```sh
node scripts/benchmark-low-capability.mjs prepare-pilot \
  --executors E1,E2 \
  --replicates 1 \
  --output .local/benchmarks/low-capability/pilot-v1 \
  --json
```

This creates 20 run manifests (5 cases × 2 variants × 2 executors) and a
`pilot-plan.json`. Executing Stage A before Stage B lets the harness use early
stopping if Stage A does not meet the safety gate.

## Safety and determinism

- Each run gets a content-derived `run_id` and a fresh workspace copy.
- The base fixture state is committed to git so `git diff` can compute exactly
  which files changed.
- Writes outside the case `allowed_writes` list are counted as scope violations
  and downgrade the result to `verification_failed`.
- If a round produces the same failure fingerprint as the previous round, the
  next round is classified as `stop_repeated_failure`.
- `max_rounds` is 3; requesting a round beyond 3 yields `stop_max_rounds`.

## Adding a new case

1. Add a directory under `tests/fixtures/low-capability-benchmark/` with a
   complete Node project, `.code-pact/` project and agent profile, design files,
   and tests.
2. Add a case object to `benchmarks/low-capability/corpus.json`.
3. Run `pnpm benchmark:low-capability:corpus-check`.
4. Add a unit test in `tests/unit/scripts/benchmark-low-capability.test.ts`.

## Maintenance scripts

- `pnpm benchmark:low-capability:corpus-check` — corpus validation.
- `pnpm test:unit -- tests/unit/scripts/benchmark-low-capability.test.ts` —
  unit tests for the harness.
