# Low-Capability Execution Evidence Benchmark

A provider-neutral, model-API-free harness for measuring whether Code Pact
improves verified completion, bounded repair, scope discipline, and token
efficiency for lower-cost executors.

## Purpose

This benchmark compares a baseline executor instruction with a Code Pact variant
for the same task contract, fixture, verification commands, and round budget.
Code Pact does not call any model API; external executor evidence is imported and
validated deterministically.

## What is included in P73-T1

- Fixed five-case corpus (`corpus.json`).
- JSON schemas for run manifests, executor results, and score summaries.
- Paired baseline / Code Pact run preparation.
- Deterministic verification, scope scoring, and repeated-fingerprint stopping.
- External token/cost telemetry import.
- Result validation and paired scoring.
- No model or network integration.

## What is NOT included

- Model execution.
- Provider SDKs or pricing tables.
- Production CLI behavior changes.
- P64 / P65 / P67 / P68, Stable Core, or Task Delta implementations.
- Benchmark claims or product claims.

## Usage

```bash
# Validate the corpus and fixtures
pnpm check:low-capability-corpus

# Prepare a single run
pnpm benchmark:low-capability prepare \
  --case bounded-feature \
  --variant baseline \
  --executor-id E1 \
  --replicate 1 \
  --output .local/benchmarks/low-capability

# Evaluate one round (after the executor has modified the workspace)
pnpm benchmark:low-capability evaluate \
  --run .local/benchmarks/low-capability/<run-id> \
  --round 1

# Import executor telemetry
pnpm benchmark:low-capability finalize \
  --run .local/benchmarks/low-capability/<run-id> \
  --telemetry executor-telemetry.json

# Score paired runs
pnpm benchmark:low-capability score \
  --results .local/benchmarks/low-capability
```

See `docs/maintainers/low-capability-benchmark.md` for the full contract.
