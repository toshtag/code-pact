# RFC: Archive-level compaction — the archive must compact too, not just grow

**Status:** proposed — design contract. Fixes the model + invariants for compacting the `.code-pact/state/archive/` records themselves; an implementation ships later in small reviewed layers (reader/binding → bundle writer → gated loose-record deletion), mirroring [event-pack-compaction](event-pack-compaction-rfc.md). No code is authorized by this RFC. (2026-06)
**Scope:** make the per-item archive records — phase snapshots, event-packs, and decision records — **fold into content-addressed bundles** so the archive's *file count* does not grow monotonically with the project's lifetime. Defines the bundle format, loose∪bundle resolution, fail-closed binding, sharding (so a bundle is not itself unbounded), and the prune *capability* (policy is separate). **Not** a new retention policy and **not** a change to the per-item record formats.
**Owners:** maintainer
**Related:** [event-pack-compaction](event-pack-compaction-rfc.md) (the loose∪pack lifecycle this generalises one level up — reader/binding, writer+readback, the delete-time gate G0–G8, R0–R5 reconciliation) · [collaboration-safe-state](collaboration-safe-state-rfc.md) (the one-record-per-file ledgers being folded) · [decision-lifecycle](decision-lifecycle-rfc.md) (decision records / `decision_retention`) · [dogfood-durable-truth-migration](dogfood-durable-truth-migration-rfc.md) (the migration that produced 80 archive files and surfaced this need) · [control-plane-v2](control-plane-v2-rfc.md) (phase identity the bundles bind to).

## Summary

design-docs-ephemeral moved completed phase YAMLs and shipped decision `.md` out of `design/` into `.code-pact/state/archive/` records, and event-pack compaction folded loose per-event files into per-phase packs. That was necessary but **incomplete**: it converted "many loose docs / loose events" into "**one archive record per phase / per pack / per decision**", which still grows **monotonically** — on this repo, after the migration, `.code-pact/state/archive/` holds **46 phase snapshots + 31 event-packs + 3 decision records (80 files)**, and the count rises by one for every future phase archived, phase compacted, and decision retired. **Moving the pile is not the goal; the pile must be compactable.** This RFC fixes that: the **per-item archive record is an intermediate form**, and many records fold into one content-addressed **bundle** via the same loose∪pack discipline event-pack compaction already proved — applied recursively one level up. After bundling, `validate` / `plan lint` / `check:docs` still resolve every item, and no level (loose docs, loose events, loose archive records) grows without bound.

## The growth that must stop (measured 2026-06-15)

| level | loose form | first compaction | still grows as | this RFC adds |
| --- | --- | --- | --- | --- |
| design docs | `design/phases/*.yaml`, `design/decisions/*.md` | archive snapshot / decision record | — (live docs are deletable) | — |
| events | `.code-pact/state/events/<at>-<id>.yaml` (one/event) | event-pack (one/phase) | **one pack per archived phase** | event-pack **bundles** |
| **archive records** | `state/archive/phases/<id>.json`, `event-packs/<id>.json`, `decisions/<stem>-<hash>.json` (one each) | — (none today) | **+1 per phase / pack / decision, forever** | phase-snapshot, event-pack, and decision **bundles** |

The archive-record row has **no second compaction today** — that is the gap. 80 files now; unbounded over the project's life.

## Decision

Adopt **archive bundles**: a content-addressed JSON that folds N per-item archive records of one kind into one file, resolved as **loose records ∪ bundle members**, exactly as the durable ledger resolves **loose events ∪ packs**. The per-item record format is unchanged — a bundle *contains* records verbatim plus an integrity manifest. Three bundle kinds, one per archive directory:

- **phase-snapshot bundle** — N `phases/<id>.json` snapshots.
- **event-pack bundle** — N `event-packs/<id>.json` packs.
- **decision-record bundle** — N `decisions/<stem>-<hash>.json` records.

### Bundle format + binding (fail-closed, mirrors Tier-1/Tier-2 packs)

- A bundle is content-addressed and carries, per member, the member's own id + a `sha256` of its canonical bytes; plus a bundle-level `member_ids_sha256` over the sorted member-id set (the event-pack `event_ids_sha256` analogue).
- **Tier-1** (self): schema, per-member id↔content bijection, no duplicate ids, sorted, `member_ids_sha256` matches.
- **Tier-2** (binding): each member still binds to its own authority (a phase snapshot to its roadmap identity / `path_sha256`; an event-pack to its snapshot; a decision record to its stem/hash) — bundling must not weaken per-member integrity.
- A bundle that fails either tier is **dropped** by the lenient readers (surfaced as an issue) and **throws** in strict loaders — the same fail-closed posture as a bad pack. A member present in BOTH a loose record and a bundle must be byte-identical (else `bundle_stale`, fail-closed).

### Resolution (loose ∪ bundle, live-wins is N/A here — archive only)

Every archive reader (`validate`, `plan lint`, `check:docs`, `resolveMissingPhaseRef`, the event-pack binder, decision-record resolution) resolves an item from **loose record ∪ bundle members**, deduped by id, a bundle member proven by its `sha256`. A loose record always satisfies on its own; a bundle satisfies for members not present loose. This is the [event-pack](event-pack-compaction-rfc.md) loose∪pack rule, lifted to archive records.

### Sharding (a bundle is not itself unbounded)

A single bundle has a **member cap**; beyond it, members shard into multiple bundles by a deterministic key (content-hash prefix, or id range) so neither the file count NOR any single bundle grows without bound — a bounded fan-out (√n-style), not one-giant-file and not one-file-per-item.

### Prune capability (policy separate)

The model MUST **support** dropping a bundle (or a member) whose item is no longer referenced by any live or archived authority — e.g. a decision record superseded past a retention horizon. The **default policy is keep-full** (consistent with this repo's `decision_retention`); prune is opt-in and governed separately. This RFC fixes that prune is *expressible* (bundles are removable, readers tolerate their absence when nothing references the members), not when it runs.

### Compaction verb + destructive deletion (small layers)

A `state compact-archive` step (or an extension of `state compact`) folds loose archive records into bundles, readback-verifies, then **deletes the now-bundled loose records** — the irreversible step, behind a delete-time gate and post-run reconciliation, exactly as event-pack Layer 3. Ships in layers: **(1)** bundle reader + binding (no write), **(2)** bundle writer + readback (no delete), **(3)** gated loose-record deletion. Each layer reviewed before the next, per [[split-destructive-work-into-layers]].

## Invariants (binding for the implementation)

1. **No level grows unboundedly.** Loose docs → records → bundles → sharded bundles; every level has a next compaction, and sharding bounds the last.
2. **Per-item records are intermediate, not final.** The `<id>.json` / `<stem>-<hash>.json` form remains valid *input* (loose∪bundle); a bundle is the compact durable form. Tools must never assume an item exists only as a loose file.
3. **Gates green after bundling.** `validate` + `plan lint --strict` + `check:docs` resolve every phase / pack / decision from bundles after the loose records are deleted — pinned by tests, and dogfood-guarded once this repo's archive is bundled.
4. **Fail-closed binding.** A bundle is trusted only on full Tier-1 + per-member Tier-2; a corrupt / stale / identity-mismatched bundle is dropped (lenient) or throws (strict), never silently accepted — the archive-reader identity discipline ([[step4-archive-reader-invariants]]) applies to bundle members too.
5. **Readers tolerate every shape.** loose-only, bundle-only, loose∪bundle, and **none** (an absent archive dir — the same all-archived/empty edge that broke `check-doc-invariants` in the migration) all resolve without crashing.

## Non-goals

- **No new retention policy** — only the *capability* to prune; when/what to prune is a separate decision (default keep-full).
- **No per-item record format change** — bundles contain records verbatim; the snapshot / pack / decision-record schemas are frozen here.
- **No automation / scheduling** — `state compact-archive` is operator-invoked, like `state compact`.
- **No change to the event/pack lifecycle below** — event-pack compaction (loose events → pack) is unchanged; this adds the layer ABOVE it (packs → pack bundle).

## Alternatives considered

- **Leave the archive as one-file-per-item.** Rejected — it is the "moved the pile" outcome: the archive grows monotonically for the project's life, which is exactly the unbounded-growth the user rejected.
- **One giant bundle per kind (no sharding).** Rejected — trades file-count growth for single-file growth; sharding bounds both.
- **A database / non-file store.** Rejected — breaks the git-tracked, diffable, merge-safe, content-addressed file model the rest of `.code-pact/state` relies on (CI reads the committed tree).
