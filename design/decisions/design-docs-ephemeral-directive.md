# Product Directive: Design docs are ephemeral (v2.0 control-plane relocation)

**Status:** accepted (v2.0 product direction, 2026-06) — **transitional
directive** (retire after v2.0 lands; the durable form of this rule is the
schema + tests + `.code-pact/state` behavior, not this file).
**Type:** superseding product directive — overrides conflicting prior RFCs /
`constitution` *where and only where* they would block removable design docs.
**Owners:** maintainer.
**Related:** [constitution](../constitution.md) (the `design/`-source-of-truth line
this updates) · [decision-lifecycle-rfc](decision-lifecycle-rfc.md) (prune/tombstone
machinery — generalized, its tombstone home moved out of `design/`) ·
[collaboration-safe-state-rfc](collaboration-safe-state-rfc.md)
(`.code-pact/state/events/` one-file-per-record precedent) ·
[control-plane-v2-rfc](control-plane-v2-rfc.md) (shared resolve seams; PR2+
quarantined here).

## Why this is transitional (read first)

The v2.0 canonical truth is **not this markdown file** — it is the schema, the
tests, and the observable `.code-pact/state` behavior. This directive exists only
to stop the half-finished prior RFCs and the pre-v2.0 constitution from steering
the implementation. Once v2.0 lands and `constitution.md` + `docs/` reflect the new
model, **this file may itself be deleted** — it is exactly the kind of ephemeral
historical working doc it describes. Do not let it become a new permanent RFC, and
do not accrete future direction from it after v2.0 ships.

## Canonical rule (the new source of truth)

1. For the v2.0 **removable-doc scope**, runtime truth for **archived / completed
   phase references** and **retired / settled decision outcomes** moves to
   `.code-pact/state` + generated control snapshots. **`design/` remains the
   active authoring/control surface** for the roadmap and not-yet-archived
   phase/task definitions **until a separate future relocation** (out of v2.0
   scope — see A1's scope split). What `design/` stops being is the *permanent
   home of historical docs*: completed/retired material becomes removable.
2. `design/decisions/*.md` and **completed** `design/phases/*.yaml` are
   **ephemeral**: deletable, retire-able, eventually `.gitignore`-able — **by hand**,
   not only via a CLI verb.
3. The only thing that must survive deletion is the **information active tasks
   need**, retained as a **deterministic, non-AI** snapshot/tombstone under
   `.code-pact/state/`. No AI summarization anywhere on a control-plane path.
4. **Fail-closed, scoped precisely** (this replaces any blanket "missing-doc
   tolerant" framing):
   - *Missing **archived / historical** docs* (a completed phase, a retired
     decision) → **tolerated**, resolved from the `.code-pact/state`
     snapshot/tombstone.
   - *Missing **active** control docs* (an active phase YAML, a live decision gate)
     whose state is **not yet snapshotted** → **fail closed.** Never silently
     swallowed.
5. **No `design/decisions/` retention dependency.** `PRUNED.md` is demoted to a
   **read-only backward-compat input**; the v2.0 **decision-state record** (the
   tombstone is its degenerate form, for records no active gate needs) lives under
   `.code-pact/state/` so the **entire `design/decisions/` directory can be
   removed** — provided every decision an active gate needs is represented as a
   record that may satisfy that gate (A3). Otherwise the gate **fails closed**.

## "completed phase" — defined by state, not by YAML

A phase's YAML is **removable** only when its terminal state is established
**independently of the YAML**:

- every task in the phase has a **terminal progress state derived from
  `.code-pact/state/events/`** (`done`), **or** a **validated archive snapshot**
  records its terminal status (`done` / `cancelled`); **and**
- no active, unresolved task depends on a **non-`done`** (e.g. `cancelled`) task of
  that phase.

YAML `status: done` **alone is not sufficient** — it disappears with the file.

**Authority order across deletion:** *before* deletion, `.code-pact/state/events/`
may prove terminal state while the phase YAML still supplies the task set; *after*
deletion, the **validated archive snapshot is authoritative** for phase membership,
task ids, and terminal status — progress events alone **cannot reconstruct the full
task set** of a deleted phase (a task with zero events is invisible to the ledger),
so "events exist" is never by itself a license to delete the YAML.

## Acceptance criteria (v2.0 — locked)

- **A1.** An active task that **references or depends on an archived phase / a
  retired decision** resolves it from `.code-pact/state` (snapshot / decision-state
  record) **alone**. The active task's own *not-yet-archived* phase YAML stays
  required (rule 5).
  **Scope split (load-bearing — do not blur):**
  - Relocating **active phase / task definitions** into `.code-pact/state` is
    **out of v2.0 scope** (it would contradict rule 5 / the active-fail-closed
    stance). The active task's body still comes from its `design/phases/*.yaml`.
  - A **decision-state record that may satisfy an active decision gate** is
    explicitly **in v2.0 scope** — A3 requires it (that is how the live gate
    survives `rm -rf design/decisions`). This is *not* "relocating active control
    docs"; it is recording the *settled outcome* a gate needs, not the active
    phase/task definition.
  A1 is implemented by steps 3–6 (the snapshot / decision-state writers + the
  archived-only resolution readers), **not** by a separate active-phase-snapshot
  writer.
- **A2.** After snapshotting, **`rm design/phases/<completed>.yaml` by hand** keeps
  `validate` / `doctor` / `plan lint` / `task context` / `task prepare` green.
- **A3.** **`rm -rf design/decisions` by hand** is tolerated **only when every
  decision required by an active gate** (any not-done task's `requires_decision` /
  `decision_refs`) **is already represented in `.code-pact/state` as a
  decision-state record** (see step 3 for its minimum fields, including whether it
  may satisfy an active gate). Then the live decision gate and all of A2's
  commands stay green. If **any** active gate depends on an **unsnapshotted**
  decision, the gate **fails closed** — it never resolves from absence, and the
  retired-decision tombstone alone is NOT sufficient to release a live gate.
- **A4.** The `.code-pact/state` snapshot/tombstone **alone** resolves a completed
  phase / retired decision — with **no** `design/decisions/` and **no** completed
  `design/phases/*.yaml` on disk.
- **A5.** Existing projects that **delete nothing** are **byte-identical /
  behavior-identical** to pre-v2.0.
- **A6.** If active-task-needed info is **not yet snapshotted**, the read paths
  **fail closed** (no silent success).
- **A7.** An integration test proves A2 + A3 by **actually `rm`-ing** the files in a
  fixture, then running the full gate **including `check:docs` (doc-link integrity)**
  — the hand-delete path must not leave dangling inbound doc-links to the removed
  decisions/phases.

## Build order (staged PRs — reader-side backward compatibility throughout)

> **Status at a glance (for the next session):** ✅ done = 0, 1, 2a (#405), 3
> (#406), 2c (#407), 2b (#409), **4a** (phase-side archived resolution — the FIRST
> reader of the step-3 snapshots; `rm design/phases/<completed>.yaml` with the
> roadmap ref kept stays green via a validated snapshot, existence-only archived
> task index, all collision-checked + fail-closed). ⬜ not started = **4b**
> (roadmap-ref-REMOVED + unreferenced-archived-phase cross-phase `depends_on`),
> 5 (retired-decision resolution), 6, 7. Nothing destructive has shipped yet
> (4a writes/deletes nothing — it only READS the snapshots). **The locked reader
> invariants that bind 4b/5/6/7** (stated in full in the 4a entry below and enforced
> by `tests/unit/core/archive/`, `tests/unit/core/plan/state-archive.test.ts`,
> `tests/unit/core/plan/resolve-task-archive.test.ts`, and
> `tests/integration/archive-phase-tolerance.test.ts`): the live phase/decision
> loaders return full `Phase` / resolve from the live `.md` ONLY; archived resolution
> is a SEPARATE archived-aware path, never a snapshot coerced into `Phase`, never a
> gate released from absence, never a present (or present-but-inaccessible) live file
> overridden by a snapshot (live-wins), and never a task-id collision used as a
> silencer (collision → `PHASE_SNAPSHOT_INVALID`, fail-closed, on every reader path).

0. This directive (foundation, reviewed first) + the `constitution` update.
1. Recovery report / inventory (continue / discard / quarantine). ✅ done.
2a. **`loadPhase` dedupe** — the 8 byte-identical `loadPhase` copies (+ 2
   re-export importers) route through `src/core/plan/load-phase.ts`. Pure,
   behavior-identical. **✅ done (PR #405).**
2b. **Decision read seam — ✅ done (PR #409).** The two pack decision-read entry
   points (`loadDecisions` / `loadDeclaredDecisions` in `core/pack/loaders.ts`)
   route onto live-only seams `readLiveDecisionDir` / `readLiveDecisionFile` in
   `core/decisions/adr.ts`. **Locked contract:** the live decision reader is
   **live `design/decisions/` ONLY**; the step-5 `.code-pact/state` decision-state
   fallback is **caller-scoped** — added in gate-aware / lint-aware *wrappers* that
   compose these seams, **never inside the primitive** (so the pack render /
   ADR-quality scans never start treating a retired record as a live decision).
   `path-fields.ts` (the lint `decision_refs` not-found detector) was
   **intentionally NOT changed** in 2b — its `fileExists` does not detect symlink
   escape, so routing it onto the seam would be a behavior change; step 5 revisits
   it via a lint-aware wrapper. Pack loaders keep their optional `catch → []`/skip
   at the call site (the seams are fail-closed).
2c. **Task/plan-state phase read seam — ✅ done (PR #407).** The strict
   raw-throwing readers (`resolve-task.ts`, `phase-reconcile.ts`,
   `adapters/claude.ts`) now go through the live-only `load-phase.ts` seam; the
   PlanState family (`loadPlanState` / `collectPlanArtifacts` /
   `scanPhasesDirBestEffort`) shares one `loadPlanStatePhase(absPath)` helper
   (keeps `loadYaml`'s `ParseError` contract); the read-modify-write readers
   (`sync-paths`, `finalize/safe-write`) are documented **never-archive-fallback**.
   **Important contract (locked in the seam comments):** `load-phase.ts` /
   `loadPlanStatePhase` are **live-phase-YAML / full-`Phase` ONLY** — a snapshot
   is intentionally smaller than `Phase`, so step 4 must add archived resolution
   in a **separate archived-aware resolver or a `live | archived` union**, never
   by coercing a snapshot into `Phase` from these loaders. `phase-reconcile`
   (live rewrite) and `adapters/claude` (reads `verification.commands`, absent
   from snapshots) must **never** be fed a snapshot.
3. **Snapshot + decision-state writers — ✅ done (PR #406; library only, no CLI).**
   `src/core/archive/phase-snapshot.ts` + `src/core/archive/decision-record.ts`
   write `.code-pact/state/archive/phases/<id>.json` and
   `.code-pact/state/archive/decisions/<stem>-<hash8>.json` via pure
   `.code-pact/state` writes (schemas in `src/core/schemas/phase-snapshot.ts` /
   `decision-state-record.ts`). Fail-closed throughout: ExpectedState write
   guard, record-identity + phase-id + graph-wide duplicate-task-id checks,
   progress-drift detection, attestation-can't-overrule-events, live-file-wins
   semantic comparison (no-op vs `record_inputs_changed`/`record_state_mismatch`),
   bidirectional `may_satisfy_active_gate` schema invariant. **Reader status:** the
   PHASE snapshots are now consumed by step 4a (PR #410); the DECISION-state records
   are still unconsumed — that is step 5. Original spec note: a decision-state
   record carries identity / original path / ADR status / may-satisfy-active-gate
   / source hash + provenance; a plain tombstone is the degenerate case.

   _Below: 4a done; 4b/5–7 are where readers keep consuming the records and,
   finally, where deletion happens._
4a. **Resolve completed-phase missing (roadmap-ref-STAYS) — ✅ done (PR #410).**
   The FIRST reader of the step-3 snapshots. `rm design/phases/<completed>.yaml`
   with the **roadmap ref kept** + a valid snapshot keeps `validate` / `plan lint`
   / `plan analyze` (`--strict`) / `task context` / `task prepare` green —
   including an active task in another phase that `depends_on` a task of the deleted
   phase (A2). Implemented exactly per the 2c contract — **NOT** by coercing a
   snapshot into `Phase`:
   - `src/core/archive/load-phase-snapshot.ts` — `loadPhaseSnapshot` (invalid is
     never collapsed to absent), `resolveMissingPhaseRef` (re-checks
     id/original_path/path_sha256/terminal — does not trust the writer),
     `mergeArchivedTaskIndex` (collision fail-closed, never picks a winner).
   - `PlanState.phases` stays **live-only** (the deleted phase is skipped); the
     archive data lives in a **separate `PlanState.archivedTaskIndex`** consumed
     ONLY by the existence checks (`detectTaskDependsOnUnresolved` +
     `detectOrphanProgressEvents`), never by the ~20 quality detectors, never
     coerced to `Phase`.
   - **EXISTENCE ≠ SATISFACTION (locked):** the archived index proves a task id
     *existed*; dependency *satisfaction* stays purely event-based
     (`deriveTaskState`). A `cancelled` archived dep is KNOWN but NOT satisfied.
   - **Fail-closed everywhere:** an active / non-terminal / unsnapshotted missing
     phase still errors; a corrupt/mismatched/colliding snapshot is
     `PHASE_SNAPSHOT_INVALID` (error). The collision check runs on **every** reader
     path (strict + lenient loaders, doctor → `validate`, AND `resolveTaskInRoadmap`
     so `task context`/`task prepare` cannot bypass it). Live file present (even
     present-but-inaccessible) → the snapshot is never consulted (live-wins).
4b. **⬜ Resolve completed-phase missing (roadmap-ref-REMOVED) + unreferenced-phase
   deps** — NOT started. The destructive `phase archive --write` removes the roadmap
   ref (and rewrites inbound doc-links, step 7); 4b resolves a cross-phase
   `depends_on` into an archived phase that is **no longer in the roadmap** (4a only
   covers a *referenced* missing phase). Same locked reader invariants as 4a.
5. **⬜ Resolve retired-decision missing** via the `.code-pact/state` decision-state
   record (`PRUNED.md` read-only backcompat). This layer must cover, explicitly:
   **`resolveDecisionGate`** (the live gate — resolves only from a record that
   says it may satisfy an active gate, never from absence), **`plan lint`'s
   `decision_refs` AND `acceptance_refs`** not-found detectors (`acceptance_refs`
   is NOT covered by the decision tombstone today — do not drop it),
   **`task prepare` / `task record-done`** (gate + commitments echo),
   **`status`**, and the **doc-link checker** (interim rule below; full
   tombstone-awareness is step 7 half (ii)).
   **`acceptance_refs` stays strict by default:** it may point at ordinary docs
   (e.g. `docs/cli-contract.md`), not just decisions. Soften a missing
   `acceptance_ref` **only** when its target is a **retired design decision /
   archived historical artifact represented by a validated `.code-pact/state`
   record** — a generic missing acceptance doc must still fail (never blanket-
   silence `acceptance_refs` via the decision record).
6. **⬜ Tolerance, scoped** — `validate` / `doctor` / `plan lint` / `task context` /
   `task prepare`: *missing archived historical docs tolerant; missing active
   control docs fail-closed.*
7. **⬜ `phase archive` + hand-delete** — the destructive verb (dry-run + `--write` +
   stale-plan guard + write lock, least-harmful ordering) **and** the A2 / A3 / A7
   integration fixture that `rm`s the files manually.
   **Doc-link strategy (decided, two halves):**
   (i) the **destructive retire command** — `decision retire --write` /
   `phase archive --write` (NOT step 3's pure writers — the `decision prune`
   link-collector precedent) rewrites or clears **inbound doc-links at retire
   time**, so a *later* hand-`rm` leaves nothing dangling; **and**
   (ii) **`check-doc-links` learns the decision-state record** — a link whose
   target is recorded in `.code-pact/state` resolves as *retired*, not *broken*
   (the safety net when files are hand-deleted before a link sweep).
   **This is a substantial work item, not a footnote:** this repo's own `docs/` +
   RFC cross-references deep-link `design/decisions/*.md` heavily (the checker
   resolves 800+ relative links today), and A3/A7 cannot pass without both
   halves. Budget it as its own reviewed layer inside step 7.
   **This PR's own footprint:** it adds a public **link** from root `README.md` and
   a public **textual reference** from `docs/positioning.md` to *this transitional
   directive*. Retiring the directive (or `rm -rf design/decisions`) must therefore
   **also remove or redirect that public link / reference** before A7 can pass —
   the link is part of the inbound set half (i) must clear; the plain reference
   must be reworded.

## Quarantined (do not accrete v2.0 direction from these)

- decision-lifecycle **PR-D2 `decision compress`** (lossy ADR rewrite) — likely
  redundant under delete + git-backstop + `.code-pact/state` tombstone; re-decide in
  the v2.0 context rather than building it as previously specced.
- control-plane-v2 **PR2+** (slug ids / per-task files / glob discovery) — a
  separate collaboration-safety concern; v2.0 uses its own snapshot-index discovery
  and does not inherit that plan.

## Non-negotiables

- **No interim broken-docs state.** No PR may introduce a state where runtime
  retired-decision / archived-phase resolution succeeds but `check:docs` is
  knowingly broken. Tombstone-aware doc-link behavior may land later (step 7
  half (ii)), but **every interim PR must keep `check:docs` green**.
- Deterministic, **non-AI** logic only on control-plane paths.
- Every destructive command: dry-run preview + `--write` + stale-plan guard + lock.
- Prefer **fail-closed over silent success**. Snapshots small, deterministic,
  schema-validated.
- **Reader-side backward compatibility** for existing projects (A5).
