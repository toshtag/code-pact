# RFC: Collaboration-safe shared state — event-file progress ledger

**Status:** accepted (A1–A3 + B1–B6 scope, 2026-06)
**Scope:** move the progress ledger from a single `progress.yaml` array to one-file-per-event under `.code-pact/state/events/` (Bucket B); reconcile the `.code-pact/` shared-vs-local commit policy across `init`/ci/dogfood (Bucket A); add `PROGRESS_EVENT_CONFLICT` detection. Defers the v2 control-plane changes (canonical phase ids, `roadmap.yaml`-optional, per-task files — Bucket C) behind a real-demand trigger.
**Owners:** maintainer
**Related:** [Governance](governance-rfc.md) (the v1.5 advisory write lock this RFC corrects — the monolithic writer can *lose* a concurrent event, not merely reorder it) · [CI branch-drift](ci-branch-drift-rfc.md) (the committed-ledger precondition) · [Control-plane v2](control-plane-v2-rfc.md) (takes up the deferred Bucket C, C1–C4) · [Collaboration UX](collaboration-ux-rfc.md) (the coordination layer on top) · [P22 cancelled](P22-cancelled-adapter-schema-v2.md) / [P37 deferred](P37-deferred-outcome-audit.md) (the no-preemptive-engineering precedent the Bucket-C deferral relies on).

## Summary

`code-pact`'s progress ledger is documented "append-only by contract" but implemented as a whole-file read-modify-rewrite, so concurrent writers can **lose** events (a lost update, not mere reordering) and branch merges can corrupt or silently reorder the log. Separately, the product contradicts itself on whether `.code-pact/` is committed or ignored, and `init` commits machine-local lock files.

This RFC fixes the two issues **broken now and independent of team size** (Bucket A — the commit policy + doc reconciliation) and makes the **one structural change with the best cost/benefit** (Bucket B — one-file-per-event ledger with deterministic dual-read of the legacy file). It **explicitly defers** the larger v2 control-plane changes (Bucket C) behind a real-demand trigger, consistent with this project's accepted refusals of preemptive engineering ([P22](P22-cancelled-adapter-schema-v2.md), [P37](P37-deferred-outcome-audit.md)).

Root cause, in brief: `appendEvent` loads the whole file, spreads the array, and rewrites it; the write is deliberately excluded from the advisory lock; and `deriveTaskState` trusts **array order** (takes the last element, does not sort by `at`). The dominant failure is branch-merge corruption of the shared `events:` array; the single-machine lost update is real but low-probability (verbs run serially).

## Decisions

### A1 — One shared-vs-local policy, written by `init`

`init` writes a `.gitignore` ignoring the local/derived subset; the rest is committable. **"Written by", not "enforced by":** `init` merges entries and never deletes a user's lines, so a pre-existing blanket `/.code-pact/` ignore survives and silently defeats the policy (the CI gate then skips). Surfacing that is a deferred follow-up (Open questions). The source-of-truth table, published in `cli-contract.md` § State file write guarantees and linked from governance/ci/dogfood:

| Path | Disposition | Why |
| --- | --- | --- |
| `.code-pact/project.yaml` | **commit** | shared config |
| `.code-pact/agent-profiles/*`, `.code-pact/model-profiles/*` | **commit** | shared config |
| `.code-pact/adapters/*.manifest.yaml` | **commit *with* its generated files** | the manifest records adapter-owned files (`CLAUDE.md`, `.claude/skills/*`, …) as *managed*; committing it **without** those files fails a clean-checkout `adapter doctor` with `ADAPTER_FILE_MISSING`. A repo that ignores its adapter output (e.g. **this** repo, A3) ignores the manifest too |
| `.code-pact/templates/**` | **commit** | shared adapter templates |
| `.code-pact/state/events/**` | **commit** | the new ledger; conflict-free (B1) |
| `.code-pact/state/baselines/**` | **commit** | shared drift-detection snapshots |
| `.code-pact/state/progress.yaml` | **commit while present** (legacy) | read-merged (B3); migration target (B4) |
| `.code-pact/locks/**` | **ignore** | machine-local (pid/hostname) — fixes the init-commits-locks bug |
| `.code-pact/cache/**` | **ignore** | derived (reserved; none today) |
| `.context/**`, `.local/**` | **ignore** (already) | regenerated / per-developer |

`init` adds `/.code-pact/locks/` and `/.code-pact/cache/` to the entries it writes (anchored so fixtures are unaffected). The adapter-manifest row is the one **conditional** entry — shared only when its generated files are committed too.

### A2 — Reconcile the docs, stop claiming a guarantee the code does not keep

Replace `governance.md`'s "append-only by contract" with a pointer to the event-file safety model (safety now comes from the *data model* — distinct files — not an unkept contract). Document the event-file write (exclusive create, no read-modify-write) and the dual-read merge in `cli-contract.md`; keep the honest "concurrent X out of scope" note only for any path that genuinely stays monolithic. Stop stating the universal-sounding "this repo ignores `.code-pact/`" in `dogfood.md` (its resolution is A3).

### A3 — Dogfood repo: narrow ignore + commit the shared config (not the adapter manifest)

A product telling users to commit shared control-plane state while its flagship repo blanket-ignores `.code-pact/` undermines this RFC's credibility. So this repo narrows `.gitignore` to the local/derived subset and commits the shared config (`project.yaml`, agent/model profiles, `state/baselines/`). **Two principled exceptions stay ignored:** (1) the **adapter manifest** — this repo is the source of the adapter templates and regenerates `CLAUDE.md`/`.claude/skills/*` (already gitignored); committing the manifest alone would orphan it (clean-checkout `ADAPTER_FILE_MISSING`); manifest and generated files travel together or not at all, here not at all. (2) the **legacy monolithic `state/progress.yaml`** — stays ignored until per-event files (B) replace it; committing it now would reintroduce the merge problem B fixes. Committing this public repo's previously-untracked config is a maintainer action; the documented default for a user repo is **commit the shared config** (with the manifest caveat). (Resolves Q1.)

### B1 — One file per event; safety from the data model

Each progress event is written as its own file under `.code-pact/state/events/`, created with an **exclusive** flag (`wx`) — no load, no array spread, no whole-file rewrite. Consequences:

- **No lost update**, even without the lock: two concurrent writers produce two different files (different content → different id → different name); both survive.
- **Idempotent create**: `wx` `EEXIST` means the identical event is already on disk (same content → same `<at-compact>-<id>.yaml` filename, B5) → treat as success. This is the only write-path collision case; there is no distinct-event filename clash to resolve. Makes re-runs and migration (B4) safe with no bookkeeping.
- **No branch-merge corruption**: distinct filenames mean git never merges two appends to one line. Two branches adding different events merge cleanly. The only path collision is two branches writing the **same** event (identical files → trivial). *Semantic* conflicts (incompatible task lifecycles) are not filename collisions — they are detected at read time by B6.

### B2 — Deterministic, glob-order-independent merge order

The reader never trusts directory enumeration. It sorts by a total key: **primary** `at` (ISO-8601 with offset, already on every event) ascending; **tiebreaker** the event `id` (B5) ascending; optional final tiebreaker the legacy array index (only if a golden test needs byte-stable intra-second reproduction).

**Clock skew is acknowledged, not solved with logical clocks** (recorded as a non-goal): (1) `deriveTaskState` filters by `task_id` first, and a single task's lifecycle is almost always produced by one actor on one machine with an internally-monotonic clock — so per-task ordering, the only thing the reducer depends on, stays correct; (2) the residual case — the *same* task driven concurrently on two skewed machines — is a **genuine semantic conflict** that should *surface*, not be auto-resolved by a logical clock silently picking a winner. "Surface" is only real if something detects it — see B6.

### B3 — Dual-read with a uniform in-memory shape (minimal blast radius)

All consumers read the same `ProgressLog { events: ProgressEvent[] }` in-memory shape. **We change only how that array is assembled, not its shape**, so consumers are untouched. `loadProgressLog` gains an assembly step with a **legacy-only fast path that is byte-for-byte behaviour-identical to today**:

1. Parse legacy `progress.yaml` if present → events, each assigned the B5 content id + a synthetic `source_order` (array index, used only as a final tiebreaker, **not** an identity).
2. Parse every `events/*.yaml` → events (each carries its id).
3. **No event-files** → return legacy events in **original array order, unsorted** — exactly today's reducer input (this is why a legacy-only repo is never re-sorted).
4. Otherwise → dedupe by **full `id`** (a migrated event still in the legacy array collapses to one), then sort by the B2 key (`at` asc, `id` asc, `source_order` asc).

The reducer `deriveTaskState` keeps using `history[length-1]` unchanged and is **deliberately not made conflict-aware** — it stays total and deterministic for compatibility; surfacing genuine conflicts is B6's job.

### B4 — Idempotent migration

`plan migrate --events [--write]` (name TBD; dry-run default):

- For each legacy event, write the corresponding event-file. Idempotent by construction: the id is content-derived and the filename embeds the full id (`<at-compact>-<id>.yaml`, B5), so a re-run's `wx` hits `EEXIST` on the *same* event → skip. No distinct-event ambiguity.
- Leaves `progress.yaml` in place (readers keep merging it); re-running is a no-op and partial migrations are safe. Emptying/removing it is a later, separate, opt-in step.
- **Reports derived-state changes:** for each task, compute derived `current` under both legacy array order and post-migration `(at, id)` order; report any difference so the maintainer reviews the flip. This is the safety net for the one moment a repo's order semantics can change.
- Does **not** touch phase ids, task layout, or `roadmap.yaml`.

### B5 — Collision-resistant, content-derived event ids

`id = sha256_hex(canonicalizeEvent(payload))` — the **full** 64-char digest, stored in the event body. The **filename is `<at-compact>-<full-id>.yaml`** (full digest, not a truncated prefix), where `<at-compact>` is the **normalized (UTC) `at`** rendered `YYYYMMDDTHHMMSSsssZ` for a human-browsable, roughly-chronological `ls`. Both parts are fully content-determined, so the filename is in bijection with the `id`: a filename collision occurs **iff** the events are canonically identical → idempotent success (B1), never a distinct-event clash. (A truncated `id12` filename would reintroduce an undefined case — two distinct events sharing an `at`-ms and a 12-hex prefix collide on path while differing in full id; the ~90-char full filename is well under the 255 limit and buys an unconditional collision-free property.) The final file is published via temp-file + `link`, so it is never overwritten. Dedup is on the full `id`. Reuse the project's `node:crypto` sha256-hex convention; add only `canonicalizeEvent`.

**Canonical event payload — the exact hash input, pinned (or the id is not reproducible and dedup / idempotent migration silently break):**

- Includes every persisted field **except `id`**; includes `at`.
- Excludes all filename/filesystem-derived metadata and `source_order`.
- Object keys sorted recursively; absent/`undefined` optional fields omitted; array order preserved. **`null` is never normalized to absent** — the schema's optionals are `.optional()` (undefined-only), so a `null` optional is schema-invalid and is rejected by `ProgressEvent.parse` *before* canonicalization; silently mapping `null`→absent would hide a malformed event.
- `at` is normalized to UTC ISO-8601 with milliseconds (`…Z`) **before** hashing, so the same instant with different offsets hashes identically.
- The hash input is the canonical **JSON** of the payload (UTF-8, LF) — YAML formatting is never part of the hash.
- A **single** `canonicalizeEvent()` is the only producer of the hash input, called from all three sites (loader, writer, migration), so they can never drift.

Content-derived (not random) so legacy↔file dedup (B3) and re-run safety (B4) need no bookkeeping; distinct real events do not collide because `at` carries milliseconds.

### B6 — Semantic conflict detection (makes "surface, don't auto-resolve" real)

B2 declines logical clocks because a same-task concurrent edit is a genuine semantic conflict that should *surface* — but the reducer takes `history[length-1]` and would silently pick a winner. The detector is a new `detectProgressEventConflicts(events)` in `src/core/plan/checks.ts` (mirroring `detectOrphanProgressEvents`), emitting **`PROGRESS_EVENT_CONFLICT` (`severity: "warning"`)** from `plan analyze` and `doctor` (and, since Collaboration UX D3, from `code-pact status` as `data.conflicts[]`). It is **not** a `plan lint` diagnostic and `verify` does not surface it. **default → warning; `validate --strict` → failure** (because `validate` delegates to `doctor` and promotes its warnings under `--strict` — the same established strict path that gates P34's branch-drift advisory; no new gate machinery). This is the team/CI lever; a conflict invisible in `--strict` would be too weak.

A conflict is reported when, folding a single task's events through the `assertTransition` state machine in `(at, id)` order, an event has **no valid predecessor** or two distinct ids assert **incompatible** transitions — at least: `done` and `blocked` with no intervening `resumed`/`started`; a second `started` while already `started`; `done` after `done` with different ids; any pair whose order is decided only by wall-clock `at` yet violates the lifecycle machine (the B2 clock-skew case). The reducer still returns a derived state; the conflict is reported alongside it, not swallowed.

## Backward compatibility

- **Read (legacy-only) — a guarantee, not a hope.** A repo with only a legacy `progress.yaml` reads **byte-for-byte identically** — B3's fast path returns the array **unsorted**, so the reducer sees today's input, **even if array order disagrees with `at` order** (manual edits, clock adjustments). We do not silently re-sort an existing repo.
- **Transition (first event-file / after migration) — reported, not silent.** Once event-files exist, the merge sorts by `(at, id, source_order)`. If legacy array order disagreed with `at` order, a task's derived state could change; migration (B4) **must detect and report** any flip, so it is reviewed, never a silent regression.
- **Write:** new events go to event-files; the legacy `progress.yaml` is never rewritten by the new path (stays byte-stable / untracked / committed per the repo's choice) and is **read-merged indefinitely** (Q2). Emptying/removing it is a future explicit opt-in, never automatic.
- **No id rewrites:** existing `P<N>` ids, phase files, and `roadmap.yaml` are untouched (the id question is Bucket C).

## Acceptance criteria

A team can independently record progress on separate branches, then merge with either no conflict or only a genuine semantic conflict — driven by the tool, not human discipline. Concretely:

1. Two branches each appending events merge with **no** git conflict and **no** lost event (both present, counted once).
2. Concurrent event writes on one machine cannot lose an event (exclusive-create → two files).
3. A legacy-only repo derives **byte-for-byte identical** task state before/after, because the loader preserves array order when no event-files exist, independent of whether array order matches `at` order.
4. Migration is idempotent: running twice produces the same event set and rewrites nothing on the second run.
5. `init` no longer commits `.code-pact/locks/`; the published table matches what `init` writes and what governance/ci/dogfood say.
6. No `P<N>` id, phase file, `roadmap.yaml`, or inline task is rewritten by any path in this RFC.
7. A merged set with incompatible lifecycle events for one task (e.g. two branches both `done` it) yields a `PROGRESS_EVENT_CONFLICT` from `plan analyze` / `doctor` (and `status.data.conflicts[]` since D3) — it surfaces, not silently resolved.
8. Migration reports any task whose derived state changes under `at`-sort versus legacy array order.

## Non-goals (deferred to a follow-up "v2 control plane" RFC)

Gated on a **real-demand trigger** — a second active contributor (`git shortlog -sn` >1 author) or a concrete external team adopter. Until then these are preemptive engineering this project has twice chosen to refuse without observed pain ([P22](P22-cancelled-adapter-schema-v2.md), [P37](P37-deferred-outcome-audit.md)). Taken up in [control-plane-v2](control-plane-v2-rfc.md).

- **C1 — Collision-resistant canonical phase ids / retiring `P<N>` as primary key.** Correct in principle but taxes the common (solo) path to fix a problem no current user has. When taken up, evaluate `slug`-only (collides only on same-slug-same-day, detectable at merge) before `slug+hash`.
- **C2 — `roadmap.yaml` optional / discover `design/phases/*.yaml` by glob.** A reader change plus a `plan index --write` regenerator.
- **C3 — Per-task files `design/tasks/<phase-id>/<task-id>.yaml`** + a migration to split inline tasks (the one genuine layout change for tasks — phases are already split).
- **C4 — `plan lint` legacy advisories** (`LEGACY_SEQUENTIAL_PHASE_ID`, etc.), warning-only. **Re-scoped by control-plane-v2 PR1b:** must **not** ship on default `plan lint` / `doctor` (they would flag the *current canonical* layout as "legacy" before any alternative exists, contradicting the shipped `PHASE_ID_NAMING` check); they belong to a future explicit `upgrade` / `migrate --check` surface.
- **Logical clocks** for event ordering (see B2 rationale).
- **No server, daemon, database, remote lock, or GitHub integration.**

## Alternatives considered

- **Lock `progress.yaml` writes** (per [governance](governance-rfc.md)) — rejected; the monolithic read-append-rewrite can *lose* a concurrent event, so the real fix is per-event files (B1), not a lock. Event-files are safe by construction even without the lock.
- **Logical / vector / Lamport clocks for ordering** — rejected; per-task lifecycle is single-actor-monotonic in practice (B2), and the residual cross-machine same-task case is a genuine semantic conflict that should *surface* (B6), not be auto-resolved by silently picking a winner.
- **Truncated `id12` filename prefix** — rejected; reintroduces an undefined collision case (two distinct events sharing `at`-ms + 12-hex prefix). The full-digest `<at-compact>-<id>.yaml` (~90 chars) buys an unconditional collision-free property; readability is the cheaper thing to give up.
- **Make `deriveTaskState` conflict-aware** — rejected; it stays total/deterministic for backward compatibility. Conflict surfacing is a separate read-time detector (B6) on `analyze`/`doctor`/`status`, not the reducer.
- **"Deliberate solo-maintainer exception" for the dogfood repo's blanket ignore** — rejected (A3); it undermines the RFC's credibility. The repo narrows its ignore and commits shared config, with only the adapter-manifest and legacy-ledger exceptions.
- **Random event ids** — rejected; content-derived ids make legacy↔file dedup and re-run/migration safety bookkeeping-free.
- **Bucket C now** (canonical ids, roadmap-optional, task-file split) — deferred behind a real-demand trigger per P22/P37, not dropped.

## Open questions

Residual (decide at implementation):

- **Migration command name** — `plan migrate --events` vs `task migrate` vs a new verb; fit the existing command clustering (P27).
- **Lint inclusion (decided):** `PROGRESS_EVENT_CONFLICT` stays **out** of `plan lint`; surfaced by `plan analyze` / `doctor` and `status.data.conflicts[]` (since D3); `verify` does not surface it — mirroring the analyze/doctor-only `ORPHAN_PROGRESS_EVENT` choice.
- **Blanket-ignore advisory (A1 follow-up):** `init` cannot delete a user's pre-existing blanket `/.code-pact/` ignore, so the policy is *written*, not *enforced*. A `doctor`/`init` advisory detecting it would close the gap; deferred (needs an i18n string + a new check). Bucket A only softens the claim and pins the no-delete behavior with a test.

Resolved during review: **Q1 → A3** (dogfood repo migrates to commit event-files with a narrow ignore; "solo exception" rejected). **Q2** (`progress.yaml` read-merged indefinitely; the writer never rewrites it; cleanup is a future explicit opt-in). **Q3** (full sha256 id in the event body; filename uses the full id as its suffix, not a truncated prefix; dedup on the full id).

## References

- RFCs: [Governance](governance-rfc.md) · [CI branch-drift](ci-branch-drift-rfc.md) · [Control-plane v2](control-plane-v2-rfc.md) (Bucket C) · [Collaboration UX](collaboration-ux-rfc.md) (D3 `status.data.conflicts[]`) · [P22 cancelled](P22-cancelled-adapter-schema-v2.md) / [P37 deferred](P37-deferred-outcome-audit.md).
- Docs: `docs/cli-contract.md` (§ State file write guarantees) · `docs/concepts/governance.md` · `docs/workflows/ci.md` · `docs/dogfood.md`.
- Code: `src/core/progress/io.ts` (`appendEvent`) · `src/core/progress/task-state.ts` (`deriveTaskState`) · `src/core/plan/checks.ts` (conflict detector) · `src/commands/init.ts` (gitignore policy).
