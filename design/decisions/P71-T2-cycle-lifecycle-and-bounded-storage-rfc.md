# Cycle Lifecycle and Bounded Storage

**Status:** accepted (P71-T2, 2026-07)
**Scope:** define cycle tracking lifecycle, report identity, and bounded active
cycle storage before P66 runtime work begins.
**Owners:** maintainer
**Related:** P66, P70-T2, P71-T1

## Tracking Start

The public tracking start contract is:

```bash
code-pact task prepare <task-id> --track-cycle --json
```

`--track-cycle` requires `--json`.

The following are `CONFIG_ERROR`:

```bash
code-pact task prepare P1-T1 --track-cycle
code-pact task prepare P1-T1 --track-cycle --dry-run --json
```

Dry-run does not write state, so it cannot create a usable cycle ref.

## Cycle Creation

A cycle is created only when `task prepare` successfully produces a runnable
context result. No cycle is created for:

- already done tasks
- blocked tasks
- decision-required tasks that cannot run
- unmet dependencies
- configuration failure
- context generation failure
- dry-run

When tracking was requested but no cycle starts, JSON tracking mode returns an
additive result only:

```json
{
  "cycle_tracking": {
    "requested": true,
    "started": false,
    "reason": "task_not_runnable"
  }
}
```

## Store Failure

Failure to create or update the cycle store does not change the original
command result or exit code. Tracking mode adds a warning and returns no cycle
ref:

```json
{
  "cycle_tracking": {
    "requested": true,
    "started": false,
    "warning": {
      "code": "CYCLE_TRACKING_UNAVAILABLE",
      "affects_exit": false
    }
  }
}
```

## Cycle Ref

Cycle refs are opaque local identifiers:

```text
cycle:sha256:<64 lowercase hex>
```

The canonical payload used to derive the hash includes a cryptographically
random local nonce. It must not be derived from task id alone. It must not
include username, hostname, absolute path, or PID. Cycle records are local,
ignored by Git, and not portable between repositories.

## Follow-Up Ref

P65 does not expose `--cycle-ref`.

P66 adds optional `--cycle-ref <ref>` at the same time as metrics runtime for:

- `task context`
- `task complete`
- `context show`
- `evidence show`
- `memory recall`

Unknown refs, refs from another repository, and refs that were pruned must not
change the main command correctness result or exit code. JSON mode adds:

```json
{
  "cycle_tracking_warning": {
    "code": "CYCLE_REF_NOT_FOUND",
    "affects_exit": false
  }
}
```

Human and raw modes write a short warning to stderr and must not mix the warning
into stdout content. Unknown refs are never assigned to the latest open cycle
by inference.

## Report Identity

Single-cycle report:

```bash
code-pact memory cost <cycle-ref> --json
```

Task query:

```bash
code-pact memory cost --task <task-id> --json
```

Task query returns at most eight retained cycle summaries for the task. It does
not implicitly select the latest cycle, does not sum complete and abandoned
cycles together, and does not collapse distinct cycles into one total.

Any aggregate report requires a later explicit flag or a P55 closed harness.

## Active Cycle Record

Cycle storage separates cumulative totals from bounded detail:

```json
{
  "totals": {
    "task_prepare": 2000,
    "task_context": 12000,
    "task_complete_failure": 5000
  },
  "observed_code_pact_stdout_bytes": 19000,
  "total_event_count": 83,
  "events": [],
  "retained_event_count": 64,
  "omitted_event_count": 19,
  "details_truncated": true
}
```

`MAX_RETAINED_EVENT_DETAILS = 64` limits retained event detail, not cumulative
accounting. The 65th and later events still update:

- category totals
- `observed_code_pact_stdout_bytes`
- total event count
- omitted detail count

## Per-Cycle Byte Limit

`MAX_CYCLE_BYTES = 32 KiB` applies to active and inactive cycle records.
Active cycles are not exempt.

If a canonical cycle record would exceed the cap, implementation must compact
in this order:

1. omit oldest detail events
2. omit component breakdown
3. preserve category totals and event count
4. set `details_truncated: true`

If even the minimum summary cannot be saved, store the smallest possible record
with:

```json
{
  "measurement_incomplete": true
}
```

The original CLI command result and exit code remain unchanged.

## Retention

Hard limits:

```text
MAX_CYCLES = 256
MAX_TOTAL_BYTES = 2 MiB
MAX_CYCLE_BYTES = 32 KiB
MAX_RETAINED_EVENT_DETAILS = 64
MAX_CYCLES_PER_TASK = 8
MAX_AGE_DAYS = 90
MAX_ACTIVE_IDLE_DAYS = 7
MAX_MINIMAL_CYCLE_BYTES = 4 KiB
```

Active cycles are protected from deletion while they are being tracked, but
they still converge to the per-cycle event and byte limits through compaction.
Retention removes old inactive cycles by age, per-task count, global count, and
global byte pressure without discarding cumulative totals from retained cycles.

P72 adds admission control: stale active cycles are first abandoned, inactive
cycles are retained or compacted, and a new cycle is created only if all hard
limits remain satisfied. If capacity is exhausted, only tracking fails open.

## Consequences

P66 can remain bounded without lying about cumulative stdout bytes. Reports are
cycle-ref based, so a task with multiple attempts does not accidentally report
an arbitrary latest cycle or a mixed aggregate.
