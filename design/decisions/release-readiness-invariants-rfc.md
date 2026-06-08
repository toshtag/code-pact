# RFC: Release readiness invariants (minimal cut)

**Status:** accepted (P38, 2026-05-30)
**Scope:** internal quality infrastructure only — a shared security corpus exercised at every write entrypoint, a `check-release-version.mjs` + `pnpm release:check` version-consistency gate, a PR self-report template, and trust-boundary docs. No shipped CLI surface, no schema/envelope/exit-code change.
**Owners:** maintainer
**Related:** [task-readiness-schema](task-readiness-schema-rfc.md) (`writes` / protected paths) · [governance](governance-rfc.md) (`createPhase` write chokepoint + reserved-id policy). Phase plan: [P38-release-readiness-invariants.yaml](../phases/P38-release-readiness-invariants.yaml).

## Summary

The 1.26.0 cycle reached release quality only after many rounds of external human review. The repeated findings clustered into four mechanically-detectable classes — author-side / tooling-side gaps that recur every release. P38 closes them with the **minimal** set of mechanisms, built by extending existing tests/fixtures/scripts rather than introducing new frameworks. It protects code-pact's *own* change quality; it is not a product feature.

## The four recurring classes

1. **Surface drift** — a meaning change (e.g. `record_only` becoming a first-class lane) lands in some surfaces but not others (CLI `--help`, `docs/dogfood.md` kept the old framing after prose docs were reconciled).
2. **Schema applied to reads but not writes** — `PlanId` / `RelativePosixPath` were added to read schemas but missed one at a time across write entrypoints (`phase import`, `createPhase`, `task add --id`, `recommend`/`pack --agent`, agent-profile path fields), because there was no inventory of every input path a value flows in through.
3. **Unsafe input reaching path/command sinks** — the same bad-value set (`../evil`, `P1/T1`, `--json`, `/tmp`, …) had to be re-discovered per site; no shared corpus exercised at every entrypoint.
4. **Release-version inconsistency** — `package.json` / CHANGELOG / docs `code-pact@x.y.z` / `RECOMMENDATION_CONSUMPTION_FROM_VERSION` / `design/measurements` version checked by hand at release prep.

## Decisions

1. **P38 is internal quality infrastructure, not a product feature.** No CLI surface, no `stats`, no outcome audit, no AI quality judgement.

2. **Minimal cut, tests-first.** Build only the mechanisms that map to the four classes, by **extending** existing tests/fixtures/scripts:
   - **Shared security corpus + write-entrypoint coverage** (highest priority). A single `BAD_PLAN_IDS` / `BAD_RELATIVE_PATHS` fixture exercised at *every* write entrypoint and schema boundary, pinned against a documented write-entrypoint inventory. *Rationale:* the one mechanism that would have prevented the majority of the 1.26.0 rounds (classes 2 + 3).
   - **`check-release-version.mjs` + `pnpm release:check`** — a deterministic version-consistency check bundling the existing gates into one pre-release command (class 4).
   - **PR self-report template** — a short table (changed contract / command surface / docs-help surface / schema-validation boundary / write entrypoints / added invariant tests / trust-boundary impact) that forces the author to enumerate surfaces at authoring time. *Rationale:* cheapest, highest-leverage — it changes thinking before review (class 1).
   - **Trust-boundary documentation** of the three boundaries (execution = `verification.commands` trusted shell; path = project-relative; identifier = `PlanId`), plus a small `record-done` / `record_only` required-term test, folded into the above (no separate framework).

3. **Generation/dedup is preferred over policing where cheap.** Surface drift is a duplication problem (the same guidance lives in i18n adapters and `src/cli/usage.ts`). Where a canonical string can be shared, prefer that over a checker; required-term tests are a backstop for the 2–3 concepts that actually drifted.

## Alternatives considered (Non-goals — guarded against scope creep)

- **Contract Surface Matrix** (YAML mapping concept → files → required terms) — rejected; a third source of truth that itself drifts, and string-matching detects *absence* but not *contradiction* (a doc can contain `record_only` and describe it wrongly → false confidence). If ever needed, extend `scripts/check-doc-invariants.mjs` for a named concept instead.
- **Golden Consumer Repo framework** — rejected; `tests/fixtures/project-a`/`project-b` + existing CLI integration tests already cover end-to-end flows. Extend them if a scenario is missing.
- **Outcome audit / `stats` / `task outcome`** — rejected here; that is P37, deferred.
- **A large new doc-invariant framework** — rejected; extend the existing `check-doc-invariants.mjs` only as needed.
- **Any new shipped CLI surface** — rejected; `release:check` and the version checker are dev/CI tooling, not part of the published package.

## Open questions (revisit conditions)

If a future release still leaks a surface-drift or schema-application bug that these mechanisms did not catch, reconsider a *narrowly-scoped* extension of `check-doc-invariants.mjs` for the specific concept — not a general matrix.

## References

- RFCs: [task-readiness-schema](task-readiness-schema-rfc.md) · [governance](governance-rfc.md).
- Phase plan: [P38-release-readiness-invariants.yaml](../phases/P38-release-readiness-invariants.yaml).
- Tooling: `scripts/check-release-version.mjs`, `scripts/check-doc-invariants.mjs`, `pnpm release:check`.
