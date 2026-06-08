# RFC: Control-plane v2 — collaboration-safe phases, discovery, and task layout

**Status:** accepted (scope-limited — authorizes PR0 + PR1a + PR1b only; PR2+ gated on §5; 2026-06)
**Scope:** takes up [collaboration-safe-state](collaboration-safe-state-rfc.md)'s deferred **Bucket C** (multi-contributor plan-side control plane: phase identity, glob discovery, `roadmap.yaml`-advisory, per-task files). Records the incident, decomposes the problem (D1–D9), weighs alternatives (A–J), fixes the semver story (all-MINOR), and authorizes only PR0 (refactor) + PR1a (`AMBIGUOUS_PHASE_ID`) + PR1b (conflict-recovery `recovery`).
**Owners:** maintainer
**Related:** [collaboration-safe-state](collaboration-safe-state-rfc.md) (deferred Bucket C C1–C4) · [ci-branch-drift](ci-branch-drift-rfc.md) (committed-control-plane precondition) · [deterministic-roadmap-stabilization](deterministic-roadmap-stabilization-rfc.md) · [cross-phase-deps](cross-phase-deps-rfc.md) (`depends_on` across phases) · [P22 cancelled](P22-cancelled-adapter-schema-v2.md) / [P37 deferred](P37-deferred-outcome-audit.md) (the no-preemptive-engineering precedent this RFC is allowed to cross).

## Summary

The collaboration-safe-state RFC made the **progress ledger** merge-safe (one file per event, dual-read of legacy `progress.yaml`, shipped additively as a MINOR) and deferred the rest of the multi-contributor control plane — **Bucket C** — behind a real-demand trigger (a second active author **or** a concrete external adopter). The trigger is met by its second leg: an external multi-contributor adopter hit real conflicts, with a first-hand structured account recorded ([§1](#1-incident-analysis), 2026-06-04). The conflict spans phase-id collision, `roadmap.yaml` / inline-task array merges, and agent confusion from duplicate ids — **decisively *not* ledger-only**, so v1.31.0 does not discharge it.

Bucket C is three independent structural changes plus an id question. The precedent's move — *shard the shared file, dual-read the legacy form, migrate opt-in and dry-run* — solves all of them and shipped as a MINOR. **DECISION:** the same applies here; each piece ships as a backward-compatible additive minor, and **v2.0.0 is a product/branding choice, not a semver necessity** ([§4](#4-semver-analysis)). This is a scope-limited *accepted* RFC: it does **not** pre-commit to a v2 layout or a big-bang PR. Acceptance authorizes only PR0 + PR1a + PR1b; PR2+ stay gated on §5.

## Context — the conflict surface (verified against the tree)

Three facts define the conflict surface:

1. **Phase identity is a branch-local sequential counter.** `nextPhaseId` is `max(P<N>)+1` from the local roadmap (`plan-adopt.ts`), so two contributors branching from `P50` both mint `P51`. The only guard is intra-roadmap (`createPhase` raises `DUPLICATE_PHASE_ID` for a same-branch collision), never cross-branch. `P<N>` is the canonical primary key: filenames, dedupe, `decision_refs`/`acceptance_refs` resolution, and the roadmap registry all key on it.
2. **Phase discovery is registry-driven, not glob.** `design/roadmap.yaml` is a mandatory `phases: [{ id, path, weight }]` registry — an unlisted phase file is not discovered. Two contributors each appending a phase collide on the `phases:` array (the same adjacent-line shape the ledger had pre-shard). **Hidden blast radius (verified):** `loadRoadmap` is byte-equivalently re-implemented in **8 files** (`pack`, `createPhase`, `recommend`, `verify`, `task-add`, `progress`, `phase`, `phase-import`); any discovery change touches all 8 unless consolidated first (PR0). Other roadmap readers with **distinct contracts** — `resolveTaskInRoadmap`, `doctor`'s validating reader, `plan adopt`'s id-minting reader, `phase reconcile`, adapter generation — are *not* PR0; they change when the discovery contract changes (PR2+).
3. **Tasks are inline in the phase YAML** (`tasks:` array). Two contributors adding tasks to the same phase edit the same array and conflict. Phase bodies are already one-file-per-phase; tasks are the one genuine file-layout gap (C3).

## 1. Incident analysis

**First-hand structured account received 2026-06-04** from the external adopter — detailed, internally consistent, matching the code-level Context findings — but a **described/reproducible account, not a forensic trace**: raw diffs, conflict markers, merge commits, branch names, and recovery-time were not supplied (residual [Open questions](#open-questions--required-incident-data)).

**Files that conflicted:** `.code-pact/state/progress.yaml`, `design/roadmap.yaml`, `design/phases/<id>-*.yaml` (inline `tasks:`), `design/decisions/<Pn-Tm>-*.md` (duplicate-id ADRs).

**Conflict classes → this RFC's decomposition:** phase-id collision (no cross-branch allocator → D1); `roadmap.yaml` (append to `phases:` **and** independent `weight` edits merging clean-but-wrong → D3/D4 + D9); inline task array → D5; progress ledger (reporter's loudest class) → **solved by v1.31.0**; agent confusion (duplicate id resolved ambiguously → wrong context pack, re-implementing a `done` task) → consequence of D1/D5.

**The two failure modes — and which is dangerous:**
- **Hard conflict (loud):** shared-array appends collide on adjacent lines. Git stops you. Annoying, not corrupting.
- **Clean-but-wrong auto-merge (silent — the dangerous one):** duplicate ids in *separate* files produce **no git conflict**; independent scalar edits (e.g. phase `weight`) merge cleanly into a value no contributor intended. This is the strongest argument for detection (PR1): the worst cases are invisible to git, so a tool-side detector is the only guard.

**Three corrections to the raw report (verified against the tree):**
1. **There is no `weight`-sum-100 invariant.** The reporter's "weight total ≠ 100" was *their* project convention; the schema is `weight: z.number().positive()` and `total_weight` is derived, not constrained. The code-true generalization (**D9**) is broader: git merges any independent scalar edit cleanly and cannot enforce *any* cross-contributor semantic constraint.
2. **Duplicate-id detection already exists — but only post-hoc.** `plan lint` already emits `DUPLICATE_PHASE_ID` / `DUPLICATE_TASK_ID` / `PHASE_ID_MISMATCH` (`checks.ts`, all `severity: error`, fail the default exit). The gap is not "no detector": it is (a) nothing runs them at the dangerous moment (merge/pre-branch), (b) they are not cross-branch, (c) the agent path resolves an ambiguous id instead of refusing. PR1's net value is (a)–(c). Because the existing checks are already error-severity, PR1's cross-branch/dangerous-moment surface must be a **separate `warning`-severity advisory** to stay inside the §5 diagnostics exemption.
3. **Task-id ambiguity was *already* fail-closed; the silent path was PHASE ids.** `resolveTaskInRoadmap` (P14) already throws `AMBIGUOUS_TASK_ID`. The real fail-**open** was phase-id resolution: 8 call sites did `roadmap.phases.find(p => p.id === id)` and silently took the first match. **PR1a closes this** — a shared `resolve-phase.ts` throws `AMBIGUOUS_PHASE_ID` (exit 2, `data.phases[]` lists colliding files) across all 8, mirroring the P14 task resolver.

**Decision-gate verdict:** the incident is decisively **NOT ledger-only**. v1.31.0 removed the loudest class, but every plan-side root remains (D1, D3/D4/D5, D9, fail-open agent resolution), so Bucket C is justified. The evidence also *orders* it: PR1 diagnostics are the highest-value first ship (worst failures are git-silent); the documented roots are id allocation (D1) and task storage (D5).

## 2. Problem decomposition

Bucket C is **separate concerns**, not one problem (treating it as one is how scope inflates to a big-bang v2):

| # | Concern | Conflict today | Independent? |
| --- | --- | --- | --- |
| D1 | Canonical phase identity | branch-local `max+1` → duplicate `P<N>` | yes |
| D2 | Human label / ordinal | `P<N>` is both identity and display order | coupled to D1 |
| D3 | Phase discovery | registry-only; unlisted = invisible | yes |
| D4 | Phase ordering | `roadmap.yaml` array order + `weight` | coupled to D3 |
| D5 | Task storage layout | inline `tasks:` array per phase | yes |
| D6 | Migration | none exists for phases/tasks | depends D1/D3/D5 |
| D7 | Branch-drift / CI | gate reads committed control plane | yes (already committed) |
| D8 | Docs / workflow | docs call `roadmap.yaml` "the registry", `P<N>` "canonical" | follows ship |
| D9 | Cross-file / semantic invariants | duplicate ids & independent scalar edits merge clean-but-wrong; existing `DUPLICATE_*_ID` checks are post-hoc, single-tree | yes (detection, not layout) |

**Co-ship analysis.** The only hard orderings: D3 needs PR0 first; D2 only matters if D1 changes the id; D6 follows whatever layout it migrates. **No concern requires atomic co-ship** — the central argument against a single v2 PR. D9 lands in PR1 (detection), not a structural PR.

## 3. Alternatives

| Alternative | Verdict | Why |
| --- | --- | --- |
| **A.** Current layout + conflict-resolution tools only | Strong contender (default if ledger-only) | Cheapest, lowest risk; a `plan merge` / collision detector may discharge it without a layout change |
| **B.** Keep `roadmap.yaml` mandatory, add `plan merge` / `plan renumber` | Considered | Resolves collisions at merge time without changing the mental model; good middle option |
| **C.** `roadmap.yaml` advisory/generated, discover by glob | Likely-accepted for D3 | Reader change (consolidate the 8 `loadRoadmap`s) + `plan index --write`; dissolves the registry hotspot |
| **D.** Slug-only canonical phase ids | Candidate, **not accepted** for D1 | Lowest-friction *if* renames are rare or canonical-id/display-slug are split; **not accepted until rename semantics are designed** — a slug that doubles as the key turns a rename into an identity break |
| **E.** Slug + short hash/random suffix | Rejected unless D collisions prove common | Maximalist; **taxes the solo path** (opaque entropy, worse to type). Adopt only if slug-only collisions are *observed* |
| **F.** Retain `P<N>` canonical, improve duplicate detection | Considered | Smallest mental-model change; **subsumes id-space reservation/partition** (hand a branch a non-overlapping block). Pairs with A/B |
| **G.** Per-task files `design/tasks/<phase-id>/<task-id>.yaml` | Likely-accepted for D5 | The one genuine task-layout fix; dual-read inline + files, opt-in split |
| **H.** Append-friendly inline task format (map / one-per-line) | Considered vs G | Cheaper than G but weaker (map merges still conflict on the same key) |
| **I.** One-shot v2 | **Rejected** | Largest blast radius, longest time-to-value, hardest rollback; contradicts the one-focused-change precedent |
| **J.** Incremental additive minors | **Recommended** | Each concern ships backward-compatibly; value lands early; a v2.0.0 cut becomes optional, not structural |

## 4. Semver analysis

v2.0.0 is **not** a semver necessity — the project's own precedent (v1.31.0 sharded the ledger monolithic→per-file with dual-read + opt-in dry-run migration, shipped MINOR) proves it. The decisive test: **does upgrading the binary break an *existing* project?**

- **No** (existing `P<N>`, `roadmap.yaml`, inline tasks still read; migration opt-in) → backward-compatible → **MINOR**. This is the target for every step.
- Changing the **default layout for *new* projects** so an *older* binary can't read a *new* one is **forward**-incompatibility, which semver does not make a MAJOR.

**A MAJOR is required only if:** read compatibility for existing projects is dropped; or a stable public JSON contract (envelope, error codes, `task prepare` shape) changes incompatibly; or existing canonical-id semantics downstream consumers depend on are broken. [§7](#7-compatibility-requirements) makes all three non-goals → the whole sequence can be MINOR.

**PR1a brushes the second trigger and is still additive:** failing closed on an ambiguous id (surfaced via `task prepare`/`task context`) is a **new error on previously-undefined input** — lenient resolution of a duplicate id was never a guaranteed success contract — not a break to a *working* shape.

**Recommendation:** ship as additive minors. Treat a **v2.0.0** cut as a deliberate product/branding decision (signalling a new default mental model) and label it as such — never let "it feels big" launder a marketing milestone into a fake compatibility break. Reserve a true MAJOR for the day (if ever) legacy read support is actually dropped.

## 5. Soak gate (implementation, not this draft)

Implementation **past the diagnostics PR** is gated on all of:
1. **v1.31.0 post-release integrity audit** passes (npm ⇄ tag ⇄ build; `doctor` / `plan lint` / `plan analyze` green on the published package).
2. **The ledger sharding pattern soaks** — Bucket C reuses the shard-and-dual-read pattern; let it prove itself in real use first (v1.31.0 shipped with zero field soak).
3. **First-hand [incident analysis](#1-incident-analysis)** — ⚠️ *partially* satisfied: direction confirmed (not ledger-only), but the **forensic trace is still missing**. Required before **PR2+**, not before PR1.
4. **At least one focused design review** — ✅ satisfied: two adversarial reviews ran, must-fixes applied, status flipped to scope-limited `accepted`.

**PR1a is not a diagnostic and is not soak-exempt** — it is a fail-closed resolver safety fix for undefined/corrupt input (a duplicate phase id previously resolved to a silent first match), surfacing `AMBIGUOUS_PHASE_ID` at exit 2. It changes an *error* path, not a warning surface, and ships on its own merit (§4).

**PR1b is exempt from gates 2–4** because, as re-scoped (§6), it adds **no new diagnostic and no new exit behaviour**: it attaches an additive `recovery` field to conflict errors that *already* fire, plus docs. A consumer reading only `code`/`severity`/`message` sees no change; a valid project gains zero new issues. Any *future* migration-readiness advisory ships on an explicit `upgrade` / `migrate --check` surface (not default lint/doctor) and re-enters the gate on its own merits.

## 6. Recommended rollout

Additive, value-first, no big-bang. Each PR is independently shippable as a MINOR and independently revertible. (PR1 = the first diagnostic/safety step, split into the fail-closed PR1a and the recovery-focused PR1b.)

- **PR0 — Consolidate the 8 byte-equivalent strict `loadRoadmap` readers** (refactor, no behaviour change). A first step toward D3, not the whole discovery seam — distinct-contract readers stay separate. Zero contract change.
- **PR1a — Fail closed on an ambiguous phase id (shipped).** Shared `src/core/plan/resolve-phase.ts` throws **`AMBIGUOUS_PHASE_ID`** (exit 2; `data.phases[]` lists colliding files) across all 8 former first-match sites, mirroring the P14 `AMBIGUOUS_TASK_ID`. A fail-closed safety fix, *not* a warning diagnostic — not soak-exempt as a diagnostic; ships as a new error on previously-undefined input (§4).
- **PR1b — Conflict-recovery actionability (re-scoped; shipped).** Detection already exists at error-severity (`DUPLICATE_PHASE_ID` / `DUPLICATE_TASK_ID` / `PHASE_ID_MISMATCH` in `checks.ts`, mirrored by `doctor`), so the original "detection as a *warning*" target was already met — and more strongly. What was missing is **recovery**. PR1b adds a structured `recovery` object (the `CONTROL_PLANE_*` shape: minimal manual fix + re-verify command) to those three diagnostics, threaded through `plan lint` and `doctor` `data.issues[]` (the surfaces that run the id checks; `plan analyze` does not), plus a `docs/troubleshooting.md` § *Id collisions & mismatches* (all five collaboration codes, incl. `AMBIGUOUS_PHASE_ID` / `AMBIGUOUS_TASK_ID`) and a `docs/agent-contract.md` recovery playbook. **No new diagnostics, no new default warnings** — a valid project stays exactly as quiet.

  **Superseded/deferred: `LEGACY_SEQUENTIAL_PHASE_ID` and `LEGACY_INLINE_TASKS`.** The original draft named these warning-default advisories as PR1b's net-new. They are **not** shipped, for three verified reasons: (1) they flag the current *canonical* layout as "legacy" before any non-legacy alternative exists (slug ids PR3, per-task files PR4 are deferred) — noise, not signal; (2) `LEGACY_SEQUENTIAL_PHASE_ID` directly contradicts the shipped `PHASE_ID_NAMING` check, which warns when an id does *not* match `P<N>` — the code treats `P<N>` as correct; (3) `LEGACY_INLINE_TASKS` would fire on every phase with tasks. They are moved **out of default `lint`/`doctor`** and re-homed on a future explicit `upgrade` / `migrate --check` surface — "your layout is a future migration target" should appear only when a user intentionally runs a migration check.
- **PR1c — Cross-branch / `--base-ref` surfacing (deferred).** Surfacing a duplicate id *before* merge is heavier and lower marginal value now that single-tree detection + PR1a's fail-closed cover the post-merge case. Deferred pending the forensic backfill.
- **PR2 — Glob phase discovery, `roadmap.yaml` advisory/generated (D3/D4).** Discover `design/phases/*.yaml` by glob (infra: `glob.ts`, `PHASES_DIR_SEGMENTS`); honor the registry when present (dual-read); add `plan index --write` to regenerate the ordering view. Existing roadmaps keep working.
- **PR3 — Safer new-phase-id default (D1/D2), only if the incident justifies it.** Slug-based canonical id for *new* phases; `P<N>` retained as a readable display ordinal / legacy label. Evaluate slug-only (D) before slug+suffix (E), and only after rename semantics / the stable-id-vs-display-slug split are designed. Existing `P<N>` phases untouched.
- **PR4 — Per-task file dual-read (D5).** Reader merges inline `tasks:` + `design/tasks/<phase-id>/<task-id>.yaml`. New tasks *may* be files; inline keeps working. A task id present in both is a **detected conflict, not a silent winner**.
- **PR5 — Opt-in, dry-run migration (D6).** `plan migrate --control-plane` (name TBD; must not collide with v1.31.0's `plan migrate`, the events migration with no `--events` flag): split inline tasks to files, regenerate the index, report changes before writing, `--write` explicit, legacy artifacts left in place. Idempotent by construction.
- **Final — default-flip / branding decision.** Only here does a v2.0.0 cut become a question, and per §4 it is a product decision, not a compatibility break — read-compat must still hold.

**Atomicity:** the only mandatory orderings are PR0 → PR2 and (D1 change) → its dependents. Nothing else must co-ship; stopping after PR1 (or PR2) leaves a coherent, shippable state.

## 7. Compatibility requirements

Non-negotiable for every PR — these keep the rollout a MINOR:
- **Read-preserve, forever:** existing `P<N>` ids; existing `design/roadmap.yaml`; existing inline `tasks:`; migrated *and* un-migrated ledgers.
- **No automatic rewrite without explicit `--write`** (dry-run by default, reports changes first).
- **No silent winner on dual-read ambiguity** — a phase/task in both forms is deduped deterministically or *surfaced* as a conflict.
- **Branch-drift / CI keeps working** — the control plane stays committed, so the `CONTROL_PLANE_BRANCH_NOT_DRIVEN` gate reads it.

## 8. Acceptance criteria (final-state)

These define the *end state* of the full sequence — not a bar each intermediate PR must clear (rough mapping: PR1b → #2, already satisfied by the shipped error-severity checks + adds *recovery*; PR2 → #3; PR2+PR3 → #1; PR4 → #4, #8; PR5 → #6; legacy compat #5/#7 holds at every step):

1. **Independent phase add:** two branches each `createPhase` and merge with no git conflict and no lost/duplicated phase.
2. **Duplicate-id detection:** a tree with two same-id phases yields a `doctor`/`plan lint` conflict diagnostic — shipped at **error-severity** (stronger than the originally-drafted warning); PR1b adds `recovery`. No silent acceptance.
3. **Roadmap-optional discovery:** a project with phase files but no `roadmap.yaml` discovers and orders all phases; `plan index --write` regenerates a round-tripping roadmap.
4. **Per-task dual-read:** a phase mixing inline tasks and `design/tasks/...` files reports the correct merged set; a task id in both is flagged, not silently merged.
5. **Inline-only compatibility:** a legacy project derives **byte-for-byte identical** behavior before and after — no resort, no rewrite.
6. **Migration idempotency + report:** `plan migrate --control-plane` run twice leaves the tree unchanged on the second run; the first reports every change before `--write` touches anything.
7. **No breakage for legacy projects:** golden fixtures of pre-v2 layouts read identically under the new reader.
8. **Independent task add:** two branches each add a task to the **same** phase (as task-files) and merge with no conflict and no lost task.

## Non-goals

- **No server, daemon, database, or remote lock.** Conflict-freedom comes from the data model (distinct files), not infrastructure.
- **No "coordinate manually" as the product answer** — a docs-only "just take turns" is explicitly rejected; the tool must make independent work safe.
- **No automatic rewrite of existing roadmaps/tasks without `--write`.**
- **No breaking read compatibility** for existing `P<N>` / `roadmap.yaml` / inline-task / ledger projects.
- **No Bucket C implementation in this RFC** — acceptance authorizes only PR0, PR1a (`AMBIGUOUS_PHASE_ID`, exit 2), and PR1b (conflict-recovery `recovery`; `LEGACY_*` superseded/deferred); PR2+ stay gated on §5.
- **No logical/vector clocks** (the ledger already routed this to detection, not silent resolution).

## Risks

- **Designing from second-hand evidence** (the dominant risk) — mitigated by making PR1 diagnostics the evidence-gathering step and gating everything else on the incident analysis.
- **Taxing the solo path** — this repo is still single-author; an opaque slug+suffix id (E) degrades the common case. Mitigated by preferring slug-only (D) and gating PR3 on *observed* collisions.
- **Building on an unsoaked pattern** — Bucket C reuses the day-old ledger sharding; mitigated by soak gate #2.
- **The 8× `loadRoadmap` duplication** (hidden refactor cost / drift) — mitigated by PR0 consolidating it first.
- **Slug-as-identity churn** — a rename changes the slug → identity drift, broken `decision_refs`/`acceptance_refs`. Must design stable id ≠ display slug before PR3.
- **Dual-read ambiguity** — needs a deterministic, *surfaced* resolution, not a silent winner.
- **Migration changing derived ordering** — report derived-state flips before writing (the ledger migration's pattern).
- **Downstream / docs hardcoding** `roadmap.yaml` as "the registry" or `P<N>` as canonical — inventoried in the docs-change list.

## Docs that must change

(When the work is taken up — not in this RFC.) `docs/cli-contract.md` (phase discovery, `plan index` / `plan migrate --control-plane` contracts, new advisories, the "`P<N>` is a legacy/display ordinal, not the canonical key" note); `design/decisions/README.md` index row; `docs/` getting-started / planning / dogfood / ci anywhere calling `roadmap.yaml` the mandatory registry or `P<N>` the canonical id; the `docs/ja/` mirror for every English page changed.

## Open questions / Required incident data

**Incident data — substantially in hand ([§1](#1-incident-analysis)):** *Resolved* — the conflict is characterized first-hand and is not ledger-only (Bucket C justified). *Residual (non-blocking backfill, required before PR2+):* raw forensic artifacts — diffs, conflict markers, merge commits, branch names, anonymized logs — and a recovery-time figure.

**Design questions to settle at acceptance:**
- **Slug-only (D) vs slug+suffix (E)** for D1 — decided by whether slug-only collisions are *observed*, not assumed.
- **Per-task files (G) vs append-friendly inline (H)** for D5 — compare on real conflict reduction, not aesthetics.
- **Stable-id vs display-slug split** — if slugs become canonical, how is rename handled without breaking `decision_refs`/`acceptance_refs`?
- **Migration command name** — `plan migrate --control-plane` vs a distinct verb; must not be confused with v1.31.0's `plan migrate` (the events migration, no `--events` flag).
- **Advisory surface** — do new collision advisories live in `doctor`/`verify` only, or also `plan lint`? Mirror the `PROGRESS_EVENT_CONFLICT` / `ORPHAN_PROGRESS_EVENT` precedent.

## References

- RFCs: [collaboration-safe-state](collaboration-safe-state-rfc.md) (deferred Bucket C) · [ci-branch-drift](ci-branch-drift-rfc.md) · [deterministic-roadmap-stabilization](deterministic-roadmap-stabilization-rfc.md) · [cross-phase-deps](cross-phase-deps-rfc.md) · [P22 cancelled](P22-cancelled-adapter-schema-v2.md) · [P37 deferred](P37-deferred-outcome-audit.md).
- Code: `src/core/plan/resolve-phase.ts` (`AMBIGUOUS_PHASE_ID`) · `src/core/plan/checks.ts` (`DUPLICATE_*_ID` / `PHASE_ID_MISMATCH` / `PHASE_ID_NAMING`) · `src/core/glob.ts` (`PHASES_DIR_SEGMENTS`) · `src/core/services/createPhase.ts`.
- Docs: `docs/cli-contract.md` · `docs/troubleshooting.md` · `docs/agent-contract.md`.
