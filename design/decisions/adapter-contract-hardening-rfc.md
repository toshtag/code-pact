# Adapter Contract Hardening (P30)

**Status:** accepted (P30)
**Scope:** three new `adapter conformance` checks that enforce the post-P29 contract in adapter guidance / generated instructions, gated by a version-resolved severity.
**Owners:** maintainer
**Related:** P29 (fixed the broken `commands.finalize` = `task finalize --agent` that `task prepare` emitted, and added the parser-roundtrip test these checks mirror at the conformance layer).

## Summary

Before P30, `adapter conformance` verified only that required CLI surfaces are *mentioned* (substring match in `conformance-spec.ts`) — not that the guidance presents `task prepare` as primary or is free of the anti-patterns P29 removed. P30 adds three structural checks and resolves their severity per install from the manifest `generator_version`, so they enforce on adapters that carry the hardened (P29-aligned) templates and only warn on older ones.

## Conformance checks

Three checks (pinned by tests; the P29-aligned claude/codex/generic templates pass by construction):

1. **`task prepare` is primary** — it appears in the per-task workflow section AND ahead of the first `recommend` / `task context` mention. Structural position check, not NLP.
2. **Anti-pattern rejection** — fail when the generated instruction or its examples contain `task finalize ... --agent`, or present `recommend` as the primary per-task entrypoint. The conformance-layer analogue of P29's parser-roundtrip test.
3. **Activation rules documented** — the P29-T3 rules are present in the guidance: `task finalize --write` only after `task complete`; `wait_for_dependencies` → do not implement; `CONTEXT_OVER_BUDGET` → report, do not widen.

**Precision (load-bearing):** check 3 verifies the rules are **documented**, never that an agent **obeys** them at runtime — a static instruction-file check cannot observe runtime behaviour. The conformance output and docs must say so; overstating it would re-introduce the doctor/conformance contract-overstatement that P28/P29 corrected.

## Decision: hybrid, version-gated severity

Each check carries a `severity` resolved per install from `generator_version`:

- present and semver `>= FROM_VERSION` → **required** (a failure makes the adapter non-compliant).
- missing, unparseable, or `< FROM_VERSION` → **advisory** (a failure is a warning but does NOT make the adapter non-compliant).

`FROM_VERSION` is the release that first ships the P29-aligned templates:

> **`ADAPTER_CONTRACT_HARDENING_FROM_VERSION = "1.14.0"`** — the anticipated next release. **Release-coupled:** release prep MUST confirm the actual P30 release version and bump this constant if it differs, so "required" only ever applies to installs that actually carry the hardened templates.

The released line at decision time is `1.13.3`, whose templates still lead with `recommend`. Setting `FROM_VERSION <= 1.13.3` would hard-fail real `1.13.3` installs that legitimately have the old templates — the breaking change this hybrid exists to avoid. The package version is **not** bumped in the P30 feature work (version bumps belong to release prep), so in-tree and CI installs report `1.13.3` (`< FROM_VERSION`) and the new checks run at **advisory** there; the templates' *content* conformance is asserted directly in tests, independent of severity.

### Rationale

- **Required alone** is too strong: pre-P30 installs (old `recommend`-led templates) would hard-fail on upgrade — destructive, not safety.
- **Advisory alone** is too weak: freshly generated adapters would only warn, so P30 would not actually enforce the post-P29 contract.
- **Hybrid** enforces on adapters that carry the hardened templates and warns (with a concrete `adapter upgrade` action) on older ones.

### Output requirements

- Each check result carries an explicit `severity` (`required` | `advisory`).
- An advisory failure names the violated rule and the remediation (`adapter upgrade <agent> --write`) so the warning is actionable.
- `compliant` is `false` only when a **required** check fails; advisory failures are surfaced but keep `compliant: true`.

## Non-goals

- Adapter architecture rewrite or a new adapter schema version.
- New agent support.
- Asserting runtime obedience of behavioural rules.
- `task prepare --record` / making `task prepare` write progress.
- Evidence-harness reproducibility and read_refs (unnumbered future capabilities, not part of P30).

## Backward compatibility

Templates were refreshed in P29, so a fresh `adapter install` / `adapter upgrade` produces conformant output. The only compatibility surface is the severity decision: under "required", pre-P30 installs must re-upgrade; under the hybrid, they warn until they do.
