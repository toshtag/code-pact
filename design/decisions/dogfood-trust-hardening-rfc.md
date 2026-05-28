# RFC: Dogfood Trust Hardening — External Completion, Drift Detection, ADR Status

**Status:** accepted (§3-A/B/C/D · §1 implemented; §2 control-plane-not-driven deferred, 2026-05)
**Scope:** design-only. Records constraints and a phased plan for three deferred capabilities — loop-external completion recording, "scaffold not driven" detection, and status-aware ADR resolution + proposed-stub generation. No code lands with this document.
**Owners:** maintainer
**Related:** the implemented hardening PRs this RFC is the design-only tail of — adapter convergence + `--model` pin (#233), recommendation cost correction (#234), init self-consistency (#235), subcommand `--help` + bare-adapter removal (#236). Touch points named below: [src/core/decisions/adr.ts](../../src/core/decisions/adr.ts), [src/core/schemas/progress-event.ts](../../src/core/schemas/progress-event.ts), [src/core/progress/task-state.ts](../../src/core/progress/task-state.ts), [src/commands/verify.ts](../../src/commands/verify.ts), [src/commands/doctor.ts](../../src/commands/doctor.ts).

## Status lifecycle

- This document opens at status **proposed**.
- It is **design-only**: nothing here is implemented yet, and the implemented hardening PRs (#233–#236) did not touch these surfaces.
- Each capability below becomes load-bearing only when a future implementation PR cites this RFC. An implementation PR may not weaken the **MUST** constraints (especially the ADR-gate constraint in §1) without a separate RFC-update PR.
- The maintainer flips this to **accepted** once the constraints are agreed, even though implementation is deferred — so the constraints are binding on whoever implements later.

## Background

Dogfooding `code-pact` in another project exposed a class of trust bugs: a tool that sells determinism wobbling on its own generated output. PRs #233–#236 fixed the live ones (adapter non-convergence, `--model` no-op, init self-contradiction, weak-verification cost inversion, missing `--help`, a deprecated-but-side-effecting bare `adapter`).

Three further ideas surfaced during that review but were **deliberately not implemented**, because each is either bigger than a hotfix or carries a sharp failure mode if done naively. This RFC captures them so they are not lost and — more importantly — so the one that can quietly destroy `code-pact`'s core value (external completion bypassing decision gates) cannot be implemented incorrectly later.

## §1 — Loop-external completion recording (the load-bearing constraint)

### Motivation

Not every task is worth driving through the full `task prepare → start → verify → complete → finalize` loop. Small fixes often ship via an ordinary PR. Today there is no honest way to record that a `code-pact`-tracked task was completed outside the loop, so `progress.yaml` either lies (a fabricated `done`) or silently diverges from reality. A lightweight `record-done` would let the control plane stay truthful without ceremony.

### The hazard

A naive `record-done` that skips `verify` also skips `verify`'s **decision gate**. For a task with `requires_decision: true`, that means:

```
requires_decision: true  →  no ADR  →  verify never runs  →  record-done writes `done`  →  ADR gate is now bypassable
```

This is unacceptable. The decision gate is the single most valuable thing `code-pact` enforces for design tasks. A "convenience" that removes it would trade away the product's reason to exist. **record-done is a feature for not fabricating progress, not a back door around ADR enforcement.**

### Constraints (MUST)

1. External completion MUST reuse the **exact** decision gate `verify` uses. Today that is the shared predicate [`hasDecisionAdrForTaskId`](../../src/core/decisions/adr.ts) (already shared by `verify` and `plan lint`). The implementation MUST route through the same resolution, not a parallel copy.
2. For a task with `requires_decision: true` (or whose phase sets it), if the decision is **unresolved**, `record-done` MUST NOT append a `done` event. It MUST fail with `CONFIG_ERROR`, and the message MUST point at the expected `decision_refs` or `design/decisions/<task-id>.md`.
3. A non-completing record MAY be allowed for "work happened outside the loop but the decision is still open" — e.g. an `external_reported` event. Such an event MUST NOT count as `done` in `phase status`, `validate`, `phase reconcile`, or `doctor`. The task MUST remain blocked/incomplete until the decision gate is satisfied.
4. Evidence is mandatory for any external record (`--evidence`, e.g. a PR URL) so the entry is auditable.

### Proposed shape (non-binding sketch)

```sh
code-pact task record-done <task-id> --evidence "PR #123" --notes "completed outside the loop"
```

- Add an optional `source: "loop" | "external"` to [`ProgressEvent`](../../src/core/schemas/progress-event.ts). `task complete` writes `source: "loop"`; `record-done` writes `source: "external"`. Absent ⇒ `"loop"` (back-compat).
- For the non-completing path, prefer a new `EventStatus` value (e.g. `external_reported`) over overloading `blocked`. Adding a status is **not free**: [`task-state.ts`](../../src/core/progress/task-state.ts) `deriveTaskState` takes the latest event as current state, and `ALLOWED_TRANSITIONS` plus the reconcile classifier interpret each status. Any new value MUST be threaded through all three, and MUST NOT be treated as terminal-done anywhere.

### Acceptance (when implemented)

- A docs task with no `requires_decision` can be recorded done externally.
- A `requires_decision` task with **no** accepted decision CANNOT be recorded done externally (CONFIG_ERROR).
- A `requires_decision` task **with** a resolved decision can be recorded done externally.
- An unresolved `external_reported` event does not make `phase status` / `validate` / `reconcile` / `doctor` report the task as done.

## §2 — "Scaffold not driven" detection (`CONTROL_PLANE_NOT_DRIVEN`)

### Motivation

A project can adopt `code-pact` scaffolding, then quietly stop driving it: real code changes land in git while `progress.yaml` never advances. The scaffold becomes decoration, and the control plane silently describes a fiction. A detector turns that into a visible, advisory signal.

### Proposed behavior

- In `doctor` / `analyze`: warn (`CONTROL_PLANE_NOT_DRIVEN`, severity `warning`, advisory) when **all** hold:
  - the roadmap has at least one non-tutorial task (reuse the `id !== "TUTORIAL"` notion already used by the placeholder gate in [doctor.ts](../../src/commands/doctor.ts)),
  - `progress.yaml` has no recent forward motion (empty, or no `started`/`done` within a window), and
  - git shows ordinary working changes accumulating.
- **Git-unavailable MUST be a silent skip, never an error.** No git repo, no `git` binary, or a git failure ⇒ the check does nothing. The control plane must not punish non-git or sandboxed checkouts.
- Advisory only (`affects_exit: false`): it surfaces drift; it does not fail CI.

### Open questions

- The "recent forward motion" window is a heuristic; define it conservatively to avoid false positives on legitimately paused projects.
- Whether the git probe compares against a merge-base or just dirties — start with "uncommitted working changes exist" and refine.

## §3 — Status-aware ADR resolution → proposed-stub generation

### The current weakness

`verify` / `plan lint` resolve a decision purely by **filename match**: [`hasDecisionAdrForTaskId`](../../src/core/decisions/adr.ts) returns true if any `design/decisions/*.md` filename contains the task id. It does not read the file. Observed ADRs carry a human metadata line, e.g. `**Status:** accepted (P10, 2026-05)`, but nothing parses it.

### Why ordering is an irreversible constraint

It is tempting to auto-generate a `design/decisions/<task-id>.md` stub when a task declares `requires_decision: true`. **If done while resolution is still filename-match-only, that stub immediately satisfies the gate** — every `requires_decision` task would auto-pass with an empty, unreviewed stub. That silently nullifies the gate. So the work MUST proceed in this order:

```
A. Extract verify's decision resolution into a single shared function
   (formalize today's hasDecisionAdrForTaskId into checkDecisionGate(cwd, phase, task)).
B. record-done (§1) reuses that exact function — no parallel gate.
C. Make resolution STATUS-AWARE: parse `**Status:**` (and/or frontmatter `status:`);
   only an `accepted` decision resolves the gate. `proposed` stays unresolved.
D. ONLY THEN auto-generate proposed stubs (e.g. on `phase import` when
   requires_decision: true and decision_refs is empty). A `proposed` stub is
   surfaced by lint as unresolved and does NOT pass verify; flipping it to
   `accepted` is the human act that releases the gate.
```

A→B may land together; C is a prerequisite for D; D must never precede C.

### Constraints (MUST)

- Status-aware parsing MUST be backward compatible: existing accepted ADRs (and projects relying on filename-match today) MUST keep resolving. Consider treating a missing status line as `accepted` for pre-existing files, or gating the stricter behavior behind a project opt-in, to avoid breaking live projects on upgrade.
- A generated stub MUST default to `proposed` and MUST NOT resolve any gate until a human flips it to `accepted`.

## Sequencing summary

1. **§3-A/B first**: extract the shared `checkDecisionGate`. This unblocks §1 cleanly (record-done reuses it) and is a safe refactor with no behavior change.
2. **§1**: implement `record-done` + `external_reported` on top of the shared gate. Highest user value; gated by the §1 MUST constraints.
3. **§2**: `CONTROL_PLANE_NOT_DRIVEN` detection. Independent; can land anytime.
4. **§3-C then §3-D**: status-aware resolution, then proposed-stub generation. Strictly ordered; D never before C.

## Non-goals

- No orchestration: `record-done` records, it does not run anyone's CI or PR.
- No change to the implemented PRs (#233–#236); this RFC neither revisits nor depends on their internals beyond the named shared predicate.
- No new roadmap phase is created by this document; it is a design record. Implementation, when scheduled, will add its own phase(s).
