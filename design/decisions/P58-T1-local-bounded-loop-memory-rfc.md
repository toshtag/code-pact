# RFC: local bounded loop memory

**Status:** accepted (P58-T1, 2026-07)
**Scope:** introduce a local, bounded, schema-validated episode store for task-loop verification outcomes. The store is advisory only and is not read by context preparation, recommendation, verification gates, write audit, Evidence, or Failure Capsule generation in P58.
**Owners:** maintainer
**Related:** `task-prepare-lifecycle-aware-rfc.md` (prepare remains the per-task entry point); `decision-lifecycle-rfc.md` (local memory is not a decision source).

## Summary

Code Pact already has deterministic context packs, deferred context artifacts,
Failure Capsules, and bounded repair guidance. What it does not have is a
small, local record of repeated verification outcomes that later phases can use
to avoid re-investigating the same failure. P58 accepts that foundation, but
keeps it deliberately inert: record first, retrieve later.

The decision is to add a machine-local loop-memory store under the ignored
cache, using one strict JSON file per episode. The store records compact facts
about `task complete` verification success or failure. It does not store source,
diffs, prompts, responses, model reasoning, stdout, stderr, Failure Capsule
excerpts, or free-form reflection.

## Decision

Use one-record JSON files under:

```text
.code-pact/cache/loop-memory/v1/episodes/
```

Each file is named with a UTC timestamp plus a digest prefix, and the digest is
computed from canonical episode payload bytes. The cache path is local and
gitignored by the existing `.code-pact/cache/` policy.

The initial backend is not SQLite, JSONL, Markdown, or one giant JSON file.
Those options add migration, locking, parsing, or prose-drift costs before the
project has evidence that the small bounded store is insufficient.

## Contract

Loop memory is advisory and disposable:

- It is not a source of truth for task status, verification, decisions, write
  audit, Evidence, Context artifacts, or Failure Capsules.
- Deleting `.code-pact/cache/loop-memory/` must not change normal project
  behavior.
- `task prepare`, `task context`, and `recommend` must not read it in P58.
- Context pack bytes and recommended budgets must not change because the store
  exists.
- `verify` and `task complete` gates must not be weakened or bypassed by a
  stored episode.
- The progress ledger remains the only task lifecycle record.
- The store is local to one checkout and is not shared through Git, CI, or
  adapters.

## Stored Facts

P58 records only compact structured fields that `task complete` already knows:

- task id, phase id, and task type
- lifecycle mode and repair mode
- verification pass/fail kind
- failed check or bounded command name when available
- failure fingerprint when available
- recording timestamp

It does not infer missing fields. If `task complete` cannot determine a value
from its existing flow, the episode omits it.

Episode schema v1 does not store an Evidence reference. `task complete` records
the memory episode before the agent-detail Evidence projection is generated on
failure, and generating Evidence only for memory would add a new side effect.
Evidence integration is deferred to a later schema version if it becomes useful.

## Retention

Retention is hard-coded at introduction:

- at most 256 episodes
- at most 2 MiB total
- at most 8 KiB per episode
- at most 90 days old
- at most 8 episodes per task
- at most 4 episodes per failure fingerprint

Corrupt, oversized, identity-mismatched, or unsafe files are reported, not
silently deleted. Explicit prune commands may delete only validated candidate
files. `memory prune --write` preflights the whole batch, deletes nothing on a
preflight conflict, treats concurrent post-preflight deletion as idempotent, and
reports the actual post-write scan.

## Non-Goals

- No memory injection into context packs or Failure Capsules.
- No same-fingerprint stop.
- No failure-to-success resolution aggregation.
- No natural-language learning or model-generated reflection.
- No semantic search, embeddings, tokenizer, or LLM API call.
- No SQLite or schema migration.
- No project-level configuration for the policy.
- No contributor sync or remote memory.
- No automatic promotion into project rules.

## Implementation Commitments

- [x] T2: add the strict episode schema, canonical serialization, filesystem
  authority, atomic create path, scanning, status calculation, and retention
  plan/apply behavior.
- [x] P58A: reject oversized files before body read, require filename/content
  identity, require UTC `toISOString()` timestamps, and omit unsafe command
  strings containing absolute paths.
- [x] T3: record success and failure episodes from `task complete` only, after
  verification has produced its normal result. Failure Capsule and Evidence
  output remain independent of loop memory.
- [x] P58A: memory write failures and retention maintenance failures are
  non-fatal, accurately distinguished, and do not change the task completion
  source-of-truth result, progress event contract, or exit code.
- [x] T4: add `memory status` and dry-run-by-default `memory prune`.
- [x] T4: add doctor checks for tracked loop-memory files and unsafe memory
  roots, without automatic deletion.
- [x] P58A: use Git's ignore semantics for the cache ignore doctor check.
- [x] T4: keep normal successful `task complete` output free of memory metadata.

## References

- Docs: [docs/cli-contract.md](../../docs/cli-contract.md),
  [docs/agent-contract.md](../../docs/agent-contract.md),
  [docs/positioning.md](../../docs/positioning.md).
