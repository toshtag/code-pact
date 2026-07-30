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
2. **CHANGELOG:** add a `## [<version>] — <date>` section (Keep a Changelog
   format: Added / Changed / Fixed). Lead with the user-facing shipped change.
   On a **major bump**, roll older majors out of `CHANGELOG.md` into
   `docs/maintainers/history/CHANGELOG-<major>.md` with `pnpm changelog:archive`
   (verbatim move, not a delete; leaves a pointer). `check:changelog-archive`
   (part of `check:docs`) fails if an older major is still inline, so this is
   not silently skipped.
3. **Docs-sync audit** — confirm everything shipped since the last tag followed
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

4. **Verify** — one command, the release gate:
   ```sh
   pnpm release:check
   ```
   `release:check` (in `package.json`) runs typecheck, the full test suite,
   build, `check:docs` (links + invariants + history-noise + generated-reference drift),
   `check:release-version` (package.json ↔ CHANGELOG ↔ docs examples agree),
   then `validate --json`, `plan lint --include-quality --strict --json`, and
   `plan analyze --strict --json`. This is the single source of the release
   gate — don't re-list the steps here, or the runbook drifts from the script.
5. Open the PR; merge once CI is green.

## Tag + publish (automated via GitHub Actions)

After the release-prep PR merges to `main`:

6. **SSH-signed annotated tag** on the merge commit. `SECURITY.md` requires
   stable releases to use SSH-signed tags (so the GitHub tag page shows
   "Verified"); use `-s` (not `-a`, which is annotated but not signed).
   Lightweight tags are rejected by the publish workflow; signing setup is in
   [CONTRIBUTING](../../CONTRIBUTING.md#tag-signing-maintainer-only):
   ```sh
   git tag -s v<version> -m "v<version> — <theme>"
   git verify-tag v<version>   # expect a good signature before pushing
   git push origin v<version>
   ```
7. **The publish workflow runs.** Pushing the verified signed tag starts
   `.github/workflows/publish.yml` — **the signed tag is the release
   authorization**, and in a single-maintainer repository publication proceeds
   from there without a further approval step. The workflow has four jobs with
   strict permission separation:

   | Job              | Permissions                         | Runs                                                                                                                                                  |
   | ---------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `prepare`        | `contents: read`                    | checkout, tag verification, exact-SHA CI verification, release-specific checks, tarball build + inspection, release notes generation, artifact upload |
   | `publish`        | `contents: read`, `id-token: write` | artifact download, manifest verification, `npm publish --ignore-scripts` (no checkout, no repository code)                                            |
   | `verify`         | `contents: read`                    | artifact download, registry tarball download + byte verification, integrity report upload                                                             |
   | `github-release` | `contents: write`                   | artifact download, `gh release create/edit` (no checkout, no repository code)                                                                         |

   The `publish` job runs in the `npm-publish` GitHub Environment, which exists
   as the OIDC environment binding npm Trusted Publishing is configured against
   — not as an approval gate. The workflow then:
   - **prepare** verifies the signed annotated tag (`check-release-tag.mjs`),
     verifies that the `CI status` check passed for the exact commit SHA
     (`check-required-ci-for-sha.mjs`), runs release-specific supply-chain and
     version checks, builds and inspects the exact tarball
     (`check-package-tarball.mjs`), generates release notes, and uploads the
     artifact,
   - **publish** downloads the verified artifact and publishes it via npm
     Trusted Publishing (OIDC, no npm token) with `--ignore-scripts`,

     > **OIDC note:** The `publish` job does **not** pass `registry-url` to
     > `actions/setup-node`. Setting `registry-url` generates an `.npmrc` entry
     > referencing `NODE_AUTH_TOKEN`; when that token is absent (as it is with
     > Trusted Publishing), npm may attempt legacy token auth instead of OIDC
     > and fail with `ENEEDAUTH`. The npm registry endpoint is fixed via the
     > `--registry` CLI flag on both `npm view` and `npm publish` to prevent
     > `NPM_CONFIG_REGISTRY` environment variable overrides.

   - **verify** downloads the registry tarball and verifies its bytes
     (`verify-published-tarball.mjs`),
   - **github-release** creates a GitHub Release with an auto-generated
     `## Integrity` section.

   > **On approval gates.** A repository with an **independent** release
   > reviewer may additionally configure GitHub Environment required reviewers
   > on `npm-publish`. That is a separation-of-duty control, and it only
   > separates duties when the approver is not the person who pushed the tag —
   > the same maintainer pushing a tag and then approving their own deployment
   > adds a click, not a boundary. If you enable it, record who may approve,
   > whether self-review is prevented, and how a release proceeds when that
   > reviewer is unavailable; otherwise the control becomes an availability
   > risk instead of a security one.

8. **Verify.** After the workflow succeeds:
   - Check the npm package page for the provenance badge.
   - Check the GitHub Release for the auto-generated Integrity section
     (shasum, integrity, local SHA-256, provenance note).

## One-time security setup

These steps are performed once by a repository administrator, and they live
outside the repository: **no check in this repo can verify them.**
`check-supply-chain-invariants.mjs` verifies that the workflow declares
`environment: npm-publish` and the per-job permission map — it cannot see the
environment's protection rules, the deployment tag policy, or the npm Trusted
Publisher fields. Those are only ever as configured as someone last left them,
so verify them directly (below) rather than inferring them from a green gate.

### GitHub Environment: `npm-publish` — required

1. **Create** a GitHub Environment named `npm-publish` (Settings → Environments).
2. **Deployment branches and tags:** selected tags → `v*` only.
3. The name must match the **Environment** field of the npm Trusted Publisher
   configuration exactly; that pairing is what the OIDC exchange binds to.

### GitHub Environment: `npm-publish` — optional

These are separation-of-duty controls. They are worth configuring only when an
**independent** reviewer exists; with a single maintainer they add a step
without adding a boundary.

1. **Required reviewers:** the independent reviewer or release team.
2. **Prevent self-review:** enabled — the person who pushed the tag cannot
   approve their own deployment.
3. **Allow administrators to bypass:** disabled — no bypass.

If any of these is enabled, say so in this runbook alongside who may approve and
what happens when they are unavailable. A control described here but absent in
the settings is worse than no control: it reads as a guarantee nobody is
providing.

### npm Trusted Publisher

Configure at [npmjs.com](https://www.npmjs.com/) → package settings →
Trusted Publishing:

1. **Provider:** GitHub Actions.
2. **Repository:** `toshtag/code-pact` (or the target repository).
3. **Workflow filename:** `publish.yml`.
4. **Environment:** `npm-publish`.
5. **Allowed action:** `npm publish` only.

### Verifying the external settings

Before a release, or after changing any of the above, read the settings back
rather than assuming them. These are the only way to know what is actually
configured:

```sh
# environment exists, and its protection rules — empty [] means no approval gate
gh api repos/toshtag/code-pact/environments \
  --jq '.environments[] | {name, protection_rules}'

# deployment tag policy
gh api repos/toshtag/code-pact/environments/npm-publish/deployment-branch-policies \
  --jq '.branch_policies[].name'

# whether a given run actually waited for an approval
gh api repos/toshtag/code-pact/actions/runs/<run-id>/approvals --jq 'length'
```

The npm Trusted Publisher fields (provider, repository, workflow filename,
environment) are visible only in the npm package settings UI. Compare all four
against this repository by hand: a mismatch surfaces as `npm publish` failing
with `ENEEDAUTH`, because npm falls back to token auth and finds no token.

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
