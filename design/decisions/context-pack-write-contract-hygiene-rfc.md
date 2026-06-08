# RFC: Context-pack write contract hygiene (P45)

**Status:** accepted (P45, 2026-06)
**Scope:** route `writeContextPack()` through `atomicWriteText`; correct the docs that blur `task context` (read-only) with the pack writers; one scoped doc-invariant guard. Patch-level (v1.29.1) — no new command, flag, JSON field, error code, or schema field.
**Owners:** maintainer
**Related:** [agent-contract-v2](agent-contract-v2-rfc.md) (added `task prepare` / `task context --explain`, the commands this RFC disambiguates) · [context-budget](context-budget-rfc.md) (the `--budget-bytes` pack surface sharing `buildContextPack`, untouched here).

## Summary

The context pack is part of code-pact's deterministic agent-facing artifact surface, so the write that produces it should use the same atomic primitive (`atomicWriteText`) as the other managed file-content writes in the write-guarantees contract. It used a raw `writeFile` instead, and the docs blurred which command writes the pack. A contract-hygiene change: align the implementation with the published atomic-write guarantee and correct the writer docs.

## Decisions

1. **Make `writeContextPack()` atomic.** Replace the raw `writeFile(outputPath, pack.content, "utf8")` with `atomicWriteText(outputPath, pack.content)`. RATIONALE: the write-guarantees contract in `docs/cli-contract.md` promises managed file-content writes go through `atomicWriteText` so an interrupted process cannot leave a half-written file — but an interrupted `task prepare` / `pack` could leave a half-written `.context/<agent>/<task-id>.md`, exactly the failure the contract forbids. `atomicWriteText` recursively creates the parent directory before the temp-file + rename, so the prior explicit `mkdir(outDir, { recursive: true })` becomes redundant and is removed. Output path, pack bytes, `outputDir` / profile `context_dir` behavior, and `--dry-run` semantics are unchanged — the only change is the write primitive.

2. **Correct the writer docs.** `cli-contract.md` gains an explicit context-pack row (written by `task prepare` / `pack`, regenerable, default-gitignored, not in the adapter manifest); the `<adapter-owned files>` row drops the `.context/<agent>/*` claim (clarified to "creates the directory"). RATIONALE: `task context` (`src/commands/task-context.ts`) only calls `buildContextPack` and returns/prints — it never writes the file; the writers are `task prepare` (unless `--dry-run`) and the low-level `pack`. The adapter only `mkdir`s the directory at install/upgrade. `positioning.md`, `glossary.md`, and `agent-contract.md` are corrected to distinguish `task context` (builds / returns / prints) from `task prepare` / `pack` (write). With the row present and the implementation atomic, the table-scoped file-content write guarantee now covers the context pack.

3. **Add a narrow regression guard.** `scripts/check-doc-invariants.mjs` gains one rule with two scoped parts: (a) the `task context` bullet in `positioning.md` must not describe the command as writing the pack file; (b) when `cli-contract.md` lists the context pack as a guaranteed-atomic write, `writeContextPack()` must use `atomicWriteText`. RATIONALE: both parts derive their obligation from the doc's own claim, so they cannot go stale — and the blur re-grows every time the pack surface is touched. Two precisely-scoped slices, not a prose scanner.

## Non-goals

- No new CLI command, flag, JSON field, or public error code.
- No change to the bytes produced by `task context`, `task prepare`, or `pack`, nor to context-pack path-resolution semantics.
- No promotion of the evidence harness to public CLI surface; no broad README / getting-started rewrite.
- No broad non-goals / command-surface regex policy in the doc invariants — the guard is two scoped slices.

## References

- RFCs: [agent-contract-v2](agent-contract-v2-rfc.md) · [context-budget](context-budget-rfc.md).
- Code: `src/core/pack/index.ts` (write primitive) · `src/commands/task-context.ts` (read-only builder) · `scripts/check-doc-invariants.mjs` (guard).
- Docs: `docs/cli-contract.md` · `docs/positioning.md` · `docs/glossary.md` · `docs/agent-contract.md`.
