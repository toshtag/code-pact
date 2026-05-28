# RFC: CI branch-drift detection

- Status: accepted
- Phase: P34
- Date: 2026-05-28

## Problem

For code-pact to act as a control plane (not just a local ledger), CI needs to
catch the case where a PR changes real code but never drove the loop — no
progress event was recorded for the work. The existing `CONTROL_PLANE_NOT_DRIVEN`
(v1.25) is **working-tree based**: it inspects uncommitted changes, which are
empty in PR CI after a clean checkout, so it never fires there.

We need a branch-diff signal: compare the PR branch against its base
(`merge-base..HEAD`) and detect "real code changed, but the control plane was
not driven on this branch."

## Decisions

1. **New advisory `CONTROL_PLANE_BRANCH_NOT_DRIVEN`, `--base-ref`-gated.** A new
   `doctor` / `validate` check that runs **only** when `--base-ref <ref>` is
   supplied (default `doctor` / `validate` are a no-op for it). It reuses
   `auditWrites({ baseRef })`'s merge-base mode for the branch diff. The
   existing working-tree `CONTROL_PLANE_NOT_DRIVEN` is unchanged.

2. **Severity `warning`; gate via `validate --strict`.** The check is advisory
   by default — it never changes `doctor` / `validate` exit on its own.
   `validate --strict --base-ref origin/main` promotes it to exit 1 (the
   existing `runValidate` strict semantics already fail on warnings, so no
   severity change is needed). Three-layer opt-in: no `--base-ref` → does not
   run; no `--strict` → does not fail; `disabled_checks` → individually off.
   Rationale: a branch-drift gate is the most false-positive-prone check in the
   tool; shipping it as a hard error would make CI noisy on docs-only /
   config-only / hotfix PRs and teams would disable `validate` entirely. Start
   advisory; let adopters ramp via `--strict`.

3. **Fire only when a KNOWN plan task was NOT driven on the branch — not when
   progress.yaml was merely touched.** The check compares the merge-base and
   HEAD versions of `progress.yaml` and skips only when the branch ADDED at
   least one event that is **all** of: `status` `started` or `done`; `task_id`
   not `TUTORIAL-*`; and `task_id` present in the currently-loaded
   `phases[].tasks[]`. Otherwise it fires — phase-only, unrelated/unknown
   `task_id`, empty, or TUTORIAL-only additions do **not** suppress it. This
   closes the bypass where an agent could touch `progress.yaml` (or append one
   unrelated event) to pass CI. `task.writes`-vs-changed-files matching is
   deliberately out of scope (keeps P34 light).

4. **`started` alone suppresses.** P34 detects **whether the branch used the
   control plane**, not whether every changed file is fully completed. A
   `started` OR `done` event for a known non-TUTORIAL task is therefore enough
   to suppress `CONTROL_PLANE_BRANCH_NOT_DRIVEN`. (`task record-done` also
   records a `done` event, so out-of-loop work recorded honestly counts too.)

5. **False-positive control is team-declared, default-empty.** docs-only /
   config-only PRs are exempted via `.code-pact/doctor.yaml` →
   `control_plane_branch_not_driven: { exclude_globs: [...] }`. No hardcoded
   path classification — `docs/README.md` may not need the ledger while
   `docs/api-contract.md` does; the tool cannot decide that. Default is
   **empty** (nothing excluded); `exclude_globs` is a team's explicit escape
   hatch, not a broad built-in exemption.

6. **Committed-`progress.yaml` precondition; silent skip otherwise.** `.code-pact/`
   is gitignored by default (per-developer runtime state), but CI can only audit
   the ledger via the branch diff if `.code-pact/state/progress.yaml` is
   committed. So the check **silently skips** when `progress.yaml` is not
   git-tracked (`git ls-files` empty) — a repo that does not commit the ledger
   is not cried-wolf at. Docs state: "to use the CI drift gate, commit
   `.code-pact/state/progress.yaml`." code-pact's own repo keeps `.code-pact/`
   gitignored, so this gate is a no-op in its own CI — it is a consumer-repo
   feature.

7. **No `ci scaffold` command.** A 15-line GitHub Actions YAML does not warrant
   a generator. Ship a version-pinned (`npx -y code-pact@<pinned>`, not
   `@latest`) Actions example in the docs instead.

## Non-goals

- No `code-pact ci scaffold` command (decision 7).
- No change to the working-tree `CONTROL_PLANE_NOT_DRIVEN` behavior.
- No hardcoded docs/config path classification (decision 5).
- No `task.writes`-vs-changed-files matching (decision 3 — keeps P34 light).
- Not a hard error by default (decision 2).
