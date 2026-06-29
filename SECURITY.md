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

All control-plane reads (`.code-pact/project.yaml`, agent profiles, model profiles, design files, phase YAMLs, decision ADRs, roadmap, archive records) and all automated writes (adapter install/upgrade, model pin) use **ownership** resolution. Containment-only resolution is reserved for explicit user-selected input paths (e.g. `--from-file` flags) where in-project symlinks are a legitimate convenience and the path is not attacker-controllable config.

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

Model profiles (`.code-pact/model-profiles/*.yaml`) are loaded via two loaders:

- `loadModelProfilesStrict`: used by adapter install/upgrade. Uses `resolveSymlinkFreeProjectPath` for both the directory and each entry. A symlinked or unreadable entry throws — it is **not** silently skipped. An empty array would cause the generator to produce model-unaware output, masking the configuration problem.
- `loadModelProfilesSafe`: used by `adapter doctor`. Uses `resolveSymlinkFreeProjectPath` for the directory and each entry. A symlinked **directory** throws `PATH_NOT_OWNED` (surfaced as `MODEL_PROFILES_UNSAFE` issue); individual unreadable/malformed entries are skipped (doctor is diagnostic). Both loaders share the same symlink-free resolution primitive.

### Control-plane config path

`.code-pact/project.yaml` is read through `resolveProjectConfigPath`, a dedicated helper that wraps `resolveSymlinkFreeProjectPath`. This ensures the control-plane config file is always read with ownership resolution, never containment. The `readProjectYamlStrictOrNull` helper provides safe locale discovery with size and type checks.

### TOCTOU safety

`writeManifest` always re-resolves the manifest path via `resolveSymlinkFreeProjectPath` at write time, regardless of any earlier preflight check. A symlink planted between the preflight and the write is detected and refused.

### Static analysis gates

Two CI gates provide structural backstops for path safety:

- **`check:fs-containment`** (`scripts/check-fs-containment.mjs`): flags lexical `join(...)` paths handed directly to fs functions across `src/commands/`, `src/core/`, and `src/cli/`.
- **`check:fs-authority`** (`scripts/check-fs-authority.mjs`): an **AST-based** gate using the TypeScript compiler API. Parses each target file into an AST, walks every `CallExpression`, and verifies that fs operations (`readFile`, `writeFile`, `mkdir`, `stat`, `unlink`, `rename`, `rm`, `readdir`, `access`, etc.) use a path sourced from an authority resolver (`resolveSymlinkFreeProjectPath`, `resolveOwnedReadPath`, `resolveProjectConfigPath`, `resolveAgentProfilePath`, `resolveArchiveOwnedPath`, `resolveManifestPath`, `authorizeAdapterMutationPath`, or a pre-resolved variable). Tracks variable provenance to follow `const abs = await resolveSymlinkFreeProjectPath(...)` assignments. Exemptions: `// fs-safe: <reason>` marker, authority resolver definitions, and import statements.

Both are structural tripwires — exit 0 does not prove semantic invariants. The security regression tests (`control-plane-symlink-red.test.ts`, `control-plane-ownership-red.test.ts`, `adapter-preflight-atomicity.test.ts`, `adapter-fs-operation-proof.test.ts`, `filesystem-operation-proof.test.ts`) are the proof layer. The operation proof test spies on **all** fs operations (`readFile`, `writeFile`, `stat`, `lstat`, `readdir`, `mkdir`, `rename`, `rm`, `unlink`, `access`, `cp`, `copyFile`) to verify no unowned path is touched.

## Known technical debt

- **`resolveWithinProject` in user-selected input paths**: `plan-constitution.ts`, `plan-brief.ts`, `plan-adopt.ts`, and `spec-import.ts` (input mode) still use `resolveWithinProject` for `--from-file` / `--from` user-selected input paths. These are containment-only (in-project symlinks allowed). This is acceptable because: (a) the paths are explicitly user-selected, not attacker-controllable config; (b) the content is user-authored design content, not control-plane config; (c) these are read-only operations with no write side effects. Each call site is annotated with `// fs-authority: containment-only` and `// reason: explicit user-selected input path`.
- **`adapter-doctor.ts` does not use `loadValidatedAdapterProfile`**: it loads profiles via `resolveAgentProfilePath` + direct `readFile` (lenient, returns null on failure). This is acceptable because `adapter-doctor` is diagnostic-only (no writes), and `readProjectFileForDoctor` uses `resolveSymlinkFreeProjectPath` for all file reads. Contract violations are caught by `doctor.ts`'s `checkAgentProfiles`. Model profile loading uses the shared `loadModelProfilesSafe` loader with symlink-free resolution.
- **`context_dir` placeholder side effect**: `adapter install` and `adapter upgrade` create `context_dir` via `mkdir(contextDirAbs, { recursive: true })` after all preflight checks pass but before the file write loop. This is intentional: (a) the path is symlink-free resolved; (b) it is schema-constrained to `.context/**`; (c) it is created after the model pin preflight; (d) without it, the first file write would create it anyway via `mkdir(dirname(absPath), { recursive: true })`. The side effect is a directory in an owned adapter namespace — not a file write — and is idempotent.
- **`projectFs` seam not introduced**: the fs operation proof test (`filesystem-operation-proof.test.ts`) uses `vi.mock` spies on all fs operations rather than a mockable `projectFs` seam. A seam would allow exhaustive spy-matrix testing but requires a larger refactor of all fs import sites. The current spy approach covers `readFile`, `writeFile`, `stat`, `lstat`, `readdir`, `mkdir`, `rename`, `rm`, `unlink`, `access`, `cp`, `copyFile` — all operations that could leak content or mutate state.
- **`check:fs-authority` scope**: the AST gate currently covers `adapter-install.ts`, `adapter-upgrade.ts`, and `adapter-doctor.ts`. Expanding to `src/core/` and `src/commands/` broadly would require handling more authority resolvers and call patterns. The `check:fs-containment` lexical guard already covers the broader scope.
