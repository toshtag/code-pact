<!--
  Thanks for opening a PR.

  Replace the placeholder text below before submitting. The checklist
  near the bottom is required for any PR that touches CLI behaviour,
  the JSON contract, error codes, or user-visible docs.
-->

## Summary

<!-- One or two sentences. What changed and why. -->

## Surface self-report

<!--
  Enumerate the surfaces this PR touches (write "—" / "N/A" when none). The
  point is to force the surface inventory at authoring time — the 1.26.0 review
  found schema constraints applied to read schemas but missed on write
  entrypoints, and docs reconciled while CLI help drifted, precisely because no
  one enumerated these up front (P38).
-->

| Surface | Changed? (what / N/A) |
| --- | --- |
| Public contract (flag / exit code / JSON envelope / error code) | |
| Command surface (new or changed command/flag) | |
| Docs / CLI help surface | |
| Schema / validation boundary | |
| Write entrypoints (an id/path/agent flowing to a filesystem path or command) | |
| Invariant / regression tests added | |
| Trust-boundary impact (execution / path / identifier) | |

## Test plan

- [ ] `pnpm typecheck`
- [ ] `pnpm test:unit`
- [ ] `pnpm test:integration`
- [ ] `pnpm build`
- [ ] Relevant `code-pact` self-checks (typically `plan lint --include-quality --strict --json`, `plan analyze --strict --json`, `validate --json`, `doctor --json` — pick the subset that applies)

## Contract checklist

- [ ] **No Stable (v1.0) contract change** — no rename / removal / shape change to any flag, exit code, JSON envelope, error code, or human-stdout/stderr surface classified `Stable (v1.0)` or `Stable (human-output)` in [`docs/cli-contract.md`](../docs/cli-contract.md). If unchecked, explain below why the change is safe (additive, behind a new flag, etc.).
- [ ] **Docs updated** if the change is user-visible. New flags / new commands → `docs/cli-contract.md`. New onboarding surface → `docs/getting-started.md`. Upgrade relevance → `docs/upgrading.md`.
- [ ] **Atomic-write contract preserved** if writing to `design/` or `.code-pact/state/` — go through `src/io/atomic-text.ts` (see [`docs/cli-contract.md` § State file write guarantees](../docs/cli-contract.md#state-file-write-guarantees)).
- [ ] **No new runtime dependency** added without an explicit RFC. See [Runtime dependency policy in CONTRIBUTING.md](../CONTRIBUTING.md#runtime-dependency-policy).

## Scope notes

<!--
  Optional. Use this section to call out anything reviewers should
  know: deliberate omissions, deferred follow-ups, related issues,
  what is intentionally out of scope.
-->
