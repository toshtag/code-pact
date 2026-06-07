# RFC: Doc truth from code

- Status: accepted
- Scope: how *enumerable* public-contract facts are kept in docs (generation, not hand-writing); the burden contract any new doc check must satisfy.
- Owners: maintainer (@toshtag)
- Related: [cli-command-spec-rfc.md](cli-command-spec-rfc.md) (the registry this extends to in rollout C), [leaf-help-docs-straightening-rfc.md](leaf-help-docs-straightening-rfc.md), [stability-taxonomy.md](stability-taxonomy.md). Rule: [`design/rules/doc-authoring.md`](../rules/doc-authoring.md).

## Summary

An *enumerable* public-contract fact — the values of an enum, a table of error
`data.detail` codes, a command/flag/alias list — must not be hand-written in
docs. It lives once as a typed catalog in `src/`, and the doc shows a
**generated block** rendered from that catalog. CI checks only that the
committed block still matches the catalog (drift). The point is to **reduce
hand-written facts**, not to add documentation policing.

## Problem

A contract fact lives in code and is then re-stated in `cli-contract.md`,
concept docs, bridge docs, and comments. On a change, one copy updates and the
rest drift; review catches it late. Worse, past fixes were scoped **per file**
("fix the `cli-contract` table, forget the bridge enum"), so the *same* contract
drifted again on the next surface a release later.

## The DX guardrail (what this is NOT)

This is **not** a push to add CI that enforces doc *quality* or *style*. That
would move code-pact's own doc-maintenance burden onto unrelated contributors —
the opposite of the goal. Explicit non-goals, never to be added under this
initiative:

- No style / voice lint on concept docs.
- No judgment gate ("this reads like reference, move it"; "this is mental model
  not reference").
- No comment-philosophy lint.
- No hard gate on judgment-loaded tokens (`Pnn`, RFC names, wizard phrasing) —
  the `vX.Y` history-noise gate is intentionally the *only* prose gate and stays
  at its current narrow line.
- No check that fails an unrelated PR because of pre-existing doc debt.
- No "you must also update concept doc X" human-judgment CI.

For concept / narrative docs the tool is **structural reduction** — state the
mental model, link to the generated reference — *not* CI.

## Mechanism

Two complementary checks already coexist; pick by fact shape:

1. **invariant-check** (`scripts/check-doc-invariants.mjs`) — "IF code does X,
   the doc must MENTION Y." Prose stays hand-written; the check guards a
   cross-reference. Good for one-off relationships.
2. **generate-from-source** (`scripts/gen-doc-blocks.ts`, this RFC) — for
   *enumerable* facts the doc block IS rendered from the catalog, so it cannot be
   hand-written wrong. **Preferred whenever the fact is an enumeration the code
   already owns.**

Generate-from-source shape:

- Typed catalog in `src/` (`SPEC_IMPORT_DETAILS = { detail: { when } } as const`;
  `type SpecImportDetail = keyof typeof …`). The runtime uses it (the error class
  carries the type; CLI-layer literals are tied back with `satisfies`).
- `<!-- @generated:<id> … --> … <!-- @generated:<id>:end -->` markers wrap the
  rendered block in the doc.
- `pnpm gen:doc-blocks` writes; `pnpm check:doc-blocks` (in `check:docs`) fails on
  drift, and the failure message names the one-command fix (`pnpm gen:doc-blocks`).

## The CI-burden contract (binding on every future check)

Every new check added under this initiative MUST declare its **Contributor
impact** in the PR (and the rule doc):

- Who can hit it? · What kind of PR triggers it? · Is the fix mechanical? · Is
  there an auto-fix command? · Can an *unrelated* PR fail because of existing debt?

If any answer is vague — or "yes, unrelated PRs can fail on debt" — the check is
**not** added. `check:doc-blocks` is the worked example (see the rule doc): it
fires only for a PR that changed a generated catalog value, the fix is one
command, and an unrelated PR can never drift a block it didn't touch.

## This increment (the vertical slice)

- `spec import` `data.detail` enum → typed catalog + generated `cli-contract.md`
  table + `check:doc-blocks`.
- Removed the duplicated enum *list* in `docs/spec-kit-bridge.md` (now links to
  the generated table) — structural reduction, **no new CI on that doc**.
- This RFC + `design/rules/doc-authoring.md` + a unit test for the generator.

### Not covered (honest residue)

- *Behavioral* prose that names a single detail value (the two `mutex` bullets in
  the bridge / contract docs) is not generated. Guarding it would be
  invariant-check territory and is added **only if** it passes the CI-burden
  contract above — not in this increment.
- This slice proves the *pattern*; it does not by itself close the prose-guidance
  drift caught in earlier reviews. That is the next contracts.

## Rollout (each obeys the CI-burden contract: drift-only, no concept-doc policing)

- **B** — same catalog+block for `plan brief` / `constitution` / `adopt`, `phase
  reconcile`, and the public error-code catalog.
- **C** — command / alias / stable-surface registry as a generated stable table
  (extends [cli-command-spec-rfc.md](cli-command-spec-rfc.md)); kills the
  `task record-done`-missing-from-the-table class.
- **D** — structural reduction of concept docs (link to generated references).
  Reduction, not CI.

## Non-goals

- A `docs:generate` mega-aggregate. `gen:doc-blocks` is the single entry, mirroring
  `gen:cli-reference`.
- Generating prose / narrative. Only enumerations the code owns are generated.
