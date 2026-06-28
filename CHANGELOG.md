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

### Security

- **Context pack no longer follows a `design/constitution.md` symlink out of the project (CWE-59).** `loadConstitution` now reads through the same project-contained helper as rules/decisions (`resolveWithinProject`), so a repo that symlinks `design/constitution.md` to an outside file cannot leak that file into the agent-facing context pack. A missing/unreadable/unsafe constitution still degrades to "not included".
- **`task complete --dry-run` no longer executes verification shell commands (CWE-78).** The caller's `dryRun` is now propagated into verify, so the project-controlled `verification.commands` (run with `shell: true`) are previewed, not executed, on a dry run. The read-only decision gate still runs. **Behavior change:** a `--dry-run` whose only failing check is a command no longer exits 1 — it returns a clean `dry_run` preview. A non-dry-run completion is unchanged (it executes commands and fails on a failing command).
- **Adapter manifest I/O fails closed on a `.code-pact/adapters` symlink escape (CWE-59).** `readManifest` / `writeManifest` resolve the manifest path through `resolveWithinProject`, so a symlinked adapters directory can no longer make a read pull a foreign manifest or a write land outside the project. `adapter install` / `adapter upgrade` map the refusal to a structured `ADAPTER_MANIFEST_INVALID` envelope (exit 2) instead of leaking an internal error / exit 3.
- **Atomic writes use unpredictable, exclusively-created temp files (CWE-59 / CWE-377).** Temp paths are now crypto-random and opened with `wx` (`O_CREAT|O_EXCL`), so a pre-planted symlink at the temp path is refused (EEXIST, never followed) instead of being written through to an outside target.
- **`adapter install` no longer trusts a project-shipped manifest hash to preserve stale/forged generated content (CWE-345).** A `managed-clean` file whose content no longer matches the generator output is now re-rendered (`update`) instead of skipped, so a forged manifest hash matching shipped-malicious instructions is self-healed. A managed file that matches **neither** the manifest hash **nor** the generator output (`managed-modified × stale` — the shape a hostile repo ships: malicious content + a non-matching forged hash) is no longer **silently** skipped: it is **refused** (not overwritten — it could be a genuine local edit — but surfaced via `result.refused[]` / `files[].action: "refuse"`, and `adapter install` exits 1). Genuinely user-modified files are still never overwritten.
- **`adapter upgrade --write` no longer deletes an orphan just because the manifest claims it (CWE-73).** An orphan is auto-pruned only when its path is in the adapter descriptor's `ownedPathGlobs`; an orphan outside that set is surfaced (`action: "warn"`) and kept on disk. **Behavior change:** a renamed/removed generated file whose path is not in the owned set is now reported rather than auto-deleted, so a forged manifest entry cannot turn `upgrade --write` into an arbitrary in-project delete.
- **`adapter install` / `adapter upgrade` establish read authority before touching generated-file targets (CWE-200).** Static existing files are read only after exact path+role authorization and symlink-free resolution. Existing dynamic skill collisions are refused without reading or hashing their bytes, and unowned manifest orphans are reported as `local: "unverifiable"` without a target existence/hash probe. This removes the manifest-SHA equality oracle for profile redirects such as `.env`.
- **Adapter placeholder preflight now rejects every symlink component before model pinning (CWE-59).** `context_dir` / `hook_dir` use the same strict owned-path resolver as the commit phase, including in-project final and parent symlinks. The resolved paths are carried into mkdir, generated-file write/prune, and manifest-write phases, so a failed `--model` install/upgrade cannot leave only the profile pin behind.
- **Glob matching is now linear and backtrack-free (CWE-1333).** The file-walk / write-audit / doctor match paths use a two-pointer segment matcher instead of a regex compiled from `**`, eliminating the catastrophic backtracking a project-controlled `task.reads` glob could trigger. A pattern-length cap is also enforced in `validateGlobSyntax`.

## [2.0.0] — 2026-06-18

**v2.0.0 — bounded archive maintenance.** `state archive-maintain` is the one command that keeps `.code-pact/state/archive` bounded — it recovers any pending delete-intent journal, compacts the loose tail into bundles, retains/removes unreferenced old truth, re-plans, and runs `validate` + `plan lint`, reporting an honest `bounded_status`. **Scope (no over-claim):** v2.0.0 bounds the archive's **file-count** sprawl and removes **unreferenced old truth** while **preserving referenced truth**. It does **not** yet bound a single bundle's **byte size** — sharding is the next storage milestone. This is a **major** bump because of one breaking error-code-contract change (see Changed → `MISSING_PHASE_FILE`).

### Changed

- **Behavior fix (error-code contract): `doctor` / `validate` now report a roadmap-referenced missing phase file as `MISSING_PHASE_FILE`, matching `plan lint`.** Previously `doctor` (and `validate`, which delegates to it) emitted `ORPHAN_PHASE_FILE` (severity `error`) for a `roadmap.yaml` reference whose phase file is absent or present-but-inaccessible — the opposite of that code's documented meaning ("a phase file present but not referenced"), so a user looking the code up read a contradictory definition. The condition now uses the code whose name matches it (`MISSING_PHASE_FILE`, *referenced but not present*), with **severity unchanged (`error`)**. `ORPHAN_PHASE_FILE` (warning) is unchanged and now means **only** *present but unreferenced*. **Migration:** a consumer that string-matched `doctor` / `validate` JSON for `ORPHAN_PHASE_FILE` to detect a missing referenced phase must switch to `MISSING_PHASE_FILE`; one that keys on `severity` (error vs warning) needs no change. `plan lint` already used `MISSING_PHASE_FILE` and is unaffected.
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
