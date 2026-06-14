# RFC: Event-pack compaction lifecycle

**Status:** proposed — design contract only. Review required before Layer 3 (unlink) implementation. This RFC does not authorize any code change; Layer 1/2 already shipped under #425/#426 and are recorded here retroactively. Layer 3 implementation begins only in a separate PR after this RFC is accepted. (2026-06)
**Scope:** the full event-pack compaction lifecycle — Layer 1 (reader / pack binding / evidence resolution, shipped #425), Layer 2 (pack writer / readback-verify / `state compact`, no unlink, shipped #426), and **Layer 3** (loose `unlink` / `cleanup_remaining_loose` / **delete-time ownership gate**, designed here, not yet implemented). The Layer 3 branch truth table and the delete-time ownership gate table are the centrepiece.
**Owners:** maintainer
**Related:** [collaboration-safe-state](collaboration-safe-state-rfc.md) (the one-event-per-file ledger this folds into a pack) · [control-plane-v2](control-plane-v2-rfc.md) (phase identity / `AMBIGUOUS_PHASE_ID` / per-task control plane the gates rely on) · [decision-lifecycle](decision-lifecycle-rfc.md) (the plan→`--write` destructive-verb split this mirrors) · [ci-branch-drift](ci-branch-drift-rfc.md) (committed-ledger precondition; the rev reader shares `bindPackToSnapshot`).

## Summary

A completed, archived phase's progress events live as many loose YAML files (`<at-compact>-<id>.yaml`). Compaction folds them into one durable, content-addressed `event-pack` JSON and — eventually — deletes the loose files. The pack is the durable replacement: Tier-2 binding already proves a pack captures **every** progress event for the phase's tasks (`pack_missing_phase_event`), so deleting the loose copies loses no provenance. The lifecycle ships in three layers so the irreversible step (unlink) lands last, on a reviewed foundation. Layer 1 and Layer 2 shipped; this RFC records them and locks the Layer 3 design before it is built.

## Problem

Layer 3 is the first destructive unlink step in event-pack compaction. Layer 2 (#426) showed that missing branch cells around pack validity, loose-file state, and live-phase discovery cause repeated review churn — four review rounds, each a missed cell. Before any unlink code exists, the project needs a durable design contract that fixes the branch truth table, the delete-time ownership gate, the failure semantics, and the post-run reconciliation rules.

## Decision

Adopt the event-pack compaction lifecycle defined below. Layer 1 remains the reader/binding foundation; Layer 2 remains pack-write + readback with no unlink; Layer 3 may delete loose files ONLY according to the truth table and the delete-time ownership gate in this RFC. The truth table, the G0–G8 gate, the R0–R5 reconciliation, the failure contract, and the test-gap checklist are binding for the later implementation PR.

## Layer scope (what each layer owns)

| Layer | Owns | Destructive? | Status |
| --- | --- | --- | --- |
| **1** | Pack *reader* (Tier-1 self/bijection), Tier-2 *binding* (snapshot identity, completeness, semantic replay), evidence resolution from `loose ∪ pack` | no | shipped #425 |
| **2** | Pack *writer*: `planEventPack` verdict → `applyEventPackPlan` (atomic write under `{kind:"absent"}` + readback re-plan verify); `state compact` CLI; result naming `packed`/`would_pack`/`already_packed` with `cleanup_pending` | no (writes pack; **loose files remain**) | shipped #426 |
| **3** | Loose-file `unlink` after verified coverage (incl. a new task-id owner gate `findLiveTaskOwnersByTaskId`); `cleanup_remaining_loose`; **delete-time ownership gate**; `cleaned`/`already_cleaned` outcomes + `STATE_COMPACT_CLEANUP_FAILED` / `STATE_COMPACT_CLEANUP_INCOMPLETE`; `legacy_progress_retained` + `unclassified_loose_after_cleanup` (advisories, not gates); full E2E | **yes — first unlink** | **designed here, not implemented** |

## Layer 3 truth table — TWO columns: dry-run verdict vs --write terminal outcome

The verdict is the product of four axes. The table is split into **two outcome columns** because Layer 3 conflates them at peril: the **dry-run verdict** (`planEventPack`, no disk mutation) and the **`--write` terminal outcome** (after the unlink runs) are *different states*. Layer 2's `--write` left `cleanup_pending:true` because it never deleted; Layer 3's successful `--write` finishes the job, so it lands on `cleanup_pending:false` / `cleanup_remaining_loose:0` (with `loose_deleted_count > 0` in the normal case — but the all-vanished edge below completes as `cleaned` with `loose_deleted_count:0`). A single column would let an implementer return a `cleanup_pending:true` outcome after a successful unlink — exactly the bug this split prevents.

**Result-name discipline (locked):** Layer 2's pack-write success is `packed`. Layer 3's **cleanup-complete** success is a DIFFERENT name — **`cleaned`** (chosen over `compacted` to avoid implying "compaction = packing"; `cleaned` reads as "loose files removed"). NEVER reuse `packed` for a cleanup-complete result.

**`cleaned` semantics (the success terminal — precise):** `cleaned` means the cleanup phase RAN and post-run reconciliation found **zero present in-scope survivors** — NOT literally "all targeted loose deleted". Normally at least one loose file was unlinked (`loose_deleted_count > 0`, `partial_applied:true`). But an **all-vanished race** is also `cleaned`: every targeted loose file disappeared (external `rm` / crash) before the unlink could remove it, so `loose_deleted_count:0`, `vanished_count > 0`, `cleanup_remaining_loose:0`. In that race `partial_applied` is `false` when no pack was written this run (the run mutated nothing) or `true` when the pack WAS written this run (the cell-10 path). The binding invariant: **`cleaned` ⇒ `cleanup_started:true` ∧ `cleanup_remaining_loose:0` ∧ (`loose_deleted_count > 0` ∨ `vanished_count > 0`)**; `partial_applied` tracks ANY filesystem mutation (pack write OR unlink), exactly as on the failure rows — it is NOT fixed `true`. (The `CleanupOutcome` type pairs `partial_applied`↔`loose_deleted_count` via `CleanupMutationProgress` so `partial_applied:false` with files deleted cannot type-check, while the all-vanished `partial_applied:false`/`loose_deleted_count:0` is representable; `vanished_count > 0` on that arm is a runtime invariant TS cannot express.)

**Axes**

- **live-discovery**: `absent` / `present` / `ambiguous` (dup phase id) / `discovery_incomplete` (a phase YAML cannot be read/parsed/resolved)
- **snapshot**: `missing` / `invalid` / `evidence_broken` / `valid`
- **target-pack**: `none` (ENOENT) / `Tier-1-bad` (JSON/schema/order/sha256-self) / `Tier-2-bad` (snapshot_sha256 / task_id_not_in_snapshot / semantic_replay_conflict / pack_missing_phase_event / evidence_unresolved) / `valid`
- **loose** (count of loose files for the snapshot's task_ids): `0` / `full` (== pack's id set) / `stale` (hash ≠ pack, neither subset nor empty) / **`subset-after-partial-cleanup`** (a strict, non-empty subset of the pack's id set — every remaining loose id IS in the pack, but some are gone)

Ordering note (load-bearing, from #426's four rounds): the gates are evaluated **in this order** — live-discovery → snapshot read → **target-pack Tier-1** → durable sources → loose set → **target-pack Tier-2 binding** → evidence → existing-pack hash branch. A corrupt *target* pack must win as `pack_invalid` **before** the evidence check, or the cause is mis-reported as `snapshot_evidence_broken`.

| # | live-disc | snapshot | target-pack | loose | **dry-run verdict** (`kind` / `block.kind`, `cleanup_pending`, `unlink_allowed`) | **--write terminal outcome** (`kind`, exit, `cleanup_pending`, `loose_deleted_count`, `cleanup_remaining_loose`) | fail-closed reason / pin |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | present | * | * | * | `ineligible`/`phase_file_still_present`, —, **no** | `ineligible`, exit 2, —, 0, — | live phase YAML exists — compact follows archive; pin: "phase YAML still present" |
| 2 | ambiguous | * | * | * | `ineligible`/`ambiguous_phase_id`, —, **no** | `ineligible`, exit 2, —, 0, — | dup phase id = control-plane corruption; pin: "duplicate phase id in roadmap" / "TWO orphan live YAMLs" |
| 3 | discovery_incomplete | * | * | * | `ineligible`/`phase_discovery_incomplete`, —, **no** | `ineligible`, exit 2, —, 0, — | a phase file unreadable/unparseable — cannot prove no live phase owns the id; pin: "unreadable (not a dir)" / "single unparseable phase YAML" |
| 4 | absent | missing | * | * | `ineligible`/`snapshot_missing`, —, **no** | `ineligible`, exit 2, —, 0, — | no archived snapshot to bind to; pin: "no snapshot" |
| 5 | absent | invalid | * | * | `ineligible`/`snapshot_invalid`, —, **no** | `ineligible`, exit 2, —, 0, — | snapshot corrupt — read **before** pack/evidence; pin: "corrupt snapshot". *(gap: snapshot=invalid + pack=valid ordering)* |
| 6 | absent | valid | Tier-1-bad | * | `ineligible`/`pack_invalid`, —, **no** | `ineligible`, exit 2, —, 0, — | *target* pack failed Tier-1 — diagnosed before evidence; pin: "existing pack fails Tier-1" / "CORRUPT target pack + zero loose" |
| 7 | absent | valid | Tier-2-bad | * | `ineligible`/`pack_invalid`, —, **no** | `ineligible`, exit 2, —, 0, — | target pack Tier-1-valid but binding failed; pin: "snapshot_sha256 mismatch + zero loose" / "foreign task_id + zero loose" |
| 8 | absent | evidence_broken | none | full | `ineligible`/`snapshot_evidence_broken`, —, **no** | `ineligible`, exit 2, —, 0, — | snapshot evidence does not resolve from `loose ∪ packs`; pin: "snapshot evidence unresolvable (loose done hand-deleted)" |
| 9 | absent | valid | none | 0 | `noop_no_events`, `cleanup_pending:false`, **no** | `noop_no_events`, exit 0, `cleanup_pending:false`, `loose_deleted_count:0`, `cleanup_remaining_loose:0` | archived phase with no events (attested / pre-event); pin: "zero loose events, no pack" |
| 10 | absent | valid | none | full | `would_pack_and_cleanup`, `cleanup_pending:true`, **yes** | **(write step first)** if pack write/readback fails → `STATE_COMPACT_WRITE_FAILED`, exit 2, `phase` field (Layer 2's existing field name, value `write_pack\|verify_pack`), `partial_applied:` **inherited** (`write_pack`→false, `verify_pack`→true), `cleanup_started:false`, `loose_deleted_count:0`, `pack_path` included, **no unlink attempted**. **(write OK, cleanup step)** all gated files unlinked → `cleaned`, exit 0, `cleanup_pending:false`, `loose_deleted_count:N` (NORMAL PATH; `0` if every target vanished before unlink — still `cleaned`, see the `cleaned` semantics note above), `cleanup_remaining_loose:0`; any G-skip/abort → failure contract (exit 2) | canonical compact: build+verify pack (Layer 2 step) **then** Layer 3 unlinks each gated loose; the two steps fail with **different** codes (WRITE vs CLEANUP); pins: "snapshot + loose, no pack" + Layer-2 write-fail pins (both `write_pack` and `verify_pack`) + a new cleaned-to-zero E2E |
| 11 | absent | valid | valid | 0 | `noop_already_cleaned`, `cleanup_pending:false`, **no** | `already_cleaned`, exit 0, `cleanup_pending:false`, 0, 0 | pack present, no loose left — fully compacted; pin: "valid pack + ZERO loose" (rename outcome from Layer 2's `already_packed`/`cleanup_pending:false`) |
| 12 | absent | valid | valid | full | `would_cleanup_loose`, `cleanup_pending:true`, **yes** | **`cleaned`, exit 0, `cleanup_pending:false`, `loose_deleted_count:N` (normal path; `0` if all vanished first — still `cleaned`), `cleanup_remaining_loose:0`** (any G-skip → exit 2 per failure contract) | pack matches loose set exactly; Layer 3 finishes cleanup; pin: "valid pack + loose remain + matching hash" + a new cleaned-to-zero E2E |
| 13 | absent | valid | valid | stale | `ineligible`/`pack_stale`, —, **no** | `ineligible`, exit 2, —, 0, — | pack's `event_ids_sha256` ≠ loose set and loose is **not** a subset — edited/added out of band; never unlink against a stale pack; pin: "valid pack + loose remain + hash differs". **Reachability:** see note below — if a loose event for a snapshot task is NOT in the pack, Tier-2 `pack_missing_phase_event` fires first → axis target-pack becomes `Tier-2-bad` → **cell 7** `pack_invalid`, not here |
| 14 | absent | valid | valid | **subset-after-partial-cleanup** | **`would_resume_cleanup`**, `cleanup_pending:true`, **yes (only surviving loose ids the pack covers)** | **`cleaned`, exit 0, `cleanup_pending:false`, `loose_deleted_count:M` (normal path, M = surviving loose; `0` if those all vanished first — still `cleaned`), `cleanup_remaining_loose:0`** (any G-skip → exit 2) | a prior unlink ran partially (crash / external `rm` / interrupted). Every remaining loose id is in the pack → safe to **resume**. NOT `pack_stale` (subset, not divergence). Gate re-checks each survivor. **NEW branch — see below.** |

**Cell 14 is the Layer-3-specific addition.** In Layer 2's current code a non-empty subset hashes differently from the full pack set and falls into the `pack_stale` branch (step 8, `existing.pack.event_ids_sha256 !== expected`). That is correct *for Layer 2* (it never deletes, so any loose ≠ pack is suspicious). **Layer 3 must distinguish a true subset (resumable cleanup) from genuine staleness (divergence):**

> **Decision for cell 14:** Layer 3 classifies the existing-pack + loose branch by *set relationship*, not just hash equality:
>
> - loose id-set **== pack id-set** → dry-run `would_cleanup_loose`, unlink all (cell 12).
> - loose id-set **⊊ pack id-set** (strict, non-empty subset; every loose id ∈ pack) → dry-run **`would_resume_cleanup`**: unlink only the surviving loose files the pack covers (cell 14). `--write` success → `cleaned`, `cleanup_remaining_loose:0`.
> - loose id-set **⊄ pack id-set** (any loose id NOT in pack, or hash diverges with a non-subset) → `pack_stale`, **no unlink** (cell 13).
> - loose **== ∅** → already cleaned (cell 11).
>
> This is the single most important new branch and the one with **zero current test coverage** — it must ship with pins for all four relationships.

**Cell 13 reachability (when `pack_stale` actually wins over `pack_invalid`).** Tier-2 binding's completeness rule (`pack_missing_phase_event`) checks the *opposite* direction from cell 13's hash check: it fires when a **loose** event for a snapshot task is **not in the pack**. So if the divergence is "loose has an event the pack lacks", binding catches it first → target-pack is `Tier-2-bad` → **cell 7 `pack_invalid`**. `pack_stale` (cell 13) is therefore reserved for divergence that **survives Tier-2 binding** yet fails the id-set hash equality — concretely, the *pack* references the snapshot cleanly and contains a superset, but the loose set's `computeEventIdsSha256` differs and the loose set is neither the full pack set (cell 12) nor a strict subset of it (cell 14). The narrowest real case: the pack is a strict **superset** of the current loose (loose lost a file the pack still holds *and* gained nothing) — which is exactly cell 14's subset relationship, so genuinely divergent (non-subset, non-equal, binding-passing) loose is a thin, mostly **defensive / diagnostic** branch. **Test expectation:** the Layer 3 PR constructs a concrete reachable fixture if one exists; otherwise it labels cell 13 a defensive branch in the test file and does not assume ordinary flows hit it.

## Delete-time ownership gate table

Layer 3 deletes, so it **re-verifies ownership immediately before each irreversible unlink** — validator-time / plan-time checks are NOT trusted to still hold (TOCTOU). This mirrors the producer's own fail-closed discipline in `phase-snapshot.ts:356-382` ("never assume lint/doctor's `DUPLICATE_TASK_ID` ran first" — the writer re-checks itself). Each loose file is unlinked **only if every check passes**; **any** failure → no unlink of that file, and the run reports what it skipped (no silent truncation).

Three failure dispositions, distinguished per check:

- **abort** — a global safety signal that invalidates the *whole* run (the pack / snapshot / control-plane is no longer trustworthy). Stop immediately; unlink no further files. Terminal error code `STATE_COMPACT_CLEANUP_FAILED`.
- **skip** — this *one* file cannot be proven safe to delete, but the run can continue with the others. The file **still exists** and is counted in `cleanup_remaining_loose`. Record the reason; never unlink it.
- **vanished** — the file is already gone (ENOENT at re-read). It is **not** a survivor: not unlinked by us, not counted in `cleanup_remaining_loose`. Counted only in an optional `vanished_count`. Distinct from skip because "already absent" must not inflate the remaining count (the result JSON would otherwise claim a file remains that does not).

**Symlink / no-follow contract (and its honest limit).** G1/G3b read and verify the loose file through a helper — call it `readRegularEventFileNoSymlink(path)` — that: (1) `lstat`s the path immediately before reading and rejects anything that is not a regular file (symlink / dir / fifo / device → `skipped:not_regular_file`); (2) opens with `O_NOFOLLOW`-equivalent semantics where the platform supports it (Node `fs.open` with `O_NOFOLLOW`), so a symlink at the final component fails the open rather than reading its target; (3) where `O_NOFOLLOW` is unavailable, re-`lstat`s after the read and requires the same inode/ident, treating a mismatch as `skipped:not_regular_file`. **This is best-effort against accidental symlinks and benign races — it is NOT a defense against a hostile local filesystem racing the cleanup.** The RFC states that limit explicitly so the gate is not mistaken for a security boundary; the operator running `state compact --write` is trusted, and the threat model is accidental corruption / concurrent honest writers, not an attacker with write access to `.code-pact/state/`.

For each loose file `f` about to be unlinked:

| # | check | how | must hold | disposition on failure | any unlink yet? |
| --- | --- | --- | --- | --- | --- |
| G0 | **plan still valid** | re-run `planEventPack` under the write lock; verdict is `would_cleanup_loose`/`would_resume_cleanup` (a valid, bound pack with `cleanup_pending:true`) | a valid, bound pack covers the phase | **abort** the whole run; unlink **nothing** | no |
| G1 | **path resolves within project AND is a regular file** | `resolveWithinProject(cwd, eventsDir/f)`, then `lstat` (no symlink follow) via the `readRegularEventFileNoSymlink` contract above | `f` is under `.code-pact/state/events/`, no symlink escape, and is a regular file | **skip** `f`, record `skipped:path_escape` (escape) or `skipped:not_regular_file` (symlink/dir/special) | possibly (earlier files) |
| G2 | **expected path shape** | `f`'s name parses as `<at-compact>-<id>.yaml` (`parseEventFileName`) | the file is a real event file, not a stray | **skip** `f`, record `skipped:not_event_file` | possibly |
| G3a | **still present** | `lstat`/`readFile` ENOENT at re-read time | — (allowed to be gone) | **vanished**: do not unlink, do not count as remaining; `vanished_count += 1` | possibly |
| G3b | **re-readable & a regular file** (re-assert G1 at read time, no symlink follow) | `readRegularEventFileNoSymlink(f)` *now*, not the plan-time copy | the surviving file is readable and still a regular file | **skip** `f` (it still exists but cannot be proven safe), record `skipped:unreadable` / `skipped:not_regular_file` | possibly |
| G4 | **event id recomputes** | parse `content`, then `computeEventId(parsed) === idFromFilename` | content ↔ filename ↔ id bijection still holds (not swapped/tampered since plan) | **skip** `f`, record `skipped:parse_failed` (content is not a parseable event) **or** `skipped:id_mismatch` (parsed, but recomputed id ≠ filename id) — distinct because operator recovery differs (fix/remove a corrupt file vs investigate a swapped one) | possibly |
| G5 | **task_id ∈ archived snapshot task set** | `snapshot.tasks` (the snapshot bound in G0) contains `event.task_id` | the event belongs to *this* archived phase | **skip** `f`, record `skipped:task_not_in_snapshot` | possibly |
| G6 | **no LIVE phase OWNS the task_id** (see "G6 deep-dive") | a NEW gate `findLiveTaskOwnersByTaskId(cwd, event.task_id)`: scan **every** `design/phases/*.yaml`, parse each phase's `tasks[].id`, and report any live phase whose task array contains `event.task_id` — NOT `phaseFileStillPresent` (that finds phase-**id** owners, a different thing) | no live phase's task array claims `event.task_id` | **abort** (a live phase re-uses this task_id ⇒ the loose event may still be live ⇒ corruption). Also **abort** on any unreadable / unparseable / path-escape / ambiguous scan result (fail closed) | possibly |
| G7 | **verified pack contains the same event id** | the pack bound in G0 has an entry whose `id === f`'s id (Tier-2 completeness proved superset; re-assert per file) | the durable replacement provably holds this exact event | **abort** with block `pack_stale_after_cleanup` (`STATE_COMPACT_CLEANUP_FAILED`) — a present loose file the pack does NOT cover means the pack no longer matches the live loose set; this is a coverage failure, not a per-file skip. Unlink no further files | possibly |
| G8 | **pack still bound to current snapshot** | the G0 pack's `snapshot_sha256 === sha256(current snapshot bytes)` | pack and snapshot have not diverged since plan | **abort**; unlink no further files | possibly |
| — | **all G0–G8 pass** | — | — | **`unlink(f)`** — the only place a file is removed | yes, this file |

### Final reconciliation step (after the unlink loop, before returning)

The per-file gate alone is not enough: between plan and the end of the loop the events dir can gain a file (a concurrent writer appends a new event) or a deleted file can be re-created with different content. Such a **survivor never went through the gate**, so it has no skip record — and the result JSON would otherwise report `cleanup_remaining_loose > 0` with an empty `skipped[]`, or silently ignore it. The reconciliation step closes that gap. It runs **after** the unlink loop and is the single authority for the returned counts.

```
R0. Build the post-run reconciliation CANDIDATE SET, then re-enumerate it from disk (the
    post-run on-disk truth — never the plan-time list). A post-run loose file is IN-SCOPE
    for THIS phase's cleanup iff ANY of:
      (i)   its path or filename-embedded id was in the ORIGINAL CLEANUP TARGET SET —
            defined as the loose file paths / event ids selected by the G0 re-plan run
            under the write lock IMMEDIATELY before the unlink loop, NOT an earlier dry-run
            or any pre-lock plan (a stale pre-lock target could name files a concurrent
            writer has since changed);
      (ii)  its filename-embedded event id is in the verified pack;
      (iii) its content is parseable AND event.task_id ∈ the archived snapshot task set;
      (iv)  it already carries a skip record from the unlink loop.
    This set is the union — it deliberately does NOT require "read + parse + id-recompute"
    (which an unreadable file fails), because (i)/(ii)/(iv) key on the FILENAME or a prior
    record, not the content. So an unreadable file whose FILENAME id ties it to this pack/
    target is in-scope (caught by R1.0); a stray unreadable file with no such tie is NOT
    this phase's survivor (handled by R1.X below). Files outside the candidate set are
    never counted in this phase's cleanup_remaining_loose.
R1. For each PRESENT in-scope candidate s, evaluate IN THIS ORDER. The id-unverifiable
    case (R1.0) comes FIRST because the later branches all key on s's recomputed event id;
    pack-coverage (R1.1) comes BEFORE the skip-record branch because a not-covered survivor
    is a coverage failure regardless of any earlier per-file skip reason:
    0. s is in-scope (its FILENAME id ties it to this pack/target, or it has a prior skip
       record — R0 (i)/(ii)/(iv)) BUT its current content cannot be read / parsed /
       regular-file-verified / id-recomputed (it changed since the loop and its content id
       is UNKNOWN — e.g. a malformed `.yaml`, a symlink, an unreadable file at a path the
       pack/target names):
                                   → record the matching reason —
                                     skipped:not_regular_file_after_cleanup /
                                     skipped:unreadable_after_cleanup /
                                     skipped:parse_failed_after_cleanup /
                                     skipped:id_unknown_after_cleanup;
                                     contributes to STATE_COMPACT_CLEANUP_INCOMPLETE
                                     (NOT _FAILED — we cannot prove the pack fails to
                                     cover it, only that we cannot classify/remove it
                                     safely); cleanup_remaining_loose includes s; continue.
    1. s's current event id is known AND is NOT in the verified pack
                                   → terminal STATE_COMPACT_CLEANUP_FAILED with block
                                     pack_stale_after_cleanup (the pack no longer covers
                                     the live loose set). This wins over any skip record
                                     s may already carry (e.g. a G-skip on the same file).
    2. else s already has a skip record  → keep that reason; contributes to
                                     STATE_COMPACT_CLEANUP_INCOMPLETE.
    3. else (no skip record, id IS in the verified pack)
                                   → record skipped:appeared_during_cleanup (a
                                     gate-bypassing file the pack still covers);
                                     contributes to STATE_COMPACT_CLEANUP_INCOMPLETE.
    (Note: G7 already aborts a not-in-pack file it reaches during the loop. R1.1 is the
    backstop for a survivor that appeared AFTER its position in the loop, so the in-loop
    gate never saw it. Both paths land on the same pack_stale_after_cleanup verdict. R1.0
    is the backstop for a survivor whose id cannot even be computed — without it, an
    id-unknown survivor would match none of R1.1–R1.3, breaking the "every present
    survivor is in skipped[]" invariant.)
    Optional sharpening: if the survivor's FILENAME-embedded id is parseable and clearly
    NOT in the pack (even though the content id cannot be recomputed), the implementation
    MAY promote it to R1.1 (pack_stale_after_cleanup / CLEANUP_FAILED). Default is the
    conservative R1.0 classification.
R2. cleanup_remaining_loose = count of present IN-SCOPE survivors after R1.
    Vanished files (ENOENT, G3a) are EXCLUDED here and counted only in vanished_count.
R3. Success (`cleaned` / `already_cleaned`, exit 0) is allowed ONLY when
    cleanup_remaining_loose === 0 AND no abort occurred AND no present in-scope survivor
    remains.
R4. skipped[] corresponds to PRESENT in-scope survivors only. Vanished files never appear.
R5. OUT-OF-SCOPE event-looking files (in `.code-pact/state/events/` but matching NO R0
    candidate clause — parseable with a task_id NOT in this snapshot AND filename id NOT in
    the verified pack; or unverifiable with no filename/skip-record tie to this pack/target):
    these are NOT this phase's cleanup survivors. POLICY (locked, not implicit):
      → do NOT count them in cleanup_remaining_loose;
      → emit a GLOBAL advisory in an `advisories[]` array on the result —
        `advisories: [{ code: "unclassified_loose_after_cleanup", path: "<rel-path>" }]`
        (a hint that the events dir holds a file no phase cleanup owns — a state anomaly to
        investigate); `advisories[]` is present on success results too (empty when none);
      → the advisory does NOT affect this run's exit code or `kind` (a clean cleanup of
        the in-scope set still returns `cleaned`/exit 0 with the advisory attached).
    Rationale: mixing another phase's (or a stray) broken file into THIS phase's
    cleanup_remaining_loose would make the result JSON lie about what this compaction left
    behind. The anomaly is surfaced, but as a separate global signal, never as a phase
    survivor.
```

This makes `cleanup_remaining_loose`, `skipped[]`, and `vanished_count` mutually consistent by construction: **every** present survivor is in `skipped[]` — including one whose id cannot be computed (R1.0), so there is no "present but unclassified" hole — nothing in `skipped[]` is absent, and the success condition is exactly "zero present survivors, no abort". A present-but-uncovered survivor with a KNOWN id is always `pack_stale_after_cleanup` (`CLEANUP_FAILED`), never downgraded by a stale skip record; a present survivor with an UNKNOWN id is `CLEANUP_INCOMPLETE` (we cannot prove non-coverage, only that we cannot safely classify/remove it).

### G6 deep-dive — task-id owner discovery, NOT phase-id discovery

The eligibility gate (`phaseFileStillPresent`, truth-table axis 1) answers *"is there a live phase YAML whose **id** is `<phaseId>`?"*. G6 answers a **different** question: *"does any live phase, **regardless of its phase id**, own this **task_id** in its task array?"*. The hazard if conflated (concrete):

```
archived snapshot   P42  owns task_id T1   (loose event file carries task_id T1)
some LIVE phase     P99  has tasks: [{ id: T1 }]   ← a re-used task_id
```

`phaseFileStillPresent("P42")` finds nothing live for **P42** → eligibility passes. But `T1` is live under **P99**, so the loose `T1` event must **not** be unlinked. Only a task-id-keyed scan catches this. The new gate:

- scans **all** `design/phases/*.yaml` (the same dir-walk `findLivePhaseYamlsById` uses);
- parses each as a `Phase`, reads `tasks[].id`;
- **fails closed** on any file that is unreadable / unparseable / escapes the project (a hidden file could be the live owner) — same posture as `findLivePhaseYamlsById`'s `discovery_incomplete`;
- treats ambiguity (the task_id appears in >1 live phase, or in both a live phase and the archived snapshot's *other* live siblings) as fail-closed **abort**;
- relies on global `DUPLICATE_TASK_ID` uniqueness as the *invariant*, but **re-checks it here** rather than assuming lint/doctor enforced it (the `phase-snapshot.ts:356-382` precedent: the writer never trusts a prior check before an irreversible act).

### Delete-time gate failure contract (public, locked)

The unlink is irreversible, so "what got deleted, what remained, did the command succeed" is a hard public contract — not left to the implementer.

`partial_applied` and `cleanup_started` are emitted on EVERY result (success, error, AND ineligible), so a consumer can read them unconditionally. Concrete values: `cleaned` → `cleanup_started:true` (the cleanup ran), `partial_applied:true` when this run mutated the tree (a pack write OR ≥1 unlink) and `false` ONLY in the all-vanished edge (no pack write this run + every target vanished before unlink); `already_cleaned` and `noop_no_events` → both `false` (nothing was mutated); **every pre-write / pre-cleanup `ineligible` outcome** (cells 1–8, 13) → `partial_applied:false` / `cleanup_started:false` / `loose_deleted_count:0` (the run stopped before the pack write step, so nothing on disk changed).

Three distinct error codes — the operator's next action differs per code, so they must not be merged:

- **`STATE_COMPACT_WRITE_FAILED`** — the **pack write / readback verify failed BEFORE cleanup started** (`cleanup_started:false` — no unlink ever ran). This is Layer 2's existing error, reached on the cell-10 path when the pack step fails. **`partial_applied` is NOT fixed false** — it is inherited from `EventPackWriteError.partial_applied`, which is already distinct in the shipped code: `write_pack` failure ([event-pack.ts:507](../../src/core/archive/event-pack.ts)) → `partial_applied:false` (pack never reached disk); `verify_pack` failure ([event-pack.ts:524/531/542](../../src/core/archive/event-pack.ts)) → `partial_applied:true` (the pack IS on disk and Layer 2 does not auto-remove it). The error data carries the existing `phase` field (value `write_pack`|`verify_pack` — NOT a new `write_phase` field; Layer 3 reuses Layer 2's field name) and `pack_path` so the operator can locate the bad pack — exactly what [state.ts:124–130](../../src/cli/commands/state.ts) already emits (`phase: err.phase`). Next action: inspect/remove the bad pack (esp. on a Layer-2 `verify_pack` readback failure, where the pack IS on disk), re-run. **Layer 3's orchestrator also returns `verify_pack` when it wrote + verified the pack but the post-write pre-cleanup re-prepare then failed (snapshot corrupted / a live phase reappeared / the pack was removed) — there `partial_applied:true` records the pack-step mutation, but the pack may NO LONGER be present, so a `next_action` must not assume it can be inspected.**
- **`STATE_COMPACT_CLEANUP_FAILED`** — a **global cleanup safety gate aborted** the run (G0 stale plan, G6 live task-id owner reappeared, G8 pack/snapshot divergence), **or** reconciliation R1 found a present survivor the pack no longer covers (`pack_stale_after_cleanup`). The *environment* changed under the cleanup. Next action: resolve the conflict (the live phase / the divergent snapshot / the out-of-band loose file), then re-run.
- **`STATE_COMPACT_CLEANUP_INCOMPLETE`** — the run **completed but ≥1 present survivor remains** — either gate-skipped, or a gate-bypassing file the pack still covers (reconciliation `appeared_during_cleanup`). Not a corruption; specific files could not be removed. Next action: read `skipped[]`, fix each, re-run.

| terminal state | exit | `kind` / block | `cleanup_pending` | `partial_applied` | `cleanup_started` | `loose_deleted_count` | `cleanup_remaining_loose` | `vanished_count` | error code | `skipped[]` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **cleanup ran, zero in-scope survivors — normal (≥1 unlinked)** | 0 | `cleaned` | false | **true** | true | N (>0) | 0 | ≥0 | — | [] |
| **cleanup ran, zero survivors — ALL-VANISHED race (0 unlinked)** | 0 | `cleaned` | false | **true iff a pack was written this run, else false** | true | 0 | 0 | >0 | — | [] |
| **already clean before run** | 0 | `already_cleaned` | false | **false** | false | 0 | 0 | 0 | — | [] |
| **no events to compact** (cell 9) | 0 | `noop_no_events` | false | **false** | false | 0 | 0 | 0 | — | [] |
| **pre-write/pre-cleanup ineligible** (cells 1–8, 13: `phase_file_still_present` / `ambiguous_phase_id` / `phase_discovery_incomplete` / `snapshot_missing` / `snapshot_invalid` / `pack_invalid` / `snapshot_evidence_broken` / `pack_stale`) | 2 | `ineligible` / block-specific | per existing CLI contract | **false** | **false** | 0 | — | 0 | `STATE_COMPACT_INELIGIBLE` (existing) | — |
| **`write_pack` failed** (cell 10; pack never on disk) | 2 | (error) | true | **false** | **false** | 0 | (all loose) | 0 | `STATE_COMPACT_WRITE_FAILED` (`phase:write_pack`, `pack_path` set) | — |
| **`verify_pack` failed** (cell 10; pack ON disk for a Layer-2 readback fail, OR pack-step done then the post-write re-prepare failed — pack may be gone) | 2 | (error) | true | **true** | **false** | 0 | (all loose) | 0 | `STATE_COMPACT_WRITE_FAILED` (`phase:verify_pack`, `pack_path` set) | — |
| **cleanup gate aborted before any unlink** (G0/G6/G8 on file 1) | 2 | (error) | true | **false** | **true** | 0 | (loose still present) | ≥0 | `STATE_COMPACT_CLEANUP_FAILED` | — |
| **cleanup gate aborted after some unlink** (G6/G7/G8 mid-run) | 2 | (error) | true | **true** | **true** | N (so far) | (still present) | ≥0 | `STATE_COMPACT_CLEANUP_FAILED` | — |
| **reconciliation: survivor NOT in pack** (R1.1, `pack_stale_after_cleanup`) | 2 | (error) `pack_stale_after_cleanup` | true | true iff ≥1 unlink | **true** | N | ≥1 | ≥0 | `STATE_COMPACT_CLEANUP_FAILED` | populated |
| **run completed, ≥1 present in-scope survivor** (gate-skip, reconciliation `appeared_during_cleanup`, **or R1.0 id-unknown survivor**) | 2 | (error) | true | true iff ≥1 unlink happened | **true** | N | M (present in-scope survivors) | ≥0 | `STATE_COMPACT_CLEANUP_INCOMPLETE` | populated |

Note the two `STATE_COMPACT_WRITE_FAILED` rows differ ONLY in `partial_applied` (`write_pack`→false vs `verify_pack`→true) — `cleanup_started:false` for both. The `partial_applied:true` + `cleanup_started:false` cell (`verify_pack`) is a first-class state: the pack STEP mutated the tree this run, the unlink phase never ran. (For a Layer-2 readback failure the pack remains on disk; for a post-write re-prepare failure it may already be gone — `partial_applied:true` asserts the mutation, not the pack's presence.)

Locked rules:

- **One survivor = the command does NOT succeed.** Any still-present skipped file exits **2** with `STATE_COMPACT_CLEANUP_INCOMPLETE`. The operator must see it was incomplete, not assume done.
- **`partial_applied` reflects whether ANY filesystem mutation happened — pack OR unlink** (NOT only unlink). It mirrors `EventPackWriteError.partial_applied` for the write phase (`write_pack`→false, `verify_pack`→true because the pack step mutated the tree — the pack is on disk in the Layer-2 readback case, possibly already gone in a post-write re-prepare failure) and is true once any loose unlink has run. The companion `cleanup_started` boolean tells the operator specifically whether the *cleanup* phase began: on `STATE_COMPACT_WRITE_FAILED` `cleanup_started:false` (no unlink) even when `partial_applied:true` (the pack was written then failed verify). Conflating the two — reporting `partial_applied:false` whenever cleanup hadn't started — would tell the operator the tree is untouched when a half-written pack is actually on disk.
- **`cleanup_remaining_loose` is post-run actual** (re-enumerated from disk), never the plan-time list. Vanished files are excluded; present survivors are included.
- **`cleanup_pending` stays true** whenever any loose remains on disk after the run — so a re-run is invited. `false` ONLY on full success / already-clean.
- **Re-run is idempotent**: re-running after a partial run re-enters via G0; the surviving loose is now a `subset-after-partial-cleanup` (cell 14) → resume. A re-run after the cause is fixed converges to `cleaned`.
- **No silent truncation**: every present survivor appears in `skipped[]` with its reason; the human line states "M loose file(s) could not be removed".

`legacy_progress_retained` (advisory only, NOT a gate input): emit it when a tracked `progress.yaml` still contains event ids that are now covered by the pack / just cleaned up — a hint that the legacy file can be migrated/retired. It is **never** evidence and **never** decides unlink eligibility (Layer 1/2 closed "legacy is not a durable evidence source"; this advisory must not reopen it). It does not affect exit code.

**Re-check, do not trust the plan.** G0/G3a/G3b/G4/G6/G8 deliberately re-read disk at delete time. The plan computed a verdict; between plan and unlink the tree can change (a concurrent writer, an external edit, a reappearing live YAML or re-used task_id, a file already removed). The gate is the same fail-closed posture Layer 2's readback-verify already uses (`applyEventPackPlan` re-runs the whole plan after writing) — extended to the irreversible step.

## Layer 3 implementation test gaps

For the Layer 3 implementation PR, NOT fixed in this RFC. The truth table marks cells with **no current pin**; the Layer 3 PR must add them:

- **Cell 14 (subset-after-partial-cleanup)** — all four set-relationships (`== / ⊊ / ⊄ / ∅`). *Highest priority — zero coverage today, and the core new branch.*
- **Cell 5 ordering** — `snapshot=invalid` + `target-pack=valid` (assert snapshot block wins before the pack/evidence path).
- **`--write` terminal outcomes** — `cleaned` (full), `already_cleaned` (no-op), and the three error codes each pinned separately:
  - `STATE_COMPACT_WRITE_FAILED` — pin **both** values of the existing `phase` field (it is NOT a single `partial_applied:false` case): `phase:write_pack` failure → `partial_applied:false`, `cleanup_started:false`; `phase:verify_pack` failure → `partial_applied:true` (pack-step mutation happened; pack on disk for a Layer-2 readback failure, possibly gone for a post-write re-prepare failure), `cleanup_started:false`, `pack_path` present. No unlink in either.
  - `STATE_COMPACT_CLEANUP_FAILED` — G0/G6/G8 abort + reconciliation `pack_stale_after_cleanup`; `partial_applied` false-before / true-after first unlink; `cleanup_started:true`.
  - `STATE_COMPACT_CLEANUP_INCOMPLETE` — ≥1 present survivor, exit 2, counts + `skipped[]`.
- **all-vanished `cleaned` edge** — the cleanup ran but EVERY targeted loose file vanished before unlink (concurrent `rm` / crash): `cleaned`, exit 0, `loose_deleted_count:0`, `vanished_count > 0`, `cleanup_remaining_loose:0`; `partial_applied:false` when no pack was written this run (cell 12/14), `true` on the cell-10 write-then-all-vanish path. Pin the invariant `cleaned ⇒ (loose_deleted_count > 0 ∨ vanished_count > 0)` (a zero-op `cleaned` — deleted 0 AND vanished 0 — is incoherent and must never be emitted, regardless of `partial_applied`).
- **vanished vs unreadable** — a file removed out-of-band mid-run (ENOENT) is NOT counted in `cleanup_remaining_loose` (`vanished_count` instead); an unreadable-but-present file IS. `cleanup_remaining_loose` matches the post-run on-disk enumeration.
- **Final reconciliation (R1)** — (a) a NEW loose file appended mid-run whose id IS in the pack → `appeared_during_cleanup` / `CLEANUP_INCOMPLETE`; (b) a NEW loose file whose id is NOT in the pack → `pack_stale_after_cleanup` / `CLEANUP_FAILED`; (c) a survivor that has BOTH a per-file skip record AND is not-in-pack → must resolve to `CLEANUP_FAILED` (pack-coverage wins over the skip record — R1.1 before R1.2); (d) **R1.0 id-unknown** — a malformed/unreadable/symlink/parse-failed survivor appended mid-run (no skip record, id uncomputable) → `*_after_cleanup` skip reason / `CLEANUP_INCOMPLETE`, counted in `cleanup_remaining_loose` (NOT silently ignored, NOT `CLEANUP_FAILED`); (e) counts/`skipped[]`/`vanished_count` mutually consistent (every present survivor in `skipped[]` incl. id-unknown, no absent file in it, success ⇔ zero present survivors).
- **G4 split** — `skipped:parse_failed` (content not a parseable event) vs `skipped:id_mismatch` (parses but recomputed id ≠ filename id) are distinct reasons.
- **R0 candidate set / R5 out-of-scope** — (a) an unreadable file whose FILENAME id ties it to this pack/target → in-scope, R1.0, counted; (b) a parseable event whose `task_id` is NOT in the snapshot and whose filename id is NOT in the pack → out-of-scope, NOT counted in `cleanup_remaining_loose`, global `unclassified_loose_after_cleanup` advisory, run can still be `cleaned`/exit 0; (c) another phase's broken loose file present in the events dir → never counted in THIS phase's `cleanup_remaining_loose`.
- **G7 abort** — a present loose file not covered by the verified pack reached in-loop → abort `pack_stale_after_cleanup` / `CLEANUP_FAILED`, no further unlink.
- **`partial_applied` vs `cleanup_started`** — a `verify_pack` failure (pack-step mutation, no unlink — pack on disk in the Layer-2 readback case, possibly gone in a post-write re-prepare failure) → `partial_applied:true`, `cleanup_started:false`; a `write_pack` failure → both false; a mid-cleanup abort → both true.
- **G6 task-id owner gate** — the P42/P99 re-used-task_id case (abort, no unlink); unreadable/unparseable/ambiguous live phase → fail-closed abort.
- The delete-time gate G0–G8 each need a TOCTOU pin (re-read sees a change → skip/abort, unlink count correct, partial-progress reported).
- **Idempotent re-run** — partial cleanup → re-run converges to `cleaned` via cell 14.
- **G1/G3b symlink** — a symlink at the loose path is `skipped:not_regular_file`, never followed; verification reads no other target. (Best-effort; not a hostile-FS race test.)

## Non-goals

- **No `EventPack` schema change** (`src/core/schemas/event-pack.ts` untouched).
- **No Layer 1 reader/binding semantics change** — Tier-1 / Tier-2 / completeness / semantic-replay rules are frozen; Layer 3 only *consumes* them.
- **No `phase archive` evidence semantics change** — snapshot minting / terminal evidence kinds are out of scope.
- **No legacy migration changes** (`plan migrate` / `progress.yaml` dual-read untouched).
- **No unrelated docs cleanup** in the Layer 3 PRs.
- **No adapter drift fixes** bundled in.
- **No automation / GC scheduling / retention policy** — Layer 3 is operator-invoked `state compact --write`, one phase at a time.

## Alternatives considered

- **Unlink in Layer 2 (one combined PR).** Rejected — combines the foundation with the irreversible step; a destructive bug layered on an unreviewed writer is hard to root-cause. The layer split exists precisely to review the writer first.
- **Treat any loose ≠ pack as `pack_stale` (skip the subset branch).** Rejected — makes a *resumable* partial cleanup permanently ineligible; the operator could never finish an interrupted compact. Cell 14 distinguishes subset from divergence.
- **Trust the plan-time ownership facts at delete time.** Rejected — TOCTOU. The gate re-reads disk before each unlink.
- **G6 via `phaseFileStillPresent` (phase-id discovery).** Rejected — that finds live phases by **phase id**, not the loose event's **task_id**. A re-used task_id under a different live phase id would slip through and the still-live event would be unlinked. G6 needs a task-id-keyed scan (`findLiveTaskOwnersByTaskId`).
- **One-column truth table (verdict and `--write` outcome merged).** Rejected — Layer 3's successful `--write` flips `cleanup_pending` to false and deletes files, a different state from the dry-run verdict. Merging the columns invites returning `cleanup_pending:true` after a successful unlink.
- **Reuse `packed` (or `STATE_COMPACT_WRITE_FAILED`) for cleanup outcomes.** Rejected — `cleaned` ≠ `packed` (pack-written vs loose-removed). The three error codes (`WRITE_FAILED` = pack step failed before cleanup; `CLEANUP_FAILED` = a global safety gate aborted cleanup; `CLEANUP_INCOMPLETE` = survivors remain) drive **different operator next-actions**, so collapsing them into one would hide which recovery applies.
- **Count vanished files as `cleanup_remaining_loose` (one `vanished_or_unreadable` skip reason).** Rejected — an already-absent file is not a survivor; counting it makes the result JSON claim a file remains that does not. `vanished` (ENOENT) and `unreadable` (present but unverifiable) are split, and `cleanup_remaining_loose` is computed from the post-run on-disk state, not the plan-time list.
- **`resolveWithinProject` alone as the path gate (no `lstat`/symlink check).** Rejected — it proves the *path* is in-project but not that the entry is a regular file; a symlink at that path would be followed by `readFile`, letting verification read a different target. G1/G3b `lstat` and require a regular file, never following symlinks (best-effort, with the limit stated explicitly).
- **No final reconciliation (trust the per-file gate's running tallies).** Rejected — a loose file appended or re-created mid-run never passed the gate, so it has no skip record; the running tally would report `cleanup_remaining_loose > 0` with an empty `skipped[]`, or ignore it silently. R0–R5 re-enumerate the post-run on-disk truth and classify every ungated survivor, so the three counts can never disagree.
- **`partial_applied:false` whenever cleanup hasn't started.** Rejected — a `verify_pack` failure means the pack step already mutated the tree (the pack on disk in the Layer-2 readback case); reporting the tree as untouched would mislead recovery. `partial_applied` tracks ANY filesystem mutation (pack or unlink); `cleanup_started` separately reports whether the unlink phase began.
- **G7 not-in-pack as a per-file skip (`CLEANUP_INCOMPLETE`).** Rejected — a present loose file the pack does not cover means the pack no longer matches the live loose set, a coverage failure (`pack_stale_after_cleanup` / `CLEANUP_FAILED`), not "one file I couldn't remove". G7 aborts; R1 evaluates pack-coverage before any skip record.
- **R1 keyed only on a known event id (no id-unknown branch).** Rejected — a survivor that appeared mid-run and cannot be read/parsed/id-recomputed (malformed, symlink, unreadable) matches none of the id-based branches, leaving a present-but-unclassified file that breaks the "every present survivor is in `skipped[]`" invariant. R1.0 classifies it as `CLEANUP_INCOMPLETE` (not `CLEANUP_FAILED` — non-coverage is unproven) so nothing is ever silently dropped.
- **Reconciliation scoped by "snapshot task_id" alone (no candidate set).** Rejected — an unreadable/unparseable survivor cannot have its `task_id` read, so a task_id-only filter either silently drops it (R1.0 never fires) or, if widened to the whole events dir, pulls another phase's broken loose file into THIS phase's `cleanup_remaining_loose`. The R0 candidate set keys on FILENAME id / pack membership / prior skip-record (none of which need the content), so an unreadable file still in-scope is caught, and a stray file is routed to the R5 global advisory instead of lying about this phase's survivors.

## References

- Code (Layer 1/2, the contract Layer 3 builds on): [`src/core/archive/event-pack.ts`](../../src/core/archive/event-pack.ts) (`planEventPack` / `applyEventPackPlan`), [`event-pack-reader.ts`](../../src/core/archive/event-pack-reader.ts) (Tier-1), [`event-pack-binding.ts`](../../src/core/archive/event-pack-binding.ts) (Tier-2 / completeness / replay), [`state-compact.ts`](../../src/commands/state-compact.ts), [`src/cli/commands/state.ts`](../../src/cli/commands/state.ts); producer fail-closed precedent [`phase-snapshot.ts`](../../src/core/archive/phase-snapshot.ts).
- Tests pinning the current cells: `tests/unit/core/archive/event-pack-compaction.test.ts`, `tests/unit/core/archive/event-pack.test.ts`, `tests/unit/commands/state-compact.test.ts`.
