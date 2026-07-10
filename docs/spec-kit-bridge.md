# Spec Kit bridge

`code-pact spec import` is a **dry-run-first, one-way bridge** that ingests external spec-driven planning artifacts (initially the `tasks.md` file format used by Spec Kit and similar tools) into code-pact's phase YAML. It never mutates the source artifact; `--write` can persist an unregistered draft phase inside the code-pact project.

> **code-pact does not re-implement Spec Kit.** It accepts artifacts produced by other tools so teams already invested in Spec Kit can adopt code-pact without throwing their planning work away. If you do not already have a `tasks.md`, you do not need this command — start with `code-pact init` and `code-pact plan brief`.

This bridge lives under the top-level `spec` namespace. Two complementary modes share the same command:

For generated flags, usage, and examples, see the generated [CLI reference § `spec import`](cli-reference.generated.md#spec-import). This page focuses on workflow, semantics, and the supported input subset.

| Mode | What it does | Writes a file? |
| --- | --- | --- |
| Import mode (`--from` + `--phase-id`) | Parses tasks.md → draft phase YAML | Only with `--write` (to `design/phases/<id>-imported.yaml`) |
| Suggestion mode (`--suggest-from`) | Extracts brief / constitution candidates | Never |

## Mode 1 — importing `tasks.md` into a phase YAML draft

### What gets parsed

The parser accepts a deliberately minimal Markdown subset so it stays small and deterministic:

```markdown
### Setup (becomes one phase task group)

- [ ] Install dependencies (becomes one task candidate)
- [ ] Configure environment

### Implementation

- [ ] Build the parser
- [x] Already done — silently dropped
- [ ] Wire CLI command
```

Constructs **silently dropped** (counted in `skipped_lines`):

- Other heading levels (`#`, `##`, `####`, `#####`, `######`)
- Bullet items without checkboxes
- Numbered lists
- Checked items (`- [x]`)
- Prose paragraphs
- Code fences
- Tables
- HTML comments
- Frontmatter (YAML/TOML at the file head)

The supported subset is intentionally narrow — for richer Spec Kit input, run the importer to extract the structured tasks, then hand-edit the generated YAML for the rest. This is more honest than silently mis-mapping fields.

### Generated phase shape

Each `- [ ]` line becomes one code-pact task with sensible defaults:

| code-pact task field | Default |
| --- | --- |
| `id` | Auto-generated `<phase-id>-T<n>` |
| `description` | `[Section title] verbatim task text` |
| `type` | `feature` |
| `ambiguity` / `risk` / `context_size` / `write_surface` / `verification_strength` / `expected_duration` | `medium` |
| `status` | `planned` |
| `reads` / `writes` / `acceptance_refs` / `depends_on` / `decision_refs` | omitted (you add them after the import) |

The phase itself carries `weight: 20`, `confidence: medium`, `risk: medium`, `status: planned`, a generic objective citing the source path, a generic `definition_of_done`, and `verification.commands: [pnpm test]`. **All of these are intentionally generic — you will edit them.**

### Dry-run is the default

```sh
# Dry-run: prints the generated YAML to stdout, writes nothing
code-pact spec import --from tasks.md --phase-id P-feature

# JSON envelope dry-run (machine-readable)
code-pact spec import --from tasks.md --phase-id P-feature --json
```

When you are happy with what the dry-run produced:

```sh
# Persist to design/phases/P-feature-imported.yaml
code-pact spec import --from tasks.md --phase-id P-feature --write

# Overwrite an existing imported YAML
code-pact spec import --from tasks.md --phase-id P-feature --write --force
```

### What the importer does NOT do

- **It does not add the new phase to `design/roadmap.yaml`.** `spec import --write` writes an *unregistered* draft at `design/phases/<id>-imported.yaml`; code-pact treats `design/roadmap.yaml` as a chokepoint, so coupling import to roadmap mutation would silently bypass that contract. To adopt the draft, review it and then add a `design/roadmap.yaml` entry that points at that file. (`phase add` is **not** that step — it creates a *fresh* phase from flags, so it would not register the imported draft.)
- **It does not call any LLM API.** The importer is a pure parser + transform.
- **It does not watch the source file.** You re-run `spec import` explicitly when `tasks.md` changes.
- **It does not support every Spec Kit construct.** Only the documented subset above. Constructs outside the subset are dropped, not silently mis-mapped.

### Post-import follow-up

```sh
# 1. Review the generated phase
$EDITOR design/phases/P-feature-imported.yaml

# 2. Adopt the reviewed draft explicitly: add a design/roadmap.yaml entry
#    that points at design/phases/P-feature-imported.yaml.
#    (Do NOT use `phase add` for this — it creates a fresh phase from flags,
#     not a registration of the imported draft.)

# 3. Validate
code-pact plan lint --json
code-pact validate --json

# 4. (Optional) See the recommended per-task lifecycle
code-pact task runbook P-feature-T1 --json
```

Running `plan lint --include-quality --strict` against an imported phase will likely warn about `PLACEHOLDER_VERIFICATION`, `WEAK_DOD`, and (once you add reads) `TASK_READS_NO_MATCH`. These are normal post-import advisories — the same posture as a brand-new phase added by hand. Fix them as you fill in the phase's real intent.

## Mode 2 — extracting brief / constitution candidates from `spec.md` / `plan.md`

```sh
# Read-only suggestion mode
code-pact spec import --suggest-from spec.md --json
code-pact spec import --suggest-from plan.md --json
```

The extractor recognises a conservative set of canonical Spec Kit headings (and their common synonyms) and returns a structured envelope:

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
    "recognised_sections": ["Problem statement", "Audience"],
    "skipped_sections": ["Implementation notes"]
  }
}
```

Each candidate field is independently optional. Only fields the extractor recognised get emitted.

### Recognised headings

| Bucket | Recognised headings (case-insensitive) |
| --- | --- |
| `what` | Problem statement, Problem, Overview, Summary, Goal, Goals, Objective, Objectives |
| `who` | Audience, Users, Personas, Stakeholders, Target users |
| `differentiator` | Positioning, Differentiator, Value proposition, Why now, Unique value |
| `description` | Background, Context, Rationale, Motivation, Vision, Philosophy |
| `principles` | Principles, Constraints, Tenets, Non-goals, Guidelines, Guiding principles |

First match wins. Heading normalisation strips Markdown punctuation, so `## **Problem Statement**` and `## problem statement` go to the same bucket.

### Why read-only

Two opt-ins beats one coupled action. Once you have the suggestion envelope, you decide whether to feed it into the non-interactive paths:

```sh
# Pipe into plan brief --from-file (after extracting just the brief_candidates)
code-pact spec import --suggest-from spec.md --json \
  | jq '.data.brief_candidates' \
  > /tmp/brief.yaml
code-pact plan brief --from-file /tmp/brief.yaml --json

# Same for constitution
code-pact spec import --suggest-from plan.md --json \
  | jq '.data.constitution_candidates' \
  > /tmp/const.yaml
code-pact plan constitution --from-file /tmp/const.yaml --json
```

Auto-apply is intentionally out of scope; this mode ships extraction only.

## Mutex constraints and error handling

- `--from` and `--suggest-from` are mutually exclusive. Passing both returns `CONFIG_ERROR` with `data.detail: "mutex_violation"`.
- `--from` without `--phase-id` returns `CONFIG_ERROR` with `data.detail: "missing_phase_id"`.
- `--suggest-from` ignores `--phase-id` silently.

All `spec import` failures reuse the existing `CONFIG_ERROR` code (no new public error codes). For the full `data.detail` enum and when each value fires, see the [`spec import` failure envelope in cli-contract.md](./cli-contract.md#spec-import-v18) — that table is generated from the catalog in source, so it cannot drift from the runtime.

## Related planning-input commands

| Command | What it gives you |
| --- | --- |
| `phase import` | Bulk YAML roadmap import (you already have a `roadmap.yaml`) |
| `plan brief --from-file` / `--stdin` / flag-driven | Non-interactive brief authoring |
| `plan constitution --from-file` / `--stdin` / flag-driven | Non-interactive constitution authoring |
| **`spec import`** | **Ingest external spec-driven planning artifacts (Spec Kit tasks.md / spec.md / plan.md)** |

If you do not already have spec-driven planning artifacts from another tool, you do not need this command — use `init` + `plan brief` + `plan constitution` as the bootstrap path.

## Not supported (and why)

- **Bidirectional sync** (code-pact phase YAML → Spec Kit tasks.md): out of charter. code-pact stays a control plane that other tools' outputs flow into.
- **Live watch / auto-sync** on `tasks.md` file change: importer is explicitly invoked.
- **Auto-apply `--suggest-from` to `design/brief.md` / `design/constitution.md`**: out of scope; this mode ships suggestion-only.
- **Importers for non-Spec-Kit formats** (Cursor rules, Linear specs, Notion exports): out of scope; each format needs its own supported-subset analysis and import contract.
- **A full Spec Kit-compatible spec generator**: out of charter. Re-implementing Spec Kit would invite the "code-pact replaces Spec Kit" misframing and dilute the control-plane positioning.

See the **spec-kit-bridge RFC** (retired — in git history and the `.code-pact/state` archive record) for the full design rationale and alternatives considered.
