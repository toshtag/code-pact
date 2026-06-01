# RFC: Project-side version pinning guidance (P42)

- Status: accepted
- Phase: P42
- Date: 2026-05-31

## Problem

The 1.26.0 real-use feedback flagged a reproducibility gap: a consumer that
runs `npx code-pact@latest` (or relies on a global install that floats) can
silently change CLI version between runs, which matters because code-pact's
contract and `state/progress.yaml` semantics evolve across versions. The
feedback's own conclusion — recorded in the post-1.26 backlog — is that pinning
is the **consumer's** responsibility (pin the `devDependency`; stop following
`@latest`), not something code-pact should police with a new self-referential
mechanism.

An audit of the existing docs (recorded below) found that the CI side is already
covered — `docs/cli-contract.md` carries a GitHub Actions example with
`# Pin the version — do NOT track @latest in CI.` and a pinned
`npx -y code-pact@<version>` invocation. What is **missing** is the entry-point
guidance: `docs/getting-started.md` presents only `npm install -g code-pact` and
`npx code-pact …` as install paths, with no `devDependency` pin option and no
statement that teams/CI should prefer it. So the first surface a new consumer
reads does not mention the one practice the feedback says they should adopt.

## Decision

P42 is a **close-out phase, not a build phase.** It records the version-pinning
posture and fills the single real entry-point gap with a minimal docs edit. It
adds **no new mechanism.**

- **Do NOT build `.code-pact/code-pact.version` + a `CODE_PACT_VERSION_MISMATCH`
  diagnostic.** It is self-referential — a version file committed to the repo
  cannot guarantee the *running* CLI matches it, and it drifts silently in
  exactly the unpinned-consumer case it would be meant to catch. The pin must
  live in the consumer's `package.json` (`devDependency`) and their CI, where it
  actually constrains the running binary. This is an explicit **non-goal**, not
  a deferral.
- **Do NOT widen the docs surface.** The audit listed several files that mention
  pinning in passing (README, upgrading.md, migration.md, the `docs/ja` mirror).
  P42 does **not** reconcile all of them — that would re-grow the docs set and
  reintroduce the docs-drift pain P39/P41 just reduced. P42 touches exactly one
  file.

### The one gap P42 fills

`docs/getting-started.md`'s install-facing guidance — its Prerequisites line,
the Install commands, and the alpha/stable-release-line note — is updated so the
exact `devDependency` pin is the recommended path for teams and CI, with
`npm install -g` / `npx` kept for one-off / individual use. It is one file, but
not one line: the three install-facing spots must agree, or the page recommends
pinning and floating at once. This also resolves the mild incoherence the audit
flagged (the entry point recommending a global install while `cli-contract.md`
requires a pinned binary in CI).

## Scope (maintainer-approved)

- **Docs change is limited to `docs/getting-started.md`'s install-facing
  guidance** (Prerequisites + Install commands + the alpha/stable-line note) —
  the added pin block plus the surrounding lines aligned to it. No new
  concept page. The other docs that mention pinning in passing — the root
  `README.md`, `upgrading.md`, `migration.md`, and the `docs/ja` mirror — are
  **not** reconciled here (that is the docs-surface re-growth P42 avoids).
  `cli-contract.md` is not rewritten either, but for a different reason: it
  already carries the CI pin guidance (see Audit), so it needs no change.
- **`docs/ja/getting-started.md` is intentionally NOT synced here.** The ja
  mirror is a known follow-up; widening P42 to translation work would defeat the
  "close small" intent. Recorded as a follow-up note, not done.
- **No code, no schema, no new diagnostic, no CI change.**

## Non-goals

- A `.code-pact/code-pact.version` file or any `CODE_PACT_VERSION_MISMATCH`
  diagnostic / `validate` advisory — rejected as self-referential (see Decision).
- A full reconcile of every doc that mentions pinning — out of scope to avoid
  re-growing the docs surface.
- The `docs/ja` mirror — follow-up.
- Any change to install tags (`latest` / `alpha`) or the dist-tag policy.

## Audit (read, not assumed)

CI pin guidance that **already exists**:

- `docs/cli-contract.md:1661` — `# Pin the version — do NOT track @latest in CI.`
  above a pinned `npx -y code-pact@<version> validate …` GitHub Actions step.

The entry-point gap (**missing**):

- `docs/getting-started.md` Prerequisites + Install — only `npm install -g
  code-pact` and `npx code-pact …`; no `devDependency` pin path, no
  team/CI-prefers-pin statement.

Mild incoherence (resolved by the one edit, not separately reconciled):

- `docs/getting-started.md` leads with a global install while
  `docs/cli-contract.md` requires a pinned binary in CI — a consumer following
  the entry point literally has no path to the CI requirement.

## Definition of done

- `docs/getting-started.md`'s install-facing guidance (Prerequisites + Install
  commands + the alpha/stable-line note) presents the exact `devDependency` pin
  (`npm install --save-dev --save-exact code-pact@<version>`) as the recommended
  path for teams/CI, tells the reader to commit `package.json` + the lockfile,
  keeps the global/npx paths for one-off use, and leaves no line recommending a
  floating `@latest` install.
- This RFC records the `.version`-mechanism non-goal so the backlog question
  ("is the mechanism still coming?") is closed, not left ambiguous.
- The post-1.26 backlog and `design/decisions/README.md` mark P42 shipped
  (docs-first guidance; no new mechanism).
- `pnpm check:docs` and the doc-link/invariant checks pass; `getting-started.md`
  is the only doc changed for *content* (the backlog and the
  `design/decisions/README.md` index rows are control-plane sync — marking P42
  shipped — not new guidance).
