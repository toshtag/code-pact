# Active Cycle Admission and Lifecycle

**Status:** accepted (P72-T2, 2026-07)
**Scope:** define active-cycle states, admission control, stale abandonment, and
global hard-limit convergence before P66 implementation.
**Owners:** maintainer
**Related:** P71-T2, P72-T1

## Cycle State

Cycle records use a closed state set:

```text
active
complete
abandoned
```

Each cycle record carries:

```text
created_at
last_activity_at
closed_at
state
```

`closed_at` is absent while the cycle is active.

## One Active Cycle Per Task

Within one repository, a task may have at most one active cycle.

If tracked `task prepare` runs for a task that already has an active cycle:

- no new cycle is created
- the existing active cycle is resumed
- the same `cycle_ref` is returned
- a new `task_prepare` event is recorded on that cycle

This is not a new attempt. A new attempt can start only after the previous
cycle is `complete` or `abandoned`.

## Cycle Close

Lifecycle outcomes:

```text
task complete success      -> complete
task record-done success   -> complete
repairable verify failure  -> active
decision-required stop     -> abandoned
unsafe-write stop          -> abandoned
non-repairable stop        -> abandoned
aborted command            -> active, without last_activity_at update
```

`task finalize` occurs after cycle close and is not measured by P66.

## Stale Active Cycles

P66 defines:

```text
MAX_ACTIVE_IDLE_DAYS = 7
```

An active cycle with no activity for seven days transitions deterministically
to `abandoned` during the next scan, status, prune, or tracking start. It is
not automatically deleted at that moment. After abandonment, normal retention
may remove it.

## Admission Control

Before creating a new cycle, implementation must:

1. transition stale active cycles to `abandoned`
2. apply retention to inactive cycles
3. compact active and inactive cycle details as needed
4. verify that adding a minimal new cycle preserves all hard limits

If capacity still cannot be preserved, tracking fails open:

```json
{
  "cycle_tracking": {
    "requested": true,
    "started": false,
    "warning": {
      "code": "CYCLE_TRACKING_CAPACITY_EXHAUSTED",
      "affects_exit": false
    }
  }
}
```

No cycle ref is returned. The original `task prepare` result and exit code do
not change.

## Minimal Summary Bound

Every cycle must compact to a minimal summary of at most:

```text
MAX_MINIMAL_CYCLE_BYTES = 4 KiB
```

Minimal summary keeps only:

- schema version
- cycle ref
- task identity
- state
- timestamps
- category totals
- observed stdout total
- event count
- `measurement_incomplete`
- `details_truncated`

P66 implementation must include a fixture proving that 256 minimal summaries
fit under `MAX_TOTAL_BYTES = 2 MiB`.

## Hard-Limit Invariant

P66 must always preserve:

```text
cycle count <= 256
total stored bytes <= 2 MiB
cycles per task <= 8
each cycle bytes <= 32 KiB
retained details per cycle <= 64
```

Active cycles are protected from deletion, but they are not exempt from
admission control, per-cycle compaction, or global capacity checks.

## Consequences

The cycle store cannot exceed global hard limits merely because many active
cycles are protected. If the store cannot safely admit a new cycle, only
tracking is disabled for that invocation; command correctness is unaffected.
