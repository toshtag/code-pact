# RFC: Dogfood durable-truth migration — converting this repo's history so deleting `design/` just works

**Status:** proposed — design only. This RFC fixes the migration *decision* and the durable-truth model; an execution PR (or PRs) applies it using **already-shipped** commands (`phase archive --write [--attest]`, `decision retire --write`, `state compact --write`). No new mechanism is required to start; one optional convenience (bulk-attest UX) is flagged as a non-blocking nice-to-have. (2026-06)
**Scope:** the act of converting **this dogfood repository's** completed-phase / shipped-decision history into the durable forms the v2.0 mechanism already supports, so that the live `design/phases/*.yaml` and `design/decisions/*.md` become deletable views rather than the source of truth. Plus the v2.0.0 product-positioning gate this unlocks. **Not** a new deletion mechanism — that shipped under the RFCs below.
**Owners:** maintainer
**Related:** [decision-lifecycle](decision-lifecycle-rfc.md) (decision retire/prune — the decision-side durable record) · [event-pack-compaction](event-pack-compaction-rfc.md) (folds the per-event ledger into packs; Layer 3 now deletes loose events) · [collaboration-safe-state](collaboration-safe-state-rfc.md) (the one-event-per-file ledger this migration depends on) · [control-plane-v2](control-plane-v2-rfc.md) (phase identity / archive eligibility) · [finalization-reconciliation](finalization-reconciliation-rfc.md) (`task finalize` is what mints the per-event `done` evidence going forward) · [dogfood-trust-hardening](dogfood-trust-hardening-rfc.md) (the earlier dogfood-trust tail) · [doc-truth-from-code](doc-truth-from-code-rfc.md) (the parallel "docs generated from code" track).

## Summary

The v2.0 mechanism to delete completed phase YAMLs and retired decision `.md` **safely** is shipped (`phase archive --write`, `decision retire --write`, and now event-pack compaction `state compact --write`). What is NOT yet true is that **this repo** can exercise it end to end: almost all of `design/phases/*.yaml` are still live, because the durable evidence those archives bind to is uneven across the repo's own history. This RFC measures that history, fixes how each part converts to durable truth, states the on-purpose-vs-accident goal split, and defines the v2.0.0 release gate. The headline finding corrects the prior plan: the blocker is **not** "run `plan migrate`" (that is a no-op here) and **not** 196 untracked tasks — it is a clean two-population split where **34 of 46 phases archive today** and only **12 phases / 52 tasks** need maintainer attestation.

## Durable-truth model (what is canonical)

The durable record of "what was built and decided" is, in priority order:

1. **The per-event ledger** — `.code-pact/state/events/<at>-<id>.yaml`, one content-addressed file per progress event — **unioned with** any event-packs (`.code-pact/state/archive/event-packs/<id>.json`) that have folded loose events away. This is the execution history.
2. **Phase snapshots** — `.code-pact/state/archive/phases/<id>.json`, written by `phase archive --write`, each binding to the ledger evidence above. A snapshot makes the live `design/phases/<id>.yaml` redundant.
3. **Decision records** — `.code-pact/state/archive/decisions/<stem>-<hash>.json`, written by `decision retire --write`. A record makes the live `design/decisions/<stem>.md` redundant (a link to the deleted `.md` resolves as *retired* via the record).
4. **Git history + CHANGELOG** — the backstop and the human-readable narrative.

The live `design/phases/*.yaml` and `design/decisions/*.md` are **authored working views**. Once (2)/(3) exist for an item, its live file is a deletable view, not the truth. The legacy monolithic `progress.yaml` is **not** in this hierarchy — it predates the per-event ledger and is redundant with it (see below).

## Current state — measured 2026-06-14 (motivating inventory, point-in-time)

> This section is a measurement that motivated the decisions below. It is **not** a progress tracker — an RFC fixes the *decision*; per-item migration status lives in the execution PRs and CHANGELOG, not here.

- **Phases:** 46 live in `design/phases/` (45 `done`, 1 `cancelled` = P22). **0 archived** (`.code-pact/state/archive/phases/` empty).
- **Decisions:** 43 `.md` in `design/decisions/` — **41** decision/RFC docs plus the `README.md` index and the `PRUNED.md` ledger (the latter two are **not** retirement candidates). **1** archived decision record exists.
- **Execution ledger:** `.code-pact/state/events/` has **262** per-event files (142 `done` + 120 `started`). The legacy `.code-pact/state/progress.yaml` (1774 lines) holds the **same 262 events** — it is the pre-ledger monolith and the per-event files are its already-migrated form. `code-pact plan migrate --json` reports `legacy_events: 262` but is a **no-op** (the events are already present as files; `written`/`already_present` are only counted under `--write`, so the dry-run's `0/0` is expected, not "nothing to migrate").
- **Coverage is uneven.** Both the ledger and `progress.yaml` cover the **same 33 phases** (P5, P9–P21, P24, P26–P34, P36, P38–P39, P42, P44, P46–P47, P49–P50). The remaining phases have **no execution events anywhere** — their YAML says `status: done` but no `started`/`done` event was ever recorded.
- **Eligibility, verified by dry-run:** a phase **with** events archives cleanly (`phase archive P10` → `would_archive`); the cancelled P22 archives cleanly (`would_archive`); a phase **without** events is refused (`phase archive P1` → `PHASE_ARCHIVE_INELIGIBLE`, blocks `task_done_without_done_event` for P1-T1/P1-T2). `validate` is currently green with everything live.

**Two populations fall out of this:**

- **Population A — archives today (34 phases):** the 33 with events + P22 (cancelled phases need no `done` events).
- **Population B — needs attestation (12 phases / 52 done tasks):** P1, P2, P3, P4, P6, P7, P8, P40, P41, P43, P45, P48. These predate the per-event ledger; their completion is real (the code shipped) but was never recorded as events.

## The goal split (load-bearing)

- **(A) Delete ON PURPOSE → keeps working = the goal.** Archive/retire first (write the durable record), then delete the live file; gates stay green and the item still resolves from its record. This is what the migration performs.
- **(B) Delete BY ACCIDENT (no record) → keeps working = an ANTI-goal.** A raw `rm` of a live `design/phases/*.yaml` or `design/decisions/*.md` with no snapshot/record **must fail closed** — that refusal is the safety, not a bug. The correct target for (B) is "**fail closed AND tell the user how to recover**" (restore from git, or `phase archive` / `decision retire` first). Accidental deletion must never silently pass.

A consequence for (B): the fail-closed errors (`PHASE_ARCHIVE_NOT_ARCHIVED` / missing-phase-file / missing-decision) should carry the recovery path in their message. That copy change is a small follow-up, noted here, not implemented in this design PR.

## Migration strategy

### Population A — archive the 34 ready phases

Run `phase archive <id> --write` per phase: it writes the snapshot (binding to the ledger evidence), readback-verifies, then deletes the live YAML last. The roadmap reference is kept; archived phases still resolve. No attestation, no forged history.

### Population B — attest, then archive (12 phases / 52 tasks)

These tasks were genuinely completed but predate the ledger. **Do NOT synthesize events from `status: done`** — that forges an execution timeline the repo never had. Use the existing `phase archive --write --attest <task-id>="<reason>"` (repeatable), which records a maintainer's signed statement that the task completed, with the *basis* for that claim (the shipped artifact / git history), distinct from a replayed event. At **52 tasks across 12 invocations** this is tractable by hand — the prior estimate of "196 tasks, need a bulk UX" no longer holds because Population A carries its own evidence.

**Attestation-reason policy (fix here):** the reason is an honest provenance statement, e.g. `"pre-ledger phase; completion evidenced by shipped code + git history"`, never a fabricated run. One reason per task is acceptable; a per-phase shared rationale is fine.

**Optional, non-blocking:** a bulk-attest convenience (`phase archive <id> --attest-all="<reason>"` or a dry-run that lists every missing-evidence task then one attested write) would smooth Population B. It is a nice-to-have, **not** a prerequisite — flag it, don't gate on it.

### The legacy `progress.yaml`

It is redundant with the per-event ledger (same 262 events, already migrated). Plan: after Population A's archives prove green, **remove `progress.yaml`** in its own step and confirm no `LEGACY_EVENT_FOR_ARCHIVED_TASK` fires (it will not — every legacy event's content id already resolves from the per-event files, so the durable ledger still covers each archived task). Keep it until then as a zero-cost backstop. Removal is reversible via git.

### Decision records (41 decision docs → retire the shipped ones)

Decisions already convert cleanly via `decision retire --write` (one record exists). Retire shipped/accepted decisions (of the 41 decision/RFC docs — never `README.md` or `PRUNED.md`) per the [decision-lifecycle](decision-lifecycle-rfc.md) policy so `design/decisions/` visibly shrinks, links still resolve as *retired*, and `check:docs` stays green. This track is independent of the phase work and lower-risk; sequence it in parallel or after Population A.

## Sequencing (smoke-test order, not a checklist)

1. **P22 (cancelled)** — the safest first archive: terminal, needs no `done` events. Proves the archive→delete→green loop on this repo.
2. **One Population-A phase (e.g. P10)** — proves evidence-bound archive on a real done phase.
3. **One Population-B phase (e.g. P1, 2 tasks)** — proves the attest path end to end.
4. **Retire 2–3 safe shipped decisions** — proves the decision side and shrinks `design/decisions/` visibly.
5. **Then batch** the remainder, A before B, decisions in parallel. Each step ends green (`validate` + `plan lint --strict` + `check:docs`); each is its own reviewable PR.

## v2.0.0 product gate

`code-pact` ships v2.0.0 **only if this repo itself** proves the story: ≥1 phase snapshot **and** ≥2 decision records present, and **all gates green after the corresponding live docs are removed** (a phase YAML and a decision `.md` actually deleted, control plane still green, dependents still resolve). If the dogfood migration is not done by release time, ship the surface as a **v1.x additive minor** instead — the CLI additions are backward-compatible; v2.0.0 is a product-positioning claim ("design docs are ephemeral"), not a semver necessity. The claim must be *demonstrated on this repo*, not just *implemented*.

## Open questions

- **Attestation reason granularity** — per-task vs one shared per-phase string. Default: shared per-phase is acceptable; revisit only if a reviewer wants per-task basis.
- **Delete `progress.yaml` or keep as backstop?** Default: delete after Population A is green (it is pure redundancy); git is the backstop.
- **Bulk-attest UX** — build it or hand-attest 52 tasks? Default: hand-attest now; build the convenience only if a second large migration appears.

## Non-goals

- **No new deletion mechanism** — `phase archive` / `decision retire` / `state compact` are shipped; this RFC only *applies* them to this repo.
- **No forged execution history** — Population B uses attestation, never events synthesized from `status: done`.
- **No change to the durable-truth hierarchy** — the ledger/snapshot/record model is fixed by the related RFCs; this only consumes it.
- **No making accidental deletion pass** — (B) stays fail-closed; the only improvement in scope is recovery copy in the error.
