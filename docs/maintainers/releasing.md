# Releasing

The repeatable steps to cut a release. Most of it is a normal PR; only the
**signed tag** and **`npm publish`** are maintainer-local (they need the
maintainer's signing key and npm credentials).

Only `dist/` + `LICENSE` ship in the npm package (`package.json` `files`). So
**code changes under `src/` require a release to reach users; docs-only changes
do not** (they're already visible in the repo).

## Pick the version

Semantic versioning across the v1.x line:

- **patch** (`1.x.Y`) — bug fixes only, no new surface.
- **minor** (`1.X.0`) — additive features (new commands/flags/aliases, new
  optional schema fields). Backwards-compatible.
- **major** — a breaking change to a `Stable (v1.0)` surface. Avoid; the v1.x
  contract is frozen.

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
4. **Docs-sync audit** — confirm everything shipped since the last tag followed
   the [docs ownership map](docs-maintenance.md#ownership-map--what-to-update-for-which-change).
   `check:docs` covers links + the error-code contract, but one rule is
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
   build, `check:docs` (links + invariants + generated-reference drift),
   `check:release-version` (package.json ↔ CHANGELOG ↔ measurements agree),
   then `validate --json`, `plan lint --include-quality --strict --json`, and
   `plan analyze --strict --json`. This is the single source of the release
   gate — don't re-list the steps here, or the runbook drifts from the script.
6. Open the PR; merge once CI is green.

## Tag + publish (maintainer-local)

After the release-prep PR merges to `main`:

7. **SSH-signed annotated tag** on the merge commit. `SECURITY.md` requires
   v1.x releases to use SSH-signed tags (so the GitHub tag page shows
   "Verified"); use `-s` (not `-a`, which is annotated but not signed).
   Lightweight tags are rejected by a hook; signing setup is in
   [CONTRIBUTING](../../CONTRIBUTING.md#tag-signing-maintainer-only):
   ```sh
   git tag -s v<version> -m "v<version> — <theme>"
   git verify-tag v<version>   # expect a good signature before pushing
   git push origin v<version>
   ```
8. **Publish.** `dist/` is gitignored, yet `files: ["dist", …]` / `bin: dist/cli.js`
   ship it — so a fresh checkout (or a clean `main`) has **nothing to publish**
   until you build. Build first, then publish (`prepublishOnly` re-checks package
   metadata as a backstop, but does not build for you):
   ```sh
   pnpm install --frozen-lockfile
   pnpm build            # or `pnpm release:check` for the full pre-publish gate
   npm publish
   ```
9. **GitHub Release** from the tag, using the CHANGELOG section as the body,
   **plus an `## Integrity` section** recording the published tarball's
   `shasum` and `integrity`. This is a documented supply-chain policy
   ([SECURITY.md](../../SECURITY.md): "the published tarball shasum is recorded
   in the corresponding GitHub Release notes"), so it is **required**. Take the
   values **after** publish from the registry — `pnpm pack` is not the
   published tarball, and `npm view … dist` can return a stale `E404` right
   after publish, so read the registry JSON directly:
   ```sh
   curl -s https://registry.npmjs.org/code-pact \
     | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d).versions["<version>"].dist;console.log("shasum:",v.shasum);console.log("integrity:",v.integrity)})'
   ```
   As a final check, download that `dist.tarball` and recompute `shasum` to
   confirm it matches the notes.

## What does NOT need a release

- Documentation (`docs/**`, `README.md`, `design/**`) — not shipped; already in
  the repo on merge.
- CI scripts / dev dependencies — not in the published package.
