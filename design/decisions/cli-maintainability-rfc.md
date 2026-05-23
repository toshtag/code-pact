# RFC: CLI maintainability hardening — `src/cli.ts` split

**Status:** proposed (P27, 2026-05)
**Scope:** split the most active subcommand clusters out of `src/cli.ts` (currently 4559 lines, 36 cmd functions) into per-cluster files under a new `src/cli/commands/` directory. P27 ships two extractions: the task cluster (`cmdTask` + cmdTaskAdd/Context/Prepare/Complete/Finalize/Runbook/Start/Block/Resume/Status; ~1500 lines moved) and the adapter cluster (`cmdAdapter` + cmdAdapterList/Install/Doctor/Conformance/Upgrade/BareForm; ~500 lines moved). The remaining clusters (init, plan, phase, doctor, validate, verify, pack, progress, spec, recommend) stay in `src/cli.ts` for v1.14 — extracting them is mechanical follow-on work, not P27 scope. **Pure refactor**: every command's JSON envelope, exit code, error code, and flag surface is byte-identical to v1.13. The existing 1262 unit tests + 333 integration tests are the safety net; the refactor passes iff every existing test passes without modification.
**Owners:** maintainer
**Related:**
- [design/decisions/agent-contract-v2-rfc.md](agent-contract-v2-rfc.md) (P21 — added `cmdTaskPrepare` + `cmdAdapterConformance`, the largest single-phase contribution to the file growth this RFC addresses).
- [design/decisions/context-budget-rfc.md](context-budget-rfc.md) (P24 — added `--budget-bytes` parsing + `CONTEXT_OVER_BUDGET` envelope handling in both `cmdTaskContext` and `cmdTaskPrepare`; the duplicated error block is one of the maintainability signals this RFC names).
- [docs/cli-contract.md](../../docs/cli-contract.md) (the stability contract every extracted function must preserve byte-for-byte).

## Status lifecycle

- This document opens at status **proposed** in the P27-T0 PR and flips to **accepted** in a small follow-up commit before subsequent implementation work begins, per the P11–P26 precedent.
- P27-T0 is considered done only after a commit with `Status: accepted` has landed on main.
- Subsequent implementation PRs (P27-T1..T3) treat the accepted document as load-bearing.

## Background

`src/cli.ts` has grown across every phase since v0.1 because the project's stable-CLI-surface guarantee means **every new command landed in the same file**:

- v1.0 baseline: ~2500 lines, 22 cmd functions.
- v1.7 (P16 adapter contract): + cmdAdapterDoctor expansion.
- v1.10 (P15 audit-strict): + `--audit-strict` / `--base-ref` parsing in `cmdTaskFinalize` (266 lines, the largest single function in the file).
- v1.11 (P21): + cmdTaskPrepare (173 lines), cmdAdapterConformance (67 lines), `--explain` parsing in cmdTaskContext.
- v1.13 (P24): + `--budget-bytes` parsing in BOTH cmdTaskContext and cmdTaskPrepare, + `CONTEXT_OVER_BUDGET` error block duplicated in both. The duplication is the maintenance signal — adding one more flag with one more error shape forces two near-identical edit sites.

Today's state:

- **4559 lines, 36 cmd functions**, all in one file.
- Top three by size: cmdTaskFinalize (266), cmdTaskAdd (228), cmdSpec (181). Five more functions are over 100 lines each.
- `cmdTaskContext` and `cmdTaskPrepare` carry near-duplicate `--budget-bytes` parsing + `CONTEXT_OVER_BUDGET` error envelope blocks. The duplication is correct but mechanically copied; a future change has to land in both places.
- Two clusters dominate the recent growth: **task** (cmdTask + 10 task-* commands) and **adapter** (cmdAdapter + 6 adapter-* commands).

Three operational gaps follow:

1. **Compounding review surface.** Every PR that adds a new command or a new flag forces reviewers to navigate the 4500-line monolith to verify the change is localised. With each phase the navigation gets harder.
2. **Duplicate maintenance sites.** The `--budget-bytes` + `CONTEXT_OVER_BUDGET` example is concrete; future cross-command flags (e.g. a future `--timeout` on every long-running command) compound the duplication.
3. **Test coverage protects the contract but not the structure.** The 1262 unit + 333 integration tests cover behaviour byte-for-byte. They do NOT push back against `src/cli.ts` getting longer; structure-level safety has to come from intentional split work.

## Problem statement

1. **One file holds the entire CLI dispatch surface.** No mechanical force pushes back against unbounded growth.
2. **The two most active clusters (task, adapter) account for ~44% of the file.** Extracting them removes ~2000 lines in two well-scoped tasks.
3. **The refactor surface is well-protected by tests, but the tests must not change.** A "pure-refactor" PR that adjusts a test to make a split work would defeat the safety guarantee. The contract is: the existing tests pass without modification after the move.

## Goals

- **Ship `src/cli/commands/task.ts`** containing every `cmdTask*` function plus the `cmdTask` dispatch entry point. `src/cli.ts` keeps a one-line import + a single dispatch call. The task cluster's flag parsing, JSON envelopes, error codes, and exit codes are byte-identical to v1.13.
- **Ship `src/cli/commands/adapter.ts`** containing every `cmdAdapter*` function plus the `cmdAdapter` dispatch entry point. `src/cli.ts` keeps the same one-line shape.
- **Preserve every existing test without modification.** The existing 1262 unit + 333 integration tests pass exactly as written. If any test needs adjustment to accommodate the move, the move is wrong.
- **Preserve `dist/cli.js` behaviour byte-for-byte.** A `code-pact <command> --json` invocation against the same input must produce the same bytes before and after the refactor. The bundled binary may grow or shrink by formatting / dead-code-elimination differences; the runtime envelope contract is what is locked.
- **Preserve i18n message lookups.** `messages[locale].task.context.taskNotFound(...)` etc. continue to resolve. The extracted files import from `../i18n/` rather than reaching back into the now-shorter `cli.ts`.
- **Defer other clusters.** The init, plan, phase, doctor, validate, verify, pack, progress, spec, and recommend commands stay in `src/cli.ts` for v1.14. Future RFCs may extract them when growth or duplication justifies; P27 does not pre-empt that judgement.

## Non-goals (out of scope for P27)

- **No CLI surface change.** No new commands, no new flags, no new error codes, no envelope adjustments.
- **No new abstractions.** No "command base class", no "registry pattern", no plugin system. Each cluster is a literal extraction of the existing functions, preserving function signatures and inter-function references.
- **No phase / plan / init / doctor / verify / pack / progress / spec / recommend extraction.** Those are stable enough that their inclusion in `cli.ts` is not the bottleneck. A future P27b RFC may extract them.
- **No test refactoring.** Existing tests are the safety net. Any test that has to change for the refactor is a sign the refactor is doing more than it claims.
- **No reorganisation of shared helpers.** Utilities like `strictParse`, `ConfigError`, `emitTaskCommonError` remain in their current locations. The extracted files import from there.
- **No change to `src/commands/`** (the existing pure-function layer that the CLI calls into). That layer is already split correctly. P27 extracts the **CLI wrapper** layer, not the implementation layer.
- **No `package.json` `exports` map change.** The CLI is still consumed via the `bin` entry, not via the package's public API.

## Design

### File layout

```
src/
  cli.ts                       (≈2500 lines after P27; was 4559)
  cli/
    commands/
      task.ts                  (≈1500 lines; cmdTask + 10 cmdTask* functions)
      adapter.ts               (≈500 lines; cmdAdapter + 6 cmdAdapter* functions)
```

`src/cli/commands/` is a new directory. `src/cli.ts` is unchanged in shape — it still exports `runCli` (or whatever the top-level dispatch is named), it still routes `task` / `adapter` to dispatchers, but the dispatchers are now imported rather than defined inline.

### Extraction contract

Each extracted file:

1. **Imports** from `../i18n/`, `../core/...`, `../commands/...`, and shared CLI utilities (`../strict-parse.ts`, `../config-error.ts` — using their current locations).
2. **Exports** the cluster-entry dispatch function (`cmdTask`, `cmdAdapter`) for `src/cli.ts` to import.
3. **Does not re-export** the per-subcommand functions. They are private to the cluster.
4. **Preserves function signatures byte-for-byte.** `cmdTaskContext(argv, locale, globalJson)` keeps the same signature in the new file.
5. **Carries the same JSDoc / inline comments** as the original. No prose changes during the move.

### `src/cli.ts` after the extraction

The file shrinks but its structure is unchanged. A representative excerpt:

```typescript
// before P27:
async function cmdTask(argv, locale, globalJson) { ...the 82-line dispatch... }
async function cmdTaskContext(argv, locale, globalJson) { ...178 lines... }
async function cmdTaskPrepare(...) { ...173 lines... }
... 8 more cmdTask* functions ...

// after P27:
import { cmdTask } from "./cli/commands/task.ts";
import { cmdAdapter } from "./cli/commands/adapter.ts";
// (the cmdTask* and cmdAdapter* private functions live in the extracted files)
```

The top-level command dispatcher in `cli.ts` calls `cmdTask(rest, locale, json)` and `cmdAdapter(rest, locale, json)` exactly as before.

### What proves the refactor is correct

Three independent safety nets:

1. **Existing tests pass without modification.** 1262 unit + 333 integration. If any test needs changing, the refactor is wrong.
2. **`dist/cli.js` byte-comparison.** Build the dist before the refactor (`pnpm build` on the v1.13 main commit), build it after the refactor, diff the two `dist/cli.js` outputs. Layout-level differences (function order, source-map line numbers) are expected; envelope-affecting differences are forbidden. If the diff includes a JSON template string change, the refactor is wrong.
3. **Manual smoke test of representative commands.** `code-pact task prepare <id> --json --explain --budget-bytes <N>`, `code-pact adapter conformance <agent> --json`, `code-pact task finalize <id> --audit-strict --write --json --base-ref origin/main`. Three commands that exercise the most cross-cluster shared code (i18n lookup, error envelope construction, lock acquisition).

### What stays in `src/cli.ts`

The following clusters remain in `cli.ts` for v1.14:

- `cmdInit` (213 lines)
- `cmdDoctor` (38 lines)
- `cmdValidate` (50 lines)
- `cmdSpec` (181 lines)
- `cmdRecommend` (84 lines)
- `cmdPlan` + 6 cmdPlan* functions (~700 lines)
- `cmdVerify` (87 lines)
- `cmdPack` (73 lines)
- `cmdProgress` (55 lines)
- `cmdPhase` + its subcommands (~440 lines)

These are NOT extracted in P27 because:

- **`cmdInit` / `cmdDoctor` / `cmdValidate`** are stable; they have not seen feature additions in the last three phases.
- **`cmdSpec`** (Spec Kit import) is unlikely to grow per the current Spec Kit non-goals.
- **`cmdRecommend`** is small and bounded.
- **`cmdPlan` cluster** is large but stable (the plan brief / constitution / lint / normalize / analyze surface has been frozen since v0.7 / v1.4).
- **`cmdPhase` cluster** is medium-size and stable (P14 governance and P19 cross-phase deps both stabilised the surface).

If any of these clusters DOES grow significantly in a future phase, a follow-up RFC may extract them. P27 deliberately ships an incremental split rather than a wholesale reorganisation — every extraction is independently reviewable and independently reversible.

## Out of scope (deferred)

- **`src/cli/commands/phase.ts`** — defer to P27b if `cmdPhase` cluster grows.
- **`src/cli/commands/plan.ts`** — defer to P27b if `cmdPlan` cluster grows.
- **`src/cli/commands/init.ts`** — defer.
- **Top-level command-registry pattern** — out of scope; manual dispatch is fine.
- **Sub-package `code-pact-cli`** — out of scope; the CLI ships with the main package.

## Backward compatibility

- **Every public CLI command, flag, JSON envelope, exit code, and error code** — byte-identical to v1.13. Verified by the existing test suite.
- **`bin` entry in `package.json`** — unchanged. The entry point file path may change inside `dist/` (tsup output naming), but the user-facing `code-pact` binary works identically.
- **Bundle size** — may shift by a small amount due to tsup's bundling order; the locked invariant is the runtime behaviour, not the byte count.
- **`progress.yaml` schema** — unchanged.
- **Adapter manifest schema** — unchanged. No `adapter upgrade` required.
- **Existing test files** — unchanged. The refactor passes iff the tests do.

## Risks

1. **A subtle behavioural difference slips through.** Most likely cause: an inline closure in an extracted function captured a variable from the enclosing module that does not exist in the new file. Mitigation: TypeScript catches the missing variable at compile time; the test suite catches the runtime regression. The split must compile AND pass tests.
2. **i18n message lookup breaks.** The extracted files import `messages` from `../i18n/`; if the import path is wrong, `messages[locale].task.context.taskNotFound` returns undefined and the error envelope shape changes. Mitigation: the integration test `tests/integration/json-stdout.test.ts` and per-command unit tests exercise the localised messages; a broken lookup fails one of them.
3. **Source-map line numbers shift.** Debugging tooling and stack traces will reference new line numbers. This is intentional — it is the point of the split — but downstream consumers who screen-scrape error message line numbers (none known) would be affected.
4. **Future phases land changes in BOTH `src/cli.ts` and the new files.** A new command might land in `cli.ts` by mistake when it should be in `cli/commands/task.ts`. Mitigation: documented convention in `docs/cli-contract.md` "Where new commands go" + lint rule (deferred, not P27 scope) or PR review.

## Open questions

1. **Should `src/cli.ts` re-export the extracted dispatch functions?** No — the dispatchers are called only from `cli.ts`'s own top-level routing. Re-exporting would create a confusion-inducing duplicate entry surface. Confirmed at acceptance.
2. **Should the new directory be `src/cli/` or `src/commands/cli/`?** `src/cli/commands/` is consistent with the existing `src/commands/` (pure-function command implementations). The new directory makes "this is the CLI wrapper layer for the task cluster" explicit. Confirmed at acceptance.

Both questions are resolved; no open questions blocking implementation.
