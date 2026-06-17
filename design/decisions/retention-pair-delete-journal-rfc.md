# RFC: Retention pair-delete journal — crash-safe both-or-neither for a phase snapshot ↔ event_pack pair

**Status:** proposed — design contract. Fixes the state machine + invariants for deleting a mutually-bound `phase_snapshot` ↔ `event_pack` pair both-or-neither across a crash, which a sequential two-unlink cannot do. Implementation ships in small reviewed layers (journal + recovery foundation → reader-awareness → CLI wiring → bundle-member pairs). No code is authorized for the destructive CLI path by this RFC's foundation layer. (2026-06)
**Scope:** the LOOSE-pair case only — a `phase_snapshot` and its `event_pack` that are BOTH loose-only `would_drop`. Bundle-only / `both` pairs (which add bundle rebuild/verify/retire on top of the same pair atomicity) are a later layer. This RFC does NOT change the per-item record format and does NOT run retention on this repo.
**Owners:** maintainer
**Related:** [archive-level-compaction](archive-level-compaction-rfc.md) (the bounded-archive milestone; this refines its §(A).3 "fail-closed-ordered delete" for the mutually-bound pair) · [event-pack-compaction](event-pack-compaction-rfc.md) (the delete-time gate + R0–R5 reconciliation this reuses) · [decision-lifecycle](decision-lifecycle-rfc.md) (the `PRUNED.md` write-ahead-tombstone precedent this generalises into a typed journal).

## Summary

`state archive-retention --write` (PR-2a, shipped) drops old archive truth, but it deletes ONLY **independent** loose-only records — a `decision_record`, or a `phase_snapshot` with **no** `event_pack`. A `phase_snapshot` and its `event_pack` are a **mutually-bound** pair and are deferred whole (`requires_atomic_pair_removal`):

- the pack carries the snapshot's `snapshot_sha256` — a pack **without** its snapshot is structurally broken;
- the snapshot's `progress_events` evidence resolves its `event_ids` from the durable ledger (loose events ∪ validated packs) — once the loose events are compacted into the pack, the pack is that evidence's **only** durable source, so a snapshot **without** its pack dangles (`validate` / `plan lint` / `doctor` flag `unresolved`).

A filesystem cannot unlink two files atomically. So a sequential "delete pack, then snapshot" (or the reverse) is **not crash-safe**: a process crash (SIGKILL / power loss), or a per-record gate skip / `unlink_failed` / `unreadable` **between** the two unlinks, leaves exactly one side and breaks the archive. (This is the P1 that took PR-2a from "delete the dependent first" → "delete order by binding" → "the binding is mutual" → "mutual + atomic is unachievable with two sequential unlinks". The write lock bars concurrent *code-pact* mutations but not a crash mid-sequence nor a real I/O failure on the second file — so this is a within-contract gap, not the documented out-of-lock window.)

Both-or-neither across a crash needs a **write-ahead delete-intent journal** + **recovery**, exactly the shape `decision prune` already uses (append the `PRUNED.md` tombstone — the commit — before the `unlink`, idempotent on retry), generalised to a typed journal that names the pair.

## Decision

Add a typed, atomically-written **delete-intent journal** at `.code-pact/state/archive/delete-intent.json`. The journal is the **commit point** of a pair deletion: a pair is logically deleted the instant its intent is durably on disk, and recovery rolls a committed-but-incomplete deletion **forward** to "both gone" (never backward — a delete intent is never rolled back). Everything before the intent write is rolled **back** (both retained), because nothing destructive has happened yet.

### The atomicity boundary: the intent write is the commit

```
                       commit point
                            │
  gate both ──► write intent ──► unlink pack ──► unlink phase ──► clear intent
   (validate)   (atomic, WAL)
      │              │              │                │               │
  crash here:    crash here ─────────────────────────────►      crash here:
  no intent      intent present → recovery completes BOTH        no intent
  → both         the unlinks (idempotent) → both gone            → both gone
  RETAINED                                                       (already done)
```

- **Before the intent write** (gate fails for either side, or a crash): no intent on disk → recovery is a no-op → **both retained**. Nothing was unlinked, so this is a clean rollback.
- **After the intent write** (any crash through "unlink pack", "unlink phase", before "clear intent"): the intent is on disk → recovery re-reads it and completes the unlinks of **both** members **idempotently** (`ENOENT` is success) → **both gone**. The committed decision ("this pair is deleted") is honoured.
- **After clear**: no intent, both gone → terminal success.

So every crash converges, under recovery, to exactly one of **both-deleted** (intent was committed) or **both-retained** (intent was not) — never one side.

### The journal record

```
{
  "schema_version": 1,
  "pairs": [ { "phase_id": "P1", "phase_sha256": "...", "pack_sha256": "..." }, ... ]
}
```

- `phase_id` names the pair (the loose phase snapshot AND the loose event pack share the id; their paths are derived). Recovery needs only the id to finish the unlinks.
- `phase_sha256` / `pack_sha256` record the exact bytes the gate validated at commit — **diagnostic / audit only**. Recovery does **not** gate on them: a delete intent must COMPLETE, never skip (a skip would leave a permanent half-state if one side is already gone). Re-validation belongs at the commit point, not at recovery.

### Durability — the commit is a real WAL barrier, not just an atomic rename

An atomic `rename` gives atomic *visibility*, not *durability* across power loss / OS crash: the rename can be in the page cache when a later `unlink` is also in the page cache, and a power loss can persist the unlink but not the rename — leaving a member gone with no journal to recover it (exactly the half-state this RFC must prevent). So the commit `fsync`s:

1. write the journal to a temp file, **`fsync` the temp file's data**;
2. refuse if a journal already exists (see below), then `rename` temp → `delete-intent.json`;
3. **`fsync` the parent directory** so the rename itself is durable.

Only when `writeDeleteIntent` returns is the intent on stable storage — and the operation issues every unlink *after* it returns. So the ordering **"commit durable ≤ any unlink durable"** holds: a power loss that lost the commit also lost every unlink (the unlinks come after the commit `fsync`), so the worst observable state is *both retained*, never one side. After the unlinks the member directories are `fsync`ed before the journal is cleared, so "both gone" is durable before the commit record is removed (a power loss after the clear cannot resurrect a member with no journal to re-delete it). The clear `unlink` + directory `fsync` make journal removal durable too. (Durability is to the extent the platform's `fsync` guarantees; the **directory** `fsync` is best-effort — some platforms cannot `fsync` a directory, where the rename's durability is the platform's concern. The data `fsync` on the temp file is mandatory.)

### No-overwrite — a pending journal blocks a new commit

`writeDeleteIntent` **refuses** to overwrite an existing journal (`PendingDeleteIntentError`), and `deleteLoosePairsJournaled` first checks the journal is **absent** (else it throws). A present journal is an **un-recovered prior commit**; overwriting it would destroy the authority to finish (or roll back) that pair, stranding it. So the only way past a pending journal is `recoverPendingDeletes` — recovery, never silent clobber. The journal also rejects a duplicate `phase_id` (a malformed batch), fail-closed before any commit.

### The gate (reused, unchanged)

Immediately before committing the intent, BOTH the loose phase and the loose pack go through the **same per-record gate** PR-2a already uses (`gateLooseDelete`): path-in-project, fresh re-read, planned-bytes digest match (`loose_sha256` captured by the planner), and authority re-validation. The intent is committed only if **both** gate to `delete`. If either gates to `skip` / `vanished`, no intent is written and **both are retained** (a vanished one side means the pair isn't cleanly removable this run). This preserves PR-2a's invariants: stale/changed bytes are never deleted (digest mismatch → `authority_changed` → no commit), and a `both` / bundle-only member (whose loose path is absent or shadowed) never reaches a committed intent.

### Recovery runs at the start of every archive mutation, under the write lock

`recoverPendingDeletes(cwd)` runs first inside the retention `--write` path (and, later, any archive-mutating verb), under the held write lock: if a journal exists, it completes the unlinks and clears it, so a crashed prior run is healed before the new run plans. Recovery is idempotent and safe to call when no journal exists (no-op).

### Layering (foundation before destructive wiring — see split-destructive-work-into-layers)

1. **Journal + recovery FOUNDATION (this layer):** the journal schema + `writeDeleteIntent` / `readDeleteIntent` / `clearDeleteIntent` primitives + `recoverPendingDeletes` + the gated `deleteLoosePairsJournaled` operation, with the full crash-state-machine proven by tests. **UNWIRED** from the CLI — `state archive-retention --write` still defers every pair (`requires_atomic_pair_removal`) until the wiring layer. So nothing in the destructive CLI path changes yet; this layer cannot run on a real repo.
2. **Reader-awareness:** archive readers (the `resolveArchiveRecordBytes` / enumeration entry points) treat a record named in a pending delete-intent as logically **absent**, so the crash→recovery window is consistent for `validate` / `plan lint` / `doctor` (they never observe the half-deleted intermediate). Until this lands, the foundation stays unwired.
3. **CLI wiring:** `applyArchiveRetention` calls `recoverPendingDeletes` first, then routes loose-loose `would_drop` pairs through `deleteLoosePairsJournaled` instead of deferring them.
4. **Bundle-member pairs:** the `both` / bundle-only pair case — the same pair atomicity plus bundle rebuild + readback-verify + retire-old, journaled the same way.

## Invariants (proven by the foundation layer's tests)

1. **No intent, normal state:** with no journal on disk, recovery is a no-op and the archive is untouched.
2. **Crash after intent written** (before any unlink): recovery completes both unlinks → both gone.
3. **Crash after pack unlinked** (phase still present): recovery completes the phase unlink → both gone (the dangling pack-gone/snapshot-present intermediate is healed).
4. **Crash after phase unlinked** (both gone, intent not cleared): recovery clears the intent → terminal, both gone.
5. **Convergence:** after recovery, the pair is in exactly one of {both deleted, both retained} — never one side. Both-deleted iff the intent was committed before the crash; both-retained iff it was not.
6. **Stale / changed bytes are never deleted:** if either member's on-disk bytes no longer match the digest the plan captured, the gate skips it, no intent is committed, both retained (`authority_changed`).
7. **`both` / bundle-only members are never touched:** a member with no loose copy (or a shadowed/divergent one) gates to `vanished` / `skip`, no intent is committed.
8. **Dry-run and write share one planner authority:** the apply re-runs the planner internally (never a stale dry-run plan); the journal operation consumes that same authority's gated verdicts.
9. **No-overwrite:** a pending (un-recovered) journal blocks a new pair delete — `writeDeleteIntent` refuses to clobber it (`PendingDeleteIntentError`) and `deleteLoosePairsJournaled` preconditions on an absent journal — so a prior crash's recovery authority is never lost; a duplicate `phase_id` batch is rejected before any commit.
10. **Durable commit ordering:** the commit `fsync`s (temp data + parent directory) before any unlink, so a power loss can never leave a member unlinked with no journal — the worst observable post-power-loss state is *both retained*, never one side. (Verified by construction + the fsync-ordering reasoning above; a unit test cannot induce a real power loss.)

## Non-goals (this RFC)

- Running retention `--write` on this repo (the foundation is unwired; nothing is dropped).
- Bundle-only / `both` pair removal (later layer — adds bundle rebuild/verify/retire on top of this).
- Multi-process recovery coordination beyond the existing single write lock (recovery runs under the lock; the out-of-lock external-edit window stays documented out-of-scope, as everywhere else).
