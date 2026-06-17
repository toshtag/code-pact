# RFC: Bundle-member removal — actually shrink the bundle-backed `would_drop` tail (supersede-by-removal)

**Status:** proposed — design contract. Fixes the mechanism + state machine + layer split for retention to remove a `would_drop` record that lives as a BUNDLE member (or a `both` loose+bundle record), which `state archive-retention --write` currently defers `needs_bundle_member_removal`. This is the FINAL destructive layer of bounded-archive retention. No code is authorized by the design alone; it ships in small reviewed layers. (2026-06)
**Scope:** remove from the content-addressed bundle store the members a retention plan decided to drop. Covers the INDEPENDENT case (a decision member, a phase member with no pack) and the PAIR case (a phase member + its pack member, both-or-neither). It does NOT change the per-item record format, and does NOT touch a live `design/` doc.
**Owners:** maintainer
**Related:** [archive-level-compaction](archive-level-compaction-rfc.md) (the bounded-archive milestone; this completes its §(A) retention for bundle-backed records) · [retention-pair-delete-journal](retention-pair-delete-journal-rfc.md) (the loose-pair journal whose both-or-neither pattern the bundle-pair case reuses) · the shipped bundle primitives `buildArchiveBundle` / `writeArchiveBundle` / `supersedeArchiveBundle` / `verifyBundleReadback` / `retireSupersededBundles` and the `buildCompactionPlan` consolidation (`#467`/`#469`).

## Summary

Retention's loose path is wired (`#476`): `state archive-retention --write` removes loose records and loose `phase_snapshot`↔`event_pack` pairs both-or-neither via the delete-intent journal. But a `would_drop` record whose physical home is a **bundle** (source `bundle`, or `both`) is deferred `needs_bundle_member_removal` — the archive's bundle tail never shrinks. After a healthy store compacts (records → bundles), the OLD unreferenced records that retention should drop live in bundles, so this layer is what actually bounds the steady-state archive.

A bundle is **content-addressed by its member-id SET** (`bundles/<kind>-<idsHash16>.json`). You cannot edit a member out in place — removing a member changes the id set, hence the file. So removal is **supersede-by-removal**: rebuild the kind's consolidated bundle from `(current members − removed)`, write + verify the smaller bundle, then **retire the old** bundle. If the removed set leaves no members, delete the bundle instead of writing an empty one.

## Decision

### Single-kind removal — crash-safe WITHOUT a journal (write-new-then-retire-old)

To remove member ids `R` of one `kind`:

1. Load the kind's bundles STRICT (a corrupt store throws before any write — fail-closed). Gather the surviving member set `S = (∪ all bundle members) − R`. (The members in `R` must actually exist as bundle members and be authority-valid — re-validate, like the loose gate; an `R` id that is not a current bundle member is a no-op, reported.)
2. If `S` is non-empty: `buildArchiveBundle(kind, S)` → write + **verify readback** the new consolidated bundle (content-addressed at `addr(S)`). If `S` is empty: skip the write.
3. **Retire the old bundle(s)** with a removal-aware gate: a bundle is retirable iff **every** member is EITHER covered byte-identically by the new bundle (`addr(S)`) OR in `R`. (This differs from `retireSupersededBundles`'s "fully covered" gate, which would refuse to retire a bundle holding an `R` member — for removal, an `R` member is *meant* to disappear.) The new `addr(S)` bundle is never retired.

**Why this needs no journal:** the removed member stays RESOLVABLE (from the old bundle) until the old bundle is retired — the retire IS the commit. A crash between the new-bundle write and the old-bundle retire leaves BOTH bundles: `S` resolves from both (byte-identical → deduped, valid), and each `R` member still resolves from the old bundle (still present) → the removal simply has not happened yet, and a re-run completes it. No reader ever sees a half-removed record; no reader-awareness is required. (Contrast the loose pair: two unlinks with no surviving authority, hence a journal.)

### Pair removal — both-or-neither across TWO bundles needs a journal

Removing a `phase_snapshot` bundle member AND its `event_pack` bundle member is two single-kind removals, and their two **old-bundle retires are two unlinks → not atomic**. A crash between them retires (say) the pack's old bundle (pack member gone) while the phase's old bundle survives → a snapshot-without-pack dangle (or the mirror). So a bundle-pair removal is committed by a journaled set of retires, reusing the loose pair's pattern: write both new bundles + verify → **journal the intent (the old bundles to retire, the pair id)** as the durable commit → retire both old bundles → clear. `recoverPendingDeletes`-style recovery completes the retires. The loose-only enforcement inverts: a pending BUNDLE-pair intent names ids whose members are bundle-backed, and reader-awareness treats them as logically absent in the crash→recovery window (the old bundle still physically holds them, but the intent says they are being removed).

### Per-record outcome accounting (the `#476` lesson, from the start)

Every removed/retained record reports its OWN outcome — a `would_drop` bundle member becomes `deleted` (its member removed + old bundle retired) or `skipped{reason}` (re-validation failed, a partial store, an empty-set edge, a pair half it could not co-remove). A pair reports each side into its own kind. Never a coarser per-pair or per-bundle approximation.

## Layer split (small reviewed PRs — design reviewed before destructive code)

1. **Removal PLANNER + single-kind PRIMITIVE (foundation, UNWIRED):** `planBundleMemberRemoval(cwd, kind, R)` (read-only: the surviving set, the bundles that would be retired, the empty-set verdict, per-id authority validation) + `removeBundleMembers(cwd, kind, R)` (write-new-then-retire-old, removal-aware retire gate, empty→delete). Crash-safe by construction (no journal). Reuses `buildArchiveBundle` / `writeArchiveBundle` / `verifyBundleReadback`. Tests: a member shrinks the bundle, survivors byte-identical, removed member gone, empty set deletes the bundle, a re-run is idempotent, a crash-simulated double-bundle converges.
2. **Bundle-PAIR removal (journaled both-or-neither):** the two-bundle retire intent + recovery + reader-awareness for pending bundle-pair ids. Reuses the delete-intent journal machinery.
3. **CLI wiring:** route the planner's `needs_bundle_member_removal` `would_drop` records through layer 1 (independent) / layer 2 (pairs); surface `deleted` / `recovered` / per-side outcomes.
4. **Final bounded-archive validation:** on a fixture (and a measured dry-run of this repo), prove the bundle file count AND the unreferenced old-truth tail are bounded — the v2.0 "ゴミが溜まらない" gate.

## Invariants (binding on the implementation)

1. **Truth never half-removed.** Single-kind: the removed member resolves until the old bundle is retired (the commit); a crash leaves it resolvable, a re-run completes. Pair: both-or-neither via the journal.
2. **Fail-closed.** A corrupt bundle store, an `R` id that is not an authority-valid current member, or a partial view → the affected removal is skipped, never a silent or wrong delete. Loads STRICT before any write.
3. **Removal-aware retire is precise.** A bundle is retired only when every member is covered-by-the-new-bundle OR explicitly in `R` — never a bundle holding an un-named member.
4. **Per-record accounting.** Each record reports its own `deleted` / `recovered` / `skipped{reason}`; a pair reports per side into its kind.
5. **No live doc touched; no format change.**

## Non-goals (this RFC)

- Sharding (bounding a single bundle's SIZE) — separate, already noted in the compaction RFC.
- Running retention `--write` on this repo as part of the foundation layers (validation layer 4 measures via dry-run / fixture).
