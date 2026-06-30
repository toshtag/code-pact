# The design-doc lifecycle: archiving and retiring

A finished project accumulates completed phases and settled decisions. code-pact
lets you **remove** those historical design docs — a completed
`design/phases/*.yaml` or a retired `design/decisions/*.md` — without breaking
anything that still points at them. This page is the user-facing walkthrough of
**how to do it safely**. The exact command contracts (JSON envelopes, error codes)
live in [`cli-contract.md`](../cli-contract.md#phase-archive); each verb's full
flag reference is in its `--help`.

## The short answer

A completed phase file or a retired decision file **is** deletable — but **only
after** its runtime truth has been saved to `.code-pact/state` as a snapshot (for a
phase) or a record (for a decision). Delete it before that, by hand, and the
control plane **fails closed**: it refuses to silently lose information an active
task might still need.

You do not delete the file yourself. The verb does it for you, in one step, after
the snapshot/record is durable:

- `code-pact phase archive <id> --write` — writes the snapshot **and** deletes the
  phase's `design/phases/*.yaml` file.
- `code-pact decision retire <path> --write` — writes the record **and** deletes
  the `design/decisions/*.md` file.

## Three states of a design doc

| State | Where the truth lives | What you can do |
| --- | --- | --- |
| **Live** | `design/phases/*.yaml` / `design/decisions/*.md` — the editable source | Edit it; it is the authoring surface |
| **Archived / retired** | a snapshot/record under `.code-pact/state/archive/` (the source file may still be present, or already deleted by `--write`) | Refs resolve from the snapshot/record |
| **Deleted** | the source file is gone; the snapshot/record remains | Everything still resolves; the file is reclaimable from git history if needed |

The reader is **live-wins**: while the source file is present it always takes
precedence; the snapshot/record is consulted only when the file is genuinely
absent.

## When a phase is archivable

Every task in the phase must have a **terminal state established independently of
the YAML** — a `done` derived from the progress ledger
(`.code-pact/state/events/`), or a recorded `cancelled` — and the phase itself must
be `done` / `cancelled`. A YAML `status: done` **alone is not enough**: it
disappears with the file, so the archive needs proof that survives deletion.

A task that is `done` in the YAML but has **no `done` event** blocks the archive
with `task_done_without_done_event`. Older projects whose tasks pre-date the
per-event ledger (a legacy `planned → done` shortcut) hit this. The narrow escape
is `--attest <task-id>=<reason>` (repeatable), which attests one such legacy
done-task. It is **only** that: it does not let you archive a non-terminal phase or
skip writing the snapshot.

## When a decision is retireable

A decision can be retired at **any** status — but if an **active** task still needs
it, the record must be able to carry that need:

- An accepted `decision_refs` gate → the accepted record carries it.
- A **non-accepted** `decision_refs` gate, or **any filename-scan gate** (a gated
  task with no explicit `decision_refs`, so there is no canonical key to look up) →
  the record **cannot** carry it, and retire refuses. Migrate the task to an
  explicit, accepted `decision_refs` first.
- An `acceptance_refs` (a reference-integrity annotation, not a gate) is softened by
  a valid decision-state record **only when it points at a `.md` decision record
  under `design/decisions/`**; an `acceptance_refs` to a non-decision target (an
  ordinary doc like `docs/cli-contract.md`) stays strict and is never softened by a
  record.

## The safe procedure

```sh
# 1. Dry-run (the default): read the eligibility verdict and the planned action.
#    Writes nothing, deletes nothing.
code-pact phase archive P1 --json

# 2. Apply: this writes the snapshot AND deletes the phase YAML, in that order.
code-pact phase archive P1 --write --json
```

There is **no separate "now delete the file" step** — the `--write` already
removed it. The same shape applies to a decision:

```sh
code-pact decision retire design/decisions/foo-rfc.md --json          # dry-run
code-pact decision retire design/decisions/foo-rfc.md --write --json  # writes record, deletes the .md
```

## Two kinds of bare `rm` — keep them apart

This is the part that trips people up.

**Bare `rm` *before* archive/retire → fail-closed (this is the safety, not a bug).**
If you delete a live completed phase file by hand with no snapshot yet, the gates
refuse. `plan lint` reports it as an error:

```jsonc
// rm design/phases/P2.yaml   (no snapshot written first)
// code-pact plan lint --json
{
  "ok": false,
  "error": { "code": "PLAN_LINT_FAILED", "message": "plan lint failed: 2 error(s), 0 warning(s)" },
  "data": {
    "errors": 2,
    "warnings": 0,
    "issues": [
      { "code": "MISSING_PHASE_FILE", "severity": "error",
        "message": "roadmap.yaml references \"design/phases/P2.yaml\" but the file does not exist" },
      { "code": "INVALID_YAML", "severity": "error",
        "message": "Cannot read or parse design/phases/P2.yaml: ENOENT ..." }
      // (both errors stem from the one missing file)
    ]
  }
}
```

`validate` fails the same way (it reports the same missing-phase error under its own
`VALIDATE_FAILED` envelope). Restoring the file makes both green again. The control
plane is refusing to lose the phase's task set silently — exactly the guarantee the
lifecycle is built on. Run
`phase archive --write` instead and the same deletion is safe.

**Bare `rm` *after* archive/retire → safe.** Once every relevant file is
snapshot/record-backed, a later bare `rm` of what is left — for example the whole
now-empty `design/decisions/` directory — keeps every gate green, because the
records resolve the references. (This composite hand-delete is pinned by the
`hand-delete-keeps-gates-green` integration test, and this project itself retired a
real decision this way.)

## Safety guarantees

- **Dry-run by default** — nothing is written or deleted until you pass `--write`.
- **Record-then-delete order** — the snapshot/record is written and readback-verified
  *before* the source file is deleted, so a failure never leaves you with neither.
- **Writer-not-trusted readback** — after writing, code-pact re-loads the
  snapshot/record through the reader and checks its `source_sha256` against the live
  file before authorizing the delete.
- **Identity re-check + external-state recheck** — immediately before the
  irreversible delete, the file's identity (content + inode/dev, no symlink escape)
  and the full external state are re-verified; any drift aborts with a `*_STALE`
  error and **the source file is left untouched**.
- **Live-wins** — a present source file is never overridden by a snapshot/record.
- **Doc links stay green** — an inbound `.md` link to a retired decision resolves as
  *retired* via the record, not as a broken link.
- **Archive maintenance never touches a live `design/` doc** — `state archive-maintain`
  (and the low-level `state compact-archive` / `state archive-retention` it orchestrates)
  bounds **only** `.code-pact/state/archive`. It folds the loose archive tail into bundles
  and removes unreferenced **archived** truth; it never deletes, rewrites, or resurrects a
  `design/decisions/*.md`, `design/phases/*.yaml`, `design/rules/`, or `design/roadmap.yaml`.
  A doc you safely removed *after* archiving stays removed — maintenance reads the archive,
  not the authoring surface. (Pinned by the `state-archive-maintain` integration tests:
  the live `design/` tree is byte-identical before and after `--write`, and the
  `hand-delete`-style safe-delete gates stay green.)

## See also

- [`cli-contract.md` § `phase archive`](../cli-contract.md#phase-archive) and
  [§ `decision retire`](../cli-contract.md#decision-retire) — the command contracts.
- [The decision gate](decision-gate.md) — what an active `requires_decision` gate
  needs, and why a non-accepted record can't release one.
