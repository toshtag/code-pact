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
   **read-only backward-compat input**; the v2.0 retired-decision tombstone lives
   under `.code-pact/state/` so the **entire `design/decisions/` directory can be
   removed** without breaking the live decision gate.

## "completed phase" — defined by state, not by YAML

A phase's YAML is **removable** only when its terminal state is established
**independently of the YAML**:

- every task in the phase has a **terminal progress state derived from
  `.code-pact/state/events/`** (`done`), **or** a **validated archive snapshot**
  records its terminal status (`done` / `cancelled`); **and**
- no active, unresolved task depends on a **non-`done`** (e.g. `cancelled`) task of
  that phase.

YAML `status: done` **alone is not sufficient** — it disappears with the file.

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
- **A3.** After snapshotting, **`rm -rf design/decisions` by hand** keeps the **live
  decision gate** and all of A2's commands green.
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
2a. **Phase read seam** — route every `loadPhase` site through one seam
   (`src/core/plan/load-phase.ts`). Pure, non-destructive, behavior-identical.
   **✅ done.** The single place layers 4 + 6 hook phase archive-fallback into.
2b. **Decision read seam** — consolidate the decision-read entry points
   (`loadDecisions` / `loadDeclaredDecisions` in `core/pack/loaders.ts`, the
   `decision_refs` + `PRUNED.md` resolution in `core/plan/checks/path-fields.ts`)
   on top of the already-shared `resolveDecisionGate` / `classifyAdr` in
   `core/decisions/adr.ts`, so layer 5 has ONE place to add `.code-pact/state`
   tombstone-fallback. **NOT done** (this PR ships 2a only).
3. **Snapshot + tombstone writers** —
   `.code-pact/state/archive/phases/<phase-id>.json` (one-phase-one-file) + a Zod
   schema, and the retired-decision tombstone under `.code-pact/state/`
   (non-destructive; nothing is deleted yet).
4. **Resolve completed-phase missing** via the snapshot (loaders / deps / lint),
   scoped to archived-only; active-missing stays fail-closed.
5. **Resolve retired-decision missing** via the `.code-pact/state` tombstone
   (`PRUNED.md` read-only backcompat).
6. **Tolerance, scoped** — `validate` / `doctor` / `plan lint` / `task context` /
   `task prepare`: *missing archived historical docs tolerant; missing active
   control docs fail-closed.*
7. **`phase archive` + hand-delete** — the destructive verb (dry-run + `--write` +
   stale-plan guard + write lock, least-harmful ordering) **and** the A2 / A3 / A7
   integration fixture that `rm`s the files manually. Like `decision prune`'s
   link-collector, the delete path must clear/rewrite **inbound doc-links** to the
   removed decisions/phases so `check:docs` stays green (A7).

## Quarantined (do not accrete v2.0 direction from these)

- decision-lifecycle **PR-D2 `decision compress`** (lossy ADR rewrite) — likely
  redundant under delete + git-backstop + `.code-pact/state` tombstone; re-decide in
  the v2.0 context rather than building it as previously specced.
- control-plane-v2 **PR2+** (slug ids / per-task files / glob discovery) — a
  separate collaboration-safety concern; v2.0 uses its own snapshot-index discovery
  and does not inherit that plan.

## Non-negotiables

- Deterministic, **non-AI** logic only on control-plane paths.
- Every destructive command: dry-run preview + `--write` + stale-plan guard + lock.
- Prefer **fail-closed over silent success**. Snapshots small, deterministic,
  schema-validated.
- **Reader-side backward compatibility** for existing projects (A5).
