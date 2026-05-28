# Upgrading

`code-pact` froze its public CLI surface at v1.0. Everything in the v1.x line is **additive** — new flags, new commands, and new *optional* schema fields, never a breaking change to an existing flag, exit code, JSON envelope, or error code. See [`cli-contract.md` § Stability taxonomy](cli-contract.md#stability-taxonomy-v10).

## Within the v1.x line

Just bump the version. Existing phase YAML, progress logs, and generated adapter files keep working unchanged. New optional features (task readiness fields in v1.1, `task finalize` / `phase reconcile` in v1.2, runbooks in v1.3, the governance layer in v1.5, the declared-writes audit in v1.6, `task record-done` in v1.21, the [decision gate](concepts/decision-gate.md) going status-aware in v1.22, `phase import --scaffold-decisions` in v1.23, …) are opt-in — adopt them on new work; no backfill is required.

### Worth knowing: the status-aware decision gate (v1.22)

One v1.22 change is backward-compatible but worth flagging because it can make a previously-passing task **start blocking**. The decision gate for `requires_decision` tasks now reads the ADR's status, not just its filename: a decision resolves only when its ADR is `**Status:** accepted`. A non-empty ADR with **no** status line still resolves (so projects that predate status-aware parsing are unaffected), but an ADR that explicitly says `proposed` / `draft` / `rejected` / `superseded` — which used to satisfy the gate by filename match alone — will now hold `verify` / `task complete` / `task record-done` until you flip it to `accepted`. If a bump suddenly blocks a task, check the referenced ADR's `**Status:**` line. See the [decision-gate concept](concepts/decision-gate.md) and [`DECISION_REQUIRED` in troubleshooting](troubleshooting.md#decision_required-from-task-record-done-v121).

After bumping the CLI, refresh the generated adapter files:

```sh
code-pact adapter upgrade <agent> --check --json   # inspect drift, write nothing
code-pact adapter upgrade <agent> --write          # apply safe updates
```

An `ADAPTER_GENERATOR_STALE` warning right after a CLI bump is expected — see [troubleshooting.md](troubleshooting.md#adapter_generator_stale-from-adapter-doctor--global-doctor).

## What changed in each release

[`CHANGELOG.md`](../CHANGELOG.md) is the per-release record of what's new. For the concepts behind the larger additions, see the [concepts guides](README.md#concepts).

## Coming from a pre-v1.0 alpha (v0.6 – v0.9)?

New projects use the default `latest` tag (v1.x); pinned alphas remain installable on the `alpha` dist-tag. The detailed alpha-era, version-by-version upgrade notes are archived in [migration.md](migration.md), and the release-by-release history is in [`CHANGELOG.md`](../CHANGELOG.md).
