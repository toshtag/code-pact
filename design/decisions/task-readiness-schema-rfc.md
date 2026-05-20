# RFC: Task Readiness Schema

**Status:** proposed (P10, 2026-05)
**Scope:** task schema in src/core/schemas/task.ts and dependent surfaces (plan lint, task context pack, docs/cli-contract.md)
**Owners:** maintainer
**Related:** [design/phases/P5-planning-integrity.yaml § non_goals](../phases/P5-planning-integrity.yaml) (deferred "Plan Readiness Schema RFC" — superseded by this document)

## Status lifecycle

- This document opens at status **proposed** in PR1.
- After review approval, and **before** PR1 merges, the maintainer flips the status line at the top of this file to **accepted**.
- P10-T1 (RFC acceptance) is considered done only after PR1 — with the status line reading `accepted` — has landed on main.
- Subsequent implementation PRs (P10-T2..T6) treat the accepted document as load-bearing. They may not change RFC decisions without a separate RFC-update PR.

## Background

`code-pact` v1.0 ships a task schema with 8 required + 2 optional fields (`id`, `type`, `ambiguity`, `risk`, `context_size`, `write_surface`, `verification_strength`, `expected_duration`, `status`, `description?`, `requires_decision?`). The context pack in `src/core/pack/index.ts` uses `context_size` / `ambiguity` / `write_surface` as attribute-based heuristics to decide which design artifacts (constitution, decisions, rules, done events) to surface.

That works for v1.0 but ceilings out quickly: a task cannot say *which specific decision to read*, *which file it touches*, or *what it depends on*. The heuristic gives the agent more or less context based on coarse labels, not the actual surface the task operates on.

P5 (Planning Integrity) explicitly deferred "schema expansion (non_goals / dependencies / touched_paths / decision_refs)" to a later RFC. This document is that RFC, scoped slightly wider than the P5 deferred name suggests: it covers context-pack target references, read/write surface declaration, and acceptance references, in addition to dependencies.

## Problem statement

1. `task context` cannot distinguish between two tasks with the same `context_size` / `ambiguity` / `write_surface` that nevertheless need different decisions and rules surfaced.
2. There is no declarative surface for inter-task ordering or for recording what files a task is expected to read or write.
3. P11 `task finalize` / `phase reconcile` (future) needs a machine-readable acceptance reference to decide whether a task's `done` event is consistent with the documented criteria.
4. P14 governance (future) needs a declared write surface to detect when a task wrote outside what it was supposed to touch.

All four want the same underlying primitive: a task that declares its own dependencies and surfaces, additively to the existing schema.

## Goals

- Add five optional fields to the task schema: `depends_on`, `decision_refs`, `reads`, `writes`, `acceptance_refs`.
- Provide deterministic plan lint validation for each new field.
- Wire the new fields into `task context` so declared references are surfaced in the pack.
- Preserve byte-identical `task context` output for tasks that do not declare any of the new fields (full v1.0.2 compatibility).
- Provide a migration story for projects that want to adopt the new fields incrementally.

## Non-goals

- Making any new field required.
- Cross-phase `depends_on`. P10 ships same-phase only.
- ID-based references for `decision_refs` / `acceptance_refs`. Path references only in P10.
- Line-level acceptance references. File-level only.
- File content inclusion for `reads`. Declaration-only in P10.
- Introducing `human_gate`. P12 RFC owns that field's design.
- Hard enforcement of protected-path writes. P14 owns that policy.
- Any change to Stable (v1.0) flags, exit codes, JSON envelope shape, or existing error codes.
- LLM API calls, RAG, MCP, issue-tracker integration, multi-agent orchestration, adapter breadth (all excluded from v1.x).

## Proposed schema

Adds five optional fields to the task type. Pseudocode:

```ts
const Task = z.object({
  // ... existing required and optional fields unchanged
  depends_on: z.array(z.string()).optional(),
  decision_refs: z.array(z.string()).optional(),
  reads: z.array(z.string()).optional(),
  writes: z.array(z.string()).optional(),
  acceptance_refs: z.array(z.string()).optional(),
});
```

## Field semantics

### `depends_on`

- Element type: task id string.
- Scope: must reference a task in the **same phase**. Cross-phase references are deferred to a future extension.
- Semantic: "this task should not start until the referenced tasks are `done`". P10 does not enforce ordering at runtime — `task start` does not refuse to run if a dependency is incomplete. The declaration is for documentation, lint validation, and pack surfacing. Enforcement is a candidate for P12 runbook.

### `decision_refs`

- Element type: repo-root-relative path string. Convention: paths start with `design/decisions/`.
- Semantic: "the agent should read these decision files as part of task context". Surfaced in the pack regardless of `context_size`.
- Validation: path must be safe (`assertSafeRelativePath`) and the file must exist.
- Size / budget policy: declared decisions are rendered with the same content path as the existing `context_size: large` `allDecisions` branch. No truncation, line cap, or budget shaping is introduced in P10. If decision files grow large enough to cause budget pressure in the agent loop, truncation policy is a future RFC, not a P10 concern.

### `reads`

- Element type: repo-root-relative glob string.
- Semantic: "this task is expected to read files matching these globs". In P10 the pack surfaces the declared paths as a section; file contents are not inlined.
- Validation: glob syntax must be valid; paths resolved by the glob must be safe; at least one file should match (warning if zero matches).

### `writes`

- Element type: repo-root-relative glob string.
- Semantic: "this task is expected to write files matching these globs". Future P11 `task finalize` can use this to detect writes outside the declared surface; future P14 governance can enforce protected paths against it.
- Validation: glob syntax must be valid; path safety must hold. Existence is **not** checked because writes are by definition future-tense.
- **Protected path seed set (P10, advisory only).** A declared write matching any pattern in the following built-in seed set fires `TASK_WRITES_PROTECTED_PATH` as a warning:

  - `.git/**`
  - `node_modules/**`
  - `.code-pact/**`
  - `design/roadmap.yaml`
  - `design/phases/*.yaml`

  The set is intentionally narrow and advisory in P10. P14 governance may replace it with a configurable policy and promote `TASK_WRITES_PROTECTED_PATH` to error severity. Tasks that legitimately need to write `design/phases/*.yaml` (typically dogfood / release-prep tasks before P11 `task finalize` exists) see the warning by design — it surfaces the fact that future P11 will move those mutations behind a dedicated command.

### `acceptance_refs`

- Element type: repo-root-relative path string.
- Semantic: "task completion is judged against the criteria in these files". P10 ships path references only; an `id` reference scheme into `definition_of_done` items is deferred.
- Validation: path safety; file must exist.

### `human_gate` (deferred)

Not introduced in P10. P12 runbook RFC owns this field's design.

### Supported glob subset (P10)

`reads` and `writes` use repo-root-relative glob strings. Because P10 does not introduce a runtime dependency for glob matching (the project's runtime-dependency policy in CONTRIBUTING.md limits runtime deps to `yaml` and `zod`), the supported glob shape is intentionally narrow:

- literal path segments (e.g. `src/commands/init.ts`)
- `*` within a single path segment (e.g. `src/commands/task-*.ts`)
- `**` as a full path segment only (e.g. `tests/**/*.test.ts`)

Not supported in P10:

- brace expansion (`{a,b}`)
- extglob (`@(...)`, `+(...)`, `*(...)`)
- negation (`!pattern`)
- character classes (`[abc]`)

`TASK_READS_GLOB_INVALID` / `TASK_WRITES_GLOB_INVALID` fire when a declared glob uses syntax outside the supported subset. If real usage shows the subset is too narrow, adopting a glob library (`picomatch` etc.) is a separate runtime-dependency RFC.

## Validation rules (plan lint)

Twelve additive lint codes in the `plan` category:

| Code | Severity | Trigger |
| --- | --- | --- |
| `TASK_DEPENDS_ON_UNRESOLVED` | error | reference to a task id not in the same phase |
| `TASK_DEPENDS_ON_SELF_REFERENCE` | error | task references itself in `depends_on` |
| `TASK_DECISION_REF_NOT_FOUND` | error | referenced decision file does not exist |
| `TASK_DECISION_REF_UNSAFE_PATH` | error | `assertSafeRelativePath` violation |
| `TASK_READS_UNSAFE_PATH` | error | path safety violation |
| `TASK_READS_GLOB_INVALID` | error | glob syntax invalid |
| `TASK_READS_NO_MATCH` | warning | declared glob matches zero files on disk |
| `TASK_WRITES_UNSAFE_PATH` | error | path safety violation |
| `TASK_WRITES_GLOB_INVALID` | error | glob syntax invalid |
| `TASK_WRITES_PROTECTED_PATH` | warning (P10) / error (P14) | write declared against a protected path |
| `TASK_ACCEPTANCE_REF_NOT_FOUND` | error | referenced acceptance file does not exist |
| `TASK_ACCEPTANCE_REF_UNSAFE_PATH` | error | path safety violation |

All codes are additive. No existing code changes name or severity. `KNOWN_CODES.plan` in `tests/unit/error-code-surface.test.ts` is extended; the docs/cli-contract.md Plan diagnostic codes table is updated; unit tests are added under `tests/unit/core/plan/checks.test.ts`.

## Context packing behaviour

When any of the new fields are present on a task, the pack rendered by `task context <id>` includes additional sections after the existing Phase Contract / Task Definition sections, in this order:

1. **Depends on** — list of dependency task ids with their current derived state (`planned` / `started` / `blocked` / `done` / etc.) computed from `progress.yaml`.
2. **Declared read surface** — list of `reads` glob entries with the set of currently-matched files under each.
3. **Declared write surface** — list of `writes` glob entries.
4. **Declared decisions** — full content of files referenced by `decision_refs`, inserted under each filename.
5. **Acceptance references** — list of `acceptance_refs` paths only. No content excerpt and no semantic validation in P10; richer rendering and reconcile-time validation are deferred to P11.

When **none** of the new fields are declared, the pack body is byte-identical to v1.0.2. "Byte-identical" here is scoped: the markdown rendered by `src/core/pack/formatters/markdown.ts` for a frozen task fixture matches a checked-in golden file, excluding any environment-dependent metadata (absolute paths, timestamps, or version strings if any are introduced in future). A regression test under `tests/integration/` enforces this against the golden file.

The existing context_size / ambiguity / write_surface heuristics continue to operate as before. `decision_refs` adds to, does not replace, the `context_size: large` `allDecisions` path.

## Backward compatibility

- All new fields are `.optional()`.
- Existing v1.0.x phase YAMLs parse unchanged.
- `phase import` lenient mode accepts old YAML (no new fields) and new YAML (any subset of new fields). `applyTaskDefaults` does not fill the new fields with synthetic defaults — optional fields remain `undefined` when absent.
- `task context` output is byte-identical for tasks with none of the new fields declared (locked by regression test).
- No existing error code is renamed, removed, or changed in severity. All 12 new codes are additive in the `plan` category.
- JSON envelope shape (`{ ok, data, error? }`) is unchanged.
- `tests/integration/json-stdout.test.ts` continues to pass against every Stable (v1.0) command.

This is a Stable (v1.0) compatible release — v1.1.0 in semver terms.

## Migration story

Target: existing projects upgrading from v1.0.x to v1.1.0.

- **No required action.** All v1.0.x projects continue to work unchanged because all new fields are optional.
- **Recommended adoption pattern.** Start declaring new fields on **new** tasks. Leave existing tasks alone unless you have a concrete reason to retro-declare. Full backfill is not necessary and is explicitly discouraged as "exhaustive backfill".
- **CI under `--strict`.** Projects running `plan lint --strict` do not see new errors unless their tasks already declare the new fields with invalid values (`TASK_READS_GLOB_INVALID` etc.). A project that does not adopt the new fields sees zero new warnings.
- **Docs.** `docs/migration.md` gains a `v1.0.x → v1.1.0` section documenting the additive change and the adoption pattern.

## Alternatives considered

- **Required new fields.** Rejected. Breaks every v1.0.x project. v1.0 contract freeze does not permit this in a minor release.
- **Cross-phase `depends_on` in P10.** Rejected. Cycle detection across phases needs a graph analysis that is out of scope. The field surface is reserved for a future extension.
- **File content inclusion for `reads` in P10.** Rejected. Size limits, safety, and budget interaction need their own RFC. Start with declaration-only; the file content path can be added later without breaking the declaration semantics.
- **ID-based `decision_refs` / `acceptance_refs` in P10.** Rejected. Requires extending `definition_of_done` to a structured form with stable ids, which is a meaningful schema change in its own right. Path references are sufficient for P10.
- **Introduce `human_gate` in P10.** Rejected. No behavioural hook in P10 — runbook (`task run` / `phase close`) is P12. Adding a field with no use surface invites a rename in P12 that would be technically additive but practically confusing.
- **Glob library dependency.** Rejected. CONTRIBUTING.md `Runtime dependency policy` limits runtime deps to `yaml` and `zod` without an explicit RFC. A minimal in-repo glob matcher using `node:fs/promises` `readdir` is sufficient for the expected glob shapes (`**` / `*` / literal segments). If real usage shows more complex patterns are needed, the question of adding `picomatch` etc. is a separate dependency RFC.
- **Hard enforcement of `writes` declaration in P10.** Rejected. Would require integration with the file-system write surface across every `code-pact` command, which is the substance of P14 governance. P10 establishes the declarative side only; enforcement lands in P14.

## Open questions

1. **`TASK_READS_NO_MATCH` severity.** Currently proposed as warning. If dogfood shows it is too noisy (developer adds a `reads` entry intending to create the file later), it can be demoted to a `hidden_by_default` warning in a follow-up. If it is too lax (typos slip through), it can be promoted to error. P10 ships as warning; revisit in P11 / P12 based on experience.
2. **Default surface order in the pack.** The pack section order chosen above (Depends on → reads → writes → decisions → acceptance) is one defensible choice; another is to put decisions first because they are content-bearing. P10 picks the chosen order to keep the metadata together at the top and the bulk content (decisions) below.
3. **`phase reconcile` integration.** P11 will read `acceptance_refs` to validate that the documented acceptance points are present in the proposed `done` state. The exact semantic of "present" (file exists vs file modified vs file references a specific id) is deferred to P11 RFC.
4. **Cross-phase dependency UX.** Deferred. If projects start informally encoding cross-phase deps in `description`, that is the signal that a future RFC needs to upgrade the field.
5. **`roadmap.yaml` phase-level `depends_on`.** Out of scope for P10. This RFC concerns task-level only. Phase-level ordering is already expressed by the linear roadmap entries; if a real need for explicit phase dependencies emerges, it is a separate RFC.
6. **v1.1.0 dist-tag.** Proposed: plain `latest`, same as v1.0.x. Confirmed at release time of P10 implementation, not in this RFC.

## Implementation slicing

This RFC, once accepted, is followed by five implementation PRs:

| PR | Scope |
| --- | --- |
| **P10-T1 (this RFC PR)** | RFC + design/phases/P10 + roadmap entry. **No src/ changes.** |
| **P10-T2** | Schema extension in `src/core/schemas/task.ts`, lenient mode adjustment in `src/commands/phase-import.ts`. Unit tests proving existing v1.0.x fixtures still parse. |
| **P10-T3** | 12 lint detectors in `src/core/plan/checks.ts`, registration in `src/core/plan/lint.ts`, `KNOWN_CODES` expansion, `docs/cli-contract.md` table expansion, 12 unit tests. As part of this PR, promote `assertSafeRelativePath` / `resolveWithinProject` from `src/core/adapters/file-state.ts` to a neutral module (`src/core/path-safety.ts`) and re-export from the adapter file so existing call sites stay untouched. Plan lint, future P11 finalize, and P14 governance all import from the neutral module. |
| **P10-T4** | Context pack behaviour in `src/core/pack/index.ts` and `src/core/pack/formatters/markdown.ts`. Byte-identical regression test for v1.0.2-shaped tasks. |
| **P10-T5** | Migration docs (`docs/migration.md`), getting-started example, cli-contract Task schema table. |
| **P10-T6** | Dogfood adoption: small set of existing phase YAMLs in this repo declare new fields. Self-validate end-to-end. |

## References

- [design/phases/P5-planning-integrity.yaml § non_goals](../phases/P5-planning-integrity.yaml) — the deferred Plan Readiness Schema RFC that this document supersedes
- [src/core/schemas/task.ts](../../src/core/schemas/task.ts) — the schema extension point
- [src/core/pack/index.ts](../../src/core/pack/index.ts) — the context-pack code path
- [src/core/plan/checks.ts](../../src/core/plan/checks.ts) and [src/core/plan/lint.ts](../../src/core/plan/lint.ts) — the lint detector registration
- [tests/unit/error-code-surface.test.ts](../../tests/unit/error-code-surface.test.ts) — the error-code surface contract
- [docs/cli-contract.md](../../docs/cli-contract.md) — the public surface this RFC must not break
- [docs/migration.md](../../docs/migration.md) — destination for the v1.0.x → v1.1.0 section
- [design/decisions/stability-taxonomy.md](stability-taxonomy.md) — the v1.0 contract this RFC operates under
