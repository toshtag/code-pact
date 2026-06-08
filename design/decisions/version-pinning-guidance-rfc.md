# RFC: Project-side version pinning guidance (P42)

**Status:** accepted (P42, 2026-05)
**Scope:** docs-only close-out. Records the version-pinning posture and fills one entry-point gap in `docs/getting-started.md`. No code, schema, diagnostic, or CI change.
**Owners:** maintainer
**Related:** post-1.26 backlog — `docs/maintainers/history/post-1.26-agent-dx-backlog.md` (the reproducibility-gap feedback) · `docs/cli-contract.md` (already carries the CI pin guidance) · `docs/getting-started.md` (the one file P42 edits).

## Summary

`npx code-pact@latest` (or a floating global install) can silently change CLI version between runs — and code-pact's contract and `state/progress.yaml` semantics evolve across versions. The 1.26.0 feedback's own conclusion: **pinning is the consumer's responsibility** (pin the `devDependency`; stop following `@latest`), not something code-pact should police with a new self-referential mechanism. CI is already covered (`docs/cli-contract.md` pins the binary and says "do NOT track @latest in CI"). The one real gap is the entry point: `docs/getting-started.md` offered only `npm install -g` / `npx` — no `devDependency` pin path. P42 is a close-out phase that fills exactly that gap.

## Decision

P42 records the posture and fills the single entry-point gap with a minimal docs edit. It adds **no new mechanism** and touches exactly one file.

- **Do NOT build `.code-pact/code-pact.version` + a `CODE_PACT_VERSION_MISMATCH` diagnostic.** *Rationale:* it is self-referential — a version file committed to the repo cannot guarantee the *running* CLI matches it, and it drifts silently in exactly the unpinned-consumer case it would be meant to catch. The pin must live in the consumer's `package.json` (`devDependency`) and their CI, where it actually constrains the running binary. Explicit **non-goal**, not a deferral.
- **Do NOT widen the docs surface.** *Rationale:* several files mention pinning in passing (README, `upgrading.md`, `migration.md`, the `docs/ja` mirror). Reconciling all of them would re-grow the docs set and reintroduce the docs-drift pain P39/P41 just reduced. P42 touches exactly one file.
- **Fill the one gap in `docs/getting-started.md`.** Its install-facing guidance (Prerequisites + Install commands + the alpha/stable-release-line note) now presents the exact `devDependency` pin — `npm install --save-dev --save-exact code-pact@<version>` — as the recommended path for teams/CI, tells the reader to commit `package.json` + the lockfile, and keeps `npm install -g` / `npx` for one-off / individual use. *Rationale:* it is one file but not one line — the three install-facing spots must agree or the page recommends pinning and floating at once. This also resolves the mild incoherence between the entry point (leading with a global install) and `cli-contract.md` (which requires a pinned binary in CI).

## Non-goals

- A `.code-pact/code-pact.version` file or any `CODE_PACT_VERSION_MISMATCH` diagnostic / `validate` advisory — rejected as self-referential (see Decision).
- A full reconcile of every doc that mentions pinning (README, `upgrading.md`, `migration.md`) — out of scope to avoid re-growing the docs surface.
- The `docs/ja/getting-started.md` mirror — intentionally not synced here; a known follow-up, recorded not done.
- Any change to install tags (`latest` / `alpha`) or the dist-tag policy.

## Alternatives considered

- **A committed `.version` file + version-mismatch diagnostic** — rejected; self-referential (cannot bind the *running* CLI) and drifts in the exact unpinned case it targets. The pin belongs in the consumer's `package.json` + CI.
- **Reconcile all docs that mention pinning at once** — rejected; re-grows the docs surface and reintroduces the docs-drift the prior phases reduced. Close small instead.
- **Rewrite `cli-contract.md` too** — rejected; it already carries the CI pin guidance, so it needs no change.

## References

- Backlog / feedback: `docs/maintainers/history/post-1.26-agent-dx-backlog.md`.
- CI pin guidance (already present): `docs/cli-contract.md` — `# Pin the version — do NOT track @latest in CI.` above a pinned `npx -y code-pact@<version> validate …` GitHub Actions step.
- Entry-point edit: `docs/getting-started.md` (Prerequisites + Install commands + alpha/stable-line note).
