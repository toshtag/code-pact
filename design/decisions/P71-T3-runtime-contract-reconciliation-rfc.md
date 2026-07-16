# Runtime Contract Reconciliation

**Status:** accepted (P71-T3, 2026-07)
**Scope:** reconcile future runtime phases with P71-T1 and P71-T2 before
P63-T2 begins.
**Owners:** maintainer
**Related:** P55, P63, P65, P66, P68, P71-T1, P71-T2

## Decision

P72 supersedes the P71-T3 gate for P63-T2. Future runtime work must implement
the observable stdout, cycle lifecycle, and P72 execution-closure contracts
before adding exact-match recall, retrieval, or cycle metrics.

## P63

The prior-local signal field name is `exact_match_count`. The old
`prior_match_count` name is not part of the contract.

P63 automatic recall remains a minimal signal:

```json
{
  "schema_version": 1,
  "exact_match_count": 2,
  "last_observed_at": "2026-07-15T00:00:00.000Z"
}
```

Resolution aggregation remains owned by P64.

## P65

P65 exposes:

```bash
code-pact memory recall <fingerprint> --json
```

P65 does not expose:

```bash
code-pact memory recall <fingerprint> --cycle-ref <ref> --json
```

Cycle correlation is an extension point only until P66 implements the metrics
store and tracking lifecycle. P65's 4 KiB bound applies to the successful JSON
envelope plus any trailing newline actually written to stdout, not only to an
internal data object.

## P66

P66 uses these names:

```text
observed_code_pact_stdout_bytes
measurement_scope
external_input_unobserved
emitted_bytes
```

P66 does not use:

```text
task_total_agent_input_bytes
observed_agent_input_bytes
returned_bytes
control_metadata
```

The summable categories are mutually exclusive:

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

`cycle_ref`, `prior_local_signal`, and other control fields may be recorded as
component diagnostics, but they are not added separately.

Cycle report commands are read-only observation surfaces for the target cycle
and are not summable events on that cycle.

P66-T2 scope includes the actual CLI serialization layer:

- `src/cli/util.ts`
- `src/cli/commands/task.ts`
- `src/cli/commands/context.ts`
- `src/cli/commands/evidence.ts`
- `src/cli/commands/memory.ts`
- `src/cli/spec/task.ts`
- `src/cli/spec/context.ts`
- `src/cli/spec/evidence.ts`
- `src/cli/spec/memory.ts`
- `docs/cli-contract.md`
- `docs/cli-reference.generated.md`
- `tests/unit/cli/spec-render.test.ts`
- `tests/integration/json-stdout.test.ts`

The implementation should measure the final serialized stdout once:

```ts
emitTrackedStdout({
  serialized,
  cycleRef,
  category,
});
```

Metrics failure must not change the serialized stdout.

## Cycle Reports

P66-T5 reports one cycle by ref:

```bash
code-pact memory cost <cycle-ref>
```

Task query lists retained summaries:

```bash
code-pact memory cost --task <task-id>
```

Task query does not choose the latest cycle and does not aggregate cycles with
different lifecycle states.

## P55

P55 separates:

- `observed_code_pact_stdout_bytes`
- closed-harness controlled totals
- unobserved external input
- complete cycles
- incomplete, truncated, and abandoned cycles

Normal runtime stdout evidence is not total task input evidence.

## P68

Cold benchmark means the first measured invocation in a fresh Node process with
a fresh temporary project/store. Warm benchmark means 20 warm-up runs followed
by 200 measured runs in the same process and store.

The benchmark does not require OS page-cache clearing and must not claim a
fully cold filesystem cache unless the harness explicitly proves it.

## Future Runtime Tests

P66 runtime implementation must cover:

- no byte changes when tracking is disabled
- `--track-cycle` without `--json` rejected
- `--track-cycle --dry-run` rejected
- non-runnable prepare creates no cycle
- store failure returns no cycle ref
- unknown cycle refs do not alter the main command result
- one stdout invocation records one summable event
- control metadata is not double counted
- prior-local signal bytes are counted only within the failure stdout event
- raw context and Evidence content bytes include the exact emitted newline
- repeated retrieval invocations count repeatedly
- event 65 and later preserve cumulative totals
- retained detail events stay at or below 64
- cycle records stay at or below 32 KiB
- active cycles also obey per-cycle byte caps
- task query does not choose the latest cycle
- cycle-ref query returns one cycle
- normal runtime reports `external_input_unobserved: true`
- P65 has no no-op cycle tracking flag
- cold and warm benchmark definitions are reproducible

## Consequences

P63-T2 can start only after P72-T4, so it does not inherit unobservable
total-input claims, no-op public flags, ambiguous cycle reports, incomplete
lifecycle coverage, or impossible active-cycle retention semantics.
