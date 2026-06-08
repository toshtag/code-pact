---
tags: [docs, ci, contract]
applies_to: [feature, refactor, docs]
---

# Doc authoring — generate enumerable facts; never police prose

The rule behind [doc-truth-from-code-rfc.md](../decisions/doc-truth-from-code-rfc.md).
Two short halves: how a contract fact reaches the docs, and the bar a new doc
check must clear before it can fail anyone's PR.

## 1. Enumerable contract facts are generated, not hand-written

If a public-contract fact is an **enumeration the code already owns** — the
values of an enum, a table of error `data.detail` codes, a command / flag / alias
list — it must not be retyped in a doc. It lives once as a typed catalog in
`src/` and the doc carries a **generated block** rendered from it.

To add one:

1. Make the catalog the single source: `const X = { key: { … } } as const` and
   `type T = keyof typeof X`. Have the runtime consume it (carry the type; tie any
   stray string literal back with `satisfies T`). Keep the catalog in a
   **side-effect-free, import-light module** (e.g. `src/contracts/`) — a generator
   must never import a full command handler to read it, or that handler's
   transitive deps (parsers, file I/O, `yaml`) get dragged into `check:docs`.
2. Wrap the doc region in `<!-- @generated:<id> … -->` / `<!-- @generated:<id>:end -->`
   and add a `BLOCKS` entry + `render()` in [`scripts/gen-doc-blocks.ts`](../../scripts/gen-doc-blocks.ts).
   A generated block is **block-level** — markers on their own lines around a
   table (cells `|`-escaped via `escapeTableCell`). Do **not** embed inline,
   mid-sentence markers (they clutter the Markdown source), and put the block in
   **one** place — other sections **link** to it rather than embedding a second
   copy (that link-don't-restate move is the dedup, not four generated copies).
3. `pnpm gen:doc-blocks` to write; `pnpm check:doc-blocks` runs in `check:docs`.

Prefer this over restating the fact in prose. For a one-off *relationship*
(not an enumeration), an invariant-check in `scripts/check-doc-invariants.mjs`
("if code does X the doc must mention Y") is the lighter tool.

## 2. The CI-burden contract (binding)

A new doc check exists to catch **generated-output drift**, not to police prose.
Before adding one, answer all five in the PR body. If any answer is vague — or
the last is "yes" — **do not add the check**; reduce the hand-written surface
instead.

- **Who can hit it?**
- **What kind of PR triggers it?**
- **Is the fix mechanical?**
- **Is there an auto-fix command?** (name it; the failure message must print it)
- **Can an *unrelated* PR fail because of pre-existing doc debt?** (must be **no**)

### Worked example — `check:doc-blocks`

| Question | Answer |
| --- | --- |
| Who can hit it? | Someone who edits a generated catalog (e.g. `SPEC_IMPORT_DETAILS`), the generator, or hand-edits a `@generated` block. |
| What PR triggers it? | One that touches the generated contract surface: the typed catalog, the generator, or the `@generated` block itself. |
| Mechanical fix? | Yes. |
| Auto-fix command? | `pnpm gen:doc-blocks` (named in the failure message). |
| Unrelated PR fails on debt? | No — a block already in sync can't drift from a PR that doesn't touch that surface. |

## 3. Never (these shift our doc burden onto contributors)

- Style / voice lint on concept docs, or a "this reads like reference, move it"
  judgment gate.
- A comment-philosophy lint.
- A hard gate on judgment-loaded tokens — `Pnn`, RFC names, wizard phrasing. The
  `vX.Y` history-noise gate is the **only** prose gate and stays at its narrow line.
- A check that fails an unrelated PR on pre-existing doc debt.
- A "you must also update concept doc X" human-judgment CI.

## 4. Concept docs: reduce, don't gate

Narrative / concept docs are human mental-model docs. The tool for keeping them
from drifting is **structural reduction** — state the model, link to the
generated reference — *not* CI. Removing a restated enumeration in favor of a
link is the win; adding a check on that doc is not.

## References

- [doc-truth-from-code-rfc.md](../decisions/doc-truth-from-code-rfc.md) — the decision and rollout.
- [`scripts/gen-doc-blocks.ts`](../../scripts/gen-doc-blocks.ts) — the generator + `--check`.
- [`docs/maintainers/docs-maintenance.md`](../../docs/maintainers/docs-maintenance.md) — the doc-ownership map and the `check:docs` list.
