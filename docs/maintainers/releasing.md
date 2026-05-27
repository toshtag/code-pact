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
   `design/measurements/` so the snapshot reflects this release (version, git
   SHA, date, and any metric drift). CI enforces that the snapshot's
   `code_pact_cli_version` matches `package.json` (see `check:doc-invariants`),
   so this step cannot be silently skipped. `docs/positioning.md` points at the
   snapshot rather than copying numbers, so it needs no edit.
3. **CHANGELOG:** add a `## [<version>] — <date>` section (Keep a Changelog
   format: Added / Changed / Fixed). Lead with the user-facing shipped change.
4. **Verify** (the same gates CI runs):
   ```sh
   pnpm typecheck && pnpm test:unit && pnpm build \
     && pnpm exec vitest run --config vitest.integration.config.ts \
     && pnpm check:docs \
     && node dist/cli.js plan lint --include-quality --strict --json \
     && node dist/cli.js plan analyze --strict --json \
     && node dist/cli.js validate --json
   ```
5. Open the PR; merge once CI is green.

## Tag + publish (maintainer-local)

After the release-prep PR merges to `main`:

6. **Annotated, signed tag** on the merge commit (lightweight tags are rejected
   by a hook; signing setup is in [CONTRIBUTING](../../CONTRIBUTING.md#tag-signing-maintainer-only)):
   ```sh
   git tag -a v<version> -m "v<version> — <theme>"
   git push origin v<version>
   ```
7. **Publish** (`prepublishOnly` re-checks package metadata):
   ```sh
   npm publish
   ```
8. **GitHub Release** from the tag, using the CHANGELOG section as the body.
   Do **not** hand-copy a tarball checksum into the notes: `npm publish`
   attaches a provenance signature and the registry exposes a sha512
   `integrity`, which `npm install` verifies automatically — a manual sha1 is
   weaker, redundant, and drift-prone. If you ever do need the published
   tarball's hash, read it from `npm view code-pact dist` **after** publish
   (never from `pnpm pack`, which is not the published tarball).

## What does NOT need a release

- Documentation (`docs/**`, `README.md`, `design/**`) — not shipped; already in
  the repo on merge.
- CI scripts / dev dependencies — not in the published package.
