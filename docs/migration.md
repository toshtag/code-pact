# Migration guide (archive)

> **This archived page preserves the v1.x-era migration notes. For current upgrade
> guidance, start with [upgrading.md](upgrading.md).**
> Within the historical v1.x line, an upgrade was just a version bump — the CLI
> contract stayed frozen and additive within that major.

This page is kept as a compatibility archive. Older design phases, RFC decision
records, and a few concept docs link to its per-version anchors, so the file
path and the section anchors that current docs still link to are preserved
below. Many of the original fine-grained per-release sections were not — the
detailed, release-by-release history now lives in
[`CHANGELOG.md`](../CHANGELOG.md), and the concepts behind each addition live in
the [concepts guides](README.md#concepts).

## v1.0 — the frozen surface

v1.0 froze the public CLI surface (flags, exit codes, JSON envelope shapes,
error codes) across the whole v1.x line. Everything after it is additive. See
[`cli-contract.md` § Stability taxonomy](cli-contract.md#stability-taxonomy-v10).

## v1.0.x → v1.1.0

Adds the optional task readiness fields (`depends_on` / `reads` / `writes` /
`decision_refs` / `acceptance_refs`). Fully additive — pre-v1.1 phase YAML is
unchanged, and a task that declares none of them behaves exactly as before.
Walkthrough: [concepts/task-readiness-fields.md](concepts/task-readiness-fields.md).
Release detail: [`CHANGELOG.md`](../CHANGELOG.md).

## v1.1.x → v1.2.0

Adds `task finalize` (single task) and `phase reconcile` (whole phase) to flip
the design `status` to `done` after `task complete` records the operational
fact. Walkthrough:
[concepts/finalization-reconciliation.md](concepts/finalization-reconciliation.md).
Release detail: [`CHANGELOG.md`](../CHANGELOG.md).

## v1.2.x → v1.3.0

Adds the read-only `task runbook` / `phase runbook` sequencing guidance — they
recommend the next commands but never execute anything. Walkthrough:
[concepts/runbook.md](concepts/runbook.md). Release detail:
[`CHANGELOG.md`](../CHANGELOG.md).

## v1.4.x → v1.5.0

Adds the governance layer: the advisory write lock (`LOCK_HELD`), the reserved
`TUTORIAL` phase id, and the roadmap mutation policy. Walkthrough:
[concepts/governance.md](concepts/governance.md). Release detail:
[`CHANGELOG.md`](../CHANGELOG.md).

## Coming from a pre-v1.0 alpha (v0.6 – v0.9)?

The release-by-release detail (including the alpha-era breaking changes) is in
[`CHANGELOG.md`](../CHANGELOG.md). New projects should use the default `latest`
tag; pinned alphas remain installable on the `alpha` dist-tag. For the current,
forward-looking upgrade story, see [upgrading.md](upgrading.md).
