# RFC: Leaf help + docs straightening (P41)

- Status: accepted
- Phase: P41
- Date: 2026-05-31

## Problem

Agents use `--help` as an exploration surface, but code-pact's leaf help is
uneven: only 6 leaf commands have rich help (`task prepare`/`complete`/
`record-done`/`finalize`, `plan prompt`, `phase import`); the rest fall back to a
2-line stub (`subcommandStub` in `src/cli/usage.ts`). The 1.26.0 feedback flagged
`task add --help` as a stub while `task complete --help` is rich.

Separately, the `record_only` lifecycle mode is explained in **full** in 6
different docs, so the explanations drift (the recurring docs-drift pain from
P39/P43).

P41 (backlog "cheap fill", next after P43) fixes both, **without growing the docs
set** — it brings the task lifecycle verbs' `--help` to parity behind a coverage
test, and consolidates the `record_only` explanation to its one canonical home.

## Scope (maintainer-approved)

- **`--help` parity is limited to the 7 stubbed task lifecycle verbs:** `add`,
  `context`, `start`, `status`, `block`, `resume`, `runbook`. The plan / phase /
  adapter stubs are left to a later task — widening here would turn P41 into a
  full CLI-surface redesign.
- **`record_only` consolidates into the existing `docs/per-task-loop.md`** (the
  docs-role-map canonical home for the lifecycle); **no new concept page** —
  reducing duplication, not adding docs.

## Verified flag surfaces (read from `src/cli/commands/task.ts`, not assumed)

The earlier draft list was wrong in places; these are the verified surfaces (the
help text and the coverage test must match THESE):

| Verb | Positional | Flags |
| --- | --- | --- |
| `add` | `<phase-id>` | `--description --type --ambiguity --risk --context-size --write-surface --verification-strength --expected-duration --depends-on(*) --decision-ref(*) --read(*) --write(*) --acceptance-ref(*) --id --json` |
| `context` | `<task-id>` | `--agent --json --explain --budget-bytes` |
| `start` | `<task-id>` | `--agent --json` |
| `status` | `<task-id>` | `--json` |
| `block` | `<task-id>` | `--agent --reason(required) --json` |
| `resume` | `<task-id>` | `--agent --json` |
| `runbook` | `<task-id>` | `--json` (alias `next`) |

`(*)` = repeatable. Behavioral facts to encode in prose: `add`/`start`/`block`/
`resume` append a progress event; `context`/`status`/`runbook` are read-only.
`add` runs an interactive wizard when `--description` is omitted (TTY); `--type`
is **required when `--description` is given**. `block` requires a non-empty
`--reason`. `context` `--explain` prints a section-budget table; `--budget-bytes`
caps the pack (`CONTEXT_OVER_BUDGET` on overflow).

## Design

### Rich help (`src/cli/usage.ts`)

Add 7 `LEAF_USAGE` entries (after `phase import`), each mirroring the
`task complete` shape: Usage line; blank; 2-4 sentence description with
cross-refs; blank; `Options:` (2-space-indented `--flag <type>  desc`); blank;
`Examples:`. Dispatch already calls `subcommandUsage`, so no other source change.

**Length:** avoid bloat — for most verbs keep ≤ `task complete`. **`task add` is
the exception** (15 flags): do not mechanically truncate it. Group it — list the
non-interactive essentials and each repeatable scope flag individually, and fold
the six sizing/readiness enums into ONE line that still shows all six flag names
(`--ambiguity, --risk, --context-size, --write-surface, --verification-strength,
--expected-duration  Optional sizing/readiness fields; see the task schema for
allowed values`). Never inline each enum's allowed values.

### Help-coverage test (both layers)

- **Unit** (`tests/unit/cli/task-lifecycle-help-terms.test.ts`, new — sibling of
  the P38-T3 `record-done-help-terms.test.ts`): import `subcommandUsage`, an
  `it.each` per-verb required-term table for all 11 rich task verbs (the 7 new +
  prepare/complete/record-done/finalize). Assert the `Usage:` line, each
  documented flag token, a purpose phrase, and that help ≠ the stub second line.
  Pin `task add` **thickly** (`<phase-id>`, all repeatable + essential flags,
  `interactive`/`wizard`, `requires --type`), `block` (`--reason` + `required`),
  `context` (`--budget-bytes` + `--explain`) — guarding the help-vs-real-flags
  drift the coverage test can't auto-detect.
- **Integration** (`tests/integration/cli-help.test.ts`): add the 7 verbs to the
  `RICH_LEAF_HELP` table; the existing spawn loop then checks Usage + a flag +
  `Examples:` through the built CLI.

### `record_only` consolidation

Canonical home stays `docs/per-task-loop.md` (the docs-role-map mandates "do not
re-define the lifecycle anywhere else"). **Default target: exactly 2 files change
(cli-contract, agent-contract)** — a per-block, role-based judgment, not a count:
link out only the *duplicated lifecycle explanation*; keep role-specific content.

Classification of the 6 full-mentions (+ ja mirrors):

| Location | Verdict | Action |
| --- | --- | --- |
| `docs/per-task-loop.md` | canonical | KEEP (content unchanged; minimal anchor clarification allowed if the link target is unclear) |
| `docs/cli-contract.md` record-done section (concept prose) | concept-duplicate | LINK out; KEEP flags/exit/envelope |
| `docs/cli-contract.md` lifecycleMode **schema rule** | role-appropriate | KEEP (cli-contract's job — the deterministic `type∈{docs,test} AND …` switch) |
| `docs/agent-contract.md` "two uses / lighter loop" prose | concept-duplicate | LINK out; KEEP agent-specific facts (gate still applies; distinct path) + the conformance-table `record_only` token |
| `docs/glossary.md` term def | role-appropriate | KEEP |
| `CLAUDE.md` template | generated + conformance-load-bearing | KEEP (do not edit) |

Brief mentions in troubleshooting/positioning/dogfood/README stay. **JA:**
`docs/ja/per-task-loop.md` stays JA-canonical; the two edited files are
English-only reference contracts (not mirrored), so **no JA edit is planned** —
if a *material* JA/EN contradiction surfaces, record a follow-up, do not expand
P41 into a JA rewrite.

New links use the relative `per-task-loop.md#<anchor>` form; the heading slug has
backticks/`--`, so verify the exact GitHub anchor against an existing intra-docs
link (`check:doc-links` hard-fails a wrong slug).

## Documentation contract checklist (the P39/P43 anti-drift guard)

- **T1** writes: `src/cli/usage.ts`, `tests/unit/cli/task-lifecycle-help-terms.test.ts`,
  `tests/integration/cli-help.test.ts`, `CHANGELOG.md`. (No public-doc prose
  change — help text lives in source.)
- **T2** writes: `docs/cli-contract.md`, `docs/agent-contract.md`, `CHANGELOG.md`
  (+ `docs/per-task-loop.md` only if a minimal anchor clarification is needed —
  if touched, it MUST be added to `writes`).
- Because T2 writes public docs, the phase verification MUST include
  `pnpm check:docs` (else the P43 `PHASE_DOCS_WRITE_NO_DOC_CHECK` guard fires
  while the phase is not-`done`).

## Non-goals

- Rich `--help` for plan / phase / adapter stubs, or for top-level commands
  (`init`/`verify`/…) — a later task.
- Rich help for command **aliases** (`task next`, `task reconcile`) — they stay
  stubs; `subcommandUsage` keys on the canonical name.
- Any new docs page; any JA rewrite; any CLI parser/help-generator abstraction
  (7 hand-written `LEAF_USAGE` entries are enough).

## Tasks

- **P41-T0** — this RFC + phase registration (bootstrap).
- **P41-T1** — rich help for the 7 task verbs + the unit & integration
  help-coverage tests.
- **P41-T2** — `record_only` consolidation (link out the 2 concept-duplicates).
