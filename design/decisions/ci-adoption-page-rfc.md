# RFC: CI / adoption page (P44)

**Status:** accepted (P44, 2026-06)
**Scope:** docs-only — one new usage page `docs/workflows/ci.md` (+ mandatory `docs/ja` mirror) as the single CI-adoption home; removal of the runnable Actions YAML from `cli-contract.md`; hub + docs-ownership registration. No new CLI surface, detector, or code change.
**Owners:** maintainer
**Related:** task-readiness-schema-rfc.md (`writes` + `TASK_WRITES_PROTECTED_PATH`) · the P33/P34 `CONTROL_PLANE_*` / branch-drift detectors this page sequences (no new machinery). Same "value the consumer can't find" theme as P39–P43: the gap is a findable adoption home.

## Summary

Running code-pact in CI today means assembling the recipe from ~six docs (`cli-contract.md`, `troubleshooting.md`, `maintainers/operations.md`, `dogfood.md`, `getting-started.md`, `workflows/brownfield-feature.md`), and `docs/README.md` has no CI entry. Add one **thin orchestration page** that sequences and links the existing facts without re-stating them.

## Decision

Add **`docs/workflows/ci.md`** as the single adoption home for running code-pact in CI, registered in the docs hub. It sequences and links existing facts; it introduces no new CLI surface, detector, or code.

- **Contributor-vs-maintainer split.** The page is explicitly split so it never reads as "run everything on every commit": a *contributor loop* (run the checks relevant to your change, before a PR) and a *maintainer/release loop* (the full gate, before merge/release). RATIONALE: prevents a first-time contributor reading the full gate as a mandatory per-commit ritual.
- **One minimal Actions example (the only YAML on the page).** A single `pull_request` workflow — `checkout` with `fetch-depth: 0` (for merge-base), `pnpm install --frozen-lockfile`, then the gate commands. It runs the gate via the **project-local pinned devDependency** (P42), never `npx code-pact@latest`. RATIONALE: pinned binary is reproducible; `@latest` drifts. The full recommended gate is `validate --strict --base-ref` + `plan lint --include-quality --strict` + `plan analyze --strict` + `task finalize --audit-strict --base-ref`. The page links to `cli-contract.md` for the `--base-ref` branch-drift variant and detector reference rather than duplicating that YAML.
- **`--include-quality --strict` explained, not presented as a wall.** The page states it should be green on release branches, but that some quality diagnostics are advisory (`affects_exit: false`) — review guidance, not hard blockers — unless project policy says otherwise. RATIONALE: stops a reader treating every warning as a PR-blocker.
- **Consolidated preconditions checklist.** One list: commit `.code-pact/` (ledger + project config) or force-add `progress.yaml` (else the gate silently skips); `fetch-depth: 0` for merge-base; pin an exact version; pair `--audit-strict` with `--base-ref <default-branch>` (else `DECLARED_UNUSED` fires without `--base-ref`). Each item links to its canonical home. RATIONALE: the preconditions that cause the most common CI failures are otherwise scattered footnotes.
- **The one real content move: `cli-contract.md` loses its runnable Actions YAML.** Its CI section keeps the `--base-ref` contract + diagnostics and links to `ci.md`; `ci.md` owns the one canonical template. RATIONALE: anti-duplication — there is exactly one Actions workflow in the docs, and `ci.md` is not a copy of a cli-contract block.
- **The ja mirror is NOT deferrable.** `workflows/*` is in the docs-maintenance ja-sync list, so `docs/ja/workflows/ci.md` (+ reciprocal language-switcher line) ships with the page — unlike P42. Hub: one Workflows row in `docs/README.md` and one in `docs/ja/README.md`. `docs/maintainers/docs-maintenance.md` registers the page in the ownership / ja-sync map.
- **Template lives as a fenced YAML block inside `ci.md`**, not a committed runnable file. RATIONALE: a committed file would fall outside the docs ownership map and the ja-mirror rule, growing surface for no adoption benefit.

## Alternatives considered (non-goals)

- **A new CLI command / flag / detector / schema** — rejected; the detectors already exist (P33/P34). The gap is findability, not machinery.
- **An `init`-scaffolded workflow file / `.code-pact/templates/` artifact** — rejected; see "template as fenced block" rationale (ownership/ja-mirror surface).
- **Matrix / caching / release / `npm publish` automation in the example** — rejected; out of scope for P44, which ships the minimal PR-check workflow only.
- **Non-GitHub CI provider pages (GitLab/Circle/Jenkins)** — rejected; the page may state provider-neutral requirements (full history, base-ref, exact pin) in prose, but ships only the GitHub Actions example.
- **A second copy of the Actions workflow, or re-stating the envelope/detector specs `cli-contract.md` owns** — rejected; the anti-duplication rule (`ci.md` owns the one template, `cli-contract.md` links to it).
- **`external-tool` name-drops** — excluded per the constitution / docs convention.

## References

- Docs: `docs/workflows/ci.md` (the new page) + `docs/ja/workflows/ci.md` (mirror) · `docs/cli-contract.md` (the `--base-ref` contract + detector reference it now links to) · `docs/README.md` / `docs/ja/README.md` (hub) · `docs/maintainers/docs-maintenance.md` (ownership / ja-sync map).
- Verify: `pnpm check:docs` (links + invariants); `validate` / `plan lint --include-quality --strict` / `plan analyze --strict` stay green.
