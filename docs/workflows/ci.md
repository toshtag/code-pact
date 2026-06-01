# Running code-pact in CI

This page is the single home for wiring code-pact into CI. It **sequences and
links** the pieces — it does not restate them. The detectors it relies on already
exist (`CONTROL_PLANE_*`, branch-drift; see [`cli-contract.md`](../cli-contract.md#error-codes)).

If you only want the per-command reference (flags, JSON envelopes, the
branch-drift `--base-ref` mechanics), read [`cli-contract.md`](../cli-contract.md);
for the install/pinning rationale, read [`getting-started.md`](../getting-started.md).
This page is about **which checks to run, when, and what must be true first.**

## Two loops, not one

code-pact's checks are not a "run everything on every commit" ritual. Split them:

- **Contributor loop — before opening a PR.** Run the checks relevant to your
  change. A docs-only change does not need the full plan-integrity sweep; a phase
  or task change does. You do not have to run the whole suite on every commit.
- **Maintainer / release loop.** Run the full gate before merge or release. This
  is where the strict promotions below belong.

## The minimal PR check (GitHub Actions)

A single `pull_request` workflow that runs the gate. It assumes you pinned
code-pact as an **exact project devDependency** (see
[`getting-started.md`](../getting-started.md)), so it runs the
project-local binary — it never floats on `@latest`.

```yaml
# .github/workflows/code-pact.yml
name: code-pact
on:
  pull_request:
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # full history — merge-base for --base-ref
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile     # installs the pinned code-pact
      - run: pnpm exec code-pact validate --strict --base-ref origin/${{ github.base_ref }} --json
      - run: pnpm exec code-pact plan lint --include-quality --strict --json
      - run: pnpm exec code-pact plan analyze --strict --json
```

That is the whole minimal gate. Heavier setups — a build matrix, dependency
caching beyond the above, release/publish automation — are intentionally out of
scope here; add them per your project's own conventions.

> Not on GitHub Actions? The same requirements are provider-neutral: fetch the
> **full git history** (for the merge-base), expose the **base ref** to the
> command, and run the **pinned** binary. Translate the steps above into your
> provider's syntax.

## What each check gates

- **`validate --strict --base-ref <default-branch>`** — project integrity plus
  the P34 branch-drift gate (`CONTROL_PLANE_BRANCH_NOT_DRIVEN`): code changed on
  the branch without driving the loop. `--strict` promotes warnings to exit 1.
  Mechanics: [`cli-contract.md`](../cli-contract.md#--base-ref-and-ci-branch-drift-gating-v126-p34).
- **`plan lint --include-quality --strict`** — plan/schema integrity. Aim for
  this to be **green on release branches**. Note: some `--include-quality`
  diagnostics are **advisory** (`affects_exit: false`) — review guidance, not
  hard blockers — so a clean exit does not require resolving every one of them
  unless your project policy says so.
- **`plan analyze --strict`** — promotes plan-analysis warnings to exit 1 (status
  drift, dependency issues).
- **`task finalize <id> --audit-strict --base-ref <default-branch>`** *(optional,
  per advanced task)* — the declared-writes audit. Pair `--audit-strict` with
  `--base-ref` so a clean working tree does not fire `DECLARED_UNUSED`. See
  [`task-readiness-fields.md`](../concepts/task-readiness-fields.md).

## Preconditions checklist

The most common CI surprise is a gate that silently skips or mis-fires. Before
the workflow above will do anything useful:

- [ ] **Commit `.code-pact/`** — the project config **and** `state/progress.yaml`.
      `init` does not gitignore it. The branch-drift gate reads the *committed*
      `progress.yaml`; if the ledger is untracked the check **silently skips**.
      If your repo deliberately ignores `.code-pact/`, force-add the ledger:
      `git add -f .code-pact/state/progress.yaml`. Full note:
      [`cli-contract.md`](../cli-contract.md#--base-ref-and-ci-branch-drift-gating-v126-p34).
- [ ] **`fetch-depth: 0`** — `--base-ref` compares against the merge-base, which
      needs full history. A shallow checkout breaks it.
- [ ] **Pin an exact version** — pin code-pact as a `devDependency`
      (`--save-exact`) and commit the lockfile, so every run resolves the same
      CLI. See [`getting-started.md`](../getting-started.md).
- [ ] **Pair `--audit-strict` with `--base-ref`** — without it, a clean CI
      checkout reports `DECLARED_UNUSED` for every task that declared writes.

## See also

- [`cli-contract.md`](../cli-contract.md) — the command/flag/envelope reference and the branch-drift gate mechanics.
- [`getting-started.md`](../getting-started.md) — install + exact-version pinning.
- [`maintainers/operations.md`](../maintainers/operations.md) — the maintainer planning-integrity and release-prep posture.
