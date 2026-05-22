# RFC: Agent contract adapter hardening

**Status:** accepted (P16, 2026-05)
**Scope:** elevate the three stable adapters (claude-code, codex, generic) from "instruction templates that produce per-agent files" to "agent contracts" by adding a `## Agent contract` section to each stable adapter's instruction file body. The new section names the three axes of the canonical code-pact workflow (when to invoke code-pact, what to verify first, how to handle failures) and references the v1.6+ surfaces (`--from-file` / `--stdin` / flag-driven `plan brief` & `plan constitution`; configurable protected paths; `write_audit` envelope; `--base-ref`; `--audit-strict`). Adds one new diagnostic code (`ADAPTER_CONTRACT_DRIFT`) emitted by `adapter doctor` as a soft signal when a managed instruction file is present but its contract section is missing or out-of-shape.
**Owners:** maintainer
**Related:**
- [design/decisions/task-readiness-schema-rfc.md](task-readiness-schema-rfc.md) (P10 — declared `writes` + `TASK_WRITES_PROTECTED_PATH`; v1.6+ audit promoted these to a runtime surface that the contract section now teaches).
- [design/decisions/governance-rfc.md](governance-rfc.md) (P14 — advisory write lock + `LOCK_HELD`; contract section names lock-aware retry as the failure-handling axis's canonical recovery).
- [design/decisions/finalization-reconciliation-rfc.md](finalization-reconciliation-rfc.md) (P11 — `task finalize` / `phase reconcile`; contract section names these as the canonical "done" path the agent should target).
- [design/decisions/planning-ux-init-hardening-rfc.md](planning-ux-init-hardening-rfc.md) (P13 — non-interactive `task add`; the v1.6 P17 non-interactive `plan brief` / `plan constitution` work this RFC documents extends that family).

## Status lifecycle

- This document opens at status **proposed** in PR1 (the P16-T1 PR).
- After review approval, and **before** PR1 merges (or in a small follow-up PR per the P11/P12/P13/P14 precedent), the maintainer flips the status line at the top of this file to **accepted**.
- P16-T1 is considered done only after PR1 — with the status line reading `accepted` — has landed on main.
- Subsequent implementation PRs (P16-T2..T5) treat the accepted document as load-bearing. They may not change RFC decisions without a separate RFC-update PR.

## Background

P7 (`adapter` platform) shipped per-agent instruction file generation in v0.9. P9 (post-v1.0 dogfood) settled the stable adapter set at three: claude-code, codex, generic. cursor and gemini-cli ship as experimental; upstream format churn keeps them off the conformance suite.

The instruction template each stable adapter emits is a Markdown body that names the canonical workflow:

1. `code-pact recommend` (model tier + budget)
2. `code-pact task context` (fetch the per-task context pack)
3. (agent implements the work)
4. `code-pact task complete` (record progress, verify)
5. `code-pact task finalize` (flip design YAML, mechanizes the v1.0 contract)

Through v1.5 this was the entire workflow the templates needed to teach. v1.6 ships eleven new surfaces across two phases (P15 + P17) and the templates currently teach **none** of them:

- `plan brief --from-file <yaml>` / `--stdin` / flag-driven (`--what` / `--who` / `--differentiator`).
- `plan constitution --from-file <yaml>` / `--stdin` / flag-driven (`--description` / `--principle` repeatable).
- `task finalize --base-ref <ref>` (branch-level audit).
- `task finalize --audit-strict` (opt-in exit-relevant audit gate).
- `data.write_audit` envelope in the `task finalize --json` output, with the new advisory warning codes `TASK_WRITES_AUDIT_OUTSIDE_DECLARED` and `TASK_WRITES_AUDIT_DECLARED_UNUSED`.
- `TASK_WRITES_OVER_BROAD` plan-lint warning.
- Configurable protected paths via `design/rules/protected-paths.md`.

An agent picking up code-pact today via `adapter install claude-code` reads instruction text that is functionally **expired** relative to the CLI surface. The audit fires when the agent ignores its declared writes, but the agent has no way to know it should declare those writes correctly in the first place, or that `--audit-strict` exists to gate CI on the signal.

## Problem statement

1. **Templates lag the CLI by an entire feature phase.** v1.6 ships 11 new surfaces; the templates teach 0 of them. Agents installed from v0.9 onwards have no notification mechanism — `adapter upgrade --check` reports drift only on hash mismatch, not on semantic staleness.
2. **The workflow contract is not legible.** Each stable adapter emits a Markdown body that names the per-task loop but does not name the contract — there is no section called "Agent contract" or equivalent that a conformance test (or a human reader) can use as an anchor. The body is per-step prose; the canonical shape lives implicitly in `step0..step4`.
3. **No diagnostic for contract-section drift.** `adapter doctor` checks file presence (`ADAPTER_FILE_MISSING`), sha256 drift (`ADAPTER_FILE_DRIFT`), schema version drift (`ADAPTER_SCHEMA_DRIFT`), and manifest staleness (`ADAPTER_MANIFEST_INVALID` / `ADAPTER_MANIFEST_MISSING`). None of these detect a managed file that exists, has not been hand-edited, but lacks the contract section because it was generated by a pre-P16 code-pact version.
4. **The three axes are unnamed.** Existing docs (cli-contract, dogfood, getting-started) reference each axis individually (when, verify, recover) but never name the axis or use a consistent vocabulary across them. A new contributor reading the templates and the docs has no shared lexicon for what the "agent contract" actually IS.

## Goals

- **Add a `## Agent contract` section** to each stable adapter's instruction file body. The section MUST cover the three named axes:

    A. **When to invoke code-pact** — the canonical command sequence (recommend → context → start → block/resume → complete → finalize) AND the v1.6 non-interactive bootstrap surfaces (`plan brief` / `plan constitution` 3-mode trifecta) AND `init --non-interactive`.

    B. **What to verify first** — the canonical pre-action checks (`code-pact recommend` for budget; `code-pact validate` for static integrity; `code-pact plan lint` for advisory) AND the v1.6 audit-aware additions (`task finalize --json` to see `write_audit`; `--audit-strict` to gate CI).

    C. **How to handle failures** — the canonical failure recovery patterns (`LOCK_HELD` retry; `VERIFICATION_FAILED` re-attempt; `TASK_FINALIZE_NOT_ELIGIBLE` route via `task complete` first) AND the v1.6 audit-specific patterns (`WRITES_AUDIT_STRICT_FAILED` → fix declared writes OR drop `--audit-strict`).

- **Lock the three-axis vocabulary** so future doc / template authors use the same terms. Each axis MUST be named verbatim (`When to invoke code-pact`, `What to verify first`, `How to handle failures`) in the section so a conformance regex can find them. Synonyms are allowed in the body text; the axis HEADINGS are load-bearing.

- **Add `ADAPTER_CONTRACT_DRIFT`** to `KNOWN_CODES.adapter`. Emitted by `adapter doctor` (single agent) and global `doctor` (every installed agent) when a managed instruction file is present but its `## Agent contract` section is missing or its three-axis sub-structure is incomplete. **Soft signal** — does NOT change the exit code of `adapter doctor` (the existing `ADAPTER_FILE_DRIFT` and friends still own that). Surfaces in `data.issues[]` only.

- **Preserve every existing Stable contract.** The instruction file path, role, manifest entry, and adapter selection logic are unchanged. The contract section is a textual addition inside the existing body. Hand-edited files trip the existing `ADAPTER_FILE_DRIFT` flow exactly as before; `--accept-modified` preserves user edits.

## The three axes (full content)

Each stable adapter's `## Agent contract` section MUST emit these three subsections in this order:

### A. When to invoke code-pact

The canonical "agents should run X before / instead-of Y" list. P16-T2/T3 templates cover:

- **Project bootstrap** (`init`, `plan brief`, `plan constitution`). Mention all four bootstrap modes per planning command: TTY wizard (default; requires a human terminal), `--from-file <yaml>` (P17-T1/T4), `--stdin` (P17-T2/T4), and flag-driven (P17-T3/T4). State the three-way pairwise mutex; reference `docs/cli-contract.md § plan brief` and `§ plan constitution` for the full envelope.
- **Per-task loop**: `code-pact recommend` (budget) → `code-pact task context` (input pack) → implement → `code-pact task complete` (verify + progress) → `code-pact task finalize --write` (design flip; opt-in `--audit-strict` for CI).
- **Multi-task coordination**: `code-pact phase runbook <phase>` / `code-pact task runbook <task>` for read-only sequencing. `code-pact phase reconcile <phase> --write` for batch finalize.
- **Static integrity**: `code-pact validate`, `code-pact plan lint`, `code-pact doctor`. Run them at PR boundaries, not per-task.

### B. What to verify first

The canonical pre-action checks. P16-T2/T3 templates cover:

- **Before implementing**: `code-pact recommend --phase <p> --task <t> --agent <a> --json` for model tier + budget + planning posture. The agent SHOULD adapt its planning depth to the returned profile.
- **Before declaring writes**: read the task's existing `writes` field and the project's `design/rules/protected-paths.md` (v1.6 P15-T3). Mirror real intent into `writes` so the v1.6 audit has a useful signal.
- **Before `task finalize --write`**: run the same command with `--json` (no `--write`) once to inspect the `data.write_audit` envelope. If `outside_declared` or `declared_unused` is non-empty, fix the declared writes first OR document why the deviation is expected.
- **In CI**: prefer `task finalize --audit-strict --write --json`. Promotes the audit advisory to exit-relevant. Distinct from `plan lint --strict` (plan-lint-scoped) — combining them is fine.

### C. How to handle failures

The canonical recovery patterns. P16-T2/T3 templates cover:

- **`LOCK_HELD`** (v1.5 P14): another code-pact mutation is in progress on the same project. Wait and retry (the lock is released on exit), or inspect `data.lock_holder` to identify the holder. Manual recovery: delete `.code-pact/locks/write.lock` if certain no process holds it.
- **`VERIFICATION_FAILED`** (`task complete`): the phase's `verification.commands` failed. Address the failing command, then re-run `task complete`. Idempotent — re-running on a passing state is safe.
- **`TASK_FINALIZE_NOT_ELIGIBLE`**: the task's derived state from `progress.yaml` is not `done`. Route via `code-pact task complete <task-id>` first; the derived state then advances and `task finalize` becomes eligible.
- **`WRITES_AUDIT_STRICT_FAILED`** (v1.6 P15-T6): `--audit-strict` was supplied AND the audit emitted at least one `TASK_WRITES_AUDIT_*` warning. Two routes:
    1. **Fix the declared writes** so the audit returns clean (preferred — keeps the gate honest).
    2. **Drop `--audit-strict`** if the warning is structural (e.g. release-prep slice touches `CHANGELOG.md` that no single task declares); document the reason in the PR body.
- **`CONFIG_ERROR`** (general): structural argument problem — mutually exclusive flags, missing positional, `--audit-strict` / `--base-ref` without `--json`. Re-read the command surface.

## Per-adapter scope

| Adapter | Stability | P16 in-scope | Notes |
| --- | --- | --- | --- |
| `claude-code` | Stable | ✅ T2 | Primary adapter; P14 dogfood golden. |
| `codex` | Stable | ✅ T3 | Mirror of claude-code shape, different instruction filename + role. |
| `generic` | Stable | ✅ T3 | Slimmer body; agent contract section is the substantive new content. |
| `cursor` | Experimental | ❌ | Out-of-scope. Upstream `.cursor/rules/*.mdc` format is moving; revisit when stable. |
| `gemini-cli` | Experimental | ❌ | Out-of-scope. Same rationale as cursor. |

The conformance test (P16-T4) extends only the stable adapters' assertions. cursor / gemini-cli stay excluded — same posture as the existing P14 conformance suite.

## ADAPTER_CONTRACT_DRIFT diagnostic (P16-T5)

### Detection logic

Per-managed instruction file:

1. Read the file body.
2. Locate the literal heading `## Agent contract` (case-sensitive).
3. If absent → emit `ADAPTER_CONTRACT_DRIFT` with `data.kind = "section_missing"`.
4. If present, scan the body following the heading for three sub-headings (the exact heading text is locked by this RFC: `When to invoke code-pact`, `What to verify first`, `How to handle failures`).
5. If fewer than three sub-headings present → emit `ADAPTER_CONTRACT_DRIFT` with `data.kind = "axes_incomplete"` and `data.missing_axes: string[]`.

Severity: **warning** (advisory). The diagnostic is informational — it does NOT change `adapter doctor`'s overall ok/exit shape. The existing `ADAPTER_FILE_DRIFT` (hash mismatch) and friends continue to own the exit-relevant signal.

### Why a separate code (not `ADAPTER_FILE_DRIFT` extension)

`ADAPTER_FILE_DRIFT` fires when the file's sha256 differs from the manifest record. That signal means "the file was hand-edited", and the existing `--accept-modified` flow takes care of it.

`ADAPTER_CONTRACT_DRIFT` fires when the file's sha256 MATCHES the manifest record (no hand edit) but the file was generated by a pre-P16 code-pact and lacks the new section. The diagnoses are independent. Conflating them would force users to choose between `--accept-modified` (keep my edits but ignore the contract drift) and `--force` (overwrite my edits to get the contract section back). Splitting them lets `adapter upgrade --write` reinstate the contract section while preserving user edits.

### Recovery path

1. `code-pact adapter doctor --agent <a> --json` → see `ADAPTER_CONTRACT_DRIFT`.
2. `code-pact adapter upgrade --agent <a> --check --json` → preview the regen.
3. `code-pact adapter upgrade --agent <a> --write --json` (optionally `--accept-modified` if the file is hand-edited too).

The recovery uses existing v0.9 adapter upgrade machinery; no new flag or command.

## Why a textual section, not a structured field

Two alternatives were considered:

1. **Structured field on the manifest** (e.g. `agent_contract: { axes: ["when", "verify", "fail"], v: 1 }`). Rejected because the contract content is what the agent READS — it lives in the instruction file body by definition. A manifest field would only carry hashes or version markers, not the content itself; the conformance test needs to inspect the body anyway.
2. **Separate per-agent contract file** (e.g. `.claude/contract.md`). Rejected because it splits the instruction surface in two — agents would have to learn to read both files, and `adapter doctor` would need to track two file states per agent. The instruction file is already the agent's entry point; the contract belongs there.

A textual section inside the existing instruction file is the minimum cost intervention that delivers the contract.

## Conformance test extension (P16-T4)

`tests/integration/adapter-conformance.test.ts` already asserts, per stable adapter:

- Manifest file list matches the expected fixture (`tests/fixtures/adapters/<agent>/expected-files.txt`).
- Instruction file mentions the four canonical CLI commands (`code-pact recommend`, `code-pact task context`, `code-pact task complete`, `code-pact validate`).
- `--json` is mentioned.
- Install→install idempotency.
- Zod manifest round-trip.
- File path safety (`assertSafeRelativePath`).

P16-T4 adds, per stable adapter:

- Literal `## Agent contract` heading present in the instruction body.
- Three sub-headings present verbatim: `When to invoke code-pact`, `What to verify first`, `How to handle failures`.
- At least one mention of each v1.6 audit surface in the body: `--audit-strict`, `--from-file`, `--stdin`, `write_audit`.

The `expected-files.txt` fixtures don't change (the instruction file path is unchanged); only the body content's assertions extend.

## Backward compatibility

- **Existing projects on v1.6 or earlier**: `adapter upgrade --check` shows `ADAPTER_FILE_DRIFT` (hash changed) on first contact with v1.7. The user runs `adapter upgrade --write` to take the new template. If they had hand-edited the file, `--accept-modified` preserves the edits but `ADAPTER_CONTRACT_DRIFT` continues to fire until the agent contract section is added back manually.
- **Existing CI consumers of `adapter doctor --json`**: the envelope shape is unchanged. The new code lives in `data.issues[]` as an additive entry; existing checks for `ok: true` continue to pass (the new code is severity warning, not error).
- **Locale variants**: en-US ships first; ja-JP follows in the same PR (T2 / T3). The contract section's three axis HEADINGS are locked in English even in the ja-JP variant — they're load-bearing for the conformance regex. The body text under each heading is localised normally.
- **Adapter manifest schema**: unchanged. No new field, no new schema_version bump.

## Migration

A short v1.6.x → v1.7.0 migration section in `docs/migration.md` will cover:

1. Run `code-pact adapter doctor --json` — expect `ADAPTER_CONTRACT_DRIFT` warnings on every previously-installed stable adapter.
2. Run `code-pact adapter upgrade <agent> --check --json` to preview each adapter's regen.
3. Run `code-pact adapter upgrade <agent> --write --json` (optionally `--accept-modified` per-agent) to apply.

No mandatory action: the new warning is advisory; the v1.0 stable contract is unchanged.

## Non-goals (recap)

- cursor / gemini-cli adapters (experimental — out-of-scope).
- LLM API integration of any kind.
- Adapter file shape changes beyond textual body extension.
- Per-locale customisation of the new section's axis headings (the heading strings are load-bearing).
- Forcing the new section onto hand-edited instruction files (`--accept-modified` continues to govern that).
- A formal "agent contract" schema for OTHER projects to publish their own contracts (this RFC scopes the term to code-pact's own stable adapters).

## Deferred to a future RFC

- **Auto-injection of the contract section on `adapter upgrade --write`** when the existing file is `--accept-modified` (i.e. detect the missing section, surgically add it without overwriting other edits). v1.7 ships the diagnostic; the surgical-injection mechanism is a future refinement once `ADAPTER_CONTRACT_DRIFT` has shown enough false-positive / false-negative data to design the right machinery.
- **Generalising the contract format** to a versioned schema (`agent_contract_v: 1`, etc.). Premature optimisation given there's exactly one contract version today.
- **cursor / gemini-cli conformance**: deferred to a separate phase that promotes either adapter to stable.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Don't ship P16; let agents read CLI docs directly | Agents read the instruction file on day one. CLI docs are out of scope for "what should I do next?" — the instruction file is the single entry point we control. |
| Embed the entire CLI surface in the instruction file | Bloat. The contract section is intentionally short (three axes, ~30 lines per adapter). Agents who want depth follow the doc link. |
| Use a YAML / JSON file instead of Markdown | The file is already Markdown (`CLAUDE.md` / etc.). Mixing formats inside the same surface is worse than slightly less structured Markdown. |
| Wait for cursor / gemini-cli to stabilise before standardising | Stable adapter set is closed at three. Waiting on experimental upstreams indefinitely defers a v1.7 win. |
| Skip `ADAPTER_CONTRACT_DRIFT`; rely on `ADAPTER_FILE_DRIFT` alone | Conflates "hand-edited" with "stale template". Splitting the two diagnostics lets users keep their edits AND get the new section. |

## Acceptance criteria

- This document carries `Status: accepted` before any P16-T2/T3/T4/T5 implementation PR opens.
- `tests/integration/json-stdout.test.ts` continues to pass.
- `KNOWN_CODES.adapter` extension is additive: one new code (`ADAPTER_CONTRACT_DRIFT`). `KNOWN_CODES.public` is unchanged.
- Stable adapter fixtures (`tests/fixtures/adapters/<agent>/expected-files.txt`) keep the same file count and the same paths; only body content changes.
- Human-mode and `--json` envelopes for every existing command are unchanged.

## Open questions

None at proposal time. The diagnostic name, axis heading strings, and three-axis taxonomy were all settled during P16-T1 drafting. If implementation finds an issue, this RFC opens a follow-up amendment per the v1.5 P14 lifecycle precedent.
