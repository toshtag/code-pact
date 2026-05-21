# Finalization & Reconciliation (v1.2+)

This document is the agent- and reviewer-facing walkthrough of `task finalize` and `phase reconcile`, the two commands introduced in v1.2.0 to mechanize the drift between progress evidence and design intent. For the full design rationale, read [`design/decisions/finalization-reconciliation-rfc.md`](../../design/decisions/finalization-reconciliation-rfc.md). For the migration story from v1.1.x, read [`docs/migration.md` § v1.1.x → v1.2.0](../migration.md#v11x--v120).

## The drift these commands close

`code-pact` keeps a deliberate split between **design intent** (`design/phases/*.yaml`) and **operational fact** (`.code-pact/state/progress.yaml`):

- `task complete` records the fact ("verify passed, the task is done") by appending a `done` event to `progress.yaml`.
- It **never** mutates `status: planned` in the phase YAML.

That split protects the v1.0 contract — agents and CI tooling can rely on `task complete` being side-effect-free at the design layer — but it accumulates drift. After every `task complete`, `plan analyze` reports a `STATUS_DRIFT done-but-design-not-done` warning until someone hand-edits the phase YAML to flip `status: planned` → `status: done`. Through v1.1.x, that hand-edit was a manual step in every release-prep PR.

v1.2.0 mechanizes that step.

## `task finalize <task-id>`

```sh
# Preview — does NOT write.
code-pact task finalize P9-T5 --json

# Apply — atomic write to design/phases/<phase>.yaml.
code-pact task finalize P9-T5 --write --json
```

What it does:

1. Resolves `<task-id>` via the same roadmap scan as `task context` / `task complete`.
2. Reads `progress.yaml`, derives the task's current state, and refuses with `TASK_FINALIZE_NOT_ELIGIBLE` (exit 2) unless that state is `done`. The check is identical in dry-run and `--write` — dry-run means "won't write", not "won't validate".
3. If the phase YAML already shows `status: done` for this task, returns `kind: "already_finalized"` (exit 0) with no write.
4. Otherwise, rewrites `tasks[].status` for that one task via atomic write. Other fields and other tasks in the file are untouched.

What it does **not** do:

- Touch `progress.yaml`. The append-only contract is preserved.
- Write to `design/roadmap.yaml`. That stays a manual release-prep step until P14.
- Flip the phase's own `status` field. That stays manual until P14.
- Call any adapter. There is no `--agent` flag.

JSON envelope kinds: `would_finalize` (dry-run), `finalized` (`--write` applied), `already_finalized` (no-op).

## `phase reconcile <phase-id>`

```sh
# Preview — what would reconcile do across the whole phase?
code-pact phase reconcile P9 --json

# Apply — flip every eligible task at once.
code-pact phase reconcile P9 --write --json
```

`phase reconcile` is the bulk counterpart. It walks every task in the phase and classifies each into one of three actions:

| Action | When | Effect of `--write` |
| --- | --- | --- |
| `flip` | Derived state is `done` AND design status is `planned` / `in_progress` | Status rewritten to `done` (atomic write) |
| `skip` | Already `done`, OR `planned` with no events, OR work in progress (`started` / `resumed`) | No change |
| `manual_review` | Derived state is `blocked` or `failed` | No change. Run `plan analyze` for diagnosis |

`phase reconcile` only ever mutates `flip` tasks. `manual_review` tasks are surfaced in `data.tasks[]` but never touched even with `--write` — they require human judgement, which a deterministic command should not pretend to provide.

JSON envelope kinds: `would_reconcile` (dry-run), `reconciled` (`--write`), `no_eligible_tasks` (exit 0, intentionally not an error code — nothing to flip is a normal outcome).

## Partial success is normal

`phase reconcile --write` may apply some flips while refusing others (unsafe path, symlink escape, target outside `design/phases/`, etc.). Both `applied_writes[]` and `skipped_writes[]` are populated and the command returns exit 0. Only when **every** eligible flip is refused does `PHASE_RECONCILE_WRITE_REFUSED` (exit 2) fire.

This matches the spirit of `adapter upgrade`: the contract is "do as much as is safe, surface exactly what was skipped and why."

## Phase status remains manual in v1.2 — formalized as the convention in v1.5+ / P14

`phase reconcile` reports a `phase_status_candidate` (`done` / `in_progress` / `planned`) by simulating the post-flip state, but never writes the phase's own `status` field:

```json
{
  "phase_status_candidate": "done",
  "phase_status_note": "advisory — phase status is never written by phase reconcile in v1.2; flip by hand in release prep until P14"
}
```

The candidate exists so release-prep PRs have a deterministic check ("if reconcile suggests `done`, flip the phase status by hand"). Auto-flipping the phase is the kind of judgement call that P14 governance was expected to address — it often depends on non-task work (release prep, docs, manual cleanup) that no command can verify.

**v1.5+ / P14 decision: manual-flip is the convention, auto-flip stays out of scope.** The P14 governance RFC ([design/decisions/governance-rfc.md](../../design/decisions/governance-rfc.md) § Phase status policy) explicitly defers auto-flip implementation to a future RFC. The release-prep convention is:

1. Run `code-pact phase reconcile <phase-id> --write` to flip task statuses.
2. Hand-edit the phase's own `status` field in `design/phases/<phase>.yaml` (typically in the release-prep PR).

A future RFC may design either a `phase reconcile --write --phase-status` flag, a separate `phase finalize <phase-id> --write` command, or some other mechanism — but v1.5 does NOT design or implement any of them. The `phase_status_note` JSON-envelope text remains accurate: phase status is never written by `phase reconcile`, and that contract is now load-bearing rather than transitional.

## The full release-prep loop, before and after

**Before (v1.1.x release prep):**

1. Bump version + write CHANGELOG.
2. **Hand-edit each completed task's `status: planned` → `status: done` in `design/phases/*.yaml`.**
3. Hand-edit the phase status when every task is done.
4. Hand-edit `design/roadmap.yaml` if a phase weight or status moved.
5. Commit + PR.

**After (v1.2.0+ release prep):**

1. Bump version + write CHANGELOG.
2. `code-pact phase reconcile <phase-id> --write --json` — flips every eligible task in one shot.
3. Hand-edit the phase status when every task is done — **manual by convention** in v1.5+ (P14 governance RFC § Phase status policy); `phase_status_candidate` tells you what it should be.
4. Hand-edit `design/roadmap.yaml` if a phase weight or status moved (still manual — the writer chokepoint is `createPhase` (see [docs/cli-contract.md § Roadmap mutation policy](../cli-contract.md#roadmap-mutation-policy-v15--p14)), and a `roadmap reconcile`-style command is deferred to a future RFC).
5. Commit + PR.

Step 2 replaces what was previously the most repetitive and error-prone part of release prep.

## How `plan analyze` advertises the fix

The `STATUS_DRIFT done-but-design-not-done` warning that `plan analyze` emits now carries an additive `details.remediation` field that names the exact command to run:

```json
{
  "code": "STATUS_DRIFT",
  "severity": "warning",
  "details": {
    "kind": "done-but-design-not-done",
    "design_status": "planned",
    "derived_state": "done",
    "remediation": "code-pact task finalize P9-T5"
  }
}
```

Only the `done-but-design-not-done` kind carries this hint — the other four STATUS_DRIFT kinds (`done-blocked-conflict`, `done-with-incomplete-events`, `done-historical`, `in-progress-no-events`) need human judgement and are not mechanizable, so they intentionally stay unannotated. Agents and CI consumers reading `plan analyze --json` can act on the warning without consulting any docs.

## Field reference

The `data` payload for both commands lists declarative context to help reviewers audit the proposed mutation:

- `acceptance_refs_check[]` (task finalize only) — each declared `acceptance_refs` path plus whether it exists on disk. **Existence check only**; semantic validation of the file content is intentionally out of scope.
- `declared_writes[]` (task finalize only) — the task's declared `writes` globs, surfaced as-is. See § Declared writes as a governance review surface below for the v1.5+ contract.
- `depends_on_check[]` (task finalize only) — for each `depends_on` entry, the current derived state and whether it is `done`. Used as a warning surface; finalize does not block on unsatisfied dependencies.

`phase reconcile` does not emit these per-task fields in the top-level payload — they are present in `data.tasks[]` only when a per-task verdict needs them.

## Declared writes as a governance review surface (v1.4+ / P14)

The `writes` field on a task (P10, v1.1+) and the `declared_writes[]` field on `task finalize` JSON output (P11, v1.2+) together form a **review surface**, not enforcement.

**What the surface IS in v1.5:**

- A declaration of intent: the task author says "this task is expected to write these globs."
- A reviewable signal in `task finalize --json` / `task runbook --json` output: a human (or agent) can compare declared intent against actual file-system changes (typically via `git diff`) when reviewing a PR or commit.
- A lint surface via `TASK_WRITES_PROTECTED_PATH` (P10, warning severity in v1.5): the lint flags when declared `writes` cover paths in the protected seed set (`.git/**`, `node_modules/**`, `.code-pact/**`, `design/roadmap.yaml`, `design/phases/*.yaml`). Under `plan lint --strict` the advisory becomes exit-relevant. As of v1.5.1, this repo's dogfood corpus is expected to pass that strict check with zero warnings.

**What the surface is NOT in v1.5:**

- **Not enforced at runtime.** `task complete` / `task finalize` / `phase reconcile` / any other command does NOT verify that actual file-system writes match declared `writes`. A task can declare `writes: src/foo.ts` and modify `src/bar.ts` without code-pact noticing.
- **Not tracked across the per-task loop.** code-pact does not run the agent's implementation, so there's no opportunity to observe writes as they happen.
- **Not git-aware.** No `git diff` comparison between declared and actual change sets.

**Why "review surface" is the right v1.5 posture.**

Actual write enforcement requires either:

- A runner that observes file-system writes during command execution, or
- VCS integration (e.g. `git diff` between two commits or against a base ref) to verify declared `writes` covered the actual changes.

Both options are significant scope expansions. The P14 RFC explicitly defers them to P15+. Meanwhile, the v1.2 + v1.3 surfaces (declared_writes in `task finalize` output, state_summary.declared_writes in `task runbook` output) give a reviewer everything they need to spot a declared/actual mismatch in PR review — without committing to a specific enforcement mechanism that might constrain future design.

**How to use the surface today.**

In a PR review (human or agent-assisted):

1. Run `code-pact task finalize <task-id> --json` (dry-run) to read the `declared_writes` array for the task.
2. Compare against `git diff --name-only main...HEAD` (or equivalent) for the actual changes.
3. Flag any mismatch — declared paths not touched, or untouched paths beyond the declaration — as a review concern.

Or via the runbook:

1. Run `code-pact task runbook <task-id> --json`.
2. Read `data.state_summary.declared_writes` for the same declaration.
3. Apply the same comparison.

Both surfaces emit the same data; pick whichever fits the reviewer's workflow.

## Error code reference

Three new public error codes ship in v1.2.0 (all additive in `KNOWN_CODES.public`):

| Code | Exit | Raised by | Trigger |
| --- | --- | --- | --- |
| `TASK_FINALIZE_NOT_ELIGIBLE` | 2 | `task finalize` (both modes) | Derived state from `progress.yaml` is not `done` |
| `TASK_FINALIZE_WRITE_REFUSED` | 2 | `task finalize --write` | Safety check refused the phase YAML write (unsafe path, outside `design/phases/`, symlink escape, unparseable phase, etc.) |
| `PHASE_RECONCILE_WRITE_REFUSED` | 2 | `phase reconcile --write` | Every eligible task write was refused for safety reasons (partial successes return exit 0) |

`no_eligible_tasks` is intentionally **not** an error code — it is represented as `data.kind: "no_eligible_tasks"` with exit 0. Nothing to flip is a normal outcome.

## What stays the same

- `task complete` is unchanged. Same flags, same JSON envelope, same exit codes, same error codes. The v1.0 contract — `task complete` records progress only and never mutates design YAML — is preserved.
- `progress.yaml` is read-only for the new commands. The append-only operational-log contract is preserved.
- No new STATUS_DRIFT kind. No existing kind changes severity or `hidden_by_default`. The `details.remediation` field is purely additive.
- `task context` pack output for v1.0 / v1.1 tasks remains unchanged (the byte-identical pack regression test passes without modification).
- The `KNOWN_CODES.public` surface lock is extended additively. No existing entry is renamed or recategorized.

## See also

- [`design/decisions/finalization-reconciliation-rfc.md`](../../design/decisions/finalization-reconciliation-rfc.md) — the full RFC (alternatives considered, open questions)
- [`docs/cli-contract.md` § `task finalize`](../cli-contract.md#task-finalize--flip-task-design-status-to-done-v12-p11)
- [`docs/cli-contract.md` § `phase reconcile`](../cli-contract.md#phase-reconcile--bulk-flip-task-design-statuses-for-a-phase-v12-p11)
- [`docs/migration.md` § v1.1.x → v1.2.0](../migration.md#v11x--v120) — adoption pattern and CI implications
- [`docs/concepts/task-readiness-fields.md`](task-readiness-fields.md) — the P10 sibling document; the `writes` and `acceptance_refs` fields are surfaced (but not enforced) by P11
