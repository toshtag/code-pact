# RFC: CLI maintainability hardening — `src/cli.ts` split

**Status:** accepted (P27, 2026-05)
**Scope:** split the two most active subcommand clusters out of `src/cli.ts` (4559 lines, 36 cmd functions) into per-cluster files under a new `src/cli/commands/` directory — the **task** cluster (`cmdTask` + 10 `cmdTask*`; ~1500 lines) and the **adapter** cluster (`cmdAdapter` + 6 `cmdAdapter*`; ~500 lines). All other clusters (init, plan, phase, doctor, validate, verify, pack, progress, spec, recommend) stay in `src/cli.ts`. **Pure refactor** — every command's JSON envelope, exit code, error code, and flag surface is byte-identical to v1.13.
**Owners:** maintainer
**Related:** [agent-contract-v2](agent-contract-v2-rfc.md) (P21 — added `cmdTaskPrepare` + `cmdAdapterConformance`, the largest single-phase contributor to the growth this RFC addresses) · [context-budget](context-budget-rfc.md) (P24 — added `--budget-bytes` + `CONTEXT_OVER_BUDGET` handling duplicated across `cmdTaskContext` and `cmdTaskPrepare`, a named maintainability signal) · [docs/cli-contract.md](../../docs/cli-contract.md) (the stability contract each extracted function preserves byte-for-byte).

## Summary

`src/cli.ts` grows every phase because the stable-CLI-surface guarantee lands every new command in one file (4559 lines today). The two clusters that dominate recent growth — **task** and **adapter** — account for ~44% of the file and carry the only mechanically-duplicated code (`--budget-bytes` / `CONTEXT_OVER_BUDGET` copied across two task functions). P27 extracts them into `src/cli/commands/task.ts` and `src/cli/commands/adapter.ts` as a literal, contract-preserving move. No new commands, flags, error codes, abstractions, or registry pattern.

## Decisions

1. **Extract the task and adapter clusters only.** Each becomes a file under `src/cli/commands/` exporting its dispatch entry (`cmdTask`, `cmdAdapter`); the per-subcommand functions stay private to the cluster (not re-exported). `src/cli.ts` keeps a one-line import and routes `task` / `adapter` to the imported dispatcher exactly as before. **Rationale:** these two clusters are the active growth drivers and the only duplicated-maintenance sites; extracting ~2000 lines in two well-scoped, independently reversible tasks attacks the bottleneck without a wholesale reorganisation.
2. **Defer every other cluster** (init, plan, phase, doctor, validate, verify, pack, progress, spec, recommend) to a possible future RFC. **Rationale:** they are stable — `cmdInit`/`cmdDoctor`/`cmdValidate` have seen no feature additions in three phases; the `cmdPlan` surface has been frozen since v1.4; `cmdSpec` is unlikely to grow; `cmdPhase` stabilised at P14/P19. Their presence in `cli.ts` is not the bottleneck, so extracting them now would be churn without payoff.
3. **The existing tests must pass unmodified.** The 1262 unit + 333 integration tests are the safety net; the refactor is correct iff every existing test passes without a single edit. **Rationale:** a "pure-refactor" PR that adjusts a test to make a split work would defeat the guarantee — a changed test is the signal the move did more than it claims. Tests protect the *contract* (behaviour byte-for-byte), not the *structure*, so the split work must be intentional and the tests left untouched.

## Contract surface (locked invariants)

The refactor is a no-op against every external contract:

- **CLI surface byte-identical to v1.13** — every public command, flag, JSON envelope, exit code, and error code is unchanged. No new commands/flags/error codes.
- **Function signatures preserved** — e.g. `cmdTaskContext(argv, locale, globalJson)` keeps its signature in the new file; JSDoc/inline comments move verbatim.
- **i18n lookups preserved** — extracted files import `messages` from `../i18n/`; `messages[locale].task.context.taskNotFound(...)` etc. resolve identically. A broken import path changes the error envelope and fails a localised-message test.
- **`bin` entry unchanged** — the `code-pact` binary works identically. Bundle size / `dist/cli.js` byte count may shift from tsup bundling order; the locked invariant is runtime behaviour, not byte count.
- **Unchanged schemas** — `progress.yaml` and the adapter manifest are untouched; no `adapter upgrade` required.

What proves it: (a) existing tests pass without modification; (b) `dist/cli.js` before/after diff shows only layout-level differences (function order, source-map lines) — any JSON-template-string change is forbidden; (c) smoke test of the cross-cluster paths (`task prepare --json --explain --budget-bytes`, `adapter conformance --json`, `task finalize --audit-strict --write --json --base-ref origin/main`).

## Alternatives considered

- **Extract all clusters in P27** — rejected; the stable clusters are not the bottleneck, and a wholesale reorganisation is harder to review and reverse than two scoped extractions. Their extraction is deferred to a future RFC, gated on real growth.
- **Introduce a command-base-class / registry / plugin pattern** — rejected as premature abstraction. Manual dispatch is fine; P27 is a literal extraction, not a redesign.
- **Re-export the extracted dispatch functions from `src/cli.ts`** — rejected; the dispatchers are called only from `cli.ts`'s own top-level routing, so a re-export creates a confusing duplicate entry surface.
- **Refactor tests to fit the split, or touch `src/commands/` (the pure-function layer)** — rejected; tests are the safety net and the implementation layer is already split correctly. P27 moves only the CLI wrapper layer.
- **Sub-package `code-pact-cli` / `package.json` `exports` change** — rejected; the CLI ships with the main package via the `bin` entry, not a public API.

## Open questions

Both acceptance-time questions are resolved, none blocking:

1. **Directory name** — `src/cli/commands/` (parallel to the existing pure-function `src/commands/`), making "CLI wrapper layer" explicit.
2. **Drift risk** — a future command could land in `cli.ts` when it belongs in a cluster file. Mitigated by a documented "where new commands go" convention in `docs/cli-contract.md`; a lint rule to enforce it is possible future work, not P27 scope.

## References

- RFCs: [agent-contract-v2](agent-contract-v2-rfc.md) (P21) · [context-budget](context-budget-rfc.md) (P24).
- Docs: [docs/cli-contract.md](../../docs/cli-contract.md).
- Code: `src/cli.ts` → `src/cli/commands/task.ts`, `src/cli/commands/adapter.ts`.
