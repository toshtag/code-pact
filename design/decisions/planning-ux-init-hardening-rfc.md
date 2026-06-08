# RFC: Planning UX and init hardening

**Status:** accepted (P13, 2026-05)
**Scope:** new flag `init --sample-phase`; non-interactive flag set for `task add`; additive `data.suggested_next_steps: string[]` on `plan prompt` and `phase import`; sample-phase artifact rename `P1` → `TUTORIAL` with 1–2 tutorial tasks. v1.4.0 is a **minor** release — every change is additive on existing envelopes/exit codes except the new-init artifact rename.
**Owners:** maintainer
**Related:** [lightweight-runbook](lightweight-runbook-rfc.md) (P12 — deferred init/UX polish here) · [task-readiness-schema](task-readiness-schema-rfc.md) (P10 — the optional task fields the new `task add` flags declare).

## Summary

The first-run experience had sharp edges: `init` always scaffolded a `P1` sample phase, `task add` was TTY-only, and planning commands gave no "what next" hint. This RFC makes the sample phase **opt-in** via `init --sample-phase` (renamed `P1` → `TUTORIAL` with real tutorial tasks), adds a **non-interactive flag set for `task add`** (mode-switched on `--description` presence), and adds an additive **`suggested_next_steps`** field to `plan prompt` / `phase import`. Walkthrough: [docs/concepts/sample-phase.md](../../docs/concepts/sample-phase.md).

## Decisions

1. **`init --sample-phase`** (Stable v1.4+ boolean) — in **non-interactive** mode it enables sample-phase creation at all (otherwise none is created); in **TTY wizard** mode it skips the prompt and forces creation. The wizard's existing default-yes is unchanged — P13 does not touch interactive onboarding. The flag never changes the artifact's shape, only whether it is created. `init --non-interactive --locale <l> --agent <a> --sample-phase` is the complete scripted bootstrap. No `--no-sample-phase` (the wizard already answers "no"; omit the flag to script "none"). The flag does not influence mode selection.

   - RATIONALE: closes "scripted bootstrap impossible without a hand-built `phase import` YAML." Explicit opt-in (rather than default-on in non-interactive) keeps CI runs from silently emitting a tutorial artifact.

2. **Sample-phase artifact: `TUTORIAL` rename + tutorial tasks.** `writeSamplePhase()` produces `design/phases/TUTORIAL-walkthrough.yaml` (`id: TUTORIAL`, `weight: 1`, `status: planned`) instead of `P1-welcome.yaml` (`id: P1`, no tasks). It carries `TUTORIAL-T1` (`type: feature`) and `TUTORIAL-T2` (`type: docs`, `depends_on: [TUTORIAL-T1]`). Both wizard and `--sample-phase` produce this identical artifact. The roadmap entry becomes `id: TUTORIAL`, `path: design/phases/TUTORIAL-walkthrough.yaml`, `weight: 1`.

   - RATIONALE: `id: P1` collides with the user's natural first phase, forcing the documented "delete the sample first" workaround (the `DUPLICATE_PHASE_ID` pain in `docs/concepts/sample-phase.md`). `TUTORIAL` signals "not your real phase." The two tasks (with the `depends_on` chain) let the tutorial demo the full per-task loop and the P10 `depends_on` field + P12 `task runbook` blocking step in one artifact — `task runbook TUTORIAL-T2 --json` returns a blocking `manual_action` step until `task complete TUTORIAL-T1` runs. The "delete before treating design/ as source-of-truth" warning lives in the phase `objective` text because YAML forbids comments inside zod-parsed values, so that is the only schema-compatible boundary statement; console output reinforces it after creation.

3. **`task add` non-interactive flag set** (Stable v1.4+). Mode switch is **presence of `--description`**: present → flag-driven path (wizard skipped); absent + TTY → wizard (unchanged); absent + no TTY → `CONFIG_ERROR`. Newly added tasks are **always `status: planned`**; `--status` is intentionally not exposed.

   - RATIONALE: gives CI/scripted planning a per-task incremental path without a pre-assembled `phase import` YAML. `--description` is the natural mode switch (the wizard exists only to ask description + type), so no redundant `--non-interactive` flag is added. No `--status`: P11/P12 established design `done` is the *result* of `task finalize` / `phase reconcile` after `task complete`, not a creation-time declaration — a "born done" task with no progress event is exactly the drift the P12 runbook surfaces. Historical/migrated tasks use `phase import`.

4. **`plan prompt` / `phase import` `suggested_next_steps`** (Stable v1.4+) — an additive `string[]` of the deterministic CLI sequence the docs already recommend. Always present (may be `[]`).

   - RATIONALE: the recommended "prompt → import → lint → runbook" sequence lived only in docs and maintainer muscle memory; surfacing it on the JSON envelope lets a runner or agent chain it. The field surfaces the **existing** CLI sequence only — it does not invoke an LLM, pre-render a prompt response, or add automation. `suggested_next_steps` (not `warnings`) is the right semantic: it is advisory, nothing is wrong.

## Flag contract — `task add`

Mode trigger is `--description`. Required when non-interactive: `--description`, `--type` (enum: architecture / feature / bugfix / refactor / docs / test / mechanical_refactor / other). Optional with wizard defaults: `--id` (default `<phaseId>-T<n>`), `--ambiguity` / `--risk` / `--context-size` / `--write-surface` (default `medium`), `--verification-strength` (default `medium`), `--expected-duration` (default `medium`). P10 repeatable fields (multiple flag instances, **not** comma-separated, so paths-with-commas stay unambiguous): `--depends-on`, `--decision-ref`, `--read`, `--write`, `--acceptance-ref`.

**Partial-flags resolution** (explicit, never silent):

| Input | Result |
| --- | --- |
| `--description` provided | non-interactive path; `--type` required (else `CONFIG_ERROR`) |
| `--description` absent, no non-interactive flags, TTY | wizard (unchanged) |
| `--description` absent, no non-interactive flags, no TTY | `CONFIG_ERROR` with non-interactive guidance |
| `--description` absent, but ≥1 non-interactive-only flag present | `CONFIG_ERROR` ("non-interactive flags provided without `--description`") |

Silent mode-switching on TTY availability alone (or silently ignoring flags) is a footgun for scripts that lose terminal capability mid-pipeline; the explicit `CONFIG_ERROR` keeps behaviour predictable.

**P10 field validation** is `plan lint`'s job, not `task add`'s. `task add` stores P10 flags after basic string validation only; existence checks, glob validity, unsafe-path detection (`assertSafeRelativePath`), and protected-path advisories stay in `plan lint`. Duplicating them would create a second source of truth, and the `task add` → `plan lint --json` dogfood loop already gives immediate feedback.

## CLI contract / error taxonomy

All four changes are additive on existing JSON envelopes; exit codes unchanged (0 success, 2 for argument/config errors). **No new error codes** — every path reuses an existing public code, and `KNOWN_CODES.public` is unchanged.

- `init --sample-phase` — envelope unchanged; the flag affects which files are written, not the shape.
- `task add` (non-interactive) — envelope **identical to the wizard path**: `{ ok: true, data: { phaseId, taskId, phasePath } }`. Tests assert envelope parity across modes.
- `plan prompt --json` — `data` gains `suggested_next_steps: string[]`; existing `prompt` / `hasBrief` / `hasConstitution` / `clipboardCopied` unchanged.
- `phase import --json` — `data` gains `suggested_next_steps: string[]`; existing `imported_phases` / `imported_tasks` / `skipped_phases` / `completed_fields` unchanged.

| Code | Exit | Command | When |
| --- | --- | --- | --- |
| `CONFIG_ERROR` | 2 | `init` | missing `--locale` / `--agent` in non-interactive mode (unchanged) |
| `ALREADY_INITIALIZED` | 2 | `init` | `.code-pact/` exists without `--force` (unchanged) |
| `PHASE_NOT_FOUND` | 2 | `task add` | phase id not in roadmap |
| `DUPLICATE_TASK_ID` | 2 | `task add` | task id already exists in phase |
| `CONFIG_ERROR` | 2 | `task add` | missing `--description` AND no TTY; missing `--type` when `--description` given; non-interactive flag without `--description`; unknown flag; invalid enum |
| `DUPLICATE_PHASE_ID` | 2 | `phase import` | (unchanged) |
| `AMBIGUOUS_TASK_ID` | 2 | `phase import` | (unchanged) |

`task context` pack output and the byte-identical pack regression test are unchanged; no new task/phase schema field.

## Reserved-id boundary (P13 scope)

P13 changes only the sample-phase **default**; it does **not** reserve `TUTORIAL`. Users can still hand-edit the roadmap or run `phase add --id TUTORIAL` — these collide with the sample exactly as `P1` does today, caught by the existing `DUPLICATE_PHASE_ID`. Hard enforcement (block writes to `TUTORIAL*` from non-tutorial paths, refuse `phase add --id TUTORIAL`) is **P14 governance scope** — see [governance-rfc.md](governance-rfc.md).

## Alternatives considered

- **Explicit `--non-interactive` flag on `task add`** — rejected; `--description` presence is the natural switch, a mode flag doubles the surface for no gain, and the no-TTY error already names the alternative.
- **`task add --status`** — rejected; design `done` is the result of `task finalize` / `phase reconcile`, not a creation-time field. A "born done" task with no progress event is the drift P12 surfaces. Historical state goes through `phase import`.
- **Keep the sample phase as `P1`, only add the flag** — rejected; the `P1` / `DUPLICATE_PHASE_ID` pain persists. Renaming is a small change with high onboarding payoff; existing projects keep their `P1`.
- **Sample phase with NO tasks (only the id change)** — rejected; without tasks the tutorial can't demo the per-task loop without the user doing `task add` first. Two minimal tasks (with `TUTORIAL-T2 depends_on: [TUTORIAL-T1]`) make it an end-to-end walkthrough.
- **Separate `--no-sample-phase` opt-out flag** — rejected; the wizard already answers "no" interactively; a negation flag doubles the surface for no usage signal.
- **`task add` partial flags silently fall through to the wizard** — rejected; silent mode-switching on TTY alone is a footgun for pipelines that lose terminal capability. Explicit `CONFIG_ERROR` + remediation message stays predictable.
- **Promote `DUPLICATE_TASK_ID` from `plan` to `public` in KNOWN_CODES** — rejected for P13; the code already fires at command level. The category mismatch is a doc inconsistency to fix separately, not a runtime issue.
- **`data.warnings` instead of `suggested_next_steps` on `phase import`** — rejected; warnings imply something is wrong; the field is purely advisory.
- **Bundle the `plan prompt` / `phase import` guidance into `task runbook` / `phase runbook`** — rejected; runbook's domain is the per-task/phase lifecycle. These are pre-roadmap planning surfaces (getting *into* the lifecycle, not progressing within it); keeping them separate avoids overloading runbook semantics.
- **`task add` dry-run** — rejected; the wizard has none, adding it only to the non-interactive path is asymmetric, and a bad task costs one delete + re-run. Revisit in P14 if signal warrants.
- **`init --mode tutorial` sugar alias** — rejected; `--sample-phase` is the primary explicit flag; aliases proliferate the surface.

## Open questions

1. **`--sample-phase` standalone (no `--non-interactive`)** — yes; it forces the wizard to skip the prompt.
2. **`task add --depends-on a,b,c` comma-separated** — no; repeatable only. Revisit on signal.
3. **Hard-enforce no project phase uses `TUTORIAL`** — no; deferred to P14 governance; `DUPLICATE_PHASE_ID` catches the practical case.
4. **Omit `suggested_next_steps` when empty vs always `[]`** — always `[]` (field-presence-fixed, the P12 RunbookStep convention).
5. **`init --sample-phase` when the artifact already exists** — no regeneration; `DUPLICATE_PHASE_ID` is swallowed silently (matching existing `writeSamplePhase()`). Recreate via `phase add --force` or delete + re-init.
6. **`init --sample-phase` AND wizard answered "no"** — the flag wins (sample created); explicit intent beats the default prompt. Implementation skips the prompt entirely when the flag is set.
7. **`task add --status`** — resolved NO (see decision 3 / alternatives). Open only if a use case emerges that `phase import` cannot serve.

## References

- RFCs: [lightweight-runbook](lightweight-runbook-rfc.md) (P12) · [task-readiness-schema](task-readiness-schema-rfc.md) (P10) · [finalization-reconciliation](finalization-reconciliation-rfc.md) (P11 — `phase reconcile --write` mechanizes the release-prep status flip) · [governance](governance-rfc.md) (P14 — reserved-id hard enforcement) · [stability-taxonomy](stability-taxonomy.md) (bands the new flags ship under).
- Docs: [docs/concepts/sample-phase.md](../../docs/concepts/sample-phase.md) (rewritten to TUTORIAL terms) · [docs/cli-contract.md](../../docs/cli-contract.md) · [docs/migration.md](../../docs/migration.md) (v1.3.x → v1.4.0).
