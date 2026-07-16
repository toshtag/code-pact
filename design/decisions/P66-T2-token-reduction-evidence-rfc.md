---
status: accepted
task: P66-T2
---

# P66-T2 Token Reduction Evidence and Model-Independence Decision

## Context

P63-T1 decided to treat token-reduction signals as a bounded, exact-match advisory
rather than a semantic inference engine. P66 was chartered to measure the
overhead of those signals using a deterministic, closed harness running the
built Code Pact CLI against fixed fixtures.

## Closed-harness byte evidence

The harness was run in a controlled environment with no model API calls and no
network traffic. It exercised five deterministic scenarios:

| scenario                   | total_code_pact_stdout_bytes | command_count | verification_count | failure_count | context_retrieval_count | evidence_retrieval_count | prior_signal_count |
| -------------------------- | ---------------------------- | ------------- | ------------------ | ------------- | ----------------------- | ------------------------ | ------------------ |
| first_pass_success         | 839                          | 2             | 1                  | 0             | 0                       | 0                        | 0                  |
| failure_repair_success     | 2224                         | 3             | 2                  | 1             | 0                       | 0                        | 0                  |
| repeated_failure_success   | 3602                         | 4             | 3                  | 2             | 0                       | 0                        | 1                  |
| deferred_context_retrieval | 68536                        | 3             | 0                  | 0             | 2                       | 0                        | 0                  |
| evidence_retrieval         | 22071                        | 3             | 1                  | 1             | 0                       | 1                        | 0                  |

Key derived values:

- `signal_field_incremental_bytes`: 110
- `repeated_failure_envelope_bytes`: 1488
- `first_failure_signal_omitted`: true
- `repeat_failure_signal_present`: true
- `default_output_compatible`: true

The default-output compatibility check is fail-closed: the harness parses the
JSON error envelope, requires `ok === false`, requires the envelope to be a
verification failure, and asserts that `data.prior_local_signal` is absent when
`--detail agent` is not supplied.

## Break-even avoided-repeat estimate

```text
break_even_avoided_repeat_count = ceil(110 / 1488) = 1
```

This is a synthetic, closed-harness break-even point. It does not claim that any
repeat was actually avoided, that success rates improved, or that the feature
pays off in real usage.

## Follow-up phase decisions

Because the harness is synthetic and provides no actual usage frequency data,
all follow-up phases remain **deferred**:

- **P64 deterministic aggregation**: deferred
- **P65 explicit retrieval**: deferred
- **P67 consolidation**: deferred
- **P68 backend review**: deferred

Reasons:

- Synthetic scenario hit counts are determined by fixture design, not by real
  frequency.
- The closed harness does not prove storage pressure.
- There is no measured evidence that retrieval avoids a retry in practice.

P55 is **not started**.

## Low-capability model compatibility

### Product requirement

Code Pact must not depend on a high-capability model inferring omitted execution
steps, hidden constraints, or unstated completion conditions. Lower-cost models
are the default execution target for tasks that satisfy the deterministic
readiness contract.

### Currently demonstrated

- Code Pact can bound and measure its own CLI output.
- Exact repeated failures can be surfaced without semantic inference.
- Task state, next action, commands, and verification are provided in a
  structured form.

### Not yet demonstrated

- First-pass verification pass rate of a low-cost model on a fixed task corpus.
- Repair-round reduction compared to a baseline.
- Reduction in out-of-scope edits.
- Whether exact-match signals change model behavior.
- Stability across arbitrary models and arbitrary tasks.

This ADR therefore does **not** claim that Code Pact is model-independent or that
it works with any model.

### Deterministic readiness contract

A task may be handed to a lower-cost default executor only when all of the
following hold:

1. `requires_decision` is resolved.
2. All declared dependencies are done.
3. The objective is single and bounded.
4. Declared writes are finite and explicit.
5. Execution commands are generated deterministically.
6. Verification commands are executable.
7. Completion conditions are machine-verifiable.
8. Repair attempts are bounded.
9. A stop/change contract exists for repeated failure fingerprints.
10. Required context fits the budget or can be retrieved explicitly.

If any condition is not met, the system must not ask the model to infer the gap.
Instead it returns one of:

- `decompose_task`
- `resolve_decision`
- `retrieve_context`
- `stop_repeated_failure`
- `escalate_model`

### Escalation policy

High-capability models are **not** a default requirement. They are only an
escalation candidate under explicit conditions:

- unresolved architectural decision
- scope cannot be deterministically decomposed
- same failure fingerprint persists after bounded repairs
- required context cannot be selected deterministically
- conflicting acceptance criteria

When escalation is unavailable, the system stops rather than continue with an
unverified implementation.

### Loop policy

The default loop is:

```text
prepare
→ execute one bounded change
→ deterministic verify
→ classify result
→ repair / retrieve / stop
```

The following are prohibited:

- unbounded self-reflection
- standing review by additional agents
- unlimited retry against the same failure fingerprint
- injecting the entire memory store into initial context

### Memory policy

- Prefer exact match first.
- Retrieve explicitly only when needed.
- Keep local, bounded, and disposable.
- Do not use semantic inference as a correctness mechanism.

## Future evidence required

A separate benchmark, run outside Code Pact itself, should eventually compare a
fixed small task corpus between baseline instructions and Code Pact instructions
on the cheapest available model. Metrics to record:

- first-pass verification pass rate
- repair round count
- out-of-scope write rate
- same-fingerprint repeat count
- input/output token count
- total cost per completed task

Code Pact will not call model APIs itself; an external runner will pass the
summary into Code Pact as evidence.

## Evidence validation correction

After the original P66-T2 decision, P66-T1C corrected the
default-output validator so that only `VERIFICATION_FAILED` is accepted,
even when another error envelope contains a `data` object.

P66-T1C also ensured that cleanup failure cannot replace the primary
harness setup error.

The closed harness and required verification were rerun after this
correction. The decision outcomes remain unchanged.

## Final decision

- Closed-harness byte evidence: **accepted**
- P63 exact-match signal: **retained as bounded advisory**
- P64: **deferred**
- P65: **deferred**
- P67: **deferred**
- P68: **deferred**
- Low-capability model stability: **required product objective, not yet
  empirically demonstrated**
- High-capability model requirement: **rejected as a default assumption**
- Next product direction: reduce inference through deterministic readiness,
  verification, bounded repair, exact next actions, and explicit escalation gates.
