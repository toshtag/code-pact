# RFC: Spec Kit bridge

**Status:** proposed (P18, 2026-05)
**Scope:** one new top-level CLI command, `code-pact spec import`, that ingests external spec-driven planning artifacts (initially the `tasks.md` file format used by Spec Kit and similar tools) into code-pact phase YAML drafts. Read-only, one-way, opt-in. Adds new module `src/core/spec-import/` with a pure parser + a transform; adds `src/commands/spec-import.ts` for the CLI surface. No schema changes to existing phase YAML. No new error codes beyond `CONFIG_ERROR` (reused).
**Owners:** maintainer
**Related:**
- [design/decisions/task-readiness-schema-rfc.md](task-readiness-schema-rfc.md) (P10 — the phase YAML task schema the importer must produce valid output against).
- [design/decisions/planning-ux-init-hardening-rfc.md](planning-ux-init-hardening-rfc.md) (P13 — `phase import` for the bulk YAML import path; `spec import` is the spec-derived sibling).
- [design/decisions/agent-contract-rfc.md](agent-contract-rfc.md) (P16 — sets the precedent for "code-pact is a control plane that other tools' outputs flow into").

## Status lifecycle

- This document opens at status **proposed** in PR1 (the P18-T1 PR).
- After review approval, and **before** PR1 merges (or in a small follow-up PR per the P11–P16 precedent), the maintainer flips the status line at the top of this file to **accepted**.
- P18-T1 is considered done only after PR1 — with the status line reading `accepted` — has landed on main.
- Subsequent implementation PRs (P18-T2..T5) treat the accepted document as load-bearing.

## Background

code-pact has shipped two complementary entry points for getting work into a project's roadmap:

- **`phase import <file>`** (v0.4+, hardened v1.4 P13) — bulk-import a YAML roadmap, typically produced by an AI agent fed `code-pact plan prompt`'s output. Optimised for the "agent generates a draft, user ingests it" flow.
- **`plan brief` / `plan constitution`** (v0.2+, v1.6 P17 non-interactive) — author the project's intent so `plan prompt` has something to ground itself in. Now supports `--from-file`, `--stdin`, and flag-driven modes.

Neither covers the case where the user has **already** produced a planning artifact using a different spec-driven tool (Spec Kit being the most common, but the same pattern applies to other markdown-with-checklists formats). Today, those users have to hand-translate the existing artifact into one of the formats code-pact accepts. That's friction the project's positioning ("control plane that ingests planning artifacts") explicitly promises to eliminate.

The original P15+ roadmap plan (the `/Users/tochi/.claude/plans/` document that opened the v1.6 cycle) named this as a phase: "Spec Kit bridge — read-only importer". This RFC locks the design decisions before any importer code is written.

## Problem statement

1. **Users with existing spec-driven artifacts have no native entry point.** A `tasks.md` from Spec Kit or a similar markdown-with-checklists file from any tool that produces them — there's no way to feed those into code-pact short of hand-translating them.
2. **`phase import` is the wrong shape for spec-derived content.** `phase import` expects code-pact-shaped YAML. Asking the user to first transform Spec Kit's markdown into YAML defeats the purpose.
3. **AI-assisted regeneration is worse than parsing.** Pointing the user at "use `plan prompt` and an agent" works but loses the structure the original tool already provided. A deterministic parser preserves the user's existing decisions; an AI round-trip might rewrite them.
4. **Spec Kit format may evolve, so the supported subset must be explicit.** Without a documented supported subset, users can't tell whether their tasks.md will parse cleanly; upstream changes in Spec Kit risk silent breakage.

## Goals

- **Ship a `code-pact spec import --from <path> --phase-id <id> [--write] [--json]`** command. Read-only one-way (Spec Kit → code-pact, never back). Dry-run default; `--write` opt-in.
- **Document the supported Spec Kit subset explicitly.** Heading 3 sections (`### Section Name`) as the phase-task grouping unit; `- [ ]` checkbox list items under each section as task candidates. Other Markdown constructs (other heading levels, prose paragraphs, code blocks, tables) are silently dropped from the import but counted in a `skipped_lines` advisory so the user sees what the parser ignored.
- **Output valid existing phase YAML.** The importer produces a draft `design/phases/<id>-imported.yaml` that passes `plan lint`. Generated tasks carry minimal P10 fields (type, ambiguity, risk, context_size, write_surface, verification_strength, expected_duration, status) set to sensible defaults; the description is the verbatim text of the original `- [ ]` line. The user is expected to fill in `reads` / `writes` / `acceptance_refs` after the import — same workflow as `phase import` with the lenient task schema (v1.4+).
- **Add a parallel `--suggest-from <path>` mode for spec.md / plan.md** that surfaces brief / constitution candidates **without** writing files. The user pipes the suggestions into `plan brief --from-file` / `plan constitution --from-file` if they accept them.
- **Reuse `CONFIG_ERROR` exclusively.** No new public error codes. Failure modes (missing file, unsafe path, --phase-id collision, no sections parsed) all return `CONFIG_ERROR` (exit 2) with structured `data.detail` enums.

## Supported Spec Kit subset

The parser accepts the following minimal Markdown grammar:

```markdown
### Section name (becomes phase YAML task group)

- [ ] First task description (becomes one task candidate)
- [ ] Second task description
- [x] Checked tasks are ignored (Spec Kit marks them done)

### Another section

- [ ] More tasks
```

Constructs that the parser **silently drops** (counted in `skipped_lines`):

- Other heading levels (`#`, `##`, `####`, `#####`)
- Bullet items without checkboxes (`- some bullet`)
- Numbered lists (`1. some item`)
- Prose paragraphs
- Code blocks
- Tables
- HTML comments (`<!-- ... -->`)
- Frontmatter (YAML/TOML at the file head)

The supported subset is intentionally minimal so the parser can be small and deterministic. Users with richer Spec Kit input run the importer to extract the structured tasks, then hand-edit the generated YAML for the parts the parser didn't carry over. This is more honest than pretending to parse a richer subset and silently mis-mapping fields.

## Field mapping

Each parsed `- [ ]` line becomes one code-pact task with these defaults:

| code-pact task field | Source / default |
| --- | --- |
| `id` | Auto-generated `<phase-id>-T<n>` where `<n>` starts at 1 and increments. Conflicts with existing tasks are not possible because the importer writes to a new phase YAML at `design/phases/<id>-imported.yaml`. |
| `description` | Verbatim `- [ ]` line text (leading checkbox stripped). |
| `type` | `"feature"` (the most common default; user adjusts to `refactor` / `docs` / etc. by hand if needed). |
| `ambiguity`, `risk`, `context_size`, `write_surface`, `verification_strength`, `expected_duration` | All `"medium"` defaults — the safest middle ground that doesn't bias `recommend` toward unwarranted complexity or unwarranted simplicity. |
| `status` | `"planned"` (P11+ contract — newly imported tasks always start planned). |
| `reads`, `writes`, `acceptance_refs`, `depends_on`, `decision_refs` | All omitted (P10 optional fields). The user adds them after the import. The v1.4 `phase import` precedent is identical: lenient task schema with defaults reported in `completed_fields`. |

The generated phase carries:

| phase field | Source / default |
| --- | --- |
| `id` | From `--phase-id <id>`. |
| `name` | First `### Section name` heading, or `--phase-id <id>` if no sections. |
| `weight` | `20` (matches the P10–P14 median). |
| `confidence` | `"medium"`. |
| `risk` | `"medium"`. |
| `status` | `"planned"`. |
| `objective` | "Imported from `<source>` on `<date>`. Edit this objective to reflect the phase's actual scope." |
| `verification.commands` | `["pnpm test"]` (single placeholder; user adjusts). |
| `tasks` | The parsed `- [ ]` items, with the field mapping above. |

The generated YAML is **valid existing phase YAML** — `plan lint` accepts it after the import without any schema migration.

## Command surface

### `spec import --from <path> --phase-id <id> [--write] [--force] [--json]`

Reads the file at `<path>` (must pass `assertSafeRelativePath` — relative to cwd, no `..`, no absolute, no leading `~`). Parses via the T2 parser. Transforms to a phase YAML draft.

**Dry-run (default):**

- Prints the generated YAML to stdout (human mode) OR includes it in the `data.phase_yaml` field (`--json` mode).
- Does NOT write any file.

**`--write`:**

- Writes the YAML to `design/phases/<id>-imported.yaml` via `atomicWriteText`.
- If `design/phases/<id>-imported.yaml` already exists, returns `CONFIG_ERROR` unless `--force` is passed (mirrors `plan brief` / `plan constitution` shape).
- Does NOT add the new phase to `design/roadmap.yaml` — that's the user's explicit follow-up step (`phase add --id <id>` or hand-edit). This is intentional: roadmap mutation is a P14-governed surface, and silently coupling it to an import would conflate two operations.

**JSON envelope (success):**

```json
{
  "ok": true,
  "data": {
    "kind": "would_import" | "imported",
    "source_path": "tasks.md",
    "phase_id": "P18-imported",
    "sections_imported": 3,
    "tasks_imported": 12,
    "skipped_lines": 4,
    "output_path": "design/phases/P18-imported-imported.yaml",
    "phase_yaml": "id: P18-imported\nname: ...\n...",
    "warnings": [
      "skipped 2 lines under 'Section Three' (no checkbox)",
      "skipped 1 unsupported heading: '#### Sub-detail'"
    ]
  }
}
```

`kind`: `"would_import"` on dry-run, `"imported"` after `--write`. `output_path` is `null` on dry-run.

**JSON envelope (failure):**

```json
{
  "ok": false,
  "error": {
    "code": "CONFIG_ERROR",
    "message": "..."
  },
  "data": {
    "detail": "unsafe_path" | "unreadable" | "no_sections_parsed" | "phase_yaml_exists" | "phase_id_invalid",
    "source_path": "tasks.md",
    "phase_id": "..."  // when applicable
  }
}
```

### `spec import --suggest-from <path> --json`

Reads a Spec Kit `spec.md` or `plan.md` and surfaces candidate brief / constitution fields **without writing any file**. Scope is read-only suggestion only — the user is expected to pipe the output into `plan brief --from-file` / `plan constitution --from-file` if they accept the suggestions.

JSON envelope:

```json
{
  "ok": true,
  "data": {
    "source_path": "spec.md",
    "brief_candidates": {
      "what": "...",
      "who": "...",
      "differentiator": "..."
    },
    "constitution_candidates": {
      "description": "...",
      "principles": ["..."]
    },
    "skipped_sections": ["..."]
  }
}
```

Each candidate field is independently optional — only fields the extractor recognised get emitted. This is the read-only mode; auto-apply to `plan brief --from-file` is left as a user-side concern in v1.8. A future RFC may add `spec import --suggest-from <path> --apply-brief` if usage data shows the manual pipe step is the bottleneck.

### Mutex constraints

- `--from` and `--suggest-from` are mutually exclusive. Passing both returns `CONFIG_ERROR` with `data.detail: "mutex_violation"`.
- `--phase-id` is required with `--from` (the importer needs to know what to call the generated phase). Passing `--from` without `--phase-id` returns `CONFIG_ERROR` with `data.detail: "missing_phase_id"`.
- `--suggest-from` ignores `--phase-id` if both are passed (the suggestion mode has no use for it; we silently accept to keep the flag combinator simple).

## Backward compatibility

- **New command, no impact on existing surfaces.** `phase import`, `plan brief`, `plan constitution`, and every other v1.0+ Stable command are unchanged.
- **No new public error codes.** Failures reuse `CONFIG_ERROR` (the public error surface stays size-stable).
- **No phase YAML schema changes.** The importer writes valid existing phase YAML — `plan lint`, `validate`, and every downstream consumer see it as just another phase file.
- **Conforms to v1.5.1 strict-clean dogfood corpus rules.** The importer does NOT add the generated phase to `design/roadmap.yaml`; the user runs `phase add --id <id>` separately. Roadmap mutation stays governed by P14's chokepoint contract.
- **Conformance + `--strict`**: `plan lint --include-quality --strict` against an imported phase will likely warn about `PLACEHOLDER_VERIFICATION` (the default `pnpm test` may not match the project's actual verify command), `WEAK_DOD` (the default objective is generic), and `TASK_READS_NO_MATCH` if the user added reads. These are normal post-import advisories — same posture as a brand-new phase added by hand. The dogfood corpus is unaffected since code-pact's own design/phases/*.yaml are never produced by the importer.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Implement a full Spec Kit-compatible spec generator | Out of charter. code-pact is a control plane, not a spec authoring tool. Re-implementing Spec Kit would be both wasteful and would invite the "code-pact replaces Spec Kit" misframing. |
| Skip the bridge; tell users to use `plan prompt` + an agent | Loses the structure Spec Kit already preserved. AI round-trip risks rewriting decisions the user made deliberately. Worse user experience for a use case the project's positioning explicitly promised. |
| Parse a richer Spec Kit subset (numbered lists, tables, etc.) | Higher false-positive rate (silent mis-mapping). The minimal subset is honest about what's supported and what isn't; richer parsing trades precision for opacity. |
| Auto-apply brief / constitution suggestions to disk | Couples extraction with file write. Two operations should be two opt-ins. v1.8 ships read-only suggestion; auto-apply is a future refinement if data shows the manual step is the bottleneck. |
| Add the generated phase to `design/roadmap.yaml` automatically | Couples import with roadmap mutation. P14 governance explicitly chokes roadmap.yaml writes; conflating two operations would break that contract. User runs `phase add --id <id>` as the explicit follow-up. |
| Use a single `code-pact import spec` (subcommand vs new top-level) | Adds a sub-command tree level without a clear win. `spec import` reads more naturally and the future `spec` namespace is empty — if a sibling `spec export` ships later, the namespace exists; if not, the single command sits comfortably. |

## Open questions

None at proposal time. The supported-subset decision, the field-mapping defaults, the JSON envelope shape, the mutex constraints, and the deferred auto-apply for suggestions were all settled during P18-T1 drafting. If implementation finds an issue, this RFC opens a follow-up amendment per the v1.5 P14 lifecycle precedent.

## Deferred to a later phase / RFC

- **Bidirectional sync** (code-pact phase YAML → Spec Kit tasks.md). Out of charter; code-pact stays a control plane that other tools' outputs flow into.
- **Live watch / auto-sync** on tasks.md file change. Importer stays explicitly invoked.
- **Auto-apply `--suggest-from` candidates** to `design/brief.md` / `design/constitution.md` via piping. v1.8 ships suggestion-only.
- **Importers for non-Spec-Kit formats** (Cursor rules, Linear specs, Notion exports, etc.). Each warrants its own phase + RFC with its own supported-subset analysis.
- **Phase + roadmap atomic add** as a single command. Would conflate the two governance surfaces; if real usage shows the two-step pattern is friction, a future RFC can design a coupled command.

## Acceptance criteria

- This document carries `Status: accepted` before any P18-T2/T3/T4/T5 implementation PR opens.
- `tests/integration/json-stdout.test.ts` continues to pass (the new `spec import` command added under Stable v1.0 commands).
- `KNOWN_CODES.public` is unchanged — no new public error codes; `CONFIG_ERROR` is reused.
- Phase YAML schema is unchanged.
- Human-mode and `--json` envelopes for every existing command are unchanged.
- The supported Spec Kit subset and the field-mapping defaults are locked in this RFC; T2/T3 implementation may not change them without a separate RFC-update PR.
