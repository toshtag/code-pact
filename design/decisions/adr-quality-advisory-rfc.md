# RFC: ADR quality advisory (stub-only)

**Status:** accepted (P36, 2026-05)
**Scope:** one advisory-only `plan lint --include-quality` code, `ADR_ACCEPTED_BODY_THIN`, that surfaces an `accepted` ADR with a near-empty body. Additive; never affects exit code. No heading/section sniffing, no decision-gate change.
**Owners:** maintainer
**Related:** [context-fit](context-fit-rfc.md) (P46 — reuses this RFC's `affects_exit: false` advisory pattern).

## Summary

An `accepted` ADR with an empty body slips the decision gate today: marking `accepted` is sufficient. The value of an ADR is that writing it *elicits the design decision* — so we surface "accepted but no recorded reasoning" without turning code-pact into an ADR-template enforcer. One advisory (`ADR_ACCEPTED_BODY_THIN`), structure-independent, advisory-only.

## Decisions

1. **One advisory, stub-only.** A single `plan lint --include-quality` code, `ADR_ACCEPTED_BODY_THIN`, fires when an `accepted` ADR's body is nearly empty. No other ADR-quality codes.

2. **No heading-name / section sniffing.** Detecting "missing Consequences / Alternatives / Decision sections" is rejected: this repo's legitimate ADRs use widely varying heading sets (`## Context`+`## Decision`+`## Rationale`; `## Proposal`+`## Accepted approach`+`## Why`; `## Problem statement`+`## Goals`+`## Proposed schema`; …). Any heading-name match would false-positive on valid ADRs and reduce P36 to template enforcement. The goal is stub visibility, not template uniformity.

3. **Structure-independent thinness signal, conservative AND.** Fire only when BOTH hold: the substantive body (frontmatter removed; status line and h1 title stripped; whitespace normalized) is `< ADR_THIN_BODY_CHARS` (400), **AND** the raw body has zero `##` (h2) headings. The smallest legitimate ADR in this repo is ~3610 bytes with 3 h2 headings, so it never fires — only empty-to-a-few-lines stubs do. The AND avoids flagging "short but structured" and "long but heading-free prose" ADRs alike. Threshold calibrated against the real ADR corpus; rationale recorded in source.

4. **`accepted`-only; the accepted-status-only stub IS the target.** `classifyAdr` returns `"empty"` only for a literally 0-byte (whitespace-only) file; a `**Status:** accepted` line — or no status line at all (the lenient backward-compat case) — classifies as `"accepted"`. So the case P36 most wants to catch — a file that is *just* an accepted status line with no reasoning — is in scope. Only a truly empty file is excluded (neither status nor body; a different concern).

5. **Advisory, never a hard gate.** `affects_exit: false` — it does not fail `plan lint`, even under `--strict` (existing advisory contract). The `task complete` / `verify` decision gate is unchanged. A canonical ADR template, if ever introduced, is the only thing that would justify decision-section advisories — and that is a separate future phase.

The issue payload is `{ code: "ADR_ACCEPTED_BODY_THIN", severity: warning, affects_exit: false, file, details: { body_chars, heading_count } }`. The code is registered in `KNOWN_CODES` and the cli-contract plan-diagnostics table.

## Alternatives considered

- **Heading/section-based codes** (`ADR_ACCEPTED_WITHOUT_CONSEQUENCES` / `_WITHOUT_ALTERNATIVES` / `_NO_DECISION_CONTENT`) — rejected; false-positive prone given the repo's diverse ADR heading structures (Decision 2).
- **A hard gate** — rejected; advisory only, so it never blocks completion (Decision 5).
- **Body check for proposed/draft ADRs** — rejected; only `accepted` carries the "approved but empty" contradiction worth surfacing.
- **Changing the `task complete` / `verify` decision gate** — rejected; out of scope, the gate stays as-is.

## Open questions

- A canonical ADR template (if ever introduced) is the only thing that would justify decision-section advisories — deferred to a separate future phase, not this one.

## References

- RFCs: [context-fit](context-fit-rfc.md) (P46 — reuses `affects_exit: false`).
- Code: [lint.ts](../../src/core/plan/lint.ts) (`detectAdrAcceptedBodyThin`) · [adr.ts](../../src/core/decisions/adr.ts) (`classifyAdr`).
- Docs: [docs/cli-contract.md](../../docs/cli-contract.md) (plan-diagnostics table).
