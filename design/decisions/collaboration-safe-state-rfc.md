# RFC: Collaboration-safe shared state — event-file progress ledger

**Status:** accepted (A1–A3 + B1–B6 scope, 2026-06)

- Phase: — (unassigned; assign at adoption per the project's current id convention)
- Date: 2026-06-03
- Owners: maintainer
- Related: [Governance](governance-rfc.md) (the v1.5 advisory write lock), [CI branch-drift](ci-branch-drift-rfc.md) (the committed-ledger precondition), [P22 cancelled](P22-cancelled-adapter-schema-v2.md) / [P37 deferred](P37-deferred-outcome-audit.md) (the project's no-preemptive-engineering precedent this RFC's deferral relies on)

## Summary

`code-pact`'s shared state model is not collaboration-safe. The progress ledger
is documented as "append-only by contract" but is implemented as a
whole-file read-modify-rewrite, so concurrent writers can lose events and
branch merges can corrupt or silently reorder the log. Separately, the product
contradicts itself on whether `.code-pact/` is committed or ignored.

This RFC fixes the two issues that are **broken now and independent of team
size** (Bucket A) and makes the **one structural change with the best
cost/benefit** (Bucket B): moving the progress ledger from a single
`progress.yaml` array to one-file-per-event under `.code-pact/state/events/`,
with deterministic dual-read of the legacy file for backward compatibility.

It **explicitly defers** the larger v2 control-plane changes — collision-resistant
canonical phase ids, retiring `roadmap.yaml` as the mandatory registry, and
splitting inline tasks into per-task files (Bucket C) — behind a real-demand
trigger. That deferral is not timidity; it is consistency with this project's
own accepted decisions to refuse preemptive engineering without observed user
pain ([P22](P22-cancelled-adapter-schema-v2.md), [P37](P37-deferred-outcome-audit.md)).

## Problem

Every claim below was verified against the current tree.

### 1. The progress ledger is not a safe append (Bucket B)

`appendEvent` loads the whole file, spreads the array, and rewrites the file:

```ts
// src/core/progress/io.ts:55-58
const { log, path } = await loadProgressLog(cwd);
const nextLog: ProgressLog = { events: [...log.events, event] };
await atomicWriteYaml(path, nextLog);
```

`atomicWriteText` is honest that it does not help here:

```ts
// src/io/atomic-text.ts:8 — "Does NOT protect against concurrent writers"
```

And the write is **deliberately excluded from the advisory lock**:

> `task complete` / `task start` / `task block` / `task resume` | **No**
> (progress.yaml is append-only by contract) — `docs/concepts/governance.md:52`

So two `task start`/`task complete` invocations that read the same base file
will each rewrite it, and the second `rename` wins — a **lost update**, not the
"worst case is event reordering" the governance doc implies. The CLI contract is
actually more honest in one place ("Concurrent `task complete` calls are out of
scope for v0.2" — `cli-contract.md:1852`) and misleading in another
(governance's "append-only by contract"). They must be reconciled.

**Two distinct failure modes, same root cause — be precise about which:**

- **Lost update from concurrent writers on one machine.** Real per the code, but
  *low probability* in practice: a single developer runs these verbs serially.
  We should not oversell this as the motivating threat.
- **Branch-merge corruption.** The *dominant, high-probability* failure for any
  team: contributor A on branch-1 and contributor B on branch-2 both append to
  the same `events:` array. Git either conflicts on the adjacent lines or
  auto-merges into a valid-looking but reordered/duplicated log. Because the
  state reducer trusts array order (next point), a bad merge silently changes
  derived task state.

### 2. The state reducer trusts array order, not timestamps

`deriveTaskState` takes the **last array element** as the current state — it
does not sort by `at`:

```ts
// src/core/progress/task-state.ts:34-35
const history = events.filter((e) => e.task_id === taskId);
const last = history[history.length - 1];
```

This is correct today only because `appendEvent` always pushes to the end. The
moment the single array is replaced by many files (Bucket B), the reader must
*reconstruct* a deterministic order that does **not** depend on filesystem
enumeration order. This is the crux of the event-file design (see Decision B2).

### 3. `.code-pact/` shared-vs-local is self-contradictory (Bucket A)

| Source | Says |
| --- | --- |
| `src/commands/init.ts:270` | ignores **only** `/.local/` and `/.context/` → everything else in `.code-pact/` is committed, **including `.code-pact/locks/`** (machine-local lock files with pid/hostname) |
| `docs/workflows/ci.md:84` | "**Commit `.code-pact/`** — the project config **and** `state/progress.yaml`" |
| `docs/cli-contract.md:1770` | the ledger "is committable, and in the normal case you commit it" |
| `docs/dogfood.md:5` | "this repo **gitignores** `/.code-pact/`, so it is **not** committed" |
| this repo's `.gitignore:10` | `/.code-pact/` (ignored wholesale) |

So the product's own default (init + ci + cli-contract) says *commit it*, while
the project's own dogfood repo *ignores it*. Two concrete bugs fall out:

- **init commits lock files.** `init` does not ignore `.code-pact/locks/`, so a
  user repo would commit machine-local lock state. Latent, independent of the
  rest of this RFC.
- **The bind the dogfood repo is escaping.** Commit `progress.yaml` → merge
  conflicts; ignore it → the `CONTROL_PLANE_BRANCH_NOT_DRIVEN` CI gate
  (`cli-contract.md:1722`) silently skips because the ledger is untracked. The
  maintainer chose "ignore," which is itself evidence the monolithic ledger is
  painful to commit even solo. The event-file model (Bucket B) dissolves the
  bind: event-files are conflict-free, so committing them is painless and the CI
  gate keeps working.

### Not in scope here — but verified, so it is recorded (Bucket C)

These are real and correctly diagnosed, but deferred (see Non-goals):

- Sequential `P<N>` ids are the canonical primary key and are minted
  branch-locally (`plan-adopt.ts:259-271` does `max(P<N>)+1`;
  `createPhase.ts:117-150` keys filename, dedupe, and `roadmap.push` on the id),
  so two branches can each mint `P51`. **Mitigating nuance:** phase bodies are
  *already* one-file-per-phase (`createPhase.ts:125` →
  `design/phases/<id>-<slug>.yaml`); the only central hotspot is the ordering
  index `roadmap.yaml` (`roadmap.ts:20-22`), whose append conflicts are usually
  trivial to resolve.
- Tasks **are** inline in the phase YAML (`createPhase.ts:142`), so two people
  adding tasks to the same phase do conflict. This is the one Bucket-C item that
  is a genuine file-layout change (phases are already split; tasks are not).

## Decisions

### A1 — One shared-vs-local policy, written by `init`

`init` writes a `.gitignore` that ignores the local/derived subset; the rest is
committable. **"Written by", not "enforced by":** `init` merges entries into an
existing `.gitignore` and never deletes a user's lines, so a pre-existing blanket
`/.code-pact/` ignore survives and silently defeats the policy (the CI gate then
skips). Surfacing that — a `doctor` / `init` advisory when a blanket
`/.code-pact/` ignore is detected — is a deferred follow-up (see Open questions);
the source-of-truth table below is published in `cli-contract.md` § State file
write guarantees and linked from governance, ci, dogfood:

| Path | Disposition | Why |
| --- | --- | --- |
| `.code-pact/project.yaml` | **commit** | shared config |
| `.code-pact/agent-profiles/*`, `.code-pact/model-profiles/*` | **commit** | shared config |
| `.code-pact/adapters/*.manifest.yaml` | **commit *with* its generated files** | the manifest records adapter-owned files (e.g. `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/skills/*`, `.cursor/**`) as *managed*; committing it **without** those files makes a clean checkout fail `adapter doctor` with `ADAPTER_FILE_MISSING` (error). A repo that ignores its adapter output (e.g. **this** repo, A3) **ignores the manifest too** |
| `.code-pact/templates/**` | **commit** | shared adapter templates |
| `.code-pact/state/events/**` | **commit** | the new ledger; conflict-free (B1) |
| `.code-pact/state/baselines/**` | **commit** | shared snapshots used by drift detection |
| `.code-pact/state/progress.yaml` | **commit while present** (legacy) | read-merged (B3); migration target (B4) |
| `.code-pact/locks/**` | **ignore** | machine-local (pid/hostname) — fixes the init-commits-locks bug |
| `.code-pact/cache/**` | **ignore** | derived (reserved; none today) |
| `.context/**`, `.local/**` | **ignore** (already) | regenerated / per-developer |

`init` gains `/.code-pact/locks/` and `/.code-pact/cache/` to the entries it
writes. The narrow-ignore lines are anchored so test fixtures are unaffected
(mirror the existing `/.code-pact/` anchoring note in this repo's `.gitignore`).
The adapter-manifest row is the one **conditional** entry: it is shared *only*
when its generated files are also committed (the common user case); a repo that
treats adapter output as regenerated (A3) ignores both.

### A2 — Reconcile the docs, stop claiming a guarantee the code does not keep

- `governance.md:52`: replace "append-only by contract" with a pointer to the
  event-file safety model (B1) — the safety now comes from the *data model*
  (distinct files), not from a contract the monolithic writer never kept.
- `cli-contract.md` § State file write guarantees: document the event-file write
  (exclusive create, no read-modify-write) and the dual-read merge; keep the
  honest "concurrent X out of scope" note only for any path that genuinely
  remains monolithic, otherwise remove it.
- `dogfood.md:5`: stop stating the universal-sounding "this repo ignores
  `.code-pact/`." The dogfood-specific resolution is its own decision — see A3.

### A3 — Dogfood repo: narrow ignore + commit the shared config (not the adapter manifest)

The "deliberate solo-maintainer exception" framing is rejected: a product that
tells users to commit shared control-plane state while its own flagship repo
blanket-ignores `.code-pact/` undermines this RFC's credibility. So this repo
narrows `.gitignore` to the local/derived subset and commits the shared config —
`project.yaml`, agent/model profiles, `state/baselines/`.

**Two principled this-repo exceptions stay ignored:**

- **The adapter manifest** (`.code-pact/adapters/`). This repo is the *source* of
  the adapter templates and regenerates `CLAUDE.md` / `.claude/skills/*` (already
  gitignored). Committing the manifest alone would orphan it — a clean checkout
  would fail `adapter doctor` with `ADAPTER_FILE_MISSING` (the manifest-aware
  check runs only when the manifest is present; an absent manifest is safely
  skipped). Manifest and its generated files travel together or not at all; here,
  not at all.
- **The legacy monolithic `state/progress.yaml`** — stays ignored until per-event
  files (B) replace it. Committing the monolithic ledger now would reintroduce the
  merge problem B fixes, and the CI branch-drift gate will read the *event* ledger
  anyway.

Committing this repo's previously-untracked config to a public repo is a
maintainer action; the documented default for a normal user repo is **commit the
shared config** (with the manifest caveat in A1). (Resolves Q1.)

### B1 — One file per event; safety from the data model

New writer path: each progress event is written as its own file under
`.code-pact/state/events/`, created with an **exclusive** flag (`wx`). There is
no load, no array spread, no whole-file rewrite. Consequences:

- **No lost update**, even without the lock: two concurrent writers produce two
  different files (different content → different id → different name); both
  survive. (The advisory-lock exclusion at `governance.md:52` becomes safe by
  construction rather than by unkept promise.)
- **Idempotent create**: the writer uses `wx`; an `EEXIST` means the identical
  event is already on disk (same content → same `<at-compact>-<id>.yaml` filename, B5) → treat as
  success, not error. This is what makes re-runs and migration (B4) safe with no
  bookkeeping, and it is the *only* write-path collision case — there is no
  distinct-event filename clash to resolve.
- **No branch-merge corruption**: distinct filenames mean git never has to merge
  two appends to the same line. Two branches each adding *different* events merge
  cleanly (new files on both sides). The only path-level collision is two
  branches writing the **same** event — same content → same `<at-compact>-<id>.yaml` filename →
  git sees identical files, a trivial resolution. *Semantic* conflicts (different
  events asserting incompatible task lifecycles) are **not** filename collisions;
  they are detected at read time by B6 (surfaced by `plan analyze` / `doctor`,
  and `status.data.conflicts[]` since D3).

### B2 — Deterministic, glob-order-independent merge order

The reader never trusts directory enumeration order. It sorts by a total key:

- **Primary:** `at` (ISO-8601 with offset; already on every event,
  `progress-event.ts:25`), ascending.
- **Tiebreaker:** the event `id` (B5), ascending — deterministic for equal `at`.
- (Optional final tiebreaker for byte-stable reproduction of a legacy file's
  intra-second order: the legacy array index. Only needed if a golden test
  requires it; `at`+`id` is otherwise total.)

**Clock skew is acknowledged, not solved with logical clocks.** `at` is
wall-clock; two machines can disagree. We do **not** add vector/Lamport clocks,
for a reasoned trade-off:

1. `deriveTaskState` filters by `task_id` first, and a single task's lifecycle
   (`started → … → done`) is almost always produced by one actor on one machine,
   whose clock is internally monotonic — so per-task ordering, the only thing the
   reducer depends on, stays correct.
2. The residual case — the *same* task driven concurrently on two machines with
   skewed clocks — is a **genuine semantic conflict** (two people worked the same
   task at once). A logical clock would let the tool silently pick a winner; the
   Acceptance criteria say such a case should *surface*, not be auto-resolved.

Recorded as a non-goal with this rationale, in the P22/P37 negative-space style.
**Crucially, "surface" is only real if something detects it** — see B6. Skipping
logical clocks is fine; skipping conflict detection would make "surface" a
hollow claim, because the reducer (B3) takes the last event and would otherwise
pick a silent winner.

### B3 — Dual-read with a uniform in-memory shape (minimal blast radius)

All current consumers read the same `ProgressLog { events: ProgressEvent[] }`
in-memory shape (`state.ts`, `analyze.ts`, `pack/index.ts`, `verify.ts:165`,
`doctor.ts`, every `task-*.ts` via `deriveTaskState`). **We change only how that
array is assembled, not its shape**, so consumers are untouched.

`loadProgressLog` (and the parallel readers) gain an assembly step with a
**legacy-only fast path that is byte-for-byte behaviour-identical to today**:

1. Parse legacy `.code-pact/state/progress.yaml` if present → events, each
   assigned the content id from B5 and a synthetic `source_order` = its array
   index (used only as a final tiebreaker; **not** an identity — see B5).
2. Parse every `.code-pact/state/events/*.yaml` → events (each carries its id).
3. **If there are no event-files**, return the legacy events **in their original
   array order, unsorted** — exactly today's reducer input. This is why we do
   *not* sort a legacy-only repo (see the backward-compat guarantee).
4. Otherwise (event-files present, with or without legacy): dedupe by **full
   `id`** (an event migrated to a file but still in the legacy array collapses to
   one), then sort by the B2 total key — `at` asc, then `id` asc, then legacy
   `source_order` asc as the final tiebreaker so legacy events keep their
   relative order on equal `(at, id)`. Return `{ events }`.

The reducer `deriveTaskState` keeps using `history[length-1]` unchanged. **It is
deliberately not made conflict-aware** — it stays total and deterministic for
compatibility; surfacing genuine conflicts is B6's job (`plan analyze` / `doctor`,
and `status.data.conflicts[]` since D3), not the reducer's.

### B4 — Idempotent migration

`plan migrate --events [--write]` (name TBD; dry-run is the default):

- For each event in the legacy `progress.yaml`, write the corresponding
  event-file. Idempotent by construction: the id is content-derived **and the
  filename embeds the full id as its suffix** (`<at-compact>-<id>.yaml`, B5), so a
  re-run's `wx` hits `EEXIST` on the *same* event and treats it as "already
  migrated → skip" — there is no distinct-event ambiguity to disambiguate.
- Leaves `progress.yaml` in place (readers keep merging it), so re-running is a
  no-op and partial migrations are safe. Optionally emptying/removing it is a
  later, separate step once a repo has fully cut over.
- **Reports derived-state changes:** for each task, compute the derived `current`
  under both the legacy array order and the post-migration `(at, id)` order; if
  any differs, report it (per B3 / Backward compatibility), so the maintainer
  reviews the flip instead of discovering it later. This is the safety net for
  the one moment a repo's order semantics can change.
- Does **not** touch phase ids, task layout, or `roadmap.yaml`.

### B5 — Collision-resistant, content-derived event ids

`id = sha256_hex(canonicalizeEvent(payload))` — the **full** 64-char sha256 hex
digest, stored in the event body. **The filename is `<at-compact>-<full-id>.yaml`
— the full digest, not a truncated prefix** — where `<at-compact>` is the
**normalized (UTC) `at`** rendered compactly (`YYYYMMDDTHHMMSSsssZ`) for a
human-browsable, roughly-chronological `ls`. Both parts are fully determined by
the canonical event, so the **filename is deterministically derived from content**
— and in bijection with the `id` (same `id` ⟺ same filename, since `<at-compact>`
is itself content-derived): a filename collision occurs **iff** the events are
*canonically identical* (same canonical payload).
That collapses the write-path collision question to a single rule — a
pre-existing final file (published via a temp file + `link`, so it is never
overwritten) means *the canonically identical event is already on disk*
(idempotent success, B1), never a distinct-event clash needing a longer suffix or
fallback. (A truncated
`id12` filename would reintroduce an undefined case: two distinct events sharing
an `at`-ms **and** a 12-hex prefix collide on path while differing in full id.
The `<at-compact>-<id>.yaml` filename (full digest, not a truncated prefix) is
~90 chars — well under the 255 limit — and buys an unconditional collision-free
property; readability is the cheaper thing to give up.) Dedup is on the full `id`
(the digest carried as the filename suffix). Reuse the
project's existing sha256-hex convention (`node:crypto` `createHash`, as in
[`src/core/adapters/manifest.ts:95`](../../src/core/adapters/manifest.ts)); add
only the `canonicalizeEvent` step below.

**Canonical event payload — the exact hash input. It must be pinned, or the id is
not reproducible and dedup / idempotent-migration silently break:**

- Includes every persisted event field **except `id`**; includes `at`.
- Excludes all filename- and filesystem-derived metadata and `source_order`.
- Object keys sorted recursively; absent/`undefined` optional fields are omitted;
  array element order is preserved. **`null` is never normalized to absent.** The
  schema's optionals are `.optional()` (undefined-only, `progress-event.ts`), so a
  `null` optional is schema-invalid and is rejected by `ProgressEvent.parse`
  *before* canonicalization. `canonicalizeEvent` deliberately does **not** map
  `null`→absent — silently doing so would let a malformed persisted event pass
  unnoticed instead of being reported.
- `at` is normalized to UTC ISO-8601 with milliseconds (`…Z`) **before** hashing,
  so the same instant written with different offsets hashes identically.
- The hash input is the canonical **JSON** of the payload (UTF-8, LF) — YAML
  formatting/whitespace is never part of the hash.
- A **single** `canonicalizeEvent()` is the only producer of the hash input and
  is called from all three sites — the loader (id-assigning legacy events), the
  new-event writer, and migration — so they can never drift apart.

Why content-derived rather than random: the same logical event always hashes to
the same id, so legacy↔file dedup (B3) and re-run safety (B4) need no
bookkeeping. Distinct real events do not collide — `at` carries milliseconds, so
two genuine events for one task differ in content; an identical digest means an
identical event, which is correct to dedupe. (`Date.now()`/`Math.random()` are
available in normal CLI source, but a content hash is strictly better here.)

### B6 — Semantic conflict detection (makes "surface, don't auto-resolve" real)

B2 declines logical clocks on the grounds that a same-task concurrent edit is a
genuine semantic conflict that should *surface*. But the reducer (B3) takes
`history[length-1]`, so on its own it would silently pick a winner. "Surface" is
real only if something detects the conflict. That detector is a new
`detectProgressEventConflicts(events)` in `src/core/plan/checks.ts`, mirroring
the existing `detectOrphanProgressEvents` (same file, same issue shape), emitting
`PROGRESS_EVENT_CONFLICT` (`severity: "warning"`) from `plan analyze` and
`doctor` (and, since Collaboration UX D3, from `code-pact status` as
`data.conflicts[]` with structured attribution). It is **not** a `plan lint`
diagnostic and `verify` does not surface it. **default → warning; `validate
--strict` → failure** because `validate` delegates to `doctor` (`runDoctor()`)
and promotes its warnings under `--strict`; `plan analyze` is a separate reporting
surface. Advisory by default — never changes exit on its own; promoted to a hard
failure by `validate --strict`, the same established strict path that gates
P34's branch-drift advisory (see
[`ci-branch-drift-rfc.md`](ci-branch-drift-rfc.md): `runValidate`'s strict
semantics already fail on warnings, so no new gate machinery is needed). This is
the team/CI lever — a conflict that is invisible in `--strict` would be too weak.

A conflict is reported when, folding a single task's events through the
`assertTransition` state machine (`src/core/progress/task-state.ts`) in
`(at, id)` order, an event has **no valid predecessor** or two distinct event ids
assert **incompatible** transitions. At least these:

- `done` and `blocked` for the same task with no intervening `resumed`/`started`.
- a second `started` while the task is already `started` (distinct event ids).
- `done` after `done` with different event ids.
- any pair whose relative order is decided only by wall-clock `at` yet violates
  the lifecycle state machine — the clock-skew case B2 deliberately routes to
  detection rather than silent resolution.

The reducer still returns a derived state for compatibility; the conflict is
reported alongside it, not swallowed.

## Backward compatibility

- **Read (legacy-only): a guarantee, not a hope.** A repo with only a legacy
  `progress.yaml` (no event-files) reads **byte-for-byte identically** — B3's
  legacy-only fast path returns the array **unsorted**, so the reducer sees
  exactly today's input. This holds **even if the legacy array order disagrees
  with `at` order** (manual edits, clock adjustments). We do **not** silently
  re-sort an existing repo. (My earlier draft claimed identity only "if events
  are in `at` order" — that was an over-claim the current `array-order-is-truth`
  reducer does not back; this fast path makes it unconditional.)
- **Transition (first event-file / after migration): reported, not silent.** Once
  event-files exist, the merge sorts by `(at, id, source_order)`. If a repo's
  legacy array order disagreed with `at` order, a task's derived state could
  change. Migration (B4) **must detect and report** any task whose derived
  `current` flips, so the change is reviewed — never a silent regression.
- **Write:** new events go to event-files. Legacy `progress.yaml` is never
  rewritten by the new path (so it can stay byte-stable / untracked / committed
  per the repo's choice). It is **read-merged indefinitely** (Q2, resolved);
  emptying/removing it is a future, explicit opt-in command, never automatic.
- **No id rewrites:** existing `P50`/`P<N>` ids, phase files, and `roadmap.yaml`
  are untouched. The id question is out of scope (Non-goals).

## Non-goals (deferred to a follow-up "v2 control plane" RFC)

Gated on a **real-demand trigger**: a second active contributor (i.e.
`git shortlog -sn` shows >1 author) or a concrete external team adopter. Until
then these are preemptive engineering, which this project has twice chosen to
refuse without observed pain ([P22](P22-cancelled-adapter-schema-v2.md),
[P37](P37-deferred-outcome-audit.md)).

- **C1 — Collision-resistant canonical phase ids / retiring `P<N>` as primary
  key.** Correct in principle, but it taxes the *common* (solo) path — every
  invocation would take a hash-suffixed id — to fix a problem no current user
  has. When taken up, evaluate `slug`-only (human-typable, collides only on
  same-slug-same-day, detectable at merge) before `slug+hash`; the maximalist
  form may be over-engineered.
- **C2 — `roadmap.yaml` optional / discover `design/phases/*.yaml` by glob.**
  Phase files already exist; this is a reader change plus a `plan index --write`
  regenerator. Smaller than it sounds, but still C.
- **C3 — Per-task files `design/tasks/<phase-id>/<task-id>.yaml`** + a migration
  to split inline tasks. The one genuine layout change for tasks.
- **C4 — `plan lint` legacy advisories** (`LEGACY_SEQUENTIAL_PHASE_ID`,
  `LEGACY_INLINE_TASKS`, `LEGACY_MONOLITHIC_PROGRESS_LOG`), warning-only.
  **Superseded by the control-plane-v2 PR1b re-scope:** these
  migration-readiness advisories must **not** ship on default `plan lint` /
  `doctor` — they would flag the *current canonical* layout (`P<N>` ids, inline
  tasks) as "legacy" before any non-legacy alternative exists, and contradict the
  shipped `PHASE_ID_NAMING` check. They belong to a future **explicit**
  `upgrade` / `migrate --check` surface, shown only when a user intentionally runs
  a migration check. See [control-plane-v2](control-plane-v2-rfc.md) (PR1b).
- **Logical clocks** for event ordering (see B2 rationale).
- **No server, daemon, database, remote lock, or GitHub integration.**

## Acceptance criteria

A team can have multiple contributors independently **record progress** on
separate branches, then merge with either no conflict or only a genuine semantic
conflict — driven by the tool, not human discipline. Concretely:

1. Two branches each appending progress events merge with **no** git conflict and
   **no** lost event (both events present and counted once after merge).
2. Concurrent event writes on one machine cannot lose an event (exclusive-create;
   two writers → two files).
3. A legacy-only repo (`progress.yaml`, no events dir) derives **byte-for-byte
   identical** task state before and after — because the loader preserves legacy
   array order when no event-files are present (the B3 fast path), independent of
   whether array order matches `at` order.
4. Migration is idempotent: running it twice produces the same event set and
   rewrites nothing on the second run.
5. `init` no longer commits `.code-pact/locks/`; the published shared-vs-local
   table matches what `init` writes and what governance/ci/dogfood say.
6. No `P<N>` id, phase file, `roadmap.yaml`, or inline task is rewritten by any
   path in this RFC.
7. A merged event set with incompatible lifecycle events for one task (e.g. two
   branches both `done` it) yields a `PROGRESS_EVENT_CONFLICT` from
   `plan analyze` / `doctor` (and `status.data.conflicts[]` since D3) — the
   conflict surfaces, it is not silently resolved.
8. Migration reports any task whose derived state changes under `at`-sort versus
   the legacy array order.

## Test plan

- **Reducer/merge:** event-files in shuffled filesystem order derive the same
  task state as their `(at, id)`-sorted order (glob-order independence, B2).
- **Dual-read:** legacy-only, events-only, and mixed (legacy + migrated file for
  the same event) all yield the correct deduped, ordered `events`.
- **Legacy-only fast path:** a `progress.yaml` whose **array order disagrees with
  `at` order** derives the *array-order* state (no sort applied) — guards the
  backward-compat guarantee, not just the happy path.
- **Canonical id:** the same logical event (incl. an `at` written with a `+09:00`
  offset vs `Z`) produces the same full sha256 id; reordered keys and absent-vs-
  explicit-`undefined` optionals do not change it; a schema-invalid `null`
  optional is **rejected by `ProgressEvent.parse`**, not silently normalized.
- **Concurrency / idempotent create:** two writers producing distinct event-files
  both survive (no read-modify-write race); re-writing the *same* event hits
  `wx` `EEXIST` on the identical `<at-compact>-<id>.yaml` filename and is treated as success.
- **Merge:** apply two divergent branches' event sets; assert union, no loss, no
  dup (conflict-free; RFC-conformance test per the P28 convention).
- **Conflict detection:** a merged set with incompatible same-task lifecycle
  events emits `PROGRESS_EVENT_CONFLICT` (warning) from `plan analyze` / `doctor`
  (and `status.data.conflicts[]` since D3), while the reducer still returns a
  derived state.
- **Migration idempotency + report:** run twice → second run is a no-op
  (unchanged tree); a fixture whose array order ≠ `at` order is flagged as a
  derived-state change on migrate.
- **gitignore:** `init` output ignores `locks/`/`cache/` and commits
  `events/`/`project.yaml`/profiles/baselines.

## Rollout / sequencing

1. **A1 + A2 + A3 (partial)** ship first and alone — correctness/credibility fixes
   with no data-model dependency: the lock-file ignore (A1), the doc
   reconciliation (A2), and the `.gitignore` narrowing + committing the
   already-shared **non-ledger** config (A3: `project.yaml`, profiles, baselines
   — **not** `adapters/`: this repo ignores the manifest because its adapter-owned
   output is regenerated/ignored, so committing the manifest alone would orphan it
   → clean-checkout `ADAPTER_FILE_MISSING`). **A3 is split by necessity** — the event *ledger*
   cannot be committed here because event-files do not exist until B5/B1, so A3's
   ledger-commit completes only **after B + migration**. The legacy
   `progress.yaml` is **not** newly committed in this PR (still monolithic;
   committing it now would reintroduce the merge problem B fixes). **Maintainer-
   gated:** A3 commits this public repo's previously-untracked state, so the PR is
   opened and reviewed but the `git add` merges only on explicit maintainer
   approval. (For a *user's* own repo, A1's `init` change makes the same policy
   the default, no gate.) After B lands, this repo commits
   `.code-pact/state/events/.gitkeep` until the first real event file exists, so
   the committed-ledger precondition (`CONTROL_PLANE_BRANCH_NOT_DRIVEN`'s
   tracked-ledger gate) is satisfied — making the branch-drift gate **dogfoodable**
   (it no longer silently skips here; wiring `--base-ref` into this repo's own CI
   is a separate follow-up) — without committing the legacy monolithic
   `progress.yaml`. The
   ledger readers ignore any name that is not an `<at-compact>-<id>.yaml` event
   file, so the sentinel never affects derived state.
2. **B5 → B1 → B2/B3** (id, writer, reader) behind the existing readers; new
   writes go to event-files, dual-read merges legacy. **B6** lands with B3 (the
   reader is where conflict detection runs).
3. **B4** migration command.
4. Docs (`cli-contract`, `governance`, `ci`, `dogfood`, `getting-started`,
   `troubleshooting`, upgrading) updated to the published table and the
   event-file model.

## Open questions

Residual after review (decide at implementation):

- **Migration command name:** `plan migrate --events` vs `task migrate` vs a new
  verb — pick to fit the existing command clustering (P27).
- **Lint inclusion (decided by implementation):** `PROGRESS_EVENT_CONFLICT` stays
  **out** of `plan lint`. It is surfaced by `plan analyze` / `doctor`, and — since
  Collaboration UX D3 — by `status.data.conflicts[]`; `verify` does not surface
  it. This mirrors the `ORPHAN_PROGRESS_EVENT` choice, which is analyze/doctor-only
  and deliberately not in lint (`src/core/plan/lint.ts:89`).
- **Blanket-ignore advisory (A1 follow-up):** `init` cannot delete a user's
  pre-existing blanket `/.code-pact/` ignore (it never removes user lines), so the
  shared-vs-local policy is *written*, not *enforced*. A `doctor` (and/or `init`)
  advisory that detects a blanket `/.code-pact/` ignore and points at the narrow
  policy would close the gap without "make the user coordinate." Deferred — it
  needs an i18n string and a new check; Bucket A only softens the claim and pins
  the no-delete behavior with a test.

Resolved during review (B2/B5/backward-compat hardening):

- **Q1 → A3.** The dogfood repo migrates to commit event-files with a narrow
  ignore; the "solo exception" framing is rejected.
- **Q2.** `progress.yaml` is read-merged indefinitely; the new writer never
  rewrites it; cleanup is a future explicit opt-in command.
- **Q3.** Full sha256 id stored in the event body; **filename uses the full id as
  its suffix** (`<at-compact>-<id>.yaml`, not a truncated prefix — see the B5
  rationale for why `id12` is rejected);
  dedup on the full id. Reuse `node:crypto` `createHash`; add only
  `canonicalizeEvent()`.
