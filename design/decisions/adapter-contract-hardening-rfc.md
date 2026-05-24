# Adapter Contract Hardening (P30)

Status: accepted

## Context

P29 fixed a broken `commands.finalize` (`task finalize --agent`) that
`task prepare` emitted, and added a parser roundtrip test so an
unsupported flag in the commands dictionary can no longer pass review.
The root cause was broader than the typo: **the contract surface handed
to agents was not mechanically checked.** `adapter conformance` today
verifies only that required CLI surfaces are *mentioned*
(substring match in `conformance-spec.ts`), not that the guidance
presents `task prepare` as primary or that it is free of the
anti-patterns P29 removed.

P30 extends conformance to enforce the post-P29 contract in adapter
guidance / generated instructions.

## Proposal

Add three conformance checks (pinned by tests; the P29-aligned
claude/codex/generic templates pass by construction):

1. **`task prepare` is primary** — it appears in the per-task workflow
   section AND ahead of the first `recommend` / `task context` mention.
   Structural position check, not NLP.
2. **Anti-pattern rejection** — fail when the generated instruction or
   its examples contain `task finalize ... --agent`, or present
   `recommend` as the primary per-task entrypoint. This is the
   conformance-layer analogue of P29's parser roundtrip test.
3. **Activation rules documented** — the P29-T3 rules
   (`task finalize --write` only after `task complete`;
   `wait_for_dependencies` → do not implement; `CONTEXT_OVER_BUDGET` →
   report, do not widen) are present in the guidance.

### Precision (load-bearing)

Check 3 verifies the rules are **documented**, never that an agent
**obeys** them at runtime. A static instruction-file check cannot
observe runtime behaviour. The conformance output and docs must say so —
overstating this would re-introduce exactly the doctor/conformance
contract-overstatement that P28/P29 corrected.

## Decision: hybrid, version-gated severity (accepted)

The new checks carry a **severity** resolved per install from the
manifest `generator_version`:

- `generator_version` present and semver >= `FROM_VERSION` → **required**
  (a failure makes the adapter non-compliant).
- `generator_version` missing, unparseable, or < `FROM_VERSION` →
  **advisory** (a failure is surfaced as a warning but does NOT make the
  adapter non-compliant).

`FROM_VERSION` is the release that first ships the P29-aligned templates
(the ones that satisfy these checks). P29 + P30 are unreleased; the
current released line is `1.13.3`, whose templates still lead with
`recommend`. Setting `FROM_VERSION` to anything <= `1.13.3` would
hard-fail real `1.13.3` installs that legitimately have the old
templates — the breaking change this hybrid exists to avoid. So:

> **`ADAPTER_CONTRACT_HARDENING_FROM_VERSION = "1.14.0"`** — the
> anticipated next release. This is **release-coupled**: release prep
> MUST confirm the actual P30 release version and bump this constant if
> it differs, so "required" only ever applies to installs that actually
> carry the hardened templates.

The package version is **not** bumped inside the P30 feature work
(version bumps belong to release prep). Consequently, in-tree and CI
installs report `generator_version` `1.13.3` (< `FROM_VERSION`) and the
new checks run at **advisory** there; the templates' *content*
conformance is asserted directly in tests, independent of severity.

### Rationale

- **Required** alone is too strong: pre-P30 installs (old `recommend`-led
  templates) would hard-fail on upgrade — destructive, not safety.
- **Advisory** alone is too weak: freshly generated adapters would only
  warn, so P30 would not actually enforce the post-P29 contract.
- **Hybrid** enforces on adapters that carry the hardened templates and
  warns (with a concrete `adapter upgrade` action) on older ones.

### Output requirements

- Each conformance check result carries an explicit `severity`
  (`required` | `advisory`).
- An advisory failure names the violated rule and the remediation
  (`adapter upgrade <agent> --write`) so the warning is actionable.
- `compliant` is `false` only when a **required** check fails; advisory
  failures are surfaced but keep `compliant: true`.

## Non-goals

- Adapter architecture rewrite or a new adapter schema version.
- New agent support.
- Asserting runtime obedience of behavioural rules.
- `task prepare --record` / making `task prepare` write progress.
- Evidence-harness reproducibility and read_refs (unnumbered future
  capabilities, not part of P30).

## Backward compatibility

Templates were refreshed in P29, so a fresh `adapter install` / `adapter
upgrade` produces conformant output. The only compatibility surface is
the severity decision above: under "required", pre-P30 installs must
re-upgrade; under the hybrid, they warn until they do.
