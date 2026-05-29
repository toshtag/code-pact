# P37 deferral — outcome audit / effectiveness measurement

**Status:** accepted (2026-05-29)
**Decision:** Defer the P37 "outcome audit" feature. Ship no phase, no CLI
command, and no new write surface. This record closes P37 on the approved
roadmap reshape without implementing it.

## Context

The roadmap reshape (P32–P37) that followed the v1.25 dogfood feedback shipped
its substantive improvements:

- P32 — failure clarity (`failed_checks` / `first_failure` / `suggested_next_command`)
- P33 — lightweight lane + recommendation consumption (`lifecycleMode`)
- P34 — CI branch-drift (`CONTROL_PLANE_BRANCH_NOT_DRIVEN`, `--base-ref`)
- P36 — ADR quality advisory (`ADR_ACCEPTED_BODY_THIN`)
- P35 — merged into P33 (no separate phase)

P37 was proposed as an "outcome audit": record per-task metadata (e.g.
`agent_reported_value`, `bugs_found_by_code_pact`, decision-gate / verify
counts) to measure whether code-pact actually helped. We are deferring it.

## Decision rationale

1. **Subjective agent-reported fields are gameable.** An `agent_reported_value:
   decision_clarity` is written by the same agent whose work it scores — it is
   self-assessment, not measurement.

2. **`bugs_found_by_code_pact` contradicts the product's role.** code-pact is a
   control plane for design / progress / execution mode, not a bug detector.
   The whole reshape was about steering agent behavior, not detecting defects;
   a bugs-found metric would be ~always zero and would skew the evaluation axis.

3. **A read-only `stats` view cannot answer the real questions from today's
   data.** The signals that would matter are not reliably derivable from
   `progress.yaml` as it stands:
   - `lifecycleMode` distribution would be *recomputed from the current plan*,
     not the recommendation history that was actually issued at the time.
   - decision-gate block frequency is not recorded (the gate blocks; it does not
     append an event).
   - verify-failure counts are not recorded (`task complete` leaves
     `progress.yaml` byte-identical on failure).
   A `stats` command would emit numbers that look authoritative but do not
   reflect reality — worse than no numbers, because people trust numbers.

4. **New write surface reintroduces "a ledger for the ledger's sake."** Adding
   an `outcome:` block or a measurement command grows the contract surface
   (command, docs, tests, schema) for data we cannot yet act on.

## What follows from this decision

- No `P37` phase, no `task outcome` / `stats` command, no `outcome` schema field.
- The reshape roadmap is considered closed at P36. The next step is **real-world
  dogfooding and release prep**, not more features.

## Revisit conditions

Reconsider an effectiveness-measurement feature only after:

- several real `decision_loop` tasks have exercised the ADR gate (does it keep
  eliciting design decisions?),
- several `record_only` tasks have run the lightweight lane (did it reduce
  ceremony without hiding work?),
- at least one consumer repo runs `validate --strict --base-ref <default>` in CI
  (is `CONTROL_PLANE_BRANCH_NOT_DRIVEN` useful or noisy? are `exclude_globs`
  workable?),

and — having observed the above — the question worth measuring is concrete AND
answerable from data we actually capture (which may first require recording
recommendation history / gate-block / verify-failure events deliberately).

## Related

- [design/decisions/failure-clarity-rfc.md](failure-clarity-rfc.md) — P32, failure clarity.
- [design/decisions/lightweight-lane-rfc.md](lightweight-lane-rfc.md) — P33 + P35, lifecycle mode + recommendation consumption.
- [design/decisions/ci-branch-drift-rfc.md](ci-branch-drift-rfc.md) — P34, CI branch-drift gate.
- [design/decisions/adr-quality-advisory-rfc.md](adr-quality-advisory-rfc.md) — P36, ADR stub advisory.
