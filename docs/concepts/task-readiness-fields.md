# Task Readiness Schema

This document is the agent- and reviewer-facing walkthrough of the five optional task fields. For the full design rationale and the per-field decision matrix, see the **task-readiness-schema RFC** (retired — in git history and the `.code-pact/state` archive record).

## The five optional fields

Five `.optional()` fields on `src/core/schemas/task.ts`:

- `depends_on: string[]` — task ids this task should not start until done
- `decision_refs: string[]` — paths to decision files that the agent should read as part of context
- `reads: string[]` — glob(s) declaring what files the task reads
- `writes: string[]` — glob(s) declaring what files the task writes
- `acceptance_refs: string[]` — paths to files that describe the acceptance criteria

All five are additive. **A task that declares none of them behaves exactly like one with no readiness fields at all.**

## A phase YAML that uses every field

```yaml
# design/phases/P9-onboarding.yaml (excerpt)
id: P9
name: Onboarding Baseline
weight: 20
confidence: high
risk: low
status: planned
objective: |
  Reduce the time-to-first-task-complete for new users by restructuring
  the entry path docs and seeding the dogfood corpus.
verification:
  commands:
    - pnpm typecheck
    - pnpm test
    - pnpm build
    - node dist/cli.js plan lint --json
    - node dist/cli.js validate --json
tasks:
  - id: P9-T2
    type: docs
    ambiguity: low
    risk: low
    context_size: medium
    write_surface: medium
    verification_strength: medium
    expected_duration: medium
    status: planned
    description: |
      Slim README + add docs/getting-started.md with three onboarding
      paths (tutorial / manual / AI-assisted).

    # Task Readiness Schema declarations
    depends_on:
      - P9-T1                                  # dogfood close must land first
    decision_refs:
      - design/decisions/stability-taxonomy.md # the stability contract this work operates under
    reads:
      - README.md                              # the file being slimmed
      - docs/cli-contract.md                   # source of truth for CLI surface
      - src/commands/init-wizard.ts            # to ground the "sample phase" walkthrough
    writes:
      - README.md
      - docs/getting-started.md
    acceptance_refs:
      - design/phases/P9-onboarding.yaml       # the phase DoD itself
      - docs/cli-contract.md                   # contract that must remain unchanged
```

## What each field changes in practice

### `depends_on`

- **In `plan lint`:** flags references to ids not present in any phase (`TASK_DEPENDS_ON_UNRESOLVED`), direct self-cycles (`TASK_DEPENDS_ON_SELF_REFERENCE`), and multi-node `depends_on` cycles of length ≥ 2 (`TASK_DEPENDS_ON_CYCLE`, an iterative Tarjan SCC over the whole roadmap dep graph).
- **Cross-phase references:** `depends_on` can name a task declared in any phase, not just the current one. `task runbook`'s `state_summary.depends_on[i].phase_id` field is populated (additively) when a dep is cross-phase. `phase runbook --across-phases` aggregates runbooks for every `in_progress` phase plus the declaring phase of any unsatisfied (non-`done`) cross-phase dependency referenced by those in-progress tasks.
- **In `task context`:** the pack gains a `## Depends on` section. Each dependency is shown with its current derived state from the progress ledger (`planned` / `started` / `blocked` / `resumed` / `done` / `failed`). The agent can decide whether the dependency is ready before starting.
- **No runtime enforcement:** `task start` does not refuse to begin a task whose dependencies are incomplete. The declaration is for context, documentation, and lint validation; there is no runtime gate.

### `decision_refs`

- **In `plan lint`:** path-safety check (`TASK_DECISION_REF_UNSAFE_PATH`) and a **status-aware** existence check (`TASK_DECISION_REF_NOT_FOUND`): a missing target is an `error` for any not-`done` task; once that task is `done` it downgrades to an advisory `warning` (`affects_exit: false`) — the task has completed, so the ref is a historical annotation, and a shipped decision record can be retired without breaking the plan. Keyed on the task's own status, not its phase's (`cancelled` stays an `error`).
- **In `task context`:** the pack gains a `## Declared decisions` section with the full body of each referenced file, **inserted regardless of `context_size`**. This is additive to the existing `context_size: large` allDecisions path; files appearing in both are surfaced once under "Declared decisions" and filtered out of the existing "Related Decisions" section.
- **In the decision gate:** when a task (or its phase) is `requires_decision: true`, `decision_refs` feed the [decision gate](decision-gate.md) with **all-must-be-accepted** semantics — `verify` / `task complete` / `task record-done` stay blocked until **every** referenced ADR is `**Status:** accepted`. With no `decision_refs`, the gate falls back to a filename scan of `design/decisions/` (any-accepted-wins). `phase import --scaffold-decisions` auto-generates `proposed` ADR stubs for the referenced paths (or the default `design/decisions/<task-id>.md`) so there is something to fill in and accept. See the [decision-gate concept](decision-gate.md) for the full model.

### `reads`

- **In `plan lint`:** path-safety check (`TASK_READS_UNSAFE_PATH`), glob-syntax check against the supported subset (`TASK_READS_GLOB_INVALID`), and a warning when a glob matches zero files on disk (`TASK_READS_NO_MATCH`).
- **In `task context`:** the pack gains a `## Declared read surface` section listing each glob and the set of currently-matched files. **File contents are not inlined** — only the path list.

### `writes`

- **In `plan lint`:** path-safety (`TASK_WRITES_UNSAFE_PATH`), glob syntax (`TASK_WRITES_GLOB_INVALID`), over-broad declared globs (`TASK_WRITES_OVER_BROAD`, which flags patterns whose root segment is `**` such as `**`, `**/*`, `**/*.ts`), and an advisory warning when the declared glob overlaps a protected path (`TASK_WRITES_PROTECTED_PATH`). The protected-path list is configurable via [`design/rules/protected-paths.md`](../../design/rules/protected-paths.md), falling back to the hardcoded defaults (`.git/**`, `node_modules/**`, `.code-pact/**`, `design/roadmap.yaml`, `design/phases/*.yaml`) when that file is absent. The diagnostic stays a warning by default.
- **`write_audit`** (`task finalize --json`): an advisory layer that compares declared `writes` globs against the actual working-tree diff (default) or the merge-base branch view (`--base-ref`). Emits `TASK_WRITES_AUDIT_OUTSIDE_DECLARED` when a touched file matches no declared glob, and `TASK_WRITES_AUDIT_DECLARED_UNUSED` when a declared glob matches zero touched files. Promote to exit-relevant with `task finalize --audit-strict --json` (add `--write` to also finalize the design YAML on the clean path); in CI pair with `--base-ref <default-branch>` so the audit compares against the merge-base (otherwise a clean working tree fires `DECLARED_UNUSED` for every task that declared writes).
- **In `task context`:** the pack gains a `## Declared write surface` section listing each declared glob. **No filesystem lookup** because writes are by definition future-tense.

### `acceptance_refs`

- **In `plan lint`:** path-safety (`TASK_ACCEPTANCE_REF_UNSAFE_PATH`) and a **status-aware** existence check (`TASK_ACCEPTANCE_REF_NOT_FOUND`) — `error` for any not-`done` task, advisory `warning` (`affects_exit: false`) once the task is `done`, like `decision_refs`.
- **In `task context`:** the pack gains a `## Acceptance references` section with the path list only — no content excerpt.
- **In `task finalize`:** each declared path is surfaced in `acceptance_refs_check[]` with whether it exists on disk (existence only; semantic validation of the file content is out of scope).

## Supported glob subset

`reads` / `writes` use a minimal in-repo glob matcher. The supported subset is intentionally narrow because code-pact keeps the runtime dependency policy from [`CONTRIBUTING.md`](../../CONTRIBUTING.md#runtime-dependency-policy) (`yaml` + `zod` only):

- literal path segments
- `*` within a single path segment (does **not** cross `/`)
- `**` as a **full** path segment only (matches zero or more segments)

Not supported: brace expansion (`{a,b}`), extglob (`@(...)` / `+(...)` / `*(...)` / `?(...)` / `!(...)`), negation (`!pattern`), character classes (`[abc]`), backslash escapes (`\*`). Patterns outside the subset fire `TASK_READS_GLOB_INVALID` / `TASK_WRITES_GLOB_INVALID`. Adopting an external glob library would be a separate runtime-dependency decision.

## Recommended adoption pattern

- **Declare on new tasks first.** Don't retroactively add the fields to every existing task — the lint surface tolerates absence, and exhaustive backfill is explicitly discouraged.
- **Start with `depends_on` and `decision_refs`.** These produce the most immediately useful effect on `task context`: a "Depends on" section with derived state and a "Declared decisions" section that pulls referenced decisions into the pack regardless of `context_size`.
- **Use `reads` / `writes` only when they are load-bearing.** They are surfaced in the context pack and lint-validated. `writes` is additionally audited by `task finalize --json`; the audit is advisory by default and becomes exit-relevant only with `--audit-strict`. There is still no pre-write enforcement — the value comes from documenting and reviewing the intended surface.
- **Skip `acceptance_refs` until you have a real acceptance criteria layout.** They are path references with an existence check at `task finalize` time — nothing more.

## Intentionally out of scope

- **File content inclusion for `reads`** — the read-surface section lists matched paths, not file bodies.
- **ID-based references for `decision_refs` / `acceptance_refs`** — paths only.
- **Line-level acceptance references** — file-level only.
- **A `human_gate` field** — not part of the schema.
- **Hard enforcement of declared `writes`** — the protected-path advisory stays a warning (exit-relevant only under `plan lint --strict`) and the `write_audit` is advisory unless `--audit-strict`; nothing blocks a write as it happens.

## See also

- The **task-readiness-schema RFC** (retired; in git history / the `.code-pact/state` archive record) — full RFC with field semantics, validation rules, and the backward-compat contract.
- [`docs/migration.md`](../migration.md#v10x--v110) — upgrade walkthrough.
- [`docs/cli-contract.md` § `phase import`](../cli-contract.md#phase-import) — the phase-import schema reference, including the lenient-mode behaviour for these fields.
- [`docs/cli-contract.md` § `task context`](../cli-contract.md#task-context--context-quality-gates-v051-v11-additions) — the pack's declared-sections reference.
- [`docs/cli-contract.md` § Plan diagnostic codes](../cli-contract.md#plan-diagnostic-codes) — the full `TASK_*` lint-code reference.
