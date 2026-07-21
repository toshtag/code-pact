# P80-T1: One-Pair Post-P79 Effectiveness Trial

## Trial status

- **Pair status:** `non_discriminating`
- **Failure attribution:** `provisional_model_output_invalid`
- **Product effectiveness:** `unevaluated`
- **Reproducibility:** `incomplete` (exact model digest recovered; however,
  `gemma3:latest` remains a mutable alias and `gpt-oss:20b` could not be
  evaluated due to local memory constraints)

## What this means

One model invocation was completed in each condition with the same model,
source, oracle, and sampling parameters. Both conditions produced the same
invalid no-op replacement (`old_text` == `new_text` == `"needle"`) and no
patch was applied or verified. A qualified pair (one condition reaching
verification) was not established, so this result cannot discriminate between
the baseline and Code Pact conditions. P79 dogfood gates were not exercised.

`model-limited` is a provisional failure-attribution label, not a product
comparison conclusion.

## Scope and intent

- Measure P78 one-shot execution and P79 immutable contract / review evidence
  on one real historical bug from the code-pact repository.
- Compare a minimal baseline against one Code Pact execution under identical
  model, source, oracle, and sampling parameters.
- Stop after one pair and classify the result honestly.
- Do not add product features or start P64, P65, P67, or P68.

## Historical bug

- **File:** `src/core/execute-once/exact-replacement.ts`
- **Description:** `countOccurrences` advances `pos` by `needle.length`, so
  overlapping occurrences of `old_text` are counted as a single match.
- **BUGGY_BASE_SHA:** `bc3f83925e984761f2548f6896591e1ba7154ae3`
- **REFERENCE_FIX_SHA:** `fc30afdf584b53509c2ea0f5633432344edee564`
- **REFERENCE_PATCH_SHA256 (trimmed fixture source):**
  `8ee980a3d597f36b0a2eb3da4e7532e32132773757f31869a0bdce2295c13623`
  (minimal `pos += needle.length;` → `pos += 1;` change)

## Fixture setup

- **Temporary directory:** `/tmp/code-pact-p80/`
- **PAIR_BASE_SHA:** `dfd7a4ca2633b02ec775af891def60b010397f1f`
- **Layout:**
  - `fixture-source/` — canonical project, includes trimmed source,
    hidden oracle, P80 task definition, and external executor wrapper.
  - `baseline-run/` and `code-pact-run/` — independent clones of
    `PAIR_BASE_SHA`.
  - `results/` — raw provider responses, prompts, metrics, and final
    summary JSON.
- **Trial evidence archive:**
  `/tmp/code-pact-p80/P80-T1-trial-evidence.zip`
  (`sha256: 6155bb1a5b1fad9c8de41d1b93e162ace399b2a87a9a1b9b5b0aaace27cf664e`)

The source file was trimmed to the `countOccurrences` function so it fit the
Code Pact 120-line one-shot eligibility limit while preserving the historical
bug. The full original source and the historical SHAs are recorded above for
audit.

## Oracle preflight

- Buggy base hidden verification: **FAIL** (`exit 1`)
- Reference patch applied to fixture source: **PASS** (`exit 0`)
- Code Pact eligibility and contract lock (`task prepare` / `task start`):
  - one declared read/write
  - read path == write path == `src/exact-replacement.ts`
  - source exists and is `<= 8192` bytes
  - verification command executable
  - working tree clean
  - contract lock digest:
    `5a5b43affd1c00a52d518d4ec2902bb1ee5c2a6409aca79e785c1528e5c75c89`

## Execution order and model identity

- **Execution order:** baseline first, then Code Pact.
- **Provider:** Ollama (local)
- **Ollama version:** `0.32.1`
- **Model requested:** `gemma3:latest`
- **Model resolved digest:**
  `a2af6cc3eb7fa8be8504abaf9b04e88f17a119ec3f04a3addf55f92841195f5a`
- **Temperature:** `0`
- **Top-p:** `0.9`
- **Max output tokens:** `2048`
- **Max invocations:** `1` per condition
- **Repair count:** `0`

`gemma3:latest` is a mutable alias; the resolved digest above captures the
manifest that was present at trial time. `gpt-oss:20b` was also available but
failed to load due to a tensor size overflow, so it could not be used as an
alternative.

## Results

### Baseline

```json
{
  "condition": "baseline",
  "input_tokens": 488,
  "output_tokens": 84,
  "total_tokens": 572,
  "wall_ms": 7804,
  "model_invocations": 1,
  "verification_count": 0,
  "verification_passed": false,
  "patch_applied": false,
  "changed_paths": [],
  "out_of_scope_write_count": null,
  "contract_drift_count": null,
  "artifact_mismatch_count": null,
  "corrective_pass_count": 0,
  "p79_dogfood_status": "not_exercised",
  "stop_reason": "runner rejected model output (old_text occurs 4 times / no-op)",
  "raw_response_kind": "replace_exact",
  "raw_response_text": "{\"kind\":\"replace_exact\",\"expected_file_sha256\":\"9039accab4499195067f4f38aca2cc321870e16573e06c3ed19c34c628cfbbe6\",\"old_text\":\"needle\",\"new_text\":\"needle\"}"
}
```

### Code Pact

```json
{
  "condition": "code_pact",
  "input_tokens": 548,
  "output_tokens": 84,
  "total_tokens": 632,
  "wall_ms": 8250,
  "model_invocations": 1,
  "verification_count": 0,
  "verification_passed": false,
  "patch_applied": false,
  "changed_paths": [],
  "out_of_scope_write_count": null,
  "contract_drift_count": null,
  "artifact_mismatch_count": null,
  "corrective_pass_count": 0,
  "p79_dogfood_status": "not_exercised",
  "stop_reason": "EDIT_REJECTED: OLD_TEXT_MULTIPLE_MATCHES",
  "raw_response_kind": "replace_exact",
  "raw_response_text": "{\"kind\":\"replace_exact\",\"expected_file_sha256\":\"9039accab4499195067f4f38aca2cc321870e16573e06c3ed19c34c628cfbbe6\",\"old_text\":\"needle\",\"new_text\":\"needle\"}"
}
```

## Token summary

- **Baseline total tokens:** 572
- **Code Pact total tokens:** 632
- **Token delta (Code Pact - baseline):** +60 tokens
- Both outputs were 84 tokens, but Code Pact's input included the task
  `done_when` and contract framing, adding 60 input tokens.
- The +60 token difference is from an unsuccessful run only; it does not
  reflect a successful verification or applied patch.

## Why this is `non_discriminating`

A discriminating pair requires at least one condition to reach patch
application and verification so the other condition can be compared against
it. Here both conditions failed at the same point: the model returned an
invalid no-op replacement with a non-unique `old_text`. Neither condition
produced an applied patch or ran the hidden oracle, so no comparison of
execution integrity is possible.

`provisional_model_output_invalid` is the failure attribution because the same
model, with the same prompt schema and source content, emitted the same
invalid JSON in both conditions. The prompt, fixture, and raw responses are
included in the trial evidence archive for independent review.

## Limitations

- The source was trimmed to the `countOccurrences` function to satisfy Code
  Pact's 120-line one-shot eligibility limit.
- The trial used a local `gemma3:latest` model. A more capable model might
  produce a valid patch, but `gpt-oss:20b` failed to load due to a tensor
  size overflow on the local workstation.
- No Code Pact finalization, phase reconcile, `ci-parity`, or `review-bundle`
  was produced because `task execute` did not reach completion.
- `contract_drift_count`, `artifact_mismatch_count`, and
  `out_of_scope_write_count` are recorded as `null` because the P79
  evidence/audit path was not exercised.

## Raw evidence

Raw prompts, provider responses, metrics, oracle results, fixture source,
executor wrapper, baseline runner, contract lock, and start event are bundled
in:

```text
/tmp/code-pact-p80/P80-T1-trial-evidence.zip
sha256: 6155bb1a5b1fad9c8de41d1b93e162ace399b2a87a9a1b9b5b0aaace27cf664e
```

No provider credentials, authentication tokens, or full prompt/response text
is committed to the repository.

## Product effect claim

**No product effect is claimed.** This single pair did not establish a usable
patch, so no conclusion about P78/P79 effectiveness can be drawn. Per the P80
plan, the result is recorded, the pair is classified as
`non_discriminating`, and the scope stops here.
