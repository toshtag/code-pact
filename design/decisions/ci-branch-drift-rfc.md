# RFC: CI branch-drift detection

**Status:** accepted (P34, 2026-05)
**Scope:** new advisory `CONTROL_PLANE_BRANCH_NOT_DRIVEN` check on `doctor` / `validate`, gated by `--base-ref`; team-declared `exclude_globs` via `.code-pact/doctor.yaml`; committed-`progress.yaml` precondition. No new command.
**Owners:** maintainer
**Related:** [governance](governance-rfc.md) (advisory `LOCK_HELD`) · [collaboration-safe-state](collaboration-safe-state-rfc.md) (committed-ledger precondition) · [control-plane-v2](control-plane-v2-rfc.md) (carries forward this precondition).

## Summary

A branch-diff signal for PR CI: compare the PR branch against its base (`merge-base..HEAD`) and detect "real code changed, but the control plane was not driven on this branch." The existing working-tree `CONTROL_PLANE_NOT_DRIVEN` (v1.25) inspects uncommitted changes, which are empty after a clean PR checkout, so it never fires in CI — this fills that gap. A consumer-repo feature: it requires the ledger to be committed.

## Decisions

1. **New advisory `CONTROL_PLANE_BRANCH_NOT_DRIVEN`, `--base-ref`-gated.** A `doctor` / `validate` check that runs **only** when `--base-ref <ref>` is supplied (a no-op otherwise). Reuses `auditWrites({ baseRef })`'s merge-base mode for the branch diff. The working-tree `CONTROL_PLANE_NOT_DRIVEN` is unchanged.

2. **Severity `warning`; gate via `validate --strict`.** Advisory by default — never changes `doctor` / `validate` exit on its own. `validate --strict --base-ref origin/main` promotes it to exit 1 (existing `runValidate` strict semantics already fail on warnings; no severity change needed). Three-layer opt-in: no `--base-ref` → does not run; no `--strict` → does not fail; `disabled_checks` → individually off. *Rationale:* a branch-drift gate is the most false-positive-prone check in the tool; a hard default would make CI noisy on docs/config/hotfix PRs and teams would disable `validate` entirely. Start advisory; let adopters ramp via `--strict`.

3. **Fire only when a KNOWN plan task was NOT driven on the branch — not when `progress.yaml` was merely touched.** Compare the merge-base and HEAD versions of `progress.yaml`; suppress only when the branch ADDED at least one event that is **all** of: `status` `started` or `done`; `task_id` not `TUTORIAL-*`; and `task_id` present in the currently-loaded `phases[].tasks[]`. Otherwise it fires — phase-only, unrelated/unknown `task_id`, empty, or TUTORIAL-only additions do **not** suppress it. Closes the bypass where an agent touches `progress.yaml` (or appends one unrelated event) to pass CI. `task.writes`-vs-changed-files matching is deliberately out of scope (keeps P34 light).

4. **`started` alone suppresses.** P34 detects **whether the branch used the control plane**, not whether every changed file is fully completed. A `started` OR `done` event for a known non-TUTORIAL task suffices. (`task record-done` also records a `done` event, so out-of-loop work recorded honestly counts too.)

5. **False-positive control is team-declared, default-empty.** docs-only / config-only PRs are exempted via `.code-pact/doctor.yaml` → `control_plane_branch_not_driven: { exclude_globs: [...] }`. No hardcoded path classification — `docs/README.md` may not need the ledger while `docs/api-contract.md` does; the tool cannot decide that. Default is **empty** (nothing excluded); `exclude_globs` is an explicit escape hatch, not a broad built-in exemption.

6. **Committed-`progress.yaml` precondition; silent skip otherwise.** `.code-pact/` is gitignored by default (per-developer runtime state), but CI can only audit the ledger via the branch diff if `.code-pact/state/progress.yaml` is committed. The check **silently skips** when `progress.yaml` is not git-tracked (`git ls-files` empty) — a repo that does not commit the ledger is not cried-wolf at. Docs: "to use the CI drift gate, commit `.code-pact/state/progress.yaml`." code-pact's own repo keeps `.code-pact/` gitignored, so this gate is a no-op in its own CI.

7. **No `ci scaffold` command.** A 15-line GitHub Actions YAML does not warrant a generator. Ship a version-pinned (`npx -y code-pact@<pinned>`, not `@latest`) Actions example in the docs instead.

## Alternatives considered

- **Hard error by default** — rejected (decision 2); the most false-positive-prone check shipping as a hard error would push teams to disable `validate`. Advisory + `--strict` ramp instead.
- **Hardcoded docs/config path classification** — rejected (decision 5); the tool cannot know which docs need the ledger. Team-declared `exclude_globs`, default-empty.
- **`task.writes`-vs-changed-files matching** — rejected (decision 3); keeps P34 light. Presence of a driven known task is the signal.
- **`code-pact ci scaffold` command** — rejected (decision 7); a 15-line YAML is a docs example, not a generator.

## References

- RFCs: [governance](governance-rfc.md) · [collaboration-safe-state](collaboration-safe-state-rfc.md) · [control-plane-v2](control-plane-v2-rfc.md) · [stability-taxonomy](stability-taxonomy.md) (`CONTROL_PLANE_BRANCH_NOT_DRIVEN` severity/surface).
- Docs: [docs/cli-contract.md](../../docs/cli-contract.md).
