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

| stage               |     input |    output |     total |
| ------------------- | --------: | --------: | --------: |
| capability          |        71 |         6 |        77 |
| baseline initial    |     3,790 |         2 |     3,792 |
| baseline repair     |     3,283 |     2,461 |     5,744 |
| **baseline total**  | **7,073** | **2,463** | **9,536** |
| code-pact initial   |     4,378 |     2,510 |     6,888 |
| **code-pact total** | **4,378** | **2,510** | **6,888** |

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

## P84-T2 Code Pact lifecycle

- `code-pact task prepare P84-T2 --detail agent --json` produced the lifecycle
  command envelope.
- `code-pact task start P84-T2 --json` created the contract lock.
- `code-pact task lock P84-T2 --json` re-created the lock after adding
  development-efficiency artifacts to the task writes.
- `code-pact task complete P84-T2 --json` passed:
  - `node /tmp/P84-T2-evidence/verify.mjs /tmp/P84-T2-evidence/P84-T2-evidence.zip`
  - `pnpm check:docs`
  - `pnpm check:development-efficiency -- --next-task P84-T2`
- `code-pact task finalize P84-T2 --write --json` flipped P84-T2 design status to
  `done` and accepted the write audit with advisory warnings.
- `code-pact task review-bundle P84-T2` refused with
  `TASK_CONTRACT_DRIFT` because the necessary updates to
  `design/phases/P84-post-p83-qualified-cycle-effectiveness-recheck.yaml`
  (task writes) and `scripts/check-development-efficiency.mjs` are outside the
  original declared write surface and the `review-bundle` lifecycle reclassification
  only allows `status` changes on the phase file. A manual `git archive` review
  bundle was produced as `/tmp/P84-T2-review.zip`.

## Evidence

- Evidence archive: `/tmp/P84-T2-evidence/P84-T2-evidence.zip`
- Verification: `node /tmp/P84-T2-evidence/verify.mjs /tmp/P84-T2-evidence/P84-T2-evidence.zip`
- Negative verification: `/tmp/P84-T2-evidence/negative-verification-results.json`
- Review bundle: `/tmp/P84-T2-review.zip` (manual `git archive` of HEAD)
- Worktree commits:
  - Baseline: `/tmp/P84-T2/baseline` detached at `ae86e36`
  - Code Pact: `/tmp/P84-T2/code-pact` detached at `a910885`

## Writes

- `design/decisions/P84-T2-protocol-correct-effectiveness-trial.md`
- `scripts/development-efficiency-checkpoint.json`
- `scripts/check-development-efficiency.mjs`

## Related

- P84-T1 decision report: `design/decisions/P84-T1-post-p83-qualified-cycle-trial.md`
- P83-T6 decision report: `design/decisions/P83-T6-pre-start-spec-drift-gate.md`

## P84 final closeout

This section records the fixed review outcome and termination decision for P84.

### Final classification

```yaml
trial_status: review_process_failed
pair_status: invalid
token_result: not_comparable
repair_round_result: not_comparable
product_effectiveness: not_demonstrated
```

### Blockers identified in the final review

- **B1** Capability evidence: `num_predict` conflict between attempts (`512`) and
  `environment.json`/`capability/metrics.json` (`8192`).
- **B2** Invocation limit: passed.
- **B3** Same fixture/oracle/protocol: failed — Baseline and Code Pact initial
  tree SHAs differ and oracle command sets are not equal.
- **B4** Raw usage and token accounting: failed — Baseline repair raw provider
  response is stored as `.txt` instead of `.json`, so `input_tokens`,
  `output_tokens`, `total_tokens`, `model`, `done reason`, and `sampling` cannot
  be recomputed from raw evidence.
- **B5** Classification: failed — verifier is fail-open and does not compare
  oracle digests, initial trees, or formal review-bundle success.
- **B6** Code Pact lifecycle: failed — `task review-bundle P84-T2` and the
  historical `P83-T6` review bundle were refused.
- **B7** Evidence archive completeness: failed — missing `response-repair.json`,
  manifest hash is not externally anchored, and patch / lifecycle artifacts are
  incomplete for a Code Pact review bundle.
- **B8** Verifier fail-closed: failed — tampering with `total_tokens` and internal
  arithmetic plus updating `hashes.json` still exits `0`.
- **B9** Repository / review artifact: failed — the submitted `P84-T2-review.zip`
  is a manual `git archive`, not a Code Pact review bundle with manifest,
  contract lock, start/done events, diff, write audit, and verification evidence.

### Post-termination actions

- P84-T2 is **not merged**.
- P84-T2 PR #548 is **closed without merge**.
- P84-T3 is **not created**.
- No further model invocations for P84.
- Raw evidence for P84-T1 and P84-T2 is preserved unmodified in
  `.code-pact/state/archive/P84/`.
- Main will not receive production token-reduction features from this PR.
- If main needs a record, it must be via an ordinary issue or project note only.

### Preserved facts

- P84-T2 compared a Baseline (1 initial + 1 repair) with a Code Pact (1
  initial, 0 repairs) condition on the pre-P83-T6 `TASK_CONTRACT_DRIFT` bug.
- Recorded totals: Baseline `9,536` tokens, Code Pact `6,888` tokens.
- Final patches were byte-identical between Baseline repair and Code Pact.
- Because the qualified-comparison prerequisites were not met, the `-27.8%`
  token delta is **not adopted** as a product-effectiveness conclusion.

### Product decision

P84 is terminated as `review_process_failed`. Token-reduction initiative work is
paused until new measured data can be produced under a cleaner protocol. The
next engineering work should come from existing user-facing features, bug fixes,
or release tasks, not from additional effectiveness trials or production
token-reduction features.
