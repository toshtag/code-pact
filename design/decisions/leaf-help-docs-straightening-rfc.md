# RFC: Leaf help + docs straightening (P41)

**Status:** accepted (P41, 2026-05)
**Scope:** rich leaf `--help` for the 7 stubbed task lifecycle verbs behind a coverage test; consolidate the `record_only` lifecycle explanation to its one canonical home. No new docs page, no parser/help-generator abstraction.
**Owners:** maintainer
**Related:** [cli-command-spec-rfc](cli-command-spec-rfc.md) (later supersedes the hand-written `LEAF_USAGE` entries with a single `CommandSpec` source) · [doc-truth-from-code-rfc](doc-truth-from-code-rfc.md) · [stability-taxonomy](stability-taxonomy.md).

## Summary

code-pact's leaf `--help` was uneven: only 6 verbs had rich help; the rest fell back to a 2-line stub (`subcommandStub`). P41 brings the 7 stubbed **task lifecycle verbs** to parity behind a coverage test, and de-duplicates the `record_only` mode explanation (full-defined in 6 docs, so it drifted) down to its single canonical home — **without growing the docs set**.

## Decisions

1. **`--help` parity is limited to the 7 stubbed task verbs:** `add`, `context`, `start`, `status`, `block`, `resume`, `runbook`. *Rationale:* the plan / phase / adapter stubs are a separate, larger surface — widening here would turn P41 into a full CLI-surface redesign.
2. **`record_only` consolidates into the existing `docs/per-task-loop.md`** — the docs-role-map canonical home for the lifecycle. **No new concept page.** *Rationale:* the goal is reducing duplication, not adding docs. The docs-role-map mandates "do not re-define the lifecycle anywhere else."
3. **Aliases stay stubs** (`task next`, `task reconcile`). *Rationale:* `subcommandUsage` keys on the canonical name; the alias help would duplicate.

## Verified flag surfaces (the help text + coverage test must match THESE)

Read from `src/cli/commands/task.ts`, not assumed — the earlier draft list was wrong in places.

| Verb | Positional | Flags |
| --- | --- | --- |
| `add` | `<phase-id>` | `--description --type --ambiguity --risk --context-size --write-surface --verification-strength --expected-duration --depends-on(*) --decision-ref(*) --read(*) --write(*) --acceptance-ref(*) --id --json` |
| `context` | `<task-id>` | `--agent --json --explain --budget-bytes` |
| `start` | `<task-id>` | `--agent --json` |
| `status` | `<task-id>` | `--json` |
| `block` | `<task-id>` | `--agent --reason(required) --json` |
| `resume` | `<task-id>` | `--agent --json` |
| `runbook` | `<task-id>` | `--json` (alias `next`) |

`(*)` = repeatable. Behavioral facts the help prose must encode: `add`/`start`/`block`/`resume` append a progress event; `context`/`status`/`runbook` are read-only. `add` runs an interactive wizard when `--description` is omitted (TTY); `--type` is **required when `--description` is given**. `block` requires a non-empty `--reason`. `context` `--explain` prints a section-budget table; `--budget-bytes` caps the pack (`CONTEXT_OVER_BUDGET` on overflow).

`task add` is the exception to the "keep help short" rule (15 flags): the six sizing/readiness enums fold into ONE line that still shows all six flag names, with allowed values pointed to the task schema rather than inlined.

## `record_only` consolidation — per-location verdict

The lifecycle mode is the deterministic `type∈{docs,test} AND …` switch; its full definition belongs only in the canonical home. The 6 full-mentions (+ ja mirrors) classify as:

| Location | Verdict | Action |
| --- | --- | --- |
| `docs/per-task-loop.md` | canonical | KEEP (content unchanged) |
| `docs/cli-contract.md` record-done concept prose | concept-duplicate | LINK out; KEEP flags/exit/envelope |
| `docs/cli-contract.md` `lifecycleMode` **schema rule** | role-appropriate | KEEP (cli-contract's job — the deterministic switch) |
| `docs/agent-contract.md` "two uses / lighter loop" prose | concept-duplicate | LINK out; KEEP agent-specific facts (gate still applies; distinct path) + the conformance-table `record_only` token |
| `docs/glossary.md` term def | role-appropriate | KEEP |
| `CLAUDE.md` template | generated + conformance-load-bearing | KEEP (do not edit) |

Default target: exactly 2 files change (cli-contract, agent-contract) — a per-block, role-based judgment, not a count: link out only the *duplicated lifecycle explanation*; keep role-specific content. New links use the relative `per-task-loop.md#<anchor>` form; the heading slug has backticks/`--`, so verify the exact GitHub anchor against an existing intra-docs link (`check:doc-links` hard-fails a wrong slug).

**JA:** `docs/ja/per-task-loop.md` stays JA-canonical; the two edited files are English-only reference contracts (not mirrored), so no JA edit is planned — a *material* JA/EN contradiction is recorded as a follow-up, not a JA rewrite under P41.

## Alternatives / non-goals (rejected or deferred)

- **Rich `--help` for plan / phase / adapter stubs or top-level commands** — deferred; a later task, to keep P41 from becoming a CLI-surface redesign.
- **A CLI parser / help-generator abstraction** — rejected for P41; 7 hand-written `LEAF_USAGE` entries are enough. *(Later picked up by [cli-command-spec-rfc](cli-command-spec-rfc.md), which derives parse + help + reference from one `CommandSpec`.)*
- **A new `record_only` concept page** — rejected; the point was to remove duplication, not add a doc.
- **Any JA rewrite** — rejected; the edited files are English-only reference contracts.

## References

- RFCs: [cli-command-spec-rfc](cli-command-spec-rfc.md) · [doc-truth-from-code-rfc](doc-truth-from-code-rfc.md) · [stability-taxonomy](stability-taxonomy.md).
- Code: `src/cli/usage.ts` (`subcommandStub`, `LEAF_USAGE`, `subcommandUsage`) · `src/cli/commands/task.ts` (the verified flag surfaces).
- Docs: [docs/per-task-loop.md](../../docs/per-task-loop.md) (canonical lifecycle home) · [docs/cli-contract.md](../../docs/cli-contract.md) · [docs/agent-contract.md](../../docs/agent-contract.md).
