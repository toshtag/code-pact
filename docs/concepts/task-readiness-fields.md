# Task Readiness Schema (v1.1+)

This document is the agent- and reviewer-facing walkthrough of the five optional task fields introduced in v1.1.0. For the full design rationale and the per-field decision matrix, read [`design/decisions/task-readiness-schema-rfc.md`](../../design/decisions/task-readiness-schema-rfc.md). For the migration story from v1.0.x, read [`docs/migration.md` § v1.0.x → v1.1.0](../migration.md#v10x--v110).

## What changes vs v1.0.2

Five `.optional()` fields are added to `src/core/schemas/task.ts`:

- `depends_on: string[]` — same-phase task ids this task should not start until done
- `decision_refs: string[]` — paths to decision files that the agent should read as part of context
- `reads: string[]` — glob(s) declaring what files the task reads
- `writes: string[]` — glob(s) declaring what files the task writes
- `acceptance_refs: string[]` — paths to files that describe the acceptance criteria

All five are additive. **A task that declares none of them behaves exactly as it did under v1.0.2.**

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

    # P10 Task Readiness Schema declarations
    depends_on:
      - P9-T1                                  # P4 dogfood close must land first
    decision_refs:
      - design/decisions/stability-taxonomy.md # the v1.0 contract this work operates under
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

- **In `plan lint`:** flags references to ids not present in any phase (`TASK_DEPENDS_ON_UNRESOLVED` — v1.9 P19 made the resolver cross-phase aware; before that the check was same-phase only), direct self-cycles (`TASK_DEPENDS_ON_SELF_REFERENCE`), and multi-node `depends_on` cycles of length ≥ 2 (`TASK_DEPENDS_ON_CYCLE` — v1.9 P19, iterative Tarjan SCC over the whole roadmap dep graph).
- **Cross-phase references** (v1.9 P19+): `depends_on` can name a task declared in any phase, not just the current one. `task runbook`'s `depends_on_check[i].phase_id` field is populated (additively) when a dep is cross-phase. `phase runbook --across-phases` (v1.9+) aggregates runbooks for every `in_progress` phase plus any phase pulled in via one level of transitive dep-driven inclusion.
- **In `task context`:** the pack gains a `## Depends on` section. Each dependency is shown with its current derived state from `.code-pact/state/progress.yaml` (`planned` / `started` / `blocked` / `resumed` / `done` / `failed`). The agent can decide whether the dependency is ready before starting.
- **No runtime enforcement:** `task start` does not refuse to begin a task whose dependencies are incomplete. The declaration is for context, documentation, and lint validation; runtime gating is a candidate for P12 runbook.

### `decision_refs`

- **In `plan lint`:** path-safety check (`TASK_DECISION_REF_UNSAFE_PATH`) and existence check on disk (`TASK_DECISION_REF_NOT_FOUND`).
- **In `task context`:** the pack gains a `## Declared decisions` section with the full body of each referenced file, **inserted regardless of `context_size`**. This is additive to the existing `context_size: large` allDecisions path; files appearing in both are surfaced once under "Declared decisions" and filtered out of the existing "Related Decisions" section.

### `reads`

- **In `plan lint`:** path-safety check (`TASK_READS_UNSAFE_PATH`), glob-syntax check against the supported subset (`TASK_READS_GLOB_INVALID`), and a warning when a glob matches zero files on disk (`TASK_READS_NO_MATCH`).
- **In `task context`:** the pack gains a `## Declared read surface` section listing each glob and the set of currently-matched files. **File contents are not inlined** — only the path list. Richer rendering (e.g. inlining file bodies, sub-file ranges) is deferred to a future RFC.

### `writes`

- **In `plan lint`:** path-safety (`TASK_WRITES_UNSAFE_PATH`), glob syntax (`TASK_WRITES_GLOB_INVALID`), over-broad declared globs (`TASK_WRITES_OVER_BROAD` — v1.6 P15-T2; flags patterns whose root segment is `**` such as `**`, `**/*`, `**/*.ts`), and an advisory warning when the declared glob overlaps a protected path (`TASK_WRITES_PROTECTED_PATH`). The protected-path seed list (`.git/**`, `node_modules/**`, `.code-pact/**`, `design/roadmap.yaml`, `design/phases/*.yaml`) is the v1.1 default; v1.6 P15-T3 made it **configurable** via [`design/rules/protected-paths.md`](../../design/rules/protected-paths.md) — projects can extend or override the list without forking. The diagnostic code remains a warning by default.
- **`write_audit`** (v1.6 P15-T1+, `task finalize --json`): an advisory layer that compares declared `writes` globs against the actual working-tree diff (default) or branch-level merge-base (`--base-ref`). Emits `TASK_WRITES_AUDIT_OUTSIDE_DECLARED` when a touched file matches no declared glob, and `TASK_WRITES_AUDIT_DECLARED_UNUSED` (v1.6 P15-T4) when a declared glob matches zero touched files. Promote to exit-relevant with `task finalize --audit-strict --write --json`; in CI pair with `--base-ref <default-branch>` so the audit compares against the merge-base (otherwise a clean working tree fires `DECLARED_UNUSED` for every task that declared writes).
- **In `task context`:** the pack gains a `## Declared write surface` section listing each declared glob. **No filesystem lookup** because writes are by definition future-tense.

### `acceptance_refs`

- **In `plan lint`:** path-safety (`TASK_ACCEPTANCE_REF_UNSAFE_PATH`) and existence check (`TASK_ACCEPTANCE_REF_NOT_FOUND`).
- **In `task context`:** the pack gains a `## Acceptance references` section with the path list only. No content excerpt and no semantic validation in v1.1.0; richer rendering and reconcile-time validation are deferred to P11 (`task finalize` / `phase reconcile`).

## Supported glob subset

`reads` / `writes` use a minimal in-repo glob matcher. The supported subset is intentionally narrow because v1.1.0 keeps the runtime dependency policy from [`CONTRIBUTING.md`](../../CONTRIBUTING.md#runtime-dependency-policy) (`yaml` + `zod` only):

- literal path segments
- `*` within a single path segment (does **not** cross `/`)
- `**` as a **full** path segment only (matches zero or more segments)

Not supported: brace expansion (`{a,b}`), extglob (`@(...)` / `+(...)` / `*(...)` / `?(...)` / `!(...)`), negation (`!pattern`), character classes (`[abc]`), backslash escapes (`\*`). Patterns outside the subset fire `TASK_READS_GLOB_INVALID` / `TASK_WRITES_GLOB_INVALID`. Adopting an external glob library is a separate runtime-dependency RFC.

## Recommended adoption pattern

- **Declare on new tasks first.** Don't retroactively add the fields to every existing task — the lint surface tolerates absence, and exhaustive backfill is explicitly discouraged.
- **Start with `depends_on` and `decision_refs`.** These produce the most immediately useful effect on `task context`: a "Depends on" section with derived state and a "Declared decisions" section that pulls referenced decisions into the pack regardless of `context_size`.
- **Use `reads` / `writes` only when they are load-bearing.** v1.1.0 surfaces them but does not enforce them — value comes from documenting the surface, not from machine-checking it. P11 and P14 are where they start gating behaviour.
- **Skip `acceptance_refs` until you have a real acceptance criteria layout.** v1.1.0 ships path references only; the consumer is P11 reconcile.

## What is intentionally not in this release

- **Cross-phase `depends_on`** — same-phase only in v1.1.0.
- **File content inclusion for `reads`** — declaration-only in v1.1.0.
- **ID-based references for `decision_refs` / `acceptance_refs`** — path references only in v1.1.0.
- **Line-level acceptance references** — file-level only in v1.1.0.
- **`human_gate` field** — deferred to P12 runbook, where it has a behavioural hook.
- **Hard enforcement of protected-path `writes`** — advisory warning in v1.1.0; configurable governance is P14.

## See also

- [`design/decisions/task-readiness-schema-rfc.md`](../../design/decisions/task-readiness-schema-rfc.md) — full RFC with field semantics, validation rules, backward-compat contract, and the implementation slicing across P10-T1..T6.
- [`docs/migration.md` § v1.0.x → v1.1.0](../migration.md#v10x--v110) — upgrade walkthrough.
- [`docs/cli-contract.md` § `phase import`](../cli-contract.md#phase-import) — the phase-import schema reference, including the lenient-mode behaviour for the new fields.
- [`docs/cli-contract.md` § `task context`](../cli-contract.md#task-context--context-quality-gates-v051-v11-additions) — the pack's declared-sections reference.
- [`docs/cli-contract.md` § Plan diagnostic codes](../cli-contract.md#plan-diagnostic-codes) — the twelve new `TASK_*` lint codes.
