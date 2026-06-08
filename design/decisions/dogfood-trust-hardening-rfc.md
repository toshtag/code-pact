# RFC: Dogfood Trust Hardening — External Completion, Drift Detection, ADR Status

**Status:** accepted (§1 · §2 · §3-A/B/C/D all implemented, 2026-05)
**Scope:** design-only constraints for three capabilities — loop-external completion recording, "scaffold not driven" detection, and status-aware ADR resolution + proposed-stub generation. The binding constraints below hold for whoever implements; an implementation PR may not weaken a **MUST** (especially the §1 ADR-gate constraint) without a separate RFC-update PR.
**Owners:** maintainer
**Related:** the implemented hardening PRs this is the design tail of — adapter convergence + `--model` pin (#233), recommendation cost correction (#234), init self-consistency (#235), subcommand `--help` + bare-adapter removal (#236). User-facing walkthrough: [docs/concepts/decision-gate.md](../../docs/concepts/decision-gate.md). Touch points: [adr.ts](../../src/core/decisions/adr.ts), [progress-event.ts](../../src/core/schemas/progress-event.ts), [task-state.ts](../../src/core/progress/task-state.ts), [verify.ts](../../src/commands/verify.ts), [doctor.ts](../../src/commands/doctor.ts).

## Summary

Dogfooding `code-pact` exposed trust bugs where a determinism tool wobbles on its own output. PRs #233–#236 fixed the live ones. This RFC captures the three follow-ons deliberately *not* hotfixed — each bigger than a hotfix or carrying a sharp failure mode if done naively — and pins the constraints so the one that can quietly destroy the product's core value (external completion bypassing the decision gate) cannot be implemented incorrectly later.

## §1 — Loop-external completion recording

**Decision:** add a lightweight `record-done` so a `code-pact`-tracked task completed outside the full loop can be recorded honestly, instead of `progress.yaml` either lying (a fabricated `done`) or silently diverging.

**The hazard / rationale:** a naive `record-done` that skips `verify` also skips `verify`'s **decision gate**. For `requires_decision: true`, `record-done` writing `done` with no ADR makes the gate bypassable. The decision gate is the single most valuable thing `code-pact` enforces for design tasks — `record-done` is a feature for not fabricating progress, **not** a back door around ADR enforcement.

**Constraints (MUST):**

1. External completion MUST reuse the **exact** decision gate `verify` uses (the shared predicate [`hasDecisionAdrForTaskId`](../../src/core/decisions/adr.ts), also used by `verify` and `plan lint`) — the same resolution, not a parallel copy.
2. For a task with `requires_decision: true` and an **unresolved** decision, `record-done` MUST NOT append `done`. It MUST fail with `CONFIG_ERROR`, with a message pointing at the expected `decision_refs` or `design/decisions/<task-id>.md`.
3. A non-completing record MAY be allowed for "work happened outside the loop but the decision is still open" — e.g. an `external_reported` event. It MUST NOT count as `done` in `phase status`, `validate`, `phase reconcile`, or `doctor`; the task stays blocked/incomplete until the gate is satisfied.
4. Evidence is mandatory for any external record (`--evidence`, e.g. a PR URL) so the entry is auditable.

**Contract shape:** an optional `source: "loop" | "external"` on [`ProgressEvent`](../../src/core/schemas/progress-event.ts) — `task complete` writes `"loop"`, `record-done` writes `"external"`, absent ⇒ `"loop"` (back-compat). For the non-completing path, a new `EventStatus` (e.g. `external_reported`) rather than overloading `blocked`. Any new status MUST be threaded through all three of [`task-state.ts`](../../src/core/progress/task-state.ts) `deriveTaskState`, `ALLOWED_TRANSITIONS`, and the reconcile classifier, and MUST NOT be treated as terminal-done anywhere.

## §2 — "Scaffold not driven" detection (`CONTROL_PLANE_NOT_DRIVEN`)

**Decision:** an advisory detector for projects that adopt `code-pact` scaffolding then stop driving it — real code lands in git while `progress.yaml` never advances and the control plane silently describes a fiction.

**Behavior:** in `doctor` / `analyze`, warn `CONTROL_PLANE_NOT_DRIVEN` (severity `warning`, advisory, `affects_exit: false`) when **all** hold: the roadmap has ≥1 non-`TUTORIAL` task; `progress.yaml` shows no recent forward motion (empty, or no `started`/`done` within a window); and git shows ordinary working changes accumulating. **Git-unavailable MUST be a silent skip, never an error** — no repo, no `git` binary, or a git failure ⇒ the check does nothing, so non-git/sandboxed checkouts are not punished.

**Open questions:** the "recent forward motion" window is a heuristic — define it conservatively to avoid false positives on legitimately paused projects. Start the git probe at "uncommitted working changes exist" and refine toward a merge-base comparison.

## §3 — Status-aware ADR resolution → proposed-stub generation

**Current weakness:** `verify` / `plan lint` resolve a decision purely by **filename match** — [`hasDecisionAdrForTaskId`](../../src/core/decisions/adr.ts) returns true if any `design/decisions/*.md` filename contains the task id, without reading the file. ADRs carry a `**Status:**` line, but nothing parses it.

**Irreversible ordering constraint:** auto-generating a `design/decisions/<task-id>.md` stub for a `requires_decision: true` task is tempting, but **while resolution is filename-match-only, the stub immediately satisfies the gate** — every such task auto-passes with an empty, unreviewed stub, silently nullifying the gate. So the work MUST proceed in order, and **D must never precede C**:

- **A.** Extract `verify`'s decision resolution into one shared function (`checkDecisionGate(cwd, phase, task)`, formalizing today's `hasDecisionAdrForTaskId`).
- **B.** `record-done` (§1) reuses that exact function — no parallel gate. (A→B may land together.)
- **C.** Make resolution **status-aware**: parse `**Status:**` (and/or frontmatter `status:`); only an `accepted` decision resolves the gate, `proposed` stays unresolved. (C is a prerequisite for D.)
- **D.** *Only then* auto-generate `proposed` stubs (e.g. on `phase import` when `requires_decision: true` and `decision_refs` is empty). A `proposed` stub is surfaced by lint as unresolved and does NOT pass `verify`; flipping it to `accepted` is the human act that releases the gate.

**Constraints (MUST):**

- Status-aware parsing MUST be backward compatible: existing accepted ADRs (and projects relying on filename-match today) MUST keep resolving — e.g. treat a missing status line as `accepted` for pre-existing files, or gate the stricter behavior behind a project opt-in.
- A generated stub MUST default to `proposed` and MUST NOT resolve any gate until a human flips it to `accepted`.

## Non-goals

- No orchestration: `record-done` records, it does not run anyone's CI or PR.
- No change to PRs #233–#236; this RFC neither revisits nor depends on their internals beyond the named shared predicate.
- No new roadmap phase is created by this document; implementation, when scheduled, adds its own phase(s).

## Post-implementation follow-ups (not blockers)

Surfaced in the pre-1.25 review of the §3 implementation; none block 1.25.0.

1. **`ADR_STATUS_UNRECOGNIZED` does not recurse into nested ADR dirs.** [`classifyDecisionAdrs`](../../src/core/decisions/adr.ts) is a flat scan of `design/decisions/`. The **gate** ([`resolveDecisionGate`](../../src/core/decisions/adr.ts)) correctly reads a nested `decision_refs` path (e.g. `design/decisions/p3/adr.md`), so a nested ADR with a typo'd status still *blocks* the gate — only the advisory that would *warn* before the block does not see nested files. A recursive walk is the refinement, left out to avoid a behavior change at release time.
2. **`classifyDecisionAdrs` reads top-level entries with a plain `readFile`**, not via `resolveWithinProject`. It is a read-only classifier feeding an advisory (not the gate), so it is a consistency nit rather than a hole; routing it through the same path-safety primitive would make the boundary uniform.
3. **`decision_refs` is not restricted to `design/decisions/`.** The gate rejects *unsafe* paths (escaping the repo → `unsafe_path`, fail-closed), but a *safe* repo-relative path outside `design/decisions/` (e.g. `docs/foo.md` with `**Status:** accepted`) still resolves the gate — the current, documented behavior ([decision-gate concept](../../docs/concepts/decision-gate.md)). Whether to constrain ADRs to `design/decisions/**` (e.g. a `TASK_DECISION_REF_OUTSIDE_DECISIONS` advisory) is an open policy question for a later minor.

## References

- RFCs / PRs: #233–#236 (the implemented hardening this is the tail of).
- Code: [adr.ts](../../src/core/decisions/adr.ts) (`hasDecisionAdrForTaskId`, `classifyDecisionAdrs`, `resolveDecisionGate`) · [progress-event.ts](../../src/core/schemas/progress-event.ts) (`source`) · [task-state.ts](../../src/core/progress/task-state.ts) (`deriveTaskState`, `ALLOWED_TRANSITIONS`).
- Docs: [docs/concepts/decision-gate.md](../../docs/concepts/decision-gate.md).
