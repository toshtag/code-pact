# RFC: Task Readiness Schema

**Status:** accepted (P10, 2026-05)
**Scope:** task schema in `src/core/schemas/task.ts` and dependent surfaces (plan lint, task context pack, `docs/cli-contract.md`)
**Owners:** maintainer
**Related:** [design/phases/P5-planning-integrity.yaml § non_goals](../phases/P5-planning-integrity.yaml) (deferred "Plan Readiness Schema RFC" — superseded by this document) · downstream consumers: [finalization-reconciliation](finalization-reconciliation-rfc.md) (P11 — reads `writes` / `acceptance_refs` / `depends_on`) · [lightweight-runbook](lightweight-runbook-rfc.md) (P12) · [governance](governance-rfc.md) (P14 — promotes `TASK_WRITES_PROTECTED_PATH`).

## Summary

Adds **five optional task fields** — `depends_on`, `decision_refs`, `reads`, `writes`, `acceptance_refs` — so a task declares its own dependencies and surfaces instead of relying only on the coarse `context_size` / `ambiguity` / `write_surface` heuristics. Each field gets deterministic `plan lint` validation and is surfaced in the `task context` pack. All fields are `.optional()`; a task that declares none produces byte-identical pack output to v1.0.2. Stable-compatible — v1.1.0 in semver. Agent-facing walkthrough: [docs/concepts/task-readiness-fields.md](../../docs/concepts/task-readiness-fields.md).

## Field semantics

All five are optional arrays of repo-root-relative strings, additive to the existing task type.

- **`depends_on`** — task id strings. **Same-phase only** in P10 (cross-phase deferred). Declarative: "should not start until the referenced tasks are `done`". Not runtime-enforced — `task start` does not refuse; the declaration drives docs, lint, and pack surfacing. Runtime enforcement is a P12 runbook candidate.
- **`decision_refs`** — path strings (convention: `design/decisions/`). "Read these decision files as part of context." Surfaced **regardless of `context_size`**, rendered with the same full-content path as the `context_size: large` `allDecisions` branch — no truncation or budget shaping in P10 (truncation policy is a future RFC). Validated for path safety (`assertSafeRelativePath`) and existence.
- **`reads`** — glob strings. "Expected to read files matching these globs." Pack surfaces the declared paths as a section; **contents are not inlined** (declaration-only in P10). Validated for glob syntax + path safety; zero matches is a warning, not an error.
- **`writes`** — glob strings. "Expected to write files matching these globs." Future P11 `task finalize` uses it to detect out-of-surface writes; P14 governance enforces protected paths against it. Validated for glob syntax + path safety; **existence is not checked** (writes are future-tense).
- **`acceptance_refs`** — path strings. "Completion is judged against the criteria in these files." Path references only in P10 (an `id` scheme into `definition_of_done` is deferred). Validated for path safety + existence.
- **`human_gate`** — **not introduced.** The P12 runbook RFC owns its design.

### Supported glob subset (P10)

P10 introduces **no runtime glob dependency** (runtime deps stay `yaml` + `zod` per CONTRIBUTING.md). `reads` / `writes` therefore accept a narrow shape, matched by an in-repo matcher over `node:fs/promises` `readdir`:

- literal path segments (e.g. `src/commands/init.ts`)
- `*` within a single path segment (e.g. `src/commands/task-*.ts`)
- `**` as a full path segment only (e.g. `tests/**/*.test.ts`)

**Not supported:** brace expansion (`{a,b}`), extglob (`@(...)`/`+(...)`/`*(...)`), negation (`!pattern`), character classes (`[abc]`). Syntax outside the subset fires `TASK_READS_GLOB_INVALID` / `TASK_WRITES_GLOB_INVALID`. Adopting a glob library (`picomatch` etc.) if the subset proves too narrow is a separate runtime-dependency RFC.

### Protected path seed set (P10, advisory only)

A declared `writes` matching any built-in seed pattern fires `TASK_WRITES_PROTECTED_PATH` as a **warning**:

- `.git/**`
- `node_modules/**`
- `.code-pact/**`
- `design/roadmap.yaml`
- `design/phases/*.yaml`

Intentionally narrow. P14 governance may replace it with a configurable policy and promote the code to error severity. Tasks that legitimately write `design/phases/*.yaml` (dogfood / release-prep, pre-P11) see the warning by design — it flags that future P11 `task finalize` moves those mutations behind a dedicated command.

## Validation rules (plan lint)

Twelve additive lint codes in the `plan` category. No existing code changes name or severity; `KNOWN_CODES.plan` and the `docs/cli-contract.md` Plan diagnostic table are extended.

| Code | Severity | Trigger |
| --- | --- | --- |
| `TASK_DEPENDS_ON_UNRESOLVED` | error | reference to a task id not in the same phase |
| `TASK_DEPENDS_ON_SELF_REFERENCE` | error | task references itself in `depends_on` |
| `TASK_DECISION_REF_NOT_FOUND` | error | referenced decision file does not exist |
| `TASK_DECISION_REF_UNSAFE_PATH` | error | `assertSafeRelativePath` violation |
| `TASK_READS_UNSAFE_PATH` | error | path safety violation |
| `TASK_READS_GLOB_INVALID` | error | glob syntax outside the supported subset |
| `TASK_READS_NO_MATCH` | warning | declared glob matches zero files on disk |
| `TASK_WRITES_UNSAFE_PATH` | error | path safety violation |
| `TASK_WRITES_GLOB_INVALID` | error | glob syntax outside the supported subset |
| `TASK_WRITES_PROTECTED_PATH` | warning (P10) / error (P14) | write declared against a protected path |
| `TASK_ACCEPTANCE_REF_NOT_FOUND` | error | referenced acceptance file does not exist |
| `TASK_ACCEPTANCE_REF_UNSAFE_PATH` | error | path safety violation |

## Context packing behaviour

When any new field is present, `task context <id>` appends sections after the existing Phase Contract / Task Definition sections, in this order:

1. **Depends on** — dependency task ids with their derived state (`planned`/`started`/`blocked`/`done`/…) from `progress.yaml`.
2. **Declared read surface** — `reads` globs with the currently-matched files under each.
3. **Declared write surface** — `writes` globs.
4. **Declared decisions** — full content of `decision_refs` files, under each filename.
5. **Acceptance references** — `acceptance_refs` paths only (no excerpt, no semantic validation in P10; richer rendering deferred to P11).

`decision_refs` **adds to** — does not replace — the `context_size: large` `allDecisions` path; the existing `context_size`/`ambiguity`/`write_surface` heuristics are unchanged.

## Backward compatibility

This is a Stable (v1.0) compatible release (v1.1.0).

- All five fields are `.optional()`; existing v1.0.x phase YAMLs parse unchanged. `applyTaskDefaults` does **not** synthesize defaults — absent fields stay `undefined`.
- `phase import` lenient mode accepts both old YAML and any subset of the new fields.
- `task context` output is **byte-identical** for tasks declaring none of the new fields — locked by a checked-in golden-file regression test (excluding environment-dependent metadata like absolute paths / timestamps).
- No existing error code is renamed, removed, or changed in severity; all 12 codes are additive. JSON envelope `{ ok, data, error? }` is unchanged; every Stable command still passes `json-stdout`.
- **Adoption is opt-in:** declare the fields on new tasks; backfilling existing tasks is explicitly discouraged. A project that does not adopt sees zero new warnings under `plan lint --strict`.

## Alternatives considered

- **Required new fields** — rejected; breaks every v1.0.x project, disallowed in a minor release under the v1.0 freeze.
- **Cross-phase `depends_on` in P10** — rejected; cross-phase cycle detection needs graph analysis out of scope. Field surface reserved for a future extension.
- **File-content inclusion for `reads` in P10** — rejected; size/safety/budget interactions need their own RFC. Declaration-only now; content can be added later without breaking semantics.
- **ID-based `decision_refs` / `acceptance_refs`** — rejected; requires a structured `definition_of_done` with stable ids — a meaningful schema change of its own. Path references suffice for P10.
- **Introduce `human_gate` in P10** — rejected; no behavioural hook until P12 runbook. A field with no use surface invites a confusing P12 rename.
- **Glob-library runtime dependency** — rejected; CONTRIBUTING.md limits runtime deps to `yaml` + `zod` without an explicit RFC. An in-repo matcher covers the expected `**`/`*`/literal shapes; `picomatch` is a separate dependency RFC.
- **Hard enforcement of `writes` in P10** — rejected; requires integration with the write surface across every command — the substance of P14 governance. P10 establishes the declarative side only.

## Open questions

1. **`TASK_READS_NO_MATCH` severity** — ships as warning; demote to `hidden_by_default` if noisy, promote to error if typos slip through. Revisit in P11/P12.
2. **Pack section order** — chosen order keeps metadata at top and bulk content (decisions) below; decisions-first is a defensible alternative.
3. **`phase reconcile` integration** — P11 reads `acceptance_refs`; the exact "present" semantic (exists vs modified vs references a specific id) is deferred to the P11 RFC.
4. **Cross-phase dependency UX** — deferred; informal cross-phase deps in `description` are the signal to upgrade the field.
5. **`roadmap.yaml` phase-level `depends_on`** — out of scope; this RFC is task-level only. Phase ordering is already the linear roadmap; explicit phase deps would be a separate RFC.

(The v1.1.0 dist-tag choice is a release-policy question for the P10 release-prep PR, not a design question for this RFC.)

## References

- [design/phases/P5-planning-integrity.yaml § non_goals](../phases/P5-planning-integrity.yaml) — the deferred Plan Readiness Schema RFC this document supersedes.
- Code: [src/core/schemas/task.ts](../../src/core/schemas/task.ts) (schema extension point) · [src/core/pack/index.ts](../../src/core/pack/index.ts) (context-pack path) · [src/core/plan/checks.ts](../../src/core/plan/checks.ts) + [src/core/plan/lint.ts](../../src/core/plan/lint.ts) (lint detectors) · [tests/unit/error-code-surface.test.ts](../../tests/unit/error-code-surface.test.ts) (error-code surface contract).
- Docs: [docs/cli-contract.md](../../docs/cli-contract.md) · [docs/migration.md](../../docs/migration.md) · [docs/concepts/task-readiness-fields.md](../../docs/concepts/task-readiness-fields.md) · [stability-taxonomy](stability-taxonomy.md) (the v1.0 contract this RFC operates under).
