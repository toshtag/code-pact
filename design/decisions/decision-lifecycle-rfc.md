# RFC: Decision record lifecycle — prunable shipped decisions

**Status:** proposed
**Scope:** make a *shipped* decision record safely removable without breaking control-plane integrity. Three additive layers: (1) **status-aware ref integrity** — a `done` task no longer hard-requires its `decision_refs` / `acceptance_refs` file to exist on disk; (2) a **`code-pact decision prune`** command with eligibility gates + an append-only tombstone ledger; (3) a per-project **`decision_retention`** policy (`keep-full` | `compress-on-ship` | `prune-on-ship`). Plus the long-term record-of-truth model (CHANGELOG authored + rolling-archived; release notes generated; the RFC is a prunable working doc; git is the backstop).
**Owners:** maintainer
**Related:** [task-readiness-schema](task-readiness-schema-rfc.md) (defines `decision_refs` / `acceptance_refs`) · [finalization-reconciliation](finalization-reconciliation-rfc.md) (`task finalize` flips design status to `done` — the signal this RFC keys off) · [adr-downstream-commitments](adr-downstream-commitments-rfc.md) + [adr-quality-advisory](adr-quality-advisory-rfc.md) (the `## Implementation commitments` surface an eligibility gate must honor) · [doc-truth-from-code](doc-truth-from-code-rfc.md) (the lean compress form the `compress-on-ship` policy reuses).

## Summary

A `decision_ref` has a **dual nature** the integrity checker conflated (before PR-A): while its task is live it is a **gate requirement** (an accepted ADR must exist); once the task is `done` it is a **historical annotation** (the decision *was* recorded here). The checker enforced "must exist" forever, so a shipped RFC was **undeletable** — and whether to keep a shipped design record is a matter of taste, not something the spec should force. (PR-A, merged, gives `done`-task refs the soft integrity story; this RFC's remaining layers build the command + policy on top.) This RFC makes retention a **policy**, gives `done`-task refs a soft integrity story, and adds an eligibility-gated `decision prune` command so a shipped decision can be retired cleanly, auditable, without future-conflict.

## Problem — a shipped decision record was undeletable

Before PR-A, in [`src/core/plan/checks/path-fields.ts`](../../src/core/plan/checks/path-fields.ts), `detectTaskDecisionRefNotFound` (and the acceptance-ref twin) emitted `TASK_DECISION_REF_NOT_FOUND` at **`severity: "error"`**, iterating every task **without consulting its status**. So deleting an RFC that any `done` task referenced:

1. fails `plan lint` / `validate` **by default** (an `error` fails exit even without `--strict`);
2. breaks `check:doc-links` on every inbound `.md` link (the `design/decisions/README.md` index row, other RFCs' `Related:` / `References`, concept docs).

The asymmetry that proves this is a gap, not a guard: the **`reads`** field in the same file treats a missing target as a `warning` *with a recovery path* (`detectTaskReadsNoMatch` → "redirect with `plan sync-paths`, or drop the entry"). `decision_refs` / `acceptance_refs` alone are a permanent hard dependency. The gate already passed at `task complete`; continuing to require the file forever turns a historical annotation into an eternal liability. git history and `CHANGELOG.md` already hold the durable log, so forced retention buys nothing for the maintainer who considers the shipped RFC noise.

## Decision

### 1. Status-aware ref integrity (the loosening)

`detectTaskDecisionRefNotFound` / `detectTaskAcceptanceRefNotFound` consult the **referencing task's own status** (not the phase's — a `done` phase holding an open task must not loosen that task's live gate). **Only `decision_refs` are silenced by the ledger** — `acceptance_refs` routinely point at non-decisions (`docs/`, phase YAML), so the decision tombstone never silences them:

| Field | Referencing task | target on disk | Result |
| --- | --- | --- | --- |
| `decision_refs` | not `done` | missing | `TASK_DECISION_REF_NOT_FOUND` — `error` (the gate is live) |
| `decision_refs` | `done` | present | OK |
| `decision_refs` | `done` | missing **and** recorded in `PRUNED.md` | **silent** — intentional decision retirement |
| `decision_refs` | `done` | missing **and** not recorded | `warning`, `affects_exit: false` — restore (accidental) or `decision prune` (retire properly) |
| `acceptance_refs` | not `done` | missing | `TASK_ACCEPTANCE_REF_NOT_FOUND` — `error` |
| `acceptance_refs` | `done` | present | OK |
| `acceptance_refs` | `done` | missing | `warning`, `affects_exit: false` — **`PRUNED.md` never silences `acceptance_refs`** |

This is a strict **loosening** — it never makes a previously-passing plan fail. A `done` task's gate was satisfied at completion; its ref is now annotation, mirroring the soft `reads` story.

### 2. `code-pact decision prune <ref…>` — the keep-clean command

Retires a shipped decision from the live plane. Reuses the existing **prune-if-clean / refuse-if-dirty** pattern already in [`adapter upgrade`](../../src/commands/adapter-upgrade.ts) (orphan cleanup). Dry-run by default, `--write` to apply, `--json` envelope — symmetric with `task finalize`.

**Eligibility (all required; else `DECISION_PRUNE_NOT_ELIGIBLE`, exit 2, zero writes):**

0. the target is a **readable, top-level `design/decisions/<name>.md`** record (not README/PRUNED, not an outside/traversing/nested path) that is an **accepted** decision — prune retires *settled* records only; a `proposed`/`draft`/`rejected`/`superseded`/empty/unknown target is rejected (a status-less ADR counts as accepted per the lenient classifier);
1. every task/phase that references the decision is `done` — no live gate still needs it;
2. it has no **open** (unchecked) `## Implementation commitments` — pruning would orphan declared downstream work;
3. no **live** (`proposed`/`draft`) decision references it — a future decision still depends on this rationale.

These gates are exactly the "integrity + no future conflict" guarantee: you can only retire a settled decision whose every obligation is discharged. The verdict is one pure function (`evaluatePrune`) that `--dry-run` and `--write` share — dry-run never relaxes a gate.

**On `--write`:** remove the decision file; rewrite inbound `.md` references (the README index row → a tombstone line; other doc/RFC links → delink, or repoint at the CHANGELOG entry); append a ledger row. The `decision_refs` check (1) then tolerates the absent pruned decision silently.

### 3. Tombstone ledger — `design/decisions/PRUNED.md`

Append-only table: `decision path | phase/task | pruned date | rationale home (CHANGELOG vX.Y / git <sha>)`. It makes retirement **auditable**, lets check (1) distinguish an intentional prune from an accidental `rm`, and makes the freed filename namespace **visible** — so a later RFC reusing a name is a conscious choice, never a silent collision. Excluded from the decision-candidate filename scan (it is a ledger, not a decision).

### 4. Retention is a policy, not a hardcoded requirement — `project.yaml: decision_retention`

| Value | Shipped (`done`) decision becomes |
| --- | --- |
| `keep-full` (**default** — today's behavior, ADR tradition) | kept verbatim, forever |
| `compress-on-ship` | compressed to decision + rationale + contract stub (the lean [doc-truth-from-code](doc-truth-from-code-rfc.md) form) |
| `prune-on-ship` | eligible decisions retired via `decision prune` |

`decision prune` *enacts* the project's policy; `--policy <v>` overrides per-invocation. The core fix is that the **spec stops dictating retention** — it becomes the maintainer's preference, which is what it always was.

**Locked choices** (this RFC): the shipped default is **`keep-full`** — non-surprising and backward-compatible for the ecosystem; no project's records vanish on upgrade. The locked dogfood choice for this repository is **`prune-on-ship`**; the `project.yaml` `decision_retention` field itself is introduced in PR-D (it does not exist yet). The command is **`decision prune`**, reusing the existing prune vocabulary.

## Long-term record-of-truth model

One job per surface (the anti-duplication principle):

| Surface | Single role | Bloat control |
| --- | --- | --- |
| **git history** | complete, immutable record of everything (incl. pruned RFC full text) | not in working context — never bloats "in your face"; the ultimate backstop |
| **`CHANGELOG.md`** | human-curated "**what changed**" — the authored source of truth | **rolling-archive**: keep the current major in-repo, move older to `docs/maintainers/history/CHANGELOG-<major>.md` |
| **Release notes** (forge Releases) | user-facing announcement | **generated from `CHANGELOG.md`**, never authored twice |
| **RFC** (`design/decisions/`) | the only home for *why-this-way + rejected alternatives* | a **prunable working doc** — not the durable record |

Direct answer to "should release notes be the source of truth?" — **No.** `CHANGELOG.md` is the one *authored* record; release notes are *derived* from it; git is the complete backstop; the RFC is a working doc, not a record of truth.

## Contract surface

- **New command** `decision prune <ref…> [--write] [--policy <v>] [--json]` — dry-run default; success envelope reports `{ pruned, rewrote_links, ledger_appended }`.
- **New public error code** `DECISION_PRUNE_NOT_ELIGIBLE` (exit 2); `KNOWN_CODES.public` += 1; `cli-contract.md` + `troubleshooting.md` entries.
- **`TASK_DECISION_REF_NOT_FOUND` / `TASK_ACCEPTANCE_REF_NOT_FOUND`** gain status-awareness — a `done`-task severity *loosening* only; never tightens an existing plan. Documented in `cli-contract.md`.
- **New optional `project.yaml` field** `decision_retention` (default `keep-full` → fully backward-compatible).
- **New ledger** `design/decisions/PRUNED.md`, excluded from the gate-candidate scan.

## Alternatives considered

- **Keep RFCs permanent (status quo)** — rejected: it forces retention as policy; the undeletable-file UX is the complaint.
- **Delete files and tell users to ignore the lint error** — rejected: breaks `validate` / CI; not integrity-preserving.
- **Make `decision_refs` soft for *all* tasks** — rejected: it removes the live gate's teeth (a not-yet-`done` `requires_decision` task could pass with a missing ADR). The loosening must be scoped to `done`.
- **Inline pruned RFC bodies into `CHANGELOG.md`** — rejected: bloats the CHANGELOG with rollout detail git already holds. An *optional* one-paragraph decision summary is the middle path (`compress-on-ship`).
- **Auto-prune at `task finalize`** — rejected: deletion must be explicit and eligibility-checked, not a silent side effect of finalize.

## Open questions

1. **Filename reuse after prune** — allow (a new decision is genuinely new) but the ledger records the prior life. Refuse reuse of a tombstoned name, or just warn? Lean: warn.
2. **`compress-on-ship`** — automatic at finalize, or a separate `decision compress` invocation (symmetric with `prune`)? Lean: a command, for explicitness.
3. **Consumer projects** — does `PRUNED.md` ship to consumers or stay maintainer-only? Lean: per-project, lives beside their decisions.
4. **Revisited decisions** — gate (3) blocks pruning a decision a *live* one references, but a *future* revisit of an already-pruned decision loses its in-repo anchor (e.g. governance's "don't lock progress.yaml" later corrected by collaboration-safe-state). `prune-on-ship` users accept the git backstop; `compress-on-ship` is the hedge.

## Implementation commitments

- [x] PR-A — status-aware `TASK_DECISION_REF_NOT_FOUND` / `TASK_ACCEPTANCE_REF_NOT_FOUND` (loosening, keyed on `task.status === "done"`) + unit tests + `cli-contract.md` note. **Merged (#395).** Shipped decisions are now deletable-without-breakage.
- [ ] PR-B — `design/decisions/PRUNED.md` ledger + reader + the ledger-aware branch of the status-aware check (a `done`-task **`decision_refs`** recorded in the ledger is silent; one not recorded still warns). The ledger silences **`decision_refs` only** (not `acceptance_refs`, which routinely point at non-decisions), entries are confined to top-level `design/decisions/*.md` (re-validated — `PRUNED.md` is user-editable), and the ledger is excluded from both the decision-candidate scan and the context-pack decision loader.
- [ ] PR-C — `decision prune` command: eligibility gates, inbound-link rewrite, ledger append, JSON envelope, `DECISION_PRUNE_NOT_ELIGIBLE`.
- [ ] PR-D — `project.yaml: decision_retention` + the `compress-on-ship` form.
- [ ] PR-E — `CHANGELOG.md` rolling-archive tooling + release-notes generation from the CHANGELOG.

## References

- [`src/core/plan/checks/path-fields.ts`](../../src/core/plan/checks/path-fields.ts) — the ref-not-found detectors this RFC makes status-aware (and the soft `reads` precedent).
- [`src/commands/adapter-upgrade.ts`](../../src/commands/adapter-upgrade.ts) — the prune-if-clean / refuse-if-dirty precedent.
- [docs/cli-contract.md](../../docs/cli-contract.md) — destination for the new command + error-code contract.
- [docs/maintainers/docs-maintenance.md](../../docs/maintainers/docs-maintenance.md) — the doc-ownership map the long-term record model extends.
