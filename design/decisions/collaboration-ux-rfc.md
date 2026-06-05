# RFC: Collaboration UX — attribution, activity overview, and conflict recovery

**Status:** accepted (D1–D3, additive MINORs; 2026-06)

- Phase: — (accepted as an unassigned design decision; implementation rollout is D1 → D2 → D3)
- Date: 2026-06-05
- Owners: maintainer
- Related: [Collaboration-safe state](collaboration-safe-state-rfc.md) (made the ledger merge-safe; this RFC builds the *coordination* layer on top), [Control-plane v2](control-plane-v2-rfc.md) (PR1a fail-closed id resolution; PR1b conflict-recovery `recovery` shipped — this RFC takes up the parts it deferred), [CI branch-drift](ci-branch-drift-rfc.md), [Governance](governance-rfc.md) (the advisory lock; this RFC deliberately does **not** add a blocking lock), [P37 deferred](P37-deferred-outcome-audit.md) (the no-preemptive-engineering precedent this RFC honours)

> **Accepted — the JSON contract below is pinned.** This records the problem,
> decomposes it, weighs alternatives, and **authorizes the additive rollout** in
> [§ Rollout](#rollout--sequencing-additive-minors-no-big-bang): D1 → D2 → D3, each
> a backward-compatible MINOR shipped and reverted independently. Acceptance does
> **not** authorize the [Non-goals](#non-goals) or the [Open edges](#open-edges-recorded-out-of-scope-here-candidates-for-a-small-pr-or-this-rfc).
> Every "verified" claim below was checked against the current tree.

## Summary

`code-pact`'s shared state is now merge-**safe** (per-event ledger, conflict-free
files — collaboration-safe-state RFC) and merge conflicts are **detected** with a
recovery path (`DUPLICATE_*` / `PHASE_ID_MISMATCH` / `PROGRESS_EVENT_CONFLICT` +
`recovery`, `CONTROL_PLANE_GITIGNORED`). That is the **defensive** half of
collaboration: *your merges won't corrupt, and breakage is surfaced.*

The **generative** half is missing: a team cannot answer *"who is doing what,
what is safe for me to pick up, and — when a conflict is surfaced — who caused
it."* Concretely, three gaps remain, all verified against the tree:

1. **Attribution.** The ledger is *actor-anonymous*: an event records `actor`
   (`human` | `agent`) and an optional `agent` profile name, but **not which
   human** recorded it. For a team of N humans every event is `actor: human` with
   no identity — so "who started P3-T2", "who blocked it" is unanswerable from the
   ledger.
2. **Activity overview.** `task status` is single-task and pure-read; there is no
   cross-task view of *what is in flight, by whom, what is blocked and why, and
   what is free to pick up.* Two contributors will grab the same task; the safe
   state model prevents *corruption* but does nothing to prevent the *wasted
   work*, and only surfaces it after the fact as a `PROGRESS_EVENT_CONFLICT`.
3. **Conflict recovery.** Detection + per-issue `recovery` shipped (control-plane
   v2 PR1b). What remains is small and mostly *enabled by attribution*: a conflict
   that says **who** produced each side, and surfacing conflicts in the overview —
   not a new heavy resolver.

This RFC proposes three **additive, backward-compatible (MINOR)** changes — an
optional `author` on the event, a read-only activity overview command, and the
attribution-enabled recovery polish — and explicitly **rejects** the heavyweight
forms (presence server, blocking locks, auto-resolution).

## Problem (verified against the current tree)

### 1. The ledger is actor-anonymous

`ProgressEvent` (`src/core/schemas/progress-event.ts`) is:

```ts
{ task_id, status, at, actor: "human" | "agent", agent?: string,
  evidence?, notes?, reason?, source? }
```

`actor` is a *kind*, not an identity; `agent` is the agent **profile** name
(e.g. `claude-code`), not a person. There is no field for *which human* ran the
command. The only existing attribution signal is **git authorship of the event
file** (`git blame .code-pact/state/events/<id>.yaml`) — but that is (a) the
person who *committed* the file, which may differ from who ran the verb (batched
/ squashed / rebased commits), and (b) awkward for the tool and agents to read
per event. So "who did this" is effectively unavailable in-product.

### 2. No cross-task activity view

`task status` (`src/commands/task-status.ts`, ~40 lines) resolves **one** task and
returns its derived `current` + history. It is pure-read and needs no agent config
(good). But there is **no** command that aggregates derived state across the plan.
`plan analyze` already iterates every task and calls `deriveTaskState(events,
task.id)` (`src/core/plan/analyze.ts`) for *drift* classification — proof the
aggregation is cheap and precedented — but it reports drift, not "who is on what /
what is free." A contributor sitting down has no answer to *"what is in flight and
what is safe to start."*

### 3. Conflict recovery is detection-only on the *who* axis

Shipped: `PROGRESS_EVENT_CONFLICT` detection (`detectProgressEventConflicts`,
collaboration-safe-state RFC B6); `DUPLICATE_*` / `PHASE_ID_MISMATCH` with
structured `recovery` (`manual_action` + `confirm`, control-plane v2 PR1b);
`CONTROL_PLANE_GITIGNORED` (collaboration-safe-state RFC A1 follow-up). What these
**cannot** say is *who* produced each conflicting side — e.g. "both A and B
recorded `done` for P3-T2" — because of gap (1). That naming is the single most
useful recovery improvement left, and it is **blocked on attribution**, not on a
new resolver.

## Decisions (decomposition)

Three independent concerns. **None requires atomic co-ship with another** (D2/D3
are *better* with D1 but do not need it). Each ships as an additive MINOR.

### D1 — Author attribution on the progress event

**Minimal spec.** Add one **optional** field to `ProgressEvent`:

```ts
author?: string   // git identity of whoever ran the verb, e.g. "Ada Lovelace"
```

- **Captured at write time** in the *one* place events are constructed before
  the writer, by this **fixed resolution order** (decided — not an open question).
  **`off` is the strongest signal** — a repo that opts out is never overridden by
  an env var, so `off` genuinely means *never capture*:

  1. `collaboration.author: off` in `project.yaml` → **omit** (capture disabled; wins over everything).
  2. else `CODE_PACT_AUTHOR` env var, if non-empty → use it verbatim.
  3. else `git config user.name` (via the existing `runGit` helper), if present → use it.
  4. else → **omit** (never a fabricated or empty value).

  **No automatic `user.email` fallback.** An email is PII; the fact that git
  commit metadata holds one does **not** license auto-embedding it in the
  committed progress ledger. A team that wants email-as-identity sets it
  explicitly via `CODE_PACT_AUTHOR` (or a future explicit `git config` opt-in) —
  it is never captured by default.
- **`project.yaml` key (pinned):**

  ```yaml
  collaboration:
    author: auto   # auto (default — capture git user.name) | off (never capture)
  ```

- `actor` (kind) and `agent` (tool profile) are **unchanged**; `author` is the
  *human identity* regardless of `actor` (for an agent run, it is the human
  driving the agent — still the useful "who").

**JSON / data contract.** `author?` appears wherever an event is surfaced
(`task status` `last_event` / `history`, the new overview, conflict diagnostics).
Additive; consumers ignoring it are unaffected.

**Content-id interaction (verified).** `canonicalizeEvent`
(`src/core/progress/event-id.ts`) hashes **every persisted field except `id`**, so
`author` automatically joins the content id. Consequences, all *correct*:

- Existing events (no `author`) hash **identically to today** — absent optional
  fields are omitted from the canonical JSON, so **no id changes, no migration,
  legacy↔file dedup is unaffected**.
- Two different people recording the *same logical transition* produce **different
  ids → two files → both survive**, and `detectProgressEventConflicts` surfaces it
  (e.g. double-`started`). This is the desired "surface, don't silently merge"
  behaviour, now with names.

**Backward compatibility.** Purely additive optional field; legacy events read
unchanged and display author as *unknown*. No migration. Re-using the established
"additive optional field, omitted-when-absent" pattern (P10 task-readiness fields).

**Non-goals for D1.** No accounts / no identity service / no verification — it is
*self-reported git identity*, exactly as trustworthy as `git blame` (and no more).
This is coordination metadata, not an audit/security control.

### D2 — Read-only activity overview

**Minimal spec.** A new **read-only** command that aggregates derived task state
across the plan and answers the sit-down questions: *what is in flight (by whom),
what is blocked (why/by whom), what is free to pick up — and, for what isn't,
why.* Pure-read, no agent config (mirroring `task status`), reusing
`deriveTaskState` + the `depends_on` resolver (P10/P19) + the shared decision-gate
resolver — **no new core machinery.**

**CLI surface (decided): `code-pact status`** (top-level, like `doctor` /
`validate`). `task status` is single-task; top-level `status` is the project. The
rejected alternatives: `plan status` (closes it to `plan`, weak fit for reading
ledger state), `activity` (too narrow for `blocked`/`available`), `board`
(UI-flavoured, weak as a CLI contract name).

```sh
code-pact status            # human table
code-pact status --json     # the envelope below
code-pact status --phase P3 # scope to one phase
code-pact status --mine     # only my work (needs D1)
```

**`--mine` matching rule (decided).** `--mine` matches `event.author` by **exact
string equality** with the value the author resolver (D1 order) returns *now*.
Events with **no `author`** (legacy, or capture-off) are **never** matched.

The envelope always carries a **`data.filter`** object so an agent can tell
"empty because nothing is mine" from "can't tell who I am" — these are different:

```json
// status            → { "mine": false }
// status --mine      → { "mine": true, "supported": true,  "author": "Ada" }
// status --mine (off)→ { "mine": true, "supported": false, "reason": "AUTHOR_CAPTURE_DISABLED" }
// status --mine (no identity) → { "mine": true, "supported": false, "reason": "AUTHOR_UNAVAILABLE" }
```

When `supported: false`, all buckets are empty (it is "can't filter", not "no
work"). Reason codes are pinned: **`AUTHOR_CAPTURE_DISABLED`** (`collaboration.author:
off`) and **`AUTHOR_UNAVAILABLE`** (resolver yielded nothing — no git identity).
`--mine` is identity *display-string* matching, not account matching (D1's
self-reported scope): a renamed `user.name` stops matching older events — an
accepted coordination-view limitation, noted in the human output.

**JSON contract (pinned).**

```json
{
  "ok": true,
  "data": {
    "filter": { "mine": false },
    "in_flight": [
      { "task_id": "P3-T2", "phase_id": "P3", "since": "2026-06-05T…Z", "author": "Ada" }
    ],
    "blocked": [
      { "task_id": "P4-T1", "phase_id": "P4", "reason": "waiting on infra", "author": "Bo", "since": "…" }
    ],
    "available": [
      { "task_id": "P3-T3", "phase_id": "P3" }
    ],
    "waiting": [
      {
        "task_id": "P4-T2", "phase_id": "P4",
        "reasons": [
          { "code": "WAITING_FOR_DEPENDENCY", "task_id": "P3-T1" },
          { "code": "MISSING_DECISION", "decision_ref": "design/decisions/x.md" }
        ]
      }
    ],
    "conflicts": [
      {
        "task_id": "P3-T2",
        "code": "PROGRESS_EVENT_CONFLICT",
        "details": {
          "events": [
            { "event_id": "…", "status": "done", "author": "Ada", "at": "2026-06-05T…Z" },
            { "event_id": "…", "status": "done", "author": "Bo",  "at": "2026-06-05T…Z" }
          ]
        }
      }
    ],
    "totals": { "tasks": 12, "by_state": { "planned": 5, "started": 2, "blocked": 1, "done": 4 } }
  }
}
```

- **`in_flight`** = derived `started` / `resumed`, not `done`. The "someone is
  on this" signal; `author` from the latest state-advancing event (D1).
- **`blocked`** = derived `blocked` (an explicit `task block`), with `reason`
  (already required on `blocked` events) and `author`. Distinct from `waiting`
  (which is *derived* not-ready, never started).
- **`available`** (decided rule) = a `planned`, not-started task that is **ready
  to pick up**: `depends_on` all `done`, **no readiness blocker**, and — if it is
  `requires_decision` — an **accepted** decision exists (reusing the shared
  status-aware resolver `verify` / `task record-done` / `TASK_DECISION_UNRESOLVED`
  already use). Listing a task that still needs an accepted ADR as "available"
  would mislead.
- **`waiting`** = a `planned` task that is **not** ready, with **`reasons[]`**.
  The MVP `reasons[].code` set is **exactly two** (pinned): `WAITING_FOR_DEPENDENCY`
  (`+ task_id` of the unsatisfied dep) and `MISSING_DECISION` (`+ decision_ref`).
  Structural invalidity (e.g. an unsafe `decision_refs` path, a missing phase
  file) is **not** a `status` reason — it stays the responsibility of `doctor` /
  `plan lint` / `verify`; `status` only answers *activity* readiness. Planned tasks
  are never silently dropped: every planned task is in exactly one of `available` /
  `waiting`, so the overview answers both "what can I start" *and* "why not".
- **`conflicts`** (MVP, decided) = **`PROGRESS_EVENT_CONFLICT` only**, each with
  the structured `details.events[]` (D3 shape — same as the `plan lint` / `doctor`
  surface). The structural id conflicts (`DUPLICATE_*` / `PHASE_ID_MISMATCH`) stay
  the responsibility of `doctor` / `plan lint` — the overview is an *activity* view
  (in flight / blocked / available / waiting), not a structural-diagnostics
  aggregator; folding all of `plan lint` into it would bloat the command. Merging
  a structural-health section into the overview, if ever wanted, is a separate PR.

**Explicitly NOT a lock.** The overview **surfaces** overlap so humans coordinate;
it does **not** reserve, claim, or block. Two people can still pick the same
in-flight task — they will now *see* it first, and if they both proceed the
existing `PROGRESS_EVENT_CONFLICT` catches it. (Why no claim/lock: a blocking
claim needs coordination/locking infra this project rejects — Non-goals — and a
non-blocking "claim" is just a `started` event, which `in_flight` already shows.)

**Backward compatibility.** New additive read-only command; no schema or state
change. Works on any existing ledger (author simply absent pre-D1).

### D3 — Attribution-enabled conflict recovery (mostly already shipped)

**Minimal spec.** D3 is deliberately small — the heavy lifting (detection +
`recovery`) shipped in control-plane v2 PR1b. What this adds, *enabled by D1*:

- **Name the sides in `PROGRESS_EVENT_CONFLICT` — structured data, required (not
  message-only).** When two events assert incompatible transitions, the issue
  carries a structured `details.events[]` so an agent can act without parsing
  prose; the `message` is the human rendering of the same facts. Shape (pinned):

  ```json
  {
    "task_id": "P3-T2",
    "code": "PROGRESS_EVENT_CONFLICT",
    "details": {
      "events": [
        { "event_id": "…", "status": "done", "author": "Ada", "at": "2026-06-05T…Z" },
        { "event_id": "…", "status": "done", "author": "Bo",  "at": "2026-06-05T…Z" }
      ]
    }
  }
  ```

  The structured payload lives under **`details.events[]`** — aligned with the
  existing `details` convention on plan/doctor issues (e.g. PR1b's
  `details.colliding_files`), not a root-level `events`. The **same** shape is used
  on the `code-pact status` `data.conflicts[]` entry. `author` is omitted
  per-event for legacy events that lack it. Pure read-side enrichment of the
  existing `detectProgressEventConflicts`.
- **Surface conflicts in the overview** (D2 `conflicts[]`).
- **Agent playbook already exists** (`docs/agent-contract.md` "Collaboration
  conflicts: fail closed, then recover", PR1b) — extend it with the attribution
  note.

**Assisted resolution (`plan renumber` / `plan merge`) is a candidate, deferred.**
A guided fixer that renumbers a colliding id (updating `depends_on` and the
roadmap entry) is the obvious next step, but per the project's
no-preemptive-engineering precedent (P22/P37) it is **gated on observed pain**:
the shipped `recovery.manual_action` already gives the exact steps. Recorded as a
candidate, not proposed.

**Backward compatibility.** Read-side only; no new gate, no exit change.

## Alternatives (with verdicts)

| Alternative | Verdict | Why |
| --- | --- | --- |
| **A. Do nothing (rely on `git blame` + `task status`)** | Rejected | `git blame` per event file is not tool-/agent-readable; no "what's free" answer. The defensive half alone leaves teams coordinating by hand — the thing the project says it won't make the answer. |
| **B. `author` on the event (D1)** | **Proposed** | One additive optional field; reuses the content-id machinery; zero migration. |
| **C. Presence/heartbeat server ("X is editing P3-T2 now")** | Rejected | Needs a daemon/server — Non-goals. Real-time presence is a different product. |
| **D. Read-only overview (D2)** | **Proposed** | Pure aggregation over existing derived state; no new core; no lock. |
| **E. Blocking task claim / lock ("reserve P3-T2")** | Rejected | Needs coordination/locking infra the project rejects; a non-blocking claim ≡ a `started` event (already shown by `in_flight`). |
| **F. Auto-resolve conflicts (pick a winner / auto-renumber)** | Rejected | Contradicts "surface, don't silently merge" (B2/B6). Silent winners overwrite a teammate's work. |
| **G. Attribution via vector/Lamport clocks** | Rejected | Out of scope (collaboration-safe-state B2 already routed clock-skew to *detection*, not logical clocks). `author` answers "who", not "in what order". |

## Semver

All three are additive — a new optional field, a new read-only command, read-side
enrichment. **No existing behaviour changes, no existing id changes, no migration.**
By the project's own test ("does upgrading the binary break an existing project?":
no) → **MINOR**, matching the collaboration-safe-state / control-plane-v2 precedent.

## Acceptance criteria (final-state)

1. **Attribution round-trips:** an event recorded in a git repo with `user.name`
   set carries `author`; the same logical event by a different person produces a
   *distinct* id (two files, both survive). A repo with no git identity records
   events with `author` **omitted** and reads byte-for-byte as today.
2. **No id churn:** every pre-existing event hashes to the same id after D1
   (golden-fixture lock); legacy↔file dedup unaffected; no migration runs.
3. **Overview answers the questions:** `status --json` lists `in_flight` (with
   `author`), `blocked` (with `reason` + `author`), `available` (ready to pick up),
   and `waiting` (with `reasons[]`); every planned task is in exactly one of
   `available` / `waiting`. `conflicts[]` carries `PROGRESS_EVENT_CONFLICT` only.
4. **`available` is honestly ready:** a `requires_decision` task with no accepted
   decision, or a task with an unsatisfied `depends_on`, appears in `waiting`
   (with the reason), **never** in `available`.
5. **Overview is read-only and lock-free:** it never writes the ledger or design
   YAML and needs no agent config; two contributors picking the same task is
   *visible*, not *prevented*.
6. **Named conflicts (structured):** a `PROGRESS_EVENT_CONFLICT` exposes a
   structured `details.events[]` (`event_id` / `status` / `author?` / `at`) — an
   agent reads who produced each side without parsing the `message`.
7. **`--mine` is exact-match and excludes anonymous events:** legacy / capture-off
   events never appear; capture-off repos get an explicit empty/unsupported result.
8. **No new default noise:** a healthy current project gains no new warning from
   any of D1–D3 (consistent with the PR1b discipline).

## Non-goals

- **No server, daemon, database, remote lock, or GitHub API integration.**
  Coordination comes from the committed, conflict-free ledger — not infrastructure.
- **No blocking claim / lock** on tasks. The overview surfaces overlap; it does
  not reserve work.
- **No real-time presence / heartbeats.**
- **No auto-resolution / auto-renaming** of conflicts (surface, don't silently
  pick a winner).
- **No identity service / accounts / verification.** `author` is self-reported git
  identity — coordination metadata, not a security/audit control.
- **No vector/logical clocks.**

## Open edges (recorded; out of scope here, candidates for a small PR or this RFC)

Surfaced during the control-plane-v2 PR1b review — real but not blocking:

- **`roadmap.yaml` ref-id duplication vs phase-YAML id duplication.** Today two
  `roadmap.yaml` entries with the same `ref.id` pointing at phase files whose
  inner ids differ surface mainly as `PHASE_ID_MISMATCH`; a dedicated
  `DUPLICATE_ROADMAP_PHASE_REF_ID` could be clearer. Recoverable today; evaluate
  whether the clarity is worth a new code.
- **`doctor` `details` threading.** `doctor` now threads `recovery` + `details`
  (incl. `colliding_files`) from the shared plan detectors, but not `file` /
  `phase_id` / `task_id`. Cheap to add for full parity with `plan lint`'s
  `data.issues[]`.

## Docs that must change (when taken up)

- `docs/cli-contract.md` — the `author` field on the event; the new overview
  command's envelope; the `PROGRESS_EVENT_CONFLICT` attribution.
- `docs/concepts/*` — a short "who did what / coordinating a team" concept page.
- `docs/agent-contract.md` — the overview as a read-diagnostic surface; the
  attribution note in the conflict playbook.
- `docs/troubleshooting.md` — `PROGRESS_EVENT_CONFLICT` recovery gains the "who".
- `design/decisions/README.md` — index row (added with this draft).
- The `docs/ja/` mirror for any English page changed (docs-maintenance policy).

## Rollout / sequencing (additive minors; no big-bang)

1. **D1 — `author` field + capture + opt-out** (foundation; everything else reads
   it). Golden-fixture id-stability lock first.
2. **D2 — read-only overview** (independently shippable; works without D1, richer
   with it).
3. **D3 — attribution-enabled conflict naming + overview `conflicts[]`** (read-side
   enrichment once D1 lands).

Each step is independently revertible and independently shippable as a MINOR. If
review wants to stop after D1 (or D2), the project is in a coherent state.

## Decided during review (was: open questions) — the JSON contract is now pinned

These were open in the first draft and are now **fixed** in the spec above, so
acceptance inherits a complete contract (no JSON-shape decisions left to the
implementer):

- **Command name → `code-pact status`** (top-level). (D2)
- **`author` value → `git config user.name`**, never an automatic `user.email`
  fallback (PII); explicit override via `CODE_PACT_AUTHOR`. (D1)
- **Resolver precedence → `collaboration.author: off` wins first** (genuine "never
  capture"), then `CODE_PACT_AUTHOR`, then `git config user.name`, else omit. (D1)
- **`--mine` envelope → `data.filter`** `{ mine, supported?, author?, reason? }`
  with pinned reason codes `AUTHOR_CAPTURE_DISABLED` / `AUTHOR_UNAVAILABLE`. (D2)
- **`available` rule →** planned + `depends_on` all done + no readiness blocker +
  (if `requires_decision`) an accepted decision; everything else planned goes to
  **`waiting`**. (D2)
- **`waiting.reasons[].code` → exactly `WAITING_FOR_DEPENDENCY` / `MISSING_DECISION`**
  (MVP); structural invalidity stays a `doctor` / `plan lint` / `verify` concern. (D2)
- **Conflict attribution → structured `details.events[]` required** (not
  message-only; same shape on the `status` `conflicts[]` and the `plan lint` /
  `doctor` surfaces); `message` is the human rendering. (D3)
- **`conflicts[]` scope → `PROGRESS_EVENT_CONFLICT` only**; structural id conflicts
  stay with `doctor` / `plan lint`. (D2)

## Non-contract implementation notes (not blocking acceptance)

- **`--mine` after a `user.name` rename:** older events stop matching (an accepted
  coordination-view limitation, since `author` is a display string, not an
  account). The human `status --mine` output should carry a one-line hint that it
  matches the *current* identity; the JSON contract (`data.filter.author`) already
  exposes the matched string so a consumer can detect the mismatch itself.
