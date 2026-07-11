# Contributing

## Language policy

| Surface                                         | Language                          |
| ----------------------------------------------- | --------------------------------- |
| Branch names, commit messages, PR titles/bodies | English                           |
| Source code and code comments                   | English                           |
| CLI output, usage docs, generated context packs | i18n (currently `ja-JP`, `en-US`) |

Internal planning notes that are not meant for public consumption belong in `.local/` (gitignored).

## Source layout

The CLI is layered. When adding or changing a command, follow the layer that fits:

| Layer            | Path                          | Responsibility                                                                                                                                                                                                                   |
| ---------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dispatcher       | `src/cli.ts`                  | Global flags, locale detection, the top-level `switch`, and the single-verb commands that have no subcommand surface (`init`, `tutorial`, `doctor`, `validate`, `recommend`, `verify`, `pack`, `progress`).                      |
| CLI clusters     | `src/cli/commands/<group>.ts` | One module per subcommand cluster (`adapter`, `task`, `plan`, `phase`, `spec`). Owns arg parsing, JSON envelopes, exit codes, and error-code mapping. Exports only its `cmd<Group>` entry; per-subcommand handlers stay private. |
| Implementations  | `src/commands/<verb>.ts`      | The `run*` / `format*` functions the CLI layer calls. No `process.exit`, no argv parsing — return values, throw tagged errors.                                                                                                   |
| Domain logic     | `src/core/`                   | Plan state, context packing, recommendation, adapters, schemas, locks. Pure logic, no CLI concerns.                                                                                                                              |
| Shared utilities | `src/lib/`                    | Small cross-cutting helpers (`argv`, `tty`, `prompt`, `package-version`).                                                                                                                                                        |
| Messages         | `src/i18n/`                   | Locale message tables (`en-US`, `ja-JP`).                                                                                                                                                                                        |

Rule of thumb: a new multi-subcommand verb gets a `src/cli/commands/<group>.ts` cluster; its logic lives in `src/commands/` and `src/core/`. Keep the CLI layer thin — parsing and presentation only.

## Commit style

Conventional Commits. Examples:

```
feat(init): create .code-pact and design layouts
fix(verify): treat missing progress event as VERIFICATION_FAILED
chore(deps): pin node engines to >=24
docs(readme): clarify json response shape
test(progress): cover expanded_work for project-b fixture
```

## Branch / PR workflow

- One CLI command (or one cohesive concern) per branch: `feat/<command>` or `chore/<scope>`.
- Open a PR even for solo work; do not push directly to `main`.
- Inside a PR, prefer many small commits. Squash-merge at PR merge time is acceptable.
- Fast local loop: `pnpm test:unit`.
- Fast required gate before merge: `pnpm test:ci`.
- Deep local/manual gate for high-risk changes: `pnpm test:ci:deep`.
- Release remains strict through `pnpm release:check`.
- CI must be green before merge. Required PR CI runs the fast Node 22 gate; manual Deep CI covers full integration, Node 24, Windows process-control, docs, and invariant checks.
- Maintainers who want a local pre-push gate can opt in with a gitignored hook:
  `mkdir -p .local/hooks && cp scripts/local/pre-push.example.sh .local/hooks/pre-push && chmod +x .local/hooks/pre-push && git config core.hooksPath .local/hooks`.
- Touching docs? See [`docs/maintainers/docs-maintenance.md`](docs/maintainers/docs-maintenance.md) for which doc owns which kind of change, so updates don't drift across files.

## Issues and questions

- Bugs, feature requests, and usage questions currently use GitHub Issues.
- Use the provided bug or feature templates where applicable.
- The README Non-goals list remains the scope boundary for feature requests.

## Runtime dependency policy

MVP runtime `dependencies` are limited to `yaml` and `zod`. Do not add CLI frameworks (`commander`), color libraries (`picocolors`), front-matter parsers (`gray-matter`), glob libraries (`globby`), or process libraries (`execa`) without an explicit RFC in `.local/decisions/`.

Use built-ins instead:

- CLI parsing: `node:util` `parseArgs`
- Subprocess: `node:child_process` `spawn`
- Front-matter: small in-repo parser + the existing `yaml` package
- File listing: `node:fs/promises` `readdir`

## Testing

- `vitest`, snapshot tests for command output where useful.
- Fixtures live under `tests/fixtures/`. Snapshot any change deliberately.

## JSON output convention

When `--json` is set, **stdout must be JSON only**. All human-readable logs, warnings, and progress lines must go to **stderr**. Use the shared response shape:

```json
{ "ok": true, "data": {} }
```

```json
{
  "ok": false,
  "error": { "code": "PHASE_NOT_FOUND", "message": "..." },
  "data": {}
}
```

Stable error code strings are the public contract; do not rename them lightly.

Some documented envelopes may carry additive stable fields under `error`, such as `cause_code` (v1.27+, P39). Do not invent ad-hoc `error` fields — document any addition in `docs/cli-contract.md` and pin it in `tests/unit/error-code-surface.test.ts`.

## Tag signing (maintainer only)

From `v0.2.0-alpha.0` onward, release tags are signed with SSH so the GitHub tag page shows a "Verified" badge and downstream consumers can audit the chain locally. This section is for the maintainer cutting a release; it is not required for ordinary contributors who only open PRs.

### One-time local setup

```sh
# 1. Tell git to sign tags with SSH (not GPG/OpenPGP).
git config --local gpg.format ssh

# 2. Point at the SSH key you want to use as your signing key.
#    The key must be an existing public key file; ~/.ssh/id_ed25519.pub
#    is the common choice. Do NOT use a separate, unlisted key.
git config --local user.signingkey ~/.ssh/id_ed25519.pub

# 3. Sign every annotated tag created in this repo by default.
git config --local tag.gpgSign true
```

### One-time GitHub setup

In https://github.com/settings/keys, **add the same SSH public key as a Signing Key** (it is fine to also have it registered as an Authentication Key — they are separate registrations even for the same key). Only keys registered as Signing Keys produce the "Verified" badge on tag and commit pages.

### Local verification with `allowedSignersFile`

`git verify-tag` requires an `allowedSignersFile` that maps SSH public keys to identities. Without it, the command returns `signature trust unknown` even for a tag your key actually signed.

Per-repo setup:

```sh
git config --local gpg.ssh.allowedSignersFile .git_allowed_signers
# .git_allowed_signers contents (one line, your email + your public key):
# you@example.com ssh-ed25519 AAAA...your-public-key... comment
```

The `.git_allowed_signers` file is intentionally **not committed** in v0.2 because there is only one maintainer; if more maintainers are added, we will commit a curated file and pin the path globally. For now, each maintainer keeps their own local copy.

### Verifying a freshly created tag

```sh
git tag -s vX.Y.Z -m "vX.Y.Z"           # stable cut (v1.0+)
git tag -s vX.Y.Z-rc.N -m "vX.Y.Z-rc.N" # prerelease cut, if any
git verify-tag vX.Y.Z
# Expected: "Good \"git\" signature for <your-email>"
```

After `git push origin vX.Y.Z`, the tag page on GitHub should show a green "Verified" badge. If it does not, double-check that the SSH public key is registered as a **Signing Key** (not just an Authentication Key) on your GitHub profile.

### Existing unsigned tags

`v0.1.0-alpha.0` is unsigned (predates this policy). It is intentionally **not** re-tagged; moving it would invalidate the npm artifact that points at the original commit. The signed-release policy applies from `v0.2.0-alpha.0` forward.

## npm `dist-tags` policy

The npm registry assigns the first version of a package both the chosen tag (e.g. `--tag alpha`) and the implicit `latest` tag set. **`npm dist-tag rm code-pact latest` is rejected with HTTP 400 by the registry** — the `latest` tag is reserved and can only be moved, not deleted.

Starting with v1.0.0:

- Stable releases (`v1.x.0`, `v1.x.y` patches) publish to `latest` by default. The publish workflow uses Trusted Publishing (OIDC) — `1.x.y` is not a prerelease string, so npm puts it on `latest` automatically.
- The historical `alpha` tag continues to point at `v0.9.0-alpha.0` so `npm install code-pact@alpha` keeps working for users pinned to pre-v1.0 behaviour. Past alphas are not maintained but the tag is not deleted.
- Future prerelease cuts (if any) should use `--tag rc` / `--tag beta` and **not** auto-promote to `latest` until the corresponding stable cut.

Pre-v1.0 history (kept for reference): during the alpha period, every release was published with `--tag alpha` AND the `latest` tag was manually moved (`npm dist-tag add code-pact@<version> latest`) so plain `npm install code-pact` returned the newest alpha rather than the oldest `v0.1.0-alpha.0`. The v1.0.0 publish replaces that workaround.
