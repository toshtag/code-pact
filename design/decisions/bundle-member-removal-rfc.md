# RFC: Bundle-member removal — actually shrink the bundle-backed `would_drop` tail (supersede-by-removal)

**Status:** proposed — design contract. Fixes the mechanism + state machine + layer split for retention to remove a `would_drop` record that lives as a BUNDLE member (or a `both` loose+bundle record), which `state archive-retention --write` currently defers `needs_bundle_member_removal`. This is the FINAL destructive layer of bounded-archive retention. No code is authorized by the design alone; it ships in small reviewed layers. (2026-06)
**Scope:** remove from the content-addressed bundle store the members a retention plan decided to drop. Covers the INDEPENDENT case (a decision member, a phase member with no pack) and the PAIR case (a phase member + its pack member, both-or-neither). It does NOT change the per-item record format, and does NOT touch a live `design/` doc.
**Owners:** maintainer
**Related:** [archive-level-compaction](archive-level-compaction-rfc.md) (the bounded-archive milestone; this completes its §(A) retention for bundle-backed records) · [retention-pair-delete-journal](retention-pair-delete-journal-rfc.md) (the loose-pair journal whose both-or-neither pattern the bundle-pair case reuses) · the shipped bundle primitives `buildArchiveBundle` / `writeArchiveBundle` / `supersedeArchiveBundle` / `verifyBundleReadback` / `retireSupersededBundles` and the `buildCompactionPlan` consolidation (`#467`/`#469`).

## Summary

Retention's loose path is wired (`#476`): `state archive-retention --write` removes loose records and loose `phase_snapshot`↔`event_pack` pairs both-or-neither via the delete-intent journal. But a `would_drop` record whose physical home is a **bundle** (source `bundle`, or `both`) is deferred `needs_bundle_member_removal` — the archive's bundle tail never shrinks. After a healthy store compacts (records → bundles), the OLD unreferenced records that retention should drop live in bundles, so this layer is what actually bounds the steady-state archive.

A bundle is **content-addressed by its member-id SET** (`bundles/<kind>-<idsHash16>.json`). You cannot edit a member out in place — removing a member changes the id set, hence the file. So removal is **supersede-by-removal**: rebuild the kind's consolidated bundle from `(current members − removed)`, write + verify the smaller bundle, then **retire the old** bundle. If the removed set leaves no members, delete the bundle instead of writing an empty one.

## Decision

### Single-kind removal — crash-safe WITHOUT a journal, but ONLY with durable barriers

To remove member ids `R` of one `kind`, the durable barrier ORDER is fixed (the `bundles/` directory fsyncs are REQUIRED — a failure is fail-closed, the same `fsyncDirRequired` the loose journal uses):

```
S = (∪ all kind's bundle members) − R     # load STRICT; corrupt store throws before any write
                                           # each R id must be an authority-valid current member, else skip/report

S non-empty:                               S empty (no survivors):
  1. build new bundle bytes (addr(S))        1. (no new bundle)
  2. write temp                              2. re-read old bundle, confirm expected bytes (retire gate)
  3. fsync temp DATA                         3. unlink old bundle(s)
  4. rename temp → bundles/<kind>-<addr(S)>  4. fsync bundles/ DIRECTORY  ← removal durable here
  5. fsync bundles/ DIRECTORY  ← new durable 5. only NOW report deleted
  6. readback + authority verify
  7. re-read old bundle, confirm expected bytes (retire gate)
  8. unlink old bundle(s)
  9. fsync bundles/ DIRECTORY  ← removal durable here
 10. only NOW report deleted
```

The new bundle MUST be durable (steps 2–5) BEFORE any old bundle is retired (step 8) — that ordering is the whole crash-safety argument.

**Why this needs no journal — but ONLY with the fsync ORDERING above.** `writeArchiveBundle` + `verifyBundleReadback` alone are NOT a durable commit (the same `atomic rename ≠ durable` fault [retention-pair-delete-journal](retention-pair-delete-journal-rfc.md) fixed in #474): a power loss could persist the old-bundle unlink while the new-bundle write is lost, dropping the survivors `S` — **truth loss**. So the new bundle MUST be durable (temp-data fsync + parent-dir fsync) BEFORE any old bundle is retired. With that ordering, `new-bundle-durable ≤ any old-retire-durable`, so the removed member stays RESOLVABLE from the old bundle until the retire is durable (the retire IS the commit): a power loss that lost the new bundle also lost the old-retire (it comes after), leaving both bundles — `S` resolves from both (byte-identical → deduped, valid), each `R` member still resolves from the old bundle — the removal simply has not happened, and a re-run completes it. No reader ever sees a half-removed record; no journal / reader-awareness is needed. (Contrast the loose pair: two unlinks with no surviving authority, hence a journal.) **Each directory fsync is a REQUIRED barrier (fail-closed), not best-effort** — distinguishing platform-`unsupported` (defer the removal) from a real `failed` I/O fault, exactly as the loose journal's `fsyncDirRequired` does; a new-bundle / dir-fsync failure stops before any old retire (no removal committed), and an old-unlink-succeeds-but-dir-fsync-fails is NOT reported success (the next run re-observes disk and converges). Because `writeArchiveBundle` is non-durable, this layer adds a **durable bundle write** (its own fsync barriers, or a durable mode on the writer) — the RFC's reuse of `buildArchiveBundle` is for the PURE build only, not the non-durable write.

### The removal-aware retire gate (re-read the planned bytes, like the loose gate)

A bundle is retirable iff **every** member is EITHER covered byte-identically by the new bundle (`addr(S)`) OR explicitly in `R`. This differs from `retireSupersededBundles`'s "fully covered" gate (which refuses to retire a bundle holding an un-covered member), because for removal an `R` member is *meant* to disappear. The new `addr(S)` bundle is never retired. Two more conditions, carrying the loose layer's "delete EXACTLY the planned bytes" discipline to bundle retires:

- immediately before the unlink, **re-read the old bundle's raw bytes** and confirm they still hash to what the plan/proof saw (its `member_ids_sha256` / file digest). An old bundle swapped under us (out-of-lock window, or a concurrent compaction) → skip / fail-closed, never retire on a stale proof.
- the proof is re-derived from the ON-DISK new bundle (fresh read + Tier-1 verify), never a caller-passed map — the same on-disk-authority discipline #467 established for `retireSupersededBundles`.

### Pair removal — both-or-neither across TWO bundles needs a journal

Removing a `phase_snapshot` bundle member AND its `event_pack` bundle member is two single-kind removals, and their two **old-bundle retires are two unlinks → not atomic**. A crash between them retires (say) the pack's old bundle (pack member gone) while the phase's old bundle survives → a snapshot-without-pack dangle (or the mirror). So a bundle-pair removal is committed by a journaled set of retires, reusing the loose pair's machinery: durably write both new bundles + verify → **journal the intent** as the durable commit (the same `fsync`-barriered WAL write) → retire both old bundles → clear. `recoverPendingDeletes`-style recovery completes the retires.

**A bundle-pair intent is a DIFFERENT recovery authority than the loose-pair intent** — it must NOT reuse the loose `{ phase_id, phase_sha256, pack_sha256 }` schema (those are loose-FILE digests). The delete-intent journal gains an `intent_kind` discriminator (`loose_pair` | `bundle_pair`) under a bumped `schema_version`; a single run's journal may carry both kinds, and recovery branches on `intent_kind`. The `bundle_pair` shape (per kind, the old bundle to retire + its expected hash, the new bundle or an empty marker, the removed ids):

```json
{
  "schema_version": 2,
  "intents": [
    {
      "intent_kind": "bundle_pair",
      "phase_id": "P1",
      "members": {
        "phase_snapshot": {
          "removed_ids": ["P1"],
          "old_bundle": { "file": "phase_snapshot-<old16>.json", "sha256": "<digest of old bundle bytes>" },
          "new_bundle": { "file": "phase_snapshot-<new16>.json", "member_ids_sha256": "<addr(S)>" }
        },
        "event_pack": {
          "removed_ids": ["P1"],
          "old_bundle": { "file": "event_pack-<old16>.json", "sha256": "<digest>" },
          "new_bundle": null
        }
      }
    }
  ]
}
```

`new_bundle: null` is the empty-set marker (the kind had no survivors → the old bundle is just deleted, no replacement). `removed_ids` is per kind so a future N-member removal in one bundle is expressible. (Each member's per-kind payload is what recovery needs; the per-kind split also lets reader-awareness hide exactly the named bundle-member ids.)

Recovery, before retiring an old bundle, RE-VERIFIES from disk: the new bundle exists and covers every survivor byte-identically (or the empty-set marker holds and the old bundle still matches its expected hash), and the old bundle still matches the intent's expected hash. Only then does it unlink the old bundle (durably). If a re-verify fails (the store changed under the lock — out-of-scope window, or a corrupt store), recovery is fail-closed (`DELETE_INTENT_RECOVERY_FAILED`), never a guess. **Reader-awareness** for a pending `bundle_pair` intent treats the named members as logically absent in the crash→recovery window — the old bundle still physically holds them, but the intent says they are being removed, so a reader must not resolve them (the inverse of the loose-pair filter, which hides loose ids; here it hides bundle-member ids named in a pending bundle intent).

### `source: "both"` — removing the bundle member is NOT the whole deletion

A `would_drop` record that is `both` (loose copy AND bundle member) is not fully removed by dropping its bundle member — the **loose copy remains**, and readers resolve it (loose-wins), so the old truth still exists. So a `both` record's deletion has two halves: the bundle member (this layer) AND the loose copy (the loose layer, #476). The RFC fixes **Option B (decoupled, report honestly)**: bundle-member removal of a `both` record removes only the bundle member and reports it `bundle_member_removed` (NOT `deleted` — old truth still resolves from loose); on the NEXT retention run the record is `source: loose` and the existing loose retention delete removes it (reported `deleted` then). Option A (delete both copies in one run) is rejected for the foundation: it couples the bundle-removal atomicity with the loose-delete gate + the pair journal in one step, exactly the "too much at once" the layer split avoids; a `both` record converges in ≤ 2 runs, which the bound tolerates. The key invariant: **a record is reported `deleted` ONLY when no copy of it resolves anymore** — a `both` record is never reported `deleted` while its loose copy survives.

### Per-record outcome accounting (the `#476` lesson, from the start)

Every removed/retained record reports its OWN outcome — a `would_drop` bundle-only member becomes `deleted` (its member removed + old bundle retired, no copy resolves); a `both` member becomes `bundle_member_removed` (the bundle half is gone, the loose half remains — see above); a record that cannot be acted on is `skipped{reason}` (re-validation failed, a partial store, an empty-set edge, a pair half it could not co-remove); a recovery-completed bundle-pair retire is `recovered`. A pair reports each side into its own kind. Never a coarser per-pair or per-bundle approximation, and never `deleted` while a copy still resolves.

## Layer split (small reviewed PRs — design reviewed before destructive code)

1. **Removal PLANNER + single-kind PRIMITIVE (foundation, UNWIRED):** `planBundleMemberRemoval(cwd, kind, R)` (read-only: the surviving set, the bundles that would be retired, the empty-set verdict, per-id authority validation) + `removeBundleMembers(cwd, kind, R)` (**durable** write-new-then-retire-old, the removal-aware retire gate with the expected-old-bytes re-read, empty→delete). Crash-safe by construction (no journal) **given the durable barriers** — uses `buildArchiveBundle` for the PURE build + a **durable** bundle write (fsync data + dir, fail-closed, `unsupported`/`failed` split) + `verifyBundleReadback`. Tests: a member shrinks the bundle, survivors byte-identical, removed member gone, empty set deletes the bundle, a re-run is idempotent, a crash-simulated double-bundle converges, a swapped old bundle is not retired (expected-bytes gate), a barrier failure leaves no removal committed (injected fsync failure, like the loose journal's seam).
2. **Bundle-PAIR removal (journaled both-or-neither):** the two-bundle retire intent + recovery + reader-awareness for pending bundle-pair ids. Reuses the delete-intent journal machinery.
3. **CLI wiring:** route the planner's `needs_bundle_member_removal` `would_drop` records through layer 1 (independent) / layer 2 (pairs); surface `deleted` / `recovered` / per-side outcomes.
4. **Final bounded-archive validation:** on a fixture (and a measured dry-run of this repo), prove the bundle file count AND the unreferenced old-truth tail are bounded — the v2.0 "ゴミが溜まらない" gate.

## Invariants (binding on the implementation)

1. **Truth never half-removed, even under power loss.** Single-kind: the new bundle is `fsync`-durable (data + dir) BEFORE any old bundle is retired, so the removed member resolves from the old bundle until the retire is durable (the commit); a crash/power-loss leaves it resolvable, a re-run completes. Pair: both-or-neither via the journaled retires + recovery. `write + verify-readback` is NOT a durable commit — only the `fsync` barriers are (the #474 line).
2. **Durability barriers are REQUIRED, not best-effort.** A directory `fsync` failure is fail-closed (`failed` → the run fails; `unsupported` platform → defer the removal), never swallowed — a swallowed barrier failure reintroduces the truth-loss window.
3. **Fail-closed.** A corrupt bundle store, an `R` id that is not an authority-valid current member, or a partial view → the affected removal is skipped, never a silent or wrong delete. Loads STRICT before any write.
4. **Removal-aware retire is precise + planned-bytes.** A bundle is retired only when every member is covered-by-the-new-bundle OR explicitly in `R`, AND its on-disk bytes still match the plan's expected hash (re-read immediately before the unlink) — never a bundle holding an un-named member, never on a stale proof.
5. **`deleted` means no copy resolves.** A `both` record's bundle-member removal is `bundle_member_removed`, never `deleted` (its loose copy still resolves); it converges to `deleted` on a later run via the loose layer.
6. **Per-record accounting.** Each record reports its own `deleted` / `bundle_member_removed` / `recovered` / `skipped{reason}`; a pair reports per side into its kind.
7. **No live doc touched; no format change.**

## Non-goals (this RFC)

- Sharding (bounding a single bundle's SIZE) — separate, already noted in the compaction RFC.
- Running retention `--write` on this repo as part of the foundation layers (validation layer 4 measures via dry-run / fixture).
