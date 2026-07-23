# P84-T1: Post-P83 Qualified Cycle Effectiveness Recheck

## Summary

P84-T1 re-ran one capability-qualified Baseline versus Code Pact pair on the
pre-P83-T6 public task-start drift bug after the P81-P83 improvements. The
capability gate passed, and the Code Pact condition passed on its first
invocation with all verification and doc checks green. The Baseline condition
did not produce a valid patch within the allowed invocation limit, so the pair
is **not qualified** for token or repair-round reduction claims.

## Model identity

- Provider: Ollama 0.32.1
- Model requested: `gemma4:latest`
- Model resolved digest: `c6eb396dbd59` (short ID; full digest not exposed by `ollama show`)
- Sampling: temperature 0, top_p 0.9, num_ctx 16384, num_predict 4096/8192, seed 42
- Identity verified before every model invocation

## Scope guardrails

- Maximum model invocations per condition: 2 (1 initial + 1 repair) plus 1 capability gate
- Repairs: at most 1 per condition
- Model switching: 1 (initial `gemma3:latest`/`llama3.2:latest` blobs were missing; switched to `gemma4:latest` before the first recorded trial invocation)
- Provider switching: 0
- Corrective pass maximum: 1
- No product feature changes
- No generalization beyond the single pair

## Capability gate

- Fixture: `/tmp/P84-T1/{baseline,code-pact}/capability/status.txt` containing `wrong`
- Oracle: `capability-oracle.mjs` expects the file to contain `ready`
- Prompt mode: raw (`ollama` `raw: true`)
- Result: passed on first invocation
- Tokens: 71 input / 6 output / 77 total

## Pair comparison

### Baseline condition

- Prompt mode: raw
- Attempt 1 (system-style diff, invalid configuration): empty response, `done_reason: length`, 0 output tokens
- Attempt 2 (raw unified diff, default num_ctx): incomplete diff, `done_reason: length`, 447 output tokens, could not apply
- Attempt 3 (raw unified diff, num_ctx 16384): malformed diff, `git apply` failed at line 7
- Attempt 4 (raw full-file): placeholder output (33 tokens), no usable content
- Result: failed; no patch applied; final verification not reached

### Code Pact condition

- Prompt mode: raw; included `code-pact task prepare P83-T6` minimal task facts
- Attempt 1 (full function/file replacement markers): produced valid `src/commands/task-progress.ts`, `TASK_CONTRACT_DRIFT` case block, and updated `start` summary
- Repair rounds: 0
- Verification:
  - `pnpm typecheck`: passed
  - `pnpm test:unit tests/unit/commands/task-start.test.ts`: 22/22 passed
  - `pnpm vitest run --config vitest.integration.config.ts tests/integration/json-stdout.test.ts tests/integration/task-registration-spec.test.ts`: 66/66 passed
  - `pnpm test:integration:smoke`: passed
  - `pnpm check:docs`: passed
  - `pnpm check:development-efficiency`: passed
  - `pnpm build`: passed
- Tokens: 3395 input / 3032 output / 6427 total

## Token summary

| stage            | input | output | total |
| ---------------- | ----: | -----: | ----: |
| capability gate  |    71 |      6 |    77 |
| baseline         |  6975 |   1400 |  8375 |
| code-pact        |  3395 |   3032 |  6427 |
| **total**        | 10441 |   4438 | 14879 |

Baseline token total includes all four recorded attempts. Because the Baseline
condition never produced a valid patch, the Baseline versus Code Pact token
delta is not meaningful for reduction claims.

## Classification

- `pair_status`: `unqualified`
- `first_pass_result`: `code_pact_only` (Code Pact passed on first invocation; Baseline did not pass)
- `token_result`: `not_comparable` (Baseline never produced a valid patch)
- `repair_round_result`: `code_pact_advantage` (0 repair rounds vs Baseline failing after exceeding the repair limit)
- `failure_attribution`: `baseline_model_inability` (gemma4 8B Q4 could not produce a valid Baseline patch for this bug under the allowed limits)
- `product_effectiveness`: `not_demonstrated_single_pair`
- `artifact_integrity_status`: `passed` (Code Pact writes stayed within the declared write scope and docs regenerated cleanly)
- `review_bundle_generated`: `false`

## Notes

- The `gemma4:latest` model required `raw: true` for code generation; the chat-template path returned empty `done_reason: length` responses for code prompts.
- Baseline attempts 2 and 3 used a unified-diff output format; the model could not generate a valid `git apply`-clean diff.
- Code Pact first-pass success used a prompt that requested complete file content for `src/commands/task-progress.ts`, a `TASK_CONTRACT_DRIFT` case block for `src/cli/commands/task.ts`, and a summary string for `src/cli/spec/task.ts`.

## Evidence

- Evidence archive: `/tmp/P84-T1-evidence/P84-T1-evidence.zip`
- Archive SHA-256: computed by `verify.mjs`
- Verification: `node /tmp/P84-T1-evidence/verify.mjs /tmp/P84-T1-evidence/P84-T1-evidence.zip`
