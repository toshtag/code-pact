# RFC: CLI command spec — single source for parse, help, and reference docs

**Status:** accepted (P46, implemented v1.28.0)
**Scope:** `task` cluster only; one `CommandSpec` per subcommand becomes the single source from which parse options, leaf help, and the generated reference are derived. No behaviour change to any command.
**Owners:** maintainer
**Related:** [doc-truth-from-code-rfc](doc-truth-from-code-rfc.md) (the registry this extends to in rollout C) · [leaf-help-docs-straightening-rfc](leaf-help-docs-straightening-rfc.md) · [stability-taxonomy](stability-taxonomy.md).

## Summary

A task command's flag surface was declared in **three** unsynced places: the `strictParse(...)` options literal in each `cmd*` (`src/cli/commands/task.ts`), the hand-written synopsis/flag list in `LEAF_USAGE` (`src/cli/usage.ts`), and the flag tables in `docs/cli-contract.md`. They were *consistent*, but nothing *prevented* drift — adding a flag meant editing three files, guarded only by reviewers and a few presence-of-string keyword tests. This RFC makes one **`CommandSpec`** per task subcommand the single source; parse, help, and reference are all derived from it.

## Decision

One `CommandSpec` per task subcommand in `src/cli/spec/task.ts`. Derivations: `toParseOptions(spec)` → the object passed to `strictParse` (parse); `renderLeafHelp(spec)` → the `LEAF_USAGE` entry (help); `renderReference(spec)` → one section of the generated `.md` (reference).

- **Parse is derived too** (chosen over help/docs-only). `task.ts` calls `strictParse(..., toParseOptions(SPEC.<verb>), …)` instead of an inline literal, so a flag added to the spec changes parse, help, and docs at once.
  - **Rationale:** only deriving parse makes *flag-surface* drift across parse / help / generated reference **structurally impossible** (they share one source). This is NOT a claim that all CLI behaviour is drift-proof — runtime semantics stay owned and tested elsewhere (required-flag enforcement in command bodies; which names a body reads; example runnability via `task-prepare-commands-contract.test.ts`; the prose / JSON-envelope / error-code sections of `cli-contract.md`).

- **The spec is a plain `type`, not zod** (`src/cli/spec/types.ts`). It describes static CLI shape, not runtime-validated external input, so the zod-for-schemas convention does not apply — it is closer to the existing `LEAF_USAGE` constant. Fields: `cluster` (`"task"`; widen later), `command`, `positional?`, `summary`, `flags[]`, `examples[]`, `readOnly?`. Each `FlagSpec` carries `name` (long flag, no dashes), `value?` (placeholder; absent → boolean), `required?`, `repeatable?` (→ parseArgs `multiple:true`), `description`.

- **`required` is presentation-only — NOT runtime enforcement.** Node's `parseArgs` has no required concept, so `toParseOptions` does not express it. Required-flag enforcement already lives in each command body (`task block --reason`, `task record-done --evidence`, `task add`'s required fields) and stays there, pinned by parse **regression tests** (block-without-reason fails, record-done-without-evidence fails, task-add missing-required fails). This keeps the spec honest: it does not claim parse enforces something it doesn't.

- **Generation runs under tsx**, not by reading `dist/` (chosen so the spec stays TypeScript in `src/`). `scripts/gen-cli-reference.ts` imports the spec via tsx and writes `docs/cli-reference.generated.md` (a `.ts` script, not `.mjs`, because it depends on the spec types; matches the `scripts/harness/run.ts` precedent). Type-safe, no build prerequisite.
  - `pnpm gen:cli-reference` regenerates; `pnpm check:cli-reference` (`--check`) regenerates into memory and diffs against the committed file, exiting 1 on drift (self-contained, so it works on a dirty tree). Wired into `check:docs` and the CI `full` job.

- **`docs/cli-contract.md` shrinks.** The 11 `## \`task <verb>\`` flag-table sections are replaced by a single pointer to `docs/cli-reference.generated.md`. cli-contract.md keeps what it owns: JSON envelope, exit codes, error/cause codes, stability taxonomy, locale, write guarantees. `check-doc-invariants.mjs` rule #8 reads cli-contract.md's "JSON output shape" section, which is untouched. Removing the 11 headings drops their `#task-<verb>` anchors — any in-repo links were repointed (or a redirect stub kept) so `check:docs` stays green.

## Non-goals (scope decisions)

- **Other clusters (plan/phase/adapter).** task-only this round; the `cluster` field makes widening additive. P52 brought their leaf help to parity by hand (9 mutating/JSON commands) as the interim; CommandSpec-izing them is a deferred follow-up.
- **Any flag/behaviour change.** Pure refactor + generation; verified flag sets preserved byte-for-byte (including `task add`, which calls stdlib `parseArgs` directly — `toParseOptions` produces the same options shape).
- **Touching cli-contract.md sections other than the 11 task flag tables.**
- **Widening `CommandSpec` beyond flag surface + `readOnly`.** No write/lifecycle/recovery semantics on the spec this round — those belong to P47+ and would bloat the type. `readOnly` is the only semantic field allowed in P46.

## Alternatives considered

- **Derive help/docs only, leave parse as inline literals** — rejected; parse would remain a fourth unsynced copy, so flag-surface drift stays possible. Deriving parse too is what makes it structurally impossible.
- **Express `required` to parseArgs** — impossible (no such concept); would imply parse enforces required-ness when it doesn't. Kept presentation-only with enforcement in command bodies + regression tests.
- **Define the spec with zod** — rejected; it is static CLI shape, not validated external input. A plain `type` matches the `LEAF_USAGE` precedent without the zod weight.
- **Read `dist/` in the generator** — rejected; needs a build first. Importing the `src/` spec under tsx is type-safe and build-free.

## Open questions

- Porting plan/phase/adapter onto `CommandSpec` (the P52 hand-written help is the interim dedupe target) — sequencing and whether the type needs widening for those clusters.

## References

- RFCs: [doc-truth-from-code-rfc](doc-truth-from-code-rfc.md) · [leaf-help-docs-straightening-rfc](leaf-help-docs-straightening-rfc.md) · [stability-taxonomy](stability-taxonomy.md).
- Code: `src/cli/spec/types.ts`, `src/cli/spec/task.ts`, `src/cli/commands/task.ts`, `src/cli/usage.ts`, `scripts/gen-cli-reference.ts`.
- Docs: [docs/cli-contract.md](../../docs/cli-contract.md) · [docs/cli-reference.generated.md](../../docs/cli-reference.generated.md).
