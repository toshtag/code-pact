# Token Reduction Memory Roadmap

**Status:** accepted (P63-T1, 2026-07)
**Scope:** sequence the local-memory work after P58-P62 so it can reduce total
task input bytes without changing correctness gates or injecting memory into
initial context.
**Owners:** maintainer
**Related:** `P58-T1-local-bounded-loop-memory-rfc.md`

## Primary objective

Reduce total task input bytes, not merely individual prompt size. A smaller
first context pack is useful only when it reduces the whole task cycle:
initial context, deferred retrieval, evidence retrieval, failure capsules,
memory retrieval, repeated verification, and repair attempts.

## Existing foundation

P58-P62 established the local bounded loop-memory foundation:

- bounded local episode recording under the ignored cache
- canonical episode identity and UTC timestamps
- corrupt-entry visibility and measured corrupt-byte accounting
- dry-run prune and exact current-invocation unlink counts
- local-only doctor and status contracts
- no reads from memory during `task prepare`, `task context`, or `recommend`

That foundation is intentionally inert. It records safe local facts but does
not yet reduce repeated investigation or task-cycle cost.

## Why storage alone does not reduce tokens

Recording episodes by itself can increase maintenance surface without reducing
agent input. Token reduction requires a later command or signal that lets an
agent avoid re-reading, re-deriving, or re-investigating the same failure. The
memory roadmap therefore proceeds from safe storage to exact recall, then to
bounded retrieval, then to whole-cycle cost measurement.

## Recall sequence

The accepted sequence is:

- P58-P62: record the local memory substrate and close safety/accounting gaps.
- P63: surface a minimal local advisory only when the current failure
  fingerprint exactly matches prior local history.
- P69: harden the executable scopes and decision gates before P63 runtime work
  begins.
- P64: derive deterministic aggregates for matching fingerprints and observed
  resolutions.
- P65: allow explicit lazy retrieval when the exact-match signal is too small.
- P66: measure whole task-cycle input cost.
- P55: re-evaluate Stable Core and Task Delta only after P66 evidence exists.
- P67: consolidate sufficiently repeated local facts while preserving
  contradictions.
- P68: review storage backend limits from measurements and record an ADR.

## Retrieval boundaries

Initial task context remains memory-free. Exact-match signals and explicit
retrieval are local advisory surfaces only. Retrieval is bounded by exact
fingerprint, record count, and total bytes. It must not return raw stdout,
stderr, prompts, responses, reasoning, source, or diffs. Missing local cache
must be a normal empty result.

P63 exact-match recall must avoid self-match. The runtime order is:

```text
compute the current failure fingerprint
lookup against the existing episode snapshot
generate any prior-local signal
record the current failure episode
```

The current failure episode must never contribute to `prior_match_count`, and
the first observation of a fingerprint returns no signal. The only signal shape
is an additive `prior_local_signal` field on `--detail agent` failure JSON:

```json
{
  "schema_version": 1,
  "exact_match_count": 2,
  "last_observed_at": "2026-07-15T00:00:00.000Z"
}
```

The canonical JSON for this object must stay at or below 1 KiB. It omits the
fingerprint because the current failure already carries it, and it never
includes task id lists, raw episodes, failed commands, or resolution
instructions. It also omits resolution fields; P64 owns resolved/unresolved
aggregation. Default human output and default JSON do not grow; absence of a
match omits the field entirely.

## Cycle cost model

P66 measures task-level input cost with local bounded byte accounting:

```text
task_total_input_bytes
= context_pack_bytes
+ deferred_context_retrieval_bytes
+ evidence_retrieval_bytes
+ memory_retrieval_bytes
+ repeated_failure_capsule_bytes
```

The metric also records verification_run_count, repair_attempt_count,
first_pass_success, success_after_repair, same_failure_repeated, and
stopped_without_success. P66 defines cycle start, cycle id, continuation,
close, abandoned cycle, new attempt, retry, task-already-done, and cache
deletion behavior. The cycle id is not just task id; it distinguishes multiple
attempts on the same task. Metrics distinguish bytes referenced, bytes emitted,
bytes explicitly retrieved, and bytes actually returned by the CLI. Only bytes
actually returned to the agent are added to total input, and a repeated
retrieval command is counted again. It does not convert bytes to provider token
counts or prices, does not call model APIs, and does not send telemetry.

## Consolidation policy

P67 may consolidate only repeated local facts, such as a fingerprint observed
three or more times or a same-task failure-to-success pattern observed twice.
Consolidation must preserve contradictions, keep dry-run and write modes
separate, and retain TTL, count, and byte limits for aggregates. Local memory
must not be promoted automatically into project rules or decisions.

## Storage backend decision gates

P68 considers storage alternatives only after measured pressure exists. The
review gate is:

```text
status, prune, or exact lookup p95 > 50 ms near current hard caps
OR at least 25% of 100+ writes trigger retention removal
OR aggregate storage reaches 80% of its byte cap three consecutive times
OR writer conflict rate exceeds 1% across 100+ writes
OR two or more independent index queries or atomic multi-record updates are accepted as required
```

The ADR must compare one-record JSON, SQLite, an index sidecar, and an
aggregate file. It must cover migration, locking, corruption recovery, platform
behavior, transaction semantics, vacuum behavior, filesystem authority, cache
deletion/rebuild, dependency cost, package size, and contributor burden. If the
gate is not met, the outcome is rejected or deferred.

## Stable Core re-evaluation

P55 moves after P66. Stable Core and Task Delta must not be accepted merely
because a split first context pack looks smaller. The decision must compare
context resend cost against failure investigation, verification repetition,
evidence retrieval, memory retrieval, and repair attempts. Stable-core
retention by an agent must be demonstrated rather than assumed.

## Phase sequence

```text
P58 -> P59 -> P60 -> P61 -> P62 -> P63 -> P69 -> P64 -> P65 -> P66 -> P55 -> P67 -> P68
```

P55 keeps its id because it is an existing planned decision. Only its position
and dependency change.

## Non-goals

- No exact-match runtime implementation in P63-T1.
- No memory signal to agents in P63-T1.
- No memory recall CLI in P63-T1.
- No aggregate generation in P63-T1.
- No cycle metric storage in P63-T1.
- No consolidation or backend migration in P63-T1.
- No SQLite dependency in P63-T1.
- No context pack, Failure Capsule, Evidence, repairPolicy, adapter, CI,
  release, version, or phase archive change.
- No Git tracking or contributor sharing of local memory.

## Implementation commitments

- P63-T1 creates the formal roadmap and keeps production source and tests
  unchanged.
- P63-T1 established the roadmap through phase-imported design files; P69-T1
  hardens executable task scopes and decision gates before runtime
  implementation begins.
- P63-T2/P63-T3 remain planned implementation tasks for exact-match recall.
- P64 defines deterministic aggregate semantics before implementation.
- P65 requires explicit bounded retrieval instead of initial context injection.
- P66 supplies whole-cycle byte evidence before P55 can decide split context.
- P67 addresses long-term boundedness and contradiction handling.
- P68 makes backend change conditional on measured gates and a later accepted
  implementation phase.
