# Upgrading

`code-pact` froze its public CLI surface at v1.0. Everything in the v1.x line is **additive** — new flags, new commands, and new *optional* schema fields, never a breaking change to an existing flag, exit code, JSON envelope, or error code. See [`cli-contract.md` § Stability taxonomy](cli-contract.md#stability-taxonomy-v10).

## Within the v1.x line

Just bump the version. Existing phase YAML, progress logs, and generated adapter files keep working unchanged. New optional features (task readiness fields in v1.1, `task finalize` / `phase reconcile` in v1.2, runbooks in v1.3, the governance layer in v1.5, the declared-writes audit in v1.6, …) are opt-in — adopt them on new work; no backfill is required.

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
