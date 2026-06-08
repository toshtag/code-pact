# RFC: Spec Kit bridge

**Status:** accepted (P18, 2026-05)
**Scope:** one new top-level CLI command, `code-pact spec import`, that ingests external spec-driven planning artifacts (initially the `tasks.md` format used by Spec Kit and similar markdown-with-checklists tools) into code-pact phase YAML drafts. Read-only, one-way (Spec Kit → code-pact), opt-in. New module `src/core/spec-import/` (pure parser + transform) + `src/commands/spec-import.ts`. No phase-YAML schema changes. No new error codes — `CONFIG_ERROR` reused.
**Owners:** maintainer
**Related:** [task-readiness-schema](task-readiness-schema-rfc.md) (P10 — the task schema the importer must emit valid output against) · [planning-ux-init-hardening](planning-ux-init-hardening-rfc.md) (P13 — `phase import` for bulk YAML; `spec import` is the spec-derived sibling) · [agent-contract](agent-contract-rfc.md) (P16 — "code-pact is a control plane other tools' outputs flow into").

## Summary

Users who already produced a planning artifact with a different spec-driven tool (Spec Kit `tasks.md` most commonly) had no native entry point — `phase import` expects code-pact-shaped YAML, and an AI `plan prompt` round-trip risks rewriting decisions the user made deliberately. `spec import` is a **deterministic parser** that preserves that structure: `--from <path> --phase-id <id> [--write]` produces a draft `design/phases/<id>-imported.yaml` that passes `plan lint`, plus a parallel `--suggest-from <path>` mode that surfaces brief/constitution candidates without writing. User-facing guide: [docs/spec-kit-bridge.md](../../docs/spec-kit-bridge.md).

## Decisions

1. **Deterministic parser, not AI regeneration.** A pure parser preserves the user's existing structure; an AI round-trip via `plan prompt` loses it and can rewrite deliberate decisions.
2. **Explicit, minimal supported subset.** Only `### Section` headings (the phase-task grouping unit) and `- [ ]` checkbox items under them (task candidates) are parsed. `- [x]` checked items are ignored (Spec Kit marks them done). Everything else — other heading levels, non-checkbox bullets, numbered lists, prose, code blocks, tables, HTML comments, frontmatter — is **silently dropped but counted** in a `skipped_lines` advisory so the user sees what was ignored. Minimal-and-honest beats richer-but-silently-mis-mapping.
3. **Emit valid existing phase YAML.** No schema migration — `plan lint`/`validate` see just another phase file. Each `- [ ]` line becomes one task; the user fills `reads`/`writes`/`acceptance_refs` afterward (same lenient-schema workflow as v1.4 `phase import`).
4. **Do not mutate `design/roadmap.yaml`.** The import writes only the phase file; adding it to the roadmap is the user's explicit follow-up (`phase add --id <id>`). Roadmap mutation is the P14-governed chokepoint surface; coupling an import to it would conflate two operations.
5. **Reuse `CONFIG_ERROR` exclusively.** No new public error codes; failure modes are distinguished by a `data.detail` enum.

## Field mapping (locked contract)

T2/T3 implementation may not change these defaults without a separate RFC-update PR.

- **Task `id`** — auto `<phase-id>-T<n>`, `n` from 1. No collision possible (new file at `design/phases/<id>-imported.yaml`).
- **Task `description`** — verbatim `- [ ]` line text, leading checkbox stripped.
- **Task `type`** — `"feature"` (most common default; user re-types by hand).
- **Task `ambiguity` / `risk` / `context_size` / `write_surface` / `verification_strength` / `expected_duration`** — all `"medium"` (neutral middle ground so `recommend` is biased neither toward nor away from complexity).
- **Task `status`** — `"planned"` (P11+ contract: imported tasks start planned).
- **Task `reads` / `writes` / `acceptance_refs` / `depends_on` / `decision_refs`** — omitted (P10 optional); user adds after import.
- **Phase `id`** — from `--phase-id`. **`name`** — first `### Section` heading, else the phase id. **`weight`** — `20` (P10–P14 median). **`confidence` / `risk` / `status`** — `"medium"` / `"medium"` / `"planned"`. **`objective`** — `"Imported from <source> on <date>. Edit this objective…"`. **`verification.commands`** — `["pnpm test"]` placeholder. **`tasks`** — the parsed items.

## Command surface / contract

`spec import --from <path> --phase-id <id> [--write] [--force] [--json]`

- `<path>` must pass `assertSafeRelativePath` (relative to cwd; no `..`, absolute, or leading `~`).
- **Dry-run (default)** — prints generated YAML to stdout (human) or `data.phase_yaml` (`--json`); writes nothing. `data.kind` = `"would_import"`, `output_path` = `null`.
- **`--write`** — writes `design/phases/<id>-imported.yaml` via `atomicWriteText`; `data.kind` = `"imported"`. Existing file → `CONFIG_ERROR` unless `--force` (mirrors `plan brief`/`constitution`). Never touches `design/roadmap.yaml`.
- **Success `data`** — `kind`, `source_path`, `phase_id`, `sections_imported`, `tasks_imported`, `skipped_lines`, `output_path`, `phase_yaml`, `warnings[]`.

`spec import --suggest-from <path> --json` — reads a Spec Kit `spec.md`/`plan.md` and surfaces `data.brief_candidates` (`what`/`who`/`differentiator`) and `data.constitution_candidates` (`description`/`principles[]`) plus `skipped_sections[]`. **Writes no file** — each field is independently optional (only recognised fields emitted); the user pipes accepted output into `plan brief --from-file` / `plan constitution --from-file`.

**Error contract** — all failures return `CONFIG_ERROR` (exit 2) with a `data.detail` enum:
`unsafe_path` · `unreadable` · `no_sections_parsed` · `phase_yaml_exists` · `phase_id_invalid` · `mutex_violation` (`--from` + `--suggest-from` together — they are mutually exclusive) · `missing_phase_id` (`--from` without the required `--phase-id`). `--suggest-from` silently ignores `--phase-id` if both are passed.

**Backward compatibility** — additive new command. `phase import`, `plan brief`, `plan constitution`, and every v1.0+ Stable command are unchanged; `KNOWN_CODES.public` is unchanged; no phase-YAML schema change. An imported phase may draw normal post-import `plan lint --strict` advisories (`PLACEHOLDER_VERIFICATION`, `WEAK_DOD`, `TASK_READS_NO_MATCH`) — same posture as a hand-added phase. The dogfood corpus is unaffected (code-pact's own `design/phases/*.yaml` are never importer-produced).

## Alternatives considered

- **Full Spec Kit-compatible spec generator** — rejected; out of charter (control plane, not a spec authoring tool) and invites the "code-pact replaces Spec Kit" misframing.
- **Skip the bridge; tell users to use `plan prompt` + an agent** — rejected; loses Spec Kit's structure and risks an AI round-trip rewriting deliberate decisions.
- **Parse a richer subset (numbered lists, tables, …)** — rejected; higher silent mis-mapping rate. The minimal subset is honest about what it does and doesn't carry.
- **Auto-apply brief/constitution suggestions to disk** — rejected; couples extraction with file write. Two operations → two opt-ins; v1.8 ships read-only suggestion.
- **Auto-add the generated phase to `design/roadmap.yaml`** — rejected; conflates import with the P14-governed roadmap-mutation chokepoint. User runs `phase add --id <id>` explicitly.
- **`code-pact import spec` (subcommand vs new top-level)** — rejected; adds a sub-tree level without a win. `spec import` reads more naturally and leaves room for a future `spec export` sibling.

## Open questions

None at acceptance. The supported subset, field-mapping defaults, JSON envelope shape, mutex constraints, and the deferred suggestion auto-apply were all settled during P18-T1 drafting; an implementation issue opens a follow-up amendment per the P14 lifecycle precedent.

## Deferred to a later phase / RFC

- **Bidirectional sync** (phase YAML → `tasks.md`) — out of charter.
- **Live watch / auto-sync** on `tasks.md` change — importer stays explicitly invoked.
- **Auto-apply `--suggest-from` candidates** to `design/brief.md` / `design/constitution.md` — v1.8 is suggestion-only; a future `--apply-brief` if data shows the manual pipe is the bottleneck.
- **Importers for non-Spec-Kit formats** (Cursor rules, Linear, Notion, …) — each warrants its own phase + RFC + supported-subset analysis.
- **Phase + roadmap atomic add** as one command — would conflate the two governance surfaces; revisit only if the two-step pattern proves to be real friction.

## References

- RFCs: [task-readiness-schema](task-readiness-schema-rfc.md) (P10) · [planning-ux-init-hardening](planning-ux-init-hardening-rfc.md) (P13) · [agent-contract](agent-contract-rfc.md) (P16).
- Docs: [docs/spec-kit-bridge.md](../../docs/spec-kit-bridge.md).
