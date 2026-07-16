# Metric Observation Boundary

**Status:** accepted (P72-T1, 2026-07)
**Scope:** close metric self-observation and supersede conflicting P70 byte
accounting language before runtime work begins.
**Owners:** maintainer
**Related:** P70-T2, P71-T1, P71-T3

## Decision

Cycle report and maintenance commands are observation surfaces. They do not
write to the target cycle they inspect.

The following commands must not update cycle metrics for the target cycle:

```text
memory cost
cycle metrics status
cycle metrics prune
memory status
memory prune
doctor
```

`code-pact memory cost <cycle-ref>` reads one cycle and returns a report. It
does not change that cycle's:

- `observed_code_pact_stdout_bytes`
- `total_event_count`
- `retained_event_count`
- `updated_at`

Running the same report twice must return the same target-cycle measurement
state unless some other tracked command updated the cycle between reports.

## Summable Categories

`cycle_report` is not a summable category.

The final summable categories are:

```text
task_prepare
task_control
task_context
verify_success
verify_failure
context_retrieval
evidence_retrieval
memory_retrieval
task_complete_success
task_complete_failure
```

`task_control` covers small lifecycle commands:

```text
task start
task resume
task block
task record-done
```

`task finalize` is governance after the implementation cycle closes and is not
part of P66 task-cycle measurement.

## Observer Cycle

If report-output cost ever needs to be measured, it requires a separate
observer-cycle contract that explicitly records the report stdout on a different
cycle. P72 does not reserve or implement that behavior.

## Supersession

P70-T2 is superseded by P71-T1, P71-T2, and P72-T1. Its text remains as a
historical record, but the current contract uses:

- `observed_code_pact_stdout_bytes`, not `task_total_agent_input_bytes`
- `emitted_bytes`, not `returned_bytes`
- non-overlapping emission categories, not `control_metadata`
- report observation as read-only, not a summable event on the target cycle

## Retained Exact Match Count

P63's `exact_match_count` is the number of matching valid episodes currently
retained in the bounded local store. It is not a lifetime occurrence count. The
signal shape remains:

```json
{
  "schema_version": 1,
  "exact_match_count": 2,
  "last_observed_at": "2026-07-15T00:00:00.000Z"
}
```

## Consequences

Cycle cost reporting becomes stable: observing a cycle does not mutate the
cycle being observed, and repeated reports do not inflate the measured cycle.
