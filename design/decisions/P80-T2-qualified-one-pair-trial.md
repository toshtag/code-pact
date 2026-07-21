# P80-T2: Qualified One-Pair Effectiveness Trial

## Summary

P80-T2 added a capability gate before a one-pair comparison of a local
`gemma3:latest` model against the same bug. The model passed the capability
gate, the baseline condition, and the Code Pact condition on the first
invocation each. The pair is classified `qualified` and `product_effectiveness`
`promising_single_pair`.

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

## Classification

- `pair_status`: `qualified`
- `failure_attribution`: `none`
- `product_effectiveness`: `promising_single_pair`
- `p79_dogfood_status`: `failed` (`task finalize` and `phase reconcile` passed, but `task review-bundle` refused due to `TASK_CONTRACT_DRIFT` because `design/phases/P80-post-p79-effectiveness-trial.yaml` changed outside the declared writes; per protocol writes were not expanded after the gate failure)

## Code Pact condition notes

The P80-C2 `task execute` applied the correct patch and the hidden oracle
passed. Fixture-repo phase-file writes (the `design/phases/*.yaml` mutation
done by `task finalize`) conflicted with the fixture's declared write surface,
so the P80-C2 finalize/review-bundle steps were not completed inside the
fixture. This is recorded as an experimental limitation and does not affect
the qualified pair classification.

## Evidence

- Evidence archive: `/tmp/code-pact-p80-t2/P80-T2-trial-evidence.zip`
- Archive SHA-256: `49b222b8abb7909025ce34ad32bcb57f4ff2bca8923a68e7d387b0f551536976`
- Verification: `node scripts/experiments/verify-p80-t2-evidence.mjs /tmp/code-pact-p80-t2/P80-T2-trial-evidence.zip`

## Writes

- `design/decisions/P80-T2-qualified-one-pair-trial.md`
- `scripts/experiments/verify-p80-t2-evidence.mjs`
