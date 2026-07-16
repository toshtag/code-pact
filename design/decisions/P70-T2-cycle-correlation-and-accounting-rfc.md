# Cycle Correlation and Accounting

**Status:** superseded
**Superseded by:**
- P71-T1 Observable Output Semantics
- P71-T2 Cycle Lifecycle and Bounded Storage
- P72-T1 Metric Self-Observation Closure

Historical note: this ADR is retained as the P70-T2 record, but P71/P72 define
the current runtime contract.

**Scope:** define opt-in cycle tracking, correlation, byte accounting, and
hard retention before retrieval and metrics runtime work begins.
**Owners:** maintainer
**Related:** `P70-T1-recall-aggregation-boundary-rfc.md`

## Decision

Cycle accounting is explicit opt-in. Default command behavior remains byte
identical: no extra output fields, no extra flags in suggested commands, and no
metrics writes.

Tracking starts only when a caller requests it, initially through:

```text
code-pact task prepare <task-id> --track-cycle --json
```

The response returns an opaque local reference:

```json
{
  "cycle_ref": "cycle:sha256:<64 lowercase hex>"
}
```

Follow-up commands may carry it explicitly:

```text
task context ... --cycle-ref <ref>
task complete ... --cycle-ref <ref>
context show ... --cycle-ref <ref>
evidence show ... --cycle-ref <ref>
memory recall ... --cycle-ref <ref>
```

No command infers a cycle from task id, fingerprint, latest open cycle, or
timestamp proximity. Missing or unknown refs make that invocation untracked for
metrics and must not change its correctness behavior.

## Cycle Ref

The cycle ref:

- is not the task id
- distinguishes repeated attempts for the same task
- is local to one repository checkout
- is opaque
- contains no username, hostname, absolute path, or PID
- is propagated only by explicit command arguments
- is never required for normal command success

## Agent-Visible Emission Model

The old fixed additive formula is retired. The metric is:

```text
task_total_agent_input_bytes =
sum(event.returned_bytes for all tracked agent-visible emission events)
```

Event categories are:

- `task_prepare`
- `task_context`
- `deferred_context_retrieval`
- `evidence_retrieval`
- `memory_retrieval`
- `verification_failure`
- `verification_success`
- `control_metadata`

Rules:

- Count the first failure envelope.
- Count every repeated failure envelope.
- Count `prior_local_signal` only as bytes inside its failure envelope.
- Count repeated retrieval or context commands every time they return bytes.
- Returning a reference does not count artifact body bytes.
- Count retrieval bytes only when the CLI returns the body.
- Do not infer direct filesystem reads.
- Mark `unobserved_external_read: true` when known untracked reads may exist.
- Source of truth is the actual UTF-8 stdout bytes, including trailing newline.

## Completion Semantics

Cycle reports distinguish:

- `complete`
- `incomplete`
- `abandoned`

The value may be called `task_total_agent_input_bytes` only when the cycle is
complete and `unobserved_external_read` is false. Otherwise reports use
`observed_agent_input_bytes`.

## Metrics Store and Retention

Cycle metrics live under:

```text
.code-pact/cache/cycle-metrics/v1/
```

Initial hard limits:

```text
MAX_CYCLES = 256
MAX_TOTAL_BYTES = 2 MiB
MAX_CYCLE_BYTES = 32 KiB
MAX_EVENTS_PER_CYCLE = 64
MAX_CYCLES_PER_TASK = 8
MAX_AGE_DAYS = 90
```

Retention order:

1. older than 90 days
2. per-task over 8 cycles
3. per-cycle over 64 events
4. global over 256 cycles
5. global over 2 MiB

The current tracked cycle is protected while converging all hard limits as far
as possible. Corrupt records are reported, not auto-deleted. Metrics write or
retention failure does not change the original command result. Missing metrics
store leaves normal command behavior unchanged.

The store uses loop-memory-equivalent path containment, atomic write, bounded
read, canonical UTF-8 JSON, Git tracking doctor detection, and an explicit
status/prune surface. P66-T1 decides whether that surface is integrated into
`memory status/prune` or exposed as a nested cost status/prune command.
