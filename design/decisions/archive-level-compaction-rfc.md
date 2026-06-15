# RFC: Bounded archive — retention + compaction so committed state does not grow forever

**Status:** proposed — design contract. Fixes the model + invariants for keeping `.code-pact/state/archive/` **bounded**: retention/prune (the bound) plus content-addressed bundles (the compaction of the retained set). Implementation ships later in small reviewed layers (reader/binding → bundle writer → gated loose-record deletion → retention/prune), mirroring [event-pack-compaction](event-pack-compaction-rfc.md). No code is authorized by this RFC. (2026-06)
**Scope:** make the committed archive — phase snapshots, event-packs, decision records — **stop growing monotonically with the project's lifetime**. The bound comes from a **retention policy** that drops archive truth a policy no longer keeps; **bundling** then compacts the retained set into few content-addressed files. Defines the retention modes (with a concrete bounded default — `keep-latest 20` — never GC-only or keep-full-only), the bundle format + canonical-bytes hashing, loose∪bundle resolution with **cross-bundle global member uniqueness**, sharding (bounds file *size* within the retained set), and the fail-closed posture. **Not** a per-item record *format* change.
**Owners:** maintainer
**Related:** [event-pack-compaction](event-pack-compaction-rfc.md) (the loose∪pack lifecycle this generalises — reader/binding, writer+readback, the delete-time gate, R0–R5 reconciliation) · [decision-lifecycle](decision-lifecycle-rfc.md) (`decision_retention` / the `PRUNED.md` tombstone — the retention precedent this extends to phases/packs) · [collaboration-safe-state](collaboration-safe-state-rfc.md) (the one-record-per-file ledgers) · [dogfood-durable-truth-migration](dogfood-durable-truth-migration-rfc.md) (the migration that produced 80 archive files and surfaced this) · [control-plane-v2](control-plane-v2-rfc.md) (phase identity bundles bind to).

## Summary

design-docs-ephemeral moved completed phase YAMLs / shipped decision `.md` into `.code-pact/state/archive/` records, and event-pack compaction folded loose per-event files into per-phase packs. Both were necessary but they only **moved the pile**: "many loose docs/events" became "**one archive record per phase / pack / decision**", which still grows **monotonically** — 80 files on this repo today, +1 for every future archive / compact / retire. **A determinism tool whose own committed state grows without bound for the project's lifetime is the problem this RFC must actually fix — not relocate.**

The honest decomposition (a correction to this RFC's first draft, which wrongly claimed bundling alone bounds growth):

- **Bundling does NOT bound file count.** With a per-bundle member cap `C` and `N` retained items, the bundle-file count is `ceil(N / C)` — still O(N). Sharding bounds a single bundle's *size*, never the *count*. Bundling only removes per-item file overhead; it compacts, it does not bound.
- **The bound comes from RETENTION/PRUNE** — dropping archive truth a policy no longer keeps, so the committed archive is O(retention window) instead of O(project lifetime). This is the [decision-lifecycle](decision-lifecycle-rfc.md) `decision_retention` idea, extended to phase snapshots and event-packs.

So the product promise is: **code-pact provides a supported, default-available path to keep committed archive state bounded.** keep-full remains *available* but is **not the only first-class mode**. Retention is the bound; bundling compacts what retention keeps.

## The growth that must stop (measured 2026-06-15)

| level | loose form | first compaction | without retention, grows as | this RFC |
| --- | --- | --- | --- | --- |
| design docs | `design/phases/*.yaml`, `design/decisions/*.md` | archive snapshot / decision record | — (live docs deletable) | — |
| events | `state/events/<at>-<id>.yaml` | event-pack (one/phase) | one pack per archived phase = O(phases) | bundled + retained |
| **archive records** | `state/archive/{phases,event-packs,decisions}/<id>.json` | **none today** | **+1 per phase / pack / decision, O(lifetime)** | **retention bounds it; bundles compact the kept set** |

## Decision

Adopt a **two-part model**: (A) a **retention policy** that bounds *what* the committed archive keeps, and (B) content-addressed **bundles** that compact *the retained set* into few files. (A) is the bound; (B) is the compaction. Both ship; (A) is the part that satisfies "does not grow forever".

### (A) Retention — the bound (central, NOT a non-goal)

`state compact-archive` carries a retention mode; the project may override the default in `project.yaml` (alongside `decision_retention`). **Two categories — do not conflate them:**

**Garbage collection (NOT a bound).** `prune-unreferenced` drops only archive records **no live or archived authority references** (a decision record no `decision_refs`/`acceptance_refs` points at; an event-pack whose phase snapshot is gone; a phase snapshot whose roadmap ref was removed). It is safe (nothing resolves what it drops) but it is **NOT a retention bound**: the migration deliberately *keeps* a roadmap ref to every archived phase, so `roadmap ref → phase snapshot → event-pack` all stay *referenced* — GC drops nothing, and the archive still grows O(project lifetime). GC is a complement to retention, never a substitute, and **never the default**.

**Bounded retention (the actual bound).** A horizon mode keeps only the archive truth inside a window and **drops old AUTHORITIES with their records together** (the roadmap ref + its phase snapshot + the phase's event-pack, as one fail-closed-ordered step), so the committed archive is O(window) regardless of project lifetime:
- `keep-latest N` — keep the N most-recent archived items per kind (the **shipped default**; concrete N pinned below). Always defined (orders by timestamp), so it has no unmapped edge.
- `keep-releases N` — keep the archive truth closed by the last N releases (keys off `CHANGELOG.md` tags; unmapped-item rule pinned below).
- `drop-unmapped` / `--drop-unreferenced-before <date>` — extra horizons, opt-in.

**`keep-full`** — explicit opt-in to unbounded retention (this repo's current `decision_retention` posture for load-bearing RFCs). Allowed, but the operator must ask for it.

A horizon drop never removes a record a **live** task still depends on (that would break a live dep) — runtime-referenced phases are kept even when old; only history beyond the window is forgotten (git is the cold backstop). Retention removal is **fail-closed-ordered**: never drop a record an authority still references; drop the authority (ref) and the record together or not at all.

#### Pinned before the first implementation PR (review P1s — binding)

These three are fixed here so an implementer cannot quietly fall back to "bounded mode exists, but the default is effectively keep-full":

1. **No-config / no-flag default is a real HORIZON bound — `keep-latest 20` — not GC, not keep-full.** With no `project.yaml` retention config and no CLI retention flag, `state compact-archive` defaults to **`keep-latest 20`** (keep the 20 most-recent archived items per kind by their ordering key; forget older history, dropping each old phase's roadmap ref + snapshot + pack together, and old retired-decision records, except anything a live task still depends on). The concrete N is fixed here (`20`) so "bounded-capable" cannot become "effectively keep-full"; a project may raise/lower it or pick `keep-releases N`, and `keep-full` (unbounded) requires an explicit opt-in. The default is NOT `prune-unreferenced` — that is GC and, with kept roadmap refs, a no-op (see the GC note above). Like every code-pact destructive verb, `state compact-archive` is **dry-run by default** (it previews the bounded-retention drop set; `--write` applies), so the bounded default is safe to invoke. The contract: *with no options, `state compact-archive --write` keeps the committed archive at O(20) per kind regardless of project lifetime — it never silently keeps everything.*

2. **Ordering key for `keep-latest N` / `keep-releases N` is fixed per kind** (so "latest" cannot drift): **phase snapshots** order by their recorded `archived_at`; **decision records** by `retired_at`; **event-packs have no independent order — a pack is retained iff its phase snapshot is retained** (it follows its phase, never kept or dropped on its own). `keep-releases N` keys off the release tags in `CHANGELOG.md` (the existing release ledger), mapping each archived item to the release that closed it; items closed by the last N releases are kept. **An archived item that cannot be mapped to a release is KEPT and reported as `unmapped`** — never dropped — unless an explicit `--drop-unmapped` (unsafe) policy is given. (This edge does not affect the default `keep-latest N`, which orders by timestamp and is always defined.)

3. **Retention deletion has a fixed dependency order, gated like event-pack Layer 3.** Drop in this order, re-verifying at each step: **(a)** decision records that no live/archived `decision_refs`/`acceptance_refs` resolves; **(b)** an event-pack only together with (or after) its phase snapshot — never a pack whose snapshot still references it; **(c)** a phase snapshot **and** its roadmap ref together (never a snapshot while the roadmap still points at it, never a roadmap ref while a dependent task resolves the phase). A wrong order leaves dangling truth, so the implementation MUST use a **delete-time ownership gate** (re-check, immediately before each unlink, that nothing still references the record — TOCTOU-safe) and a **post-run reconciliation** pass, at the same granularity as the [event-pack-compaction](event-pack-compaction-rfc.md) Layer 3 G0–G8 gate + R0–R5 reconciliation. Any gate failure → no unlink of that record; report what was skipped (no silent truncation).

### (B) Bundles — compact the retained set

A **bundle** folds N retained per-item archive records of one kind into one content-addressed JSON, resolved as **loose records ∪ bundle members**, exactly as the durable ledger resolves **loose events ∪ packs**. One bundle kind per archive directory (phase-snapshot, event-pack, decision-record). The per-item record format is unchanged — a bundle *contains* records plus an integrity manifest.

**Canonical bytes (pin, P1).** A bundle member's `sha256` is over the member's **canonical serialized bytes = the exact bytes the per-item writer emits** (the existing snapshot / pack / decision-record serializers, which already produce deterministic output: stable key order, fixed 2-space indent, trailing newline — the same determinism `pack-byte-identical` relies on). Hashing the writer's canonical output (not a re-canonicalization, not arbitrary raw bytes) is the single source so newline/key-order/spacing can never drift a hash. A bundle stores each member's canonical bytes verbatim + that `sha256`, plus a bundle-level `member_ids_sha256` over the sorted member-id set.

**Binding (fail-closed, mirrors Tier-1/Tier-2 packs):**
- **Tier-1** (self): schema; per-member id↔canonical-bytes match (recompute `sha256`); sorted; `member_ids_sha256` matches; no duplicate ids *within* the bundle.
- **Tier-2** (per member): each member still binds to its own authority (snapshot→roadmap identity/`path_sha256`; pack→snapshot; decision record→stem/hash). Bundling never weakens per-member integrity.
- A bundle failing either tier is **dropped** by lenient readers (reported issue) and **throws** in strict loaders.

**Cross-bundle global uniqueness (Blocker — must be deterministic).** Across ALL accepted bundles **and loose records** of one kind, a member id resolves to exactly one record:
- same id in two places with **identical `sha256`** → allowed as a redundant duplicate, deterministically deduped (optionally a warning); never ambiguous.
- same id with **different `sha256`** → **fail-closed** `duplicate_member_conflict` (a stale/forked bundle), never "pick one".
- a loose record and a bundle member for the same id must be byte-identical, else `bundle_stale`, fail-closed.

**Sharding (bounds file SIZE within the retained set, not the count).** A bundle has a member cap; beyond it, members shard by a deterministic key (content-hash prefix). Stated honestly: sharding keeps any single bundle small; it does **not** bound the bundle *count* — only retention (A) does.

### Resolution

Every archive reader (`validate`, `plan lint`, `check:docs`, `resolveMissingPhaseRef`, the event-pack binder, decision resolution) resolves an item from **loose record ∪ bundle members**, deduped by id under the cross-bundle uniqueness rule above. The verb `state compact-archive` ships in layers — **(1)** bundle reader + binding (no write), **(2)** bundle writer + readback (no delete), **(3)** gated loose-record deletion, **(4)** retention/prune — each reviewed before the next, per [[split-destructive-work-into-layers]].

## Invariants (binding for the implementation)

1. **Committed archive state is bounded under a bounded retention mode** — O(retention window), not O(project lifetime). Bundling reduces the constant; retention provides the bound. The RFC must not claim bundling alone bounds anything.
2. **The no-flag default is a concrete bounded horizon (`keep-latest 20`)**, not GC (`prune-unreferenced`) and not keep-full; keep-full is an explicit opt-in, never the silent default.
3. **Per-item records are intermediate, not final.** The `<id>.json` form stays valid *input* (loose∪bundle); a bundle is the compact form; tools never assume an item exists only as a loose file.
4. **Gates green after bundling AND after prune** — `validate` + `plan lint --strict` + `check:docs` resolve every still-referenced item; pinned by tests, dogfood-guarded once this repo's archive is bundled/pruned.
5. **Fail-closed binding + global uniqueness** — a bundle is trusted only on full Tier-1 + per-member Tier-2; a different-hash duplicate id is `duplicate_member_conflict`; the [[step4-archive-reader-invariants]] identity discipline applies to bundle members.
6. **Absent dirs are tolerated ONLY as empty stores — a referenced-but-missing item still fails closed.** An absent `state/archive/*` dir (or empty bundle set) resolves as "no archived items", never a crash. **But if a live or archived authority references an item absent from loose records AND all valid bundles, strict gates fail closed** (a real missing-truth fault is never masked by emptiness tolerance).

## Non-goals

- **No per-item record *format* change** — bundles contain records verbatim (canonical bytes); the snapshot / pack / decision-record schemas are frozen here.
- **No automation / scheduling** — `state compact-archive` is operator-invoked, like `state compact`.
- **No change to the event/pack lifecycle below** — event-pack compaction (loose events → pack) is unchanged; this adds the layer above (packs → bundle) and the retention bound.
- **No external/non-git store** — the committed, diffable, content-addressed file model stays; the bound comes from retention, not from moving state out of git.

## Alternatives considered

- **Bundling without retention (this RFC's first draft).** Rejected — `ceil(N/C)` bundle files still grow O(N); it relocates the pile into `bundles/` instead of bounding it. Retention is required.
- **keep-full as the only mode (with bundling).** Rejected — "grows unless you opt out" is the UX the user rejected; a bounded mode must be default-available.
- **One giant bundle per kind.** Rejected — trades file count for unbounded single-file size; sharding + retention is the pair.
- **External datastore.** Rejected — breaks git-tracked, merge-safe, CI-readable committed state.
