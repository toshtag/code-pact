# RFC: Release readiness invariants (minimal cut)

- Status: accepted
- Phase: P38
- Date: 2026-05-30

## Problem

The 1.26.0 cycle (P32–P37 + identifier/path hardening) reached release quality
only after many rounds of external human review. The repeated findings were
not random — they clustered into four mechanically-detectable classes:

1. **Surface drift** — a meaning change (e.g. `record_only` becoming a first-
   class lane) landed in some surfaces but not others; `task record-done`'s
   CLI `--help` and `docs/dogfood.md` kept the old "external-completion-only"
   framing after the prose docs were reconciled.
2. **Schema applied to reads but not writes** — `PlanId` / `RelativePosixPath`
   were added to the read schemas, but the *write entrypoints* (`phase import`,
   `createPhase`, `task add --id`, `recommend`/`pack` `--agent`, agent-profile
   path fields) were missed one at a time across several rounds because there
   was no inventory of "every input path a value flows in through."
3. **Unsafe input reaching path/command sinks** — the same bad-value set
   (`../evil`, `P1/T1`, `--json`, `/tmp`, …) had to be re-discovered per site;
   there was no shared corpus exercised at every entrypoint.
4. **Release-version inconsistency** — `package.json` / CHANGELOG / docs
   `code-pact@x.y.z` / `RECOMMENDATION_CONSUMPTION_FROM_VERSION` /
   `design/measurements` version are checked by hand at release prep.

These are author-side and tooling-side gaps, not a product-design gap. They are
worth closing because they recur every release and consume disproportionate
review.

## Decisions

1. **P38 is internal quality infrastructure, not a product feature.** It adds
   no CLI surface, no `stats`, no outcome audit, no AI quality judgement. It
   protects code-pact's *own* change quality.

2. **Minimal cut, tests-first.** Build only the mechanisms that map to the four
   classes above, by **extending** existing tests/fixtures/scripts rather than
   introducing new frameworks:
   - **Shared security corpus + write-entrypoint coverage** (highest priority).
     A single `BAD_PLAN_IDS` / `BAD_RELATIVE_PATHS` fixture exercised at *every*
     write entrypoint and schema boundary, plus a write-entrypoint inventory the
     coverage test is pinned against. This is the one mechanism that would have
     prevented the majority of the 1.26.0 rounds.
   - **`check-release-version.mjs` + `pnpm release:check`.** A deterministic
     version-consistency check, bundled with the existing gates into one
     pre-release command.
   - **PR self-report template.** A short table (changed contract / command
     surface / docs-help surface / schema-validation boundary / write
     entrypoints / added invariant tests / trust-boundary impact) that forces
     the author to enumerate surfaces at authoring time — the cheapest, highest-
     leverage item because it changes thinking before review.
   - **Trust-boundary documentation** of the three boundaries (execution =
     `verification.commands` trusted shell; path = project-relative; identifier
     = `PlanId`), and a small `record-done` / `record_only` required-term test,
     folded into the above tasks (no separate framework).

3. **Generation/dedup is preferred over policing where cheap.** Surface drift is
   ultimately a duplication problem (the same guidance lives in i18n adapters
   and `src/cli/usage.ts`). Where a canonical string can be shared, prefer that
   over a checker. Required-term tests are a backstop for what cannot yet be
   generated, kept to the 2–3 concepts that actually drifted.

## Non-goals (explicitly NOT built — guard against scope creep)

- **No Contract Surface Matrix** (a YAML mapping concept → files → required
  terms). It becomes a third source of truth that itself drifts, and string-
  matching detects *absence* but not *contradiction* (a doc can contain
  `record_only` and still describe it wrongly → false confidence). If ever
  needed, extend `scripts/check-doc-invariants.mjs` for a named concept instead.
- **No Golden Consumer Repo framework.** `tests/fixtures/project-a` /
  `project-b` and the existing CLI integration tests already cover end-to-end
  flows; extend them if a scenario is missing rather than building a new
  harness.
- **No outcome audit / `stats` / `task outcome`** (that is P37, deferred).
- **No large new doc-invariant framework** — extend the existing
  `check-doc-invariants.mjs` only as needed.
- **No new shipped CLI surface.** `release:check` and the version checker are
  dev/CI tooling, not part of the published package.

## Tasks

- **T0** — this RFC + phase registration (bootstrap).
- **T1** — shared security corpus (`BAD_PLAN_IDS` / `BAD_RELATIVE_PATHS`) +
  write-entrypoint coverage test pinned to a documented entrypoint inventory.
- **T2** — `scripts/check-release-version.mjs` + `pnpm release:check` (bundles
  the existing gates) + the trust-boundary doc note.
- **T3** — PR self-report template (`.github` / CONTRIBUTING) + a `record-done`
  / `record_only` required-term test.

## Revisit conditions

If a future release still leaks a surface-drift or schema-application bug that
T1–T3 did not catch, reconsider a *narrowly-scoped* extension of
`check-doc-invariants.mjs` for the specific concept — not a general matrix.
