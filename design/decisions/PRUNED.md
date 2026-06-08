# Pruned decisions (ledger)

Append-only record of decision files retired from `design/decisions/` once their
work shipped, per [decision-lifecycle-rfc.md](decision-lifecycle-rfc.md).
`code-pact decision prune` appends a row here when it removes a decision file;
the full original text stays in git history. Do not hand-edit except to correct
a mistake.

This file is a **ledger, not a decision** — it is excluded from the decision-gate
filename scan and the ADR quality checks. A `done` task whose `decision_refs`
target is recorded here produces no `TASK_DECISION_REF_NOT_FOUND` warning
(intentional retirement); a missing decision ref **not** recorded here still warns
(possible accidental deletion).

Entries are confined to **top-level `design/decisions/*.md`** decision records —
a row pointing anywhere else (a `docs/` page, a `design/phases/*.yaml`, a `../`
traversal, a nested ADR, or `README.md` / `PRUNED.md` itself) is ignored, so the
ledger can never silence an arbitrary missing file. It is a *decision* tombstone only:
`acceptance_refs` are never silenced by it.

| Decision | Referenced by | Pruned | Rationale lives in |
| --- | --- | --- | --- |
