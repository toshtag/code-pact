# Runtime Scope and Benchmark Boundary

**Status:** accepted (P70-T3, 2026-07)
**Scope:** narrow future runtime write surfaces and define the storage backend
benchmark methodology before P63-T2 begins.
**Owners:** maintainer
**Related:** `P70-T1-recall-aggregation-boundary-rfc.md`,
`P70-T2-cycle-correlation-and-accounting-rfc.md`

## Scope Narrowing

Future implementation tasks must avoid broad write globs when concrete files
are known.

P65-T2 keeps `scripts/gen-cli-reference.ts` as a read dependency only. The
generated reference is updated by running the generator, not by changing the
generator source.

P66-T2 uses concrete cycle-metrics authority and command/test files rather than
`src/core/project-fs/authorities/**` or `tests/unit/commands/**`.

P67-T2 uses concrete loop-memory aggregate authority files rather than broad
authority globs, and includes the CLI/docs/error-surface files needed for the
future consolidate command.

## Benchmark Methodology

P68-T1 backend review uses a reproducible local benchmark method:

- warm-up: 20 runs
- measured runs: 200
- clock: `process.hrtime.bigint()`
- report: median, p95, maximum
- fixture: fixed record count and total bytes near current hard caps
- cache state: cold and warm cases reported separately
- concurrency: single-writer and two-writer contention cases reported separately
- p95: sort measured durations ascending and select the ceil(0.95 * n) sample

The ADR records:

- Node version
- OS
- architecture
- filesystem type when available
- CPU model
- record count
- total bytes
- fixture digest
- command

One measurement run cannot accept a backend migration. Temporary directories
are separate per case. Network is not used. Provider token counts are not
derived. If no benchmark script is committed, the ADR includes complete
reproduction commands. A measurement environment that cannot supply the method
is deferred, not accepted.

## Governance Note

P69 hardened future phase contracts through the supported planning-authoring
flow before P69-T1 finalization. P69-T1 itself is not rewritten by P70. P70
records the remaining runtime-boundary corrections without rewriting P69
history.
