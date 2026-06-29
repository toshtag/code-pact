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
- Cross-namespace observation or mutation of local untracked files from malicious tracked project/profile/manifest/roadmap/phase/task values.
- Tracked symlinks and hostile tracked control-plane content.
- Supply chain integrity of the published `code-pact` npm package (e.g. tampered tarball, unexpected `dependencies`).

Out of scope:

- Vulnerabilities in third-party dependencies — please report those upstream (`yaml`, `zod`, etc.).
- `verify.commands` executing malicious commands from an untrusted project checkout. Verification commands are trusted local project configuration; do not run `code-pact verify` or `code-pact task complete` on a repository whose `design/` files you would not run as shell commands.
- Attacks that require a separate local process to modify the filesystem during a command's execution.
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

Adapter install/upgrade use `loadValidatedAdapterProfile`, which performs symlink-free path resolution, YAML parsing, schema validation, and contract validation in a single function. Diagnostic paths may use lenient loaders, but they still resolve profile paths through the agent-profile namespace guard and must not inspect profile-derived filesystem targets unless the adapter descriptor proves authority.

### Preflight and placeholder directories

`context_dir` and `hook_dir` are **not** included in the `assertAdapterWritePathsContained` preflight. Instead:

- `context_dir` is resolved symlink-free **before the model pin** and type-checked (must be a directory if it exists). It is **not** pre-created via `mkdir` — it is created lazily by `atomicWriteText`'s parent-dir creation when the first context pack is written. It is schema-constrained to `.context/**` (`ContextOutputDir`) and cannot be an arbitrary path.
- `hook_dir` is resolved symlink-free **before the model pin** (to catch symlinks) but is **not** pre-created via `mkdir`. This prevents a hostile profile from forcing arbitrary directory creation. Parent directories for hook files are created by the write loop's `mkdir(dirname(absPath), { recursive: true })` only when a hook file is actually generated.

The preflight itself only checks the manifest path (a fixed `.code-pact/adapters/` path). Generated-file targets are authorized individually via `authorizeAdapterMutationPath` before any stat/read/hash.

### Model profile loading

Model profiles (`.code-pact/model-profiles/*.yaml`) are loaded via two loaders:

- `loadModelProfilesStrict`: used by adapter install/upgrade. Uses `resolveSymlinkFreeProjectPath` for both the directory and each entry. A symlinked or unreadable entry throws — it is **not** silently skipped. An empty array would cause the generator to produce model-unaware output, masking the configuration problem.
- `loadModelProfilesSafe`: used by diagnostic surfaces. Uses `resolveSymlinkFreeProjectPath` for the directory and each entry. Symlinked or invalid entries fail closed into structured diagnostic issues instead of being treated as silently absent. Both loaders share the same symlink-free resolution primitive.

### Control-plane config path

`.code-pact/project.yaml` is read through `resolveProjectConfigPath`, a dedicated helper that wraps `resolveSymlinkFreeProjectPath`. This ensures the control-plane config file is always read with ownership resolution, never containment. The `readProjectYamlStrictOrNull` helper provides safe locale discovery with size and type checks.

### TOCTOU safety

`writeManifest` always re-resolves the manifest path via `resolveSymlinkFreeProjectPath` at write time, regardless of any earlier preflight check. A symlink planted between the preflight and the write is detected and refused.

### Static analysis gates

Two CI gates provide structural backstops for path safety:

- **`check:fs-containment`** (`scripts/check-fs-containment.mjs`): flags lexical `join(...)` paths handed directly to fs functions across `src/commands/`, `src/core/`, and `src/cli/`.
- **`check:fs-authority`** (`scripts/check-fs-authority.mjs`): an **AST-based** gate over the adapter install/upgrade/doctor and global doctor surfaces. It verifies fs operation path arguments are sourced from approved imported authority helpers, tracks local variable provenance, and merges branch states conservatively so a variable is authorized only when every reachable branch assigns it from an approved helper. It is a targeted gate, not a whole-project proof.

Both are structural tripwires — exit 0 does not prove semantic invariants. The security regression tests (`control-plane-symlink-red.test.ts`, `control-plane-ownership-red.test.ts`, `adapter-preflight-atomicity.test.ts`, `adapter-fs-operation-proof.test.ts`, `filesystem-operation-proof.test.ts`) are the proof layer. With the `projectFs` seam centralization, operation proof tests can now mock a single import point (`project-fs/index.ts`) for exhaustive fs spying, though raw `FileHandle` methods accessed via `open()` still require code review.

### Task reads

`task.reads` is an agent-facing filename enumeration surface. It is matched only against `git ls-files -z` output. Untracked local files (for example `.env`, `.local/**`, scratch files, or ignored context output) are not walked and cannot appear in the context pack merely because a hostile task declares `reads: ["**"]`. A tracked file named `.env` is treated as intentionally repository-visible and can match. In a non-git project, `task.reads` fails closed with `TASK_READS_UNAVAILABLE`; there is no implicit untracked filesystem walk.

## Known technical debt

- **`resolveWithinProject` in user-selected input paths**: `plan-constitution.ts`, `plan-brief.ts`, `plan-adopt.ts`, and `spec-import.ts` (input mode) still use `resolveWithinProject` for `--from-file` / `--from` user-selected input paths. These are containment-only (in-project symlinks allowed). This is acceptable because: (a) the paths are explicitly user-selected, not attacker-controllable config; (b) the content is user-authored design content, not control-plane config; (c) these are read-only operations with no write side effects. Each call site is annotated with `// fs-authority: containment-only` and `// reason: explicit user-selected input path`.
- **`adapter-doctor.ts` does not use `loadValidatedAdapterProfile`**: it loads profiles via `resolveAgentProfilePath` + direct `readFile` (lenient, returns null on failure). This is acceptable because `adapter-doctor` is diagnostic-only (no writes), and `readProjectFileForDoctor` uses `resolveSymlinkFreeProjectPath` for all file reads. Contract violations are caught by `doctor.ts`'s `checkAgentProfiles`. Model profile loading uses the shared `loadModelProfilesSafe` loader with symlink-free resolution.
- **`context_dir` lazy creation**: `adapter install` and `adapter upgrade` resolve `context_dir` symlink-free and type-check it (must be a directory if it exists) but do **not** pre-create it via `mkdir`. The directory is created lazily by `atomicWriteText`'s parent-dir creation when the first context pack is written. This eliminates an unnecessary side effect from the install/upgrade path.
- **`projectFs` seam**: all `src/` modules now import fs functions from `src/core/project-fs/index.ts` instead of `node:fs/promises` or `node:fs` directly. The seam re-exports the full `node:fs/promises` surface plus sync helpers and types from `node:fs`. The `check:fs-authority` AST gate treats `project-fs/index.ts` as a trusted module. This enables exhaustive `vi.mock` spying in tests and provides a single point for future safety policy enforcement.
- **`check:fs-authority` scope**: the AST gate currently covers `adapter-install.ts`, `adapter-upgrade.ts`, `adapter-doctor.ts`, and `doctor.ts`. The `projectFs` seam centralization (B-7) now makes it feasible to expand the gate to all `src/` files that import from `project-fs/index.ts`, since direct `node:fs/promises` imports have been eliminated. The `check:fs-containment` lexical guard already covers the broader scope.
- **Adapter multi-file mutation transaction**: adapter install/upgrade stage all desired-file writes via `FileTransaction` — each write goes to a temp file first, then all are committed (renamed) in sequence. A failure during staging or commit triggers rollback (temp file cleanup), so a mid-loop failure does not leave partial state on disk. Orphan prunes run after the transaction commits; the manifest write (the commit record) runs last, so the old manifest still reflects the old state if the write loop fails.
- **Dynamic generated-file provenance**: dynamic skill files now include a provenance marker (`<!-- code-pact:generated skill="name" command="cmd" -->`) as their first line. `checkDynamicProvenance` reads ONLY the first 256 bytes (never the full file) to determine if a file was code-pact-generated. If the marker matches, the file is treated as managed-clean and can be adopted or updated. If the marker is absent or foreign, the file is preserved with a warning (never read or hashed). This enables convergent ownership for code-pact-generated dynamic files while still protecting user-authored files in the shared `.claude/skills/*.md` namespace.
