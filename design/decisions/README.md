# Design decisions (RFC index)

Every significant change to `code-pact` is recorded here as an RFC before it
ships. Each file states a **Status**, **Scope**, **Owners**, and **Related**
decisions; the longer ones open with a plain-language **Summary**. These are
the *why* behind the code — the user-facing *how* lives in [`docs/`](../../docs/README.md).

> **Current (pre-v2.0) rule: do not rename or move a gate-referenced RFC** unless
> you update every `acceptance_refs` / `decision_refs` that names it in
> `design/phases/*.yaml` (and the index below). A non-gate history record — one no
> `decision_refs` / `acceptance_refs` points at — may be moved out after you
> confirm that; see [What belongs here](#what-belongs-here-and-what-does-not) for
> where it goes.
>
> The [design-docs-ephemeral directive](design-docs-ephemeral-directive.md)
> **supersedes this rule only for retired / settled decisions represented by a
> validated `.code-pact/state` decision-state record** — those become removable
> even when a gate referenced them. **Until those records and readers land, this
> warning stays enforceable** for every decision still resolved from `design/`.

| Phase | Decision | What it decided |
| --- | --- | --- |
| v1.0 | [Stability taxonomy](stability-taxonomy.md) | Froze the public CLI surface at v1.0 and defined the Stable / Experimental / Deprecated bands. |
| P10 | [Task Readiness Schema](task-readiness-schema-rfc.md) | Added the optional task fields (`depends_on` / `reads` / `writes` / `decision_refs` / `acceptance_refs`). |
| P11 | [Finalization & Reconciliation](finalization-reconciliation-rfc.md) | Added `task finalize` / `phase reconcile` to flip design status to `done` after `task complete`. |
| P12 | [Lightweight Runbook](lightweight-runbook-rfc.md) | Added read-only `task runbook` / `phase runbook` sequencing guidance. |
| P13 | [Planning UX & init hardening](planning-ux-init-hardening-rfc.md) | Made the sample phase opt-in (`init --sample-phase`, `TUTORIAL`), added non-interactive `task add`. |
| P14 | [Governance](governance-rfc.md) | Added the advisory write lock (`LOCK_HELD`), reserved `TUTORIAL`, and extracted the task→phase resolver. |
| P16 | [Agent contract adapter hardening](agent-contract-rfc.md) | Hardened the agent/adapter contract and conformance surface. |
| P18 | [Spec Kit bridge](spec-kit-bridge-rfc.md) | Added the read-only one-way importer for Spec Kit `tasks.md` / `spec.md` / `plan.md`. |
| P19 | [Cross-phase dependencies](cross-phase-deps-rfc.md) | Allowed cross-phase `depends_on` and the aggregated `phase runbook --across-phases`. |
| P20 | [Evidence harness](evidence-harness-rfc.md) | Added the internal-only deterministic dogfood measurement harness. |
| P21 | [Agent Contract v2](agent-contract-v2-rfc.md) | Added `task prepare`, `task context --explain`, and `adapter conformance`. |
| P22 | [Adapter schema v2 — cancelled](P22-cancelled-adapter-schema-v2.md) | **Cancelled.** Recorded why adapter schema v2 / template-signature tracking was not pursued. |
| P24 | [Context budget enforcement](context-budget-rfc.md) | Added `--budget-bytes` and the `CONTEXT_OVER_BUDGET` contract. |
| P26 | [Evidence Harness v2](evidence-harness-v2-rfc.md) | Added aggregate stats and the lifecycle-adherence baselines reported in positioning. |
| P27 | [CLI maintainability](cli-maintainability-rfc.md) | Split the monolithic `src/cli.ts` into a command-cluster layout. |
| P28 | [Spec-conformance remediation](spec-conformance-rfc.md) | Established the RFC-conformance test convention. |
| P30 | [Adapter contract hardening](adapter-contract-hardening-rfc.md) | Further hardened the adapter contract checks. |
| P31 | [Deterministic roadmap stabilization](deterministic-roadmap-stabilization-rfc.md) | Made AI-assisted roadmap generation reproducible. |
| P32 | [Failure clarity](failure-clarity-rfc.md) | Surfaced the failing check, its reason, and the rerun-after-fixing command on `task complete` / `task finalize` failures. |
| P33 | [Lightweight lane + recommendation consumption](lightweight-lane-rfc.md) | Added `lifecycleMode` (`full_loop` / `record_only` / `decision_loop`) and the adapter guidance that consumes the recommendation (P35 merged in). |
| P34 | [CI branch-drift detection](ci-branch-drift-rfc.md) | Added `--base-ref` + the `CONTROL_PLANE_BRANCH_NOT_DRIVEN` advisory for PR CI. |
| P36 | [ADR quality advisory](adr-quality-advisory-rfc.md) | Added the `ADR_ACCEPTED_BODY_THIN` stub advisory (no heading-name sniffing). |
| P37 | [Outcome audit — deferred](P37-deferred-outcome-audit.md) | **Deferred.** Recorded why effectiveness-measurement was not built (gameable subjective fields; not reliably derivable from `progress.yaml` today). |
| P39 | [Root-cause-first completion errors](root-cause-completion-errors-rfc.md) | Add `error.cause_code` + an actionable `error.message` on `task complete` failures (port the `record-done` cause); minimal surface — no error-side duplication of the P32 `data` fields, no new structured block, `finalize` unchanged (it never runs the decision gate). |
| — | [Beginner-friendly CLI aliases](cli-alias-ux-rfc.md) | Added additive aliases `task next` / `phase next` / `task reconcile` / `plan import` (thin sugar to the canonical handlers). The `dogfood.md` rename stays deferred. |
| — | [Doc truth from code](doc-truth-from-code-rfc.md) | Generate *enumerable* public-contract facts (e.g. the `spec import` `data.detail` table) from a typed catalog in `src/` as a `@generated` doc block; CI checks only block drift. Reduces hand-written facts — it does **not** add doc-quality / style policing. |
| P44 | [CI / adoption page](ci-adoption-page-rfc.md) | Added `docs/workflows/ci.md` (+ ja mirror) as the single CI adoption home — a thin orchestration page (contributor-vs-maintainer loops, one minimal pinned GitHub Actions gate, a preconditions checklist) that links to `cli-contract.md` for the `--base-ref` contract rather than duplicating the workflow YAML. |
| P45 | [Context-pack write contract hygiene](context-pack-write-contract-hygiene-rfc.md) | Routed `writeContextPack()` through `atomicWriteText` (it used a raw `writeFile`, breaking the published atomic-write guarantee for listed managed file-content writes) and corrected the docs that blur `task context` (read-only — builds/returns the pack) with `task prepare` / `pack` (the writers). Patch-level (v1.29.1); no surface change. |
| P46 | [Context Fit](context-fit-rfc.md) | The future RFC P24 deferred: named budget profiles + `--context-budget`, a recommended budget on `recommend` / `task prepare`, `--explain` fit metrics, and `plan lint` context-bloat advisories — four additive layers over `--budget-bytes`, plus the recorded principle to prefer local deterministic computation over agent reasoning (the Reduction taxonomy). RFC-only bootstrap; behavior ships in P47–P50. |
| — | [Post-1.26 agent-DX backlog](../../docs/maintainers/history/post-1.26-agent-dx-backlog.md) → *moved to history* | **Complete.** Sequencing + re-scope intent for P40-P44 (not a gated decision). P43, P41, P40, P42, and P44 each shipped with its own RFC; this backlog now lives under [`docs/maintainers/history/`](../../docs/maintainers/history/post-1.26-agent-dx-backlog.md). |
| — | [Collaboration-safe state](collaboration-safe-state-rfc.md) | **Accepted (A+B; C deferred).** Move the progress ledger to one-file-per-event under `.code-pact/state/events/` (conflict-free, lost-update-free, dual-reads legacy `progress.yaml`) and reconcile the `.code-pact/` shared-vs-local policy across `init`/ci/dogfood. Explicitly **defers** collision-resistant phase ids, `roadmap.yaml`-optional, and task-file split (Bucket C) behind a real-demand trigger. |
| — | [Control-plane v2](control-plane-v2-rfc.md) | **Accepted (scope-limited: PR0 + PR1a + PR1b only).** Takes up deferred Bucket C (phase identity / glob discovery / `roadmap.yaml`-advisory / per-task files). PR1a (fail-closed `AMBIGUOUS_PHASE_ID`) and PR1b (**re-scoped**: structured `recovery` on the existing `DUPLICATE_*` / `PHASE_ID_MISMATCH` errors — the `LEGACY_*` warning-default advisories are **superseded/deferred**) shipped; PR2+ remain gated on the §5 soak + forensic incident backfill. |
| — | [Collaboration UX](collaboration-ux-rfc.md) | **Accepted (D1–D3, additive MINORs).** The *coordination* layer atop the merge-safe ledger: optional `author` attribution on events (D1), a read-only `code-pact status` activity overview — in flight / blocked / available / waiting (D2), and attribution-named (`details.events[]`) conflict recovery (D3). Pinned JSON contract; explicitly rejects presence servers, blocking locks, and auto-resolution. Ships D1 → D2 → D3 independently. |
| — | [Decision record lifecycle](decision-lifecycle-rfc.md) | **Accepted.** Shipped `decision prune --write` (status-aware ref integrity + eligibility gates + an append-only `PRUNED.md` tombstone ledger), `decision_retention` policy reporting, the CHANGELOG rolling-archive + release-notes tooling, and the archive-discoverability guard. Dogfooding found this repo's phase-born RFCs are load-bearing, so this repo uses **`keep-full`**; `compress-on-ship` is deferred (lossy). |
| v2.0 | [Design docs are ephemeral](design-docs-ephemeral-directive.md) → *transitional directive* | **Accepted (v2.0 product direction).** Moves runtime truth for **completed phase references and retired/settled decision outcomes** from `design/` to `.code-pact/state` + generated control snapshots (the active roadmap and not-yet-archived phase/task definitions stay `design/` inputs): completed `design/phases/*.yaml` and retired `design/decisions/*.md` become **ephemeral** (hand-removable / `.gitignore`-able once snapshotted; missing *archived* docs tolerated, missing *active* docs fail closed). Demotes `PRUNED.md` to read-only backcompat (the v2.0 tombstone lives under `.code-pact/state`). **Supersedes** constitution "`design/` is the source of truth" and the move-only-non-gate-records rule below. Staged PRs, reader-side backcompat. **Itself retire-able** after v2.0 lands. |

## What belongs here (and what does not)

`design/decisions/` is the **decision layer**, not a general archive. The
filename scan and `decision_refs` resolution treat every `.md` here as a
candidate gate-resolving ADR, so the directory should hold decisions and only
decisions. Two files are sanctioned exceptions, excluded from that scan by name:
this `README.md` index and [`PRUNED.md`](PRUNED.md) — the append-only ledger of
decisions retired by `decision prune` (see [decision-lifecycle-rfc.md](decision-lifecycle-rfc.md)).

**Put here:**

- An RFC for any significant, durable design decision and its rationale.
- *Negative-space* decisions — a cancellation, deferral, or supersession that a
  future contributor would otherwise re-litigate (e.g. [P22 cancelled](P22-cancelled-adapter-schema-v2.md),
  [P37 deferred](P37-deferred-outcome-audit.md)). These stay `accepted` (the
  decision *to not build* was made and approved) and say so in their title and
  first line, so they read as closed, not as live commitments.

**Do not put here** — move these to [`docs/maintainers/history/`](../../docs/maintainers/history/) instead:

- **Sequencing / backlog intent records** that schedule work but do not
  themselves decide a design (e.g. "do P40 before P43"). No gate references
  them; they are planning provenance, not contracts. The
  [post-1.26 agent-DX backlog](../../docs/maintainers/history/post-1.26-agent-dx-backlog.md)
  is the worked example — it lived here, gated nothing, and moved out.
- **"Complete" markers for a body of work** — a backlog whose every item shipped
  is history. Record the closure in CHANGELOG and the shipped phases' own RFCs.
- **Per-task implementation notes** — those belong in `progress.yaml` and the
  task context pack, not as an ADR.

Before moving anything, confirm it is not named by a `decision_refs` /
`acceptance_refs` in `design/phases/*.yaml` (those are the gate-bearing
references — see the move warning at the top). A `reads` / `writes` mention is
not a gate reference and does not block a move.

After a move, leave those historical `reads` / `writes` paths and prose
mentions in already-shipped phases pointing at the old location. They record
where a completed task actually read or wrote **at the time**; rewriting them to
the new path would fabricate history, and `plan lint` does not flag a stale
`writes` glob. (The post-1.26 move left its mentions in P39/P42/P44 untouched
for exactly this reason.)

## ADR status convention

Each ADR opens with a status line on the second line of the file:

```
# <RFC title>

**Status:** accepted (<phase or scope>, <YYYY-MM>)
```

YAML frontmatter is also recognized (`status: accepted` between `---` delimiters at the very top); when both are present, the frontmatter wins.

The status word governs the [decision gate](../../docs/cli-contract.md#error-codes) that protects `requires_decision` tasks (since v1.22, RFC §3-C):

| Word | Gate verdict |
| --- | --- |
| `accepted` | resolves the gate |
| `proposed` / `draft` / `rejected` / `superseded` | does **not** resolve |
| empty file | does **not** resolve |
| explicit unknown word (e.g. a typo) | does **not** resolve |
| **no status line** (non-empty body) | resolves as accepted — the only lenient case, for backward compat with projects that pre-date status-aware parsing |

**Status answers one question only: is this record live and gate-resolving?**
It deliberately does *not* say what was decided. A decision to **cancel** or
**defer** a feature is still a real, approved decision, so it stays `accepted`
(so the gate resolves and it never reads as unfinished work) and records the
cancellation/deferral in its title and first line — see [P22](P22-cancelled-adapter-schema-v2.md)
and [P37](P37-deferred-outcome-audit.md). Use `status: superseded` (which does
*not* resolve the gate) only when you genuinely want the gate to stop resolving
against an ADR a later one replaces. There is no separate machine-read `outcome`
field today: with cancellations and deferrals this rare, the human-readable
title plus this index's "What it decided" column carry the distinction. Add a
structured field only if a command or lint actually needs to consume it.

Resolution chooses one of two paths:

- **`task.decision_refs` (explicit references)** — every referenced ADR must be `accepted`. A single `proposed` / missing / empty / unknown ref fails the gate. This is the strong contract.
- **Filename scan over `design/decisions/`** (no `decision_refs`) — the gate resolves if **any** `.md` whose filename contains the task id is accepted. The any-accepted-wins rule preserves the substring-collision compat (e.g. `P1-T1` also matches `P1-T10-*.md`) that has shipped since v0.x.

When a decision is intentionally not yet settled, leave the ADR at `proposed`. `plan lint --include-quality` surfaces `TASK_DECISION_UNRESOLVED` early; `verify` / `task complete` / `task record-done` block completion until the status is flipped to `accepted`.

`code-pact phase import --scaffold-decisions` (and `plan adopt --write --scaffold-decisions`) generates these `proposed` stubs for you — one per `requires_decision` task that has no ADR yet (RFC §3-D). The stub opens at `proposed`, so it does **not** pass the gate; filling it in and flipping **Status** to `accepted` is the human act that releases it. Opt-in (off by default); existing ADRs are never overwritten.

## Rules

Enforcement rules referenced by the CLI live alongside the decisions:

| Doc | What it covers |
| --- | --- |
| [rules/json-output.md](../rules/json-output.md) | JSON output formatting rules. |
| [rules/protected-paths.md](../rules/protected-paths.md) | Protected-path enforcement rules. |
| [rules/doc-authoring.md](../rules/doc-authoring.md) | Generate enumerable contract facts from code; the CI-burden contract every new check must satisfy. |
