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

- [ ] Normal PR gate: `pnpm test:ci`
- [ ] High-risk / release / security / process-control changes: `pnpm test:ci:deep`
- [ ] Targeted tests relevant to the changed surface

## Contract checklist

- [ ] **No Stable (v1.0) contract change** — no rename / removal / shape change to any flag, exit code, JSON envelope, error code, or human-stdout/stderr surface classified `Stable (v1.0)` or `Stable (human-output)` in [`docs/cli-contract.md`](../docs/cli-contract.md). If unchecked, explain below why the change is safe (additive, behind a new flag, etc.).
- [ ] **Docs updated** if the change is user-visible:
  - Task command / flag → edit `src/cli/spec/*` (the `CommandSpec`) and run `pnpm gen:cli-reference`; parse, help, and the generated reference all derive from it — do **not** hand-write the task flag table into `docs/cli-contract.md`.
  - Plan / phase / adapter command or flag → edit `src/cli/spec/<cluster>.ts` and run `pnpm gen:cli-reference`; keep `docs/cli-contract.md` to semantics, not basic flag tables/examples.
  - Non-migrated non-task command / flag → update the command's rich leaf help in `src/cli/usage.ts` (a mutating/JSON-emitting command must not ship as a stub — see `tests/unit/cli/leaf-help-coverage.test.ts`) + its semantics in `docs/cli-contract.md`.
  - JSON envelope / error code / exit semantics → `docs/cli-contract.md`. User-recoverable error → `docs/troubleshooting.md`.
  - New onboarding surface → `docs/getting-started.md`. Upgrade relevance → `docs/upgrading.md`.
- [ ] **Atomic-write contract preserved** if writing to `design/` or `.code-pact/state/` — go through `src/io/atomic-text.ts` (see [`docs/cli-contract.md` § State file write guarantees](../docs/cli-contract.md#state-file-write-guarantees)).
- [ ] **No new runtime dependency** added without an explicit RFC. See [Runtime dependency policy in CONTRIBUTING.md](../CONTRIBUTING.md#runtime-dependency-policy).

## Scope notes

<!--
  Optional. Use this section to call out anything reviewers should
  know: deliberate omissions, deferred follow-ups, related issues,
  what is intentionally out of scope.
-->
