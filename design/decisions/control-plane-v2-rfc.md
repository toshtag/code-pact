# RFC: Control-plane v2 — collaboration-safe phases, discovery, and task layout

**Status:** accepted (scope-limited — authorizes PR0 + PR1a + PR1b only; PR2+ gated on §5; 2026-06)

- Phase: — (unassigned; assign at acceptance per the project's current id convention)
- Date: 2026-06-04
- Owners: maintainer
- Related: [Collaboration-safe state](collaboration-safe-state-rfc.md) (this RFC takes up its explicitly-deferred **Bucket C**, C1–C4), [CI branch-drift](ci-branch-drift-rfc.md) (the committed-control-plane precondition), [Deterministic roadmap stabilization](deterministic-roadmap-stabilization-rfc.md) (reproducible roadmap generation), [Cross-phase dependencies](cross-phase-deps-rfc.md) (`depends_on` across phases), [P22 cancelled](P22-cancelled-adapter-schema-v2.md) / [P37 deferred](P37-deferred-outcome-audit.md) (the no-preemptive-engineering precedent this RFC is now allowed to cross)

> **This is a scope-limited *accepted* RFC, not an accepted v2 layout spec.** It
> deliberately does **not** pre-commit to a v2 layout, a v2.0.0 version, or a
> single big-bang PR. Its job is to record the demand (the first-hand incident in
> [§1](#1-incident-analysis)), decompose the problem, weigh alternatives honestly,
> fix the semver story, and propose an *incremental, additive* rollout.
> **Acceptance authorizes the investigation, PR0 (a no-behaviour-change
> refactor), PR1a (fail-closed phase-id resolution safety — `AMBIGUOUS_PHASE_ID`,
> exit 2) and PR1b (re-scoped to conflict-recovery actionability — see §6; the
> original `LEGACY_*` warning-default advisories are superseded/deferred) only;
> PR2+ stay gated on §5. Nothing more.**

## Summary

The [collaboration-safe-state RFC](collaboration-safe-state-rfc.md) made the
**progress ledger** collaboration-safe (one file per event, dual-read of legacy
`progress.yaml`, shipped additively in v1.31.0 as a **MINOR**). It explicitly
deferred the rest of the multi-contributor control-plane surface — **Bucket C** —
behind a real-demand trigger:

> a second active contributor (`git shortlog -sn` shows >1 author) **or** a
> concrete external team adopter.

**The trigger is now met — by its second leg.**
At the time this RFC was drafted, `git shortlog -sn` showed a **single primary
author**, so the "taxes the common solo path" warning in the precedent (C1) still
applies to *this* repo. (The author/commit breakdown is a living metric — it
belongs in the audit log, not pinned in this RFC body where it would rot; re-run
`git shortlog -sn` to check the current state.) The demand comes from an **external
project** that ran code-pact with multiple contributors and hit real conflicts. A
**first-hand structured account is now recorded** ([§1](#1-incident-analysis),
2026-06-04): the conflict spans phase-id collision, `roadmap.yaml` / inline-task
array merges, and agent confusion from duplicate ids — **decisively *not*
ledger-only**, so v1.31.0 alone does not discharge it. (Raw forensic artifacts —
diffs, conflict markers, merge commits — remain outstanding; see [§1](#1-incident-analysis).)

Bucket C is three independent structural changes plus an id question. The
precedent already proved the move that solves all of them — *shard the shared
file, dual-read the legacy form, migrate opt-in and dry-run by default* — and
shipped it as a **MINOR**. This RFC argues the same discipline applies here: each
piece can ship as a **backward-compatible additive minor**, and **v2.0.0 is a
product/branding choice, not a semver necessity** (see [Semver](#4-semver-analysis)).

## Context — what the control plane is today (verified against the current tree)

Three facts define the conflict surface. Each was checked in the current tree.

### Phase identity is a branch-local sequential counter

`nextPhaseId` is `max(P<N>) + 1`, computed from the local roadmap:

```ts
// src/commands/plan-adopt.ts:266-271
let max = 0;
// …
if (m) max = Math.max(max, Number(m[1]));
// …
return max + 1;
```

So two contributors branching from the same `P50` both mint **`P51`**. The only
guard is intra-roadmap:

```ts
// src/core/services/createPhase.ts:116-120
if (roadmap.phases.some((p) => p.id === id)) {
  throw new Error(`Phase "${id}" already exists in roadmap.yaml.`); // DUPLICATE_PHASE_ID
}
```

That catches a collision **within one branch's roadmap**, never a cross-branch
one. `P<N>` is the canonical primary key: filenames (`design/phases/<id>-<slug>.yaml`,
`createPhase.ts:125`), dedupe, `decision_refs`/`acceptance_refs` resolution, and
the roadmap registry all key on it.

### Phase discovery is registry-driven, not glob

`createPhase` appends every new phase to the central registry and rewrites it:

```ts
// src/core/services/createPhase.ts:148-150
const ref: PhaseRef = PhaseRef.parse({ id, path: relPath, weight });
roadmap.phases.push(ref);
await saveRoadmap(cwd, roadmap);
```

`design/roadmap.yaml` is a `phases: [{ id, path, weight }]` array (schema in
`src/core/schemas/roadmap.ts`). **It is the mandatory registry**: a phase file
that is not listed is not discovered. So two contributors each adding a phase
both append to the same `phases:` array — the classic adjacent-line merge
conflict, the same shape the ledger had before v1.31.0.

> **Hidden blast radius — verified.** `loadRoadmap` is **independently
> re-implemented in at least 8 files** (`pack/index.ts:205`, `createPhase.ts:59`,
> `recommend.ts:32`, `verify.ts:51`, `task-add.ts:68`, `progress.ts:44`,
> `phase.ts:12`, `phase-import.ts:97`). Any change to discovery touches all of
> them unless they are first consolidated behind one seam. This is a named
> prerequisite (PR0 in [Rollout](#6-recommended-rollout)), not a footnote.
> **Scope note:** these 8 are the *byte-equivalent* copies PR0 consolidates;
> other roadmap readers with **distinct contracts** — `resolveTaskInRoadmap`
> (`resolve-task.ts`), `doctor`'s validating reader, `plan adopt`'s id-minting
> reader, `phase reconcile`, and adapter generation (`adapters/claude.ts`) —
> are **not** part of PR0 and are addressed when the discovery contract itself
> changes (PR2+).

### Tasks are inline in the phase YAML

Tasks live in the phase file's `tasks:` array (see `design/phases/P5-planning-integrity.yaml`,
and `createPhase.ts`'s `...(opts.tasks?.length ? { tasks: opts.tasks } : {})`).
So two contributors adding tasks to the **same phase** edit the same array and
conflict. Phase *bodies* are already one-file-per-phase; tasks are the one
genuine file-layout gap the precedent named (C3).

## 1. Incident analysis

**Status: first-hand structured account received 2026-06-04** from the external
multi-contributor adopter. It is detailed, internally consistent, and matches the
code-level Context findings above — but it is a **described / reproducible
account, not a forensic trace** (**forensic trace not yet available**): raw diffs,
conflict markers, merge commits, branch names, and anonymized logs were **not**
supplied, and recovery *time* was not quantified. Those are the residual,
non-blocking [Open questions](#open-questions--required-incident-data).

### Files that conflicted

`.code-pact/state/progress.yaml`, `design/roadmap.yaml`,
`design/phases/<id>-*.yaml` (the inline `tasks:` array), and
`design/decisions/<Pn-Tm>-*.md` (duplicate-id ADR files).

### Conflict classes observed (reporter's labels → this RFC's decomposition)

| Reporter class | What happened | Maps to |
| --- | --- | --- |
| **phase-id collision** | ids minted by manual / `max+1` numbering, no cross-branch allocator → two branches mint the same `P<N>` | **D1** (confirms Context above: `plan-adopt.ts:266-271`) |
| **`roadmap.yaml` conflict** | two branches append to the single `phases:` array (hard conflict) **and** independently edit a phase `weight` (clean merge, semantically unintended total) | **D3/D4** + **D9** (new) |
| **inline task array** | two branches append to a phase's `tasks:` array; duplicate `P<N>-T<M>` ids | **D5** |
| **progress ledger** | concurrent appends to `events:` — reporter's **most frequent / loudest** class | **solved by v1.31.0** (per-event files) |
| **agent confusion** | a duplicate id resolved ambiguously by `task prepare` / `task context` → wrong context pack, re-implementing an already-`done` task, `done` appended to the wrong id | consequence of **D1/D5** (new: agent resolution must fail closed) |

The reporter's **primary** trigger: the progress ledger by *frequency*; phase-id
collision and inline-task arrays by *root cause* (no id allocator, shared arrays).
A loosely-described repro (item 10) paraphrases phase creation as `task start P6`;
the real mechanism is the branch-local `max+1` mint in `plan-adopt` / `createPhase`.

### The two failure modes — and which is dangerous

- **Hard conflict** (loud): shared-array appends (`progress.yaml events:`,
  `roadmap.yaml phases:`, phase `tasks:`) collide on adjacent lines. Git stops you.
  Annoying, not corrupting.
- **Clean-but-wrong auto-merge** (silent — *the dangerous one*): duplicate ids in
  *separate* files produce **no git conflict at all**; independent scalar edits
  (e.g. a phase `weight`) merge cleanly into a value no contributor intended. Git
  is silent; the corruption surfaces only later, *if* `plan lint` / `validate`
  happen to run. **This is the strongest argument for detection (PR1): the worst
  cases are invisible to git, so a tool-side detector is the only guard.**

### Two corrections to the raw report (verified against the tree)

1. **There is no `weight`-sum-100 invariant in code-pact.** The reporter's
   "weight total ≠ 100" was *their* project convention. The shipped roadmap has
   46 phases whose weights sum to **644**; the schema is
   `weight: z.number().positive()` and `total_weight` is derived at runtime, not
   constrained (`src/core/schemas/roadmap.ts`, `progress.ts:99-117`). The
   *code-true* generalization (**D9**) is broader and worse: **git merges any
   independent scalar edit cleanly and cannot enforce *any* cross-contributor
   semantic constraint** a project holds.
2. **Duplicate-id detection already exists — but only post-hoc.** `plan lint`
   already emits `DUPLICATE_PHASE_ID` / `DUPLICATE_TASK_ID` / `PHASE_ID_MISMATCH`
   (`src/core/plan/checks.ts:47,69,92`) — **single-tree, after-the-fact**
   validators. The incident's gap is therefore *not* "no detector exists"; it is
   (a) nothing runs them at the dangerous moment (merge / pre-branch), (b) they
   are not cross-branch, and (c) the **agent path resolves an ambiguous id instead
   of refusing**. PR1's net-new value is precisely (a)–(c), not the bare check.
   **Severity caveat:** these existing checks are `severity: error`
   (`checks.ts:48,70,93`) and already fail `plan lint`'s exit *by default*, so PR1's
   new dangerous-moment / cross-branch surface must be a **separate
   `warning`-severity advisory** (not a re-run of the error check) to stay inside
   the §5 diagnostics exemption.
3. **Task-id ambiguity is *already* fail-closed; the silent path was PHASE ids.**
   `resolveTaskInRoadmap` (P14) already throws `AMBIGUOUS_TASK_ID` for a duplicate
   *task* id, so the §1 "duplicate `P1-T5` → wrong context pack" symptom was
   already covered. The real fail-**open** was *phase*-id resolution: eight call
   sites did `roadmap.phases.find((p) => p.id === id)` and silently took the first
   match on a duplicate phase id. **PR1a (shipped) closes this** — a shared
   `src/core/plan/resolve-phase.ts` throws the new `AMBIGUOUS_PHASE_ID` (exit 2,
   `data.phases[]` lists the colliding files) across all eight, mirroring the P14
   task resolver.

### Decision-gate verdict

**The incident is decisively NOT ledger-only.** v1.31.0 removed the most frequent
class (the progress ledger), but every plan-side root remains: branch-local id
minting (D1), shared `roadmap.yaml` / `tasks:` arrays (D3/D4/D5), unguarded
cross-file / semantic invariants (D9), and fail-open agent id resolution. So the
scope does **not** collapse — Bucket C is justified. The evidence also *orders*
it: PR1 diagnostics are the highest-value first ship (the worst failures are
git-silent), and the documented roots are id allocation (D1) and task storage (D5).

## 2. Problem decomposition

Bucket C is not one problem. Treating it as one is how scope inflates into a
big-bang v2. These are **separate concerns**; each is evaluated for whether it
must co-ship with any other (answer, for almost all: **no**).

| # | Concern | What conflicts today | Independent? |
| --- | --- | --- | --- |
| D1 | **Canonical phase identity** | branch-local `max+1` → duplicate `P<N>` | yes |
| D2 | **Human-facing label / ordinal** | `P<N>` doubles as *both* identity and display order | coupled to D1 only |
| D3 | **Phase discovery** | registry-only; unlisted phase = invisible | yes |
| D4 | **Phase ordering** | `roadmap.yaml` array order + `weight` | coupled to D3 |
| D5 | **Task storage layout** | inline `tasks:` array per phase | yes |
| D6 | **Migration** | none exists for phases/tasks | depends on D1/D3/D5 |
| D7 | **Branch-drift / CI** | gate reads committed control plane | yes (already committed per v1.31.0) |
| D8 | **Docs / user workflow** | docs call `roadmap.yaml` "the registry", `P<N>` "canonical" | follows whichever ships |
| D9 | **Cross-file / semantic invariants** (from §1) | duplicate ids & independent scalar edits (e.g. `weight`) merge *clean-but-wrong*; git enforces none of it; existing `DUPLICATE_*_ID` checks are post-hoc, single-tree | yes (detection, not layout) |

**Co-ship analysis.** The only hard ordering constraints are: D3 needs the PR0
discovery-seam consolidation first; D2 only matters if D1 changes the id; D6
follows whatever layout it migrates. **No concern requires atomic co-ship with
another.** That is the central argument against a single v2 PR. (D9, surfaced by
the §1 incident, is a *detection* concern rather than a layout one — it lands in
PR1, not a structural PR.)

## 3. Alternatives

Each is a real option, with a verdict. A "rejected" verdict is a position to be
argued at review, not a foreclosed decision.

| Alternative | Verdict | Why |
| --- | --- | --- |
| **A. Current layout + conflict-resolution tools only** (no layout change) | **Strong contender; default if incident is ledger-only** | If the external pain was mostly `roadmap.yaml`/id collision, a `plan merge` / collision detector may discharge it at far lower cost than a layout change. Cheapest, lowest risk. |
| **B. Keep `roadmap.yaml` mandatory, add `plan merge` / `plan renumber`** | Considered | Resolves collisions at merge time without changing the mental model. Heavier than A's diagnostics, lighter than glob discovery. Good middle option. |
| **C. `roadmap.yaml` advisory/generated, discover phases by glob** | Likely-accepted for D3 | Phase files already exist; this is a reader change (consolidate the 8 `loadRoadmap`s) + a `plan index --write` regenerator. Dissolves the registry hotspot. |
| **D. Slug-only canonical phase ids** | **Candidate, not accepted** for D1 | Lowest-friction *if* phase renames are rare **or** if canonical id and display slug are explicitly separated. Human-typable, collides only on same-slug-same-day. **Not accepted until rename semantics are designed** (see Risks: slug-as-identity churn) — a slug that doubles as the canonical key turns a rename into an identity break. |
| **E. Slug + short hash/random suffix** | Rejected unless D collisions prove common | Maximalist; **taxes the solo path** (every id gets opaque entropy: `budgeted-execution-a3f9`), worse to type and reference. Adopt only if slug-only collisions are observed, not assumed. |
| **F. Retain `P<N>` as canonical, improve duplicate detection** | Considered | Smallest mental-model change: keep ids, add a cross-branch collision diagnostic + a reservation/renumber helper. **Subsumes the id-space reservation / partition variant** (hand a branch a non-overlapping id block, or contributor-prefixed ids) — collision-avoidance without a layout change; evaluate it under F if D1 is taken up. Pairs naturally with A/B. |
| **G. Per-task files `design/tasks/<phase-id>/<task-id>.yaml`** | Likely-accepted for D5 | The one genuine task-layout fix. Dual-read inline + task-files; migration splits inline opt-in. |
| **H. Append-friendly inline task format** (e.g. tasks as a map, or one-task-per-line) | Considered vs G | Could reduce array-merge conflicts without a new directory. Cheaper than G but a weaker fix (map merges still conflict on the same key). Compare explicitly. |
| **I. One-shot v2** | **Rejected** | Largest blast radius, longest time-to-value, hardest rollback; contradicts the precedent's proven one-focused-change discipline. |
| **J. Incremental additive minors** | **Recommended** | Each concern ships backward-compatibly; value lands early (diagnostics first); a v2.0.0 cut becomes optional, not structural. |

## 4. Semver analysis

The previous roadmap draft treated v2.0.0 as a semver *necessity* because the
"default layout / mental model" changes. **That is incorrect, and the project's
own precedent proves it.** v1.31.0 sharded the progress ledger (monolithic →
per-file) with dual-read of the legacy form and opt-in dry-run migration, and
shipped as a **MINOR**. Bucket C applies the identical move to phases/tasks.

The semver question has exactly one decisive test:

> **Does upgrading the `code-pact` binary break an *existing* project?**

- **No** (existing `P<N>` phases, `roadmap.yaml`, and inline tasks still read;
  migration is opt-in) → backward-compatible → **MINOR**. This is the target for
  every step in the rollout.
- Changing the **default layout for *new* projects** so an *older* binary cannot
  read a *new* project is **forward**-incompatibility. Semver does not require a
  MAJOR for that — you are never expected to read future versions.

**A MAJOR (v2.0.0) is *required* only if** one of these is true:

- read compatibility for existing projects is **dropped** (e.g. the reader stops
  understanding `P<N>` or inline tasks);
- a **stable public JSON contract** (the documented envelope, error codes,
  `task prepare` shape) changes incompatibly;
- existing **canonical-id semantics** that downstream consumers depend on are
  changed in a breaking way.

> **One PR1a behavior brushes the second trigger — and is still additive.** PR1a
> makes phase-id resolution *fail closed* on an ambiguous id (surfaced by
> `task prepare` / `task context` via the context pack). That is a
> **new error on previously-undefined input** (lenient resolution of a duplicate id
> was never a guaranteed success contract), not a breaking change to a *working*
> `task prepare` shape — so it is additive, not a MAJOR trigger. Flagged so the
> reader sees it was considered, not missed.

This RFC's compatibility section ([§7](#7-compatibility-requirements)) makes all
three **non-goals**. Therefore, by strict semver, the whole sequence can be
**MINOR**.

**Recommendation.** Ship the rollout as additive minors. Treat a **v2.0.0** cut
as a *deliberate product / expectation-reset / branding* decision — to signal a
new default control-plane mental model — **and label it as such**, not as a
compatibility necessity. Reserve a true semver-MAJOR strictly for the day (if
ever) you actually drop legacy read support. Do not let "it feels big" launder a
marketing milestone into a fake compatibility break.

## 5. Soak gate (implementation, not this draft)

Drafting this RFC now is cheap and reversible. **Implementation past the
diagnostics PR is gated** on all of:

1. **v1.31.0 post-release integrity audit** passes (npm ⇄ tag ⇄ build integrity;
   `doctor` / `plan lint` / `plan analyze` green on the published package).
2. **The event-ledger sharding pattern soaks** — Bucket C reuses the same
   shard-and-dual-read pattern; let it prove itself in real dogfood / external
   use before replicating it across phases and tasks. v1.31.0 shipped 2026-06-04
   with **zero field soak**.
3. **First-hand [incident analysis](#1-incident-analysis)** — ⚠️ *partially*
   satisfied: the direction is confirmed (a first-hand structured account is
   recorded — §1, 2026-06-04 — and the conflict is *not* ledger-only), **but the
   forensic trace is still missing** (no diffs / conflict markers / merge commits /
   recovery-time figure). The forensic backfill is **required before PR2+**, not
   before PR1.
4. **At least one focused design review** of this RFC — ✅ satisfied: two
   adversarial reviews ran and their must-fixes were applied; status was flipped
   to scope-limited `accepted`.

**PR1a is not a diagnostic and is not covered by this exemption.** It is a
fail-closed **resolver safety fix** for undefined / corrupt input — a duplicate
phase id that was previously resolved to a silent first match — surfacing
`AMBIGUOUS_PHASE_ID` at exit 2. It changes an *error* path, not a warning surface,
and ships on its own merit (a new error on previously-undefined input, §4), not
under a soak exemption.

**PR1b** is exempt from gates 2–4 because, as **re-scoped** (§6), it adds **no new
diagnostic and no new exit behaviour**: it attaches an additive `recovery` field
to conflict errors that *already* fire, and adds docs. A consumer reading only
`code` / `severity` / `message` sees no change, and a valid current project gains
zero new issues — so nothing in the workflow changes and there is nothing to soak.
(The original PR1b draft proposed warning-default `LEGACY_*` advisories; those are
superseded/deferred per §6, so the earlier "exempt only while warning-default"
caveat is moot. Any *future* migration-readiness advisory ships on an explicit
`upgrade` / `migrate --check` surface, not default lint/doctor, and re-enters the
gate on its own merits.)

## 6. Recommended rollout

Additive sequence, value-first. **No big-bang.** Each PR is independently
shippable as a MINOR and independently revertible. (§§1–5 refer to the first
diagnostic/safety step collectively as "**PR1**"; it is split here into the
fail-closed **PR1a** — shipped — and the warning-default **PR1b**.)

- **PR0 — Consolidate the byte-equivalent strict readers (refactor, no behaviour
  change).** Replace the 8 duplicated command-local `loadRoadmap` implementations
  with one shared helper. A **first** step toward D3 — **not** the whole discovery
  seam: other roadmap readers with distinct contracts (`resolveTaskInRoadmap`,
  `doctor`'s validating reader, `plan adopt`'s id-minting reader, `phase reconcile`,
  adapter generation, the lenient lint loader) stay separate and are handled in
  their own later PRs, when the discovery contract actually changes. Patch/minor,
  zero contract change.
- **PR1a — Fail closed on an ambiguous phase id (shipped).** Phase-id resolution
  used `roadmap.phases.find((p) => p.id === id)` in eight places — a silent
  first-match on a duplicate id (two branches both minted `P1`, then merged). A
  shared `src/core/plan/resolve-phase.ts` now throws the new **`AMBIGUOUS_PHASE_ID`**
  (exit 2; `data.phases[]` lists the colliding files), mirroring the P14
  `resolve-task.ts` / `AMBIGUOUS_TASK_ID`. Task-id ambiguity was already
  fail-closed (`AMBIGUOUS_TASK_ID`, P14); only phase-id resolution was silently
  first-match. This is a **fail-closed safety fix, not a warning diagnostic** — it
  is *not* soak-exempt as a diagnostic (§5); it ships as a new error on
  previously-undefined input (§4).
- **PR1b — Conflict-recovery actionability (re-scoped; shipped). The original
  warning-default `LEGACY_*` advisories are superseded/deferred.** The git-silent
  failures (duplicate ids in separate files; clean-but-wrong scalar merges) want
  surfacing *before* they bite. `plan lint` **already** emits `DUPLICATE_PHASE_ID`
  / `DUPLICATE_TASK_ID` / `PHASE_ID_MISMATCH` (`checks.ts`, all `severity: error`,
  single-tree) and `doctor` mirrors them — so PR1b's original acceptance target
  (§8 #2, "duplicate-id detection as a *warning*; `--strict` promotes") is in fact
  **already met, and more strongly** (these are errors, not warnings, and fail
  the default exit). What was *missing* is not detection but **recovery**: a
  contributor or agent that hits the collision had no guided way out. So the
  shipped PR1b adds a structured `recovery` object (the `CONTROL_PLANE_*` shape)
  to those three conflict diagnostics — minimal manual fix + re-verify command,
  threaded through `plan lint` and `doctor` `data.issues[]` (the surfaces that run
  the id checks; `plan analyze` does not run them) — plus
  a `docs/troubleshooting.md` § *Id collisions & mismatches* covering all five
  collaboration codes (incl. the fail-closed `AMBIGUOUS_PHASE_ID` /
  `AMBIGUOUS_TASK_ID`) and a `docs/agent-contract.md` recovery playbook. It adds
  **no new diagnostics and no new default warnings** — a valid current project
  stays exactly as quiet.

  **Superseded/deferred: `LEGACY_SEQUENTIAL_PHASE_ID` and `LEGACY_INLINE_TASKS`.**
  The original draft named these warning-default advisories as PR1b's net-new.
  They are **not** shipped, for three verified reasons:
  1. **They flag the current *canonical* layout as "legacy" before any
     non-legacy alternative exists.** Slug ids (PR3) and per-task files (PR4) are
     deferred; until they land, `P<N>` and inline tasks are the *only* options.
     Warning every project that it is on the only available layout is noise, not
     signal — the product telling the user a true-and-correct state is wrong.
  2. **`LEGACY_SEQUENTIAL_PHASE_ID` directly contradicts the shipped
     `PHASE_ID_NAMING` check** (`checks.ts` `detectPhaseIdNaming`), which warns
     when a phase id does **not** match `P<N>` — i.e. the code treats `P<N>` as
     correct. Shipping both means every phase earns a warning either way; that is
     incoherent until PR3 flips the convention.
  3. **`LEGACY_INLINE_TASKS` would fire on every phase with tasks.** With no
     per-task-file alternative (PR4) it is pure noise.

  These migration-readiness advisories are **moved out of default `lint` / `doctor`
  entirely** and re-homed on a future, explicit `upgrade` / `migrate --check`
  surface (its own RFC, alongside PR2–PR5): "your current layout is a future
  migration target" should appear **only when a user intentionally runs a
  migration check**, never as ambient lint/doctor noise. Until that surface and
  the non-legacy alternatives exist, no `LEGACY_*` advisory ships.
- **PR1c — Cross-branch / `--base-ref` surfacing (deferred).** Surfacing a
  duplicate id *before* merge (branch vs base, like
  `CONTROL_PLANE_BRANCH_NOT_DRIVEN`) is heavier and lower marginal value now that
  single-tree detection + PR1a's fail-closed cover the post-merge case. Deferred
  pending the forensic backfill.
- **PR2 — Glob phase discovery, `roadmap.yaml` advisory/generated (D3/D4).**
  Discover `design/phases/*.yaml` by glob (infra exists: `src/core/glob.ts`,
  `PHASES_DIR_SEGMENTS`); honor the registry when present (dual-read); add
  `plan index --write` to regenerate the ordering view. Existing roadmaps keep
  working.
- **PR3 — Safer new-phase-id default (D1/D2), only if incident justifies it.**
  Slug-based canonical id for *new* phases; `P<N>` retained as a readable display
  ordinal / legacy label. **Evaluate slug-only (alt D) before slug+suffix (alt E)
  — and only after rename semantics / the stable-id-vs-display-slug split are
  designed (Open questions).** Existing `P<N>` phases are untouched and keep
  resolving.
- **PR4 — Per-task file dual-read (D5).** Reader merges inline `tasks:` +
  `design/tasks/<phase-id>/<task-id>.yaml`. New tasks *may* be written as files;
  inline tasks keep working. Define the inline-vs-file precedence rule explicitly
  (a task id present in both is a detected conflict, not a silent winner).
- **PR5 — Opt-in, dry-run migration (D6).** `plan migrate --control-plane` (name
  TBD; must not collide with v1.31.0's `plan migrate` — the shipped events
  migration, which has no `--events` flag): split inline
  tasks to files, regenerate the roadmap index, **report changes before writing**,
  `--write` is explicit, legacy artifacts left in place. Idempotent by
  construction (mirror B4).
- **Final — default-flip / branding decision.** Only here does a v2.0.0 cut
  become a question, and per [§4](#4-semver-analysis) it is a *product* decision,
  not a compatibility break — read-compat must still hold.

**Atomicity justification.** The only mandatory orderings are PR0 → PR2 and
(D1 change) → its dependents. Everything else is independent. Nothing must
co-ship. If review wants to stop after PR1 (or PR2), the project is in a
coherent, shippable state.

## 7. Compatibility requirements

Non-negotiable for every PR in the sequence. These are what keep the whole
rollout a MINOR.

- **Read-preserve, forever:** existing `P<N>` phase ids; existing
  `design/roadmap.yaml`; existing inline `tasks:` arrays; migrated *and*
  un-migrated progress ledgers (already guaranteed by v1.31.0).
- **No automatic rewrite without explicit `--write`.** Migration is dry-run by
  default and reports its changes first (precedent B4).
- **No silent winner on dual-read ambiguity.** A phase/task present in both the
  legacy and the new form is deduped deterministically or *surfaced* as a
  conflict — never silently resolved (precedent B2/B6 principle).
- **Branch-drift / CI keeps working** — the control plane stays committed (the
  v1.31.0 shared-vs-local policy), so the `CONTROL_PLANE_BRANCH_NOT_DRIVEN` gate
  reads it.

## 8. Acceptance criteria (final-state)

Concrete, testable. **These define the *end state* of the full sequence — not a
bar each intermediate PR must clear.** An incremental PR satisfies a subset and
must not be judged against criteria it does not yet target. Rough mapping: PR1b →
#2 (**already satisfied** by the shipped error-severity `DUPLICATE_*` /
`PHASE_ID_MISMATCH` checks — see the re-scoped PR1b in §6: it adds *recovery* on
top, not detection); PR2 → #3; PR2+PR3 → #1; PR4 → #4, #8; PR5 → #6; legacy
compatibility (#5, #7) must hold at **every** step. (These become RFC-conformance
tests per the P28 convention when the work is taken up.)

1. **Independent phase add:** two branches each `createPhase` and merge with **no**
   git conflict and **no** lost or duplicated phase. (Today: both mint `P51` and
   the registry conflicts.)
2. **Duplicate-id detection:** a tree containing two phases with the same
   canonical id yields a `doctor`/`plan lint` conflict diagnostic. In the shipped
   implementation this is **error-severity** (`DUPLICATE_PHASE_ID`, fails the
   default exit — stronger than the originally-drafted warning); PR1b adds
   structured `recovery` guidance, not a new warning. No silent acceptance.
3. **Roadmap-optional discovery:** a project with phase files but **no**
   `roadmap.yaml` discovers and orders all phases correctly; `plan index --write`
   regenerates a roadmap that round-trips.
4. **Per-task dual-read:** a phase with some inline tasks **and** some
   `design/tasks/<phase>/<task>.yaml` files reports the correct merged task set;
   a task id present in both is flagged, not silently merged.
5. **Inline-only compatibility:** a legacy project (inline tasks, `roadmap.yaml`,
   `P<N>`) derives **byte-for-byte identical** behavior before and after — no
   resort, no rewrite (the precedent's legacy-only fast-path guarantee).
6. **Migration idempotency + report:** `plan migrate --control-plane` run twice
   leaves the tree unchanged on the second run; the first run reports every split
   task / regenerated entry before `--write` touches anything.
7. **No breakage for legacy projects:** golden fixtures of pre-v2 layouts
   (`P<N>`, registry, inline tasks) read identically under the new reader.
8. **Independent task add:** two branches each add a task to the **same** phase
   (as task-files) and merge with no conflict and no lost task.

## Non-goals

- **No server, daemon, database, or remote lock.** Conflict-freedom comes from
  the data model (distinct files), as in the ledger — not from infrastructure.
- **No "coordinate manually" as the product answer.** A docs-only "just take
  turns" resolution is explicitly rejected; the tool must make independent work
  safe.
- **No automatic rewrite of existing roadmaps/tasks without `--write`.**
- **No breaking read compatibility** for existing `P<N>` / `roadmap.yaml` /
  inline-task / ledger projects.
- **No Bucket C implementation in this RFC.** Accepting this draft authorizes the
  incident analysis, **PR0** (no-behaviour-change refactor), **PR1a** (fail-closed
  phase-id resolution safety — `AMBIGUOUS_PHASE_ID`, exit 2), and **PR1b**
  (re-scoped to conflict-recovery actionability — §6; `LEGACY_*` advisories
  superseded/deferred) only; PR2+ stay gated on §5.
- **No logical/vector clocks** (out of scope; the ledger already routed this to
  detection, not silent resolution).

## Deliverables of this RFC

- This RFC at `design/decisions/control-plane-v2-rfc.md`, **status: accepted (scope-limited — PR0 + PR1a + PR1b only)**.
- The [open questions / required incident data](#open-questions--required-incident-data) below.
- The [recommended next-PR sequence](#6-recommended-rollout) (PR0→Final).
- The [semver recommendation](#4-semver-analysis): additive minors; v2.0.0 only as
  a labeled product decision.
- The [risks](#risks) below.
- The [docs that must change](#docs-that-must-change) below.

## Risks

- **Designing from second-hand evidence.** The dominant risk. Mitigated by making
  PR1 (diagnostics) the evidence-gathering step and gating everything else on the
  incident analysis.
- **Taxing the solo path.** This repo is still single-author; an opaque
  slug+suffix id (alt E) degrades the common case to fix an external one. Mitigated
  by preferring slug-only (D) and gating the id change (PR3) on observed collisions.
- **Building on an unsoaked pattern.** Bucket C reuses the day-old ledger sharding
  pattern. Mitigated by soak gate #2.
- **The 8× `loadRoadmap` duplication.** Hidden refactor cost / drift risk.
  Mitigated by PR0 consolidating it first.
- **Slug-as-identity churn.** Renaming a phase changes its slug → identity drift,
  broken `decision_refs`/`acceptance_refs`. Must be designed for (stable id ≠
  display slug) before PR3.
- **Dual-read ambiguity.** Inline-and-file or registry-and-glob duplicates need a
  deterministic, *surfaced* resolution, not a silent winner.
- **Migration changing derived ordering.** Same class the ledger migration
  handled by reporting derived-state flips before writing.
- **Downstream / docs hardcoding** `roadmap.yaml` as "the registry" or `P<N>` as
  canonical. Inventory in the docs-change list.

## Docs that must change

(When the work is taken up — not in this RFC.)

- `docs/cli-contract.md` — phase discovery, the `plan index` / `plan migrate
  --control-plane` contracts, the new advisories, and an explicit "`P<N>` is a
  legacy/display ordinal, not the canonical key" note.
- `design/decisions/README.md` — index row (added with this draft, marked
  accepted / scope-limited).
- `docs/` getting-started / planning / dogfood / ci — anywhere that calls
  `roadmap.yaml` the mandatory registry or `P<N>` the canonical id.
- The ja mirror under `docs/ja/` for every English page changed (per the
  docs-maintenance English-primary / mirror policy).

## Open questions / Required incident data

**Incident data — now substantially in hand ([§1](#1-incident-analysis)):**

- **Resolved:** the conflict is characterized first-hand and is *not* ledger-only,
  so the scope is fixed (Bucket C justified).
- **Residual (non-blocking backfill):** raw forensic artifacts — diffs, conflict
  markers, merge commits, branch names, anonymized logs — and a recovery-time
  figure. Useful to pin a concrete before/after, not required to reach PR1.

**Design questions to settle at acceptance:**

- **Slug-only (D) vs slug+suffix (E)** for D1 — decided by whether slug-only
  collisions are *observed*, not assumed.
- **Per-task files (G) vs append-friendly inline format (H)** for D5 — compare on
  real conflict reduction, not aesthetics.
- **Stable-id vs display-slug split** — if slugs become canonical, how is rename
  handled without breaking `decision_refs`/`acceptance_refs`?
- **Migration command name** — `plan migrate --control-plane` vs a distinct verb;
  must not be confused with v1.31.0's `plan migrate` (the events-ledger
  migration; it ships with **no** `--events` flag — just `plan migrate`).
- **Advisory surface** — do the new collision advisories live in `doctor`/`verify`
  only, or also `plan lint`? Mirror the `PROGRESS_EVENT_CONFLICT` /
  `ORPHAN_PROGRESS_EVENT` precedent.
