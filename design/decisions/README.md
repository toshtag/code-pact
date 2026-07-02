# Design decisions (RFC index)

Every significant change to `code-pact` is recorded here as an RFC before it
ships. Each file states a **Status**, **Scope**, **Owners**, and **Related**
decisions; the longer ones open with a plain-language **Summary**. These are
the _why_ behind the code — the user-facing _how_ lives in [`docs/`](../../docs/README.md).

> **Active / live decisions stay in `design/decisions/`.** A decision named by a
> live task reference — a `decision_refs` or `acceptance_refs` in
> `design/phases/*.yaml` — must keep its file present (or be retired the right way,
> below); renaming or moving it without updating every reference (and the index
> below) breaks that reference. The two references are **not** the same kind of
> thing: `decision_refs` is a live **gate** (a missing live file fails closed
> unless an accepted record satisfies it — see below), while `acceptance_refs` is
> a reference-integrity **annotation**, not a gate (when the target is a
> `design/decisions/**/*.md`, a valid record of any status can soften its lint — but a
> non-decision target like `docs/cli-contract.md` stays strict, and it never
> releases a gate either way). A non-gate history record —
> one no `decision_refs` / `acceptance_refs` points at — may be moved out after you
> confirm that; see [What belongs here](#what-belongs-here-and-what-does-not) for
> where it goes.
>
> **Retired decisions are removable — once a record exists.** Under the v2.0
> design-docs-ephemeral model (implemented; the durable model lives in
> [`constitution.md`](../constitution.md)),
> a retired / settled decision may be removed — by hand or via
> `decision retire --write`, up to and including the whole `design/decisions/`
> directory — **only after** a validated `.code-pact/state` decision-state record
> represents it. The readers then resolve a record-backed retired decision from
> `.code-pact/state` (live file present always wins; a record is consulted only on
> a true absence). A live `decision_refs` still **fails closed** unless the live
> decision exists OR an **accepted** record can satisfy the gate — a non-accepted
> record never releases a live gate. `PRUNED.md` is legacy/prune backcompat, **not**
> the durable v2.0 retire truth; the decision-state record is.

### Live decisions

Only a decision still in flight — or `accepted` but holding an open
`## Implementation commitments` — keeps a file here. The list stays short by
construction, so it never drifts as decisions retire:

| Decision                                                            | Status                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Decision record lifecycle](decision-lifecycle-rfc.md)              | **Accepted** — the `decision compress` form (PR-D2) is still open (lossy; unbuilt).                   |
| [Task-prepare lifecycle-aware](task-prepare-lifecycle-aware-rfc.md) | **Accepted** — `task record-done` shipped; the RFC's closing commitments are not all checked off yet. |

### Retired decisions

A shipped or settled decision is **retired**, not re-listed here. Its durable
record moves to `.code-pact/state/archive` — which `code-pact`'s own checks resolve a
record-backed reference against — and its original Markdown stays in **git history**
and the [`CHANGELOG`](../../CHANGELOG.md). This index deliberately tracks **only live
decisions**: enumerating retired ones would 404 on GitHub the moment a file is
removed and would need an edit on every retire (exactly the maintenance cost the
ephemeral model exists to remove). To read a retired decision, run
`git log --follow -- design/decisions/<path>.md`, or inspect its record under
`.code-pact/state/archive`.

## What belongs here (and what does not)

`design/decisions/` is the **decision layer**, not a general archive. The
filename scan and `decision_refs` resolution treat every `.md` here as a
candidate gate-resolving ADR, so the directory should hold decisions and only
decisions. Two files are sanctioned exceptions, excluded from that scan by name:
this `README.md` index and [`PRUNED.md`](PRUNED.md) — the append-only ledger of
decisions retired by `decision prune` (see [decision-lifecycle-rfc.md](decision-lifecycle-rfc.md)).

**Put here:**

- An RFC for any significant, durable design decision and its rationale.
- _Negative-space_ decisions — a cancellation, deferral, or supersession that a
  future contributor would otherwise re-litigate (e.g. P22 _cancelled adapter
  schema v2_, P37 _deferred outcome audit_ — both now retired). These stay `accepted` (the
  decision _to not build_ was made and approved) and say so in their title and
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
`acceptance_refs` in `design/phases/*.yaml` (those are the live control-plane
references that break if you move the file — a `decision_refs` gate or an
`acceptance_refs` annotation; see the move warning at the top). A `reads` /
`writes` mention is neither, and does not block a move.

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

| Word                                             | Gate verdict                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `accepted`                                       | resolves the gate                                                                                                  |
| `proposed` / `draft` / `rejected` / `superseded` | does **not** resolve                                                                                               |
| empty file                                       | does **not** resolve                                                                                               |
| explicit unknown word (e.g. a typo)              | does **not** resolve                                                                                               |
| **no status line** (non-empty body)              | resolves as accepted — the only lenient case, for backward compat with projects that pre-date status-aware parsing |

**Status answers one question only: is this record live and gate-resolving?**
It deliberately does _not_ say what was decided. A decision to **cancel** or
**defer** a feature is still a real, approved decision, so it stays `accepted`
(so the gate resolves and it never reads as unfinished work) and records the
cancellation/deferral in its title and first line — as P22 (cancelled) and P37
(deferred) did before they were retired. Use `status: superseded` (which does
_not_ resolve the gate) only when you genuinely want the gate to stop resolving
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

| Doc                                                     | What it covers                                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [rules/json-output.md](../rules/json-output.md)         | JSON output formatting rules.                                                                      |
| [rules/protected-paths.md](../rules/protected-paths.md) | Protected-path enforcement rules.                                                                  |
| [rules/doc-authoring.md](../rules/doc-authoring.md)     | Generate enumerable contract facts from code; the CI-burden contract every new check must satisfy. |
