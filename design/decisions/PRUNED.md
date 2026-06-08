# Pruned decisions (ledger)

Append-only record of decision files retired from `design/decisions/` once their
work shipped, per [decision-lifecycle-rfc.md](decision-lifecycle-rfc.md).
`code-pact decision prune` appends a row here when it removes a decision file;
the full original text stays in git history. Do not hand-edit except to correct
a mistake.

This file is a **ledger, not a decision** — it is excluded from the decision-gate
filename scan and the ADR quality checks. A `done` task whose `decision_refs` /
`acceptance_refs` target is recorded here produces no `*_REF_NOT_FOUND` warning
(intentional retirement); a missing ref that is **not** recorded here still warns
(possible accidental deletion).

| Decision | Referenced by | Pruned | Rationale lives in |
| --- | --- | --- | --- |
