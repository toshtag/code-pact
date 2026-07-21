# P80-T2: Qualified One-Pair Effectiveness Trial

## Summary

P80-T2 added a capability gate before a one-pair comparison of a local
`gemma3:latest` model against the same bug. The model passed the capability
gate, the baseline condition, and the Code Pact condition on the first
invocation each. The pair is therefore `qualified`, but the single-pair signal
is not a Code Pact advantage:

- `first_pass_result`: `tie` (both conditions passed)
- `token_result`: `code_pact_overhead` (Code Pact used 36 more tokens, +8.33%)
- `p79_dogfood_status`: `failed` (review bundle refused with `TASK_CONTRACT_DRIFT`)
- `artifact_integrity_status`: `not_evaluated` (review bundle not generated)
- `product_effectiveness`: `not_demonstrated_single_pair`

## Model identity

- Provider: Ollama 0.32.1
- Model requested: `gemma3:latest`
- Model resolved digest: `a2af6cc3eb7fa8be8504abaf9b04e88f17a119ec3f04a3addf55f92841195f5a`
- Sampling: temperature 0, top_p 0.9, max output tokens 512
- Identity was verified before every model invocation.

## Scope guardrails

- Maximum model invocations: 3 (capability gate, baseline, Code Pact)
- Repairs: 0
- Model switching: 0
- Provider switching: 0
- Corrective pass maximum: 1
- No product feature changes
- No generalization beyond the single pair

## Capability gate

- Fixture: `src/status-label.ts` returning `"wrong"`
- Oracle: `capability-oracle.mjs` expects `statusLabel()` to return `"ready"`
- Result: passed on first invocation
- Tokens: 319 input / 90 output / 409 total

## Pair comparison

- Fixture: `src/is-even.ts` with `return value % 2 === 1;`
- Oracle: `hidden-oracle.mjs` tests `isEven(2)=true`, `isEven(3)=false`, `isEven(0)=true`, `isEven(-1)=false`
- Reference patch: change `=== 1` to `=== 0`
- Baseline result: passed on first invocation (338 input / 94 output / 432 total)
- Code Pact result: passed on first invocation (362 input / 106 output / 468 total)

## Token summary

| stage           | input | output | total |
| --------------- | ----: | -----: | ----: |
| capability gate |   319 |     90 |   409 |
| baseline        |   338 |     94 |   432 |
| code-pact       |   362 |    106 |   468 |
| **total**       |  1019 |    290 |  1309 |

Pair delta: Code Pact - Baseline = +36 tokens (+8.33%).

## Classification

- `pair_status`: `qualified`
- `first_pass_result`: `tie`
- `token_result`: `code_pact_overhead`
- `failure_attribution`: `none`
- `product_effectiveness`: `not_demonstrated_single_pair`
- `p79_dogfood_status`: `failed`
- `contract_drift_count`: `1`
- `artifact_mismatch_count`: `null`
- `artifact_integrity_status`: `not_evaluated`
- `review_bundle_generated`: `false`

Both conditions passed on the first invocation. Code Pact used 36 more model
tokens than the baseline. P79 review evidence generation failed with contract
drift. This single pair therefore shows no success advantage and contains token
and artifact-integrity regression signals. It must not be classified as
promising, and no generalization is made.

## P79 and lifecycle anomalies

- `dependency_conformance`: `failed`. The planned P80-T2 dependency on P80-T1
  was omitted from the locked task contract (`depends_on: []`), and P80-T2 was
  recorded done before P80-T1 was started. Historical locks and events were not
  rewritten.
- `p79_dogfood_status`: `failed` at both the top-level and the Code Pact
  condition level. `p79_failures` is structured as:
  - `fixture_P80-C2` / `finalize` / `TASK_WRITES_AUDIT_DECLARED_UNUSED`
  - `fixture_P80-C2` / `review_bundle` / `FIXTURE_CLASSIFIER_UNAVAILABLE`
  - `main_P80-T2` / `review_bundle` / `TASK_CONTRACT_DRIFT`
- `contract_drift_count`: `1` (the main P80-T2 `TASK_CONTRACT_DRIFT`)
- `scope_audit_failure_count`: `1` (the fixture P80-C2 `TASK_WRITES_AUDIT_DECLARED_UNUSED`)
- `classifier_unavailable_count`: `1` (the fixture P80-C2 `review_bundle` missing `scripts/verification-scope.mjs`)
- `artifact_mismatch_count`: `null`; `artifact_integrity_status`: `not_evaluated`;
  `review_bundle_generated`: `false`.
- Lifecycle event evidence: `start-event.yaml` (P80-C2 `started`) and
  `done-event.yaml` (P80-C2 `done`) are present with correct time order.
- Per protocol, writes were not expanded after the gate failure.

## Code Pact condition notes

The P80-C2 `task execute` applied the correct patch and the hidden oracle
passed. Fixture-repo phase-file writes (the `design/phases/*.yaml` mutation
done by `task finalize`) conflicted with the fixture's declared write surface,
so the P80-C2 finalize/review-bundle steps were not completed inside the
fixture. This is recorded as an experimental limitation and does not affect
the qualified pair classification.

## Evidence

- Evidence archive: `/tmp/code-pact-p80-t2/P80-T2-trial-evidence.zip`
- Archive SHA-256: `0d94e463779f8cf363c4a526696023c9e7ab42072035b14423dff6a4ba4adc18`
- Verification: `node scripts/experiments/verify-p80-t2-evidence.mjs /tmp/code-pact-p80-t2/P80-T2-trial-evidence.zip`
- Negative verifier evidence: `negative-verifier-results.json` and `verifier-negative-log.txt`; 14/14 cases rejected.

## Writes

- `design/decisions/P80-T2-qualified-one-pair-trial.md`
- `scripts/experiments/verify-p80-t2-evidence.mjs`

## Related issues

- P79 lifecycle issue: <https://github.com/toshtag/code-pact/issues/543>
- Dependency omission issue: <https://github.com/toshtag/code-pact/issues/544>
