# Releasing

The repeatable steps to cut a release. Most of it is a normal PR; only the
**signed tag** is maintainer-local (it needs the maintainer's signing key).
Publishing is fully automated via GitHub Actions Trusted Publishing; maintainers
do not run a local registry publication command.

`package.json` `files` whitelists `dist/` + `LICENSE`; npm additionally **always**
includes `package.json` and the `README` regardless of `files`. Source under `src/`
and docs other than the README are **not** shipped. So **code changes under `src/`
require a release to reach users; docs under `docs/**`/`design/**` do not** (they
are not shipped — read them in the repo). The one exception is `README.md`: it is
visible in the repo immediately, but the README shown on the **npm package page**
updates only on publish — release a README-only change when that npm-facing copy
matters.

## Pick the version

Semantic versioning, per major line (`MAJOR.MINOR.PATCH`):

- **patch** (`MAJOR.MINOR.patch`) — bug fixes only, no new surface.
- **minor** (`MAJOR.minor.0`) — additive features (new commands/flags/aliases, new
  optional schema fields). Backwards-compatible.
- **major** (`major.0.0`) — a breaking change to a `Stable` surface. Rare; each one
  ships with a migration note in [`docs/upgrading.md` § Major upgrades](../upgrading.md#major-upgrades).

## Release-prep PR (all automatable steps)

On a `chore/release-<version>` branch:

1. **Bump** `package.json` `version`.
2. **Refresh measurements:** `pnpm harness --corpus . --write`. This rewrites
   `docs/maintainers/measurements/` so the snapshot reflects this release (version, git
   SHA, date, and any metric drift). CI enforces that the snapshot's
   `code_pact_cli_version` matches `package.json` (see `check:doc-invariants`),
   so this step cannot be silently skipped. `docs/positioning.md` points at the
   snapshot rather than copying numbers, so it needs no edit.
3. **CHANGELOG:** add a `## [<version>] — <date>` section (Keep a Changelog
   format: Added / Changed / Fixed). Lead with the user-facing shipped change.
   On a **major bump**, roll older majors out of `CHANGELOG.md` into
   `docs/maintainers/history/CHANGELOG-<major>.md` with `pnpm changelog:archive`
   (verbatim move, not a delete; leaves a pointer). `check:changelog-archive`
   (part of `check:docs`) fails if an older major is still inline, so this is
   not silently skipped.
4. **Docs-sync audit** — confirm everything shipped since the last tag followed
   the [docs ownership map](docs-maintenance.md#ownership-map--what-to-update-for-which-change).
   `check:docs` covers links, invariants, history-noise, and generated-reference
   drift, but one rule is
   [deliberately manual](docs-maintenance.md#deliberately-not-auto-enforced-verify-by-hand-at-release-prep) — confirm it now:
   - every new **user-recoverable** error/diagnostic code has a
     `troubleshooting.md` recovery entry.

   (There is no `docs/ja/` mirror to sync — `docs/ja/` is an entry point only.)

   ```sh
   git diff <last-tag>..HEAD --name-only -- docs/ design/decisions/
   # scan for: new error codes without a troubleshooting entry.
   ```

5. **Verify** — one command, the release gate:
   ```sh
   pnpm release:check
   ```
   `release:check` (in `package.json`) runs typecheck, the full test suite,
   build, `check:docs` (links + invariants + history-noise + generated-reference drift),
   `check:release-version` (package.json ↔ CHANGELOG ↔ measurements agree),
   then `validate --json`, `plan lint --include-quality --strict --json`, and
   `plan analyze --strict --json`. This is the single source of the release
   gate — don't re-list the steps here, or the runbook drifts from the script.
6. Open the PR; merge once CI is green.

## Tag + publish (automated via GitHub Actions)

After the release-prep PR merges to `main`:

7. **SSH-signed annotated tag** on the merge commit. `SECURITY.md` requires
   stable releases to use SSH-signed tags (so the GitHub tag page shows
   "Verified"); use `-s` (not `-a`, which is annotated but not signed).
   Lightweight tags are rejected by the publish workflow; signing setup is in
   [CONTRIBUTING](../../CONTRIBUTING.md#tag-signing-maintainer-only):
   ```sh
   git tag -s v<version> -m "v<version> — <theme>"
   git verify-tag v<version>   # expect a good signature before pushing
   git push origin v<version>
   ```
8. **Approve the publish workflow.** Pushing the tag triggers
   `.github/workflows/publish.yml`. The workflow has four jobs with strict
   permission separation:

   | Job              | Permissions                         | Runs                                                                                                               |
   | ---------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
   | `prepare`        | `contents: read`                    | checkout, tag verification, `release:check`, tarball build + inspection, release notes generation, artifact upload |
   | `publish`        | `contents: read`, `id-token: write` | artifact download, manifest verification, `npm publish --ignore-scripts` (no checkout, no repository code)         |
   | `verify`         | `contents: read`                    | artifact download, registry tarball download + byte verification, integrity report upload                          |
   | `github-release` | `contents: write`                   | artifact download, `gh release create/edit` (no checkout, no repository code)                                      |

   Approve the deployment in the GitHub Actions UI (the `publish` job runs in
   the `npm-publish` GitHub Environment with required reviewers). The workflow
   then:
   - **prepare** verifies the signed annotated tag (`check-release-tag.mjs`),
     runs `pnpm release:check`, builds and inspects the exact tarball
     (`check-package-tarball.mjs`), generates release notes, and uploads the
     artifact,
   - **publish** downloads the verified artifact and publishes it via npm
     Trusted Publishing (OIDC, no npm token) with `--ignore-scripts`,
   - **verify** downloads the registry tarball and verifies its bytes
     (`verify-published-tarball.mjs`),
   - **github-release** creates a GitHub Release with an auto-generated
     `## Integrity` section.

9. **Verify.** After the workflow succeeds:
   - Check the npm package page for the provenance badge.
   - Check the GitHub Release for the auto-generated Integrity section
     (shasum, integrity, local SHA-256, provenance note).

## One-time security setup

These steps are performed once by a repository administrator. They cannot be
verified from code alone — attach evidence (screenshots or API output) to the
rollout PR.

### GitHub Environment: `npm-publish`

1. **Create** a GitHub Environment named `npm-publish` (Settings → Environments).
2. **Required reviewers:** add the maintainer or release team.
3. **Prevent self-review:** enabled — the person who pushed the tag cannot
   approve their own deployment.
4. **Allow administrators to bypass:** disabled — no bypass.
5. **Deployment branches and tags:** selected tags → `v*` only.

### npm Trusted Publisher

Configure at [npmjs.com](https://www.npmjs.com/) → package settings →
Trusted Publishing:

1. **Provider:** GitHub Actions.
2. **Repository:** `toshtag/code-pact` (or the target repository).
3. **Workflow filename:** `publish.yml`.
4. **Environment:** `npm-publish`.
5. **Allowed action:** `npm publish` only.

### After first successful publish

1. **Revoke** any existing npm automation tokens (Access Tokens → delete).
2. **Remove** `NPM_TOKEN` from GitHub repository secrets (if it existed).
3. **Disable token-based publish** in the npm package settings (require Trusted
   Publishing only).
4. **Confirm** maintainer accounts have 2FA enabled.

## What does NOT need a release

- Documentation under `docs/**` and `design/**` — not shipped; already in the repo
  on merge.
- `README.md` is the exception: it is visible in the repo immediately, but the README
  shown on the **npm package page** updates only on publish — release a README-only
  change only when that npm-facing copy matters.
- CI scripts / dev dependencies — not in the published package.
