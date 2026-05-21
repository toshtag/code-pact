<!--
  Thanks for opening a PR.

  Replace the placeholder text below before submitting. The checklist
  near the bottom is required for any PR that touches CLI behaviour,
  the JSON contract, error codes, or user-visible docs.
-->

## Summary

<!-- One or two sentences. What changed and why. -->

## Test plan

- [ ] `pnpm typecheck`
- [ ] `pnpm test:unit`
- [ ] `pnpm test:integration`
- [ ] `pnpm build`
- [ ] Relevant `code-pact` self-checks (typically `plan lint --include-quality --strict --json`, `plan analyze --strict --json`, `validate --json`, `doctor --json` — pick the subset that applies)

## Contract checklist

- [ ] **No Stable (v1.0) contract change** — no rename / removal / shape change to any flag, exit code, JSON envelope, error code, or human-stdout/stderr surface classified `Stable (v1.0)` or `Stable (human-output)` in [`docs/cli-contract.md`](../docs/cli-contract.md). If unchecked, explain below why the change is safe (additive, behind a new flag, etc.).
- [ ] **Docs updated** if the change is user-visible. New flags / new commands → `docs/cli-contract.md`. New onboarding surface → `docs/getting-started.md`. Migration relevance → `docs/migration.md`.
- [ ] **Atomic-write contract preserved** if writing to `design/` or `.code-pact/state/` — go through `src/io/atomic-text.ts` (see [`docs/cli-contract.md` § State file write guarantees](../docs/cli-contract.md#state-file-write-guarantees)).
- [ ] **No new runtime dependency** added without an explicit RFC. See [Runtime dependency policy in CONTRIBUTING.md](../CONTRIBUTING.md#runtime-dependency-policy).

## Scope notes

<!--
  Optional. Use this section to call out anything reviewers should
  know: deliberate omissions, deferred follow-ups, related issues,
  what is intentionally out of scope.
-->
