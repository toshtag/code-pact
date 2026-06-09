# Product Directive: Design docs are ephemeral (v2.0 control-plane relocation)

**Status:** proposed — **transitional directive** (retire after v2.0 lands; the
durable form of this rule is the schema + tests + `.code-pact/state` behavior, not
this file).
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

1. From v2.0, **runtime truth = `.code-pact/state` + generated control snapshots.**
   `design/` is the human authoring surface and historical working docs — not the
   control plane.
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
  retired decision** resolves it from `.code-pact/state` (snapshot/tombstone)
  **alone**. The active task's own *not-yet-archived* phase YAML stays required
  (rule 5) — relocating **active** control docs into `.code-pact/state` is
  explicitly **out of v2.0 scope** (it would contradict rule 5 / the
  active-fail-closed stance). A1 is implemented by steps 3–6 (the snapshot/tombstone
  writers + the archived-only resolution readers), **not** by a separate
  active-control-snapshot writer.
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

0. This directive (foundation, reviewed first) + the `constitution` update.
1. Recovery report / inventory (continue / discard / quarantine). ✅ done.
2a. **`loadPhase` dedupe** — the 8 byte-identical `loadPhase` copies (+ 2
   re-export importers) now route through `src/core/plan/load-phase.ts`. Pure,
   behavior-identical. **✅ done — but this is NOT the complete phase read seam.**
   Phase YAML is still read *outside* the seam by: `core/plan/resolve-task.ts`
   (the eager all-phases loop — the very path that breaks on a hand-`rm` today),
   `core/plan/state.ts` (`loadPlanState` strict / `collectPlanArtifacts`
   lenient), `commands/phase-reconcile.ts`, `core/adapters/claude.ts`, and the
   read-modify-write sites (`core/plan/sync-paths.ts`,
   `core/finalize/safe-write.ts`) which read raw text under their own contract.
   **Archive-fallback can NOT yet be inserted in one place.**
2b. **Decision read seam** — consolidate the decision-read entry points
   (`loadDecisions` / `loadDeclaredDecisions` in `core/pack/loaders.ts`, the
   `decision_refs` + `PRUNED.md` resolution in `core/plan/checks/path-fields.ts`)
   on top of the already-shared `resolveDecisionGate` / `classifyAdr` in
   `core/decisions/adr.ts`, so layer 5 has ONE place to add `.code-pact/state`
   tombstone-fallback. **NOT done.**
2c. **Task/plan-state phase read seam** — move the remaining strict
   read-and-validate sites (`resolve-task.ts`, `loadPlanState`,
   `phase-reconcile.ts`, `adapters/claude.ts`) onto the shared seam, and give
   the lenient / read-modify-write readers (`collectPlanArtifacts`,
   `sync-paths`, `safe-write`, doctor's validating reader) an explicit
   archive-awareness contract of their own. Only after **2b + 2c** does "insert
   archive-fallback at the seam" become true. **NOT done.**
3. **Snapshot + decision-state writers** —
   `.code-pact/state/archive/phases/<phase-id>.json` (one-phase-one-file) + a Zod
   schema, and the **decision-state record** under `.code-pact/state/`
   (non-destructive; nothing is deleted yet). A decision-state record carries at
   minimum: **identity / original path**, **ADR status at retirement** (accepted /
   superseded / …), **whether it may satisfy an active gate**, and a **source hash
   / provenance** (git ref). A plain "it was pruned" tombstone is the degenerate
   case for records no active gate needs.
4. **Resolve completed-phase missing** via the snapshot (loaders / deps / lint),
   scoped to archived-only; active-missing stays fail-closed.
5. **Resolve retired-decision missing** via the `.code-pact/state` decision-state
   record (`PRUNED.md` read-only backcompat). This layer must cover, explicitly:
   **`resolveDecisionGate`** (the live gate — resolves only from a record that
   says it may satisfy an active gate, never from absence), **`plan lint`'s
   `decision_refs` AND `acceptance_refs`** not-found detectors (`acceptance_refs`
   is NOT covered by the decision tombstone today — do not drop it),
   **`task prepare` / `task record-done`** (gate + commitments echo),
   **`status`**, and the **doc-link checker** (interim rule below; full
   tombstone-awareness is step 7 half (ii)).
6. **Tolerance, scoped** — `validate` / `doctor` / `plan lint` / `task context` /
   `task prepare`: *missing archived historical docs tolerant; missing active
   control docs fail-closed.*
7. **`phase archive` + hand-delete** — the destructive verb (dry-run + `--write` +
   stale-plan guard + write lock, least-harmful ordering) **and** the A2 / A3 / A7
   integration fixture that `rm`s the files manually.
   **Doc-link strategy (decided, two halves):**
   (i) the **retire/snapshot step** (step 3's writers — the `decision prune`
   link-collector precedent) rewrites or clears **inbound doc-links at retire
   time**, so a *later* hand-`rm` leaves nothing dangling; **and**
   (ii) **`check-doc-links` learns the tombstone** — a link whose target is
   recorded in the `.code-pact/state` tombstone resolves as *retired*, not
   *broken* (the safety net when files are hand-deleted before a link sweep).
   **This is a substantial work item, not a footnote:** this repo's own `docs/` +
   RFC cross-references deep-link `design/decisions/*.md` heavily (the checker
   resolves 800+ relative links today), and A3/A7 cannot pass without both
   halves. Budget it as its own reviewed layer inside step 7.

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
