# Low-Capability Execution Benchmark

This benchmark measures provider-neutral, low-capability execution: a fixed
corpus of small tasks, a deterministic evaluator, and a paired scorer that
compares an external baseline executor against the Code Pact harness.

It never calls a model API and does not hardcode a provider.

## Files

- `benchmarks/low-capability/corpus.json` — fixed corpus of five cases.
- `benchmarks/low-capability/schemas/` — JSON schemas for run manifests,
  executor results, score summaries, round attestations, and executor telemetry.
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
- `objective` — explicit natural-language objective used in the executor input
- `allowed_writes` — the only files an implementation may modify
- `verification` commands (usually `node --test`)
- `expected_outcome`
- `requires_explicit_stop`

`max_rounds` (3) and `failure_feedback_max_bytes` are set globally in the
`corpus.json` top-level object.

## Running the harness

The harness uses subcommands. All subcommands support `--json` for JSON
envelopes and support the standard `--help` flag.

### Validate the corpus

```sh
pnpm check:low-capability-corpus
# or directly:
node scripts/benchmark-low-capability.mjs corpus-check --json
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

Preparation creates:

- a fresh workspace copy
- a `git` base commit
- `executor-input/` containing `task-contract.md`, `instruction.md`, and an
  `input-manifest.json` with file digests and a bundle digest
- `run-manifest.json` with `manifest_sha256`, `input_bundle_sha256`,
  `task_contract_sha256`, `fixture_digest`, and `base_commit`

A given run can only be prepared once; duplicates are rejected with
`RUN_ALREADY_EXISTS`.

### Evaluate a round

An external executor edits `workspace/`, then submits an attestation and the
harness evaluates it:

```sh
node scripts/benchmark-low-capability.mjs evaluate \
  --run <run_dir> \
  --round 1 \
  --attestation attestation.json \
  --json
```

The round attestation schema is in
`benchmarks/low-capability/schemas/round-attestation.schema.json`. Required
fields include `run_id`, `round`, `session_id`, `fresh_session_started`,
`tool_permission_class`, `action` (`implemented`, `stopped_decision`, or
`failed_to_execute`), `input_bundle_sha256`, `manual_intervention_count`, and
`context_retrieval_count`.

Round results are written to `<run_dir>/rounds/round-N.json` and the latest
aggregate to `<run_dir>/result.json`.

The round state machine enforces:

- sequential rounds only
- no re-evaluation
- no rounds beyond `max_rounds`
- same `session_id` for all rounds of a run
- round 1 must set `fresh_session_started: true`

### Import telemetry

After an executor reports token/cost metadata, import it:

```sh
node scripts/benchmark-low-capability.mjs finalize \
  --run <run_dir> \
  --telemetry telemetry.json \
  --json
```

`telemetry.json` format is defined in
`benchmarks/low-capability/schemas/executor-telemetry.schema.json`:

```json
{
  "schema_version": 1,
  "run_id": "<run_id>",
  "executor_id": "E1",
  "variant": "baseline",
  "replicate": 1,
  "session_id": "<session_id>",
  "tool_permission_class": "workspace-read-write-shell",
  "input_tokens": 100,
  "output_tokens": 50,
  "billed_amount": 0.001,
  "currency": "USD",
  "manual_intervention_count": 0
}
```

`input_tokens` and `output_tokens` may be `null`; when either is `null`,
`total_tokens` is also `null`. `manual_intervention_count > 0` marks the result
as `stop_manual_intervention`, which paired scoring rejects as malformed
evidence.

### Score paired runs

```sh
node scripts/benchmark-low-capability.mjs score \
  --results <results_root> \
  --json
```

The scorer recursively discovers manifests and results under `<results_root>`,
pairs baseline and `code_pact` runs by `(case_id, executor_id, replicate,
fixture_digest, task_contract_digest, max_rounds, tool_permission_class)`, and
emits `score-summary.json`.

The scorer is fail-closed:

- unpaired runs
- duplicate variants for a pairing key
- reused `session_id` across baseline and code_pact
- mismatched `tool_permission_class`
- `manual_intervention_count > 0`
- non-terminal or integrity-violating result files

are all rejected with a non-zero exit code.

Token efficiency uses the total tokens of **all** paired attempts (success and
failure) divided by the number of successful outcomes. If any run in an
executor group lacks token telemetry, the `token_efficiency_conclusion` is
"insufficient token evidence".

The safety gate requires:

- code_pact successful-outcome rate >= baseline rate
- code_pact scope-violation rate <= baseline rate
- code_pact unnecessary-implementation rate for `expected_stop_success` cases <=
  baseline rate

When the gate passes, `stage_b_allowed` is `true`.

### Pilot runs

Stage A prepares baseline and code_pact manifests:

```sh
node scripts/benchmark-low-capability.mjs prepare-pilot \
  --stage a \
  --executors E1,E2 \
  --replicates 1 \
  --output .local/benchmarks/low-capability/pilot-v1 \
  --json
```

Stage B requires a passing Stage A score summary:

```sh
node scripts/benchmark-low-capability.mjs prepare-pilot \
  --stage b \
  --executors E1,E2 \
  --replicates 2 \
  --output .local/benchmarks/low-capability/pilot-v1 \
  --gate-summary .local/benchmarks/low-capability/pilot-v1/stage-a/score-summary.json \
  --json
```

Stage A produces `pilot-plan.json` with all manifests. Stage B is only
generated when `score-summary.json` reports `safety_gate: pass` and
`stage_b_allowed: true`.

## Safety and determinism

- Each run gets a content-derived `run_id` and a fresh workspace copy.
- The base fixture state is committed to git so `git status` can compute exactly
  which files changed, including untracked files.
- The scope check uses `allowed_writes` from the corpus. Allowed paths may be
  exact files or directories; writes outside the allowed list are counted as
  scope violations and downgrade the result to `verification_failed`.
- The executor input bundle is content-hashed and recorded in the run manifest.
- The result binds back to the manifest through `manifest_sha256`,
  `input_bundle_sha256`, `task_contract_sha256`, `base_commit`, and
  `tool_permission_class`.
- A fresh session is required for round 1; subsequent rounds must reuse the same
  `session_id`.
- If a round produces the same failure fingerprint as the previous round, the
  next round is classified as `stop_repeated_failure`.
- `max_rounds` is 3; requesting a round beyond 3 yields `ROUND_OUT_OF_RANGE`.
- `manual_intervention_count > 0` is terminal (`stop_manual_intervention`) and
  is rejected by the scorer.

## Adding a new case

1. Add a directory under `tests/fixtures/low-capability-benchmark/` with a
   complete Node project, `.code-pact/` project and agent profile, design files,
   and tests.
2. Add a case object to `benchmarks/low-capability/corpus.json` with an
   explicit `objective`.
3. Run `pnpm check:low-capability-corpus`.
4. Add a unit test in `tests/unit/scripts/benchmark-low-capability.test.ts`.

## Maintenance scripts

- `pnpm check:low-capability-corpus` — corpus validation.
- `pnpm benchmark:low-capability <subcommand> ...` — run any harness subcommand.
- `pnpm test:unit -- tests/unit/scripts/benchmark-low-capability.test.ts` —
  unit tests for the harness.
