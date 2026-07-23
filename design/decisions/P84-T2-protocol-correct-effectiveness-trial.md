# P84-T2: Protocol-Correct Effectiveness Trial Rerun

## Summary

P84-T2 re-runs P84-T1 as a protocol-correct Baseline versus Code Pact pair on the
pre-P83-T6 public task-start drift bug. The P84-T1 trial was preserved as an
invalid trial; P84-T2 introduces a fixed canonical task contract, identical
generation protocol, identical source and oracle, at most one repair per
condition, and a verifier that derives its classification from the evidence
archive.

P84-T2 results:

- `pair_status`: `qualified`
- `token_result`: `code_pact_advantage` (Code Pact used 2,648 fewer model tokens)
- `repair_round_result`: `code_pact_advantage` (Code Pact 0 repairs vs Baseline 1)
- `product_effectiveness`: `not_demonstrated_single_pair`
- `p83_dogfood_status`: `review_bundle_partial` (`task review-bundle P83-T6` refused due to sibling P83-T5 `failed` state; a manual git-archive review bundle was produced)

## P84-T1 invalid reasons

P84-T1 is retained unchanged in `/tmp/P84-T1-evidence/` and is classified as
invalid for the following reasons:

- Capability gate evidence contradiction (attempt log `passed: false` while the
decision report claimed `passed: true`).
- Baseline invocation limit exceeded (4 attempts, not `1 + 1 repair`).
- Output protocol and `num_ctx` changed during the Baseline condition
(system-diff, raw-diff, `num_ctx 16384`, full-file).
- Token arithmetic mismatch between raw provider usage and the decision report.
- Incomplete Code Pact lifecycle evidence (no `task start`, `task complete`,
`task finalize`, or `review-bundle` artifacts).
- Fail-open verifier that hard-coded its result and returned exit `0` after
reporting protocol violations.

No token reduction, repair reduction, or model inability claims are carried
from P84-T1 to P84-T2.

## Model identity

- Provider: Ollama 0.32.1
- Model requested: `gemma4:latest`
- Model resolved digest: `c6eb396dbd59`
- Sampling: temperature 0, top_p 0.9, max output tokens 8192, seed 42, raw mode
- Identity was verified before every model invocation.

## Scope guardrails

- Maximum model invocations: capability 1, Baseline 1 + 1 repair, Code Pact 1 + 1
  repair, total model invocations 5 maximum.
- Repairs: Baseline 1, Code Pact 0.
- Model switching: 0.
- Provider switching: 0.
- Corrective pass maximum: 1 per condition.
- No production feature changes.
- No generalization beyond the single pair.
- Both conditions used the same base commit, fixture tests, model, sampling, and
  output marker format.

## Capability gate

- Fixture: `/tmp/P84-T2/{baseline,code-pact}/capability/status.txt` containing `wrong`
- Oracle: `capability-oracle.mjs` expects `ready\n`
- Result: passed on first invocation
- Tokens: 71 input / 6 output / 77 total

## Pair comparison

- Fixture: `src/status-label.ts` returning `"wrong"` (capability), and the
  historical pre-P83-T6 task-start `TASK_CONTRACT_DRIFT` bug.
- Allowed writes: `src/commands/task-progress.ts`, `src/cli/commands/task.ts`,
  `src/cli/spec/task.ts`, `docs/cli-reference.generated.md`.
- Oracle: hidden unit and integration tests for the task-start CLI.
- Baseline result: passed after one repair (initial response only emitted an
  opening markdown fence; repair prompt included a bounded failure capsule and
  succeeded).
- Code Pact result: passed on first invocation.

## Token summary

| stage             | input | output | total |
| ----------------- | ----: | -----: | ----: |
| capability        |    71 |      6 |    77 |
| baseline initial  | 3,790 |      2 | 3,792 |
| baseline repair   | 3,283 |  2,461 | 5,744 |
| **baseline total**| **7,073** | **2,463** | **9,536** |
| code-pact initial | 4,378 |  2,510 | 6,888 |
| **code-pact total**| **4,378** | **2,510** | **6,888** |

Pair delta: Code Pact - Baseline = -2,648 tokens (-27.8%).

Capability tokens are excluded from the pair delta per protocol.

## Classification

- `pair_status`: `qualified`
- `first_pass_result`: `code_pact_only` (Baseline required a repair, Code Pact did not)
- `token_result`: `code_pact_advantage`
- `repair_round_result`: `code_pact_advantage`
- `product_effectiveness`: `not_demonstrated_single_pair`
- `p83_dogfood_status`: `review_bundle_partial`
- `failure_attribution`: `none`
- `contract_drift_count`: 0
- `artifact_mismatch_count`: 0
- `artifact_integrity_status`: `ok`
- `review_bundle_generated`: `true` (manual git-archive bundle; `code-pact task review-bundle P83-T6` refused due to P83 phase state)

## Code Pact lifecycle

- `code-pact task prepare P83-T6 --detail minimal --json` produced the canonical
  task facts envelope.
- `code-pact task start P83-T6 --json` created the contract lock.
- The model prompt included the Code Pact `task prepare` minimal envelope, the
  same source excerpts, and the same marker protocol as the Baseline prompt.
- `code-pact task complete P83-T6 --json` ran the task verify commands and
  emitted the `done` event.
- `code-pact task finalize P83-T6 --write --json` updated the phase file and
  passed write audit (no forbidden writes in the source patch).
- `code-pact task review-bundle P83-T6 --output ...` refused because the P83
  phase contains `P83-T5` in `failed` state, so the derived phase status was
  `in_progress`. A manual `git archive` review bundle was generated and
  included as `code-pact/review-bundle.zip`.

## Evidence

- Evidence archive: `/tmp/P84-T2-evidence/P84-T2-evidence.zip`
- Verification: `node /tmp/P84-T2-evidence/verify.mjs /tmp/P84-T2-evidence/P84-T2-evidence.zip`
- Negative verification: `/tmp/P84-T2-evidence/negative-verification-results.json`
- Worktree commits:
  - Baseline: `/tmp/P84-T2/baseline` detached at `ae86e36`
  - Code Pact: `/tmp/P84-T2/code-pact` detached at `a910885`

## Writes

- `design/decisions/P84-T2-protocol-correct-effectiveness-trial.md`

## Related

- P84-T1 decision report: `design/decisions/P84-T1-post-p83-qualified-cycle-trial.md`
- P83-T6 decision report: `design/decisions/P83-T6-pre-start-spec-drift-gate.md`
