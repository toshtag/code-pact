# RFC: Dogfood durable-truth migration — converting this repo's history so deleting `design/` just works

**Status:** accepted — dogfood migration plan; **v2.0.0 product gate demonstrated on this repo** (proof in the [gate section](#v200-product-gate)). Execution uses **already-shipped** commands (`phase archive --write [--attest]`, `decision retire --write`, `state compact --write`) — no new mechanism. The remaining Population-A/B archives and decision retires are **non-gate-blocking cleanup throughput**; one optional convenience (bulk-attest UX) is a non-blocking nice-to-have. (2026-06)
**Scope:** the act of converting **this dogfood repository's** completed-phase / shipped-decision history into the durable forms the v2.0 mechanism already supports, so that the live `design/phases/*.yaml` and `design/decisions/*.md` become deletable views rather than the source of truth. Plus the v2.0.0 product-positioning gate this unlocks. **Not** a new deletion mechanism — that shipped under the RFCs below.
**Owners:** maintainer
**Related:** [decision-lifecycle](decision-lifecycle-rfc.md) (decision retire/prune — the decision-side durable record) · [event-pack-compaction](event-pack-compaction-rfc.md) (folds the per-event ledger into packs; Layer 3 now deletes loose events) · [collaboration-safe-state](collaboration-safe-state-rfc.md) (the one-event-per-file ledger this migration depends on) · [control-plane-v2](control-plane-v2-rfc.md) (phase identity / archive eligibility) · [finalization-reconciliation](finalization-reconciliation-rfc.md) (`task finalize` is what mints the per-event `done` evidence going forward) · [dogfood-trust-hardening](dogfood-trust-hardening-rfc.md) (the earlier dogfood-trust tail) · [doc-truth-from-code](doc-truth-from-code-rfc.md) (the parallel "docs generated from code" track).

## Summary

The v2.0 mechanism to delete completed phase YAMLs and retired decision `.md` **safely** is shipped (`phase archive --write`, `decision retire --write`, and now event-pack compaction `state compact --write`). At acceptance time this repo had not yet exercised it end to end; **that gate has now been demonstrated here** — P22 proved the cancelled archive path, P10 proved evidence-bound phase archive + Layer-3 compaction, P1 proved the pre-ledger attestation path, and two shipped decisions were retired, all with gates green. The remaining Population-A/B archives and decision retires are non-gate-blocking cleanup throughput. This RFC measures the repo's history, fixes how each part converts to durable truth, states the on-purpose-vs-accident goal split, and defines the v2.0.0 release gate. The headline finding is a clean two-population split, **measured by running `phase archive <id> --json` on every phase** (the authoritative per-done-task eligibility check — NOT a heuristic for "does the phase have any event"): **32 of 46 phases archive today** and **14 phases / 54 done tasks** need maintainer attestation. The committed durable ledger (`.code-pact/state/events/`, 262 git-tracked files) is the source of truth; the legacy `progress.yaml` is a gitignored maintainer-local artifact and plays no part in this plan.

## Durable-truth model (what is canonical)

The durable record of "what was built and decided" is, in priority order:

1. **The per-event ledger** — `.code-pact/state/events/<at>-<id>.yaml`, one content-addressed file per progress event — **unioned with** any event-packs (`.code-pact/state/archive/event-packs/<id>.json`) that have folded loose events away. This is the execution history.
2. **Phase snapshots** — `.code-pact/state/archive/phases/<id>.json`, written by `phase archive --write`, each binding to the ledger evidence above. A snapshot makes the live `design/phases/<id>.yaml` redundant.
3. **Decision records** — `.code-pact/state/archive/decisions/<stem>-<hash>.json`, written by `decision retire --write`. A record makes the live `design/decisions/<stem>.md` redundant (a link to the deleted `.md` resolves as *retired* via the record).
4. **Git history + CHANGELOG** — the backstop and the human-readable narrative.

The live `design/phases/*.yaml` and `design/decisions/*.md` are **authored working views**. Once (2)/(3) exist for an item, its live file is a deletable view, not the truth. The per-event ledger (1) is **committed** (`.code-pact/state/events/` is git-tracked, exactly as a user project commits it). The legacy monolithic `progress.yaml` is **not** in this hierarchy and **not** committed — it is `.gitignore`d (`.gitignore` line for `/.code-pact/state/progress.yaml`), a maintainer-local pre-ledger artifact; the archive producer never reads it (evidence comes from `loose ∪ packs`). It is therefore irrelevant to this plan (see below).

## Current state — measured 2026-06-14, before the execution PRs began (motivating inventory, point-in-time)

> This section is a measurement that motivated the decisions below. It is **not** a progress tracker — an RFC fixes the *decision*; per-item migration status lives in the execution PRs and CHANGELOG, not here.

- **Phases:** 46 live in `design/phases/` (45 `done`, 1 `cancelled` = P22). **0 archived** (`.code-pact/state/archive/phases/` empty).
- **Decisions:** at the measurement (before this RFC was added) **43** `.md` in `design/decisions/` — **41** existing decision/RFC docs plus the `README.md` index and the `PRUNED.md` ledger. Only the 41 are retirement candidates; `README.md`, `PRUNED.md`, and this RFC itself are not. (At the time this RFC was added the directory had 44 `.md`, +1 for this RFC.)
- **Execution ledger (committed):** `.code-pact/state/events/` has **262** git-tracked per-event files (142 `done` + 120 `started`). This is the durable truth a clone/CI sees.
- **Legacy `progress.yaml` (NOT committed):** a maintainer-local `progress.yaml` is `.gitignore`d and absent from the committed tree; it was observed locally to mirror the per-event ledger. `code-pact plan migrate` is therefore a **no-op** for this repo (the per-event files already exist) **and** operates only on that ignored local file — so it is **out of scope** for any execution PR (PRs change committed state). Mentioned only to forestall "just run migrate."
- **Eligibility is per-DONE-TASK, not per-phase.** A phase having *some* events does NOT make it archivable — every `done` task needs durable terminal evidence (`loose ∪ packs`). Re-derived **authoritatively by running `phase archive <id> --json` on all 46 phases** (the prior phase-prefix heuristic was wrong): a fully-evidenced done phase → `would_archive` (e.g. P10); the cancelled P22 → `would_archive` (cancelled needs no `done` events); a phase missing any done-task evidence → `PHASE_ARCHIVE_INELIGIBLE` with one `task_done_without_done_event` block per missing task. Crucially, **P5 and P38 have events but each has one done task with no done event** (`P5-T1`, `P38-T0`), so they are ineligible until attested — phase-level event presence is not eligibility. `validate` is currently green with everything live.

**Two populations fall out of this (authoritative `phase archive --json` classification):**

- **Population A — archives today (32 phases):** 31 fully-evidenced `done` phases + the cancelled P22.
- **Population B — needs attestation (14 phases / 54 done tasks):** P1, P2, P3, P4, **P5**, P6, P7, P8, **P38**, P40, P41, P43, P45, P48. These have at least one `done` task that predates the per-event ledger; their completion is real (the code shipped) but was never recorded as a `done` event. (P5 and P38 are mostly evidenced — only 1 task each is missing.)

## The goal split (load-bearing)

- **(A) Delete ON PURPOSE → keeps working = the goal.** Archive/retire first (write the durable record), then delete the live file; gates stay green and the item still resolves from its record. This is what the migration performs.
- **(B) Delete BY ACCIDENT (no record) → keeps working = an ANTI-goal.** A raw `rm` of a live `design/phases/*.yaml` or `design/decisions/*.md` with no snapshot/record **must fail closed** — that refusal is the safety, not a bug. The correct target for (B) is "**fail closed AND tell the user how to recover**" (restore from git, or `phase archive` / `decision retire` first). Accidental deletion must never silently pass.

A consequence for (B): the fail-closed errors (`PHASE_ARCHIVE_NOT_ARCHIVED` / missing-phase-file / missing-decision) should carry the recovery path in their message. That copy change is a small follow-up, noted here, not implemented in this design PR.

## Migration strategy

### Population A — archive the 32 ready phases

Run `phase archive <id> --write` per phase: it writes the snapshot (binding to the ledger evidence), readback-verifies, then deletes the live YAML last. The roadmap reference is kept; archived phases still resolve. No attestation, no forged history.

### Population B — attest, then archive (14 phases / 54 tasks)

These `done` tasks were genuinely completed but predate the ledger. **Do NOT synthesize events from `status: done`** — that forges an execution timeline the repo never had. Use the existing `phase archive --write --attest <task-id>="<reason>"` (repeatable), which records a maintainer's signed statement that the task completed, with the *basis* for that claim (the shipped artifact / git history), distinct from a replayed event. **Attest only the missing tasks**, not the whole phase — for P5 and P38 that is a single `--attest` (`P5-T1`, `P38-T0`); the rest of those phases is already evidenced. At **54 tasks across 14 invocations** this is tractable by hand — the prior estimate of "196 tasks, need a bulk UX" no longer holds because Population A and most of P5/P38 carry their own evidence.

**Attestation-reason policy (fix here):** the reason is an honest provenance statement, e.g. `"pre-ledger phase; completion evidenced by shipped code + git history"`, never a fabricated run. One reason per task is acceptable; a per-phase shared rationale is fine.

**Optional, non-blocking:** a bulk-attest convenience (`phase archive <id> --attest-all="<reason>"` or a dry-run that lists every missing-evidence task then one attested write) would smooth Population B. It is a nice-to-have, **not** a prerequisite — flag it, don't gate on it.

### The legacy `progress.yaml` (out of scope)

It is a `.gitignore`d, maintainer-local file (not in the committed tree) that mirrors the committed per-event ledger. It is **not** a migration target and **not** an execution-PR step — an execution PR changes committed state, and there is nothing committed to remove. Deleting the local copy is optional maintainer housekeeping, done outside this plan and reversible (it is regenerable / git-backed history); if removed, no `LEGACY_EVENT_FOR_ARCHIVED_TASK` would fire because every event's content id already resolves from the committed per-event files.

### Decision records (41 existing decision docs → retire the shipped ones)

Decisions convert cleanly via `decision retire --write`; this repo has now dogfooded the path with multiple records (the design-docs-ephemeral directive plus the two v2.0.0-gate smoke retires, `cli-alias-ux-rfc` + `dogfood-trust-hardening-rfc`). Retire shipped/accepted decisions (of the existing decision/RFC docs — never `README.md`, `PRUNED.md`, this RFC, or any still-proposed RFC) per the [decision-lifecycle](decision-lifecycle-rfc.md) policy so `design/decisions/` visibly shrinks, links still resolve as *retired*, and `check:docs` stays green. This track is independent of the phase work and lower-risk; sequence it in parallel or after Population A.

## Sequencing (smoke-test order, not a checklist)

1. **P22 (cancelled)** — the safest first archive: terminal, needs no `done` events. Proves the archive→delete→green loop on this repo.
2. **One Population-A phase (e.g. P10)** — proves evidence-bound archive on a real done phase. **Then `state compact <phase> --write`** on it: a Population-A phase still has its loose event files after archive, so fold them into the content-addressed pack and delete the loose copies. This proves the event-pack compaction (Layer 3) path on dogfood history; it is recommended for any archived phase with loose events but is **not** required for the v2.0.0 gate.
3. **One Population-B phase (e.g. P1, 2 tasks)** — proves the attest path end to end (`--attest`). A pure pre-ledger phase has no loose events, so no compaction step.
4. **Retire 2–3 safe shipped decisions** — proves the decision side and shrinks `design/decisions/` visibly. **Before retiring any decision, grep live docs for references to it**: `decision retire` preserves a record (status / title / hash / gate-releaseability), **not the RFC body**, so a live doc that points at the decision *for its content* ("the rationale / constraints / contract are in X") becomes false after retire — `check:docs` stays green (the link resolves as retired) and will **not** catch it. Ensure the live doc holds the contract and reframe the link as a *retired historical record*. Avoid retiring decisions used as README teaching examples.
5. **Then batch** the remainder, A before B, decisions in parallel — this is non-gate-blocking cleanup throughput (the gate is already met). Each step ends green (`validate` + `plan lint --strict` + `check:docs`); each is its own (or a few-per) reviewable PR.

## v2.0.0 product gate

The v2.0.0 claim is "design docs are ephemeral **because** durable execution truth exists" — so a cancelled-phase snapshot alone is too weak (it carries no done-task evidence). `code-pact` ships v2.0.0 **only if this repo itself** proves the story, all of (**all three are now met — see Status**):

- **≥1 evidence-bound `done` phase archive whose live `design/phases/<id>.yaml` is actually deleted** (e.g. P10) — the representative case, not P22. (P22 cancelled is a fine *smoke test* but does not satisfy the gate on its own.) **Met: P10 (archived + compacted).**
- **≥2 retired decision records whose live `design/decisions/*.md` are actually removed** (links still resolve as *retired*). **Met: `cli-alias-ux-rfc` + `dogfood-trust-hardening-rfc`.**
- **All gates green after those deletions** (`validate` + `plan lint --strict` + `check:docs`; dependents still resolve). **Met.**

If the migration is not done by release time, ship the surface as a **v1.x additive minor** instead — the CLI additions are backward-compatible; v2.0.0 is a product-positioning claim, not a semver necessity. The claim must be *demonstrated on this repo*, not just *implemented*.

## Open questions

- **Attestation reason granularity** — per-task vs one shared per-phase string, and how specific the *basis* is. Default: shared per-phase is acceptable (P1 used one rationale for both tasks). For stronger future audit, a reason may cite the specific shipped commit / release / test surface that evidences completion; not required for the early foundations phases.
- **Bulk-attest UX** — build it or hand-attest 54 tasks? Default: hand-attest now; build the convenience only if a second large migration appears.

## Non-goals

- **No new deletion mechanism** — `phase archive` / `decision retire` / `state compact` are shipped; this RFC only *applies* them to this repo.
- **No forged execution history** — Population B uses attestation, never events synthesized from `status: done`.
- **No change to the durable-truth hierarchy** — the ledger/snapshot/record model is fixed by the related RFCs; this only consumes it.
- **No making accidental deletion pass** — (B) stays fail-closed; the only improvement in scope is recovery copy in the error.
