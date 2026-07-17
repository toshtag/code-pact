---
status: accepted
task: P55-T1
---

# P55-T1 Stable Core and Task Delta Decision

## Context

P52-P54 introduced reversible context deferral, recommended budget application,
and structural context projection so that a task pack can omit large sections
and retrieve them later. P55 was chartered to decide whether the next step is a
formal split context output — a separately-specified Stable Core plus per-task
Task Delta — or whether the existing combined pack plus deferral/projection is
sufficient.

P63 and P66 followed P52-P54. P63 established exact-match local failure recall
as a bounded advisory, and P66 measured the closed-harness byte cost of the
Code Pact CLI itself. P55 now re-evaluates Stable Core and Task Delta only
after that evidence exists.

## Available evidence

P52-P54 phase files were archived at release; they are no longer present in the
active tree. The archive snapshots prove that P52, P53, and P54 completed, but
do not retain the full phase source or byte tables.

Current behavior is verified by:

- `tests/integration/task-context-budget.test.ts`
- `tests/integration/task-context-explain-metrics.test.ts`
- `tests/integration/pack-byte-identical.test.ts`
- `tests/fixtures/context-projection/**`
- `tests/fixtures/golden/pack-v1.0.2-shaped.md`

Outcomes:

- P52: deferred context is content-addressed, retrievable, and materialized
  before the pack is written.
- P53: a recommended budget can be applied deterministically without changing the
  default no-flag behavior.
- P54: read-glob and decision references can be projected when a budget is
  explicitly applied.

No stable-core-specific measurements were recorded because the split-artifact
mode does not exist.

## Current combined-context baseline

Measured with a deterministic local fixture (400 tracked read files, budget
20000 bytes) on the existing combined context + projection / deferral path:

| metric                          | source                      |  value | interpretation                                      |
| ------------------------------- | --------------------------- | -----: | --------------------------------------------------- |
| natural context bytes           | local deterministic fixture | 21,329 | unbudgeted combined context                         |
| default combined-pack bytes     | local deterministic fixture | 21,329 | current default pack body                           |
| final budgeted bytes            | local deterministic fixture |  2,403 | combined output after projection and deferral       |
| deferred bytes                  | local deterministic fixture | 19,662 | original bytes represented by the deferred artifact |
| projection bytes before         | local deterministic fixture | 19,662 | original reads section                              |
| projection bytes after          | local deterministic fixture |    315 | projected reads section in budgeted pack            |
| projection saved bytes          | derived                     | 19,347 | before minus after                                  |
| context list stdout bytes       | local deterministic fixture |    369 | manifest listing command stdout                     |
| context section retrieval bytes | local deterministic fixture | 20,396 | exact reads retrieval stdout                        |
| combined command count          | local deterministic fixture |      1 | initial context command                             |
| context retrieval count         | local deterministic fixture |      2 | list + section retrieval                            |

These values describe the current combined mode. They do not include any
Stable Core or Task Delta artifact.

## P66 closed-harness scenario totals

| scenario                        | total Code Pact stdout bytes |
| ------------------------------- | ---------------------------: |
| first-pass success              |                          839 |
| failure → repair → success      |                        2,224 |
| repeated failure → success      |                        3,602 |
| deferred-context scenario       |                       68,536 |
| evidence-retrieval scenario     |                       22,071 |
| prior signal incremental bytes  |                          110 |
| repeated failure envelope bytes |                        1,488 |

These P66 values are **scenario-wide totals**. They are not context-pack bytes
and are not individual retrieval payload sizes. They are copied from
`design/decisions/P66-T2-token-reduction-evidence-rfc.md`.

## Split-only unavailable metrics

The following cannot be produced without first building a candidate split mode:

| metric                      |       value | reason                |
| --------------------------- | ----------: | --------------------- |
| stable core initial bytes   | unavailable | no reference splitter |
| task delta initial bytes    | unavailable | no reference splitter |
| stable core retrieval bytes | unavailable | no reference splitter |
| task delta retrieval bytes  | unavailable | no reference splitter |
| split manifest bytes        | unavailable | no reference splitter |
| split digest metadata bytes | unavailable | no reference splitter |
| stable core resend bytes    | unavailable | no reference splitter |
| split artifact count        | unavailable | no implementation     |
| split command count         | unavailable | no implementation     |
| split total stdout bytes    | unavailable | no implementation     |

The current combined-mode baseline is therefore the only measured comparison
point available.

## Artifact and command-count comparison

### A. Default combined context

- Initial output bytes: current combined baseline, 21,329 bytes natural,
  2,403 bytes after budget/projection/deferral.
- Deferred retrieval bytes: 20,396 bytes for the measured reads section.
- Manifest listing bytes: 369 bytes.
- Command count: 1 initial context command; up to 2 retrieval commands when
  deferred sections are needed.
- Artifact count: one combined Markdown pack plus one deferred artifact per
  elided section.

### B. Split context

No implementation exists. A hypothetical Stable Core / Task Delta split would
require at least:

- Stable Core initial bytes (unknown).
- Task Delta initial bytes (unknown).
- Stable Core retrieval bytes (unknown).
- Task Delta retrieval bytes (unknown).
- Additional manifest bytes (unknown).
- Digest / reference metadata bytes (unknown).
- Stable Core resend bytes if the execution environment cannot attest that the
  exact content is already available (unknown).
- Stable Core availability attestation cost (unknown).

Without measured values, the split mode cannot be shown to reduce total bytes.

### C. Failure path

P66 provides bounded measurements for failure envelopes:

- Failure envelope bytes: 1,488 for repeated failure.
- Prior-local signal bytes: 110.
- Evidence retrieval scenario total stdout: 22,071.
- Deferred-context scenario total stdout: 68,536.

Whether a Stable Core resend or a Task Delta retrieval reduces any of these
costs is unmeasured.

## Stable Core availability contract

The execution environment, not the model, must establish whether the exact
Stable Core content is available to the current invocation.

Availability must be represented explicitly by:

- content reference
- expected content digest
- actual supplied-content digest or equivalent attestation
- retrieval command when content is absent or mismatched

The model must not be asked to:

- remember whether content was previously supplied
- infer whether retained content is stale
- treat a digest as if it were the content
- guess whether retrieval is required

When content availability cannot be attested, the system returns
`retrieve_context` and stops.

## Retention distinction

### Transport/session retention

The execution environment or provider session makes the same content available
to later invocations. This affects byte and token cost, but not correctness.

### Model semantic memory

The model believes it remembers earlier content. This must not be used as a
correctness mechanism.

Low-cost model benchmarks therefore measure whether the Stable Core content is
actually supplied to each invocation, not whether the model thinks it
remembers it.

## Low-capability model analysis

P66-T2 explicitly rejects assuming that a high-capability model is available.
For a split mode to be safe for the default execution target, it must:

- Return structured commands for split-mode selection, retrieval, and
  verification rather than requiring the model to infer them.
- Fail closed when the Stable Core content is not attested by returning an
  explicit `retrieve_context` next action.
- Keep the default combined output unchanged.
- Not depend on a digest as a substitute for validated content.

These properties can be specified, but they have not been implemented or
validated.

## Failure and retrieval cost comparison

| case                           | claim                                      | evidence   |
| ------------------------------ | ------------------------------------------ | ---------- |
| Content attested available     | Task Delta retrieval may save bytes        | unmeasured |
| Content not attested available | Stable Core must be resent or re-retrieved | unmeasured |
| Attested content is stale      | retrieval or resend needed                 | unmeasured |
| Digest mismatch                | explicit retrieval required                | unmeasured |

Because both the attested-available and not-attested cases must be accounted
for, and neither is measured, the cost comparison is incomplete.

## Decision rubric

### Evidence-dependent acceptance conditions

The following are not satisfied because no split-mode measurement exists:

1. Stable Core content availability can be attested across invocations.
2. Split mode total bytes are less than combined mode total bytes.
3. Stable Core resend + Task Delta is still cheaper when content is not
   attested.
4. Additional retrieval commands do not cancel the byte savings.
5. No overlap with existing deferral, projection, evidence, or retrieval paths.

### Safety and compatibility conditions

The following can be specified, but are not yet implemented or validated:

6. Default combined output remains unchanged and split is opt-in.
7. Missing Stable Core fails closed with explicit retrieval.
8. Low-cost models do not need to infer retention state.
9. Correctness does not rely on digest matching alone.
10. Concrete acceptance tests are defined.

### Rejected conditions

Rejection requires proof that split mode is structurally worse:

- Split always exceeds combined output size.
- Stable Core availability cannot be represented explicitly.
- Split harms determinism or correctness.
- The value duplicates existing deferral/projection paths.

None of these are proven either.

## Decision

**Status: deferred**

Stable Core / Task Delta is not accepted because candidate split costs and
executor-level content availability are unmeasured. It is not rejected because
no structural impossibility has been shown. The decision is deferred until the
missing measurements are collected.

## Implementation consequences

- No production implementation is authorized.
- The default combined Markdown context pack remains unchanged.
- Existing deferral, projection, and recommended-budget behavior remains unchanged.
- No new CLI flags for split mode are added.

A future decision-research task may create a test-only or repository-external
reference splitter solely to measure candidate partition bytes, artifact count,
command count, resend cost, and retrieval cost. Such a reference splitter must
not change public CLI behavior, change the default context pack, write
production `src`, claim model-behavior improvement, or become a supported
feature before a new decision.

## Evidence still required

### Stage 1 — Deterministic byte simulation

- fixed multi-step corpus
- test-only candidate partition
- combined baseline bytes
- candidate Stable Core bytes
- candidate Task Delta bytes
- manifest / reference metadata bytes
- resend bytes
- retrieval bytes
- command and artifact counts

### Stage 2 — Executor/session transport evidence

- whether exact Stable Core content is supplied to each invocation
- explicit cache / retention semantics
- cache miss behavior
- digest mismatch behavior

### Stage 3 — Low-cost model behavior

- first-pass verification rate
- repair-round count
- out-of-scope write rate
- same-fingerprint repeat rate
- total input / output token count
- completed-task cost

Stage 1 must show a favourable byte comparison before Stage 2 / 3 begins.

Until then, the Stable Core / Task Delta decision remains deferred and no
split-context implementation begins.
