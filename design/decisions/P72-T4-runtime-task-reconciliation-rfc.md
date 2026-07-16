# Runtime Task Reconciliation

**Status:** accepted (P72-T4, 2026-07)
**Scope:** reconcile P63, P66, P55, and P67 task dependencies after P72 closes
cycle metric execution contracts.
**Owners:** maintainer
**Related:** P63, P66, P55, P67, P72-T1, P72-T2, P72-T3

## Decision

P63-T2 waits for P72-T4. P66 cycle-metrics runtime work is split into bounded
implementation tasks before P55 or P67 can consume it.

## P63 Gate

P63-T2 depends on:

```text
P72-T4
```

`exact_match_count` means the number of matching valid episodes currently
retained in the bounded local store. It is not a lifetime occurrence count.

## P66 Task Split

P66 is split as:

```text
P66-T1  architecture contract
P66-T2  cycle store foundation
P66-T3  tracking start and generated command propagation
P66-T4  exact serialized stdout instrumentation
P66-T5  read-only reporting and maintenance
P66-T6  regression and compatibility coverage
```

The dependency chain is:

```text
P66-T1 -> P66-T2 -> P66-T3 -> P66-T4 -> P66-T5 -> P66-T6
```

## P66-T2 Store Foundation

P66-T2 owns:

- cycle ref
- schema
- store
- retention
- lifecycle/admission support
- status/error model
- filesystem authority
- authority resolver integration
- authority/containment checks
- store/security unit tests

It does not instrument command stdout.

## P66-T3 Tracking Propagation

P66-T3 owns:

- `task prepare --track-cycle`
- `--cycle-ref` on task lifecycle and verify surfaces
- generated command propagation for tracked prepare
- deferred context and Evidence retrieval command propagation
- task lifecycle and verify command tests

The current codebase does not have standalone `task-start.ts`,
`task-resume.ts`, or `task-block.ts` command files, so the future write surface
uses the existing `src/cli/commands/task.ts` and `src/cli/spec/task.ts`
surfaces for those command verbs.

## P66-T4 Stdout Instrumentation

P66-T4 owns exact final-serialized-stdout measurement. One CLI invocation that
writes stdout creates one emission event. Implementations must measure the
already-serialized string and must not reserialize parsed JSON for metrics.

## P66-T5 Reporting and Maintenance

P66-T5 owns `memory cost`, status, prune, doctor, i18n, generated reference,
and error-surface coverage. `memory cost` and maintenance commands are read-only
for the target cycle and must not update target-cycle totals.

## P66-T6 Compatibility

P66-T6 owns regression coverage that proves:

- tracking disabled output remains byte-identical
- tracked generated commands carry the same cycle ref
- standalone verify success/failure are counted
- task-control stdout is counted
- report commands do not self-observe
- active-cycle capacity failure changes only tracking metadata
- minimal summaries and retained cycle caps converge

Broad test globs are not used in P66-T6 writes; concrete existing test files are
listed in the phase.

## Downstream Dependencies

P55 waits for:

```text
P66-T6
```

P67-T1 waits for:

```text
P66-T6
P55-T1
```

This prevents later decisions from consuming a partial cycle-metrics runtime.

## Consequences

The P66 runtime implementation no longer concentrates store, command
propagation, stdout instrumentation, report surfaces, docs, and broad
regression tests into one task. Smaller tasks reduce retry cost and make future
review failures more local.
