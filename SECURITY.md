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

Before any filesystem operation, `validateAgentProfileForAdapter` checks the agent profile's path fields against the adapter descriptor's `profilePathContract` — a canonical set of exact values:

- `instruction_filename` must **exactly match** the adapter's canonical instruction filename.
- `skill_dir` (when present) must **exactly match** the adapter's canonical skill directory.
- `hook_dir` (when present) must **exactly match** the adapter's canonical hook directory.

This is an exact-equality check, not a prefix match — a hostile profile (e.g. `instruction_filename: .env`) is rejected at the contract boundary with `CONFIG_ERROR` — the target file is never read, hashed, or overwritten.

Profile loading is unified through `loadValidatedAdapterProfile`, which performs symlink-free path resolution, YAML parsing, schema validation, and contract validation in a single function. All adapter commands (install, upgrade, doctor) use this single source.

### Preflight and placeholder directories

`context_dir` and `hook_dir` are **not** included in the `assertAdapterWritePathsContained` preflight. Instead:

- `context_dir` is resolved symlink-free **before the model pin** and created via `mkdir` using the resolved path. It is schema-constrained to `.context/**` (`ContextOutputDir`) and cannot be an arbitrary path.
- `hook_dir` is resolved symlink-free **before the model pin** (to catch symlinks) but is **not** pre-created via `mkdir`. This prevents a hostile profile from forcing arbitrary directory creation. Parent directories for hook files are created by the write loop's `mkdir(dirname(absPath), { recursive: true })` only when a hook file is actually generated.

The preflight itself only checks the manifest path (a fixed `.code-pact/adapters/` path). Generated-file targets are authorized individually via `authorizeAdapterMutationPath` before any stat/read/hash.

### Model profile loading

Model profiles (`.code-pact/model-profiles/*.yaml`) are loaded via `loadModelProfilesStrict`, which uses `resolveSymlinkFreeProjectPath` for both the directory and each entry. A symlinked or unreadable model-profiles directory is a `CONFIG_ERROR` — it is **not** silently degraded to an empty array. An empty array would cause the generator to produce model-unaware output, masking the configuration problem.

### Control-plane config path

`.code-pact/project.yaml` is read through `resolveProjectConfigPath`, a dedicated helper that wraps `resolveSymlinkFreeProjectPath`. This ensures the control-plane config file is always read with ownership resolution, never containment. The `readProjectYamlStrictOrNull` helper provides safe locale discovery with size and type checks.

### TOCTOU safety

`writeManifest` always re-resolves the manifest path via `resolveSymlinkFreeProjectPath` at write time, regardless of any earlier preflight check. A symlink planted between the preflight and the write is detected and refused.

### Static analysis gates

Two CI gates provide structural backstops for path safety:

- **`check:fs-containment`** (`scripts/check-fs-containment.mjs`): flags lexical `join(...)` paths handed directly to fs functions across `src/commands/`, `src/core/`, and `src/cli/`.
- **`check:fs-authority`** (`scripts/check-fs-authority.mjs`): verifies that every fs operation in `adapter-install.ts` and `adapter-upgrade.ts` uses a path sourced from an authority resolver (`authorizeAdapterMutationPath`, `resolveSymlinkFreeProjectPath`, `resolveManifestPath`, or a pre-resolved variable).

Both are structural tripwires — exit 0 does not prove semantic invariants. The security regression tests (`control-plane-ownership-red.test.ts`, `adapter-preflight-atomicity.test.ts`, `adapter-fs-operation-proof.test.ts`) are the proof layer.

## Known technical debt

- **`resolveWithinProject` in user-facing reads**: `plan-constitution.ts`, `plan-brief.ts`, `plan-adopt.ts`, `task-prepare.ts`, `spec-import.ts`, and `core/decisions/retire.ts`, `prune.ts`, `link-collector.ts` still use `resolveWithinProject` for user-authored design content reads. These are containment-only (in-project symlinks allowed). This is acceptable because: (a) the paths are user-facing reads, not control-plane writes; (b) the content is user-authored design files, not attacker-controllable config; (c) write operations in `prune-executor.ts` re-resolve with `resolveSymlinkFreeProjectPath` before any delete.
- **`adapter-doctor.ts` does not use `loadValidatedAdapterProfile`**: it loads profiles via `resolveAgentProfilePath` + direct `readFile` (lenient, returns null on failure). This is acceptable because `adapter-doctor` is diagnostic-only (no writes), and `readProjectFileForDoctor` uses `resolveSymlinkFreeProjectPath` for all file reads. Contract violations are caught by `doctor.ts`'s `checkAgentProfiles`.
- **`projectFs` seam not introduced**: the fs operation proof test (`adapter-fs-operation-proof.test.ts`) uses canary files rather than a mockable `projectFs` seam. A seam would allow exhaustive spy-matrix testing but requires a larger refactor of all fs import sites.
