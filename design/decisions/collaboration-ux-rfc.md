# RFC: Collaboration UX — attribution, activity overview, and conflict recovery

**Status:** accepted (D1–D3, additive MINORs; 2026-06)
**Scope:** the *coordination* layer atop the merge-safe ledger — an optional `author` attribution field on progress events (D1), a read-only `code-pact status` activity overview (D2), and attribution-named conflict recovery (D3). Each ships as an independent, backward-compatible MINOR (D1 → D2 → D3). Explicitly **not** a blocking lock, presence server, or auto-resolver.
**Owners:** maintainer
**Related:** [collaboration-safe-state](collaboration-safe-state-rfc.md) (made the ledger merge-safe; this is the *coordination* layer on top) · [control-plane-v2](control-plane-v2-rfc.md) (PR1b shipped fail-closed id resolution + conflict `recovery`; this takes up what it deferred) · [ci-branch-drift](ci-branch-drift-rfc.md) · [governance](governance-rfc.md) (the advisory lock; this RFC deliberately does **not** add a blocking lock) · [P37-deferred](P37-deferred-outcome-audit.md) (the no-preemptive-engineering precedent honoured here).

## Summary

Shared state is now merge-**safe** (per-event ledger — collaboration-safe-state) and conflicts are **detected** with a recovery path (`DUPLICATE_*` / `PHASE_ID_MISMATCH` / `PROGRESS_EVENT_CONFLICT` + `recovery`, `CONTROL_PLANE_GITIGNORED` — control-plane-v2). That is the **defensive** half. The **generative** half — *who is doing what, what is safe to pick up, and who caused a surfaced conflict* — is missing, because three gaps remain:

1. **Attribution.** The ledger is *actor-anonymous*: an event records `actor` (`human` | `agent`) and an optional `agent` profile name, but **not which human**. `git blame` on the event file names the *committer* (may differ from who ran the verb; awkward per-event) — so "who did this" is effectively unavailable in-product.
2. **Activity overview.** `task status` is single-task, pure-read; there is no cross-task view of *what is in flight, by whom, what is blocked and why, and what is free to pick up.* The safe-state model prevents corruption but not *wasted* duplicate work — it only surfaces overlap after the fact as `PROGRESS_EVENT_CONFLICT`.
3. **Conflict recovery.** Detection + per-issue `recovery` shipped. What remains is small and *enabled by attribution*: naming **who** produced each conflicting side, and surfacing conflicts in the overview — not a new resolver.

This RFC adds three **additive, backward-compatible (MINOR)** changes and rejects the heavyweight forms (presence server, blocking locks, auto-resolution).

## D1 — Author attribution on the progress event

**Decision.** Add one **optional** field `author?: string` to `ProgressEvent` — the git identity of whoever ran the verb (e.g. `"Ada Lovelace"`), captured at write time in the single place events are constructed, by this **fixed resolution order**:

1. `collaboration.author: off` in `project.yaml` → **omit** (capture disabled; wins over everything — `off` genuinely means *never capture*, not overridable by an env var).
2. else `CODE_PACT_AUTHOR` env var → use it **trimmed** (blank-after-trim is ignored, falls through).
3. else `git config user.name` (via the existing `runGit` helper), if present → use it.
4. else → **omit** (never a fabricated or empty value).

**`project.yaml` key (pinned):**

```yaml
collaboration:
  author: auto   # auto (default — capture git user.name) | off (never capture)
```

**No automatic `user.email` fallback** — an email is PII; that git commit metadata holds one does not license auto-embedding it in the committed ledger. Email-as-identity is opt-in via `CODE_PACT_AUTHOR`.

**Rationale / contract facts.**

- `actor` (kind) and `agent` (tool profile) are **unchanged**; `author` is the *human identity* regardless of `actor` (for an agent run, the human driving it — still the useful "who"). `author?` surfaces wherever an event is shown (`task status` `last_event` / `history`, the overview, conflict diagnostics). Additive; consumers ignoring it are unaffected.
- **Content-id interaction (verified):** `canonicalizeEvent` hashes every persisted field except `id`, so `author` automatically joins the content id. Consequences are correct: existing events (no `author`) hash **identically** (absent optional fields are omitted from the canonical JSON) → **no id change, no migration, dedup unaffected**; two different people recording the same logical transition produce **different ids → two files → both survive**, which `detectProgressEventConflicts` surfaces (now with names) — the desired "surface, don't silently merge".
- **Not an audit control.** Self-reported git identity, exactly as trustworthy as `git blame` and no more. No accounts / identity service / verification.

## D2 — Read-only activity overview (`code-pact status`)

**Decision.** A new **read-only**, top-level `code-pact status` command (like `doctor` / `validate`) that aggregates derived task state across the plan and answers the sit-down questions: *what is in flight (by whom), what is blocked (why/by whom), what is free to pick up, and — for what isn't — why.* Pure-read, no agent config (mirroring `task status`), reusing `deriveTaskState` + the `depends_on` resolver + the shared decision-gate resolver — **no new core machinery.** Top-level `status` is the *project*; `task status` stays single-task. (Rejected names: `plan status`, `activity`, `board`.)

```sh
code-pact status            # human table
code-pact status --json     # the envelope below
code-pact status --phase P3 # scope to one phase
code-pact status --mine     # only my work (needs D1)
```

**JSON contract (pinned).**

```json
{
  "ok": true,
  "data": {
    "filter": { "mine": false },
    "in_flight": [ { "task_id": "P3-T2", "phase_id": "P3", "since": "…Z", "author": "Ada" } ],
    "blocked":   [ { "task_id": "P4-T1", "phase_id": "P4", "reason": "waiting on infra", "author": "Bo", "since": "…" } ],
    "available": [ { "task_id": "P3-T3", "phase_id": "P3" } ],
    "waiting":   [ { "task_id": "P4-T2", "phase_id": "P4",
      "reasons": [ { "code": "WAITING_FOR_DEPENDENCY", "task_id": "P3-T1" },
                   { "code": "MISSING_DECISION", "decision_ref": "design/decisions/x.md" } ] } ],
    "totals": { "tasks": 12, "by_state": { "planned": 5, "started": 2, "resumed": 0, "blocked": 1, "done": 4, "failed": 0 } }
  }
}
```

**Bucket rules (pinned).**

- **`in_flight`** = derived `started` / `resumed`, not `done` — the "someone is on this" signal; `author` from the latest state-advancing event.
- **`blocked`** = derived `blocked` (an explicit `task block`), with `reason` (already required on `blocked` events) + `author`. Distinct from `waiting` (*derived* not-ready, never started).
- **`available`** = a `planned`, not-started task **ready to pick up**: `depends_on` all `done`, no readiness blocker, and — if `requires_decision` — an **accepted** decision exists (reusing the shared status-aware resolver `verify` / `task record-done` use). Listing a task that still needs an accepted ADR as "available" would mislead.
- **`waiting`** = a `planned` task **not** ready, with **`reasons[]`**. The MVP `reasons[].code` set is **exactly two**: `WAITING_FOR_DEPENDENCY` (`+ task_id` of the unsatisfied dep) and `MISSING_DECISION` (`+ decision_ref`). Structural invalidity (unsafe `decision_refs` path, missing phase file) is **not** a `status` reason — it stays with `doctor` / `plan lint` / `verify`. Every planned task is in **exactly one** of `available` / `waiting`, so the overview answers both "what can I start" and "why not".
- **`conflicts[]`** ships in **D3, not D2** (a D2-era consumer sees no `conflicts` key) — `PROGRESS_EVENT_CONFLICT` only; structural id conflicts (`DUPLICATE_*` / `PHASE_ID_MISMATCH`) stay with `doctor` / `plan lint`, keeping the overview an *activity* view, not a structural-diagnostics aggregator.

**`--mine` (pinned).** Matches `event.author` by **exact string equality** with the value the D1 resolver returns *now*; events with **no `author`** (legacy / capture-off) are **never** matched. The envelope always carries `data.filter` so an agent distinguishes "nothing is mine" from "can't tell who I am":

```json
// status              → { "mine": false }
// status --mine       → { "mine": true, "supported": true,  "author": "Ada" }
// status --mine (off) → { "mine": true, "supported": false, "reason": "AUTHOR_CAPTURE_DISABLED" }
// status --mine (no identity) → { "mine": true, "supported": false, "reason": "AUTHOR_UNAVAILABLE" }
```

When `supported: false`, the four activity buckets are empty (it is "can't filter", not "no work"); `conflicts` (D3) and `totals` are scope-level and never narrowed by `--mine`. Reason codes pinned: **`AUTHOR_CAPTURE_DISABLED`** (`collaboration.author: off`) and **`AUTHOR_UNAVAILABLE`** (resolver yielded nothing). `--mine` is display-string matching, not account matching: a renamed `user.name` stops matching older events — an accepted coordination-view limitation, noted in the human output.

**Explicitly NOT a lock.** The overview **surfaces** overlap so humans coordinate; it does not reserve, claim, or block. Two people can still pick the same task — they now *see* it first, and the existing `PROGRESS_EVENT_CONFLICT` catches a double-proceed. A blocking claim needs locking infra the project rejects; a non-blocking "claim" is just a `started` event, which `in_flight` already shows.

## D3 — Attribution-enabled conflict recovery

**Decision.** Read-side enrichment only (no new gate, no exit change, no persisted-schema change) — *enabled by D1*:

- **Name the sides in `PROGRESS_EVENT_CONFLICT` — structured, required (not message-only).** Each conflict carries a structured `details.events[]` so an agent acts without parsing prose; `message` is the human rendering of the same facts. Shape (pinned):

  ```json
  {
    "task_id": "P3-T2",
    "code": "PROGRESS_EVENT_CONFLICT",
    "details": { "events": [
      { "event_id": "…", "status": "done", "author": "Ada", "at": "…Z" },
      { "event_id": "…", "status": "done", "author": "Bo",  "at": "…Z" }
    ] }
  }
  ```

  Lives under **`details.events[]`** (aligned with the existing `details` convention on plan/doctor issues — e.g. PR1b's `details.colliding_files`), not a root-level `events`. The **same** shape is used on `code-pact status` `data.conflicts[]`. `author` is omitted per-event for legacy events that lack it. `event_id` is the content id — the *suffix* of a per-event filename `.code-pact/state/events/<at-compact>-<event_id>.yaml` (locate with `*-<event_id>.yaml`), **not** the whole filename; an event living only in a legacy `progress.yaml` has no per-event file.
- **Surface conflicts in the overview** as `code-pact status` `data.conflicts[]` (`PROGRESS_EVENT_CONFLICT` only; added in D3 — D2 has no `conflicts` key).
- **Agent playbook** (`docs/agent-contract.md` "Collaboration conflicts: fail closed, then recover", PR1b) gains the attribution note.

**Deferred (gated on observed pain):** assisted resolution (`plan renumber` / `plan merge`) — a guided fixer that renumbers a colliding id (updating `depends_on` + the roadmap entry). The shipped `recovery.manual_action` already gives the exact steps; per P22/P37 it is recorded as a candidate, not proposed.

## Semver

All three are additive — a new optional field, a new read-only command, read-side enrichment. No existing behaviour changes, no id changes, no migration. By the project test ("does upgrading the binary break an existing project?": no) → **MINOR**, matching the collaboration-safe-state / control-plane-v2 precedent.

## Alternatives considered

- **A. Do nothing (`git blame` + `task status`)** — rejected; `git blame` per event is not tool-/agent-readable, and there is no "what's free" answer.
- **B. `author` on the event (D1)** — **chosen**; one additive optional field, reuses the content-id machinery, zero migration.
- **C. Presence/heartbeat server** — rejected; needs a daemon/server (Non-goals); real-time presence is a different product.
- **D. Read-only overview (D2)** — **chosen**; pure aggregation over existing derived state, no new core, no lock.
- **E. Blocking task claim / lock** — rejected; needs locking infra the project rejects; a non-blocking claim ≡ a `started` event (already shown by `in_flight`).
- **F. Auto-resolve conflicts (pick a winner / auto-renumber)** — rejected; contradicts "surface, don't silently merge"; silent winners overwrite a teammate's work.
- **G. Attribution via vector/Lamport clocks** — rejected; out of scope (collaboration-safe-state routed clock-skew to detection, not logical clocks). `author` answers "who", not "in what order".

## Non-goals

- No server, daemon, database, remote lock, or GitHub API integration — coordination comes from the committed, conflict-free ledger, not infrastructure.
- No blocking claim / lock on tasks (surface overlap, don't reserve work).
- No real-time presence / heartbeats.
- No auto-resolution / auto-renaming of conflicts.
- No identity service / accounts / verification — `author` is self-reported git identity, coordination metadata not a security control.
- No vector/logical clocks.

## Open questions

- **`roadmap.yaml` ref-id duplication vs phase-YAML id duplication.** Two `roadmap.yaml` entries with the same `ref.id` pointing at phase files whose inner ids differ surface mainly as `PHASE_ID_MISMATCH`; a dedicated `DUPLICATE_ROADMAP_PHASE_REF_ID` could be clearer. Recoverable today; evaluate whether the clarity is worth a new code.
- **`doctor` `details` threading.** `doctor` threads `recovery` + `details` (incl. `colliding_files`) from the shared plan detectors, but not `file` / `phase_id` / `task_id` — cheap to add for full parity with `plan lint`'s `data.issues[]`.
- **`--mine` after a `user.name` rename.** Older events stop matching (accepted limitation, since `author` is a display string not an account); the human output should hint it matches the *current* identity, and `data.filter.author` already exposes the matched string for consumers to detect the mismatch.

## References

- RFCs: [collaboration-safe-state](collaboration-safe-state-rfc.md) · [control-plane-v2](control-plane-v2-rfc.md) (PR1b) · [ci-branch-drift](ci-branch-drift-rfc.md) · [governance](governance-rfc.md) · [P37-deferred](P37-deferred-outcome-audit.md).
- Docs touched when taken up: `docs/cli-contract.md` (the `author` field, the overview envelope, the `PROGRESS_EVENT_CONFLICT` attribution) · `docs/agent-contract.md` (overview as a read-diagnostic; conflict-playbook note) · `docs/troubleshooting.md` (recovery gains the "who") · a short `docs/concepts/*` "coordinating a team" page · the `docs/ja/` mirror per docs-maintenance policy.
