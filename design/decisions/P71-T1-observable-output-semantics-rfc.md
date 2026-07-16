# Observable Output Semantics

**Status:** accepted (P71-T1, 2026-07)
**Scope:** define what cycle metrics can measure before runtime tracking begins.
**Owners:** maintainer
**Related:** P66, P70-T2

## Decision

Cycle metrics measure Code Pact CLI stdout emission, not total Agent input.

The only normal-runtime summable byte metric is:

```text
observed_code_pact_stdout_bytes
```

It is the sum of exact UTF-8 bytes that Code Pact CLI generated for stdout
during a tracked cycle.

Reports must include:

```json
{
  "measurement_scope": "code_pact_cli_stdout",
  "observed_code_pact_stdout_bytes": 12345,
  "external_input_unobserved": true
}
```

Normal CLI runtime must not set `external_input_unobserved` to `false`.

## Non-Claims

`observed_code_pact_stdout_bytes` is not:

- actual provider token usage
- bytes definitely read by an Agent or IDE
- bytes read directly from repository files
- shell, editor, browser, or external tool output
- automatically injected runtime context
- human-provided context
- total task input bytes

The retired names `task_total_agent_input_bytes`,
`observed_agent_input_bytes`, and `returned_bytes` must not be used for P66
runtime contracts.

## Closed Harness

`measurement_scope: "closed_harness"` is reserved for a dedicated measurement
environment that controls every Agent input path. Normal Code Pact CLI commands
must not self-report closed-harness measurement.

A closed harness must at least ensure:

- Agent input is limited to Code Pact output.
- Direct filesystem reads are disabled or measured by the harness.
- External tool output is disabled or measured by the harness.
- Every measured command propagates the same cycle ref.
- The procedure is reproducible.

P55 may compare closed-harness totals with normal runtime measurements, but it
must not treat normal runtime stdout bytes as total Agent input.

## Emission Events

One CLI invocation that produces stdout contributes to exactly one summable
emission event. The closed set of summable categories is:

```text
task_prepare
task_context
context_retrieval
evidence_retrieval
memory_retrieval
task_complete_success
task_complete_failure
verify_success
verify_failure
task_control
```

`control_metadata` is not a summable category. Fields such as `cycle_ref` and
`prior_local_signal` are components of the single stdout event that contains
them. They must not be recorded as independent additive events.

P72 removes cycle reports from the summable set. `memory cost` and maintenance
commands are read-only observation surfaces for the target cycle.

Optional component breakdown is diagnostic only:

```json
{
  "components": {
    "prior_local_signal_bytes": 120,
    "cycle_metadata_bytes": 96
  }
}
```

Component bytes are never re-added to the total.

## Byte Source

An emission event uses the exact serialized stdout string:

```ts
Buffer.byteLength(serializedStdout, "utf8")
```

The value is named:

```text
emitted_bytes
```

The measured string includes the JSON envelope, human output, raw sections,
artifact content, and a trailing newline only when that newline is actually
written to stdout.

The measurement helper must receive the final serialized output. It must not
re-serialize a parsed object for measurement.

## Repetition

If the same command is run twice and Code Pact produces stdout twice, the cycle
records two emission events. A reference to an artifact does not count the
artifact body; the body counts only when a later invocation emits it.

## Consequences

P66 measures an observable lower-bound contribution from Code Pact CLI output.
This is weaker than total Agent input, but it is honest and reproducible. P55
must use the metric as observed stdout evidence unless it is running a closed
harness that controls the entire input path.
