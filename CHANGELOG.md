# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/). The
v0.1.0-alpha through v0.9.0-alpha line used `MAJOR.MINOR.PATCH-alpha.N`
identifiers. Starting with v1.0.0, stable releases use plain
`MAJOR.MINOR.PATCH` and prereleases (if any) use the standard
`-rc.N` / `-beta.N` suffixes.

---

## [Unreleased]

### Changed
- **Retired the internal general-purpose Evidence Harness.** Removed its release-coupled aggregate CSV/JSON snapshots and dedicated unit/integration test path because the archived dogfood corpus no longer produced actionable live-task measurements. The focused P51 agent-detail byte fixture remains under `docs/maintainers/evidence/` as a direct regression check for the compact evidence contract.
- **Leaned the automated npm release path.** Removed the duplicate release-gate build, added bounded timeouts to every publish job, and reduced transient release artifact retention to seven days while preserving Trusted Publishing, provenance, and registry tarball verification.

## [2.1.0] — 2026-07-11

### Added
- **Agent-sized verification detail and local evidence retrieval.** `verify --json --detail agent` and `task complete --json --detail agent` now emit a compact Failure Capsule for agents while preserving the legacy default / `--detail full` JSON shapes. `task prepare` now returns those agent-detail forms in `commands.verify` and `commands.complete`, so generated adapters can consume the compact failure contract without inventing extra flags. Failed command stdout/stderr are stored once in the gitignored derived Evidence cache under `.code-pact/cache/evidence/`, referenced by an opaque `evidence:sha256:<digest>` value, and retrievable with `code-pact evidence show <ref> --json`. Agent-detail JSON is bounded below 24 KiB, including cancellation, timeout, preflight, and oversized-output failures.

## [2.0.1] — 2026-07-10

### Security
- **Bounded verification commands and cancellation.** `verify` and `task complete` now apply a validated per-command timeout (default 300000 ms), preserve command-level exit/output/timing results, terminate descendant process trees on timeout or abort, and connect CLI `SIGINT` / `SIGTERM` to clean cancellation. `task complete` checks cancellation before its atomic event-write commit point, so a cancelled pre-commit run records no `done` event. POSIX CI exercises CLI signal translation; Windows CI exercises the same bounded-command timeout/AbortSignal path plus `taskkill` process-tree cleanup without depending on synthetic Windows signal delivery.
- **Reviewed development toolchain is pinned and continuously checked.** pnpm is fixed at 10.34.2, Vite resolves to 6.4.3, and esbuild resolves to 0.28.1. pnpm explicitly denies esbuild lifecycle scripts with `allowBuilds.esbuild: false`; the supply-chain gate verifies package/workspace/lockfile pins, and Linux/Windows CI verify the installed pnpm, Vite, and esbuild versions, execute an esbuild transform smoke, and build the project.
- **Portable permission-error and temporary-directory tests.** ADR unreadable-directory handling is exercised through injected filesystem failures instead of relying on `chmod 000` under root, and integration fixtures clean their per-test temporary projects on success and failure paths.
- **Context pack no longer follows a `design/constitution.md` symlink out of the project (CWE-59).** `loadConstitution` now reads through the same project-contained helper as rules/decisions (`resolveWithinProject`), so a repo that symlinks `design/constitution.md` to an outside file cannot leak that file into the agent-facing context pack. A missing/unreadable/unsafe constitution still degrades to "not included".
- **`task complete --dry-run` no longer executes verification shell commands (CWE-78).** The caller's `dryRun` is now propagated into verify, so the project-controlled `verification.commands` (run with `shell: true`) are previewed, not executed, on a dry run. The read-only decision gate still runs. **Behavior change:** a `--dry-run` whose only failing check is a command no longer exits 1 — it returns a clean `dry_run` preview. A non-dry-run completion is unchanged (it executes commands and fails on a failing command).
- **Adapter manifest I/O fails closed on a `.code-pact/adapters` symlink escape (CWE-59).** `readManifest` / `writeManifest` resolve the manifest path through `resolveWithinProject`, so a symlinked adapters directory can no longer make a read pull a foreign manifest or a write land outside the project. `adapter install` / `adapter upgrade` map the refusal to a structured `ADAPTER_MANIFEST_INVALID` envelope (exit 2) instead of leaking an internal error / exit 3.
- **Atomic writes use unpredictable, exclusively-created temp files (CWE-59 / CWE-377).** Temp paths are now crypto-random and opened with `wx` (`O_CREAT|O_EXCL`), so a pre-planted symlink at the temp path is refused (EEXIST, never followed) instead of being written through to an outside target.
- **`adapter install` no longer trusts a project-shipped manifest hash to preserve stale/forged generated content (CWE-345).** A `managed-clean` file whose content no longer matches the generator output is now re-rendered (`update`) instead of skipped, so a forged manifest hash matching shipped-malicious instructions is self-healed. A managed file that matches **neither** the manifest hash **nor** the generator output (`managed-modified × stale` — the shape a hostile repo ships: malicious content + a non-matching forged hash) is no longer **silently** skipped: it is **refused** (not overwritten — it could be a genuine local edit — but surfaced via `result.refused[]` / `files[].action: "refuse"`, and `adapter install` exits 1). Genuinely user-modified files are still never overwritten.
- **`adapter upgrade --write` no longer deletes an orphan just because the manifest claims it (CWE-73).** An orphan is auto-pruned only when its path is in the adapter descriptor's `ownedPathRoles`; an orphan outside that set is surfaced (`action: "warn"`) and kept on disk. **Behavior change:** a renamed/removed generated file whose path is not in the owned set is now reported rather than auto-deleted, so a forged manifest entry cannot turn `upgrade --write` into an arbitrary in-project delete.
- **`adapter install` / `adapter upgrade` establish read authority before touching generated-file targets (CWE-200).** Static existing files are read only after exact path+role authorization and symlink-free resolution. Existing dynamic skill collisions are **preserved opaquely** (warn, not refuse): their bytes are never read or hashed, but the rest of the install/upgrade continues (static writes, model pin, manifest refresh). Unowned manifest orphans are reported as `local: "unverifiable"` without a target existence/hash probe. This removes the manifest-SHA equality oracle for profile redirects such as `.env`.
- **Adapter authority model is now role-scoped (CWE-345).** `ownedPathGlobs` and `writePathGlobs` are replaced by `ownedPathRoles` (exact static read/hash/overwrite/delete authority) and `createPathGlobsByRole` (role-scoped create-only authority). A missing target whose path matches a create glob AND whose role matches the key may be CREATED; an existing file at that path is never read, hashed, or overwritten. This prevents a forged manifest from elevating a shared-namespace path (e.g. `.claude/skills/private.md`) to read authority via a wildcard match.
- **Adapter placeholder preflight now rejects every symlink component before model pinning (CWE-59).** `context_dir` / `hook_dir` use the same strict owned-path resolver as the commit phase, including in-project final and parent symlinks. The resolved paths are carried into mkdir, generated-file write/prune, and manifest-write phases, so a failed `--model` install/upgrade cannot leave only the profile pin behind.
- **Glob matching is now linear and backtrack-free (CWE-1333).** The file-walk / write-audit / doctor match paths use a two-pointer segment matcher instead of a regex compiled from `**`, eliminating the catastrophic backtracking a project-controlled `task.reads` glob could trigger. A pattern-length cap is also enforced in `validateGlobSyntax`.
- **`context_dir` is now restricted to the `.context/**`namespace (CWE-22/CWE-73).** The`AgentProfile.context_dir`field is validated by a dedicated`ContextOutputDir`schema that rejects any path outside`.context/`. A new `resolveProfileContextOutputPath`enforces namespace containment and symlink-free resolution before any write.`writeContextPack`and`task prepare --dry-run`both route through this resolver, so a hostile profile can no longer redirect context pack output to an arbitrary project file (e.g.`CLAUDE.md`or`.env`).
- **Manifest `agent_name` identity check (CWE-345).** `readManifest` and `writeManifest` now refuse a manifest whose `agent_name` doesn't match the target agent (`ADAPTER_MANIFEST_INVALID`), preventing a cross-agent manifest swap from being acted on.
- **`classifyManifestFileForRead` now enforces role mismatch before filesystem access (CWE-200).** The API is simplified: the declared role is always checked against the static path's expected role. A role-swap (e.g. `CLAUDE.md` with `role: skill`) is `unowned` before any read/stat/heading inspection — no content oracle. The `roleCheck` / `expectedRoleFor` parameters are removed; the declared role is passed directly.
- **`dedupeDesiredFiles` now rejects same-path different-role duplicates (CWE-345).** Two desired files at the same path with identical content but different roles now throw `ADAPTER_DESIRED_PATH_CONFLICT`, preventing a role confusion from silently corrupting the adapter's converged state.
- **`resolveOwnedProjectPath` renamed to `resolveSymlinkFreeProjectPath`.** The old name implied ownership proof; the new name accurately describes the function's behavior: symlink-free project containment. A deprecated alias keeps existing imports working.
- **Adapter staged transactions are journaled before project temp files are written.** `FileTransaction` now separates pre-commit rollback from post-commit cleanup and writes the prepared journal to user-private state before staging project-side temp files. Backup/temp/journal cleanup failures after the durable commit marker surface as `TRANSACTION_CLEANUP_PENDING` while preserving the new final files. The next adapter install/upgrade attempts journal recovery before starting a new mutation.
- **`check:fs-authority` now rejects known false-negative bypasses.** The gate no longer treats `resolveWithinProject` or generic `resolveOwnedReadPath` as authority sources, merges branch authority by capability intersection, checks multi-path fs operations such as `rename`/`copyFile`/`symlink` per argument, tracks aliased projectFs/raw fs sinks, rejects namespace/dynamic/require raw fs calls, and removes the trusted-name nested-function exemption.
- **Dynamic adapter skills are create-once handoff outputs.** A newly created dynamic skill records `ownership: handed_off` in the manifest. Later runs do not use the reserved `code-pact-*` prefix as provenance, do not read/hash/update/prune the file, and do not repeatedly warn once handoff is recorded.

## [2.0.0] — 2026-06-18

**v2.0.0 — bounded archive maintenance.** `state archive-maintain` is the one command that keeps `.code-pact/state/archive` bounded — it recovers any pending delete-intent journal, compacts the loose tail into bundles, retains/removes unreferenced old truth, re-plans, and runs `validate` + `plan lint`, reporting an honest `bounded_status`. **Scope (no over-claim):** v2.0.0 bounds the archive's **file-count** sprawl and removes **unreferenced old truth** while **preserving referenced truth**. It does **not** yet bound a single bundle's **byte size** — sharding is the next storage milestone. This is a **major** bump because of one breaking error-code-contract change (see Changed → `MISSING_PHASE_FILE`).

### Changed

- **Behavior fix (error-code contract): `doctor` / `validate` now report a roadmap-referenced missing phase file as `MISSING_PHASE_FILE`, matching `plan lint`.** Previously `doctor` (and `validate`, which delegates to it) emitted `ORPHAN_PHASE_FILE` (severity `error`) for a `roadmap.yaml` reference whose phase file is absent or present-but-inaccessible — the opposite of that code's documented meaning ("a phase file present but not referenced"), so a user looking the code up read a contradictory definition. The condition now uses the code whose name matches it (`MISSING_PHASE_FILE`, _referenced but not present_), with **severity unchanged (`error`)**. `ORPHAN_PHASE_FILE` (warning) is unchanged and now means **only** _present but unreferenced_. **Migration:** a consumer that string-matched `doctor` / `validate` JSON for `ORPHAN_PHASE_FILE` to detect a missing referenced phase must switch to `MISSING_PHASE_FILE`; one that keys on `severity` (error vs warning) needs no change. `plan lint` already used `MISSING_PHASE_FILE` and is unaffected.
- **Docs: trimmed duplicated error-code tables from concept docs.** `concepts/finalization-reconciliation.md` and `concepts/governance.md` now link to `cli-contract.md` § Error codes for exit codes / triggers / envelopes instead of restating them in their own tables (matching the existing `concepts/runbook.md` pattern). Reference detail stays in its single owner; the concept docs keep only the mental model. No code change.

### Added

- **`state archive-maintain [--keep-latest N] [--write] [--json]` — the one
  high-level command that keeps the archive bounded.** It orchestrates the
  existing archive primitives in the safe order (recover any pending
  delete-intent journal → `compact-archive` all kinds → `archive-retention` →
  compact again if a follow-up materialised → re-plan → `validate` → `plan
lint`) so an operator no longer has to remember and order the low-level verbs.
  It adds **no new destructive semantics and no new persistent state** — a thin,
  honest orchestration over `compactArchive` / `applyArchiveRetention` and their
  journal recovery, writing nothing outside `.code-pact/state/archive` (no
  global maintenance ledger, no status/cache file, no timestamps/PIDs into
  tracked state — so it does not add a Git merge hotspot, and the same records
  fold to byte-identical bundles on independent branches). Dry-run by default
  (read-only, lock-free); `--write` runs the whole orchestration under one outer
  write lock. The result is reported honestly via a `bounded_status`: a
  `source: both` follow-up, a deferred mixed pair, an un-foldable record, or a
  pending journal all read as NOT bounded, and every `skipped` record is
  surfaced (never a silent drop). In healthy, compactable cases, compaction
  running first resolves ordinary mixed-source / `source: both` redundancy in the
  same maintenance run; deferred / skipped records (a `bundle_stale` divergence,
  an unsupported-platform `fsync`, a recovered bundle-pair survivor) remain
  explicitly **not bounded** and are reported with per-record reasons.
  **Scope (no over-claim):** v2.0.0 bounds the archive **file-count sprawl** and
  removes **unreferenced old truth** while **preserving referenced truth**. It
  does **not** yet bound a single bundle's **byte size** —
  `bundle_byte_size_bounded` is always `false`; sharding is the next storage
  milestone. New public error code `BUNDLE_PAIR_NOT_COMMITTABLE` (a bundle-pair
  removal's pre-commit reverify found the store no longer matches the plan;
  fail-closed, re-plan and re-run). See
  [`cli-contract.md` § `state archive-maintain`](docs/cli-contract.md#state-archive-maintain)
  and [`docs/maintainers/operations.md` § Archive maintenance](docs/maintainers/operations.md#archive-maintenance-v20).
- **`plan sync-paths --rename <old>=<new>`** — apply an explicit old→new path
  rename to the `reads` / `writes` of every phase task. Renaming or merging a
  source file that a (often historical, done) phase still lists in its `reads`
  previously left `plan lint --strict`'s reads-match invariant to be fixed by
  hand; this command does it deterministically. (A file that is gone for good is
  handled by removing the stale entry by hand — sync-paths only maps old→new.) Dry-run by default;
  `--write` applies under the write lock. Repeat `--rename` for multiple moves;
  entries that collapse to one path are de-duplicated. It only rewrites
  `reads` / `writes` of tasks under `design/phases/` — never CHANGELOG or RFC
  prose. The `TASK_READS_NO_MATCH` lint message now names this command as the
  fix. See [docs/troubleshooting.md](docs/troubleshooting.md).
- **`pnpm gen:doc-blocks` / `check:doc-blocks` — generate enumerable contract
  facts from code instead of hand-writing them.** The first such block is the
  `spec import` `data.detail` table in `cli-contract.md`, now rendered from the
  typed `SPEC_IMPORT_DETAILS` catalog in `src/contracts/spec-import-details.ts` (a
  side-effect-free module the generator reads without pulling in command-handler
  deps; the duplicated enum list in `spec-kit-bridge.md` is replaced by a link).
  No CLI behavior change. The new `check:doc-blocks` (in `check:docs`) checks only
  generated-block **drift** — it never lints prose, style, or concept docs, so it
  can fail only a PR that touches the generated contract surface (the catalog, the
  generator, or the block itself); the fix is `pnpm gen:doc-blocks`. The decision,
  rollout, and the CI-burden contract every future doc check must satisfy are in
  the retired `doc-truth-from-code-rfc.md` (git history / `.code-pact/state` archive
  record) and the live [design/rules/doc-authoring.md](design/rules/doc-authoring.md).
- **Generated detail enums for `plan brief` / `plan constitution`.** The
  `--from-file` / `--stdin` `data.detail` enums now derive from a shared
  side-effect-free catalog (`src/contracts/plan-capture-details.ts`) consumed by
  both command runtimes, and a single `cli-contract.md` table is generated from it
  (both command sections link to it; drift-checked by `check:doc-blocks`). The
  generator gained `|`-escaping for table cells. No CLI behavior change.

## Older versions

Releases before the current major are archived (moved verbatim, not deleted):

- v1.x — [docs/maintainers/history/CHANGELOG-1.md](docs/maintainers/history/CHANGELOG-1.md)
- v0.x — [docs/maintainers/history/CHANGELOG-0.md](docs/maintainers/history/CHANGELOG-0.md)
