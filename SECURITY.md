# Security Policy

## Supported versions

Starting with `v1.0.0`, `code-pact` ships under the npm `latest` tag. Only the most recent release on `latest` receives security fixes. Past pre-1.0 alpha releases remain on the `@alpha` tag for reference but are no longer maintained.

| Version                            | Supported                            |
| ---------------------------------- | ------------------------------------ |
| latest release on the `latest` tag | yes                                  |
| any release older than `latest`    | no — upgrade to the current `latest` |
| pre-1.0 alpha releases (`@alpha`)  | no                                   |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security reports.

Use GitHub's Private Vulnerability Reporting:

→ https://github.com/toshtag/code-pact/security/advisories/new

Include:

- A description of the issue and its impact.
- Steps to reproduce, or a minimal proof of concept.
- Affected version(s) (`npm view code-pact version`).
- Your suggested severity, if you have one.

You should receive an acknowledgement within a few days. This is a small project, so please be patient with response times. Coordinated disclosure timelines will be agreed in the advisory thread.

## Scope

In scope:

- Command injection, path traversal, or arbitrary file write from any CLI command.
- Issues that cause `code-pact` to leak secrets from the user's filesystem outside the project directory.
- Supply chain integrity of the published `code-pact` npm package (e.g. tampered tarball, unexpected `dependencies`).

Out of scope:

- Vulnerabilities in third-party dependencies — please report those upstream (`yaml`, `zod`, etc.).
- Issues that require an attacker who already has write access to the user's `design/` directory or `.code-pact/` state.
- `verify.commands` executing malicious commands from an untrusted project checkout. Verification commands are trusted local project configuration; do not run `code-pact verify` or `code-pact task complete` on a repository whose `design/` files you would not run as shell commands.
- Reports based on outdated releases when the issue is already fixed on the current `latest` tag.

## Supply chain notes

- Releases from `v0.2.0-alpha.0` onward use **SSH-signed annotated git tags**. The signing key is registered on GitHub as the maintainer's signing key, so the tag page displays a "Verified" badge. The maintainer setup is documented in [CONTRIBUTING.md](CONTRIBUTING.md#tag-signing-maintainer-only).
- The tag `v0.1.0-alpha.0` is unsigned (it predates this policy) and is left untouched; moving it would invalidate the corresponding npm publish.
- Releases are built locally from a clean checkout before publish.
- The published tarball shasum is recorded in the corresponding GitHub Release notes.
- 2FA (`auth-and-writes`) is enabled on the publisher's npm account.

If a published version's registry-side shasum does not match the value in its release notes, please report it via the channel above with the highest priority.

## Threat model: path safety and adapter write paths

### Containment is not ownership

`code-pact` distinguishes two levels of path safety:

- **Containment** (`resolveWithinProject`): proves a path resolves to a location within the project root. In-project symlinks are allowed — the canonical target stays inside the project.
- **Ownership** (`resolveSymlinkFreeProjectPath`): rejects ANY symlink component, including in-project aliases. A lexical path match is not proof that the real destination belongs to an owned namespace if any component is a symlink (CWE-59/CWE-61).

All control-plane reads (`.code-pact/project.yaml`, agent profiles, model profiles, design files) and all automated writes (adapter install/upgrade, model pin) use **ownership** resolution. Containment-only resolution is reserved for user-facing reads where in-project symlinks are a legitimate convenience.

### Profile contract validation

Before any filesystem operation, `validateAgentProfileForAdapter` checks the agent profile's path fields against the adapter descriptor's declared owned paths:

- `instruction_filename` must match an adapter-owned instruction or rule path.
- `skill_dir` (when present) must be a prefix of at least one owned skill path.
- `hook_dir` (when present) must be a prefix of at least one owned hook path.

A hostile profile (e.g. `instruction_filename: .env`) is rejected at the contract boundary with `CONFIG_ERROR` — the target file is never read, hashed, or overwritten.

### hook_dir policy

`hook_dir` is `RelativePosixPath.optional()` — an arbitrary project-relative path. It is included in the preflight symlink-free resolution check but is **not** pre-created via `mkdir`. This prevents a hostile profile from forcing arbitrary directory creation. Parent directories for hook files are created by the write loop's `mkdir(dirname(absPath), { recursive: true })` only when a hook file is actually generated.

`context_dir` is schema-constrained to `.context/**` (`ContextOutputDir`) and is safe to pre-create — it cannot be an arbitrary path.

### TOCTOU safety

`writeManifest` always re-resolves the manifest path via `resolveSymlinkFreeProjectPath` at write time, regardless of any earlier preflight check. A symlink planted between the preflight and the write is detected and refused.
