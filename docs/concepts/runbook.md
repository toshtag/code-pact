# Lightweight Runbook (v1.3+)

This document is the agent- and reviewer-facing walkthrough of `task runbook` and `phase runbook`, the two commands introduced in v1.3.0 to answer the user-facing question "what should I run next?" deterministically. For the full design rationale, read [`design/decisions/lightweight-runbook-rfc.md`](../../design/decisions/lightweight-runbook-rfc.md). For the migration story from v1.2.x, read [`docs/migration.md` § v1.2.x → v1.3.0](../migration.md#v12x--v130).

## Why the runbook exists

After P10 (task readiness fields) and P11 (`task finalize` / `phase reconcile`), `code-pact` has the mechanical tools to keep design intent and operational fact in sync. But the per-task and per-phase command sequence is implicit — it lives in `docs/dogfood.md`'s per-task flow and in the maintainer's muscle memory, not in a CLI-emitted form.

The cost of an implicit sequence:

- Agents and CI consumers cannot read "what to do next" from existing JSON envelopes without re-implementing the state machine + drift classifier + reconcile classifier.
- `plan analyze` surfaces drift but only points at one command (`task finalize`); the broader sequence (`task start` → `task context` → implement → `task complete` → `task finalize`) is invisible.
- `recommend` returns execution metadata for one task but does not address sequencing.

The runbook fills exactly this gap. **It does not execute anything.** Every recommended step is a command string the user (or an agent) runs separately, or a `manual_action` describing a human checkpoint.

## What runbook is not

The boundary against existing commands is sharp:

| Command | Answers |
| --- | --- |
| `recommend` | **How should this task be executed?** — model tier, effort, context profile, preflight commands, ambiguity action, budget profile. |
| `task context` | **What context does the agent need?** — markdown pack with design YAML excerpts, decisions, declared reads, depends-on state. |
| `task runbook` | **What should happen next in the task lifecycle?** — the sequence of `task start` / `task context` / implementation / `task complete` / `task finalize`, gated by `depends_on` and drift state. |
| `phase runbook` | **What should happen next across the whole phase?** — the per-priority list covering blocked tasks, reconcile candidates, ready-to-start tasks, and phase-status advisory. |

Runbook is **sequencing guidance**, not execution metadata. The four commands above are intentionally separate concerns.

## `task runbook <task-id>`

```sh
# Single task — see what to do next.
code-pact task runbook P9-T5 --json

# After implementation + task complete, runbook recommends finalize.
code-pact task complete P9-T5
code-pact task runbook P9-T5 --json   # → step: task finalize P9-T5 --write
```

The command resolves the task id by scanning every phase referenced by `design/roadmap.yaml` (same logic as `task context` / `task complete`). It derives the task's current state from `progress.yaml`, classifies any drift kind, resolves `depends_on` states, and emits the recommended next steps.

### State → steps mapping

The runbook maps `(derived state, design status, drift kind)` → recommended steps. `task start` is part of the primary loop for `planned + no events` tasks because it records the `planned → started` state-machine transition; downstream tools and handoff scripts depend on that event existing.

| Derived | Design | Drift kind | Steps |
| --- | --- | --- | --- |
| planned (no events) | planned / in_progress | (none) | `task start` → `task context` → manual implement → `task complete` |
| started / resumed | planned / in_progress | (none) | continue implementation → `task complete` |
| blocked | planned / in_progress | (none) | manual_action (resolve blocker) → `task resume --reason "..."` — both `blocking: true` |
| failed | planned / in_progress | (none) | manual_review (diagnose + fix) → `task complete` (re-run) |
| done | planned / in_progress | done-but-design-not-done | `task finalize --write` with dry-run safety note |
| done | done | (none) | empty `next_steps` (consistent) |
| done | done | done-blocked-conflict / done-with-incomplete-events | manual_review pointing at `plan analyze` (blocking) |
| done | done | done-historical | empty `next_steps` (hidden by default) |

`depends_on` adds a blocking `manual_action` step at the head whenever any dependency's derived state is not `done`. Subsequent steps are still emitted — the runbook never refuses to produce output — but they are labeled as depending on the resolution.

### What's NOT in the recommended sequence

- **No agent name** in any `task context` invocation. Agent choice belongs to the user who runs the command; runbook is agent-independent.
- **No `--write` recommendation without a safety note.** Every `task finalize --write` / `phase reconcile --write` step carries a `safety_note` pointing at the dry-run preview command.
- **No automatic execution.** The runbook proposes; the user disposes.

## `phase runbook <phase-id>`

```sh
# Inspect phase state at a glance.
code-pact phase runbook P12 --json

# Recommended sanity check before release-prep `phase reconcile --write`.
code-pact phase runbook P12 --json
code-pact phase reconcile P12 --write
```

The phase runbook iterates `phase.tasks[]` once, classifies each task, and assembles steps in a strict priority order. Two histograms (`task_histogram` and `drift_histogram`) summarize the phase at a glance, and `phase_status_candidate` reports what the phase status would be post-reconcile — **as advisory only**, never written.

### Priority order

| # | Category | Blocking? | What it emits |
| --- | --- | --- | --- |
| 1 | Blocked tasks | yes | manual_action (resolve blocker) + `task resume <id> --reason "..."` for each blocked task |
| 2 | Failed / complex-drift tasks | yes | manual_review pointing at `plan analyze` for `failed` state and `done-blocked-conflict` / `done-with-incomplete-events` drift |
| 3 | Eligible reconcile batch | no | exactly one `phase reconcile <id> --write` step covering every `flip` candidate |
| 4 | In-progress task hints | no | one `task runbook <task-id>` step per `started` / `resumed` task |
| 5 | Untouched ready tasks | no | the four-step primary loop (`task start` → `task context` → implement → `task complete`) for each `planned` task whose `depends_on` is satisfied |
| 6 | Phase-status advisory | no | manual_action recommending the phase's own `status` flip when every task would be `done` post-reconcile and the phase isn't already `done` |

The phase-status advisory is the closing step. Phase reconcile itself never writes the phase status field; the runbook continues that contract by surfacing the advisory as a `manual_action`, not a command.

## The `RunbookStep` shape

Every step in `next_steps[]` has this exact shape:

```typescript
type RunbookStep = {
  command: string | null;        // null when manual_action is set
  manual_action: string | null;  // null when command is set
  reason: string;                // required
  blocking: boolean;             // when true, downstream steps assume this is resolved
  safety_note: string | null;    // null when no safety concern
  expected_result: string | null;
};
```

Two invariants:

1. **Every field is present in JSON output.** `null` is used where a field does not apply to the particular step. JSON consumers can assume the schema is constant across step kinds.
2. **Exactly one of `command` / `manual_action` is non-null.** Never both, never neither. Tests assert this; a builder violation throws.

The fixed-shape invariant matters because runbook output is intended to be consumed by agents and CI tools, not just humans. Constant schema eliminates field-absence branching at the consumer.

## Integration with P10 / P11

Runbook reads — but never enforces — the optional fields introduced in P10:

- **`depends_on`** — emits a blocking dependency-check step at the head when any dep is unsatisfied.
- **`acceptance_refs`** — surfaced in `state_summary.acceptance_refs_check[]` with a per-path filesystem existence flag. Semantic validation of content is intentionally out of scope.
- **`writes`** — surfaced in `state_summary.declared_writes[]`. No git-diff validation.
- **`decision_refs`** — surfaced in `state_summary.decision_refs[]`.

Runbook proposes — but never executes — the v1.2 commands from P11:

- **`task finalize <id> --write`** is the single step recommended when derived state is `done` and design status disagrees (`done-but-design-not-done` drift).
- **`phase reconcile <id> --write`** is the single batch step recommended when at least one task in the phase is a `flip` candidate. Per-task finalize enumeration is intentionally avoided.

## Error codes

Both commands introduce **zero new error codes**. They reuse:

| Code | Exit | When |
| --- | --- | --- |
| `TASK_NOT_FOUND` | 2 | `task runbook` — task id is not present in any phase |
| `AMBIGUOUS_TASK_ID` | 2 | `task runbook` — task id appears in more than one phase |
| `PHASE_NOT_FOUND` | 2 | `phase runbook` — phase id is not present in `design/roadmap.yaml` |
| `CONFIG_ERROR` | 2 | Missing positional id, or unknown flag |

`KNOWN_CODES.public` in `tests/unit/error-code-surface.test.ts` is unchanged in v1.3.

## What's intentionally NOT in v1.3

The RFC § Open questions enumerates deferrals. The headline items:

- **`task runbook --execute`** — a flag that would run each recommended step automatically. The runbook's value is judgement, not orchestration; revisit only if usage signal warrants.
- **`task next` / `phase next` sugar aliases** — `runbook` is the explicit primary name. Short-form aliases may ship in P13.
- **Schema-level `human_gate` field** — manual checkpoints are expressed as `RunbookStep` content (`command: null` + `manual_action: "..."`) without a task-schema field. Promotion to a schema field requires more usage signal.
- **Multi-phase `phase runbook --all`** — per-phase only in v1.3.
- **Bundling `recommend` output into `task runbook`** — separate commands, intentionally. Bundling is a P13 candidate.
- **Init / wizard / task-add UX polish** — P13 scope per the RFC § Planning UX / init UX boundary.

## See also

- [`design/decisions/lightweight-runbook-rfc.md`](../../design/decisions/lightweight-runbook-rfc.md) — the accepted RFC with full alternatives and open questions.
- [`docs/cli-contract.md` § `task runbook`](../cli-contract.md#task-runbook--read-only-guidance-for-a-single-task-v13-p12)
- [`docs/cli-contract.md` § `phase runbook`](../cli-contract.md#phase-runbook--read-only-guidance-for-an-entire-phase-v13-p12)
- [`docs/migration.md` § v1.2.x → v1.3.0](../migration.md#v12x--v130) — adoption pattern and CI implications.
- [`docs/concepts/finalization-reconciliation.md`](finalization-reconciliation.md) — P11 sibling. The commands runbook proposes (`task finalize`, `phase reconcile`) live in detail here.
- [`docs/concepts/task-readiness-fields.md`](task-readiness-fields.md) — P10 sibling. The fields runbook reads (`depends_on`, `acceptance_refs`, `writes`, `decision_refs`) are documented here.
