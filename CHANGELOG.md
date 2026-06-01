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

### CI / adoption page (P44)

**Added**

- **P44 — `docs/workflows/ci.md`** (+ its `docs/ja/workflows/ci.md` mirror) as the single CI adoption home: a thin orchestration page that separates a before-a-PR contributor loop from a maintainer/release full loop, ships one minimal `pull_request` GitHub Actions workflow on the project-local **pinned** binary (not a floating tag), explains that some `plan lint --include-quality` diagnostics are advisory (`affects_exit: false`) review guidance rather than hard blockers, and consolidates the CI preconditions (commit the ledger, `fetch-depth: 0`, exact pin, `--audit-strict` + `--base-ref`) into one checklist. The copy-paste workflow template is owned by `ci.md`; `cli-contract.md` keeps only the `--base-ref` contract + diagnostics and links to it. Also synced `docs/ja/getting-started.md`'s install-facing guidance (Prerequisites + Install) to the exact-pin path (P42 follow-up). Design in `design/decisions/ci-adoption-page-rfc.md`. Closes the post-1.26 agent-DX backlog.

### task prepare lifecycle-aware (P40)

Make `task prepare`'s existing guidance reflect `recommendation.lifecycleMode`, without adding a third "what next" representation. Design in `design/decisions/task-prepare-lifecycle-aware-rfc.md`.

**Added**

- **P40-T1 — `record-done` command + mode-aware `next_action.message`.** `task prepare`'s `commands` dict gains an always-present additive `record-done` key (every mode) — the one non-runnable entry, emitted as the template `code-pact task record-done <id> --agent <agent> --evidence "<verification you ran>"` (`--evidence` is agent-supplied). The other 5 keys are unchanged; `commands` stays a complete, mode-agnostic lookup table. `next_action.message` becomes the single mode-aware guidance surface for the two workable states (`start_task` / `continue_implementation`): `record_only` points at `task record-done --evidence` (and says "lighter loop, not lighter verification") rather than "complete the task"; `decision_loop` says resolve/accept the gating ADR first (verification and completion-recording paths block on the gate) and a generic implement→verify step — it does **not** decide complete-vs-record-done (the mode stays `decision_loop` whenever `requires_decision` is true, independent of ADR acceptance, so it never implies the post-gate path); `full_loop` keeps the current wording. Early-return states (done/blocked/failed) keep their static messages. No new `recommended_flow`, no ordered array, no new `next_action.type`; no behavior change to `task complete` / `record-done` / `verify`.
- **P40-T2 — docs.** `docs/cli-contract.md` (the `task prepare` envelope `commands` block + a bullet: `commands` is a complete mode-agnostic lookup table, the key is exactly `record-done`, its `--evidence` is agent-supplied so it is the one non-runnable template, and `next_action.message` — not `commands` — is the lifecycle-aware surface) and `docs/agent-contract.md` (the `task prepare` bullet notes `commands["record-done"]` and the mode-aware `next_action.message`). `per-task-loop.md` is linked, not redefined (P41 consolidated `record_only`); a docs-tree sweep confirmed no stale full_loop-only prepare guidance remains (the tutorial/overview full_loop diagrams are the standard-loop illustration, not a per-task mode claim, and stay). **Closes P40** — the phase + its tasks are flipped to `status: done` and the backlog/README marked shipped in this reconcile.

### Leaf help + docs straightening (P41)

Bring the task lifecycle verbs' `--help` to parity and pin it, so agents that read leaf help as an exploration surface get consistent guidance. Design in `design/decisions/leaf-help-docs-straightening-rfc.md`.

**Added**

- **P41-T1 — rich `--help` for the 7 stubbed task lifecycle verbs.** `task add`, `task context`, `task start`, `task status`, `task block`, `task resume`, and `task runbook` now have rich help (Usage line, description with cross-refs, an `Options:` list of the verb's actual flags, and `Examples:`) instead of the 2-line stub — joining the already-rich `prepare`/`complete`/`record-done`/`finalize`. `task add` documents its `<phase-id>` positional, the wizard-vs-non-interactive split, `--type` required-with-`--description`, the repeatable scope flags, and folds the six sizing/readiness enums into one line; `task block` marks `--reason` required; `task context` documents `--explain` / `--budget-bytes` (read-only). A new unit suite `tests/unit/cli/task-lifecycle-help-terms.test.ts` pins all 11 rich task verbs to a per-verb required-term set (and that each is not the stub), and `tests/integration/cli-help.test.ts` checks the 7 through the built CLI (Usage + a flag + `Examples:`). No behavior change — help text only. (`task next` / `task reconcile` aliases intentionally stay stubs.)
- **P41-T2 — consolidate the `record_only` explanation (closes P41).** The lifecycle-mode concept was explained in full in several docs and drifted. `docs/per-task-loop.md` § "Recording a done without task complete" is the single canonical home (unchanged); the two concept-duplicate blocks in `docs/cli-contract.md` (the `task record-done` section) and `docs/agent-contract.md` now link to it for the lifecycle explanation while keeping their role-specific content (cli-contract's flags/exit/envelope and the lifecycleMode **schema decision rule**; agent-contract's decision-gate facts and the conformance row). No new docs page; the glossary term def, the `CLAUDE.md` template, and the ja mirrors are untouched. Reduces duplication without growing the docs set.

### ADR downstream commitments (P43)

Make the proven ADR→downstream effect first-class: an accepted ADR may record the concrete work its decision implies, and `task prepare` surfaces it. Deterministic and advisory-only — no new gate, no LLM summary. Design in `design/decisions/adr-downstream-commitments-rfc.md`.

**Added**

- **P43-T1 — `## Implementation commitments` parsing + `decision_commitments` on `task prepare`.** An accepted ADR may carry a `## Implementation commitments` section (a GFM checkbox list). `parseAdrCommitments` (in `src/core/decisions/adr.ts`) extracts its items deterministically — checkbox extraction under the fixed heading, no summarization — returning `{ hasSection, items: { text, done }[] }` (`hasSection` distinguishes "no section" from "present but empty"). `task prepare` now resolves the decision gate for a `requires_decision` task (read-only — the progress-read-only invariant holds) and adds an additive `decision_commitments` field: one entry per **accepted** ADR the gate considered, each with `adr` / `has_section` / `items`, in the resolver's `considered[]` order (no priority/chronological meaning). The field is present (possibly `[]`) only for gated tasks and omitted otherwise; it is `[]` only when the resolver found no accepted ADR entries (an unresolved explicit `decision_refs` gate may still surface commitments for its accepted refs) — `task prepare` does not fail, adds no decision-error surface, and does not duplicate the `verify` / `task complete` gate enforcement. `done` semantics: unchecked = downstream work to do; checked = already satisfied or an explicit non-work statement. Documented in `docs/cli-contract.md` (the `task prepare` envelope), `docs/agent-contract.md` (read it as advisory context, not a gate), and `docs/concepts/decision-gate.md` (the ADR section + `done` semantics + the no-work anti-abuse note).
- **P43-T2 — `ADR_COMMITMENTS_EMPTY` plan-lint advisory (closes P43).** `plan lint --include-quality` now emits `ADR_COMMITMENTS_EMPTY` (`severity: warning`, `affects_exit: false` — never changes the exit code, including under `--strict`) when an **accepted** ADR that **resolves** a `requires_decision` task's decision gate records no implementation commitments — no `## Implementation commitments` section, or one with zero GFM checkbox items (checked **and** unchecked all count). Scoped to accepted ADRs that **resolve** a gated task's gate: a historical/unreferenced ADR never fires, and an accepted ref inside a partially-accepted (hence unresolved) explicit `decision_refs` set never fires either (that is `TASK_DECISION_UNRESOLVED`'s job). One issue per ADR file (first task wins); `file` is the ADR path with **no `path`** field (the subject is ADR content, not a plan-YAML field, matching the other ADR-centric advisories); `details.has_section` / `details.item_count` distinguish "no section" from "empty section".
- **P43-T2 also adds `PHASE_DOCS_WRITE_NO_DOC_CHECK`**, an advisory-only (`affects_exit: false`) `plan lint --include-quality` quality check that warns when a **not-yet-`done`** phase has a task that `writes` a public doc (`docs/**` or a root-level `.md`; CHANGELOG.md and `design/**` excluded) but whose `verification.commands` run no doc check (`check:docs` / `check:doc-links` / `check:doc-invariants`). It generalizes the P39/P43 docs-drift lesson into a deterministic, forward-looking guard (`done` phases are never flagged). Both new codes are registered in `KNOWN_CODES` + the plan diagnostic codes table; documented in `docs/cli-contract.md`, `docs/troubleshooting.md`, and `docs/concepts/decision-gate.md`.

### Self-describing adapter skill names + orphan prune on upgrade

Dogfooding the Claude Code adapter surfaced two related defects in how
verification-command skills are generated under `.claude/skills/`. Both are
fixed here; no public CLI surface changes.

**Fixed**

- **Self-describing skill names.** Skill names derived from a phase's
  `verification.commands` used to take only the command's *last* token, so
  distinct commands collapsed to the same name and were disambiguated with
  opaque numeric suffixes (`doctor-2.md`, `claude-code-2.md`), and a flag
  *value* could leak into the name (`adapter doctor --agent claude-code` →
  `claude-code`, the v1.19 collision). Name derivation now strips the runner
  prefix (`pnpm`/`npm`/`yarn`/`bun` + optional `run`, `node <script>`, bare
  `code-pact`), joins the subcommand *words* up to the first flag
  (`adapter-doctor`, `plan-lint`, `validate`), and resolves any genuine
  collision by walking a deterministic flag-qualified ladder
  (`adapter-upgrade`, `adapter-upgrade-check`, `adapter-upgrade-check-json`)
  before ever falling back to a numeric suffix. The first flag is the
  word/flag boundary, so a flag value or trailing positional never leaks into
  the name regardless of which flags take values. Determinism, uniqueness, and
  reserved-name safety (`context`/`verify`/`progress`) are preserved.
- **Orphan prune on `adapter upgrade`.** Renaming a generated skill used to
  leave the old file on disk untracked — `upgrade` did not remove a path the
  generator no longer emits, and `doctor` did not surface it (its
  `ownedPathGlobs` are deliberately narrow). `upgrade` now prunes orphans: a
  path tracked by the previous manifest but absent from the new generator
  output is deleted (`action: "prune"`) when its disk content still matches the
  manifest hash, and refused (`action: "refuse"`, left on disk and still
  tracked) when the user edited it. `--check` reports the actions without
  touching disk; a second `--write` is a clean no-op. Hand-authored skills that
  were never manifest-tracked are never considered. `"prune"` is a new
  `FileAction`.

### Root-cause-first completion errors (P39)

Make `task complete` name the real cause on the primary error face so an agent reading `error` first is not misdirected. Design in `design/decisions/root-cause-completion-errors-rfc.md`.

**Added**

- **P39-T1 — `error.cause_code` + actionable message on `task complete`.** On a `VERIFICATION_FAILED` failure, `task complete` now sets `error.cause_code` — `DECISION_REQUIRED` when the decision gate is unresolved (a `requires_decision` task with no accepted ADR), or `COMMANDS_FAILED` when a verification command failed — and an actionable `error.message` derived from the first failing check, embedding that check's reason (e.g. `"P3-T1 requires an accepted ADR before completion: <gate reason>. progress.yaml was not modified."` — the reason was added in the P39 follow-up below). This ports the cause that `task record-done` already surfaces. `error.code` stays `VERIFICATION_FAILED` (exit 1) for backward compatibility; the P32 `data` fields (`failed_checks` / `first_failure` / `suggested_next_command`) are unchanged and are **not** duplicated into `error`, and no structured decision block is added. `COMMANDS_FAILED` is a new `cause_code` value, registered in the error-code surface (the surface test now also scans `cause_code:` literals). `task finalize` is unchanged — it does not run the decision gate.
- **P39 follow-up — decision message embeds the gate reason + contract-rule reconcile.** The `DECISION_REQUIRED` `error.message` on `task complete` now embeds `first_failure.reason` (e.g. `… requires an accepted ADR before completion: No accepted ADR found for "P1-T1". …`), matching the command cause — so an agent reading only `error` learns *why* the gate is unresolved (missing / proposed / unsafe-ref) without reading `data`. `design/rules/json-output.md` now documents `error.cause_code` as an additive stable field and tells programs to branch on it for the root cause; `docs/agent-contract.md`'s `task complete` entry gains the cause-code recovery steps; the cli-contract / troubleshooting quick references now distinguish `task complete` (`error.cause_code`) from standalone `verify` (which on failure returns `ok:false` / `error.code: VERIFICATION_FAILED` / `data.checks`, no `cause_code`). Tests pin the embedded decision reason and that standalone `verify` carries no `cause_code`.
- **P39-T2 — human-output parity + docs (closes P39).** The non-JSON `task complete` failure path reaches parity: for **both** the decision and command causes, stderr leads with the actionable cause message (not the generic `Verification failed for …` string) followed by the shared `cause:` / `rerun after fixing:` lines — now pinned by human-output regression tests. `docs/cli-contract.md` documents `error.cause_code` (values, deterministic mapping, `error.code` staying `VERIFICATION_FAILED` at exit 1, and the deliberate asymmetry with `record-done`'s top-level `DECISION_REQUIRED`/exit 2) and states the decision gate runs in `verify` / `task complete` / `record-done` but **not** `task finalize`. No production-code change beyond P39-T1.

### Release readiness invariants (P38)

Internal quality infrastructure that closes the mechanically-detectable classes the 1.26.0 review found by hand. No CLI surface, no stats, no outcome audit. Design in `design/decisions/release-readiness-invariants-rfc.md`.

**Internal**

- **P38-T1 — shared security corpus + write-entrypoint coverage.** A single `tests/fixtures/security-corpus.ts` (`BAD_PLAN_IDS` / `BAD_RELATIVE_PATHS` + conventional-value counterparts) is now exercised at every plan/agent write entrypoint and schema boundary by `tests/unit/security/write-entrypoint-coverage.test.ts` — `PlanId` / `RelativePosixPath` and the `Task.id` / `Phase.id` / roadmap `PhaseRef.id` / `AgentRef.name` / `AgentProfile.{name,instruction_filename,context_dir,skill_dir,hook_dir}` / `AgentRef.profile` / `TaskImport.id` / `PhaseImportEntry.id` schemas, plus the runtime `createPhase` / `task add --id` / `recommend --agent` / `pack --agent` guards. The covered set is a pinned inventory so it can't silently shrink. Prevents the "constrained the read schema but missed a write entrypoint" regression that recurred across the 1.26.0 hardening rounds.
- **P38-T2 — release version consistency + `release:check`.** `scripts/check-release-version.mjs` (and `pnpm check:release-version`) asserts that `package.json` version, the first released `## [X.Y.Z]` CHANGELOG section, `design/measurements/summary.json`, and any `code-pact@X.Y.Z` docs example all agree, and that `RECOMMENDATION_CONSUMPTION_FROM_VERSION` never references a future version. `pnpm release:check` bundles the full release gate (typecheck, test, build, check:docs, check:release-version, validate, plan lint --strict, plan analyze --strict) into one command. `docs/cli-contract.md` now states the three trust boundaries (execution / path / identifier) explicitly.
- **P38-T3 — PR self-report + record-done help pin (closes P38).** The PR template (`.github/pull_request_template.md`) gains a "Surface self-report" table (public contract / command surface / docs-help / schema-validation boundary / write entrypoints / invariant tests / trust-boundary impact) that forces the surface inventory at authoring time — the cheapest backstop for the "missed a write entrypoint / let CLI help drift" class. `tests/unit/cli/record-done-help-terms.test.ts` pins `task record-done --help` to the reconciled `record_only` vocabulary and guards against regressing to the pre-P33 external-only framing.

## [1.26.0] — 2026-05-30

### Identifier & path hardening (security)

Plan identifiers and agent-profile path fields flow into agent-facing command strings and filesystem paths. They are now constrained at the schema boundary so untrusted or malformed plan content cannot produce broken commands or escape the project root.

**Security**

- **Plan-identifier charset.** `Task.id`, `Phase.id`, roadmap `PhaseRef.id`, and agent names (`Project.default_agent`, `AgentRef.name`, `AgentProfile.name`) are constrained to `^[A-Za-z0-9][A-Za-z0-9._-]*$` — the leading character must be alphanumeric, which rejects `..`, slashes, whitespace, shell metacharacters, and option-like ids (`--json`, `-P1`) that a generated command would otherwise misread as a flag. Enforced on the write entrypoints too (`phase import`, `phase add` / `createPhase`, `task add --id`) and on the raw `--agent` of `recommend` / `pack`; the write paths run `Phase.parse` / `PhaseRef.parse` before persisting. Conventional ids (`P1-T1`, `P34-ci-branch-drift`, `claude-code`) are unaffected.
- **Agent-profile path fields.** `AgentProfile.instruction_filename` / `context_dir` / `skill_dir` / `hook_dir` and `AgentRef.profile` are now project-relative POSIX paths (`RelativePosixPath`): absolute paths, `~`, `..`, `.`, empty segments, and backslashes are rejected, so a profile cannot redirect context-pack or adapter writes outside the project root.
- **Project-root confinement in pack.** Context-pack reads and writes are confined via `resolveWithinProject` (lexical traversal **and** symlink escape): `decision_refs`, the `design/decisions` / `design/rules` readdir loaders, and the `.context/<agent>` output directory. The `acceptance_refs` existence checks and the `--baseline` name are likewise constrained.

**Fixed**

- **`CONTEXT_OVER_BUDGET` envelope.** `task context` / `task prepare --budget-bytes` now place `budget_bytes` / `minimum_achievable_bytes` / `unelidable_sections` under a **top-level `data`** (matching the documented envelope convention and `doctor` / `validate`), not under `error.data`. An agent following the cli-contract recovery prose (`data.minimum_achievable_bytes`) now finds the fields.

### Roadmap: P37 (outcome audit) deferred

**Internal**

- **P37 deferred** — the reshape roadmap's outcome-audit / effectiveness-measurement item is deferred with no implementation: no phase, no `stats` / `task outcome` command, no `outcome` schema field. Subjective agent-reported metrics are gameable, a bugs-found metric contradicts code-pact's control-plane role, and the signals worth measuring (recommendation history, decision-gate blocks, verify failures) are not reliably derivable from `progress.yaml` today. The reshape closes at P36; the next step is real-world dogfooding and release prep. Rationale + revisit conditions in `design/decisions/P37-deferred-outcome-audit.md`.

### ADR quality advisory (P36)

The value of the ADR gate is that writing the ADR elicits the decision — but today an ADR only needs `status: accepted` to pass, so an accepted ADR with an empty body slips through. This surfaces that, without enforcing a template. Design in `design/decisions/adr-quality-advisory-rfc.md`.

**Added**

- **`ADR_ACCEPTED_BODY_THIN`** — a single `plan lint --include-quality` advisory (`warning`, `affects_exit: false`) that flags an `accepted` ADR whose body is an empty stub. **Structure-independent — no heading-name matching**: fires only when the substantive body (frontmatter removed, status line + h1 title stripped, whitespace normalized) is below `ADR_THIN_BODY_CHARS` (400) **AND** the raw body has zero `##` (h2) headings. This repo's legitimate ADRs vary widely in structure (they never use `## Consequences` / `## Alternatives`), so name-matching would false-positive; the AND keeps "short but structured" and "long but heading-free" ADRs from firing. A file that is *just* a `**Status:** accepted` line is in scope; a 0-byte empty file and proposed/draft ADRs are not. Advisory only — the `task complete` / `verify` decision gate is unchanged. (A canonical-template-based check, if ever wanted, is a separate future phase.)

### CI branch-drift detection (P34)

The working-tree `CONTROL_PLANE_NOT_DRIVEN` (v1.25) never fires in PR CI because the checkout is clean. This adds a branch-diff signal so CI can catch "real code changed but the control plane was not driven on this branch." Design in `design/decisions/ci-branch-drift-rfc.md`.

**Added**

- **`--base-ref <ref>` on `doctor` / `validate`** and a new advisory **`CONTROL_PLANE_BRANCH_NOT_DRIVEN`**. The check runs **only** when `--base-ref` is supplied and compares the branch diff (`merge-base..HEAD`, via the existing `auditWrites` merge-base mode). It fires when real, non-excluded files changed but the branch added **no** event that is `started`/`done` AND non-TUTORIAL AND a `task_id` present in the loaded plan — so merely touching `progress.yaml` (or appending an unrelated/unknown/TUTORIAL event) does not pass. A `started` **or** `done` for a known task suppresses it (usage detection, not completion guarantee).
- **Gate model.** Advisory (`severity: warning`) by default — plain `doctor` / `validate` exit unchanged. `validate --strict --base-ref origin/main` promotes it to exit 1 (existing strict semantics). Three-layer opt-in: no `--base-ref` → does not run; no `--strict` → does not fail; `disabled_checks` → off.
- **Team-declared exemptions.** `.code-pact/doctor.yaml` `control_plane_branch_not_driven.exclude_globs` (default **empty** — no built-in docs/config exemption) lets a repo declare paths whose change does not require driving the loop.
- **Conservative skips.** Silent skip when git/merge-base is unavailable, `progress.yaml` is not git-tracked (the ledger must be committed for CI to audit it), or HEAD `progress.yaml` is unparseable (`INVALID_YAML`/`SCHEMA_ERROR` owns that). docs ship a version-pinned GitHub Actions example; **no `ci scaffold` command**.

### Failure clarity for `task complete` / `task finalize` (P32)

When a `task complete` / `task finalize` failure occurred, the root cause already existed in the result but the surfaces an agent reads hid it — human output was a single generic line and JSON only carried `data.verify.checks`. An agent had to re-run the lower-level `verify` to decide its next action. This surfaces the cause and the next action at the point of failure. Design in `design/decisions/failure-clarity-rfc.md`.

**Added**

- **Three additive `data` fields on the `task complete` / `task finalize` failure envelopes** — `failed_checks: string[]`, `first_failure: { name, reason } | null`, and `suggested_next_command: string | null`, placed alongside the unchanged `data.verify.checks` / `data.write_audit`. `suggested_next_command` is a deterministic, AI-free switch on the failing check (or finalize code) → an exact command, and is a **rerun-*after-fixing*** command (it does not imply an unchanged rerun will succeed). `task complete --dry-run` failures carry the same fields (verification runs before the dry-run short-circuit). `task finalize` synthesizes a pseudo-check per failure code (`eligibility` / `write_safety` / `write_audit`). **No new error codes**, and existing fields are unchanged, so any consumer that ignores unknown fields is unaffected.
- **Richer human output** — below the existing generic failure message, `cause:` and a `rerun after fixing:` line (ja: `原因:` / `修正後に再実行:`) are printed to stderr. The label is deliberately *not* `next:`, so an agent does not read it as "just rerun unchanged".

**Internal**

- New pure helper `src/core/failure/failure-summary.ts` (no dependency on `src/commands/`; takes a structural `FailureCheckLike`) and a shared CLI renderer `src/cli/render/failure-summary.ts`, reused by both `task complete` and `task finalize`.

### Lightweight lane + recommendation consumption (P33)

`recommend` / `task prepare` returned a correct execution profile, but every task ran the full loop (ceremony for small, strongly-verified work) and nothing told an agent to *consume* the recommendation — a correct recommendation was produced but not acted on. This adds a lifecycle signal and the consumption contract together. Design in `design/decisions/lightweight-lane-rfc.md`.

**Added**

- **`lifecycleMode` on `recommend` / `task prepare`** — an additive field (`full_loop` | `record_only` | `decision_loop`) from a conservative deterministic switch: `decision_loop` when the task or phase `requires_decision`; `record_only` when `type ∈ {docs, test}` AND `ambiguity == low` AND `risk == low` AND `verification_strength == strong`; otherwise `full_loop`. `architecture` is **not** auto-`decision_loop`. Advisory only — code-pact's own `task complete` / `task record-done` behavior is unchanged.
- **Recommendation-consumption guidance in generated adapters** (both locales) — the "What to verify first" axis now tells agents to read `data.recommendation` as an execution profile (`tier`/`effort`/`planningRequired`/`lifecycleMode`), to report a limitation when the runtime **cannot switch model**, and that `record_only` is a lighter *loop* — **not** lighter verification (run the project verification commands, then `task record-done --evidence`).
- **Three version-gated `adapter conformance` checks** — `recommendation_consumption_guidance_present`, `lifecycle_mode_guidance_present`, `cannot_switch_model_fallback_present` verify the guidance is present (anchored on short stable tokens). Gated on a new `RECOMMENDATION_CONSUMPTION_FROM_VERSION` threshold (not the P30 one), so adapters generated between the P30 and P33 releases stay advisory rather than failing en masse.

**Internal**

- New `src/core/recommend/lifecycle.ts` (`recommendLifecycleMode`, reuses `isDecisionRequiredForTask`); `resolveRecommendation` takes a meaning-closed `decisionContext`. No `agent_action` JSON field (it would duplicate the prose guidance without adding enforcement).

## [1.25.0] — 2026-05-28

### `CONTROL_PLANE_NOT_DRIVEN` doctor advisory (RFC §2)

Completes the dogfood-trust-hardening RFC (§1 · §2 · §3 all now landed). Surfaces a project that adopted code-pact scaffolding but stopped driving it — real code lands in git while `progress.yaml` never advances.

**Added**

- **`CONTROL_PLANE_NOT_DRIVEN`** — a `doctor` advisory (`severity: warning`, never fails doctor's exit) that fires only when **all** of: a non-TUTORIAL task is planned; `progress.yaml` has no `started`/`done` event for a non-TUTORIAL task (running the tutorial does **not** count as driving the loop); and git shows uncommitted working changes (excluding code-pact's own runtime state, via `auditWrites`). **git-unavailable is a silent skip** (never an error), and a broken/unparseable `progress.yaml` is also skipped — the existing `INVALID_YAML`/`SCHEMA_ERROR` owns that. Silence via `.code-pact/doctor.yaml` → `disabled_checks: [CONTROL_PLANE_NOT_DRIVEN]`.

**Internal**

- `dogfood-trust-hardening-rfc.md` status flipped — §1, §2, and §3 (A/B/C/D) are all implemented; the RFC is fully realized.

### Hardening + DX polish (pre-1.25 review fixes)

**Fixed**

- **Decision gate is now fail-closed on unsafe `decision_refs`.** A `decision_refs` entry that escapes the project root (`..`, an absolute path, or a symlink that resolves outside the project root) is never read and never resolves the gate — previously the gate's file reader could follow such a path. The path-safety guard (`resolveWithinProject`) now backs the gate itself, not only the `TASK_DECISION_REF_UNSAFE_PATH` lint advisory, so `verify` / `task complete` / `task record-done` stay blocked regardless of whether `plan lint` ran first. The verdict is surfaced as `data.considered[].acceptance: "unsafe_path"` and is now part of the documented `DECISION_REQUIRED` / `TASK_DECISION_UNRESOLVED` JSON contract (plus `troubleshooting.md` and the decision-gate concept doc).
- **`task record-done` rejects blank evidence items instead of silently dropping them.** `--evidence` (or a programmatic `evidence` array) containing an empty/whitespace-only item is now a `CONFIG_ERROR`, so recorded proof can never be padded with empty entries.
- **`phase import --help`** now documents `--scaffold-decisions` and corrects the `--force` description — `--force` **skips** colliding phase ids (the rest still import), it does not overwrite them.
- **`writeProposedAdrIfAbsent`** only treats `ENOENT`/`ENOTDIR` as "file absent — safe to write"; any other `access` failure (e.g. `EACCES`) is rethrown rather than silently overwriting a file it could not stat.
- **Docs:** `--scaffold-decisions` is tagged `v1.23+` (the release it shipped in), corrected from `v1.22+`.

## [1.24.0] — 2026-05-28

### `ADR_STATUS_UNRECOGNIZED` lint advisory

The status-aware gate (v1.22) treats an explicit-but-unrecognized ADR status word (e.g. a typo `**Status:** acceptd`) as `unknown_status` — it does **not** resolve — which is safe but confusing: a decision stays blocked with no obvious cause. This surfaces the typo.

**Added**

- **`ADR_STATUS_UNRECOGNIZED`** — a `plan lint --include-quality` advisory (`warning`, `affects_exit: false`) that flags any `design/decisions/*.md` whose explicit status word is not one of `accepted` / `proposed` / `draft` / `rejected` / `superseded`. `details.status` is the offending word and `details.status_source` (`"frontmatter"` | `"bold-line"`) says which channel to fix (frontmatter wins over the bold line). File-centric (fires even for ADRs no task references yet) and complementary to `TASK_DECISION_UNRESOLVED`. Not raised for a missing status line or an empty file. Gate behavior is unchanged — this only explains *why* a gate is blocked.

## [1.23.0] — 2026-05-28

### Opt-in proposed-ADR scaffolding (RFC §3-D)

Importing an AI-generated roadmap full of `requires_decision: true` tasks left every one of them gated with no ADR to fill — the human had to hand-create each `design/decisions/<task-id>.md` before the gate could ever pass. `--scaffold-decisions` closes that gap.

**Added**

- **`phase import --scaffold-decisions`** (and **`plan adopt --write --scaffold-decisions`**) — opt-in flag that scaffolds a `**Status:** proposed` ADR stub for every task the decision gate would block (`requires_decision` on the task **or** its phase, via the shared `isDecisionRequiredForTask`). The stub opens at `proposed`, so the status-aware gate (RFC §3-C) still blocks `verify` / `task complete` / `task record-done` until a human flips it to `accepted` — scaffolding fills the work-surface, it does not pre-approve. Off by default; existing ADRs are never overwritten.
  - For a task with `decision_refs`, the missing referenced files **under `design/decisions/`** are scaffolded (the all-must-be-accepted contract); the task shape is never modified. Without `decision_refs`, the default `design/decisions/<task-id>.md` is used (skipped when a matching ADR filename already exists).
  - Path safety is enforced atomically in the import preflight: an unsafe `decision_refs` path or unsafe task-id filename segment (`P1/T1`) → `CONFIG_ERROR` with nothing written and the roadmap byte-identical. A safe `decision_refs` path outside `design/decisions/` is reported in `scaffold_skipped` rather than written.
- `phase import` / `plan adopt` results gain `scaffolded_decisions: string[]` and `scaffold_skipped: { ref, reason }[]` (always present).

**Internal**

- `dogfood-trust-hardening-rfc.md` flipped to record §3-D implemented; §2 (`CONTROL_PLANE_NOT_DRIVEN`) remains the one deferred item.

## [1.22.0] — 2026-05-28

### Status-aware ADR decision gate (RFC §3-C)

The `requires_decision` gate used by `verify` / `task complete` / `task record-done` / `plan lint --include-quality` now actually reads the ADR's status, not just its filename. Before this, any `.md` whose name contained the task id resolved the gate — including a `proposed` draft or an empty stub. The gate's whole purpose (a human has *accepted* the design decision) was therefore not enforced.

**Changed**

- **Status-aware resolution.** A decision resolves only when its ADR's status is `accepted`. The status is read from YAML frontmatter `status:` (preferred) or the `**Status:** <word>` markdown bold line. `proposed` / `draft` / `rejected` / `superseded`, empty files, and explicit unknown statuses (e.g. typos like `acceptd`) do **not** resolve.
- **Lenient backward compat.** A non-empty ADR with **no** status line still resolves as accepted — the only lenient case — so projects that pre-date status-aware parsing keep working.
- **`task.decision_refs` are now consulted by the gate** with **all-must-be-accepted** semantics: a single non-accepted, missing, empty, or unknown-status ref fails the gate. The fallback filename scan over `design/decisions/` keeps **any-accepted-wins** to preserve the substring-collision compat (`P1-T1` also matches `P1-T10-*.md`).
- **`DECISION_REQUIRED.data` now carries** `via` (`"decision_refs"` or `"filename-scan"`), `considered[]` (per-ADR `{path, status, accepted, acceptance}` where `acceptance` ∈ `accepted | blocked | empty | unknown_status | missing`), and `expected_pattern` only when `via === "filename-scan"`. `current_resolution` is now `"status-aware"`.
- **`TASK_DECISION_UNRESOLVED`** (advisory, `affects_exit: false`) now fires for a `proposed` / `draft` / `rejected` / `superseded` / empty / unknown-status ADR as well as for a missing one. `details.via` / `details.reason` / `details.considered` carry the resolver verdict.
- **Single shared resolver.** All four consumers (`verify`, `task complete` via verify, `task record-done`, `plan lint`) route through one `resolveDecisionGate` (with a memoized batch variant for lint), so they cannot diverge on what "resolved" means — the central RFC §3 constraint.

**Internal**

- `dogfood-trust-hardening-rfc.md` flipped to `accepted` for §3-A/B/C and §1; §3-D (auto-generated `proposed` stubs) remains deferred.

## [1.21.0] — 2026-05-28

### `task record-done` — an honest path for work completed outside the loop

Dogfooding exposed a gap: when a task was finished **outside** the code-pact loop (already merged, or otherwise not verifiable from the working tree), there was no honest way to record it. Agents were forced either to leave `progress.yaml` drifting from reality or to fake a full loop run against a working tree that no longer holds the change. This adds the missing path.

**Added**

- **`code-pact task record-done <task-id> --evidence "<text>" [--notes "<text>"] [--agent <name>] [--json] [--dry-run]`** — records a `done` event for externally-completed work. It does **not** run verification commands; the proof is the required `--evidence`. The event is recorded with `source: external`. Idempotent (`already_done` on a task already done), supports `--dry-run` (`would_append`, no write), and ships with full `--help` (usage, flags, examples). It is **not** a replacement for the normal `prepare → start → complete → finalize` loop — use it only for genuinely external completion.
- **`ProgressEvent.source`** — `loop` (produced by `task complete`) or `external` (produced by `task record-done`). Optional; a legacy `done` event with no `source` is treated as `loop` by readers. Only valid on `done` events.
- **`DECISION_REQUIRED`** public error code — surfaced when `task record-done` is run on a `requires_decision` task whose required ADR cannot be resolved by the current file-presence-based gate. Exit 2, `progress.yaml` untouched. The envelope carries `data.decision_check`, `data.current_resolution`, `data.expected_pattern`, and `data.declared_decision_refs` (informational only).

**Changed**

- `task complete` now records `source: loop` on its `done` event.

**Important limitation**

- `task record-done` respects the existing decision gate and will not mark a `requires_decision` task done unless the current ADR resolution logic succeeds. In v1.21.0 that gate remains **file-presence based** (a `.md` under `design/decisions/` whose name contains the task id) — it does **not** parse ADR status/frontmatter. Status-aware ADR validation is planned separately.

### Developer-experience: trustworthy prepare, precise audit, planning-prompt readiness fields, richer help

A batch of ergonomics fixes that make the control plane easier to trust and use day-to-day.

**Changed**

- **Write audit excludes code-pact runtime state.** `task finalize`'s `data.write_audit.files_touched` no longer lists `.code-pact/state/progress.yaml` or anything under `.code-pact/locks/` — these are the tool's own operational log and advisory lock, never a task's work product, and previously showed up as `outside_declared` noise. User-edited config (`.code-pact/project.yaml`, `.code-pact/agent-profiles/**`) and design/adapter files are still audited.
- **`plan prompt --schema-only` emits the task readiness fields.** The YAML format example now shows the optional `depends_on`, `reads`, `writes`, `decision_refs`, and `acceptance_refs` fields (which `phase import` already accepts), with output rules telling the agent to fill what it knows and omit the rest rather than emit empty arrays. `writes` is what powers the declared-writes audit, so generated roadmaps can now carry it.
- **Richer `--help` for the lifecycle verbs.** `task prepare`, `task complete`, `task finalize`, `task record-done`, `plan prompt`, and `phase import` now answer `--help` with a full synopsis (flags + examples) instead of the generic two-line stub. Unregistered subcommands keep the stub.

**Internal**

- Regression tests lock the v1.20 recommendation cost fixes through the `task prepare` round-trip: a small/low-risk docs task resolves to `cheap_mechanical`, and `verification_strength: weak` alone does not escalate to `highest_reasoning`. `recommendation` is documented to be `null` only in the early-return states (`done` / `blocked` / unmet `depends_on`).

## [1.20.0] — 2026-05-27

### Trust hardening — deterministic adapters, honest `--model`, cost-correct recommendations

Dogfooding `code-pact` in another project exposed a class of trust bugs where the control plane wobbled on its own generated output. This release closes them. One **breaking** CLI change: the long-deprecated bare `code-pact adapter` form is removed.

**Removed**

- **BREAKING:** the deprecated bare `code-pact adapter` form (including `adapter --agent <name>`, which implicitly ran `adapter install`) now returns `CONFIG_ERROR` (exit 2) with **no side effects**. Use `code-pact adapter install <agent>`. A form that warned *and* mutated the project was the exact "warning + side effect" hazard this release removes. `code-pact adapter --help` / `-h` / `help` prints usage and exits 0.

**Fixed**

- **Adapter convergence.** A verification command whose derived skill name collides with a built-in skill (`context` / `verify` / `progress`) no longer clobbers the built-in — the derived skill is deterministically uniquified (e.g. `verify-2`), with the final name propagated to its path, body, and manifest entry. `AdapterManifest` now rejects duplicate `files[].path`, and `adapter install` / `adapter upgrade --write` repair a legacy duplicate-path manifest instead of aborting on it. `install → upgrade --check → upgrade --write → doctor` converges clean.
- **`--model` actually pins.** `adapter install`/`adapter upgrade --model <v>` now persists `model_version` to the agent profile (it was previously fingerprint-only), so `doctor`'s `ADAPTER_STALE` remediation actually works. Validation runs before any filesystem mutation; an unknown `--model` is `CONFIG_ERROR`.
- **Recommendation cost.** `verification_strength: weak` no longer escalates a task to `highest_reasoning` on its own — it is reflected in the budget profile instead. `cheap_mechanical` is now additionally gated on `write_surface=low` + `context_size=small`, so a small docs/formatting edit stays cheap even with weak verification, while a sprawling docs change is not under-priced just because its type is `docs`.
- **init self-consistency.** An existing `.gitignore` is now merged (gaining `/.local/` and `/.context/`) instead of being skipped; `doctor`'s `CONSTITUTION_PLACEHOLDER` warning is suppressed until a real (non-tutorial) phase exists; and `plan constitution` overwrites only the pristine generated placeholder without `--force`, protecting a user-edited constitution even if it still contains the edit-hint line.

**Added**

- `--model` accepts vendor-id aliases that normalize to the canonical version (`claude-opus-4-7` → `opus-4.7`, `claude-sonnet-4-6` → `sonnet-4.6`).
- `--help` / `-h` / `help` on the `plan`, `task`, `phase`, and `adapter` command groups (and `<group> <subcommand> --help`) now prints usage and exits 0 instead of `CONFIG_ERROR`. Bare `plan` / `task` / `phase` also print usage; bare `adapter` is an error (see **Removed**).
- `init` now returns `suggested_next_steps` (edit the constitution / add a phase), surfaced in both the JSON envelope and the human output.

**Changed**

- `adapter upgrade --check --model <v>` now returns `CONFIG_ERROR`: `--check` is read-only and must not pin a model.

## [1.19.0] — 2026-05-27

### Beginner-friendly command aliases + a documentation overhaul

The shipped behaviour change is small and additive; the bulk of this release is a documentation pass plus the tooling to keep docs from drifting.

**Added**

- **Beginner-friendly CLI aliases** — additive sugar that dispatches to the exact same handlers as the canonical commands (same flags, exit codes, JSON envelope, error codes):
  - `task next <id>` → `task runbook <id>`
  - `phase next <id>` → `phase runbook <id>`
  - `task reconcile <id>` → `task finalize <id>` (verb-consistent with `phase reconcile`)
  - `plan import <yaml>` → `phase import <yaml>`

  Canonical names remain the primary documented and adapter-emitted commands; the aliases are secondary Stable (v1.x+) public aliases. When an alias is misused (missing argument or unknown flag) the error message names the alias and points at the canonical command. See [`docs/cli-contract.md` § Command aliases](docs/cli-contract.md#command-aliases) and [`design/decisions/cli-alias-ux-rfc.md`](design/decisions/cli-alias-ux-rfc.md).

**Changed (documentation)**

- Reworked the docs around a single canonical per-task loop ([`docs/per-task-loop.md`](docs/per-task-loop.md), with a Mermaid lifecycle diagram), a [glossary](docs/glossary.md), a [getting-started](docs/getting-started.md) decision tree, a dedicated [troubleshooting](docs/troubleshooting.md) page, and [`docs/upgrading.md`](docs/upgrading.md); `docs/migration.md` is now a compatibility archive. `docs/dogfood.md` is a maintainer quick guide with the deeper material in [`docs/maintainers/operations.md`](docs/maintainers/operations.md). The Japanese mirror was re-synced.
- The internal `design/decisions/` RFCs gained summaries and an [index](design/decisions/README.md), and a [documentation ownership map](docs/maintainers/docs-maintenance.md) records which doc owns which kind of change.

**Tooling**

- `pnpm check:docs` (run in CI) — a relative-link checker plus a semantic-invariant checker (`scripts/check-doc-links.mjs`, `scripts/check-doc-invariants.mjs`) that guard against broken and semantically stale docs, and assert the committed measurements snapshot matches the package version.

This release regenerates the Evidence Harness measurements snapshot (`design/measurements/`); `docs/positioning.md` now points at that snapshot instead of duplicating the figures. None of `design/` or `docs/` ships in the npm package (`files: dist, LICENSE`); the alias commands are the only user-facing change.

## [1.18.0] — 2026-05-26

### Roadmap adoption — bring your own plan

This release closes the gap between "an agent (or ChatGPT) already produced a roadmap" and "code-pact can execute it", without a second AI round-trip and without code-pact ever calling an LLM.

**Added**

- **`code-pact plan adopt <path>`** — deterministically convert an existing plan into phases and tasks. Dry-run by default (prints the phase-import YAML it would create); `--write` applies it by reusing the `phase import` validation + write pass under the advisory write lock. Detection order: a phase-import YAML (`phases:`), a single Phase-shaped YAML (accepts `verify_commands` or legacy `verification.commands`, normalised), or a structured markdown plan (`roadmap.md` / `TODO.md` / `tasks.md` — checkbox / plain / numbered bullets under `P1` / `Phase N` / `Milestone` / `Epic` / `Sprint` headings, or a single inferred phase for a flat list). A narrative plan whose tasks live in prose returns `no_plan_items_detected` — the signal to use the agent-first flow instead. No semantic filtering: review the dry-run before `--write`. Advisory `warnings[]` (`PHASE_VERIFY_COMMANDS_MISSHAPED`, `CHECKED_TASK_SKIPPED`, `PHASE_ID_INFERRED`, `READINESS_FIELDS_NOT_INFERRED`) never affect the exit code.
- **`code-pact plan prompt --schema-only`** — emit just the YAML format example plus output rules, without reading `design/brief.md` / `design/constitution.md`. For agents that already hold the project context and only need the output shape fixed. JSON gains an always-present `data.schema_only` flag.

**Fixed**

- **Planning-prompt / phase-import schema mismatch (silent data loss).** `plan prompt` advertised the full Phase shape `verification: { commands: [...] }`, but `phase import` reads the flat `verify_commands: [...]` key — and `PhaseImportEntry` is not strict, so zod silently dropped the nested block and the phase fell back to the default verify command. The prompt example now uses `verify_commands` (and lists all eight `type` values plus `expected_duration` / `status`), and `phase import` detects the mis-shape on the raw YAML before validation and surfaces it as a `PHASE_VERIFY_COMMANDS_MISSHAPED` advisory in the new, always-present `data.warnings[]` array. Advisory only — never changes the exit code.

**Changed**

- **Onboarding docs restructured** around how the roadmap is produced: five approaches (Smoke test / Agent-first / Existing-plan adoption / Code-pact-first / Manual), with agent-driven adoption promoted and the brownfield guide no longer steering to "the manual path is usually right". The Spec Kit bridge is repositioned as the narrower, tool-specific importer; general structured-plan adoption is `plan adopt`. Japanese mirror updated to match. Existing getting-started anchors are preserved.

All new fields (`data.schema_only` on `plan prompt`, `data.warnings[]` on `phase import`) are additive and field-presence-fixed; existing JSON consumers see no shape change.

## [1.17.1] — 2026-05-25

### Internal: CLI cluster extraction + docs (no behavior change)

**`src/cli.ts` shrinks from 2430 to 796 lines (−67%).** Continuing the
P27 refactor (which moved the `adapter` and `task` clusters into
`src/cli/commands/`), the three remaining multi-subcommand clusters are
extracted into their own modules:

- `src/cli/commands/plan.ts` — `plan brief|prompt|constitution|lint|normalize|analyze`
- `src/cli/commands/phase.ts` — `phase add|new|ls|show|import|reconcile|runbook`
- `src/cli/commands/spec.ts` — `spec import`

`cli.ts` is now a thin dispatcher plus the single-verb commands that
have no subcommand surface (`init`, `tutorial`, `doctor`, `validate`,
`recommend`, `verify`, `pack`, `progress`). This is pure code movement:
JSON envelopes, exit codes, error codes, and flag surfaces are
byte-identical to v1.17.0. There is no change to any published command,
flag, or output — patch-level, behavior-preserving.

Also in this release:

- **`CONTRIBUTING.md`** gains a "Source layout" table documenting the
  dispatcher → CLI-wrapper → implementation → core layering, so the two
  similarly named `commands` directories are no longer something a
  reader has to infer.
- **Evidence-harness metrics refreshed.** `design/measurements/` and the
  baseline tables in `docs/agent-contract.md` / `docs/positioning.md`
  are recomputed against the current dogfood corpus (SHA `28b4df1`,
  144 tasks / 108 done), replacing the stale v1.13.3 snapshot. Context
  pack p50 19275 B, p90 49555 B, max 314774 B; first-pass verify 100.0%;
  lifecycle adherence 80.6%; adapter drift 0.0%.

## [1.17.0] — 2026-05-25

### Deterministic stabilization of AI-assisted roadmap generation (P31)

**The planning prompt now elicits the signals the tool runs on.** The
`plan prompt` YAML example previously showed only `id` / `description` /
`type` for tasks, so AI-authored roadmaps omitted `ambiguity`, `risk`,
`context_size`, `write_surface`, `verification_strength`, and
`requires_decision` — `phase import` then defaulted them to `medium`, and
attribute-driven `recommend` (tier / effort / budget) and context-pack rule
selection barely fired on the exact path where they help most. The prompt
now asks for all six per task, plus guidance to mark genuine uncertainty
explicitly (`confidence: low` / `requires_decision: true`) instead of
guessing `medium`, and to shape phases foundations → capabilities →
stabilization (one task = one PR) — keeping the prompt and the greenfield
docs in agreement.

**`plan lint --include-quality` now surfaces uncertainty as advisories.**
Three new checks — `TASK_DECISION_UNRESOLVED` (a `requires_decision` task or
phase with no resolving ADR in `design/decisions/`), `PHASE_CONFIDENCE_LOW`,
and `TASK_DESCRIPTION_MISSING` — ship as advisories (`affects_exit: false`):
visible in `--include-quality` output and CI logs, but they never fail
`--strict`. Resolving a design decision is human judgment, so the tool
surfaces it rather than blocking. `TASK_DECISION_UNRESOLVED` reuses the same
decision-resolution predicate as `verify` (a shared helper in
`src/core/decisions/adr.ts`) so lint and verify can never diverge.

**`plan lint` output gains an `advisories` count.** `plan lint --json` now
emits `affects_exit` on advisory issues and a top-level `advisories` count;
`warnings` continues to count only exit-relevant warnings, and human output
renders advisory lines as `[advisory]` so it never shows "0 warnings" above
visible advisory lines.

## [1.16.0] — 2026-05-25

### Init wizard simplification + documentation discoverability

**Init wizard no longer prompts for a project brief.** The interactive
`init` wizard previously asked whether to collect a project brief
(what / who / differentiator) and wrote `design/brief.md`. That step only
fed `plan prompt` (the AI-roadmap-generation prompt), its value depended
entirely on the specificity of the input, and most users skipped it — so it
added a decision to first-run without helping anyone who answered no. The
prompt and its now-unused `collectBriefPrompt` i18n key are removed.
`code-pact plan brief` is unchanged and still writes `design/brief.md` on
demand.

**Clearer init / adapter prompt wording.** The init adapter prompt and the
`adapter` help line said "instruction ファイル" / "instruction files"; both
now say "rule file / ルールファイル" consistently, resolving an
English/Japanese mix in the Japanese locale. The brief prompt (now only on
the standalone `plan brief` command) was reworded so "収集" no longer reads
as auto-collection.

**Documentation hub + Japanese workflow guides.** `docs/README.md` and
`docs/ja/README.md` are new EN/JA documentation indexes (GitHub renders
`docs/README.md` when browsing `docs/`). The greenfield and brownfield
workflow guides — previously unreachable from the README — are now linked
from the hub and from a one-line pointer in the README, and are translated
into Japanese under `docs/ja/workflows/`. English pages gained EN→JA
language switchers.

## [1.15.0] — 2026-05-24

### Onboarding UX — `tutorial` command + init prompt removal

**`code-pact tutorial` (new command).** Runs the full per-task loop —
`init` → `task prepare` → `task start` → `task complete` →
`task finalize` — plus the cross-task dependency gate, end to end inside a
throwaway `mkdtemp` sandbox, narrating each step in plain language, then
deletes the sandbox. Nothing is written to your project. Because it drives
the same service-layer functions the CLI uses (not canned example output),
the narrated results cannot drift from real behaviour. Flags: `--json`
emits a structured step transcript; `--keep` retains the sandbox for
inspection. Strings are localized (en-US / ja-JP). Stability: **Stable
(v1.15+)**, with unit + subprocess integration coverage.

**Init wizard no longer prompts for the sample phase.** The interactive
`init` wizard previously asked *"Create a tutorial sample phase (TUTORIAL)
to walk through the per-task loop? It is safe to delete after the smoke
test."* — three undefined terms ("per-task loop", "tutorial phase", "smoke
test") in a yes/no, at the very first-run moment, before the user knows
any code-pact vocabulary. It also taxed every `init` (including repeat
users and CI) to benefit only first-time evaluators, and left a `TUTORIAL`
phase + roadmap entry the user had to remember to delete.

The prompt is removed. Sample-phase creation is now **opt-in only via the
existing `--sample-phase` flag** (unchanged, Stable). Discoverability moves
to two footer hints printed after `init`: one pointing at `code-pact
tutorial` (watch the loop, no cleanup), one at `init --sample-phase`
(scaffold a real starter phase into `design/`). The unused
`createSamplePrompt` i18n key was removed from both locales.

This is **not a breaking change**: `--sample-phase` behaves exactly as
before, and non-interactive / CI `init` was already opt-in. Only the
interactive prompt is gone.

### Docs

- `docs/getting-started.md` (en) Path 1 rebuilt around the two options;
  `docs/ja/getting-started.md` brought up from the stale pre-v1.4
  `P1 Welcome` flow it was still on.
- `docs/concepts/sample-phase.md`, `docs/cli-contract.md`,
  `docs/workflows/{greenfield,brownfield-feature}.md`, and `README.md`
  updated; the stale `P1 Welcome` / `DUPLICATE_PHASE_ID` collision note in
  the greenfield workflow was corrected (the sample id is the reserved
  `TUTORIAL`, v1.4+).

No change to `ADAPTER_CONTRACT_HARDENING_FROM_VERSION` (stays `1.14.0`).

## [1.14.0] — 2026-05-24

### P30 — Adapter contract hardening

**P30 follow-up (test-only).** Added the end-to-end integration coverage
the P30 DoD calls for but the initial PR left to unit tests + pass-case
integration: a *violating* instruction (`task finalize ... --agent`,
with the manifest sha re-synced so `file_checksum_match` does not mask
it) now pins the full join through `runAdapterConformance` — below the
hardening threshold it is an advisory failure (`compliant: true`, with
the `adapter upgrade` remediation in `details`), and at the threshold the
same violation is a required failure (`compliant: false`). No product
behaviour change; no package version bump.

**P30-T0.** Phase bootstrap. Continuation of P29: its root cause was that
the contract surface handed to agents was not mechanically checked. P29
closed the commands-dictionary gap with a parser roundtrip test; P30
closes the adjacent gap — `adapter conformance` checks only that
required CLI surfaces are *mentioned* (substring), not that the guidance
presents `task prepare` as primary or is free of the anti-patterns P29
removed. Lands `design/decisions/adapter-contract-hardening-rfc.md`
(status: accepted — hybrid version-gated severity) and a P30 roadmap
entry (weight 8). Also corrects P29's own non_goals phantom phase-id
labels (`P30 idea` / `P32 idea` → `unnumbered future capability`), the
same inconsistency P29-T5 cleaned up. No code or public CLI surface
change in T0.

**P30-T1.** Severity-aware conformance + `task prepare` primary +
anti-pattern rejection. `ConformanceCheck` gains an explicit `severity`
(`required` | `advisory`); `compliant` is now false only when a
*required* check fails (`isAdapterCompliant`). Two new checks:
`task_prepare_is_primary` (asserts `code-pact task prepare` appears and
precedes the first `recommend` / `task context` mention — the primary
per-task entrypoint, not the pre-P29 loop) and `no_contract_antipatterns`
(fails on `task finalize ... --agent`, the exact P29 bug class — the
conformance-layer analogue of P29's parser roundtrip test). The
human-output renderer marks a failing advisory check `WARN` vs a
required `FAIL`.

**P30-T2.** `activation_rules_documented` check. Verifies the P29-T3
activation rules are present via locale-independent anchors
(`task finalize --write`, `wait_for_dependencies`, `CONTEXT_OVER_BUDGET`).
The check id, `details`, and docs state it verifies **documentation
presence, not runtime obedience** — a static instruction-file check
cannot observe an agent's runtime behaviour, and claiming otherwise
would re-introduce the contract-overstatement P28/P29 corrected.

**P30-T3.** Hybrid version-gated severity + docs. The three hardening
checks are `required` for adapters whose manifest `generator_version` is
semver >= `ADAPTER_CONTRACT_HARDENING_FROM_VERSION` ("1.14.0",
release-coupled) and `advisory` below, so installs predating the
P29-aligned templates warn (with an `adapter upgrade` remediation)
rather than hard-fail. The package version is **not** bumped here
(release-prep concern), so in-tree / CI installs run the checks at
advisory; template *content* conformance is asserted directly,
independent of severity. `docs/agent-contract.md` and
`docs/cli-contract.md` document the new checks, the severity model, and
the version gating.

**P30-T4.** Measurement honesty. The metric labelled "Agent command
adherence rate" is renamed "Task lifecycle adherence rate" in
`docs/agent-contract.md` and `docs/positioning.md` to match what it
measures (state-machine `started`→`done` adherence) and the
`lifecycle_adherence_rate_percent` summary key; both note `task prepare`
is read-only and prepare-adherence is not measured (`task prepare
--record` stays a deferred future consideration, out of scope).

### P29 — Contract truth & baseline integrity

**P29-T0.** Phase bootstrap. An external static review of v1.13.3 found
that `task prepare` — the v1.11+ single per-task entry point — emits a
`commands.finalize` string the CLI parser rejects (`code-pact task
finalize <id> --agent <agent>` → `CONFIG_ERROR "Unknown option
'--agent'"`); `task finalize` is a design/progress reconciliation
command and takes no `--agent` (already documented in this changelog).
The bug survived because the unit test pinned the broken string as
expected and no test ran the emitted commands through the parser. P29 is
a **remediation phase** scoped strictly to contract truth: fix the
broken command and its copies, add the missing parser regression, and
align the docs/measurement baselines that the same review found drifted.
Lands `design/phases/P29-contract-truth.yaml` and a P29 roadmap entry
(weight 8). No code or public CLI surface change in T0.

**P29-T1.** Fix the broken finalize command. `task prepare`'s
`commands.finalize` changes from the parser-rejected `code-pact task
finalize <id> --agent <agent>` to `code-pact task finalize <id> --write
--json` (single field; no envelope-shape change). The two copies that
propagated the bug are corrected: the `task prepare` unit-test
expectation (`tests/unit/commands/task-prepare.test.ts`) and the
`docs/cli-contract.md` commands example. `commands.finalize` is now
executable verbatim.

**P29-T2.** Add the parser regression the pinned test masked.
`tests/integration/task-prepare-commands-contract.test.ts` runs every
command `task prepare --json` emits through the built CLI and fails on
any "Unknown option" rejection, then walks start → complete → finalize
using the emitted commands. Closes the structural gap that let T1's bug
through — a string-equality unit test could not catch an unsupported
flag.

**P29-T3.** Make `task prepare` the primary per-task entry point in the
docs and generated adapter guidance. The README 30-second tour, both
`docs/getting-started.md` guides, and the `claude` / `codex` / `generic`
adapter workflow sections now lead with `task prepare`; `recommend` and
`task context` are presented as standalone diagnostics that `task
prepare` already runs for you. Adds compact activation rules to the
agent contract (`task prepare` on a named task; do not implement on
`wait_for_dependencies`; report rather than widen on
`CONTEXT_OVER_BUDGET`; `task finalize --write` only after `task
complete`). No new required conformance surface — `adapter conformance`
already required `task prepare`; this aligns the top-of-file workflow
with the contract section below it.

**P29-T4.** Sync measurement baseline docs with the measured artifact.
`docs/positioning.md` and `docs/agent-contract.md` quoted a stale
v1.13.1 (`7743d4f`) baseline; both now match
`design/measurements/summary.json` (`5f61e3c`): `pack_size_p50_bytes`
22072→21052, `pack_size_p90_bytes` 49654→49885, `pack_size_max_bytes`
290791→306153, `lifecycle_adherence_rate_percent` 81.8→82.4, and
denominators `tasks_done` 88→90 / `tasks_total` 123→128. The
release-over-release delta table in `docs/migration.md` is intentionally
historical and is left unchanged. Follow-up (not in this phase): a CI
guard that asserts the baseline tables match `summary.json` — deferred
because parsing the two distinct markdown table shapes is non-trivial.

**P29-T5.** Clean phantom-`P25` references. Docs and the P28 RFC named
"P25 (Spec Kit Bridge v2)" as a roadmap item, but `design/roadmap.yaml`
enumerates no `P25` — a source-of-truth inconsistency for a tool whose
thesis is design/ as source of truth. Spec Kit Bridge v2 is now
described as an **unscheduled future capability, not a numbered roadmap
phase** in `design/decisions/spec-conformance-rfc.md` and the P28 RFC
changelog entry; no `planned` P25 phase stub is added (that would
overstate commitment to unscoped work). The P28 phase YAML keeps its
historical wording as an internal phase record.

### P28 — Spec-conformance remediation

**P28-T0.** Phase bootstrap + RFC acceptance. An external static
review of v1.13.3 found three accepted-RFC-vs-implementation
divergences (re-verified against source before this phase opened):
P24 `--budget-bytes` elides `related_decisions` / `rules` that the
context-budget RFC marks unelidable; the P26 harness counts
`pack_bytes` as characters not UTF-8 bytes; the P26 adapter-drift
denominator is derived from observed signals instead of
`.code-pact/project.yaml` enabled agents. P28 is a **remediation
phase** — it does not change the accepted P24/P26 contracts, it
restores implementation and tests to match them, and it pins the
load-bearing RFC clauses with tests whose names quote the clause.
Lands `design/decisions/spec-conformance-rfc.md` (status: accepted),
`design/phases/P28-spec-conformance-remediation.yaml`, and a P28
roadmap entry (weight 12). No code or public CLI surface change in
T0.

**P28-T1.** P24 conditional elision. `--budget-bytes` no longer elides
`related_decisions` / `rules` when they are the default task-id-matched
decisions / `applies_to`-matched rules — only the `context_size: large`
"all decisions" and `write_surface: high` "all rules" expansions are
elidable, exactly as `context-budget-rfc.md` specifies. `completed_tasks`
/ `constitution` / `reads` stay unconditionally elidable; `ELISION_ORDER`
(the priority) is unchanged — only the per-invocation eligible subset
narrows. When a non-elidable section keeps the pack over budget,
`CONTEXT_OVER_BUDGET` fires with that section in `unelidable_sections`.
The default (no-`--budget-bytes`) path is byte-identical. The previous
budget test, which hard-coded the unconditional elidable set and asserted
that elision *happens*, is corrected; four new tests pin each RFC
eligibility clause by name. `tests/unit/core/pack/budget.test.ts` 11
passed; full suite 1262 unit + 333 integration green.

**P28-T2.** P26 evidence-harness correctness. `pack_bytes` now uses
`Buffer.byteLength(packContent, "utf8")` instead of `String.length`
(UTF-16 code units). The enabled-agent set for `adapter-drift-by-agent.csv`
— the denominator of `adapter_drift_rate_percent` — is read from the
declared source of truth (`.code-pact/project.yaml` `agents[]`, `enabled
!= false`) instead of being inferred from doctor issues + progress events,
so a clean enabled agent with zero issues and zero events still gets a
row. `scripts/harness/index.ts` re-exports the P26 builders for surface
parity. Baseline under `design/measurements/` regenerated. Isolation
finding: on the same corpus, the byte-vs-char correction moves
`pack_size_max_bytes` by +1400 (304753 → 306153, +0.46%) and the p50 by
+0.33% — small because the design corpus is English (the residual comes
from multi-byte typographic punctuation like em-dashes). The larger
290791 → 306153 shift vs the prior baseline is corpus growth (v1.13.1 →
v1.13.3 + P28 tasks), not the byte fix. The denominator change is
currently inert (single enabled agent) and latent for multi-agent
projects; both fixes are correctness/evidence-fidelity hygiene, as P28's
RFC states. Added a non-ASCII `pack_bytes` unit test; full suite green.

**P28-T3.** Design-document consistency. Corrected declared `writes`
that referenced files which were never created: P21 (`docs/cli/*.md` →
`docs/cli-contract.md`, where the CLI reference was actually
consolidated; dropped a duplicate `tests/integration/task-context-explain.test.ts`
already covered by the listed unit test) and P24 (dropped
`src/core/error-codes.ts` — `CONTEXT_OVER_BUDGET` lives in
`src/core/pack/index.ts`, already listed — and a
`tests/integration/task-context-budget.test.ts` covered by the listed
`tests/unit/core/pack/**` glob). Fixed P27-T1's manual smoke command:
`task prepare` accepts `--budget-bytes` but not `--explain` (which is a
`task context` flag), so `--json --explain --budget-bytes` never ran as
written. Corrected `docs/cli-contract.md`: `adapter doctor` and `adapter
conformance` share the `conformance-spec.ts` module but check different
things — doctor's `ADAPTER_CONTRACT_DRIFT` consumes only the heading
constants (asserting the `## Agent contract` section and axis
sub-headings are present), while the required-CLI-surface and
failure-guidance checks are `adapter conformance`-only; the previous
wording overstated a shared required-surface contract. Spec Kit Bridge /
P27 roadmap honesty: P27's partial split (task/adapter clusters
extracted; init / plan / phase / doctor / validate / verify / pack /
progress / spec / recommend still in `src/cli.ts`) is already accurately
documented in the Source layout section, and Spec Kit Bridge v2 remains
unstarted — recorded in P28's RFC as an unscheduled future capability,
with no doc overclaim to correct. The P21 / P24 /
P27 phase YAML are protected paths edited as bootstrap-class writes (not
listed in this task's `writes:`); T3 finalizes without `--audit-strict`,
deviation recorded here per the P27-T0 precedent.

## [1.13.3] — 2026-05-24

**P22 cancellation + adapter doctor two-axis docs.**
Documentation patch. No code change. `dist/cli.js` is
byte-identical to v1.13.2. Closes the v1.11-era roadmap.

P22 (Adapter schema v2) was the last item on the roadmap
drafted at the start of the v1.11 development cycle.
Investigation found the originally-proposed scope
(`adapter_schema_version: 2` + `template_signature` +
lifecycle hooks) has no shippable value: the
drift-attribution use case `template_signature` was
supposed to enable is **already satisfied** by the v1
manifest plus the existing `adapter doctor` two-axis
classification, and lifecycle hooks
(`prepare_command` / `finish_command`) have no concrete
use case the project has been asked to serve. P22 is
formally cancelled, the decision is recorded as a design
asset (`design/decisions/P22-cancelled-adapter-schema-v2.md`,
status: accepted), and the P22 number is preserved as a
documented cancellation rather than reused for unrelated
work.

The existing two-axis classification is now explicitly
documented in `docs/cli-contract.md` under
`#### Adapter file drift classification (two-axis)` so
future contributors can trace the per-combination doctor
codes (`ADAPTER_DESIRED_STALE`, `ADAPTER_FILE_DRIFT`,
`ADAPTER_FILE_MISSING`) without re-reading
`src/core/adapters/file-state.ts`. The names are
imperfectly self-describing — `ADAPTER_FILE_DRIFT`
covers the "both axes diverged" case, not the generic
"any drift" case — but a rename would be a breaking
change to `KNOWN_CODES.public`, so the documentation
clarifies semantics instead.

Going forward, new phases should be driven by surfaced
user signals (issues, real use cases, observed drift in
usage) rather than by completing a pre-drawn plan.

### Changed

- **P22 cancelled — adapter schema v2 / template
  signature tracking investigated, not shippable.** The
  P22 RFC originally proposed bumping
  `adapter_schema_version` to 2 with a per-file
  `template_signature` field for drift attribution, plus
  lifecycle hooks (`prepare_command` /
  `finish_command`). Investigation found the
  drift-attribution premise is **already satisfied** by
  the v1 manifest plus the existing `adapter doctor`
  two-axis classification (local state × desired state),
  shipped since v0.9 (P7). Adding `template_signature`
  would duplicate existing capability. Lifecycle hooks
  have no concrete use case the project has been asked
  to serve. Decision recorded in
  `design/decisions/P22-cancelled-adapter-schema-v2.md`
  (status: accepted). `design/phases/P22-adapter-schema-v2.yaml`
  registers the phase with `status: cancelled` and the
  single investigation task (P22-T0) also `cancelled`,
  matching the v1.4 P15-T5 cancellation precedent. The
  P22 number is preserved as a documented cancellation
  rather than reused for unrelated work.

- **Adapter doctor two-axis classification documented.**
  `docs/cli-contract.md` gains a `#### Adapter file
  drift classification (two-axis)` subsection under
  `### adapter doctor` documenting the existing local
  state × desired state matrix, the per-combination
  doctor code (`ADAPTER_DESIRED_STALE`,
  `ADAPTER_FILE_DRIFT`, `ADAPTER_FILE_MISSING`), and the
  remediation step for each row. The names
  (`ADAPTER_FILE_DRIFT` covers the "both axes diverged"
  case, not the generic "any drift" case) are
  imperfectly self-describing; rename would be a
  breaking change to `KNOWN_CODES.public`, so the
  semantics are documented here instead. The
  documentation references the P22 cancellation decision
  so future contributors can trace why
  `template_signature` was not added.

## [1.13.2] — 2026-05-23

**Dogfood baseline refresh.** Maintenance patch. The
`design/measurements/` artefacts P26-T2 committed against
git SHA `4627858` (v1.11.0 era) are regenerated against
git SHA `7743d4f` (v1.13.1 release commit) to reflect 18
PR merges and 9 additional `done` events since the last
measurement. `docs/positioning.md` and
`docs/agent-contract.md` baseline tables update their
cited values to match.

**Baseline shifts (v1.11.0 → v1.13.1 corpus state):**

| metric | v1.11 baseline | v1.13.1 baseline | Δ |
|---|---|---|---|
| `pack_size_p50_bytes` | 20725 | 22072 | +1347 |
| `pack_size_p90_bytes` | 50131 | 49654 | −477 |
| `pack_size_max_bytes` | 259650 | 290791 | +31141 |
| `first_pass_verify_rate_percent` | 100.0 | 100.0 | unchanged |
| `lifecycle_adherence_rate_percent` | 81.3 | 81.8 | +0.5 |
| `adapter_drift_rate_percent` | 0.0 | 0.0 | unchanged |
| `tasks_done` | 79 | 88 | +9 |
| `tasks_total` | 116 | 123 | +7 |

The `pack_size_max_bytes` shift (+31141 bytes, +12%) is
the v1.13.1 release prep commit itself absorbing the
expanded `decision_refs` from later phases. The slight
adherence-rate climb (+0.5pp) reflects new tasks being
properly started before completion (the 18 PRs in this
window all used the v1.11+ lifecycle correctly).

**No code change. No CLI surface change.** Every public
command, flag, JSON envelope, exit code, and error code is
byte-identical to v1.13.1. `dist/cli.js` is byte-identical
to v1.13.1. The published tarball is identical in shape
(5 files); only the version metadata changes.

## [1.13.1] — 2026-05-23

**CLI maintainability refactor.** v1.13.1 ships P27 (CLI
maintainability hardening) as a **patch release** because
no user-visible surface changes: every public command,
flag, JSON envelope, exit code, and error code is
byte-identical to v1.13.0. The `src/` layout is
reorganised internally so future cross-command refactors
(e.g. factoring duplicated flag parsing) become
single-file changes, but the published tarball still
contains only `LICENSE` / `README.md` / `dist/cli.js` /
`dist/cli.js.map` / `package.json` — the new
`src/cli/commands/` directory is not shipped.

The internal change in `src/cli.ts` is significant
(4559 → 2388 lines, −48%), with the `task` and `adapter`
subcommand clusters moving to dedicated files under
`src/cli/commands/` and the P14 advisory-write-lock
wrapper promoted to a shared `src/cli/util.ts` module.
The existing 1262 unit + 333 integration tests passed
WITHOUT MODIFICATION across all three implementation
tasks — that was the safety guarantee the refactor
operated under, and it held throughout.

**Why a patch (not 1.14.0).** P27 ships no user-visible
artifact. The v1.10.0 / v1.12.0 minor-per-phase precedent
applied to phases that produced user-readable artifacts
(committable CSVs, baseline numbers populated in docs).
P27 produces nothing users observe. Patch is the more
semver-honest position, matching the v1.10.1 precedent
for behaviour-preserving releases.

Commit messages in this release reference `v1.14` in
their headers — that was a working version tag during
phase implementation, not a release contract. The
release positioning as v1.13.1 reflects the
post-implementation review of what P27 actually ships.

### Changed

- **P27-T3 — Source layout documented.**
  `docs/cli-contract.md` gains a new `## Source layout
  (CLI wrapper layer)` section immediately before the
  `## Maintainer-only tooling` section. The new section
  documents the on-disk layout of the CLI wrapper layer
  after P27-T1 + T2: `src/cli.ts` (main + remaining
  clusters), `src/cli/commands/task.ts`,
  `src/cli/commands/adapter.ts`, and `src/cli/util.ts`
  (the shared `withWriteLock` module). A "Where new
  commands go" subsection walks contributors through the
  three cases (extend an existing cluster, add to a
  cli.ts-hosted cluster, or extract a new cluster via an
  RFC amendment). The note explicitly clarifies that the
  source layout is NOT a stability contract — runtime
  behaviour is locked by the JSON envelope / exit code /
  error code contract, not by file paths. The
  pure-function command implementation layer at
  `src/commands/` is also referenced so contributors do
  not confuse the two layers.

  No code changes. Closes P27.

- **P27-T2 — Adapter cluster extracted from `src/cli.ts`.**
  Pure refactor. The `adapter` subcommand cluster
  (cmdAdapter + cmdAdapterList / cmdAdapterInstall /
  cmdAdapterDoctor / cmdAdapterConformance /
  cmdAdapterUpgrade / cmdAdapterBareForm, plus the
  cluster-private `runAdapterInstallAndEmit` helper that
  cmdAdapterInstall and cmdAdapterBareForm both call)
  moves out of `src/cli.ts` into a new
  `src/cli/commands/adapter.ts` (~484 lines).
  `src/cli.ts` keeps its top-level routing and imports
  `cmdAdapter` from the new file via a single line.

  **Pure-refactor contract preserved.** Every command's
  JSON envelope, exit code, error code, and flag surface
  is byte-identical to v1.13. The existing 1262 unit +
  333 integration tests pass WITHOUT MODIFICATION.

  `src/cli.ts` shrinks from 2850 lines (after P27-T1) to
  **2388 lines (−462 additional lines)**. Cumulative
  reduction from the v1.13 baseline (4559 lines):
  −2171 lines, **−48%**.

  `dist/cli.js` grows marginally from 452.85 KB to 452.96
  KB (+0.11 KB); runtime behaviour is unchanged.

  Manual smoke verified: `adapter conformance claude-code
  --json` → `compliant: true`, `adapter doctor --json` →
  `ok: true`, `adapter list --json` → 5 agents listed.

- **P27-T1 — Task cluster extracted from `src/cli.ts`.**
  Pure refactor. The `task` subcommand cluster (cmdTask +
  cmdTaskAdd / cmdTaskContext / cmdTaskPrepare /
  cmdTaskComplete / cmdTaskFinalize / cmdTaskRunbook /
  cmdTaskStart / cmdTaskBlock / cmdTaskResume /
  cmdTaskStatus, plus the cluster-private helpers
  `TASK_ADD_NON_INTERACTIVE_ONLY_FLAGS`, `emitConfigError`,
  `emitTaskCommonError`) moves out of `src/cli.ts` into a
  new `src/cli/commands/task.ts` (~1700 lines).
  `src/cli.ts` keeps its top-level routing and imports
  `cmdTask` from the new file via a single line.

  A small shared helper module
  `src/cli/util.ts` is also added in this task. It hosts
  `withWriteLock` — the P14 advisory-write-lock wrapper —
  which was defined in `src/cli.ts` and is now consumed by
  both `cli.ts` (for init / phase mutations) and
  `cli/commands/task.ts` (for `task add` / `task finalize`
  / etc.). Moving it to a shared file avoids the circular
  import that would otherwise arise from `cli.ts` ↔
  `task.ts`.

  **Pure-refactor contract preserved.** Every command's
  JSON envelope, exit code, error code, and flag surface
  is byte-identical to v1.13. The full existing test
  suite (1262 unit + 333 integration) passes WITHOUT
  MODIFICATION — verified at commit time.

  `src/cli.ts` shrinks from 4559 lines to 2850 lines
  (−1709 lines, −37%). The duplicated `--budget-bytes`
  parsing + `CONTEXT_OVER_BUDGET` error block from P24
  now lives in one file alongside its peers, making
  future cross-command flag refactors (e.g. extracting
  the duplicated parse into a `parseBudgetBytes` helper)
  a single-file change.

  `dist/cli.js` grows from 447.82 KB to 452.85 KB (+5.03
  KB) due to the new module boundary; runtime behaviour
  is unchanged.

### Added

- **P27-T0 — CLI maintainability hardening RFC + phase
  registration.**
  `design/decisions/cli-maintainability-rfc.md` opens at
  `Status: proposed` and locks the design decisions for
  v1.14: a pure refactor that splits the two most active
  subcommand clusters out of `src/cli.ts` (currently 4559
  lines, 36 cmd functions) into per-cluster files under a
  new `src/cli/commands/` directory. P27 ships two
  extractions: the task cluster (cmdTask +
  cmdTaskAdd/Context/Prepare/Complete/Finalize/Runbook/
  Start/Block/Resume/Status; ~1500 lines moved) and the
  adapter cluster (cmdAdapter + cmdAdapterList/Install/
  Doctor/Conformance/Upgrade/BareForm; ~500 lines moved).
  Every command's JSON envelope, exit code, error code,
  and flag surface stays byte-identical to v1.13; the
  existing 1262 unit + 333 integration tests are the
  safety net (the refactor passes iff every test passes
  without modification). The remaining clusters (init,
  plan, phase, doctor, validate, verify, pack, progress,
  spec, recommend) stay in `src/cli.ts` for v1.14 —
  extracting them is mechanical follow-on work and is
  deliberately deferred. `design/phases/P27-cli-
  maintainability.yaml` registers the phase tasks (P27-T0
  through P27-T3); `design/roadmap.yaml` gains a P27
  entry at weight 15. The status line on the RFC flips to
  `accepted` in a follow-up commit before merge.

## [1.13.0] — 2026-05-23

**Context budget enforcement.** v1.13.0 closes P24 and
adds the `--budget-bytes <N>` flag to `code-pact task
context` and `code-pact task prepare`. The flag enforces a
deterministic upper bound on the rendered context pack
size by progressively eliding sections in a fixed priority
order (`completed_tasks` → `related_decisions` (when
`context_size: large`) → `constitution` → `rules` (when
`write_surface: high`) → `reads`). When even maximal
elision cannot meet the budget, the command fails with a
new public error code `CONTEXT_OVER_BUDGET` (exit 2).

The new error envelope carries `data.budget_bytes`,
`data.minimum_achievable_bytes` (the post-maximal-elision
floor — re-running with this value as the budget produces
a pack of exactly that size), and `data.unelidable_sections`
(the structural floor: `header` / `phase_contract` /
`task_definition` / `depends_on` / `writes` /
`declared_decisions` / `acceptance_refs` /
`verification_commands` / `progress_event_schema` /
`format_overhead`).

**Activates the P21-reserved enum value.** In `task
context --explain --json` mode with `--budget-bytes`,
every elided section emits `reason_code:
budget_reserved_for_later` with a `details` block
carrying `elided_for_budget_bytes` and `section_bytes`.
The P21 unit test asserting the value is never emitted in
the no-budget case continues to pass.

**Byte-identical default preserved.** Without
`--budget-bytes`, the rendered pack `content` is
byte-for-byte identical to v1.12 (the existing
`tests/integration/pack-byte-identical.test.ts` lock test
continues to apply). The flag is opt-in per invocation.

**Progress-read-only invariant preserved on the new
failure path.** `task prepare --budget-bytes` does NOT
mutate `.code-pact/state/progress.yaml` on the
`CONTEXT_OVER_BUDGET` path.

`docs/cli-contract.md` documents the flag, the locked
elision priority, the `--explain --json` interaction, the
error envelope shape, and the byte-identical default
guarantee. `KNOWN_CODES.public` gains `CONTEXT_OVER_BUDGET`.

No `adapter_schema_version` bump. No manifest schema bump.
No `adapter upgrade` required for existing installs.

### Changed

- **P24-T2 — `--budget-bytes` documentation.**
  `docs/cli-contract.md` gains a new `### --budget-bytes
  <N> (v1.13+, P24)` subsection under `## task context`
  documenting the flag, the locked elision priority
  table, the `--explain --json` interaction (the
  `budget_reserved_for_later` emission shape with the
  `details` block carrying `elided_for_budget_bytes` and
  `section_bytes`), the `CONTEXT_OVER_BUDGET` error
  envelope shape, and the byte-identical default
  guarantee. The `## task prepare` flag table gains a
  `--budget-bytes` row cross-referencing the task-context
  section. The error-code reference table gains a row for
  `CONTEXT_OVER_BUDGET (v1.13+ / P24)` documenting the
  envelope fields. The `budget_reserved_for_later`
  description in the explain reason-code table flips from
  "Reserved for P24" to "Emitted by `--budget-bytes`".

  No code changes. Closes P24.

### Added

- **P24-T1 — Context budget enforcement implementation.**
  New `--budget-bytes <N>` flag on `code-pact task context`
  and `code-pact task prepare` enforces a deterministic
  upper bound on the rendered context pack size by eliding
  sections in the locked priority order
  (`completed_tasks` → `related_decisions` (when
  `context_size: large`) → `constitution` → `rules` (when
  `write_surface: high`) → `reads`). When maximal elision
  cannot meet the budget, the command fails with the new
  public error code `CONTEXT_OVER_BUDGET` (exit 2). The
  error envelope carries `data.budget_bytes`,
  `data.minimum_achievable_bytes`, and
  `data.unelidable_sections` so callers can adjust the
  budget or split the task. The new error code joins
  `KNOWN_CODES.public` in the error-code-surface
  invariant test.

  **Activates the P21-reserved enum value.** In `task
  context --explain --json` mode with `--budget-bytes`,
  every elided section emits
  `reason_code: budget_reserved_for_later` (the value P21
  reserved for this work) with `details` carrying
  `elided_for_budget_bytes` and `section_bytes`. The P21
  unit test asserting the value is never emitted in the
  no-budget case continues to pass.

  **Byte-identical default preserved.** Without
  `--budget-bytes`, the rendered pack `content` is byte-
  for-byte identical to v1.12 — verified by the existing
  `tests/integration/pack-byte-identical.test.ts` lock
  test.

  **Progress-read-only invariant preserved on the new
  failure path.** `task prepare --budget-bytes` does NOT
  mutate `.code-pact/state/progress.yaml` on the
  CONTEXT_OVER_BUDGET path; verified by a dedicated unit
  test.

  Implementation:
  - `src/core/pack/formatters/markdown.ts` exports
    `ELISION_ORDER` as a readonly tuple next to
    `renderSections`.
  - `src/core/pack/index.ts` adds `applyBudgetElision()`
    plus a new `ContextOverBudgetError` class carrying the
    structured error fields.
  - `buildContextPack()` accepts an optional
    `budgetBytes`; when set, applies elision after
    rendering and tracks elided section names + bytes for
    the explain output.
  - `src/commands/task-context.ts` and
    `src/commands/task-prepare.ts` plumb the new option
    through.
  - `src/cli.ts` `cmdTaskContext` and `cmdTaskPrepare`
    accept `--budget-bytes <N>` (positive integer; zero
    / negative / NaN → `CONFIG_ERROR`) and surface the
    new `CONTEXT_OVER_BUDGET` envelope with
    `error.data.{budget_bytes, minimum_achievable_bytes,
    unelidable_sections}`.

  Tests:
  - `tests/unit/core/pack/budget.test.ts` (new, 7 tests)
    covers the no-budget passthrough, generous budget
    (unchanged output), the byte-identical
    explain-with-budget invariant, the
    `ContextOverBudgetError` shape, the
    `minimum_achievable_bytes` round-trip (passing it
    back as the budget produces a pack of exactly that
    size), the `budget_reserved_for_later` emission, and
    the no-budget absence of the value.
  - `tests/unit/commands/task-prepare.test.ts` gains 3
    tests covering the budget passthrough, the
    `CONTEXT_OVER_BUDGET` throw, and the
    progress-read-only invariant on the new failure
    path.
  - `tests/unit/error-code-surface.test.ts` gains
    `CONTEXT_OVER_BUDGET` to the `KNOWN_CODES.public` set.

- **P24-T0 — Context budget enforcement RFC + phase
  registration.**
  `design/decisions/context-budget-rfc.md` opens at
  `Status: proposed` and locks the design decisions for
  v1.13: add a `--budget-bytes <N>` flag to `code-pact
  task context` and `code-pact task prepare` that enforces
  a deterministic upper bound on the rendered pack size by
  eliding sections in a fixed priority order
  (completed_tasks → related_decisions(when
  context_size:large) → constitution → rules(when
  write_surface:high) → reads). Sections not in that list
  are unelidable (header, phase_contract, task_definition,
  depends_on, writes, declared_decisions, acceptance_refs,
  verification_commands, progress_event_schema,
  format_overhead). When maximal elision cannot meet the
  budget, the command fails with a new
  `CONTEXT_OVER_BUDGET` public error code (exit 2) whose
  envelope carries `minimum_achievable_bytes` and
  `unelidable_sections`. The flag is opt-in per invocation;
  the no-flag default path stays byte-identical to v1.12
  (the existing `pack-byte-identical.test.ts` lock test
  continues to apply). In `task context --explain --json`
  mode, elided sections emit the
  `budget_reserved_for_later` reason code that P21-T4
  reserved for this work — finally activating the
  forward-compatibility value the P21 unit test asserts as
  absent. Motivated by the P26 dogfood baseline
  `pack_size_max_bytes: 259650`, a real outlier task where
  budget enforcement gives cheaper-tier-model consumers a
  deterministic lever. `design/phases/P24-context-budget.yaml`
  registers the phase tasks (P24-T0 through P24-T2);
  `design/roadmap.yaml` gains a P24 entry at weight 18.
  The status line on the RFC flips to `accepted` in a
  follow-up commit before merge.

## [1.12.0] — 2026-05-23

**Evidence Harness v2.** v1.12.0 closes P26 (Evidence
Harness v2) and populates the success-metric baselines
v1.11.0 promised in `docs/positioning.md` and
`docs/agent-contract.md`.

The internal-only measurement harness at
`scripts/harness/` gains two new per-task / per-agent CSVs
(`lifecycle-adherence-by-task.csv`,
`adapter-drift-by-agent.csv`) and one aggregate JSON
sidecar (`summary.json`, `summary_schema_version: 1`) that
computes the five v1.11 success metrics in a single
committable artefact. `measurements.manifest.json` bumps
`harness_version: 0.1.0 → 0.2.0`; v1 CSV column shapes are
unchanged (additive only).

The committed dogfood baseline (against git SHA `4627858`,
denominators `tasks_done: 79`, `tasks_total: 116`,
`agents_enabled: 1`):

| metric | value |
|---|---|
| `pack_size_p50_bytes` | 20725 |
| `pack_size_p90_bytes` | 50131 |
| `pack_size_max_bytes` | 259650 |
| `first_pass_verify_rate_percent` | 100.0 |
| `lifecycle_adherence_rate_percent` | 81.3 |
| `adapter_drift_rate_percent` | 0.0 |
| `undeclared_write_rate_status` | deferred |

`docs/positioning.md` and `docs/agent-contract.md` now
cite these values from
`design/measurements/summary.json` with reproduce hints
(`pnpm harness --corpus . --check`). Operational
definitions tightened in `positioning.md`: adherence
counts only "started before done AND not legacy
shortcut"; drift gate counts only error-severity issues.

**Undeclared write rate is deferred, not omitted.**
`summary.json` carries `undeclared_write_rate_status:
"deferred"` with a note pointing at
`evidence-harness-v2-rfc.md` Non-goals. The metric is
defined in `positioning.md` but is intentionally not
computed because the project does not enforce a formal
commit→task link; a historical retrofit would either
over-claim or require new lifecycle instrumentation. A
future phase may add an event-on-finalize that records
the audit result so the metric becomes observable
historically.

**No user-visible CLI surface change.** `dist/cli.js` is
unchanged from v1.11.0. The harness remains internal-only
(not registered in `package.json` `bin`, never surfaces
in `code-pact --help`, never emits JSON envelopes). v1
CSV files regenerate with the same column shape — row
content reflects the current corpus state. No new error
codes, no `adapter_schema_version` bump, no manifest
schema bump.

### Changed

- **P26-T3 — Baseline numbers populated in v1.11 docs.**
  `docs/positioning.md` "Success metrics" and
  `docs/agent-contract.md` "Measurement" sections flip
  from "populated by P26" placeholders to the committed
  baseline values (`pack_size_p50/p90/max_bytes` =
  20725 / 50131 / 259650, `first_pass_verify_rate` =
  100.0%, `lifecycle_adherence_rate` = 81.3%,
  `adapter_drift_rate` = 0.0%, `undeclared_write_rate` =
  deferred). Both tables now cite
  `design/measurements/summary.json` against git SHA
  `4627858` as the source, with denominators
  (tasks_done=79, tasks_total=116, agents_enabled=1) and
  a `pnpm harness --corpus . --check` reproduce hint.
  Operational definitions tightened in `positioning.md`:
  the agent command adherence rate explicitly counts a
  task as adherent when it has at least one `started`
  event before its first `done` event AND does not exhibit
  the legacy v0.6 `planned → done` shortcut, with a note
  that `task prepare` is read-only and emits no event so
  the metric measures state-machine adherence only.

  `docs/concepts/evidence-harness.md` updated for v1.12 /
  P26 — the "What it measures" table grows from four to
  six CSV files, gains a `summary.json` shape callout, and
  documents the percentile rule (lower-percentile, no
  float average), the rate-rounding rule (one decimal,
  safe `0/0` divide), the adherence numerator/denominator
  semantics, the adapter drift gate (error-severity only),
  and the undeclared-write-rate deferral with a link to
  the RFC Non-goals section. The "Running it" snippet
  updates "four CSVs" → "six CSVs + summary.json".

  No code changes. Closes P21's "populated by P26"
  placeholders and P26 itself.

### Added

- **P26-T2 — Evidence Harness v2 dogfood baseline.** Run
  `pnpm harness --corpus . --write` against the dogfood
  corpus at git SHA `4627858` and commit the resulting
  baseline artefacts under `design/measurements/`:
  `lifecycle-adherence-by-task.csv` (97 rows, one per task
  with at least one event), `adapter-drift-by-agent.csv`
  (1 row, claude-code, `doctor_ok: true` despite one
  `ADAPTER_GENERATOR_STALE` warning), and `summary.json`
  (`summary_schema_version: 1`). v1 CSV files regenerate
  with column shape unchanged; row content reflects the
  current corpus state (v1.11.0 release + P26 cycle
  additions). `measurements.manifest.json` bumps
  `harness_version: 0.1.0 → 0.2.0`, refreshes
  `input_git_sha` / `code_pact_cli_version` /
  `generated_at`, and appends the two new entries to
  `csv_files`.

  **Baseline values for the v1.11 success-metric set:**

  | metric | value |
  | --- | --- |
  | `pack_size_p50_bytes` | 20725 |
  | `pack_size_p90_bytes` | 50131 |
  | `pack_size_max_bytes` | 259650 |
  | `first_pass_verify_rate_percent` | 100.0 |
  | `lifecycle_adherence_rate_percent` | 81.3 |
  | `adapter_drift_rate_percent` | 0.0 |
  | `tasks_done` | 79 |
  | `tasks_total` | 116 |
  | `agents_enabled` | 1 |
  | `undeclared_write_rate_status` | deferred |

  The ~19% non-adherence reflects historical tasks that
  used the v0.6 `planned → done` shortcut without an
  explicit `task start` event. The deferred undeclared-
  write-rate field documents its non-computation per
  evidence-harness-v2-rfc.md.

  No production code changes — corpus measurement only.
  P26-T3 will flip the v1.11 docs from "populated by P26"
  placeholders to these committed values.

- **P26-T1 — Evidence Harness v2 implementation.** The
  internal-only measurement harness at `scripts/harness/`
  now emits three additional artefacts alongside the v1
  CSVs:

  - `lifecycle-adherence-by-task.csv` — per-task booleans
    (`started_before_done`, `had_retry`, `had_block`,
    `legacy_planned_to_done_shortcut`) derived from the
    progress event log; one row per task with at least one
    event.
  - `adapter-drift-by-agent.csv` — one row per agent with
    at least one issue or one progress event referencing
    the agent. Aggregates `runAdapterDoctor` issues into a
    `doctor_ok` boolean plus per-`ADAPTER_*`-code counts
    (manifest_missing / manifest_invalid / generator_stale
    / schema_drift / profile_drift / file_missing /
    file_drift / desired_stale / contract_drift /
    unmanaged_file).
  - `summary.json` — aggregate sidecar with
    `summary_schema_version: 1` and the five v1.11 success
    metrics: `pack_size_p50/p90/max_bytes`,
    `first_pass_verify_rate_percent`,
    `lifecycle_adherence_rate_percent`,
    `adapter_drift_rate_percent`, plus the
    `undeclared_write_rate_status: "deferred"` field with a
    note documenting the historical-attribution problem.

  Percentile calculation uses the lower-median rule (no
  floating-point average) so integer byte values stay
  exact. Rates round to one decimal place. `0/0` rates
  emit `0.0` (no NaN).

  `measurements.manifest.json` `harness_version` bumps
  `0.1.0` → `0.2.0`; v1 CSV columns and row counts are
  unchanged (additive only). The byte-determinism contract
  holds across the expanded output set — two consecutive
  `--write` runs against the same git SHA produce
  byte-identical CSVs, summary.json, and manifest.

  Harness invocation surface is unchanged: `pnpm harness
  --corpus <path> [--check | --write] [--json]`. The
  harness remains internal-only (not registered in
  `package.json` bin), per P20.

  Unit coverage in
  `tests/unit/scripts/harness/metrics.test.ts` (+20 tests,
  total 38) covers the new lifecycle / adapter / summary /
  percentile / rate helpers including the `0/0` safe-
  divide case and the `legacy_planned_to_done_shortcut`
  denominator-vs-numerator semantics. Integration coverage
  in `tests/integration/harness.test.ts` exercises the
  expanded file set, the summary.json shape, and the
  byte-determinism contract.

- **P26-T0 — Evidence Harness v2 RFC + phase registration.**
  `design/decisions/evidence-harness-v2-rfc.md` opens at
  `Status: proposed` and locks the design decisions for the
  v1.12 cycle: extend the internal-only measurement harness
  (P20) with two new CSV outputs
  (`lifecycle-adherence-by-task.csv`,
  `adapter-drift-by-agent.csv`) and one aggregate JSON
  sidecar (`summary.json`) that computes p50 / p90 / max
  for pack size, percentages for first-pass verification
  rate and state-machine adherence rate, and a count-by-
  code histogram for adapter drift. After the harness
  lands, the v1.11 `docs/positioning.md` /
  `docs/agent-contract.md` baseline placeholders flip from
  "populated by P26" to the actual numbers from the
  dogfood corpus. The RFC honestly defers
  `undeclared_write_rate` (the project does not enforce
  commit→task linkage; a historical retrofit would over-
  claim) and documents the deferral as a `status:
  "deferred"` field in `summary.json`. The harness remains
  internal-only, never a `bin` entry; v1 CSV outputs are
  byte-identical (additive only). `harness_version` bumps
  0.1.0 → 0.2.0. `design/phases/P26-evidence-harness-v2.yaml`
  registers the phase tasks (P26-T0 through P26-T3);
  `design/roadmap.yaml` gains a P26 entry at weight 18.
  The status line on the RFC flips to `accepted` in a
  follow-up commit before merge.

## [1.11.0] — 2026-05-22

**Agent Contract v2.** v1.11.0 closes P21 (Agent Contract v2)
and adds three coordinated CLI surfaces that reduce agent
operation errors and make context minimisation auditable:

- `code-pact task prepare <task-id>` — single
  progress-read-only per-task entry point. Returns current
  state, recommendation, context pack metadata, structured
  `next_action`, and a `commands` dictionary for every
  per-task verb.
- `code-pact task context <task-id> --explain` — adds a
  per-section `bytes` + `reason_code` breakdown to the JSON
  envelope. The acceptance invariant `sum(sections[].bytes)
  === total_bytes === context_pack_bytes` holds; the pack
  markdown `content` is byte-identical to v1.10.
- `code-pact adapter conformance <agent>` — focused
  read-only check that the installed adapter satisfies the
  v1.11+ agent contract (`## Agent contract` heading + three
  axis sub-headings + lifecycle / diagnostic CLI surface
  mentions + failure guidance keywords + per-file checksum).

A new shared spec module
`src/core/adapters/conformance-spec.ts` is the single source
of truth consumed by both `adapter doctor`'s v1.7 contract
drift check and the new `adapter conformance` command. The
stable adapter instruction templates (`claude-code`,
`codex`, `generic`) are refreshed so a fresh `adapter
install` passes conformance by construction. Existing
installs will surface `ADAPTER_FILE_DRIFT` until `adapter
upgrade <agent> --write` is run — see `docs/migration.md`
v1.10.x → v1.11.0.

Two new self-contained docs ship: `docs/positioning.md`
(what code-pact is, what it deliberately is not, the core
CLI surfaces, the success metric set) and
`docs/agent-contract.md` (the v1.11+ contract definition,
the conformance check id catalogue, the recommended
lifecycle, the measurement set). README's "Reference docs"
table now lists both at the top.

No new error codes. No `adapter_schema_version` bump (still
1). No CLI module split (deferred). No budget enforcement
(deferred to P24); the `budget_reserved_for_later` value in
`ContextExcludedReasonCode` is reserved for that work and
MUST NOT be emitted in v1.11 (asserted by a unit test).

### Added

- **P21-T6 — Agent contract docs.** New
  `docs/agent-contract.md` formally defines the v1.11+ agent
  contract: what `code-pact` guarantees to agents (CLI
  surface stability, JSON envelope shape, exit code
  contract, error code stability, determinism, append-only
  progress), what agents must do to satisfy `adapter
  conformance` (required structural sections, lifecycle and
  diagnostic CLI surface mentions, failure guidance
  keywords, per-file integrity), the recommended per-task
  lifecycle (visualised as `task prepare ─► task start ─►
  implement ─► verify ─► task complete ─► task finalize`
  with branches for `started` / `blocked` / `done`), and
  the measurement set the Evidence Harness v2 work (P26)
  will populate. The document closes the P21 cycle and is
  referenced by `README.md`'s "Reference docs" table next
  to `docs/positioning.md`. No code changes.

- **P21-T5 — `code-pact adapter conformance <agent>` command.**
  New CLI verb `code-pact adapter conformance <agent>
  [--json]` is a focused read-only check that the installed
  adapter satisfies the v1.11+ agent contract. Exit code 0 on
  compliance, 1 on non-compliance, 2 on CONFIG_ERROR /
  AGENT_NOT_FOUND. Checks: `manifest_present`,
  `instruction_file_present`, `contract_section_present`,
  three axis sub-heading checks (`### When to invoke
  code-pact` / `### What to verify first` / `### How to
  handle failures`), `required_cli_surface_mentions` (every
  lifecycle and diagnostic surface mentioned),
  `required_failure_guidance` (every failure keyword
  mentioned), and `file_checksum_match` per manifest file.

  **Shared spec, single source of truth.** A new module
  `src/core/adapters/conformance-spec.ts` exports
  `AGENT_CONTRACT_SECTION_HEADING`,
  `AGENT_CONTRACT_AXIS_HEADINGS`,
  `LIFECYCLE_REQUIRED_SURFACES`,
  `DIAGNOSTIC_REQUIRED_SURFACES`, and
  `REQUIRED_FAILURE_GUIDANCE`. Both `adapter doctor`'s v1.7
  contract-drift check and this new `adapter conformance`
  command import from this module so the two callers can
  never disagree.

  **Adapter templates refreshed.** The `claude-code`,
  `codex`, and `generic` adapter instruction templates (in
  `src/i18n/en-US.ts` and `src/i18n/ja-JP.ts`) now mention
  every required CLI surface and every failure-guidance
  keyword by default, so a fresh `adapter install` passes
  conformance by construction. Pre-existing installs WILL
  surface `ADAPTER_FILE_DRIFT` in `adapter doctor` until
  `adapter upgrade <agent> --write` is run; this matches the
  v1.7 P16 precedent.

  Reuses existing error codes only (`AGENT_NOT_FOUND`,
  `CONFIG_ERROR`); no new public codes shipped. Unit
  coverage in `tests/unit/commands/adapter-conformance.test.ts`
  (10 tests) plus integration coverage in
  `tests/integration/adapter-conformance.test.ts` (6 new
  cases per stable agent × 3 agents = 18 new tests) covers
  the compliant path, every failure path (missing manifest,
  missing instruction file, tampered contract heading,
  tampered axis heading, missing lifecycle surface, missing
  diagnostic surface, missing failure-guidance keyword,
  checksum drift), and the doctor / conformance single-
  source-of-truth invariant.

- **P21-T4 — `task context --explain` per-section breakdown.**
  New flag `code-pact task context <task-id> --explain
  [--json]` returns the per-section byte breakdown of the
  rendered context pack and the list of sections that were
  intentionally excluded. In `--json` mode the envelope gains
  `total_bytes`, `context_pack_bytes`, `sections[]`, and
  `excluded[]` fields; the existing `content` / `char_count`
  / `agent` / `phase_id` / `task_id` fields are unchanged. In
  human mode (`--explain` without `--json`) a table of
  included and excluded sections is printed instead of the
  pack body.

  **Byte-identical contract preserved.** The rendered pack
  `content` is byte-for-byte identical to v1.10 with or
  without the flag — section metadata is computed alongside
  the content and never injected into the rendered string.
  The existing
  `tests/integration/pack-byte-identical.test.ts` is asserted
  unchanged.

  **Acceptance invariant.** `sum(sections[].bytes) ===
  total_bytes === context_pack_bytes`. A synthetic
  `format_overhead` section captures the inter-section
  newlines emitted by the final `join` so no bytes go
  unattributed.

  **Closed reason-code enums.** `sections[].reason_code` is
  one of `always_included` / `declared_by_task` /
  `referenced_decision` / `glob_match` /
  `write_surface_high` / `context_size_large` /
  `ambiguity_high` / `format_overhead`. `excluded[]
  .reason_code` is one of
  `context_size_small_and_ambiguity_low` /
  `not_declared_by_task` / `glob_no_match` /
  `budget_reserved_for_later`. The
  `budget_reserved_for_later` value is reserved for P24
  (budget enforcement) and **MUST NOT** be emitted in v1.11
  — a unit test asserts the absence in every P21 output.

  **Implementation seam.** The renderer in
  `src/core/pack/formatters/markdown.ts` is split into
  `renderSections()` (structured intermediate form) and
  `renderMarkdown()` (joins and returns the string, the
  pre-existing public entry point). `buildContextPack()`
  consumes `renderSections()` directly and attaches the
  reason codes from the task readiness flags
  (`context_size`, `ambiguity`, `write_surface`) plus the
  declared-section presence checks. No new error codes.

  Unit coverage in `tests/unit/core/pack/explain.test.ts`
  (11 tests) exercises the explain opt-in (off by default),
  the byte invariant, the synthetic `format_overhead`
  section, the closed enum membership of every emitted
  reason code, the absence of `budget_reserved_for_later`,
  the always-included section set, and the
  `not_declared_by_task` exclusion entries for tasks that
  declare no P10 fields.

- **P21-T3 — `code-pact task prepare` compound entry point.**
  New CLI verb `code-pact task prepare <task-id> [--agent
  <name>] [--json] [--dry-run]` returns everything an agent
  needs to decide what to do next on a single task: current
  state, the full v2 recommendation envelope, context-pack
  metadata (path + bytes, or `would_write_context_pack_path`
  in dry-run mode), a structured `next_action` (closed enum:
  `start_task` / `continue_implementation` /
  `wait_for_dependencies` / `noop_already_done` /
  `investigate_failure`), and a fully-formed `commands`
  dictionary (`context` / `start` / `verify` / `complete` /
  `finalize`) so the agent can invoke the next verb directly.

  **Progress-read-only contract.** `task prepare` MUST NOT
  mutate `.code-pact/state/progress.yaml` on any code path,
  including failure paths. It MAY write the deterministic
  context pack at the agent profile's `context_dir/<task-id>.md`
  unless `--dry-run` is passed.

  **Early-return states.** `done`, `blocked`, and any
  unmet-`depends_on` state skip the context pack build
  entirely; their envelope returns `recommendation: null`,
  `context_pack_path: null`, `context_pack_bytes: 0`, and
  populates `blocked_by` (for unmet deps) or `already_done:
  true` (for done). The `commands` dictionary is still
  populated so the agent can choose to invoke a verb directly
  after resolving the blocker.

  Reuses existing error codes only (`TASK_NOT_FOUND`,
  `AMBIGUOUS_TASK_ID`, `AGENT_NOT_FOUND`,
  `AGENT_NOT_ENABLED`, `CONFIG_ERROR`). The full envelope
  shape is locked in `docs/cli-contract.md` under
  `## task prepare`. Unit coverage in
  `tests/unit/commands/task-prepare.test.ts` (15 tests)
  exercises every `next_action.type`, the
  progress-read-only invariant (diff progress.yaml
  before/after), dry-run pack-skip behaviour, both blocked
  paths (state-machine blocked vs unmet-dep blocked), agent
  validation, task resolution errors, and the commands-dict
  shape.

- **P21-T2 — Pure recommendation resolver.** New
  `src/core/recommend/index.ts` exports
  `resolveRecommendation(opts)` as a pure function that
  computes the v2 recommendation envelope given an
  already-loaded task and agent profile, with no I/O of its
  own. The function is the same orchestration the existing
  `code-pact recommend` CLI command used to do inline — the
  six pure modules under `src/core/recommend/` (`tier`,
  `context-profile`, `planning`, `escalation`, `preflight`,
  `budget`) are unchanged. `buildStructuredReasons()` moved
  from the CLI command file to this module. The
  `code-pact recommend` JSON envelope is byte-identical to
  v1.10 (verified by diff against the pre-refactor output);
  the CLI command file shrinks to a thin wrapper around the
  loaders and the pure resolver. New unit tests in
  `tests/unit/core/recommend/resolve.test.ts` cover tier
  routing, model-map fallback, structuredReasons emission,
  planning derivation, ambiguity-action mapping, and the v2
  envelope shape invariant. The motivation is the
  forthcoming `code-pact task prepare` command (P21-T3),
  which needs to call the recommendation logic with
  already-loaded task data without paying the CLI's loader
  cost twice.

- **P21-T1 — Positioning docs.** New `docs/positioning.md`
  defines what `code-pact` is, what it deliberately is not
  (LLM API calls, orchestration framework, RAG / vector
  database, web UI, external tracker integration, multi-agent
  orchestration — each ruled out on purpose), the core CLI
  surfaces, and the success metrics the project measures
  itself against (context pack p50 / p90 / max bytes,
  first-pass verification rate, agent command adherence rate,
  undeclared write rate, adapter drift detection rate).
  Baseline numbers for the metrics are populated by Evidence
  Harness v2 (P26); this document fixes the metric set up
  front so the harness work targets the right shape. The
  README "Reference docs" table now lists `positioning.md`
  ahead of the existing getting-started / cli-contract /
  migration / dogfood / community rows.

- **P21-T0 — Agent Contract v2 RFC + phase registration.**
  `design/decisions/agent-contract-v2-rfc.md` opens at
  `Status: proposed` and locks the design decisions for the
  v1.11 cycle: a new compound `task prepare` command (single
  deterministic per-task entry point, progress-read-only,
  structured `next_action` + `commands` envelope), a new
  `task context --explain` mode (per-section `bytes` +
  `reason_code` breakdown with byte-identical pack content),
  a new `adapter conformance <agent>` command (focused
  read-only check that consumes the same required-surface
  spec as `adapter doctor`), and a refresh of stable adapter
  instruction templates so a fresh install passes conformance
  by construction. No new error codes, no
  `adapter_schema_version` bump, no budget enforcement (P24).
  `design/phases/P21-agent-contract-v2.yaml` registers the
  phase tasks (P21-T0 through P21-T6); `design/roadmap.yaml`
  gains a P21 entry at weight 25. The status line on the RFC
  flips to `accepted` in a follow-up commit before merge per
  the P11–P20 lifecycle precedent.

### Changed

- **README "Relationship to spec-driven workflows" section
  removed.** The section's positioning content is replaced by
  the broader self-contained narrative in
  `docs/positioning.md`. The README lead (`A vendor-neutral
  control plane for AI coding agents.`) is unchanged.

- **P21-T0 RFC flipped to `accepted`.** The Agent Contract v2
  RFC opened at `Status: proposed` in PR #161 and is now
  locked at `accepted`, closing the P21-T0 lifecycle and
  unblocking P21-T1..T6 implementation work.

## [1.10.1] — 2026-05-22

**Documentation patch.** No code change to the user-facing
product surface. v1.10.1 fixes three documentation /
design-metadata inconsistencies caught by an external review
of the v1.10.0 source bundle. The patch matters for
correctness in code-pact's "control plane" role: agents read
phase YAML, CHANGELOG, migration docs, and adapter
instruction files as source of truth, so a misleading
sentence has the same blast radius as a misleading API.

### Fixed

- **`phase reconcile --audit-strict` references removed.**
  The v1.10.0 CHANGELOG, `docs/migration.md` v1.10 section,
  and `design/phases/P15-declared-writes-audit.yaml`'s P15-T5
  cancellation note all claimed that `--audit-strict on
  phase reconcile (P15-T6, v1.6+)` was unaffected by the
  P15-T5 closure. **It was never shipped.** P15-T6
  implementation scope-reduced to `task finalize
  --audit-strict` only; the `phase reconcile --audit-strict`
  surface does not exist in any released version. The P15-T6
  task description is updated with a v1.10 hindsight note
  documenting the scope reduction. The "supported way to run
  audit-aware reconciliation" is now correctly described as
  per-task `task finalize --audit-strict` driven by
  `phase runbook --across-phases`.

- **CI recommendation examples now include `--base-ref`.**
  The previous wording in `src/i18n/en-US.ts`,
  `src/i18n/ja-JP.ts`, `design/decisions/agent-contract-rfc.md`,
  and `docs/migration.md` recommended `task finalize
  --audit-strict --write --json` for CI. That command in a
  clean working tree (the typical CI state — commits are
  pushed, no uncommitted diff) returns
  `files_touched: []` and fires
  `TASK_WRITES_AUDIT_DECLARED_UNUSED` for every task whose
  declared writes the working tree does not currently dirty,
  which makes `--audit-strict` exit 1 every CI run. The fix
  pairs `--audit-strict` with `--base-ref <default-branch>`
  for CI (so the audit compares against the merge-base) and
  keeps the bare form for local pre-commit review (where the
  uncommitted working tree IS the audit target). Both
  patterns are now documented side by side. Adapter
  instruction files installed before v1.10.1 carry the old
  wording; re-run `code-pact adapter upgrade <agent> --check`
  to see the drift and `--write --accept-modified` to refresh.

- **`docs/concepts/task-readiness-fields.md` refreshed.**
  The `depends_on` section claimed "multi-node cycle
  detection is future work" and "references to ids not in
  the same phase" — both true for v1.1, but P19 (v1.9)
  shipped cross-phase resolution + `TASK_DEPENDS_ON_CYCLE`.
  The `writes` section described protected paths as a
  built-in seed list "P14 governance may replace... with a
  configurable policy" — but P15-T3 (v1.6) already shipped
  the configurable policy via `design/rules/protected-paths.md`.
  Both sections are updated to current state and gain a
  `TASK_WRITES_OVER_BROAD` + `write_audit` summary alongside
  the existing diagnostics.

### Why this is a patch (1.10.1, not 1.11.0)

No new commands. No new flags. No new error codes. No
schema changes. No JSON envelope changes. Adapter manifests
unchanged. Existing CLI behaviour byte-identical. The
patch corrects documentation and design-metadata strings
only — exactly the case `semver` reserves the patch
position for.

## [1.10.0] — 2026-05-22

**Evidence harness release.** P20 (Evidence Harness) ships
feature-complete (T1–T4, all done) and v1.10 simultaneously
closes the long-standing P15-T5 deferral. The release is the
"move from 感覚 to measurement" payload — internal-only
tooling that captures deterministic-input metrics from the
dogfood corpus and emits committable CSV under
`design/measurements/`. Future RFCs can cite specific row
values verbatim ("the v1.10 baseline shows P14-T5 pack size
is 59,346 bytes").

**code-pact users see nothing new.** The harness is a
maintainer tool — invoked via `pnpm harness`, NOT through
the public CLI. `package.json` `bin` is unchanged. No new
public commands, no new flags, no new error codes, no JSON
envelope changes on any existing command. `dist/cli.js`
size is unchanged.

The release ships three things:

- **`pnpm harness --corpus . [--write] [--json]`** —
  internal-only measurement script at `scripts/harness/`.
  Default `--check` prints to stdout, `--write` opt-in.
- **Four CSV metrics** under `design/measurements/`:
  `pack-size-by-task.csv` (per-task context pack size +
  field cardinalities), `verify-success-rate.csv`
  (first-pass vs retry), `task-event-density.csv` (progress
  event histogram + event span in days),
  `lint-issue-histogram.csv` (`plan lint` diagnostic counts
  by phase + code). Plus `measurements.manifest.json`
  recording the corpus git SHA + harness version + cli
  version + date-only `generated_at`.
- **Byte-determinism contract** — two runs against the same
  corpus SHA produce byte-identical CSVs. Verified by an
  integration test.

### Changed

- **`plan analyze`** now treats `cancelled` tasks as "closed"
  for the `PHASE_DONE_WITH_OPEN_TASKS` check (same as `done`).
  Previously, a phase marked `done` with any non-done task —
  including `cancelled` — fired the error. The semantics are
  now: a phase is consistent if every task is either `done`
  or `cancelled`. This is necessary for the P15-T5 cancellation
  to land cleanly. No new error code; no API surface change.

### Closed (cancelled, not shipped)

- **P15-T5** — `write_audit` in `phase reconcile --json`.
  Originally deferred to "a future RFC" in v1.6; v1.10
  formally closes it as `cancelled`. The use case (phase-
  level audit during release prep) is already served by
  the combination of `task finalize --audit-strict`
  (P15-T6, v1.6+) and `phase runbook --across-phases`
  (P19, v1.9+). The "diff attribution problem" (a single
  working-tree diff cannot be deterministically sharded
  across tasks) remains unsolved on the conceptual level —
  meaning any phase-level audit would either over-report
  or require new declared semantics for which task owns
  which file. Given the existing surface covers the real-
  world use case, the marginal value of a new schema
  surface no longer justifies the cost. P15-T5's task
  description in `design/phases/P15-declared-writes-audit.yaml`
  is updated with the cancellation rationale; the P15
  phase status flips from `in_progress` to `done`.
  `task finalize --audit-strict` (P15-T6, v1.6+, the only
  `--audit-strict` surface that ever shipped) is unaffected.

### Why this is a minor (1.10.0, not 1.9.1)

Strictly speaking, the user-visible product surface is
unchanged in v1.10. The new harness is internal-only. We
still cut a minor (not a patch) because:

1. Cancelling P15-T5 is a meaningful design statement —
   it closes a phase that had been in_progress for several
   releases and removes a future schema-surface obligation.
2. The committed baseline CSVs are a new repository artifact
   that future RFCs depend on. A patch release with the
   cancellation note alone would understate the work.

A future release that ships actual user-visible features
will use the version-bump bandwidth appropriately; for now,
v1.10.0 marks "the harness exists, the baseline is frozen,
P15 is closed."

### Added

- **P20-T4** — Evidence harness docs + phase close (closes
  P20). New `docs/concepts/evidence-harness.md` walks through
  why the harness exists ("move design judgement from 感覚
  to measurement"), what it measures (the 4-CSV metric set
  in detail), how to invoke it, the byte-determinism
  contract, how to cite rows in future RFCs, and the
  explicit "what this is NOT" list. `docs/cli-contract.md`
  gains a new `## Maintainer-only tooling (NOT part of the
  CLI surface)` section forestalling the misread that
  `pnpm harness` is a public command. P20 phase status flips
  to done.

- **P20-T3** — Baseline measurement on the dogfood corpus.
  Commits the first real-world output of the harness under
  `design/measurements/`:
  - `pack-size-by-task.csv` — 105 task rows
  - `verify-success-rate.csv` — 68 task rows (only tasks with
    a `done` event are emitted)
  - `task-event-density.csv` — 68 task rows
  - `lint-issue-histogram.csv` — header-only (strict-clean
    corpus produces 0 issues at v1.10 baseline)
  - `measurements.manifest.json` — harness_version `0.1.0`,
    cli_version `1.9.0`, `generated_at` `2026-05-22`

  These CSVs are the seed any future RFC can cite. No
  production code changes in this task.

- **P20-T2** — Evidence harness implementation. New maintainer
  script at `scripts/harness/run.ts` (invoked via `pnpm harness
  --corpus . [--write] [--json]`). Walks the corpus, computes
  the four metric sets locked in P20-T1, and either prints the
  CSVs to stdout (default `--check`) or writes them under
  `design/measurements/` (`--write`).

  Implementation:
  - `scripts/harness/metrics.ts` — pure metric computation
    helpers (`buildPackSizeRow`, `buildVerifySuccessRow`,
    `buildEventDensityRow`, `buildLintHistogram`, `rowsToCsv`)
  - `scripts/harness/run.ts` — orchestrator. Loads plan state,
    iterates phases/tasks sorted by id, builds context packs
    via `buildContextPack`, walks progress events for verify-
    success and event-density rows, runs `runPlanLint` for
    the histogram, and serializes everything to CSV
  - `package.json` `scripts.harness` (NOT `bin`) — the harness
    is a maintainer tool, never a public CLI surface
  - `tsx` added as a dev dependency for the `pnpm harness` script

  Byte-determinism is preserved: rows sorted by `phase_id ASC`
  then `task_id`/`code ASC`, `generated_at` in the manifest is
  a date only (no clock time), git SHA read via `spawnSync`
  with explicit argv (no shell interpolation).

  Tests:
  - 18 unit tests for the metric-computation helpers covering
    pack-size cardinality, first-pass / retry detection,
    event histograms, lint bucketing, CSV escaping
  - 3 integration tests: `--write` persistence, default
    `--check` no-write invariant, two consecutive `--write`
    runs produce byte-identical CSVs

- **P20-T1** — Evidence harness RFC. New phase
  `P20 — Evidence Harness` registered in
  `design/roadmap.yaml` (weight 20). RFC at
  `design/decisions/evidence-harness-rfc.md` (accepted) locks
  the internal-only harness design before any code is written:
  - Internal-only — NOT registered in `package.json` bin, no
    public CLI surface, no JSON envelope changes
  - Initial 4-CSV metric set (`pack-size-by-task`,
    `verify-success-rate`, `task-event-density`,
    `lint-issue-histogram`) — column shapes locked
  - Output to `design/measurements/` (NOT gitignored — the
    CSVs are committed artifacts for future RFC citation)
  - Byte-determinism contract: no clock timestamps in CSV
    cells; `generated_at` in manifest is a date only
  - `pnpm harness --corpus . [--write] [--json]` invocation;
    default `--check` mode prints to stdout, `--write` opt-in

  Implementation lands in P20-T2..T4; v1.10.0 target.

## [1.9.0] — 2026-05-22

**Cross-phase dependencies release.** P19 (Cross-phase
Dependencies) ships feature-complete (T1–T4, all done).
v1.9 extends `depends_on` to accept references to tasks in
other phases — the schema field stays `string[]`, but the
resolver and lint detectors now look across phases when a
same-phase lookup fails. This unlocks two real-world patterns
that previously had to be tracked in PR descriptions / prose:

1. **Release prep that bundles multiple in_progress phases.**
   A v1.X.0 release prep task can now declare
   `depends_on: ["P18-T5", "P19-T4"]` and the dep gate is
   machine-checked end to end.
2. **A phase that legitimately blocks on an earlier phase's
   deferred task.** Useful for closing late spillover (e.g.
   P15-T5) before downstream phases proceed past a certain
   point.

The release adds three things:

- **`code-pact phase runbook --across-phases [--json]`** —
  new aggregated runbook that emits one per-phase
  `PhaseRunbookResult` for every phase in scope
  (`in_progress` + one level of transitive dep-driven
  inclusion). Default `phase runbook <id>` invocation is
  unchanged.
- **`TASK_DEPENDS_ON_CYCLE`** — new plan-lint code (severity
  error) built on iterative Tarjan SCC over the multi-phase
  dep graph. Catches A → B → A, A → B → C → A, etc.
  Self-cycles keep their narrower
  `TASK_DEPENDS_ON_SELF_REFERENCE` diagnostic.
- **Cross-phase resolution semantics** for `depends_on`.
  `TASK_DEPENDS_ON_UNRESOLVED` now fires only for ids absent
  from the ENTIRE roadmap (was: absent from the same phase).
  Existing JSON consumers see an additive `phase_id` field
  on `task runbook`'s `depends_on_check[i]` entries for
  cross-phase resolutions; same-phase deps omit the field.

No `depends_on` schema type change, no `task finalize`
eligibility change, no rename or removal of existing
diagnostics. `KNOWN_CODES.public` is unchanged — the new
code goes under `KNOWN_CODES.plan` per the v1.0 additive-
growth contract.

Why this is a minor (1.9.0, not 1.8.1): the release adds a
new top-level Stable v1.0 flag (`--across-phases`) and a new
plan-lint code. Patch releases are reserved for bug fixes
and doc-only changes; new flags and codes move the minor.

### Added

- **P19-T4** — `task runbook` cross-phase display update +
  docs + phase close (closes P19). Human-mode `task runbook
  <id>` output now prints a `depends_on:` block under the
  state summary, naming the foreign phase inline when a dep
  is cross-phase (e.g. `- P15-T5 (cross-phase: P15):
  derived=planned (unsatisfied)`). The JSON envelope shape
  was already locked in P19-T2 (`depends_on_check[i].phase_id`
  additive field); this task just teaches the human formatter
  to surface it.

  `docs/cli-contract.md` gains `### --across-phases` and
  `### Cross-phase depends_on` sections under
  `## phase runbook`. `docs/dogfood.md` gains a short
  "Tracking release prep with phase runbook --across-phases"
  subsection under "Release prep uses strict-clean dogfood
  checks". P19 phase status flips to done.

- **P19-T3** — `phase runbook --across-phases [--json]`.
  New aggregated runbook that emits one per-phase
  `PhaseRunbookResult` for every phase in scope. Inclusion
  rules:
  - `phase.status === "in_progress"` — always included.
  - Phases that DECLARE a task referenced (via `depends_on`)
    by an in_progress phase task with derived state != done
    — pulled in via one level of transitive closure (enough
    for release-prep semantics without surfacing the entire
    roadmap).

  Phases with status `done`, `planned`, or `cancelled` are
  excluded unless pulled in via the dep-driven rule. Step
  order: phase id ascending, then within-phase P12 runbook
  order.

  Envelope: `{ kind: "aggregated_runbook", phases_considered:
  string[], phases: PhaseRunbookResult[] }` — re-uses the
  existing `PhaseRunbookResult` shape so consumers can treat
  each `phases[i]` exactly like a single-phase runbook.

  Default `phase runbook <id>` invocation is unchanged —
  the new flag is purely additive. The regression is
  asserted by an integration test that still invokes the
  classic single-phase form. 6 new integration tests cover
  the two-in-progress aggregation, done/planned/cancelled
  exclusion, dep-driven inclusion, no-in-progress empty
  envelope, dep-no-dedup ordering, and the default-mode
  regression.

- **P19-T2** — Cross-phase `depends_on` resolver + multi-node
  cycle detection. `resolveDependsOnStates(events, task, options?)`
  gains an optional third argument `{ ownPhaseId, taskPhaseIndex }`
  (with the latter built by the new `buildTaskPhaseIndex(phases)`
  helper). When supplied, deps that resolve to a task declared in
  a different phase populate an additive `phase_id` field on the
  returned `DependsOnEntry`; same-phase deps and unresolved deps
  omit the field — additive surface per the v1.0 contract.
  `task runbook` wires the index automatically.

  `detectTaskDependsOnUnresolved` becomes cross-phase aware:
  a dep id present in any phase resolves (no warning); only ids
  absent from the entire roadmap surface as `TASK_DEPENDS_ON_UNRESOLVED`.
  This eliminates the false positive that previously fired
  whenever a phase legitimately depended on a sibling phase's task.

  New `TASK_DEPENDS_ON_CYCLE` lint code (plan, severity error)
  built on iterative Tarjan SCC over the multi-phase dep graph.
  Self-cycles keep firing the narrower `TASK_DEPENDS_ON_SELF_REFERENCE`
  diagnostic; the new code covers cycles of length ≥ 2. Each
  emitted issue carries `details.cycle: string[]` listing the
  cycle members in canonical (lexicographic-min-rotated) order
  for deterministic test fixtures. 14 unit tests cover the
  2-/3-/4-node, same-phase / cross-phase, disjoint-cycle,
  deep-linear-chain, and mixed-self+multi-node matrices; the
  resolver gains 5 new unit tests for the cross-phase /
  same-phase / mixed / no-index / duplicate-id-index cases.

- **P19-T1** — Cross-phase dependencies RFC. New phase
  `P19 — Cross-phase Dependencies` registered in
  `design/roadmap.yaml` (weight 20). RFC at
  `design/decisions/cross-phase-deps-rfc.md` (accepted) locks
  the design before any resolver / lint / runbook code is
  written: cross-phase `depends_on` references resolve via
  same-phase-first / cross-phase-fallback lookup; new
  `TASK_DEPENDS_ON_CYCLE` lint code (plan/warning) covers
  multi-node cycles via iterative DFS; `phase runbook
  --across-phases [--json]` aggregates per-phase runbook
  steps for `in_progress` phases + dep-driven inclusions;
  `task runbook` per-dependency display gains an additive
  `phase_id` field on `depends_on_check[]` entries (only
  populated for cross-phase resolutions). No schema changes,
  no `task finalize` eligibility changes, no existing
  diagnostic rename/removal. Implementation lands in
  P19-T2..T4; v1.9.0 target.

## [1.8.0] — 2026-05-22

**Spec Kit bridge release.** P18 (Spec Kit Bridge) ships
feature-complete (T1–T5, all done). v1.8 adds a new top-level
`code-pact spec import` command — a read-only, one-way bridge
that ingests external spec-driven planning artifacts (initially
the `tasks.md` file format used by Spec Kit and similar tools)
into code-pact's phase YAML. **code-pact does not re-implement
Spec Kit and does not sync back** — the bridge exists so teams
already invested in Spec Kit can adopt code-pact without
throwing their planning work away.

Two complementary modes share the same command:

- `spec import --from <tasks.md> --phase-id <id> [--write]
  [--force] [--json]` parses a Heading 3 + `- [ ]` checkbox
  subset of Markdown into a draft `design/phases/<id>-
  imported.yaml`. Dry-run by default; `--write` persists.
  Generated tasks carry minimal P10 defaults (`type=feature`,
  all judgement axes = `medium`, `status=planned`); the user
  fills in `reads` / `writes` / `acceptance_refs` after the
  import. **The importer does NOT add the new phase to
  `design/roadmap.yaml`** — that stays an explicit follow-up
  governed by P14 (the chokepoint contract is preserved).
- `spec import --suggest-from <spec.md|plan.md> --json`
  extracts brief / constitution candidates from a Spec Kit
  `spec.md` or `plan.md` and prints the envelope. **Never
  writes any file** — the user pipes the suggestions into
  `plan brief --from-file` / `plan constitution --from-file`
  (the v1.6 P17 non-interactive paths) if they accept them.

No new public error codes — failures all reuse `CONFIG_ERROR`
with a structured `data.detail` enum (`unsafe_path` /
`file_not_found` / `unreadable` / `phase_id_invalid` /
`phase_yaml_exists` / `no_sections_parsed` / `mutex_violation`
/ `missing_phase_id`). The public error code surface stays
size-stable. No phase YAML schema changes — the importer
writes valid existing phase YAML.

Why this matters now: code-pact's control-plane positioning
hinges on accepting artifacts from other tools without
demanding teams rewrite their planning. The Spec Kit bridge
is the first explicit instance of that posture, and it sets
the precedent for future importers (deliberately deferred to
their own phases + RFCs).

### Added

- **P18-T5** — Spec Kit bridge: documentation + getting-started
  integration (closes P18). New `docs/spec-kit-bridge.md` walks
  through both `--from` and `--suggest-from` modes, the
  supported Markdown subset, the generated phase shape, the
  mutex constraints, and the post-import follow-up sequence.
  `docs/cli-contract.md` gains a full `## spec import (v1.8+)`
  section under Stable v1.0 commands with the success / failure
  envelopes and the `data.detail` enum reference. `docs/getting-
  started.md` gains a short "Ingesting external specs"
  subsection pointing at the bridge as one bootstrap option.
  P18 phase status flips to done since this task closes the phase.

- **P18-T4** — Spec Kit bridge: read-only suggestion extraction
  for `spec.md` / `plan.md` files. New module
  `src/core/spec-import/spec-md-extractor.ts` exports
  `extractSpecMd(input: string): SpecMdExtractResult` returning
  `{ brief_candidates: { what?, who?, differentiator? },
     constitution_candidates: { description?, principles? },
     recognised_sections[], skipped_sections[] }`. The
  extractor is heading-level-agnostic and recognises a small
  set of canonical Spec Kit headings (Problem statement / Goal
  / Audience / Personas / Positioning / Background / Principles
  / Constraints, etc.) plus their common synonyms. First-match-
  wins so duplicate headings don't override.

  CLI surface: `code-pact spec import --suggest-from <path>
  --json` reads the file, runs the extractor, and prints the
  result envelope. **Never writes any file** — the user pipes
  the suggestions into `plan brief --from-file` /
  `plan constitution --from-file` if they want to persist.

  Mutex constraint: `--from` and `--suggest-from` cannot be
  combined; passing both returns `CONFIG_ERROR` with
  `data.detail: "mutex_violation"`. `--phase-id` is ignored
  silently when only `--suggest-from` is passed (suggestion
  mode has no use for it). Missing `--phase-id` with `--from`
  is now reported with structured `data.detail: "missing_phase_id"`.

  15 unit tests cover the extractor matrix (empty / typical
  spec.md / typical constitution.md / unrecognised sections /
  first-match-wins / heading levels h1–h6 / multi-line
  paragraph collapsing / blank-line termination / code-fence
  ignoring / Windows line endings / heading normalisation /
  empty principles / Spec Kit Goals → what / Constraints →
  principles / Unicode). 8 integration tests cover the
  --suggest-from envelope, mutex_violation, missing source,
  unsafe path, read-only invariant, and the silently-ignored
  --phase-id case.

- **P18-T3** — Spec Kit bridge: `code-pact spec import` CLI command
  (Stable v1.8+). New top-level `spec` namespace with the first
  subcommand `import`. Reads a `tasks.md` file, parses via the
  P18-T2 parser, transforms into a draft phase YAML, and either
  prints it to stdout (dry-run, default) or writes it to
  `design/phases/<id>-imported.yaml` (`--write`). Flags:
  `--from <path>` (required, safe relative path), `--phase-id <id>`
  (required, must match `/^[A-Za-z][A-Za-z0-9_-]*$/`), `--write`,
  `--force`, `--json`. Errors all reuse `CONFIG_ERROR` with a
  structured `data.detail` enum: `unsafe_path` / `file_not_found`
  / `unreadable` / `phase_id_invalid` / `phase_yaml_exists` /
  `no_sections_parsed`. The importer does NOT add the new phase
  to `design/roadmap.yaml` — that stays an explicit follow-up
  governed by P14. JSON envelope success surface:
  `{ kind: "would_import" | "imported", source_path, phase_id,
  sections_imported, tasks_imported, skipped_lines, output_path,
  phase_yaml, warnings[] }`. 11 integration tests cover the
  dry-run, --write, --force, missing-flag, unsafe-path,
  file-not-found, no-sections, and invalid-phase-id matrices.

- **P18-T2** — Spec Kit bridge: `tasks.md` parser core. New module
  `src/core/spec-import/` ships `parseTasksMd(input: string):
  ParseResult` — a pure function (no file I/O) that consumes raw
  Markdown text and returns `{ sections: { title; tasks[] }[];
  warnings: ParserWarning[]; skipped_lines: number }`. The
  supported subset is Heading 3 sections + `- [ ]` checkbox list
  items per the P18-T1 RFC. Constructs outside the subset
  (other heading levels, plain bullets, numbered lists, code
  fences, tables, frontmatter, HTML comments, checked tasks)
  are silently dropped but counted in `skipped_lines` and
  surfaced as typed `ParserWarning` records. Handles Windows
  (`\r\n`), classic Mac (`\r`), and Unix (`\n`) line endings.
  Unit tests cover empty input, only-headings, multiple
  sections, checked/unchecked tasks, orphan checkboxes,
  malformed checkboxes, frontmatter, code fences, tables,
  HTML comments, Unicode/emoji in task text, and mixed line
  endings.

- **P18-T1** — Spec Kit bridge RFC. New phase `P18 — Spec Kit Bridge`
  registered in `design/roadmap.yaml` (weight 25). RFC at
  `design/decisions/spec-kit-bridge-rfc.md` (accepted) locks the
  read-only one-way importer design: a new top-level
  `code-pact spec import --from <tasks.md> --phase-id <id>
  [--write] [--force] [--json]` command, plus
  `spec import --suggest-from <spec.md|plan.md> --json` for
  brief / constitution candidate extraction. Supported subset
  is intentionally narrow (Heading 3 sections + `- [ ]`
  checkbox lists). No new public error codes — `CONFIG_ERROR`
  is reused for unsafe path / collision / parse-failure.
  Implementation lands in P18-T2..T5; v1.8.0 target.

---

## [1.7.0] — 2026-05-22

**Agent contract release.** P16 (Agent Contract Adapter Hardening)
ships feature-complete in this release. The three stable adapters
(claude-code, codex, generic) graduate from "instruction templates
that produce per-agent files" to "agent contracts" — their
instruction files now carry a load-bearing `## Agent contract`
section between the per-task workflow and the model selection,
naming the three axes every conforming agent must honor:

- `### When to invoke code-pact` — the canonical command sequence
  plus the v1.6 non-interactive bootstrap surfaces.
- `### What to verify first` — pre-action checks plus the v1.6
  audit-aware additions.
- `### How to handle failures` — `LOCK_HELD`, `VERIFICATION_FAILED`,
  `WRITES_AUDIT_STRICT_FAILED`, `TASK_FINALIZE_NOT_ELIGIBLE`,
  `CONFIG_ERROR` recovery patterns.

The v1.6 surfaces (`--audit-strict`, `--from-file`, `--stdin`,
`write_audit`) are now referenced inline in every conforming
instruction file, so an agent installed via `adapter install
<agent>` sees them on day one. Heading strings are English-locked
across all locales (en-US, ja-JP); body text is localised. Why
agent contract matters now: v1.6 added 11 new CLI surfaces that
the pre-P16 templates didn't teach — agents had no way to know
`--audit-strict` existed or which envelope field to inspect
before finalize.

Two new structural surfaces close the loop:

- The **adapter conformance test** anchors on the agent-contract
  heading + axis sub-headings + v1.6 surface mentions, so any
  future template drift fails a CI assertion.
- The **`ADAPTER_CONTRACT_DRIFT` diagnostic** in `adapter doctor`
  surfaces missing or out-of-shape contract sections on existing
  installs (typically pre-P16 generator output). Independent of
  `ADAPTER_FILE_DRIFT` (file-level hash drift) — both can fire
  on the same file with different remediations.

cursor and gemini-cli remain experimental and out-of-scope, per
the P14 conformance posture.

**Self-validation footnote.** The P15-T1 audit advisory caught
real declared-writes omissions in **14 consecutive** v1.6 + v1.7
implementation slices. The P15-T4 `DECLARED_UNUSED` warning fired
on real scope deviations five times (P17-T3, P15-T6, P16-T2,
P16-T3, P16-T5), three of which were "plan / implementation site
mismatch" — the spec named one file but the implementation
landed on another. The audit + conformance regime continues to
pay for itself during the releases it ships in.

### Added

- **Agent contract RFC accepted** (v1.7+, P16-T1). New
  `design/decisions/agent-contract-rfc.md` locks the design for
  elevating stable adapters from "instruction templates" to
  "agent contracts". The RFC names the three load-bearing axes
  every conforming adapter MUST cover (when to invoke code-pact,
  what to verify first, how to handle failures), specifies the
  per-adapter scope (claude-code / codex / generic in;
  cursor / gemini-cli out), pre-decides the new diagnostic code
  `ADAPTER_CONTRACT_DRIFT` (severity: warning, soft signal —
  does NOT change `adapter doctor` exit code), and documents the
  backward-compatibility story (`--accept-modified` continues
  to govern hand-edited files; the new diagnostic is independent
  of `ADAPTER_FILE_DRIFT`). The RFC also closes P16's scope:
  only the textual instruction-body changes, one new advisory
  diagnostic, and the conformance test extension — no LLM API
  integration, no file shape changes, no per-locale axis heading
  variations. Subsequent P16-T2..T5 implementation PRs treat
  this RFC as load-bearing.
- **P16 phase registered** (v1.7+). `design/roadmap.yaml` lists
  P16 (Agent Contract Adapter Hardening, weight 25). Phase
  status stays `in_progress` until P16-T5 lands.
- **`ADAPTER_CONTRACT_DRIFT` diagnostic in `adapter doctor`**
  (v1.7+, P16-T5). New `KNOWN_CODES.adapter` entry. Soft signal
  (severity: warning) — does NOT gate the doctor exit code.
  Independent of `ADAPTER_FILE_DRIFT` (the existing file-level
  hash drift signal); both diagnoses can fire in the same run
  and require different remediations. Detection: scans every
  managed instruction file's on-disk body for the verbatim
  `## Agent contract` heading and three axis sub-headings; if
  the section heading is absent, emits with
  `details: { kind: "section_missing" }`; if the section heading
  is present but any axis sub-heading is missing, emits with
  `details: { kind: "axes_incomplete", missing_axes: string[] }`.
  The `details` field is additive on the `AdapterDoctorIssue`
  shape (mirrors the `PlanIssue.details` convention); consumers
  that read only `code` / `severity` / `message` / `agent` /
  `path` see no contract change. Resolution: `adapter upgrade
  <agent> --write` reinstates the section; `--accept-modified`
  preserves any user edits. Global `doctor` continues to strip
  `details` per the existing cross-cutting `adapterIssueToDoctor`
  contract — full structured details surface only on the
  dedicated `adapter doctor` envelope.
- **P16 phase complete (T1–T5 all done)** (v1.7+). Phase status
  flipped from `in_progress` to `done` after T5 ships. P16 was
  feature-scoped to elevating the three stable adapters
  (claude-code, codex, generic) from "instruction templates" to
  "agent contracts" — see `design/decisions/agent-contract-rfc.md`
  for the full design lock.
- **Adapter conformance test extended for agent-contract section**
  (v1.7+, P16-T4). `tests/integration/adapter-conformance.test.ts`
  gains four new assertions per stable adapter (claude-code,
  codex, generic): (a) the verbatim `## Agent contract` heading
  is present, (b) the three axis sub-headings
  (`### When to invoke code-pact`, `### What to verify first`,
  `### How to handle failures`) are present verbatim, (c) the
  agent-contract body (sliced between the section heading and
  the next H2) references every v1.6 audit surface
  (`--audit-strict`, `--from-file`, `--stdin`, `write_audit`),
  and (d) the section appears AFTER the per-task workflow header
  (placement check). The body-slice anchor ensures a surface
  mention elsewhere in the file cannot satisfy assertion (c) —
  the surfaces must live INSIDE the contract section.
  Heading strings are English-locked per the RFC; the regex
  anchors on the literal text across all locales. cursor /
  gemini-cli stay excluded from conformance as before. Test
  count: 286 (was 274 — +12 from the 4 new assertions × 3
  stable adapters).
- **codex + generic adapter instruction templates gain
  `## Agent contract` section** (v1.7+, P16-T3). Same shape and
  content as P16-T2's claude-code update: heading strings are
  English-locked across all locales (en-US, ja-JP), body text is
  localised, the section sits between the per-task workflow and
  the next adapter-specific section (`## Model selection` for
  codex, `## Context directory` for generic). The i18n strings
  (`templates.adapterCommon.agentContract`) are shared with the
  claude-code path — no new locale data; this PR only touches the
  two adapter template builders (`src/core/adapters/codex.ts`,
  `src/core/adapters/generic.ts`) and CHANGELOG. cursor /
  gemini-cli adapters stay experimental and untouched. After this
  PR, all three stable adapters carry the agent-contract section.
  Conformance regex (P16-T4) and `ADAPTER_CONTRACT_DRIFT`
  diagnostic (P16-T5) ship next.
- **claude-code adapter instruction template gains
  `## Agent contract` section** (v1.7+, P16-T2). Per the
  P16-T1 RFC, the canonical claude-code instruction file
  (`CLAUDE.md`) now carries a load-bearing agent-contract
  section between the per-task workflow and the model
  selection. The section names three axes — `When to invoke
  code-pact`, `What to verify first`, `How to handle
  failures` — and references the v1.6+ surfaces inline
  (`--audit-strict`, `--from-file`, `--stdin`, flag-driven
  `plan brief` & `plan constitution`, configurable protected
  paths, `write_audit`, `--base-ref`). Heading strings are
  English-locked across all locales (en-US, ja-JP) so the
  P16-T4 conformance regex can anchor on them; body text is
  localised normally. Adapter manifest schema is unchanged;
  `CLAUDE.md` path and role are unchanged — only the body
  content grows. Existing projects see this as
  `ADAPTER_FILE_DRIFT` on `adapter upgrade --check` until
  they run `adapter upgrade --write` (`--accept-modified`
  preserves any user edits). codex / generic adapters
  follow in P16-T3; cursor / gemini-cli stay
  experimental-and-untouched.

### Compatibility

- **Default invocations are byte-identical to v1.6.0** for every
  existing command. The only behavioural change ships through
  `adapter install` / `adapter upgrade` — the generated
  instruction file body grows by the new agent-contract section.
- **No CLI flag changes, no schema changes, no exit-code
  changes.** The new diagnostic is a warning that never gates
  `adapter doctor`'s exit code.
- **`KNOWN_CODES.adapter` extension is additive: one new code**
  (`ADAPTER_CONTRACT_DRIFT`). `KNOWN_CODES.public` and
  `KNOWN_CODES.plan` are unchanged.
- **`AdapterDoctorIssue` gains an additive `details?:
  Record<string, unknown>`** field. Mirrors the
  `PlanIssue.details` convention; consumers reading only
  `code` / `severity` / `message` / `agent` / `path` see no
  shape change.
- **Global `doctor`** continues to strip `details` per the
  existing `adapterIssueToDoctor` cross-cutting helper. The
  structured payload surfaces only on the dedicated
  `adapter doctor` envelope.
- **Existing v1.6 projects** will see `ADAPTER_FILE_DRIFT` on
  `adapter upgrade --check` (the instruction file body changed
  to add the new section) and `ADAPTER_CONTRACT_DRIFT` on
  `adapter doctor` (until they run `adapter upgrade --write`).
  `--accept-modified` preserves any user edits while applying
  the new template.
- **`tests/integration/json-stdout.test.ts`** continues to pass
  for every Stable command. No envelope shape changes.
- **cursor / gemini-cli adapters** stay experimental and
  untouched.

### Deferred to v1.8+

- **P15-T5 — `phase reconcile --json` write_audit exposure** —
  still deferred, no change from v1.6.0 status. The
  "diff attribution across multiple tasks" semantics RFC is the
  blocker.
- **Auto-injection of the contract section on `adapter upgrade
  --write --accept-modified`** — currently the diagnostic
  surfaces missing sections but the user must rerun without
  `--accept-modified` (or hand-edit the section back) to apply.
  A surgical injection mechanism is a future refinement once
  `ADAPTER_CONTRACT_DRIFT` has shown enough false-positive /
  false-negative data to design the right machinery.
- **cursor / gemini-cli stable promotion** — both adapters stay
  experimental. Promotion requires conformance work first; not
  in scope for v1.7.

---

## [1.6.0] — 2026-05-22

**Audit + non-interactive authoring release.** Two new feature
phases ship together:

- **P15 — Declared Writes Audit** (T1–T4, T6): `task finalize --json`
  gains a read-only `write_audit` envelope that compares each task's
  declared `writes` globs against the actual filesystem changes
  reported by git. New plan-lint warnings flag over-broad declared
  globs (`TASK_WRITES_OVER_BROAD`) and unused declarations
  (`TASK_WRITES_AUDIT_DECLARED_UNUSED`). The protected-paths list is
  now configurable via `design/rules/protected-paths.md`. The opt-in
  `task finalize --audit-strict` flag promotes warnings to
  exit-relevant (exit 1, `WRITES_AUDIT_STRICT_FAILED`) without
  affecting default behaviour. **P15-T5 (phase reconcile audit) is
  deferred to v1.7+** pending a "diff attribution across multiple
  tasks" semantics RFC — the use case overlaps with running
  `task finalize --audit-strict` per task, so the marginal value
  isn't clear yet. P15 phase status stays `in_progress` in this
  release to reflect that.
- **P17 — Non-interactive Authoring** (T1–T5, feature-complete):
  `plan brief` and `plan constitution` (previously TTY-only) each
  gain three non-interactive input modes — `--from-file <yaml>`,
  `--stdin`, and a flag-driven form (`--what` / `--who` /
  `--differentiator` for brief; `--description` / `--principle` for
  constitution). All three modes are pairwise mutually exclusive.
  Output is byte-identical to the TTY wizard for equivalent input.
  This closes the asymmetry where `task add` (v1.4) and
  `phase import` (v0.4+) had non-interactive paths but the two
  planning wizards did not — CI bootstrap is now end-to-end
  scriptable.

**Self-validation footnote.** The P15-T1 audit caught real declared-
writes omissions in **10 consecutive** P15 / P17 implementation
slices during this release cycle (some on its own dogfood, most on
sister tasks). The P15-T4 `DECLARED_UNUSED` warning fired on real
scope deviations twice (P17-T3, P15-T6). Both advisories paid for
themselves during the release they shipped in.

### Added

- **`task finalize --json` emits `data.write_audit`** (v1.6+, P15-T1). Read-only
  advisory comparing the task's declared `writes` globs against the actual
  filesystem changes reported by git. Present on all three success kinds
  (`would_finalize` / `finalized` / `already_finalized`) when `--json` is in
  effect. Default range is the working tree (HEAD vs staged / unstaged /
  untracked); pass `--base-ref <ref>` to opt into branch-level audit via
  `git merge-base HEAD <ref>`. Non-git projects return the canonical
  unavailable shape (`git_available: false`); merge-base failures gracefully
  fall back to working-tree mode with a `base_error` field. Exit code is
  **unchanged** in P15-T1 — the audit is advisory only.
- **`task finalize --base-ref <ref>` flag** (v1.6+, P15-T1). Requires `--json`;
  passing it without `--json` returns `CONFIG_ERROR` (exit 2). The flag is
  additive; existing `task finalize` invocations are byte-identical.
- **`TASK_WRITES_AUDIT_OUTSIDE_DECLARED` warning code** (v1.6+, P15-T1) added
  to `KNOWN_CODES.plan`. Emitted in `data.write_audit.warnings[]` when the
  audit detects a file change outside any declared `writes` glob. Severity:
  warning, never exit-relevant in P15-T1.
- **`src/core/audit/write-audit.ts`** new internal module exposing
  `auditWrites({ cwd, declaredWrites, baseRef? })`. Reused by future P15
  tasks for `phase reconcile --json` (P15-T5) and `--audit-strict` (P15-T6).
- **`TASK_WRITES_OVER_BROAD` plan-lint warning** (v1.6+, P15-T2). Flags
  declared `writes` globs whose root path segment is `**` — patterns that
  match the entire repository (e.g. `**`, `**/*`, `**/*.ts`, `**/foo.ts`).
  Legitimate task-scoped globs (`src/core/audit/**`, `src/**/*.ts`,
  `tests/unit/**`) have a concrete root segment and pass unchanged.
  Severity: warning, advisory in default `plan lint`; exit-relevant under
  `plan lint --strict` per the existing binary promotion. Heuristic-only:
  the goal is to catch obvious "writes everywhere" declarations, not to
  encode a precise breadth metric.
- **`task finalize --audit-strict` opt-in gate** (v1.6+, P15-T6).
  New flag promotes `TASK_WRITES_AUDIT_*` warnings from advisory to
  exit-relevant for `task finalize`. With the flag, any warning in
  the audit envelope returns `WRITES_AUDIT_STRICT_FAILED` (exit
  **1** — not 2; the invocation was well-formed, only the strict
  gate refused) and the design YAML is NOT mutated even when
  `--write` is set. Without the flag, default behaviour is
  unchanged — warnings stay advisory, exit code stays 0. Requires
  `--json` (same constraint as `--base-ref`); passing it without
  `--json` returns `CONFIG_ERROR` (exit 2). The strict-failure
  envelope carries the full `write_audit` plus a fixed
  `applied: false` invariant — the gate fires before
  `applyPlannedWrite`, so the no-mutation guarantee is
  machine-readable. New public error code
  `WRITES_AUDIT_STRICT_FAILED` added to `KNOWN_CODES.public`. Kept
  distinct from `plan lint --strict` (plan-lint-scoped) so existing
  CI consumers of either flag are unaffected.
  `phase reconcile --audit-strict` is deferred to a follow-up
  after P15-T5 (phase reconcile audit) ships — the gate would be
  a no-op there today.
- **Non-interactive authoring walkthrough docs** (v1.6+, P17-T5). New
  `docs/dogfood.md § Non-interactive plan brief / plan constitution`
  section walks through all six non-interactive modes (--from-file,
  --stdin, flag-driven on each of the two commands) with copy-paste
  examples. The `BRIEF_MISSING` and `CONSTITUTION_PLACEHOLDER`
  expected-warning rows in dogfood.md now point at the v1.6+
  resolution paths instead of "edit manually or use a TTY". The
  Quick reference table gains CI / non-TTY rows for both commands.
  `docs/getting-started.md` Path 2 (Manual) TTY-only callout is
  rewritten as a CI / non-TTY (v1.6+) callout with a fully-scripted
  bootstrap example (init → plan brief → plan constitution → phase
  add / task add / adapter install) — pre-v1.6 history is preserved
  inline so upgraders see what changed. P17 (Non-interactive
  Authoring) is fully feature-complete with this docs roll-up.
- **`plan constitution` non-interactive trifecta** (v1.6+, P17-T4).
  Applies the P17-T1/T2/T3 plan-brief patterns to `plan constitution`:
  `--from-file <yaml>` reads a YAML file, `--stdin` reads YAML from
  `process.stdin`, and `--description <text>` / `--principle <text>`
  (repeatable) supply the fields as command-line strings. Three
  pairwise-mutually-exclusive modes; passing any combination returns
  `CONFIG_ERROR` (exit 2). YAML schema (`ConstitutionFileSchema`)
  has both fields optional and defaulted to empty so empty inputs
  fall through to the locale-specific template defaults — matches
  the wizard's empty-input behaviour exactly. Failure envelopes
  mirror the plan-brief shapes: `--from-file` failures carry
  `data: { detail, path }` with detail enum
  `unsafe_path | unreadable | invalid_yaml | schema_invalid`;
  `--stdin` failures carry `data: { detail, source: "stdin" }` with
  detail enum `stdin_read_failed | invalid_yaml | schema_invalid`.
  Flag-driven mode requires no specific fields (both are optional);
  presence of any flag is the trigger. The non-TTY guard message
  now lists all three modes. Wizard path unchanged. Constitution.md
  produced via any non-interactive mode is byte-identical to one
  produced by the wizard for equivalent input. P17 now covers both
  `plan brief` and `plan constitution`; the v1.6 non-interactive
  authoring contract is feature-complete.
- **`plan brief` flag-driven mode** (v1.6+, P17-T3). New
  `--what <text>` / `--who <text>` / `--differentiator <text>` flags
  supply the brief fields directly as command-line strings. Mirrors
  the v1.4 `task add` non-interactive flag pattern so projects with
  flag-driven `task add` workflows get a consistent surface. Presence
  of ANY of the three flags triggers flag-driven mode; `--what` and
  `--who` are required (non-empty); `--differentiator` is optional
  (defaults to the locale placeholder). Missing required flags return
  `CONFIG_ERROR` (exit 2) with `data.missing: string[]` naming the
  missing flags. Empty-string values for required flags are rejected
  the same as missing flags. Bypasses the TTY check. Pairwise mutex
  with `--from-file` and `--stdin` — passing any combination returns
  `CONFIG_ERROR` (exit 2). Non-TTY guard message updated to list all
  three non-interactive modes so users see every escape hatch. The
  wizard, `--from-file`, and `--stdin` paths are unchanged.
- **`plan brief --stdin`** (v1.6+, P17-T2). Reads the same YAML schema as
  `--from-file` from `process.stdin` instead of a file. Useful for piping
  brief content from another process (`some-tool | code-pact plan brief
  --stdin --json`). Mutually exclusive with `--from-file` — passing both
  returns `CONFIG_ERROR` (exit 2). Failure envelope mirrors `--from-file`
  with `source: "stdin"` replacing the `path` field; detail enum is
  `stdin_read_failed | invalid_yaml | schema_invalid` (the `unsafe_path`
  / `unreadable` details do not apply to stdin). The internal
  YAML-parse / schema-validate pipeline is factored out as
  `parseBriefSource` and shared by both the file and stdin paths;
  loaders supply their own error constructor as a callback. Brief.md
  produced via `--stdin` is byte-identical to one produced by the
  wizard or `--from-file` for equivalent input. The non-TTY guard
  message now mentions both flags. Wizard path unchanged.
- **`plan brief --from-file <yaml>`** (v1.6+, P17-T1). Non-interactive
  input path for `plan brief`. Reads a typed YAML file (`what` / `who` /
  `differentiator`), bypasses the TTY check, and writes `design/brief.md`
  via the existing `generateBriefMd` template — byte-identical to the
  wizard's output for equivalent input. Schema is strict: unknown keys
  rejected; `what` and `who` required non-empty; `differentiator`
  optional (defaults to the wizard's empty-input placeholder). All four
  failure modes (`unsafe_path` / `unreadable` / `invalid_yaml` /
  `schema_invalid`) return `CONFIG_ERROR` (exit 2) with the structured
  envelope `{ ok: false, error: { code: "CONFIG_ERROR", message },
  data: { detail, path } }`. Partial-write-safe: any failure yields
  no write to `design/brief.md`. Wizard path unchanged; the v1.5.1
  contract that non-TTY without `--from-file` returns CONFIG_ERROR is
  preserved. Foundation for P17-T2 (`--stdin`), P17-T3 (flag-driven),
  and P17-T4 (apply the same three paths to `plan constitution`).
- **`TASK_WRITES_AUDIT_DECLARED_UNUSED` warning code** (v1.6+, P15-T4)
  added to `KNOWN_CODES.plan`. Promotes the `declared_unused` data
  field on `task finalize --json`'s `write_audit` envelope from
  data-only to an advisory warning, emitted whenever a declared
  `writes` glob has zero matches in `files_touched`. Fires
  independently of `TASK_WRITES_AUDIT_OUTSIDE_DECLARED` — a single
  audit can emit both. Advisory only: never alters the exit code in
  v1.6 (the `--audit-strict` flag in P15-T6 opts into exit-relevant
  enforcement). Underlying `write_audit` shape is unchanged;
  consumers that only inspect `declared_unused` / `outside_declared`
  / `files_touched` / `base_kind` / `base_ref` see no contract
  change. Signal interpretation: `declared_unused` usually means the
  declaration is stale, the task was partially split across PRs, or
  the planning artifact drifted from reality — exactly the pattern
  P15-T1's audit caught on P15-T2 / P15-T3 in their own PRs.
- **Configurable protected paths via `design/rules/protected-paths.md`**
  (v1.6+, P15-T3). New `src/core/rules/protected-paths.ts` loader reads
  the optional rule file (one glob per line, `#` comments, P10 supported
  subset) and feeds it into `TASK_WRITES_PROTECTED_PATH` lint emission.
  When the file is **absent**, the hardcoded `PROTECTED_PATHS` constant
  in `src/core/glob.ts` remains the fallback — v1.5 behaviour is
  preserved. When the file is **present but contains zero valid
  entries**, the list is treated as explicit "no protected paths" (the
  loader does NOT silently revert to defaults; delete the file instead).
  Malformed entries (unsafe paths, glob syntax outside the P10 subset)
  are silently skipped. `synthesizeSample` is promoted from a private
  helper in `glob.ts` to a named export so the loader can attach
  concrete samples to its entries (consumed by the overlap heuristic).
  Both `findProtectedPathOverlaps` and `detectTaskWritesProtectedPath`
  accept an optional `protectedPaths` parameter; omitting it preserves
  the v1.5 behaviour. The code-pact dogfood corpus now ships
  `design/rules/protected-paths.md` mirroring the defaults — the
  effective lint behaviour is unchanged.

### Changed

- **`docs/cli-contract.md`** documents the new `write_audit` field, the
  `--base-ref` flag, the new warning codes, the `--audit-strict` gate,
  and the `plan brief` / `plan constitution` non-interactive trifecta
  per command. The field-presence-by-kind table for `task finalize`
  now lists `write_audit` as additive optional.
- **`design/roadmap.yaml`** registers P15 (Declared Writes Audit,
  weight 25) and P17 (Non-interactive Authoring, weight 20).
- **`design/phases/P15-declared-writes-audit.yaml`** new phase YAML
  covering T1 through T6 (T1–T4 + T6 done, T5 deferred to v1.7+).
- **`design/phases/P17-non-interactive-authoring.yaml`** new phase
  YAML covering T1–T5 (all done; phase status: done).
- **`docs/migration.md`** v1.5.x → v1.6.0 section documents the
  additive surface and the migration story for both feature areas.
- **`docs/dogfood.md`** gains a non-interactive `plan brief` /
  `plan constitution` walkthrough and updates `BRIEF_MISSING` /
  `CONSTITUTION_PLACEHOLDER` warning rows with v1.6+ resolution
  paths.
- **`docs/getting-started.md`** Path 2 (Manual) TTY-only callout is
  rewritten as a fully-scripted v1.6+ CI bootstrap example.

### Deferred to v1.7+

- **P15-T5 — `phase reconcile --json` write_audit exposure.** The
  "diff attribution across multiple tasks" problem (a single
  working-tree diff cannot be sharded across tasks deterministically)
  needs its own semantics RFC. The use case overlaps with running
  `task finalize --audit-strict` per task — the marginal value of a
  phase-level audit beyond per-task strictness is unclear. P15 phase
  status stays `in_progress` until this ships or is explicitly
  closed.

### Compatibility

- Default invocations of every existing command are byte-identical
  to v1.5.1. Human-mode `task finalize` does not spawn git, does not
  compute the audit, and produces the same stdout / stderr it did
  in v1.5.1.
- The TTY wizards for `plan brief` and `plan constitution` are
  unchanged. Non-TTY environments without one of the new flags
  continue to return `CONFIG_ERROR` exactly as in v1.5.1 (the
  guidance message now lists the three v1.6+ alternatives, but
  the contract is preserved).
- `KNOWN_CODES.public` extension is additive: one new code
  (`WRITES_AUDIT_STRICT_FAILED`). `KNOWN_CODES.plan` gains three
  new advisory warning codes
  (`TASK_WRITES_AUDIT_OUTSIDE_DECLARED`,
  `TASK_WRITES_AUDIT_DECLARED_UNUSED`, `TASK_WRITES_OVER_BROAD`).
  Every existing code is unchanged.
- JSON envelope shapes are unchanged except for additive optional
  fields (`task finalize` gains `data.write_audit`; failure
  envelopes for new modes carry `data.detail` and either `data.path`
  or `data.source`).

---

## [1.5.1] — 2026-05-21

**Cleanup patch.** Conservative maintenance release: no new public commands,
flags, error codes, or JSON envelope fields.

### Changed

- Enabled unused TypeScript symbol checks in `tsconfig.json` and removed the
  current unused import/helper noise.
- `Roadmap.PhaseRef.path` now accepts only safe project-relative
  `design/phases/*.yaml` paths.
- `verify.commands` now executes documented shell command strings, preserving
  quoted arguments while keeping stdout/stderr captured and bounded.
- CI now runs the full gate on Node 22 and a compatibility smoke path on Node
  24. Unit and integration tests are split, and integration tests consume one
  prebuilt `dist/cli.js` instead of rebuilding inside multiple suites.
- The dogfood corpus is strict-clean for
  `plan lint --include-quality --strict`; stale historical protected-path
  declarations were removed from completed meta-design tasks.
- Docs now distinguish unlocked `progress.yaml` appends from locked design
  mutations, describe `pack` as a low-level stable command with `task context`
  preferred, and clarify that `verify.commands` is trusted local project
  configuration.
- **`package.json`** — version `1.5.0` → `1.5.1`. (this release prep)

---

## [1.5.0] — 2026-05-21

**Governance.** Minor release that closes the "who can write what, and when" question that v1.4 left implicit. Single deliberately small surface: one new public error code (`LOCK_HELD`), one creation-time reservation (`TUTORIAL`), one pure refactor (resolver core), and three docs-only governance decisions (protected-path strict-mode posture, declared writes as a review surface, phase status manual-flip convention). No new commands. No new schema fields. No behavioural changes to existing Stable commands on the success path.

Concurrent design-mutating invocations against the same project now fail fast with `LOCK_HELD` (exit 2) carrying a diagnostic struct (`pid`, `hostname`, `cmd`, `created_at`, lock file path). `phase add --id TUTORIAL` / `phase new` typing `TUTORIAL` / `phase import` containing a TUTORIAL entry now raise `CONFIG_ERROR` (exit 2) at creation time — `init --sample-phase` is the only sanctioned path for the reserved id. Existing v1.4.x projects with a TUTORIAL phase are untouched; the block only fires on new creation.

### CLI behavior changes

The existing Stable surface is unchanged on the success path. The new failure modes are transient + targeted:

- Design-mutating commands (`init --sample-phase`, `init` wizard, `phase add`, `phase new`, `phase import`, `task add`, `task finalize --write`, `phase reconcile --write`) may now return `LOCK_HELD` (exit 2) under concurrent invocation. Single-process users see no change.
- `phase add --id TUTORIAL` / `phase new` wizard typing `TUTORIAL` / `phase import` containing a `TUTORIAL` entry → `CONFIG_ERROR` (exit 2). Reuses the existing error code; no new code for this path.

`tests/integration/json-stdout.test.ts` continues to pass for every Stable command; new entries added for the LOCK_HELD envelope and TUTORIAL reserved-id CONFIG_ERROR paths. `tests/unit/error-code-surface.test.ts` grows by exactly **one** entry (`LOCK_HELD`).

### Added

- **`LOCK_HELD`** as a new public error code (`tests/unit/error-code-surface.test.ts` KNOWN_CODES.public). The envelope is `{ ok: false, error: { code: "LOCK_HELD", message }, data: { lock_holder: { pid, hostname, cmd, created_at } | null, lock_path: string } }`. The single addition to the v1.5 public surface lock. ([#122])
- **`src/core/locks/write-lock.ts`** — new module exposing `acquireWriteLock(cwd, cmd): Promise<LockHandle>` and `isLockHeldError` type guard. Atomic exclusive create via `fs.writeFile(..., { flag: "wx" })` (cross-platform safe; no POSIX flock dependency, no new runtime package). Lock content is JSON `{pid, hostname, cmd, created_at}`. On EEXIST throws `LockHeldError` with `.code === "LOCK_HELD"`, `.lock_holder` (or `null` for corrupt lock files), and `.lock_path`. Test escape: `CODE_PACT_DISABLE_LOCKS=1` short-circuits to a no-op handle — undocumented in public surfaces (test-only). ([#122])
- **`withWriteLock` helper in `src/cli.ts`** — wraps the seven design-mutating CLI handlers. Acquires the lock at the CLI command-handler level (not inside `createPhase` or other core services). `phase import` holds a single outer lock around its multi-phase apply loop (batch transactionality — every `createPhase` call inside runs under the same acquisition). `task finalize` and `phase reconcile` dry-runs do NOT acquire the lock; only `--write` invocations do. Read-only commands (`plan lint`, `plan analyze`, `task runbook`, `phase runbook`, `validate`, `doctor`, `recommend`, `task context`, `task status`) never acquire the lock and can be used to observe state while a mutation is pending. ([#122])
- **`tests/setup.ts` + `vitest.config.ts setupFiles`** — sets `process.env.CODE_PACT_DISABLE_LOCKS = "1"` for the bulk of the suite so unrelated tests don't accidentally acquire real locks. Lock-specific tests (`tests/unit/core/locks/write-lock.test.ts`, the LOCK_HELD integration entry in `tests/integration/json-stdout.test.ts`) delete the env var in `beforeEach` to exercise the real acquisition path. ([#122])
- **`RESERVED_PHASE_IDS = ["TUTORIAL"]` in `src/core/services/createPhase.ts`** + internal-only `_isSampleCreation?: boolean` bypass flag. `writeSamplePhase()` in `src/commands/init.ts` is the single sanctioned call site that may pass the flag. Every other caller (`phase add` flag-based / wizard, `phase new` wizard, `phase import`) is rejected with `CONFIG_ERROR` (exit 2) before any file write. ([#121])
- **`phase import` reserved-id preflight scan** in `src/commands/phase-import.ts` — runs BEFORE any `createPhase` call. If any input phase entry has `id: TUTORIAL` (in any position of the input file), the entire import is rejected with `CONFIG_ERROR` and the roadmap stays byte-identical. `--force` does NOT bypass this; reserved ids are reserved at the governance layer, not the collision-handling layer. ([#121])
- **`src/core/plan/resolve-task.ts`** — new module exposing `resolveTaskInRoadmap(cwd, taskId)` (I/O variant) and `resolveTaskInPlanState(state, taskId)` (pure variant for callers with PlanState already loaded). Consolidates the eight duplicated `resolveTaskPhase` implementations across the task-* commands (P12 RFC § Non-goals explicitly deferred this to P14). Pure refactor — every per-command unit test passes unchanged. ([#123])
- **`design/decisions/governance-rfc.md`** — the accepted RFC capturing the four governance decisions, the LOCK_HELD lock model, the reserved-id policy with the `_isSampleCreation` bypass + `phase import` preflight design, the resolver-extraction shape, the protected-path strict-mode posture, the declared-writes review-surface contract, the roadmap mutation policy matrix, the phase-status manual-flip convention, the alternatives considered, and the eight P15+ deferral items. ([#117], [#118])
- **`design/phases/P14-governance.yaml`** — phase contract registering the work. ([#117])
- **`docs/concepts/governance.md`** — new concept doc mirroring the shape of the runbook / finalization-reconciliation / task-readiness-fields / sample-phase docs. Walks through the four shipped pillars + two docs-only pillars, includes the full LOCK_HELD envelope shape, the lock acquisition matrix, the reserved-id block matrix, the error/diagnostic taxonomy, and an explicit "what's intentionally NOT in v1.5" boundary list. ([#124])
- **§ Roadmap mutation policy (v1.5+ / P14) in `docs/cli-contract.md`** — names the four `createPhase` callers as the only roadmap writers, the non-writers (task lifecycle commands), and the structural-chokepoint statement. § Reserved phase ids (v1.5+ / P14) adds the block matrix. § Advisory write lock (v1.5+ / P14) carries the full LOCK_HELD envelope, the acquisition-point matrix, the stale-lock recovery playbook, and the relationship to atomic-text. ([#121], [#122])
- **`tests/unit/core/locks/write-lock.test.ts`** (9 unit tests) — lock file JSON shape, release, idempotent acquire/release/acquire, EEXIST → LOCK_HELD with full holder, corrupt lock file → `lock_holder: null` + adjusted message, `.code-pact/locks/` created on demand, `CODE_PACT_DISABLE_LOCKS=1` short-circuit, defensive env-value checks, `isLockHeldError` correctness. ([#122])
- **`tests/unit/core/services/createPhase.test.ts` reserved-id block tests** (4 new) — reject when `_isSampleCreation` is omitted (roadmap byte-identical), reject when explicitly `false`, allow when `true`, error message contract (names id + points at `init --sample-phase`). ([#121])
- **`tests/unit/core/plan/resolve-task.test.ts`** (8 new tests) — I/O variant single match / not-found / ambiguous with full `.phases` array / correct phase among many / ENOENT on missing roadmap; PlanState variant single match / not-found / **ambiguity detection where `state.taskIndex` silently returns the first match** (the load-bearing reason the pure variant exists). ([#123])
- **`tests/integration/json-stdout.test.ts` LOCK_HELD + TUTORIAL CONFIG_ERROR entries** (3 new) — `phase add --id TUTORIAL --json` returns CONFIG_ERROR envelope with roadmap byte-identical; `phase import` containing a TUTORIAL entry returns CONFIG_ERROR via preflight with roadmap byte-identical and zero phase YAML files written; `phase reconcile --write --json` against a pre-seeded stale lock returns the LOCK_HELD envelope with data.lock_holder + data.lock_path, AND read-only `validate --json` on the same project succeeds (locks do not block reads). ([#121], [#122])

### Changed

- **`tests/unit/error-code-surface.test.ts` KNOWN_CODES.public** — added `LOCK_HELD: "public"`. The public surface lock contract grows by exactly **one** entry in v1.5. ([#122])
- **`src/commands/task-context.ts`, `task-start.ts`, `task-block.ts`, `task-resume.ts`, `task-complete.ts`, `task-status.ts`, `task-finalize.ts`, `task-runbook.ts`** — all eight private `resolveTaskPhase` implementations removed and replaced with calls to the new `src/core/plan/resolve-task.ts` helpers. `task-finalize.ts` aliases `phasePath` → `file` at the destructuring site to preserve the public `data.file` field. `task-runbook.ts`'s manual ambiguity rescan + `state.taskIndex.get(...)` + internal-invariant guard collapse into a single `resolveTaskInPlanState` call. Pure refactor — `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` emitted identically (same message text, same `.phases` array shape). ([#123])
- **`src/cli.ts`** — adds `withWriteLock` helper and wires it into seven design-mutating handlers. `cmdInit` acquires the lock when `--sample-phase` is set (non-wizard) OR in wizard mode, **but only when `.code-pact/` already exists**. Fresh init bootstraps the directory tree, and acquiring the lock helper's `mkdir -p .code-pact/locks/` would create `.code-pact/` as a side effect and trip the `ALREADY_INITIALIZED` guard. The `codePactDirExists()` gate (added during P14-T8 release-prep validation when the issue surfaced) is the correct fix: fresh init has no possible concurrent code-pact mutation to defend against (no project exists yet), so skipping the lock is semantically correct. Re-init (with `--force` on an existing project) still acquires the lock. `cmdPhase` "add" / "new" / "import" each acquire around their respective `runX` call; "import" holds a single outer lock around the multi-phase apply loop. `cmdTaskAdd` acquires around `runTaskAdd` (covers both wizard and non-interactive). `cmdTaskFinalize` / `cmdPhaseReconcile` acquire only when `--write`. `cmdPhase` "add" + "new" branches also gain `CONFIG_ERROR` catches so the P14-T4 reserved-id block surfaces correctly through the JSON envelope. (this release prep, [#121], [#122])
- **`src/core/services/createPhase.ts`** — exports `RESERVED_PHASE_IDS` and adds the internal-only `_isSampleCreation?: boolean` field on `CreatePhaseInput`. Validation against the reserved list runs before any disk read, so the roadmap stays byte-identical on rejection. ([#121])
- **`src/commands/init.ts`** — `writeSamplePhase()` passes `_isSampleCreation: true` to `createPhase`. The single sanctioned bypass for the reserved `TUTORIAL` id. ([#121])
- **`src/commands/phase-import.ts`** — adds the reserved-id preflight scan documented above. ([#121])
- **`docs/cli-contract.md`** — Public codes table gains the `LOCK_HELD` row. § State file write guarantees → Files written by code-pact: writer columns on `design/roadmap.yaml` and `design/phases/*.yaml` rows now name every writer. § Concurrent writers rewritten — was "not supported" in v1.0; now describes detection via `LOCK_HELD` + lists read-only commands that DON'T acquire the lock. New § Advisory write lock (v1.5+ / P14), § Roadmap mutation policy (v1.5+ / P14), § Reserved phase ids (v1.5+ / P14), § Phase status manual-flip convention. § `phase import` validation pass: reserved-id preflight is step 2 (between schema validation and duplicate-id check). § Plan diagnostic codes documents `--strict` semantics for `TASK_WRITES_PROTECTED_PATH`. ([#119], [#121], [#122])
- **`docs/migration.md`** — new § v1.4.x → v1.5.0 covering shipped surface, recommended adoption per context (single-process / multi-process / CI-strict / TUTORIAL-add / release-prep), stale lock manual recovery, KNOWN_CODES.public growth, and the full backward-compatibility list. § "Deferred beyond v1.4" renamed to § "Deferred beyond v1.5" with closed-in-v1.5 items struck through (advisory locks / TUTORIAL hard reservation / roadmap mutation policy docs / phase status formalization / resolver core extraction). Remaining deferrals reorganized around v1.5's framing. ([#124])
- **`docs/dogfood.md`** — § Troubleshooting gains `LOCK_HELD` and `CONFIG_ERROR from phase add --id TUTORIAL / phase import containing TUTORIAL` entries. v1.5.0 documented non-strict release-prep lint for the then-current dogfood corpus; v1.5.1 supersedes that with strict-clean dogfood guidance. ([#119], [#124])
- **`docs/getting-started.md`** — new § Concurrent processes (v1.5+) introduces LOCK_HELD as a transient failure with the envelope shape and pointer to the dogfood troubleshooting entry + governance concept doc. Next-reading list gains the governance concept doc. Migration link description updated to "v0.6 – v0.9 up through v1.5.0". ([#124])
- **`docs/concepts/sample-phase.md`** — new § "TUTORIAL is a reserved phase id (v1.5+ / P14)" replaces the previous "(Hard reservation of the `TUTORIAL` id is P14 governance scope)" forward-looking note. § "What the sample phase is not" updated: the v1.5 block protects the **id**, not the phase data. Next-reading list gains the governance concept doc. ([#124])
- **`docs/concepts/finalization-reconciliation.md`** — § Phase status remains manual in v1.2 renamed to "formalized as the convention in v1.5+ / P14" and cites the governance RFC. Release-prep loop step 3 marks the manual flip as "manual by convention" with RFC link; step 4 links to the new roadmap mutation policy section. § Declared writes as a governance review surface (v1.4+ / P14) added in P14-T3. ([#120], [#121])
- **`docs/concepts/runbook.md`** — § Declared writes as a governance review surface (v1.4+ / P14) added in P14-T3. ([#120])
- **`design/phases/P14-governance.yaml`** — phase `status: planned` → `status: done`; every P14 task (T1–T8) `status: planned` → `status: done`. **The T1–T7 task-level flips were performed by `code-pact phase reconcile P14 --write` itself** — the **fourth consecutive** release prep PR to dogfood the P11 mechanization. T8 (this release-prep task) was flipped via `task finalize P14-T8 --write` after `task complete P14-T8`, completing the per-task loop on the task that performed the release prep (per the P13-T6 pattern). The phase's own `status` field was flipped by hand per the v1.2 contract — now formalized in v1.5 as the release-prep convention. ([#121], [#122], [#123], [#124], this release prep)
- **`package.json`** — version `1.4.0` → `1.5.0`. (this release prep)

### Dogfood log

A complete end-to-end exercise of every new v1.5.0 governance flag / failure mode was captured in a fresh tmp project before this release prep PR was committed. The full log is in the PR description; verbatim summary:

```
=== STEP 1: init --non-interactive --sample-phase ===
created files: 12 incl. design/phases/TUTORIAL-walkthrough.yaml

=== STEP 2: phase add --id TUTORIAL (P14-T4 reserved-id block) ===
ok: False | code: CONFIG_ERROR | exit: 2
message contains "TUTORIAL" and "init --sample-phase": True
roadmap byte-identical before/after: True

=== STEP 3: phase import containing TUTORIAL (P14-T4 preflight) ===
ok: False | code: CONFIG_ERROR | exit: 2
roadmap byte-identical: True
phase YAML files written: 0  (preflight rejects entire input)

=== STEP 4: concurrent task finalize --write (P14-T5 LOCK_HELD) ===
process A: ok: True | task finalize succeeded
process B (with seeded stale lock): ok: False | code: LOCK_HELD | exit: 2
data.lock_holder.cmd matches A's command: True
data.lock_holder.pid is numeric: True
data.lock_path ends with .code-pact/locks/write.lock: True

=== STEP 5: read-only commands during held lock ===
validate --json:    ok: True (no lock acquired)
task status --json: ok: True (no lock acquired)
plan lint --json:   ok: True (no lock acquired)

=== STEP 6: resolver refactor invisible (P14-T6) ===
task context BOGUS-ID:  exit 2 | TASK_NOT_FOUND  (envelope unchanged)
task start BOGUS-ID:    exit 2 | TASK_NOT_FOUND  (envelope unchanged)
task complete BOGUS-ID: exit 2 | TASK_NOT_FOUND  (envelope unchanged)
```

### Known residuals (not blockers)

- **`TASK_WRITES_PROTECTED_PATH` advisories on the dogfood corpus.** Existing advisories remained in v1.5.0 (P10-T1, P10-T6, P11-T1, P14-T1 declaring writes against `design/roadmap.yaml` and `design/phases/*.yaml`). v1.5.1 removes those stale historical declarations so the dogfood corpus is strict-clean. Actual write enforcement against declared `writes` remains a P15+ candidate (requires runner or VCS integration).
- **Stale lock recovery is manual.** v1.5 ships the advisory lock without automatic stale-lock detection. If a `code-pact` process crashes mid-lock (SIGKILL, OS reboot), the user manually deletes `.code-pact/locks/write.lock` after verifying no process holds it. PID liveness checks + `--force-lock` are P15+ candidates.
- **Configurable protected paths / configurable reserved-id list / RESERVED_ID_USAGE lint on existing TUTORIAL phases / selective per-code `--strict` promotion / progress.yaml write locks** — all remain future work. See `docs/migration.md` § Deferred beyond v1.5 for the full list.
- **`STATUS_DRIFT done-but-design-not-done` warnings** on the dogfood corpus continue to fire for any task whose progress.yaml has a `done` event but whose design status was not yet flipped. This release prep clears every P14 warning that had accumulated across the P14 task PRs into a single coherent reconcile flip (for T1–T7) + a single finalize call (for T8, the release-prep task itself) — **the fourth consecutive release prep where the post-reconcile drift count drops to zero via mechanization**.

[#117]: https://github.com/toshtag/code-pact/pull/117
[#118]: https://github.com/toshtag/code-pact/pull/118
[#119]: https://github.com/toshtag/code-pact/pull/119
[#120]: https://github.com/toshtag/code-pact/pull/120
[#121]: https://github.com/toshtag/code-pact/pull/121
[#122]: https://github.com/toshtag/code-pact/pull/122
[#123]: https://github.com/toshtag/code-pact/pull/123
[#124]: https://github.com/toshtag/code-pact/pull/124

---

## [1.4.0] — 2026-05-21

**Planning UX and init hardening.** Minor release that closes four small frictions in the planning / init / task-creation surface that P9 and P12 explicitly deferred. Every change is additive on the CLI contract — no new commands, no new error codes, no new schema fields, no behavioural changes to `task complete` / `task finalize` / `phase reconcile` / `task runbook` / `phase runbook`.

The sample-phase artifact `init` produces is renamed from `P1-welcome.yaml` (id `P1`, no tasks) to `TUTORIAL-walkthrough.yaml` (id `TUTORIAL`, two tutorial tasks with `TUTORIAL-T2 depends_on: [TUTORIAL-T1]`). A single bootstrap now demos P10 (`depends_on`) + P11 (`task finalize` / `phase reconcile`) + P12 (`task runbook` blocking step) end-to-end. Existing projects with a pre-v1.4 `P1-welcome.yaml` are untouched — the rename only affects NEW `init` runs.

### CLI behavior changes

None for the existing Stable surface. Stable command flags, JSON envelope shape, exit-code semantics, and the existing error-code surface remain unchanged from v1.3.0. The `tests/integration/json-stdout.test.ts` and `tests/unit/error-code-surface.test.ts` regression nets continue to pass; new test entries are additive.

The wizard mode of `init` is unchanged — the default-yes prompt for sample-phase creation still fires for TTY users.

### Added

- **`init --sample-phase`** as Stable (v1.4+). Explicit opt-in flag. In non-interactive mode, enables sample-phase creation (previously wizard-only). In TTY wizard mode, skips the existing "create sample phase?" prompt and forces creation. Makes `init --non-interactive --locale <l> --agent <a> --sample-phase` a single-command scripted bootstrap that produces a complete tutorial artifact ready for the per-task loop. ([#112])
- **`task add` non-interactive flag set** as Stable (v1.4+) (`src/commands/task-add.ts`). Presence of `--description` triggers the flag-driven path; `--type` is required in that mode. Six readiness fields (`--ambiguity` / `--risk` / `--context-size` / `--write-surface` / `--verification-strength` / `--expected-duration`) accept enum values; five P10 fields (`--depends-on` / `--decision-ref` / `--read` / `--write` / `--acceptance-ref`) are repeatable. `--status` is **intentionally not exposed** — newly added tasks are always `status: planned`; historical / migrated tasks use `phase import`, preserving the P11/P12 contract that design `done` is the result of `task finalize` / `phase reconcile`, not a starting point. Partial flags (non-interactive flag without `--description`) raise `CONFIG_ERROR` rather than silently entering the wizard or silently ignoring flags. The wizard path is unchanged. ([#113])
- **`suggested_next_steps: string[]`** as an additive sibling field on `plan prompt --json` and as an additive top-level field on `phase import --json`. Always present (field-presence-fixed per the P12 RunbookStep convention). `plan prompt` emits the canonical 4-step AI-assisted planning flow (prompt → import → lint → phase runbook) with an optional leading brief/constitution-capture hint when either file is missing. `phase import` emits the post-import sequence (lint → phase runbook per imported phase → task runbook on first task) with an optional leading defaults-review hint when `completed_fields[]` is non-empty. The whole array is empty when nothing was imported. ([#114])
- **Sample-phase artifact rewrite**. The `writeSamplePhase()` helper in `src/commands/init.ts` now produces `id: TUTORIAL`, `name: Walkthrough`, with two minimal tutorial tasks. `TUTORIAL-T1` is a feature with no dependencies; `TUTORIAL-T2` is a docs task with `depends_on: [TUTORIAL-T1]` so the tutorial demos `task runbook TUTORIAL-T2 --json` returning a blocking dependency step until `TUTORIAL-T1` is complete. The phase's `objective` text embeds the "Tutorial-only — delete before treating design/ as your source-of-truth" warning since YAML schema forbids comments inside zod-parsed values. The `runPhaseAdd` wrapper does not forward `tasks`, so `writeSamplePhase` was rewritten to call the `createPhase` core service directly. ([#112])
- **`design/decisions/planning-ux-init-hardening-rfc.md`** — the accepted RFC capturing the four UX gaps, proposed changes (with generation-policy table for `init --sample-phase` mode × flag, `task add` flag table + 3-branch partial-flags resolution), the "P14 governance" deferral list, and the P13-T1..T6 implementation slicing. ([#110], [#111])
- **`design/phases/P13-planning-ux-init-hardening.yaml`** — phase contract registering the work. ([#110])
- **`docs/concepts/sample-phase.md`** — rewritten in TUTORIAL terms. Documents both creation paths (wizard yes / `init --sample-phase`), the artifact content with `TUTORIAL-T2 depends_on: [TUTORIAL-T1]`, the three-purpose rationale (smoke-test + working template + tutorial/source-of-truth boundary), the keep/rename/delete decision tree, and explicit upgrade guidance ("existing P1-welcome.yaml is untouched"). ([#115])

### Changed

- **`docs/migration.md`** gains a `v1.3.x → v1.4.0` section with the quick path, what's new (the four additive changes), recommended adoption pattern (replace scripted-bootstrap workarounds with `init --non-interactive --sample-phase`; replace single-task `phase import` deltas with `task add --description --type`), CI implications under `--strict` (no new errors / warnings / codes), and backward-compatibility notes. "Deferred beyond v1.3" → "Deferred beyond v1.4" with the now-shipped P13 items removed and explicit `task add --status` / `--dry-run` / reserved-id hard enforcement / `plan brief` non-TTY deferrals rolled forward. ([#115])
- **`docs/cli-contract.md`** gains a `## task add` section annotated Stable (v0.6 wizard + v1.4+ non-interactive) with the mode-resolution table, full flag table, P10 validation responsibility note ("`task add` stores; `plan lint` validates"), JSON envelope shape, error codes, and four usage examples. The `plan prompt` and `phase import` sections gain a "v1.4+ additive field" subsection describing `suggested_next_steps`. ([#113], [#114])
- **`docs/getting-started.md`** — Path 1 (Tutorial) rewritten in TUTORIAL terms with the full per-task loop on TUTORIAL-T1 + TUTORIAL-T2, the dependency-blocking demo callout, and a v1.4+ CI / non-TTY callout pointing at the single-command scripted bootstrap. Path 2 (Manual) step 4 shows both the interactive `task add` and the new non-interactive `task add --description --type ...` side-by-side. ([#115])
- **`docs/dogfood.md`** — "Adding work" gains the non-interactive `task add` example and the `--status` policy note. New "Tutorial bootstrap (v1.4+)" subsection. ([#115])
- **`design/phases/P13-planning-ux-init-hardening.yaml`** — phase `status: planned` → `status: done`; every P13 task (T1–T6) `status: planned` → `status: done`. **The T1–T5 task-level flips were performed by `code-pact phase reconcile P13 --write` itself** — the third consecutive release prep PR to dogfood the P11 mechanization. T6 (this release-prep task) was flipped via `task finalize P13-T6 --write` after `task complete P13-T6`, completing the per-task loop on the task that performed the release prep. The phase's own `status` field was flipped by hand per the v1.2 contract. ([#113], [#114], [#115], this release prep)
- **`package.json`** — version `1.3.0` → `1.4.0`. (this release prep)

### Dogfood log

A complete end-to-end exercise of every new v1.4.0 flag was captured in a fresh tmp project before this release prep PR was committed. The full log is in the PR description; verbatim summary:

```
=== STEP 1: init --non-interactive --sample-phase ===
created files: 12
TUTORIAL files: ['design/phases/TUTORIAL-walkthrough.yaml']

=== STEP 2: phase show TUTORIAL ===
TUTORIAL-T1 (feature)
TUTORIAL-T2 (docs) depends_on=['TUTORIAL-T1']

=== STEP 3: task runbook TUTORIAL-T2 (P10 + P12 demo) ===
blocking head step: True
manual_action: Wait for TUTORIAL-T1 to reach derived state: done (currently: planned)

=== STEP 4: task add TUTORIAL --description --type --depends-on --read --json ===
ok: True | taskId: TUTORIAL-T3

=== STEP 5: task add TUTORIAL --type docs (no --description) ===
ok: False | code: CONFIG_ERROR

=== STEP 6: plan prompt --json (5 suggested_next_steps) ===
1. plan brief/constitution hint
2-5. AI flow (prompt → phase import → plan lint → phase runbook)

=== STEP 7: phase import --json (4 suggested_next_steps) ===
1. completed_fields review hint
2. plan lint
3. phase runbook P1
4. task runbook P1-T1
completed_fields: 1
```

### Known residuals (not blockers)

- **`TASK_WRITES_PROTECTED_PATH` advisories on the dogfood corpus.** Existing advisories remain (P10-T1, P10-T6, P11-T1 declaring writes against `design/roadmap.yaml` and `design/phases/*.yaml`). P14 governance is the consumer that promotes to error severity with a configurable policy.
- **`task add --status`, `task add --dry-run`, reserved-id (`TUTORIAL`) hard enforcement, `plan brief` / `plan constitution` non-TTY alternatives, multi-phase reconcile / runbook (`--all`), runbook execution (`task runbook --execute`), schema-level `human_gate`, `task next` / `phase next` aliases, bundling `recommend` into `task runbook`, runbook orchestrator (`task run` / `phase close`)** — all remain future work. See `docs/migration.md` § Deferred beyond v1.4 for the full list.
- **`STATUS_DRIFT done-but-design-not-done` warnings** on the dogfood corpus continue to fire for any task whose progress.yaml has a `done` event but whose design status was not yet flipped. This release prep clears every P13 warning that had accumulated across the P13 task PRs into a single coherent reconcile flip (for T1-T5) + a single finalize call (for T6, the release-prep task itself) — the third consecutive release prep where the post-reconcile drift count drops to zero via mechanization.

[#110]: https://github.com/toshtag/code-pact/pull/110
[#111]: https://github.com/toshtag/code-pact/pull/111
[#112]: https://github.com/toshtag/code-pact/pull/112
[#113]: https://github.com/toshtag/code-pact/pull/113
[#114]: https://github.com/toshtag/code-pact/pull/114
[#115]: https://github.com/toshtag/code-pact/pull/115

---

## [1.3.0] — 2026-05-20

**Lightweight Runbook.** Minor release that introduces two new read-only commands for answering the user-facing question "what should I run next?" deterministically. `task runbook <task-id>` returns the recommended sequence of next steps for a single task; `phase runbook <phase-id>` does the same for an entire phase with a 6-priority step list, task/drift histograms, and a phase status candidate. Neither command mutates anything; neither calls an adapter; neither takes a `--write` / `--execute` / `--agent` flag. Every recommended step is a CLI invocation the user runs separately, or a `manual_action` describing a human checkpoint.

### CLI behavior changes

None for the existing Stable surface. Stable command flags, JSON envelope shape, exit-code semantics, and the existing error-code surface remain unchanged from v1.2.0. The `tests/integration/json-stdout.test.ts` and `tests/unit/error-code-surface.test.ts` regression nets continue to pass; the two new commands are additive entries with no new error codes.

### Added

- **`task runbook <task-id> [--json]`** as Stable (v1.3+) (`src/commands/task-runbook.ts`). Returns `{ ok: true, data: { kind: "runbook", task_id, phase_id, state_summary, next_steps: RunbookStep[] } }`. Maps `(derived state, design status, drift kind)` → recommended steps using the lifecycle table from the RFC. `task start` is part of the primary loop for `planned + no events` tasks. `depends_on` emits a blocking dependency-check step at the head when any dep is unsatisfied. No new error codes — reuses `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` / `CONFIG_ERROR`. ([#106])
- **`phase runbook <phase-id> [--json]`** as Stable (v1.3+) (`src/commands/phase-runbook.ts`). Bulk counterpart. Returns the same envelope kind with `phase_summary` (task histogram + drift histogram + `phase_status_candidate` + advisory note) and a 6-priority step list (blocked → manual_review → reconcile batch → in-progress hints → primary loop → phase-status advisory). Reuses `PHASE_NOT_FOUND` / `CONFIG_ERROR`. ([#107])
- **`src/core/runbook/`** — new neutral module owning the pure-function runbook builders. `types.ts` defines the field-presence-fixed `RunbookStep` shape with `assertStepInvariant` (exactly-one-of command/manual_action enforced at construction time). `depends-on.ts` extracts the inline `depends_on` resolution pattern from `task-finalize.ts` into a shared helper. `build-task-runbook.ts` and `build-phase-runbook.ts` are pure functions — commands pass already-loaded `PlanState` / progress events. No I/O in the core helpers. ([#105])
- **`src/core/finalize/reconcile-classifier.ts`** — the reconcile classifier previously private inside `src/commands/phase-reconcile.ts` is extracted into a core module in P11's `src/core/finalize/` namespace. Both `phase-reconcile.ts` and the new `src/core/runbook/build-phase-runbook.ts` import from the core helper. Preserves the `command → core` dependency direction. Pure refactor — existing `tests/unit/commands/phase-reconcile.test.ts` passes unchanged. ([#105])
- **`classifyTaskDrift` export** from `src/core/plan/analyze.ts`. The function was private; runbook needs it to label tasks with their drift kind. Same-module export — analyze.ts is already core layer, so no layering inversion. ([#105])
- **`design/decisions/lightweight-runbook-rfc.md`** — the accepted RFC capturing command semantics, runbook step shape, state-based recommendation rules, the explicit `recommend` vs `task runbook` boundary, layering decisions (classifier extraction, no `--agent` flag on runbook), the `human_gate` deferral to P13/P14, the init/UX polish deferral to P13, alternatives considered (executable runbook, `task next` alias, classifier export from command file, etc.), open questions, and the P12-T1..T5 implementation slicing. ([#103], [#104])
- **`design/phases/P12-lightweight-runbook.yaml`** — phase contract registering the work. ([#103])
- **`docs/concepts/runbook.md`** — agent- and reviewer-facing walkthrough mirroring `docs/concepts/finalization-reconciliation.md`. Covers why runbook exists, the explicit boundary against `recommend` / `task context` / `phase reconcile`, full state → steps mapping table, 6-priority order for phase runbook, RunbookStep field invariants, P10/P11 integration, error codes (none new), what's intentionally NOT in v1.3 (`--execute`, `task next` alias, `human_gate` schema field, `--all`, init UX polish). ([#108])

### Changed

- **`docs/migration.md`** gains a `v1.2.x → v1.3.0` section covering the quick path, what's new (both runbook commands, field-presence-fixed shape, the internal classifier extraction), recommended adoption pattern (use `task runbook` after `plan analyze` flags drift; use `phase runbook` as a sanity check before release-prep `phase reconcile --write`), CI implications under `--strict` (no new errors, no new warnings, KNOWN_CODES.public unchanged), and backward-compatibility notes. "Deferred beyond v1.2" → "Deferred beyond v1.3" with the now-shipped runbook commands removed and the previously-deferred init/UX polish item rolled forward to P13. ([#108])
- **`docs/cli-contract.md`** gains a `task runbook` section + a `phase runbook` section (both annotated Stable (v1.3+)) with full JSON envelope shape, RunbookStep field invariants table, state → steps mapping table, 6-priority order for phase runbook, error codes, usage examples, and the explicit `recommend` vs `task runbook` boundary statement. ([#106], [#107])
- **`docs/getting-started.md`** gains an optional step in the tutorial mentioning `task runbook` and `phase runbook` as read-only sequencing guidance, with a pointer to the concept walkthrough. ([#108])
- **`docs/dogfood.md`** gains a Step 7 in the per-task flow for `task runbook` / `phase runbook`; updates the v1.0 contract section to mention v1.3 read-only counterparts; updates the STATUS_DRIFT expected-warnings note to surface that runbook carries the same recommendation in lifecycle context; adds runbook as a v1.3+ alternative diagnostic step inside the existing `TASK_FINALIZE_NOT_ELIGIBLE` and `PHASE_RECONCILE_WRITE_REFUSED` Troubleshooting entries; section header renamed `(v1.0 / v1.2+)` → `(v1.0 / v1.2+ / v1.3+)`. ([#108])
- **`design/phases/P12-lightweight-runbook.yaml`** — phase `status: planned` → `status: done`; every P12 task (T1–T5) `status: planned` → `status: done`. **The task-level flip was performed by `code-pact phase reconcile P12 --write` itself**, after a sanity-check run of **`code-pact phase runbook P12 --json`** which returned exactly the two-step recommendation the release prep then followed (the reconcile batch + the manual phase-status flip). This is the second release-prep PR to dogfood the P11 mechanization, and the first one to dogfood the P12 read-only sanity-check layer alongside it. ([#105], [#106], [#107], [#108], this release prep)
- **`package.json`** — version `1.2.0` → `1.3.0`. (this release prep)

### Known residuals (not blockers)

- **`TASK_WRITES_PROTECTED_PATH` advisories on the dogfood corpus.** Existing advisories remain (P10-T1, P10-T6, P11-T1 declaring writes against `design/roadmap.yaml` and `design/phases/*.yaml`). These are proof the protected-path lint is working as designed; P14 governance is the consumer that promotes to error severity with a configurable policy.
- **Phase status auto-flip, multi-phase runbook (`--all`), `design/roadmap.yaml` mutation, file-content validation of `acceptance_refs`, actual-write enforcement of declared `writes`, runbook execution (`task runbook --execute`), schema-level `human_gate`, `task next` / `phase next` sugar aliases, bundling `recommend` into `task runbook`, init/wizard/task-add UX polish (P13 scope), runbook orchestrator integration** all remain future work. See `docs/migration.md` § Deferred beyond v1.3 for the full list.
- **`STATUS_DRIFT done-but-design-not-done` warnings** on the dogfood corpus continue to fire for any task whose progress.yaml has a `done` event but whose design status was not yet flipped. This release prep clears every P12 warning that had accumulated across the P12 task PRs into a single coherent reconcile flip — the second time a release prep has used `phase reconcile --write` to mechanize the step, and the first time `phase runbook` was used as the sanity check before it.

[#103]: https://github.com/toshtag/code-pact/pull/103
[#104]: https://github.com/toshtag/code-pact/pull/104
[#105]: https://github.com/toshtag/code-pact/pull/105
[#106]: https://github.com/toshtag/code-pact/pull/106
[#107]: https://github.com/toshtag/code-pact/pull/107
[#108]: https://github.com/toshtag/code-pact/pull/108

---

## [1.2.0] — 2026-05-20

**Finalization & Reconciliation.** Minor release that introduces two new commands for closing the long-standing drift between `progress.yaml` (operational fact) and `design/phases/*.yaml` (design intent). `task finalize <task-id>` flips one task's design status to `done` when its derived state from progress is already `done`; `phase reconcile <phase-id>` is the bulk counterpart. Both default to dry-run; `--write` is the explicit opt-in. Neither command mutates `progress.yaml`, neither writes to `design/roadmap.yaml`, and neither auto-flips the phase's own `status` field — phase status remains a manual release-prep step until P14 governance. The v1.0 contract that `task complete` records progress only and never mutates design YAML is preserved unchanged.

### CLI behavior changes

None for the existing Stable surface. Stable command flags, JSON envelope shape, exit-code semantics, and the existing error-code surface remain unchanged from v1.1.0. The `tests/integration/json-stdout.test.ts` and `tests/unit/error-code-surface.test.ts` regression nets continue to pass; the two new commands are additive entries.

### Added

- **`task finalize <task-id> [--write] [--json]`** as Stable (v1.2+) (`src/commands/task-finalize.ts`). Flips one task's design status to `done` only when `progress.yaml` already shows a `done` event for it. Defaults to dry-run; `--write` is the explicit opt-in. JSON envelope kinds: `would_finalize` / `finalized` / `already_finalized`. Ineligibility raises `TASK_FINALIZE_NOT_ELIGIBLE` (exit 2) in **both** dry-run and `--write` — dry-run means "won't write", not "won't validate". No `--agent` flag: finalize is a design/progress reconciliation command and never calls an adapter. ([#98])
- **`phase reconcile <phase-id> [--write] [--json]`** as Stable (v1.2+) (`src/commands/phase-reconcile.ts`). Bulk counterpart that walks every task in the phase, classifies each as `flip` / `skip` / `manual_review`, and (with `--write`) applies the flips in one shot. JSON envelope kinds: `would_reconcile` / `reconciled` / `no_eligible_tasks`. The `no_eligible_tasks` case is intentionally not an error code — nothing to flip is a normal outcome (exit 0). Partial successes return exit 0 with both `applied_writes[]` and `skipped_writes[]` populated; `PHASE_RECONCILE_WRITE_REFUSED` (exit 2) fires only when every eligible write was refused. Reports `phase_status_candidate` as advisory but never writes the phase's own `status` field. ([#99])
- **`src/core/finalize/`** — shared write-safety + dry-run diff helpers (`safe-write.ts`, `diff.ts`). Owns the load → mutate → atomic-write pattern, the dry-run diff shape (`{file, task_id, before, after}`), and the write-refusal classifier (`unsafe_path` / `outside_design_phases` / `not_yaml` / `symlink_escape` / `unreadable` / `unparseable_phase` / `task_not_found`). Imported by both new commands; namespace deliberately separate from `src/core/adapters/` (adapter-owned writes) and `src/io/` (raw write primitives). ([#97])
- **Three new public error codes** (additive in `KNOWN_CODES.public`): `TASK_FINALIZE_NOT_ELIGIBLE`, `TASK_FINALIZE_WRITE_REFUSED`, `PHASE_RECONCILE_WRITE_REFUSED`. Documented in `docs/cli-contract.md` § Public codes and locked by `tests/unit/error-code-surface.test.ts`. ([#98], [#99])
- **Additive `details.remediation` on `STATUS_DRIFT done-but-design-not-done`** issues emitted by `plan analyze`. Value is the literal string `"code-pact task finalize <task-id>"`. Only this drift kind carries the hint — the other four kinds (`done-blocked-conflict`, `done-with-incomplete-events`, `done-historical`, `in-progress-no-events`) need human judgement and stay unannotated. Additive on the `Record<string, unknown>` `details` payload; existing JSON consumers see no shape change. ([#100])
- **`design/decisions/finalization-reconciliation-rfc.md`** — the accepted RFC capturing command semantics, dry-run / write model, drift taxonomy strategy, safety model, P10 field integration scope, alternatives considered, and the P11-T1..T6 implementation slicing. ([#95], [#96])
- **`design/phases/P11-finalization-reconciliation.yaml`** — phase contract registering the work. ([#95])
- **`docs/concepts/finalization-reconciliation.md`** — agent- and reviewer-facing walkthrough mirroring `docs/concepts/task-readiness-fields.md`. Covers the drift these commands close, command surfaces with JSON envelope kinds, classification table, partial-success semantics, why phase status stays manual in v1.2, before/after release-prep loop, field reference, error code reference, what stays the same. ([#101])

### Changed

- **`docs/migration.md`** gains a `v1.1.x → v1.2.0` section covering the quick path, what's new, recommended adoption pattern (replace hand-edits in release prep with `phase reconcile --write`), CI implications under `--strict` (no new errors), the three new `KNOWN_CODES.public` entries, and backward-compatibility notes. "Deferred beyond v1.1" → "Deferred beyond v1.2" with the now-shipped `task finalize` / `phase reconcile` bullet removed. ([#101])
- **`docs/cli-contract.md`** gains a `task finalize` section + a `phase reconcile` section (both annotated Stable (v1.2+)) with full JSON envelope shape, field-presence-by-kind tables, error tables, and usage examples. The public-codes table is extended with the three new entries. The STATUS_DRIFT kinds table notes the additive `details.remediation` field for `done-but-design-not-done`. ([#98], [#99], [#100])
- **`docs/getting-started.md`** gains an optional Step 5 in the tutorial mentioning `task finalize <task-id> --write`, explicitly labelled as v1.2+ and opt-in, with a pointer to the concept walkthrough. ([#101])
- **`docs/dogfood.md`** gains a Step 6 in the per-task flow for `task finalize` / `phase reconcile`; updates the v1.0 contract section to mention v1.2 mechanization; updates the STATUS_DRIFT expected-warnings note to surface the new `details.remediation` field; adds three new Troubleshooting entries (`TASK_FINALIZE_NOT_ELIGIBLE`, `TASK_FINALIZE_WRITE_REFUSED`, `PHASE_RECONCILE_WRITE_REFUSED`) with per-reason recovery tables; section header renamed `(v1.0)` → `(v1.0 / v1.2+)`. ([#101])
- **`design/phases/P11-finalization-reconciliation.yaml`** — phase `status: planned` → `status: done`; every P11 task (T1–T6) `status: planned` → `status: done`. **The task-level flip was performed by `code-pact phase reconcile P11 --write` itself** — the first release-prep PR in the project's history to mechanize what was previously a hand-edit step in every release prep going back to v1.0.0. The phase's own `status` field was flipped by hand per the v1.2 contract (reconcile's `phase_status_candidate` reported `done`, the advisory was followed). ([#97], [#98], [#99], [#100], [#101], this release prep)
- **`package.json`** — version `1.1.0` → `1.2.0`. (this release prep)

### Known residuals (not blockers)

- **`phase reconcile --write` reflows long YAML lines.** The first `--write` against a phase file goes through `yaml.stringify()` and snaps the file to canonical line-wrap form. P11's RFC PR landed the phase YAML with hand-authored long lines; the reconcile write in this release prep normalizes them. The resulting file is what `plan normalize` considers canonical (`plan normalize --check` reports no further changes), so this is a one-time snap, not a recurring drift. Phase YAMLs written via `phase add` / `phase import` have always been canonical; future P-tasks won't see this reflow.
- **`TASK_WRITES_PROTECTED_PATH` advisories on the dogfood corpus.** Five intentional warnings remain (P10-T1, P10-T6, P11-T1 declaring writes against `design/roadmap.yaml` and `design/phases/*.yaml`). These are proof the protected-path lint is working as designed; P14 governance is the consumer that promotes to error severity with a configurable policy.
- **Phase status auto-flip, multi-phase reconcile, `design/roadmap.yaml` mutation, file-content validation of `acceptance_refs`, actual-write enforcement of declared `writes`, runbook integration (P12), cross-phase `depends_on`** all remain future work. See `docs/migration.md` § Deferred beyond v1.2 for the full list.
- **`STATUS_DRIFT done-but-design-not-done` warnings** on the dogfood corpus continue to fire for any task whose progress.yaml has a `done` event but whose design status was not yet flipped. This release prep clears every P11 warning that had accumulated across the P11 task PRs into a single coherent reconcile flip — the first time a release prep has cleared the drift without hand-editing.

[#95]: https://github.com/toshtag/code-pact/pull/95
[#96]: https://github.com/toshtag/code-pact/pull/96
[#97]: https://github.com/toshtag/code-pact/pull/97
[#98]: https://github.com/toshtag/code-pact/pull/98
[#99]: https://github.com/toshtag/code-pact/pull/99
[#100]: https://github.com/toshtag/code-pact/pull/100
[#101]: https://github.com/toshtag/code-pact/pull/101

---

## [1.1.0] — 2026-05-20

**Task Readiness Schema.** Minor release that introduces five additive optional fields on the task type (`depends_on`, `decision_refs`, `reads`, `writes`, `acceptance_refs`) so a task can declare its own context-pack targets, read / write surface, dependencies, and acceptance references. The change is strictly additive — every v1.0.x phase YAML continues to parse and behave identically.

### CLI behavior changes

None for tasks that declare none of the new fields. Stable command flags, JSON envelope shape, exit-code semantics, and the existing error-code surface remain unchanged from v1.0.2. The `tests/integration/json-stdout.test.ts` and `tests/unit/error-code-surface.test.ts` regression nets are unchanged at the envelope / existing-code level.

### Added

- **Five optional task fields** (`src/core/schemas/task.ts`): `depends_on` (same-phase task ids), `decision_refs` (paths surfaced into the pack), `reads` / `writes` (declared globs in a documented subset), `acceptance_refs` (paths to acceptance criteria). All `.optional()`; pre-v1.1 phase YAML parses unchanged. `phase import` lenient mode forwards them verbatim with no synthetic default. ([#89])
- **Twelve additive `plan` lint codes** validating the new fields when declared. All `TASK_*` prefixed: `TASK_DEPENDS_ON_UNRESOLVED`, `TASK_DEPENDS_ON_SELF_REFERENCE`, `TASK_DECISION_REF_NOT_FOUND`, `TASK_DECISION_REF_UNSAFE_PATH`, `TASK_READS_UNSAFE_PATH`, `TASK_READS_GLOB_INVALID`, `TASK_READS_NO_MATCH`, `TASK_WRITES_UNSAFE_PATH`, `TASK_WRITES_GLOB_INVALID`, `TASK_WRITES_PROTECTED_PATH`, `TASK_ACCEPTANCE_REF_NOT_FOUND`, `TASK_ACCEPTANCE_REF_UNSAFE_PATH`. Documented in `docs/cli-contract.md` § Plan diagnostic codes — Task Readiness Schema diagnostics; locked by `tests/unit/error-code-surface.test.ts`. ([#90])
- **Five new pack sections in `task context`**, rendered in stable order (Depends on → Declared read surface → Declared write surface → Declared decisions → Acceptance references) when the corresponding fields are declared. `decision_refs` content is surfaced regardless of `context_size`. ([#91])
- **`src/core/path-safety.ts`** — neutral module owning `assertSafeRelativePath` / `resolveWithinProject`, promoted from `src/core/adapters/file-state.ts`. The adapter file re-exports both symbols so existing call sites (`adapter-install`, `adapter-upgrade`, `adapter-file-state` tests) remain untouched. Plan lint, future P11 finalize, and future P14 governance import from the neutral module. ([#90])
- **`src/core/glob.ts`** — minimal in-repo glob matcher for the supported subset (literal segments, single-segment `*`, full-segment `**`). No external glob dependency added per the runtime-dependency policy in `CONTRIBUTING.md`. Exports `validateGlobSyntax`, `globToRegex`, `walkAndMatch`, `findProtectedPathOverlaps`, and the `PROTECTED_PATHS` seed set. ([#90])
- **Byte-identical pack regression test** (`tests/integration/pack-byte-identical.test.ts` + `tests/fixtures/golden/pack-v1.0.2-shaped.md`). Locks the contract that `task context` output is unchanged for v1.0.2-shaped tasks (those declaring none of the new fields). ([#91])
- **`design/decisions/task-readiness-schema-rfc.md`** — the accepted RFC capturing field semantics, validation rules, backward-compat contract, alternatives considered, open questions, and the P10-T1..T6 implementation slicing. ([#88])
- **`docs/concepts/task-readiness-fields.md`** — agent- and reviewer-facing walkthrough of the five fields with a full example phase YAML, per-field lint / pack / non-enforcement breakdown, recommended adoption pattern, and the explicit "intentionally not in this release" list. ([#92])
- **`design/phases/P10-task-readiness-schema.yaml`** — phase contract registering the work. ([#88])

### Changed

- **`docs/migration.md`** gains a `v1.0.x → v1.1.0` section covering the additive contract, one-command upgrade (`npm install` + `adapter upgrade --write`), the recommended adoption pattern (declare on new tasks first; retroactive backfill is explicitly discouraged), the supported glob subset, and the protected-path seed set. The previous "Deferred to v1.1+" section is renamed to "Deferred beyond v1.1" and refined to reflect what landed and what is still deferred (cross-phase `depends_on`, file-content inclusion for `reads`, ID-based references, `task finalize` / `phase reconcile`, hard enforcement of `writes`). ([#92])
- **`docs/cli-contract.md`** § `phase import` extends the task shape with the five new optional fields. The `task context` section gains a "P10 declared sections (v1.1+)" subsection documenting the five pack sections, stable order, decision_refs dedupe-with-Related-Decisions rule, and the byte-identical contract. ([#92])
- **`docs/getting-started.md`** gains an "Optional task readiness fields (v1.1+)" subsection with a short example YAML and pointers to the concept doc and the migration story. ([#92])
- **`design/phases/P10-task-readiness-schema.yaml`** — phase `status: planned` → `status: done`; every P10 task (T1–T6) `status: planned` → `status: done`. Also adopts the new fields itself per P10-T6 dogfood scope, which now produces three intentional `TASK_WRITES_PROTECTED_PATH` advisories (P10-T1 writes against `design/roadmap.yaml` + `design/phases/P10-task-readiness-schema.yaml`; P10-T6 writes against `design/phases/P10-task-readiness-schema.yaml`). These are proof the protected-path lint is working as designed; P14 governance will turn them into a configurable error. ([#93], this release prep)
- **`package.json`** — version `1.0.2` → `1.1.0`. (this release prep)

### Known residuals (not blockers)

- **`TASK_WRITES_PROTECTED_PATH` is advisory only.** Three intentional warnings on the dogfood corpus (see above). P14 governance is the consumer that promotes to error severity with a configurable policy.
- **Cross-phase `depends_on`, file-content inclusion for `reads`, ID-based references, `task finalize` / `phase reconcile`** all remain future work. See `docs/migration.md` § Deferred beyond v1.1 for the full list.
- **`STATUS_DRIFT done-but-design-not-done` warnings** on the dogfood corpus continue to fire for any task whose progress.yaml has a `done` event but whose design status was not yet flipped. This release prep flips every P10 task to `done`, clearing the five warnings that had accumulated across the P10 task PRs into a single coherent flip.

[#88]: https://github.com/toshtag/code-pact/pull/88
[#89]: https://github.com/toshtag/code-pact/pull/89
[#90]: https://github.com/toshtag/code-pact/pull/90
[#91]: https://github.com/toshtag/code-pact/pull/91
[#92]: https://github.com/toshtag/code-pact/pull/92
[#93]: https://github.com/toshtag/code-pact/pull/93

---

## [1.0.2] — 2026-05-20

**Onboarding and dogfood documentation baseline.** Patch release that restructures the onboarding entry path and ships the dogfood / sample-phase / community materials that v1.0 left implicit.

### CLI behavior changes

None. Stable command flags, JSON envelope shape, exit-code semantics, and error-code surface remain unchanged from v1.0.1. The `tests/integration/json-stdout.test.ts` and `tests/unit/error-code-surface.test.ts` regression nets are unchanged.

### Added

- **`docs/getting-started.md`** — canonical first-thirty-minutes guide documenting three onboarding paths side by side (tutorial / manual / AI-assisted) plus the per-task agent loop, phase-boundary checkpoints, and adapter management. Replaces the in-README Quickstart. ([#81])
- **`docs/workflows/greenfield.md`** — guidance for projects starting from an empty repo: which onboarding path matches a greenfield project, how to fill `plan brief` / `plan constitution`, the Foundations → Capability → Stabilization phase pattern. ([#82])
- **`docs/workflows/brownfield-feature.md`** — guidance for adopting `code-pact` on an existing project: scope discipline (one feature, not retroactive backfill), three coexistence options for a pre-existing `CLAUDE.md` / `AGENTS.md`, verify-command sizing. ([#82])
- **`docs/concepts/sample-phase.md`** — what the `init` wizard's optional sample phase actually contains (P1 Welcome, no tasks, one verify command), why the default is yes, keep / rename / delete decision matrix. ([#82])
- **`docs/ja/getting-started.md`** — Japanese counterpart to `docs/getting-started.md`. README / migration translations remain English-primary and out of scope for this release. ([#83])
- **`.github/ISSUE_TEMPLATE/bug-report.yml`** and **`.github/ISSUE_TEMPLATE/feature-request.yml`** — structured intake forms that ask for `--json` reproduction, the relevant exit code, and an explicit scope check against the MVP non-goals. ([#84])
- **`.github/pull_request_template.md`** — contract checklist covering Stable (v1.0) surface preservation, atomic-write contract, and the no-new-runtime-dependency policy from `CONTRIBUTING.md`. ([#84])
- **`docs/community.md`** — where to file issues / discussions / PRs, GitHub Discussions intent (with a status note that the tab may not be enabled yet), and the scope-discipline rule that re-introducing items from the MVP non-goals list requires an `rfc`-labelled issue with an explicit scope tradeoff. ([#84])
- **`design/decisions/stability-taxonomy.md`** and **`design/rules/json-output.md`** — seed corpus so the context-quality gate in `src/core/pack/index.ts` has content to surface when a task declares `context_size: large` or `write_surface: high`. Exhaustive backfill remains out of scope. ([#85])
- **`design/phases/P9-post-v1-dogfood-onboarding.yaml`** — phase contract registering the onboarding baseline work. ([#79])

### Changed

- **`README.md`** — reduced from a 269-line monolith to a ~110-line 30-second tour plus a Reference docs link hub. Quickstart, Agent-facing usage, Managing adapters, and Low-level mode all move into `docs/getting-started.md`. ([#81], [#84])
- **`docs/dogfood.md`** — Troubleshooting section gains an "Expected warnings after a non-interactive bootstrap" entry covering `BRIEF_MISSING` / `CONSTITUTION_PLACEHOLDER` / `ADAPTER_STALE`, plus a `STATUS_DRIFT done-but-design-not-done` reminder cross-linked to the v1.0 contract section. ([#86])
- **`design/phases/P4-stabilize.yaml`** — `status: in_progress` → `status: done`. P4 had been the open phase continuously since v0.5; closing it formally now that P9 is the new chapter. ([#80])
- **`design/roadmap.yaml`** — appends P9 entry. ([#79])
- **`design/phases/P9-post-v1-dogfood-onboarding.yaml`** — phase `status: planned` → `status: done`, and every P9 task (`P9-T1` through `P9-T7`) `status: planned` → `status: done`. Clears the seven `STATUS_DRIFT done-but-design-not-done` warnings that accumulated across P9 task PRs into a single coherent release-prep flip, following the v1.0.0 / v1.0.1 release-prep pattern. (this release prep)
- **`package.json`** — version `1.0.1` → `1.0.2`. (this release prep)

### Known residuals (not blockers)

- **Tutorial path requires TTY.** `code-pact init --non-interactive` does not create the sample phase (`createSamplePhase` is wizard-only). Documented in `docs/getting-started.md` Path 1 as expected behaviour. Candidate for a future `init` UX hardening phase.
- **No `task add --non-interactive`.** CI / automation workflows use `code-pact phase import` with tasks declared in the imported YAML. Documented in `docs/getting-started.md` and `docs/dogfood.md`.

[#79]: https://github.com/toshtag/code-pact/pull/79
[#80]: https://github.com/toshtag/code-pact/pull/80
[#81]: https://github.com/toshtag/code-pact/pull/81
[#82]: https://github.com/toshtag/code-pact/pull/82
[#83]: https://github.com/toshtag/code-pact/pull/83
[#84]: https://github.com/toshtag/code-pact/pull/84
[#85]: https://github.com/toshtag/code-pact/pull/85
[#86]: https://github.com/toshtag/code-pact/pull/86

---

## [1.0.1] — 2026-05-19

**Atomic-write contract alignment.** Patch release closing a public-contract gap the v1.0 post-release audit caught: `docs/cli-contract.md` claims every listed state/design write goes through `atomicWriteText`, but six raw `fs.writeFile` call sites remained on listed paths. This release routes all of them through the shared atomic-text helper so the implementation matches the published contract.

### CLI behavior changes

None. JSON envelopes, exit codes, error codes, and human output are unchanged. Output bytes on disk are identical.

### Fixed

- **Atomic-write coverage for listed state/design writes.** Six remaining raw `fs.writeFile` call sites now route through `atomicWriteText` (`src/io/atomic-text.ts`), matching the v1.0 atomic-write guarantee in [`docs/cli-contract.md`](docs/cli-contract.md):
  - `src/core/services/createPhase.ts` — `design/roadmap.yaml` and `design/phases/<phase>.yaml` (covers `phase add` and `phase import`)
  - `src/commands/task-add.ts` — `design/phases/<phase>.yaml` rewrite
  - `src/commands/plan-brief.ts` — `design/brief.md`
  - `src/commands/plan-constitution.ts` — `design/constitution.md`
  - `src/commands/init-wizard.ts` — `design/brief.md` from the interactive `code-pact init` wizard

  An interrupted process can no longer leave any of these files half-written. The v1.0.0 internal note that claimed "every disk write in `src/` now goes through the temp-file + rename primitive" was accurate as a target but premature as a fact; this release makes it actually true for every path listed in the contract.

---

## [1.0.0] — 2026-05-19

**Stable Control Plane / GA Hardening.** Locks the public CLI surface and ships the regression nets that protect it. Every command classified `Stable (v1.0)` in [`docs/cli-contract.md`](docs/cli-contract.md) keeps its flags, exit codes, and JSON envelope shape across the v1.x line. No new commands. Migration guidance from any prior alpha lives in [`docs/migration.md`](docs/migration.md).

### CLI behavior changes

None. v0.6–v0.9 callers parse v1.0 output unchanged, and every previously stable error code retains its name and `error.code` value.

### Release channel changes

- **npm dist-tag moved from `alpha` to `latest`.** New projects can `npm install code-pact` (or `npx code-pact`) and get v1.0. Past alpha releases remain available at `npm install code-pact@alpha` for users who pinned to pre-v1.0 behaviour.

### Added

- **`docs/migration.md`** — v0.6 / v0.7 / v0.8 / v0.9 → v1.0 upgrade paths, plus a dedicated section on the `task complete` vs `design.status` contract (`task complete` records operational progress; it does NOT mutate design YAML). ([#76])
- **`docs/dogfood.md` Troubleshooting section** — recovery actions keyed to the 5 most common diagnostic codes: `MANIFEST_NOT_FOUND`, `INVALID_TASK_TRANSITION`, `PLAN_NORMALIZE_REQUIRED`, `VERIFICATION_FAILED`, `ADAPTER_GENERATOR_STALE`. ([#76])
- **Stability taxonomy in `docs/cli-contract.md`** — `Stable (v1.0)` / `Stable (human-output)` / `Experimental` / `Deprecated` bands. Every command is classified explicitly. The 4-category public error code tables (public 20 / plan 13 / doctor 9 / adapter 10 / internal 1 = 53 codes) replace the previous 11-code summary table. ([#74])
- **State file write guarantees section in `docs/cli-contract.md`** — documents every file `code-pact` writes, the atomic-write strategy (temp file + rename, no fsync), the path-safety scope (adapter-managed file writes only for v1.0), and the single-process-owner assumption for `.code-pact/`. ([#75])
- **`tests/integration/e2e-workflow.test.ts`** — end-to-end smoke for the full agent-facing loop (init → adapter install → recommend → task context → task start → task complete → plan lint → plan analyze → adapter upgrade --check → doctor → validate) plus a pre-v0.9 migration scenario. ([#73])
- **`tests/integration/migration.test.ts`** — 12 scenarios covering v0.6-era (design done, no progress events), v0.8-era (mixed events + historical tasks), and v0.9-era (manifest with stale `generator_version`) project shapes. ([#75])
- **`tests/integration/json-stdout.test.ts`** — 31 tests asserting every `Stable (v1.0)` command emits a single valid JSON document on stdout under `--json`. Catches the `console.log`-on-stdout regression class regardless of which command broke. ([#74])
- **`tests/unit/error-code-surface.test.ts`** — walks `src/` for every `code: "..."` / `.code = "..."` / `outCode = "..."` literal and locks the de-facto error-code surface against a categorized table. Adding a new code in `src/` requires updating both this test and `docs/cli-contract.md`. ([#74])
- **`tests/helpers/cli.ts`** — shared subprocess + JSON-envelope helpers (`createTempProject`, `run`, `expectJsonOk`, `expectJsonErr`, `ensureCliBuilt`). New tests use it; existing tests are intentionally not migrated. ([#73])
- **Subprocess coverage for `validate`, `task add`, `plan brief`, `plan prompt`, `plan constitution`** — 14 new integration tests filling the v1.0 contract-freeze prerequisite of "every Stable command has subprocess coverage". ([#72])

### Changed

- **`README.md`** — Status section rewritten to list the v1.0 stable surface explicitly and call out cursor / gemini-cli as Experimental. Install snippets drop the `@alpha` dist-tag from primary examples (with a one-line note that `@alpha` still resolves to past prereleases). Quickstart aligned with the v0.9 adapter subcommand layout. ([#76])
- **`docs/cli-contract.md`** — Path-safety scope wording reframed to make explicit that "v1.0 path-traversal hardening is scoped to adapter-managed generated file writes" — not "design/progress need no validation". Existing state files remain protected by their schema validation and atomic-write behaviour. ([#76])
- **`CHANGELOG.md` preamble** — switches from "alpha-only" versioning to a SemVer statement covering both the v0.x-alpha history and the upcoming v1.x line. ([#76])
- **`scripts/assert-package-metadata.mjs`** — version regex broadened to accept plain `X.Y.Z` in addition to the v0.x `X.Y.Z-(alpha|beta|rc).N` prerelease form. (this PR)
- **`design/phases/P8-stable-control-plane.yaml`** — new phase covering the v1.0 work end-to-end across six tasks. Each task was a single PR, each green individually. (P8-T1 .. P8-T6)

### Fixed

- **`task add` honors post-command `--json`** like every other `task` subcommand. Pre-v1.0, `code-pact task add P1 --json` silently dropped to the human stderr path because `cmdTaskAdd` only consulted the global pre-form `--json` flag. The fix brings the JSON envelope contract in line across the whole `task` subcommand group ahead of contract freeze. ([#72])

### Internal

- **`src/commands/init.ts`** — last raw `fs.writeFile` call site converted to the shared `atomicWriteText` helper. Every disk write in `src/` now goes through the temp-file + rename primitive; an interrupted `init` cannot leave a half-written project file behind. Behaviour unchanged on the happy path. ([#75])
- **Test suite**: 881 tests at v0.9.0-alpha.0 → 930 tests at v1.0.0 across 66 files. New tests are all subprocess-level integration except `error-code-surface` (unit).

[#72]: https://github.com/toshtag/code-pact/pull/72
[#73]: https://github.com/toshtag/code-pact/pull/73
[#74]: https://github.com/toshtag/code-pact/pull/74
[#75]: https://github.com/toshtag/code-pact/pull/75
[#76]: https://github.com/toshtag/code-pact/pull/76

---

## [0.9.0-alpha.0] — 2026-05-19

### Behavior changes

- **`adapter --force` is narrowed to unmanaged-adoption only.** In v0.8, `code-pact adapter --force` overwrote every file unconditionally. In v0.9, `--force` adopts pre-existing files into the manifest but **NEVER** overwrites a file already recorded in the manifest (`managed-modified`). Destructive overwrite of a locally-modified managed file now requires `code-pact adapter upgrade <agent> --write --accept-modified`. The bare-form `code-pact adapter --agent X [--force] [--regen-skills]` continues to work in v0.9.x with a one-line stderr deprecation notice (suppressed under `--json`) and is internally routed to `adapter install`; it will be removed in v0.10. `--regen-skills` is preserved as a role-scoped force that applies `--force`-equivalent to skill files only and **still** cannot override `managed-modified`. ([#67], [#69])

### Added

- **`adapter` subcommand group.** `code-pact adapter` is promoted from a flat command into a router following the `cmdPlan` / `cmdPhase` pattern. Six subcommands ship:
  - `adapter list [--json]` — enumerate registered adapters with manifest state (enabled / experimental flags, fileCount, lastGeneratedAt, generatorVersion, manifestInvalid surfacing). ([#67])
  - `adapter install <agent> [--force] [--model <v>] [--regen-skills] [--json]` — first-time install, writes the per-agent manifest. Idempotent across re-runs. ([#67])
  - `adapter upgrade <agent> --check [--json]` — read-only drift report. Exit 0 clean / 1 drift detected / 2 config. Never touches disk or manifest. ([#69])
  - `adapter upgrade <agent> --write [--force] [--accept-modified] [--model <v>] [--regen-skills] [--json]` — apply changes. Exit 0 ok / 1 if any file was refused / 2 config. `--check` and `--write` are mutually exclusive and required. ([#69])
  - `adapter doctor [--agent <name>] [--json]` — manifest-aware adapter-scoped diagnostics. ([#68])
  - Bare-form `adapter [--agent <name>] ...` — deprecated v0.5–v0.8 surface; routes to `install`. ([#67])
- **Per-agent manifest at `.code-pact/adapters/<agent>.manifest.yaml`.** Records every file code-pact generated, its sha256 hash (computed from LF-normalized UTF-8 bytes), an `adapter_schema_version`, a `profile_fingerprint` (the adapter-output-affecting profile fields), the `generator_version` at install time, and an ISO-8601 `generated_at`. zod `.strict()` at every level so accidental field drift fails loudly. ([#66])
- **2-axis file-state classifier (`local × desired`).** Local: `new | unmanaged | managed-clean | managed-modified | managed-missing`. Desired: `current | stale | absent`. The 8-value action enum `write | skip | adopt | replace_unmanaged | update | update_manifest | refuse | warn` is derived from `(local, desired, mode, force, acceptModified)` by a pure function. Catches the "manifest hash drifted but content is still current" case (`managed-modified × current`) so re-runs refresh the manifest without touching disk. ([#66])
- **Nine new `ADAPTER_*` error codes** surfaced by `adapter doctor`:
  - `ADAPTER_MANIFEST_MISSING` (warning, **`adapter doctor` only** — never emitted by global doctor)
  - `ADAPTER_MANIFEST_INVALID` (error) — YAML parse or schema failure
  - `ADAPTER_GENERATOR_STALE` (warning) — manifest's `generator_version` differs from current package version (simple equality, no semver ordering)
  - `ADAPTER_SCHEMA_DRIFT` (warning) — manifest's `adapter_schema_version` older than the adapter module declares
  - `ADAPTER_PROFILE_DRIFT` (warning) — `profile_fingerprint` deep-mismatch
  - `ADAPTER_FILE_MISSING` (error) — managed-missing
  - `ADAPTER_FILE_DRIFT` (warning) — `managed-modified × stale`
  - `ADAPTER_DESIRED_STALE` (warning) — `managed-clean × stale`
  - `ADAPTER_UNMANAGED_FILE` (warning) — file under `ownedPathGlobs` but not in manifest ([#68])
- **Path-safety helpers** in `src/core/adapters/file-state.ts`. `assertSafeRelativePath` rejects absolute paths, leading `~`, `\`, Windows drive letters, `..`, `.`, and empty segments at the zod-schema level. `resolveWithinProject` additionally walks ancestors and rejects symlink-escape (a directory symlink under cwd resolving outside the project) before any write. ([#66])
- **Stable-adapter conformance suite** (`tests/integration/adapter-conformance.test.ts`). Per-agent snapshots of the manifest file list at `tests/fixtures/adapters/<agent>/expected-files.txt`. Content invariants assert all four required CLI references (`code-pact recommend`, `code-pact task context`, `code-pact task complete`, `code-pact validate`), `--json` mention, install→install idempotency, zod round-trip, and `generateDesiredFiles` path safety. cursor and gemini-cli are intentionally excluded with an inline comment citing `EXPERIMENTAL_AGENTS`. ([#70])
- **`recommend` and `validate` references in stable adapter instruction templates.** The generated `CLAUDE.md`, `AGENTS.md`, and `docs/code-pact/agent-instructions.md` now open with a step 0 telling the agent to call `code-pact recommend --phase <id> --task <id> --agent <name> --json` first; a `validateNote` below the verify note also points at `code-pact validate --json`. ([#70])

### Changed

- **Global `doctor` is manifest-aware when a manifest exists.** With a manifest, the legacy `ADAPTER_MISSING` warning is skipped in favor of the manifest-aware codes (`ADAPTER_FILE_MISSING`, `ADAPTER_FILE_DRIFT`, `ADAPTER_DESIRED_STALE`, `ADAPTER_GENERATOR_STALE`, `ADAPTER_SCHEMA_DRIFT`, `ADAPTER_PROFILE_DRIFT`, `ADAPTER_UNMANAGED_FILE`); findings carry an `[agent-name]` prefix on the message so consumers can attribute issues without changing the `DoctorIssue` shape. `ADAPTER_MANIFEST_MISSING` is **never** emitted by global `doctor` — it's an `adapter doctor`-only signal so existing projects don't suddenly become noisy after upgrading to v0.9. ([#68])
- **Global `doctor` is byte-identical to v0.8 when no manifest exists.** Projects that have not yet run `adapter install` continue to see the legacy `ADAPTER_MISSING` warning exactly as in v0.8 — no new codes, no new lines, no surprise CI failures. ([#68])
- **`docs/cli-contract.md`** rewrites the v0.5 `adapter` section as v0.9: subcommand list, JSON envelope shapes for every subcommand, the `--force` action table, manifest schema reference, `--regen-skills` role scoping, bare-form deprecation, full 8-row action enum table, full 9-row `ADAPTER_*` error code table, and "Interaction with global doctor" subsection. ([#67], [#68], [#69])
- **`docs/dogfood.md`** adds an "Upgrading an adapter safely (v0.9)" section covering the check/apply split, the `--force` narrowing, the 8-row action enum, and the `adapter doctor` workflow. Quick-reference table updated with `adapter list / install / upgrade / doctor` rows. ([#70])
- **`README.md` agent-facing usage** updated to match the v0.9 subcommand surface. (this PR)

### Internal

- **Pure `AdapterDescriptor` model.** Each of the five adapters now exposes `generateDesiredFiles(input): Promise<DesiredAdapterFile[]>` returning only the file list it would write (LF-normalized UTF-8 content, project-relative POSIX paths). All disk write I/O, force / skip / regenSkills logic, and directory placeholder creation moved into the command layer. Generators are byte-identical to v0.8 output for unchanged inputs. ([#65])
- **Action matrix + classifier are pure functions.** `classifyFileState({manifestHash, diskHash, desiredHash})` and `decideAction({local, desired, mode, force, acceptModified})` live in `src/core/adapters/file-state.ts` and are exhaustively unit-tested across every cell of the 5×3 × 3 modes × flag combinations. ([#66])
- **Atomic manifest I/O.** `writeManifest` validates the input through `AdapterManifest.parse` BEFORE any bytes hit disk, then delegates to the existing `atomicWriteText` helper. `readManifest` returns `null` on ENOENT (fresh project) and throws on parse failure so doctor can surface `ADAPTER_MANIFEST_INVALID`. ([#66])
- **`readPackageVersion` extracted** to `src/lib/package-version.ts` so adapter modules can read the current code-pact version into `generator_version` without duplicating the cli.ts helper. Tries both `..` and `../..` from `import.meta.url` so it works from `dist/cli.js` AND from tsx-driven runs of source files. ([#67])
- **220 new tests** across the v0.9 surface:
  - 30 schema tests (`tests/unit/schemas/adapter-manifest.test.ts`)
  - 22 manifest I/O tests (`tests/unit/core/adapter-manifest.test.ts`)
  - 59 file-state classifier + action matrix tests (`tests/unit/core/adapter-file-state.test.ts`)
  - 7 install unit tests added to `tests/unit/commands/adapter.test.ts`
  - 9 list unit tests (`tests/unit/commands/adapter-list.test.ts`)
  - 23 doctor unit tests (`tests/unit/commands/adapter-doctor.test.ts`)
  - 24 upgrade unit tests (`tests/unit/commands/adapter-upgrade.test.ts`)
  - 21 CLI integration tests (`tests/integration/adapter-cli.test.ts`)
  - 19 conformance tests (`tests/integration/adapter-conformance.test.ts`)
  - 6 global-doctor manifest-aware regression tests added to `tests/unit/commands/doctor.test.ts`
- **`design/phases/P7-adapter-platform.yaml`** — new phase covering the v0.9 work end-to-end across seven tasks. Each task was a single PR, each green individually.
- **Self-dogfood manifest not committed in v0.9.** `.code-pact/` remains gitignored as per-developer state, consistent with how v0.8 shipped. Users running v0.9 on a fresh clone see the legacy `ADAPTER_MISSING` warning from global `doctor` until they run `code-pact adapter install <agent>`. A future release may revisit the gitignore policy.

[#65]: https://github.com/toshtag/code-pact/pull/65
[#66]: https://github.com/toshtag/code-pact/pull/66
[#67]: https://github.com/toshtag/code-pact/pull/67
[#68]: https://github.com/toshtag/code-pact/pull/68
[#69]: https://github.com/toshtag/code-pact/pull/69
[#70]: https://github.com/toshtag/code-pact/pull/70

---

## [0.8.0-alpha.0] — 2026-05-19

### Added

- **`recommend` extended into a deterministic execution-planning contract** — `code-pact recommend --phase <id> --task <id> [--agent <name>] [--json]` now returns a context profile, planning posture, ambiguity action, escalation order, structured preflight commands, categorical budget profile, and machine-readable structured reasons. Strictly additive over v0.7: existing fields (`phaseId / taskId / agentName / tier / effort / modelId / reasons`) are byte-identical for pre-v0.8 fixtures, asserted by an integration regression test.
- **New `recommend` output fields:**
  - `contextProfile` (`small | medium | large`) — derived from `context_size`, bumped up one notch when `ambiguity == high`. ([#62])
  - `verificationProfile` — passthrough of `verification_strength`. ([#62])
  - `planningRequired` (boolean) — true for `architecture` type, medium / high ambiguity, high risk, or `requires_decision == true`. ([#62])
  - `ambiguityAction` (`proceed | clarify_before_implementation | split_recommended`) — top-down evaluation; clarify wins over split when both could fire. ([#62])
  - `allowedEscalation` — tier-driven ordered escalation hints. Cheap tiers lead with `increase_effort`; larger tiers lead with `increase_context`. ([#62])
  - `preflight` — structured array of suggested pre-implementation commands (`plan lint`, `plan analyze`, `task status <id>`), capped at 3 entries. Each entry has `argv` ready to spawn and a `reason` field. Advisory only (`required: false` in v0.8). ([#62])
  - `budgetProfile` — three categorical magnitudes (`toolCalls`, `contextFiles`, `verificationCommands`). Explicitly **not** an estimate of tokens, cost, or time. ([#62])
  - `structuredReasons` — machine-readable mirror of `reasons[]`. Each entry pairs one Task factor with one effect on the output. ([#62])
- **`RecommendResultV2` zod schema** with `.strict()` at every level. Drift-guards the contract — accidental snake_case fields (e.g. `planning_required` next to `planningRequired`) fail loudly instead of producing a silent split contract. ([#59])
- **`formatRecommend()` extended** with Planning / Escalation / Preflight / Budget sections beneath the existing 5-line Task / Agent / Tier / Model / Effort summary. Section/field structure, not a snapshot — tests assert labels and lines, not byte-exact output. ([#62])

### Changed

- **`docs/cli-contract.md` `recommend` section** rewritten with per-field tables (type, allowed values, trigger) plus inline tables for `PreflightEntry`, `BudgetProfile`, and `StructuredReason`. The JSON example now matches the real camelCase shape — the previous example used snake_case keys (`task_id`, `phase_id`, `agent`, `model_id`), but the implementation has always emitted camelCase. This fixes a pre-existing doc drift. ([#63])
- **`docs/dogfood.md` per-task flow** promotes `recommend` from "step 0 (optional)" to the recommended starting point. New "Reading `recommend --json` (v0.8)" section explains which fields drive which agent decisions. ([#63])
- **`README.md` agent-facing usage** updated to match the new dogfood flow. (this PR)

### Internal

- New `src/core/recommend/` modules — pure no-I/O decision functions, each paired with unit tests covering every decision-table row:
  - `context-profile.ts` — `context_size + ambiguity → contextProfile`. ([#60])
  - `planning.ts` — `isPlanningRequired` + `recommendAmbiguityAction`. ([#60])
  - `escalation.ts` — `ModelTier → ordered EscalationStep[]`. ([#60])
  - `budget.ts` — `Task → BudgetProfile`. ([#60])
  - `preflight.ts` — `Task → PreflightEntry[]`, capped at 3, Task-derivable triggers only. ([#61])
- `src/core/schemas/recommend-result.ts` — zod schema with strict mode and inner schemas for `PreflightEntry`, `BudgetProfile`, `StructuredReason`. ([#59])
- `src/commands/recommend.ts` — `runRecommend` composes every decision module and zod-validates the result before return. The public `RecommendResult` type aliases `RecommendResultV2` so callers keep working with stricter inferred field types. ([#62])
- `design/phases/P6-budgeted-execution.yaml` — new phase covering the v0.8 work end-to-end. Phase verification chains `pnpm typecheck / test / build + plan lint + plan normalize --check + plan analyze + recommend` so subsequent phases inherit the v0.8 execution-planning gate. ([#63])
- ~110 new tests across the recommend modules, schemas, and integration suite (`tests/integration/recommend-v2.test.ts`). Includes a back-compat regression that asserts every v0.7 field is byte-identical for the project-a fixture, and a CLI subprocess test confirming the `{ok:true, data:{...}}` envelope shape is preserved.
- Pre-existing local agent profile (`.code-pact/agent-profiles/claude-code.yaml`) is gitignored and absent in CI checkout. Where the v0.8 tests render formatter output, they feed stub `RecommendResult` values directly into `formatRecommend` rather than calling `runRecommend` against the repo's own profile, so CI never hits `AGENT_NOT_FOUND`.

[#59]: https://github.com/toshtag/code-pact/pull/59
[#60]: https://github.com/toshtag/code-pact/pull/60
[#61]: https://github.com/toshtag/code-pact/pull/61
[#62]: https://github.com/toshtag/code-pact/pull/62
[#63]: https://github.com/toshtag/code-pact/pull/63

---

## [0.7.0-alpha.0] — 2026-05-18

### Added

- **`plan lint [--strict] [--include-quality] [--json]`** — read-only static integrity check over `design/roadmap.yaml` and every referenced phase file. Default checks: `INVALID_YAML`, `SCHEMA_ERROR`, `MISSING_PHASE_FILE`, `DUPLICATE_TASK_ID`, `DUPLICATE_PHASE_ID`, `PHASE_ID_MISMATCH`, `ORPHAN_PHASE_FILE` (warning), `PHASE_ID_NAMING` (warning), `TASK_ID_PHASE_PREFIX` (warning). `--include-quality` opt-in adds `WEAK_DOD` and `PLACEHOLDER_VERIFICATION` so subjective heuristics never fail CI by default. `--strict` promotes warnings to exit 1. Lenient loader: a broken `roadmap.yaml` does not stop the run — it falls back to scanning `design/phases/` directly and lists the roadmap-dependent checks it skipped under `data.skipped_checks`. ([#54])
- **`plan normalize [--check | --write] [--json]`** — conservative line-based normalization for files under `design/` plus the progress log. YAML files: CRLF → LF, strip trailing whitespace, single trailing newline. Markdown files: CRLF → LF and final newline only — trailing whitespace is preserved because two trailing spaces are a meaningful hard line break. No YAML parse/re-stringify, so comments survive byte-for-byte. `--check` (default) never writes; `--write` uses an atomic temp-file + rename per file. `--check` + `--write` → `PLAN_NORMALIZE_CONFLICT` exit 2. Typo flags (e.g. `--wite`) are rejected explicitly so they cannot silently degrade to a no-op. ([#55])
- **`plan analyze [--strict] [--include-historical] [--json]`** — cross-artifact drift detection comparing design `status` against derived progress state. One `STATUS_DRIFT` code with five mutually exclusive kinds in `details.kind` (top-down evaluation guarantees a single task never produces two issues): `done-blocked-conflict` (error), `done-with-incomplete-events` (error), `done-historical` (warning, hidden by default, never affects exit), `done-but-design-not-done` (warning), `in-progress-no-events` (warning). Also reports `PHASE_DONE_WITH_OPEN_TASKS` (error) and reuses the shared `ORPHAN_PROGRESS_EVENT` detector (warning). ([#56])
- **`hidden_by_default` and `affects_exit` issue metadata** — analyze issues can now hide themselves from default output and from `--strict` exit codes without inventing a third severity tier. This is the safety property that keeps `plan analyze` from blowing up on pre-v0.7 done tasks that have no progress events. `--include-historical` exposes hidden issues in JSON; the exit code is independent of visibility. ([#56])

### Changed

- **`doctor` and `plan lint` share their duplicate / orphan / missing-reference detectors** through `src/core/plan/checks.ts`, so the two commands cannot drift apart. doctor's `DoctorIssue` shape, codes, and human messages are preserved; only the detector source moved. ([#53])
- **`src/io/atomic-text.ts`** — raw-text atomic writer extracted from `atomicWriteYaml`. `plan normalize --write` uses it directly (no YAML stringify). `atomicWriteYaml` is now a one-line wrapper over the same primitive. ([#53])

### Internal

- New `src/core/plan/` module:
  - `state.ts` — strict (`loadPlanState`) and lenient (`collectPlanArtifacts`) loaders. The lenient loader collects parse / schema / reference issues per file and, when the roadmap is unparseable, falls back to scanning `design/phases/` while reporting the skipped roadmap-dependent checks.
  - `shared.ts` — `PlanIssue` type with optional `hidden_by_default` / `affects_exit` / `details` metadata.
  - `checks.ts` — pure detectors shared with doctor (duplicate task / phase id, phase id mismatch, missing / orphan phase file, orphan progress event) plus naming heuristics used only by lint.
  - `lint.ts` — `plan lint` orchestration (structural checks + opt-in quality heuristics).
  - `normalize.ts` — file walker + pure YAML/Markdown line normalizers.
  - `analyze.ts` — cross-artifact drift detection.
- `design/phases/P5-planning-integrity.yaml` — new phase covering the v0.7 work end-to-end, dogfooded through `task start` / `task complete` for each task (T1-T5). Phase verification chains `pnpm typecheck / test / build + plan lint + plan normalize --check + plan analyze` so subsequent phases inherit the integrity gate.
- `vitest.config.ts` — `fileParallelism: false`. The integration suites all rebuild `dist/cli.js` in `beforeAll`, and concurrent workers raced against tsup's output-dir cleanup. Sequencing test files removes the race; in-file concurrency is unaffected. ([#54])
- ~60 new tests across `src/core/plan/` (state, checks, lint, normalize, analyze) and the three new `tests/integration/plan-*.test.ts` suites, including a dedicated **historical fixture** regression test that asserts `plan analyze` exits 0 on a project mirroring pre-v0.7 history (done tasks with no progress events).

[#53]: https://github.com/toshtag/code-pact/pull/53
[#54]: https://github.com/toshtag/code-pact/pull/54
[#55]: https://github.com/toshtag/code-pact/pull/55
[#56]: https://github.com/toshtag/code-pact/pull/56

---

## [0.6.0-alpha.0] — 2026-05-18

### Added

- **`task start <task-id> [--agent <name>] [--json]`** — records a `started` event in `progress.yaml`. Idempotent: starting an already-started task exits 0 with `{ already_started: true }` and leaves `progress.yaml` byte-identical. ([#51])
- **`task status <task-id> [--json]`** — pure-read inspection of a task's derived current state and full event history. **Agent-neutral**: takes no `--agent` flag and does not validate agent configuration, so CI / monitoring / human reviewers can use it without project agent setup. ([#51])
- **`task block <task-id> --reason "<text>" [--agent <name>] [--json]`** — records a `blocked` event with a required reason. The reason is enforced at both the CLI (`CONFIG_ERROR` for missing / empty) and the Zod schema (`superRefine` rejects `blocked` events without `reason`), so hand-edited progress logs cannot accumulate empty blocks. Allowed only from `started` or `resumed`. ([#51])
- **`task resume <task-id> [--agent <name>] [--json]`** — records a `resumed` event. Allowed only from `blocked`; any other current state returns `INVALID_TASK_TRANSITION`. ([#51])
- **`INVALID_TASK_TRANSITION` error code (exit 2)** — raised by `task start/block/resume/complete` when a requested state transition is not allowed from the current derived state. ([#51])
- **`ProgressEvent.reason?: string` field** — semantically distinct from the existing `notes` field. `reason` records the justification for a state transition (currently used for `blocked` events). ([#51])

### Changed

- **`task complete` rejects `blocked → done`** with `INVALID_TASK_TRANSITION` (exit 2) and leaves `progress.yaml` byte-identical. The task must be `resume`d first so the `resumed` event records the unblock decision. `planned → done` remains permitted at the command layer for v0.5 backwards compatibility. ([#51])
- **`task complete` idempotency** check now routes through the shared `deriveTaskState` helper instead of an inline `events.find` scan. The `kind: "already_done"` and exit-0 semantics are preserved; existing v0.5 integration tests pass unchanged. ([#51])
- **`EventStatus` enum extended** with `blocked` and `resumed` (in-place; `started`, `done`, and `failed` are preserved). Existing `progress.yaml` files remain forward-compatible — no schema migration is performed. ([#51])
- **`recommend` promoted into the agent-facing loop narrative** in README, `docs/dogfood.md`, and `docs/cli-contract.md`. Source code for `recommend` is unchanged; only documentation was updated. The new agent-facing flow is `recommend → task context → task start → implement → task block / resume → task complete`. ([#51])

### Internal

- New module `src/core/progress/`:
  - `io.ts` — `atomicWriteYaml` / `loadProgressLog` / `appendEvent` consolidated from `task-complete.ts`'s inline helpers; shared with all four new task-state commands.
  - `task-state.ts` — `deriveTaskState` (last-event-wins reduction over the append-only log) and `assertTransition` (deterministic state-machine enforcement).
- 35 new unit tests + 5 new integration tests covering the state machine end-to-end.

[#51]: https://github.com/toshtag/code-pact/pull/51

---

## [0.5.0-alpha.0] — 2026-05-18

### Added

- **Model-aware adapter generation (`--model`)** — `adapter --agent claude-code --model <version>` generates a `CLAUDE.md` with a "Model guidance" section containing effort-level and extended-thinking guidance tailored to the specific Claude version. Supported: `opus-4.7`, `opus-4.6`, `sonnet-4.6`. The `model_version` field in the agent profile YAML is used as the default when the flag is omitted. ([#46])
- **`--regen-skills` flag** — forces skill file regeneration without overwriting `CLAUDE.md`. Useful after adding new phases with new `verification.commands`. ([#48])
- **Skill generation from `verification.commands`** — `adapter --agent claude-code` now reads every phase in `design/roadmap.yaml` and auto-generates a `.claude/skills/<name>.md` file for each unique verification command (e.g. `pnpm test` → `/test`). Duplicate commands across phases produce a single skill. ([#48])
- **Context quality gates in `task context`** — the context pack now adapts its content to task attributes: `context_size: large` includes `constitution.md` + all decisions; `context_size: small` is minimal (no rules/decisions/constitution); `ambiguity: high` includes `constitution.md` + recent done events in the phase; `write_surface: high` bypasses the `applies_to` filter and includes all rule files. `PackResult` exposes `includedConstitution`. ([#47])
- **Plan quality `doctor` checks** — four new checks: `BRIEF_MISSING` (warning, `design/brief.md` absent), `CONSTITUTION_PLACEHOLDER` (warning, constitution not yet edited), `EMPTY_OBJECTIVE` (error, phase objective < 10 chars), `ADAPTER_STALE` (warning, no `model_version` in agent profile). ([#49])
- **`disabled_checks` config** — `.code-pact/doctor.yaml` with a `disabled_checks` array suppresses individual doctor checks per project. ([#49])
- **`design/` structure** — `design/brief.md`, `design/constitution.md`, and `design/roadmap.yaml` now ship with real content so the repo can dogfood itself.

### Changed

- `adapter --agent claude-code` always generates dynamic skills in addition to the three fixed skills (`/context`, `/verify`, `/progress`).

[#46]: https://github.com/toshtag/code-pact/pull/46
[#47]: https://github.com/toshtag/code-pact/pull/47
[#48]: https://github.com/toshtag/code-pact/pull/48
[#49]: https://github.com/toshtag/code-pact/pull/49

---

## [0.4.0-alpha.0] — 2026-05-18

### Added

- **`plan` subcommand group** — a new top-level subcommand collects all AI-assisted project planning tools under one roof:
  - `code-pact plan brief [--force]` — interactive wizard that collects project description, target users, and differentiator, then writes `design/brief.md`. ([#41])
  - `code-pact plan prompt [--clipboard]` — reads `design/brief.md` and `design/constitution.md`, then writes a structured AI planning prompt to stdout (optionally copies to clipboard via pbcopy / xclip). ([#42])
  - `code-pact plan constitution [--force]` — interactive wizard that collects a project description and comma-separated core principles, then writes `design/constitution.md`. ([#44])
- **Flexible `phase import`** — `TaskImport` lenient schema now accepts AI-generated YAML where only `id` is required on tasks; missing fields (`type`, `ambiguity`, `risk`, `context_size`, `write_surface`, `verification_strength`, `expected_duration`, `status`) are filled with sensible defaults. The result includes a `completed_fields` report so callers can surface which fields were auto-filled. Add `--strict` to restore the previous behavior (all Task fields required). ([#43])
- **Locale inheritance** — all generated content (adapter files, templates, `init` wizard output) now respects the locale saved in `.code-pact/project.yaml`. After running `init` with `ja-JP`, subsequent commands like `adapter` automatically use Japanese without `--locale`. ([#40])
- **`plan brief` integration in `init` wizard** — the init wizard now offers to collect a project brief as the final step, writing `design/brief.md` immediately after project initialization. ([#41])

### Changed

- `plan` usage line updated to `brief | prompt | constitution`.
- `phase import` JSON result now includes `completed_fields: Array<{ taskId, fields }>`.

### Fixed

- Locale not being inherited by adapter generators after `init` with `ja-JP` (locale was re-detected from env on every command, ignoring the saved project.yaml value). ([#40])

[#40]: https://github.com/toshtag/code-pact/pull/40
[#41]: https://github.com/toshtag/code-pact/pull/41
[#42]: https://github.com/toshtag/code-pact/pull/42
[#43]: https://github.com/toshtag/code-pact/pull/43
[#44]: https://github.com/toshtag/code-pact/pull/44

---

## [0.3.0-alpha.0] — 2026-04-27

### Added

- **`phase add` wizard** — running `code-pact phase add` without flags now launches an interactive wizard in a TTY. `--non-interactive` opts back into flag-only mode. ([#35])
- **`task add <phase-id>`** — interactive wizard that adds a task to an existing phase, with auto-numbering (`<phase-id>-T<n>`) when `--id` is omitted. ([#35])
- **`doctor` health checks** — added `DUPLICATE_TASK_ID` (error), `LOCAL_NOT_GITIGNORED` (warning), and `ADAPTER_MISSING` (warning) checks. ([#36])
- **`validate` command** — CI-friendly variant of `doctor`; exits 1 on errors, 0 on warnings only. Add `--strict` to promote warnings to exit 1. ([#36])
- **Locale persistence** — `init` writes the selected locale to `.code-pact/project.yaml`; subsequent commands resolve locale from that file before falling back to `LANG` / `en-US`. ([#34])
- **Next Steps** — `init` now prints `phase add → task add → task context` reminders to stderr after completion. ([#34])
- **Adapter docs updated** — all five adapter generators now include the full `task context → implement → task complete` standard workflow, with `pack` noted as an internal command. ([#37])

### Changed

- `phase add` now accepts `--non-interactive` to opt out of the wizard.
- `phase-wizard.ts` extracted as shared UI logic used by both `phase new` and `phase add`.
- i18n prompts for weight, confidence, and risk now include inline hints.

[#34]: https://github.com/toshtag/code-pact/pull/34
[#35]: https://github.com/toshtag/code-pact/pull/35
[#36]: https://github.com/toshtag/code-pact/pull/36
[#37]: https://github.com/toshtag/code-pact/pull/37

---

## [0.2.0-alpha.0] — 2026-04-06

### Added

- **`task complete`** — marks a task done by running `verify` and appending a `done` event to `.code-pact/state/progress.yaml`. Idempotent; `--dry-run` previews without writing. ([#20])
- **`phase import <yaml>`** — bulk-imports phases (with tasks) from a YAML file into the roadmap. Detects duplicate phase and task IDs before writing anything. `--force` skips colliding phases. ([#22])
- **`recommend`** — suggests a model tier for a task based on task attributes. ([#24])
- **`doctor`** — reports project structure issues (missing files, schema errors, orphan phase files, …) in human-friendly output. ([#29])
- **Cursor adapter** (experimental) — `.cursor/rules/code-pact.mdc` with `alwaysApply: true`. ([#25])
- **Gemini CLI adapter** (experimental) — `GEMINI.md` at project root. ([#26])
- **`--json` global flag** — all commands emit `{ ok, data, error? }` to stdout when `--json` is present; human-readable output goes to stderr. ([#19])
- **`--non-interactive` flag** — explicit opt-out of wizards even in a TTY. ([#28])

### Changed

- `phase ls` now emits a table by default and JSON with `--json`.
- `task context` resolves task ids across all phases (no `--phase` required).

---

## [0.1.0-alpha.0] — 2026-03-16

Initial alpha release.

### Added

- `init` — interactive wizard to bootstrap `.code-pact/` config and `design/` skeleton.
- `phase add` / `phase new` / `phase ls` / `phase show` — phase lifecycle commands.
- `task add` — add a task to a phase YAML.
- `task context` — generate a context pack for an agent.
- `progress` — show weighted progress against a named baseline snapshot.
- `pack` — write a context pack file to `.context/<agent>/`.
- `verify` — run deterministic completion criteria (verify commands + definition of done).
- `adapter` — generate per-agent instruction files (Claude Code, Codex, Generic).
- Claude Code, Codex, and Generic adapters (stable).
