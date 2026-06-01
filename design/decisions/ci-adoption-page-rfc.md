# RFC: CI / adoption page (P44)

- Status: accepted
- Phase: P44
- Date: 2026-06-01

## Problem

A consumer setting up code-pact in CI today has to assemble the recipe from at
least six docs: `cli-contract.md` (the only GitHub Actions example + the
`--base-ref` branch-drift gate + the ledger/config preconditions),
`troubleshooting.md` (the two `CONTROL_PLANE_*` detector recovery sections),
`docs/maintainers/operations.md` (the `plan lint --strict` / `plan analyze
--strict` planning-integrity sequence), `dogfood.md` (the checkpoint block),
`getting-started.md` (exact-version pinning), and `workflows/brownfield-feature.md`
(the commit-the-ledger precondition). `docs/README.md` has **no CI entry** — there
is no single "how do I run code-pact in CI" home.

Two concrete harms follow:

1. **The one copy-pasteable Actions example (`cli-contract.md`) under-covers the
   gate.** It runs only `validate --strict --base-ref`; it omits `plan lint
   --strict`, `plan analyze --strict`, and `task finalize --audit-strict
   --base-ref`. A consumer who copies it ships a CI that catches branch-drift but
   silently misses plan-integrity and write-audit regressions the rest of the
   docs say belong in CI.
2. **The preconditions that cause the most common CI failures** (the gate
   silently skips when `progress.yaml` is not tracked; `DECLARED_UNUSED` fires
   without `--base-ref`; merge-base needs full git history / `fetch-depth: 0`)
   are scattered footnotes, not a single setup checklist.

This is the same "value the agent/consumer can't find" theme as P39-P43: the
detectors already exist (P33/P34 — `CONTROL_PLANE_*`, branch-drift); the gap is a
findable adoption home, not new machinery.

## Decision

Add one new usage page — **`docs/workflows/ci.md`** — as the single adoption home
for running code-pact in CI, registered in the docs hub. It is a **thin
orchestration page**: it sequences and links the existing facts, it does not
re-state them. No new CLI surface, no new detector, no code change.

### Page shape (contributor-DX-safe)

The page is explicitly split so it never reads as "run everything on every
commit":

- **Contributor loop (before a PR).** Run the checks relevant to your change —
  not a mandatory full-suite-every-commit ritual.
- **Maintainer / release loop.** The full gate, run before merge/release.
- **The minimal PR-check Actions workflow** comes first (below). Heavier setups
  (matrix, caching, release/publish automation) are explicitly **out of scope**
  for P44.

### The minimal Actions example (the only YAML on the page)

A single, minimal `pull_request` workflow — `checkout` (with `fetch-depth: 0`
for merge-base), `pnpm install --frozen-lockfile`, then the gate commands. It
assumes the **project-local pinned devDependency** (P42), so it runs the gate
via the installed binary, never `npx code-pact@latest`. The page links to
`cli-contract.md` for the branch-drift `--base-ref` variant and the detector
reference rather than duplicating that YAML.

### `plan lint --include-quality --strict` is explained, not presented as a wall

The page states that `plan lint --include-quality --strict` should be green on
release branches, but that some quality diagnostics are advisory
(`affects_exit: false`) — review guidance, not hard blockers — unless project
policy says otherwise. This prevents a first-time contributor reading it as "every
warning blocks my PR".

### Preconditions checklist

One consolidated checklist: commit `.code-pact/` (ledger + project config) or
force-add `progress.yaml`; `fetch-depth: 0` for merge-base; pin an exact version;
pair `--audit-strict` with `--base-ref <default-branch>`. Each item links to its
canonical home (cli-contract / getting-started) for the full explanation.

## Scope (held small)

- **One new page: `docs/workflows/ci.md`**, plus its **mandatory `docs/ja`
  mirror** (`docs/ja/workflows/ci.md`) — `workflows/*` is in the docs-maintenance
  ja-sync list, so unlike P42 the ja mirror is NOT deferrable; it ships with the
  page. Both get the reciprocal language-switcher line.
- **Hub registration:** one row in `docs/README.md` and one in `docs/ja/README.md`
  (Workflows section).
- **`cli-contract.md` Actions example widened to the full gate** (the one real
  content fix — issue 1 above), kept in its existing canonical section. `ci.md`
  links to it; it is NOT copied into `ci.md`.
- **`docs/maintainers/docs-maintenance.md`:** add the CI page to the doc
  ownership map / ja-sync list so future CI guidance has a registered home.
- The template is delivered as a **fenced YAML block inside `ci.md`**, not a
  committed runnable file (a committed file would fall outside the docs ownership
  map and the ja-mirror rule, growing surface area for no adoption benefit).

## Non-goals

- No new CLI command, flag, detector, or schema. The detectors exist (P33/P34).
- No `init`-scaffolded workflow file / `.code-pact/templates/` artifact.
- No matrix / caching / release / `npm publish` automation in the example.
- No non-GitHub CI provider pages (GitLab/Circle/Jenkins) — the page may state
  the provider-neutral requirements (full history, base-ref, exact pin) in prose,
  but ships only the GitHub Actions example.
- No re-statement of the Actions YAML, envelope shapes, or detector specs that
  `cli-contract.md` owns — `ci.md` links to them (anti-duplication rule).
- No `external-tool` name-drops (constitution / docs convention).

## Definition of done

- `docs/workflows/ci.md` exists: contributor-vs-maintainer loops split; minimal
  PR-check Actions example (project-local pinned binary, no `@latest`); the
  `--include-quality --strict` advisory nuance explained; a consolidated
  preconditions checklist that links to canonical homes; no duplicated YAML/spec.
- `docs/ja/workflows/ci.md` mirror ships in the same change, with the
  language-switcher lines on both.
- `docs/README.md` + `docs/ja/README.md` each gain one Workflows row linking the
  page.
- `cli-contract.md`'s Actions example is widened to the full recommended gate
  (plan lint --strict + plan analyze --strict + finalize --audit-strict
  --base-ref, alongside the existing validate --strict --base-ref).
- `docs/maintainers/docs-maintenance.md` registers the CI page in the ownership
  map / ja-sync list.
- `pnpm check:docs` (links + invariants) passes; `validate` / `plan lint
  --include-quality --strict` / `plan analyze --strict` stay green.
