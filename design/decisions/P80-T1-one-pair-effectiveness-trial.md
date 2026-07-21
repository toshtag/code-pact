# P80-T1: One-Pair Post-P79 Effectiveness Trial

## Status

**Classification:** `model-limited`

The one-pair trial completed with oracle preflight passing, but the chosen local
model did not produce a usable patch in either the baseline or the Code Pact
condition. No product feature was added. P64, P65, P67, and P68 were not
started.

## Scope and intent

- Measure P78 one-shot execution and P79 immutable contract / review evidence
  on one real historical bug from the code-pact repository.
- Compare a minimal baseline against one Code Pact execution under identical
  model, source, oracle, and sampling parameters.
- Stop after one pair and classify the result honestly.

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
  - `results/` — raw provider responses, prompts, and metrics.

The source file was trimmed to the `countOccurrences` function so it fit the
Code Pact 120-line eligibility limit while preserving the historical bug.

## Oracle preflight

- Buggy base hidden verification: **FAIL** (`exit 1`)
- Reference patch applied to fixture source: **PASS** (`exit 0`)
- Code Pact eligibility (`task prepare` + `task start`):
  - one declared read/write
  - read path == write path == `src/exact-replacement.ts`
  - source exists and is `<= 8192` bytes
  - verification command executable
  - working tree clean

## Model and sampling configuration

- **Provider:** Ollama (local)
- **Model:** `gemma3:latest`
- **Region:** local
- **Temperature:** `0`
- **Top-p:** `0.9`
- **Max output tokens:** `2048`
- **Max invocations:** `1`
- **Repair count:** `0`

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
  "out_of_scope_write_count": 0,
  "contract_drift_count": 0,
  "artifact_mismatch_count": 0,
  "corrective_pass_count": 0,
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
  "out_of_scope_write_count": 0,
  "contract_drift_count": 0,
  "artifact_mismatch_count": 0,
  "corrective_pass_count": 0,
  "stop_reason": "EDIT_REJECTED: OLD_TEXT_MULTIPLE_MATCHES",
  "raw_response_kind": "replace_exact",
  "raw_response_text": "{\"kind\":\"replace_exact\",\"expected_file_sha256\":\"9039accab4499195067f4f38aca2cc321870e16573e06c3ed19c34c628cfbbe6\",\"old_text\":\"needle\",\"new_text\":\"needle\"}"
}
```

## Classification

`model-limited`

Both the baseline and the Code Pact condition established a single model
invocation with the same `gemma3:latest` model and identical source content.
Both rejected the model's output because the model returned a no-op
replacement (`old_text` == `new_text` == `"needle"`) that also occurred
multiple times in the source. No patch was applied and no hidden verification
ran in either condition.

Because the failure is attributable to the model's inability to emit a valid
exact-replacement JSON response, the trial is classified as `model-limited`
per the P80 stop condition. P79 dogfood conditions (finalize strict audit,
`outside_declared`, `declared_unused`, review bundle) could not be fully
exercised because `task execute` did not complete.

## Token summary

- **Baseline total tokens:** 572
- **Code Pact total tokens:** 632
- **Token delta (Code Pact - baseline):** +60 tokens
- Both outputs were 84 tokens, but Code Pact's input included the task
  `done_when` and contract framing, adding 60 input tokens.

## Limitations

- The source was trimmed to the `countOccurrences` function to satisfy Code
  Pact's 120-line one-shot eligibility limit.
- The trial used a local `gemma3:latest` model. A more capable model might
  produce a valid patch, but that would exceed the available low-cost local
  capacity (`gpt-oss:20b` failed to load due to a tensor size overflow).
- No Code Pact finalization, phase reconcile, `ci-parity`, or `review-bundle`
  was produced because `task execute` did not reach completion.
- No out-of-scope writes, contract drift, or artifact mismatch occurred in
  either condition because no patch was applied.

## Raw evidence

`/tmp/code-pact-p80/results/`

Files include:

- `baseline-prompt.txt`
- `baseline-ollama-response.json`
- `code-pact-prompt.txt`
- `code-pact-ollama-response.json`
- `code-pact-metrics.json`
- `P80-final-metrics.json`

No provider credentials or full prompt/response text is committed to the
repository.

## Product effect claim

**No product effect is claimed.** This single pair did not establish a usable
patch, so no conclusion about P78/P79 effectiveness can be drawn. Per the P80
plan, the result is recorded and the scope stops here.
