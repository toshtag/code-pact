# RFC: Doc truth from code

**Status:** accepted
**Scope:** how *enumerable* public-contract facts are kept in docs (generation, not hand-writing); the CI-burden contract any new doc check must satisfy.
**Owners:** maintainer (@toshtag)
**Related:** [cli-command-spec-rfc](cli-command-spec-rfc.md) (the registry this extends to in rollout C) · [leaf-help-docs-straightening-rfc](leaf-help-docs-straightening-rfc.md) · [stability-taxonomy](stability-taxonomy.md). Rule: [`doc-authoring.md`](../rules/doc-authoring.md).

## Summary

An *enumerable* public-contract fact — the values of an enum, a table of error `data.detail` codes, a command/flag/alias list — must not be hand-written in docs. It lives once as a typed catalog in `src/`, and the doc shows a **generated block** rendered from that catalog. CI checks only that the committed block still matches the catalog (drift). The point is to **reduce hand-written facts**, not to add documentation policing. The recurring failure this fixes: a contract fact restated across `cli-contract.md`, concept, bridge, and comment surfaces drifts on change, and past fixes were scoped **per file** so the same contract re-drifted on the next surface a release later.

## Decision

**Enumerable code-owned facts are generated, not hand-written.** Two complementary checks coexist; pick by fact shape:

1. **invariant-check** (`scripts/check-doc-invariants.mjs`) — "IF code does X, the doc must MENTION Y." Prose stays hand-written; the check guards a cross-reference. Good for one-off relationships.
2. **generate-from-source** (`scripts/gen-doc-blocks.ts`, this RFC) — for *enumerable* facts the doc block IS rendered from the catalog, so it cannot be hand-written wrong. **Preferred whenever the fact is an enumeration the code already owns.**

**Generate-from-source contract surface:**

- Typed catalog in a **side-effect-free** `src/contracts/` module (`as const` object + `keyof typeof` type). The runtime uses it (the error class carries the type; CLI-layer literals are tied back with `satisfies`). The generator reads only these light modules — never a full command handler.
- `<!-- @generated:<id> … --> … <!-- @generated:<id>:end -->` markers wrap the rendered block in the doc.
- `pnpm gen:doc-blocks` writes; `pnpm check:doc-blocks` (in `check:docs`) fails on drift, and the failure message names the one-command fix (`pnpm gen:doc-blocks`).

**Rationale:** the fact has exactly one home (the catalog), the runtime and the doc both derive from it, and drift is mechanically impossible rather than caught late in review.

## The DX guardrail (what this is NOT)

This is **not** a push to add CI that enforces doc *quality* or *style* — that would move code-pact's own doc-maintenance burden onto unrelated contributors, the opposite of the goal. Explicit non-goals, never to be added under this initiative:

- No style / voice lint on concept docs; no comment-philosophy lint.
- No judgment gate ("this reads like reference, move it"; "this is mental model not reference").
- No hard gate on judgment-loaded tokens (`Pnn`, RFC names, wizard phrasing) — the `vX.Y` history-noise gate is intentionally the *only* prose gate and stays at its current narrow line.
- No check that fails an unrelated PR because of pre-existing doc debt; no "you must also update concept doc X" human-judgment CI.

For concept / narrative docs the tool is **structural reduction** — state the mental model, link to the generated reference — *not* CI.

## The CI-burden contract (binding on every future check)

Every new check added under this initiative MUST declare its **Contributor impact** in the PR (and the rule doc): Who can hit it? · What kind of PR triggers it? · Is the fix mechanical? · Is there an auto-fix command? · Can an *unrelated* PR fail because of existing debt?

If any answer is vague — or "yes, unrelated PRs can fail on debt" — the check is **not** added. `check:doc-blocks` is the worked example: it can fail only a PR that touches the generated contract surface (catalog, generator, or block), the fix is one command (`pnpm gen:doc-blocks`), and an unrelated PR can never drift a block it didn't touch.

## Rollout

Each increment obeys the CI-burden contract (drift-only, no concept-doc policing). The initial vertical slice generated the `spec import` `data.detail` enum into the `cli-contract.md` table + `check:doc-blocks`, and replaced the duplicated enum *list* in `docs/spec-kit-bridge.md` with a link to the generated table. Per-PR progress lives in the CHANGELOG / PRs — this RFC fixes the decision, it is not a rollout checklist.

- **B** — apply the same pattern to other code-owned command detail enums (remaining `plan` capture/adopt details, `phase reconcile`, the public error-code catalog).
- **C** — command / alias / stable-surface registry as a generated stable table (extends [cli-command-spec-rfc](cli-command-spec-rfc.md)); kills the `task record-done`-missing-from-the-table class.
- **D** — structural reduction of concept docs (link to generated references). Reduction, not CI.

## Alternatives considered

- **Guard *behavioral* prose that names a single detail value** (e.g. the `mutex` bullets) by generation — rejected for the initial slice; that is invariant-check territory and is added only if it passes the CI-burden contract.
- **A `docs:generate` mega-aggregate** — rejected; `gen:doc-blocks` is the single entry, mirroring `gen:cli-reference`.
- **Generating prose / narrative** — rejected; only enumerations the code owns are generated. Concept docs are reduced structurally, not generated.

## Open questions

- The initial slice proves the *pattern*; it does not by itself close the prose-guidance drift caught in earlier reviews — that is the work in rollouts B–D.

## References

- RFCs: [cli-command-spec-rfc](cli-command-spec-rfc.md) · [leaf-help-docs-straightening-rfc](leaf-help-docs-straightening-rfc.md) · [stability-taxonomy](stability-taxonomy.md).
- Rule: [`design/rules/doc-authoring.md`](../rules/doc-authoring.md).
- Scripts: `scripts/gen-doc-blocks.ts` (generator + `--check`) · `scripts/check-doc-invariants.mjs` (invariant-check).
