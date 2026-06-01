# Agent feedback — Claude Code on code-pact 1.27.0

External-agent feedback from driving code-pact 1.27.0, classified so the
roadmap responds to the real gap (not the surface complaint). Recorded so
future prioritization does not depend on a chat log.

## Classification

Each item is one of: **implemented-but-undiscovered** (the feature exists; the
agent could not find/use it from JSON or help), **docs-duplication** (the same
concept is explained in multiple places, so the canonical one is unclear), or
**genuinely-missing** (no implementation).

| Feedback | Class | Disposition |
|---|---|---|
| `CONTROL_PLANE_NOT_DRIVEN` looked "not implemented" | implemented-but-undiscovered | The check existed; its `message` named the fix only as prose. Fixed by adding machine-readable `recovery` to the JSON (v1.28). |
| `CONTROL_PLANE_BRANCH_NOT_DRIVEN` same | implemented-but-undiscovered | Same fix. |
| `record_only` perceived as under-documented | docs-duplication | A correct definition existed (glossary); the term was *re-defined* in several places, so no obvious primary. Addressed by consolidating to pointers. |
| `task prepare --json` record_only evidence guidance "missing" | implemented-but-undiscovered | `commands["record-done"]` + `next_action.message` already carried it (P40). No new field needed. |
| Leaf `--help` inconsistency (some rich, some stub) | implemented-but-undiscovered | task cluster is uniform (CommandSpec); plan/phase/adapter still have stub help. Coverage to be pinned by a test + filled per command. |
| CLI help / contract / docs drift | docs-duplication | Flag surface was hand-copied in three places. Fixed structurally by CommandSpec single source (parse/help/generated reference all derive from it). |

## Interpretation

Most of the feedback was **discoverability, not missing implementation**. The
lesson: a control-plane check or a lifecycle field is only "real" to an agent if
it is reachable from JSON / `--help` without natural-language parsing. The
highest-ROI responses were the smallest — an additive `recovery` field, a
single-source spec — not new features.

## What shipped in response

- docs/ja mirror removed (surface reduction).
- CommandSpec single source for the task cluster's parse/help/reference.
- `cli-contract.md` task flag tables → generated-reference pointers.
- `CONTROL_PLANE_*` issues carry machine-readable `recovery`.

See `design/decisions/cli-command-spec-rfc.md` for the spec design.
