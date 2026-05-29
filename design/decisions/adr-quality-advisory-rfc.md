# RFC: ADR quality advisory (stub-only)

- Status: accepted
- Phase: P36
- Date: 2026-05-29

## Problem

The value P2-T1 demonstrated was not the ADR gate itself — it was that writing
the ADR *elicited the design decision*. But today an ADR only has to be marked
`accepted` to pass the gate; an accepted ADR with an empty body slips through.
We want to surface "accepted but no recorded reasoning" — without turning
code-pact into an ADR-template enforcer.

## Decisions

1. **One advisory, stub-only.** Add a single `plan lint --include-quality`
   advisory `ADR_ACCEPTED_BODY_THIN` that fires when an `accepted` ADR's body is
   nearly empty. No other ADR-quality codes.

2. **No heading-name / section sniffing.** Detecting "missing Consequences /
   Alternatives / Decision sections" is rejected. This repo's own legitimate
   ADRs never use `## Consequences` / `## Alternatives` — they use a
   decision/goals/rationale structure, and the heading set varies widely across
   ADRs (`## Context`+`## Decision`+`## Rationale`; `## Proposal`+`## Accepted
   approach`+`## Why`; `## Outcome`+`## Tradeoffs`; `## Problem statement`+`##
   Goals`+`## Proposed schema`). Any heading-name match would false-positive on
   valid ADRs and reduce P36 to a template-enforcement tool. P36's goal is
   stub visibility, not template uniformity.

3. **Structure-independent thinness signal, conservative AND.** Fire only when
   BOTH hold: the substantive body (frontmatter removed; status line and the h1
   title stripped; whitespace normalized) is `< ADR_THIN_BODY_CHARS` (400), AND
   the raw body has zero `##` (h2) headings. The smallest legitimate ADR in this
   repo is ~3610 bytes with 3 h2 headings, so it never fires; only empty-to-a-
   few-lines stubs do. The AND avoids flagging "short but structured" and "long
   but heading-free prose" ADRs alike. The threshold is calibrated against the
   real ADR corpus and its rationale is recorded in source.

4. **`accepted`-only; the accepted-status-only stub IS the target.**
   `classifyAdr` returns `"empty"` only for a literally 0-byte (whitespace-only)
   file; a `**Status:** accepted` line (or no status line at all — the lenient
   backward-compat case) classifies as `"accepted"`. So the case P36 most wants
   to catch — a file that is *just* an accepted status line with no reasoning —
   is correctly in scope. Only a truly empty file is excluded (it has neither
   status nor body; a different concern).

5. **Advisory, never a hard gate.** `affects_exit: false` — it does not fail
   `plan lint`, even under `--strict` (existing advisory contract). The
   `task complete` / `verify` decision gate is unchanged. A canonical ADR
   template, if ever introduced, is the only thing that would justify
   decision-section advisories — and that is a separate future phase, not this
   one.

## Non-goals

- No `ADR_ACCEPTED_WITHOUT_CONSEQUENCES` / `_WITHOUT_ALTERNATIVES` /
  `_NO_DECISION_CONTENT` (heading/section-based — false-positive prone).
- No hard gate; advisory only.
- No change to the decision gate in `task complete` / `verify`.
- No body check for proposed/draft ADRs (only `accepted` carries the
  "approved but empty" contradiction).
