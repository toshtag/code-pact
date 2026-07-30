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
   from there without a further approval step. The workflow has five jobs with
   strict permission separation:

   | Job              | Permissions                                  | Runs                                                                                                                                                                    |
   | ---------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `prepare`        | `contents: read`, `actions: read`            | checkout, tag verification, exact-SHA CI verification, release-specific checks, **distribution build**, package metadata assertion, tarball build + inspection, release notes generation, artifact upload |
   | `publish`        | `contents: read`, `id-token: write`          | artifact download, manifest verification, `npm publish --ignore-scripts` (no checkout, no repository code)                                                               |
   | `verify`         | `contents: read`                             | checkout, artifact download, registry tarball download + byte verification, integrity report upload                                                                      |
   | `provenance`     | `contents: read`                             | checkout, artifact download, npm provenance attestation verification                                                                                                    |
   | `github-release` | `contents: write`                            | artifact + integrity download, `gh release create/edit` (no checkout, no repository code)                                                                                |

   The `publish` job runs in the `npm-publish` GitHub Environment, which exists
   as the OIDC environment binding npm Trusted Publishing is configured against
   — not as an approval gate. The workflow then:
   - **prepare** verifies the signed annotated tag (`check-release-tag.mjs`),
     verifies that the `CI status` check passed for the exact commit SHA
     (`check-required-ci-for-sha.mjs`), runs release-specific supply-chain and
     version checks, builds and inspects the exact tarball
     (`check-package-tarball.mjs`), generates release notes, and uploads the
     artifact — the build is its own step, so the artifact never depends on
     another command producing `dist/` as a side effect,
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
   - **provenance** verifies the published package's npm provenance attestation
     (`verify-published-provenance.mjs`),
   - **github-release** creates a GitHub Release with an auto-generated
     `## Integrity` section. It needs `provenance` as well as `verify`, so the
     Release is never created for a package whose attestation did not check
     out.

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
outside the repository: **no current check in this repo verifies their live
external values, and repository state alone cannot prove them.**
`check-supply-chain-invariants.mjs` verifies that the workflow declares
`environment: npm-publish` and the per-job permission map. It does not read the
environment's protection rules, the deployment ref policy, or the npm trusted
publishing relationship — nothing prevents a future check from calling those
APIs, but none does today.

Those settings form three readback groups across **two** external authorities,
GitHub and the npm registry:

| Setting | Authority | Read it with |
| --- | --- | --- |
| environment existence, protection rules, deployment policy mode | GitHub | `gh api` (below) |
| deployment branch/tag policies | GitHub | `gh api` (below) — only exists when the policy mode is custom |
| npm trusted publishing relationship | npm registry | `npm trust list` as an authorized maintainer; the npm package settings UI for anything the CLI does not expose |

Read those authorities directly rather than inferring them from repository code
or from a green workflow run.

### GitHub Environment: `npm-publish` — required

1. **Create** a GitHub Environment named `npm-publish` (Settings → Environments).
2. The name must match the **Environment** field of the npm trusted publishing
   relationship exactly; that pairing is what the OIDC exchange binds to.

### GitHub Environment: `npm-publish` — recommended hardening

**Deployment branches and tags:** selected tags → `v*` only. This stops a
deployment to `npm-publish` — and therefore an OIDC token minted for it — from
originating anywhere but a release tag.

> As of v2.9.0 this is **not** configured: the environment's
> `deployment_branch_policy` reads `null`, meaning any ref may deploy to it.
> The release is still bounded by the workflow's own `on: push: tags: v*`
> trigger and by the signed-tag verification in `prepare`, so this is a
> defence-in-depth gap rather than an open door — but the runbook should not
> claim a restriction that is absent.

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

Before a release, or after changing any of the above, read each authority back.

**GitHub — the environment itself.** This is the only call that reveals the
policy *mode*, and the mode decides whether the policies endpoint below even
exists:

```sh
gh api repos/toshtag/code-pact/environments/npm-publish \
  --jq '{name, protection_rules, deployment_branch_policy}'
```

- `protection_rules: []` — no approval gate. That is the current
  single-maintainer operation; see the optional section above.
The policy has three modes; read all of `deployment_branch_policy`, not one
field of it:

| `deployment_branch_policy` | Means |
| --- | --- |
| `null` | no branch or tag restriction at all — **the state measured during v2.9.0** |
| `protected_branches: true`, `custom_branch_policies: false` | protected branches only. **Not** the intended tag-only policy for a tag-triggered release workflow, and easy to mistake for "restricted" |
| `protected_branches: false`, `custom_branch_policies: true` | custom branch/tag patterns — read the policies next |

**GitHub — the deployment policies.** Only meaningful when the mode above is
custom:

```sh
gh api repos/toshtag/code-pact/environments/npm-publish/deployment-branch-policies \
  --jq '{total_count, policies: [.branch_policies[] | {type, name}]}'
```

Read `type` as well as `name`: a policy named `v*` may be a **branch** rule or a
**tag** rule, and only a tag rule restricts this workflow. For the hardening
above, expect exactly one policy, of tag type, named `v*`.

Read the returned response without discarding fields. This repository currently
has no custom policy, so a successful response has not been observed here — if
the response available to the installed `gh` and API version does not expose the
rule's branch/tag type, confirm it in the GitHub Environment UI rather than
treating a bare `name` match as verification.

A `404` here does **not** mean "no policies" — it is what the endpoint returns
when the environment is not using custom policies at all. Check
`deployment_branch_policy` first before concluding anything.

**GitHub — deployment review history for a finished run:**

```sh
gh api repos/toshtag/code-pact/actions/runs/<run-id>/approvals --jq '.'
```

`[]` means no deployment review was recorded for that run. It does not by itself
prove the run never entered a pending state — to see a *live* wait, query the
run while it is in progress:

```sh
gh api repos/toshtag/code-pact/actions/runs/<run-id>/pending_deployments --jq '.'
```

That returns the environments a running workflow is currently waiting on.

**npm — the trusted publishing relationship.** npm 11.15.0 and newer expose this
from the CLI; it is the counterpart of the package settings UI:

```sh
npm --version                 # needs >= 11.15.0 for `npm trust`
npm trust list code-pact --json --registry=https://registry.npmjs.org/
```

The call is authenticated. It reads `/-/package/<name>/trust`, and per npm's
`npm trust` documentation the caller needs:

- npm 11.15.0 or newer,
- **write permission** on the package,
- **account-level 2FA** enabled,
- a credential type `npm trust` supports — legacy basic auth and a granular token
  configured to bypass 2FA are not accepted.

Being logged in is not by itself sufficient. Do not enter, rotate, or persist
credentials solely for this readback during an automated run.

> Measured during PR #582 on npm 12.0.1: an **unauthenticated** call returns
> `E401 Unauthorized`. That establishes only that the endpoint requires
> authentication — it does not characterize how an authorized-but-misconfigured
> call behaves.

**The website and the CLI represent the same relationship differently**, so
normalize before comparing. Per npm's trusted publishers documentation the
GitHub Actions form is six values:

| npm package settings UI | Expected |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `toshtag` |
| Repository | `code-pact` |
| Workflow filename | `publish.yml` |
| Environment | `npm-publish` |
| Allowed action | `npm publish` only |

The CLI joins owner and repository into one flag. From `npm trust --help` on
npm 12.0.1, `npm trust github` takes:

| CLI | Expected |
| --- | --- |
| subcommand | `github` |
| `--repo` | `toshtag/code-pact` |
| `--file` | `publish.yml` |
| `--env` | `npm-publish` |
| `--allow-publish` | set |
| `--allow-stage-publish` | not set |

Compare all six UI values, or their normalized CLI equivalents — never one
representation against the other unnormalized. Do not assume the shape of a
successful `npm trust list --json` response without reading it: read the whole
response rather than a preselected field, since the schema is npm's to change.

An absent or mismatched trusted publishing relationship **can** surface as
`npm publish` failing with `ENEEDAUTH`, when npm cannot exchange the workflow's
OIDC identity and then finds no traditional token. Treat `ENEEDAUTH` as a prompt
to check, not a diagnosis of one specific field:

- the organization/user and repository,
- the workflow filename,
- the environment,
- the allowed action,
- whether the runner is GitHub-hosted,
- `id-token: write` on the publishing job,
- `package.json` `repository.url`,
- for `workflow_call` / `workflow_dispatch`, the identity of the workflow that
  actually invoked `npm publish`.

> The first `v2.9.0` attempt ran before the trusted publishing relationship was
> correctly configured, and ended with `ENEEDAUTH`. The successful rerun shows
> the final configuration was sufficient for this workflow; it does not show
> that every possible field mismatch produces that same error.

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
