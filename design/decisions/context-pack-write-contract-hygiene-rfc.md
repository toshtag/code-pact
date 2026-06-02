# RFC: Context-pack write contract hygiene (P45)

- Status: accepted
- Phase: P45
- Date: 2026-06-02

## Summary

The context pack is part of code-pact's deterministic agent-facing artifact
surface, so the disk write that produces it should use the same atomic
primitive (`atomicWriteText`) as every other code-pact write. It did not — it
used a raw `writeFile`. This is a patch-level (v1.29.1) contract-hygiene change:
align the implementation with the already-published atomic-write guarantee, and
correct the docs that blur which command actually writes the pack file. No new
command, flag, JSON field, error code, schema field, or user workflow.

## Problem

Two small but real inconsistencies between the published contract and the code:

1. **The atomic-write guarantee was false for context packs.**
   `docs/cli-contract.md` § "State file write guarantees" states *"Every disk
   write goes through the same atomic primitive so an interrupted process cannot
   leave a half-written file behind"* and *"Every write listed above goes
   through `atomicWriteText`"*. But `writeContextPack()` in
   `src/core/pack/index.ts` wrote the pack with a raw
   `writeFile(outputPath, pack.content, "utf8")`. An interrupted `task prepare`
   / `pack` could therefore leave a half-written `.context/<agent>/<task-id>.md`
   — exactly the failure the contract says cannot happen. The pack was also
   absent from the write-guarantees table, while the table's
   `<adapter-owned files>` row listed `.context/<agent>/*` as if the adapter
   wrote the per-task packs (the adapter only `mkdir`s the directory at
   install / upgrade; the per-task `.md` packs are written by `task prepare` and
   `pack`).

2. **Docs blurred `task context` (read-only) with the pack writers.**
   `docs/positioning.md` described `code-pact task context` as writing the pack
   to `.context/<agent>/<task-id>.md`. In the implementation, `task context`
   (`src/commands/task-context.ts`) only calls `buildContextPack` and
   returns/prints the content — it never writes the file. The writers are
   `task prepare` (unless `--dry-run`) and the low-level `pack`. `glossary.md`
   and `agent-contract.md` had the same blur in weaker forms ("would write"
   rather than "produces").

Neither is a severe bug, but both are contract-purity defects: the published
control-plane description is not true, and the falsehood is the kind that
re-grows every time the pack surface is touched.

## Decision

1. **Make `writeContextPack()` atomic.** Replace the raw
   `writeFile(outputPath, pack.content, "utf8")` with
   `atomicWriteText(outputPath, pack.content)`. `atomicWriteText` recursively
   creates the parent directory before the temp-file + rename, so the explicit
   `mkdir(outDir, { recursive: true })` becomes redundant and is removed. Output
   path computation, pack bytes, `outputDir` / profile `context_dir` behavior,
   and `task prepare --dry-run` semantics are all unchanged — the only change is
   the write primitive.

2. **Correct the writer docs.** `cli-contract.md` gains an explicit context-pack
   row (written by `task prepare` / `pack`, regenerable, gitignored, not in the
   adapter manifest) and the `<adapter-owned files>` row drops the
   `.context/<agent>/*` claim (clarified to "creates the directory"). With the
   row present and the implementation atomic, the "every write goes through
   `atomicWriteText`" sentence becomes true. `positioning.md`, `glossary.md`,
   and `agent-contract.md` distinguish `task context` (builds / returns / prints)
   from `task prepare` / `pack` (write).

3. **Add a narrow regression guard.** `scripts/check-doc-invariants.mjs` gains
   one rule with two scoped parts: (a) the `task context` bullet in
   `positioning.md` must not describe the command as writing the pack file; and
   (b) when `cli-contract.md` lists the context pack as a guaranteed-atomic
   write, `writeContextPack()` must actually use `atomicWriteText`. Both parts
   derive their obligation from the doc's own claim, so they cannot go stale.

## Non-goals

- No new CLI command, flag, JSON field, or public error code.
- No change to the bytes produced by `task context`, `task prepare`, or `pack`.
- No change to context-pack path-resolution semantics.
- No promotion of the evidence harness to public CLI surface.
- No broad README / getting-started rewrite.
- No broad non-goals / command-surface regex policy in the doc invariants — the
  new guard is two precisely-scoped slices, not a prose scanner.

## Scope

`src/core/pack/index.ts` (write primitive), `tests/unit/core/pack-core.test.ts`
(regression test), `docs/cli-contract.md`, `docs/positioning.md`,
`docs/glossary.md`, `docs/agent-contract.md`, `scripts/check-doc-invariants.mjs`,
and the v1.29.1 release metadata.

## Related

- [Agent Contract v2](agent-contract-v2-rfc.md) — added `task prepare` /
  `task context --explain`, the commands this RFC disambiguates.
- [Context budget enforcement](context-budget-rfc.md) — the `--budget-bytes`
  pack surface that shares `buildContextPack` (untouched here).
