# Upgrading

`code-pact` froze its public CLI surface at v1.0. Everything in the v1.x line is **additive** — new flags, new commands, and new *optional* schema fields, never a breaking change to an existing flag, exit code, JSON envelope, or error code. See [`cli-contract.md` § Stability taxonomy](cli-contract.md#stability-taxonomy-v10).

## Within the v1.x line

Just bump the version. Existing phase YAML, progress logs, and generated adapter files keep working unchanged. New optional features (task readiness fields in v1.1, `task finalize` / `phase reconcile` in v1.2, runbooks in v1.3, the governance layer in v1.5, the declared-writes audit in v1.6, `task record-done` in v1.21, the [decision gate](concepts/decision-gate.md) going status-aware in v1.22, `phase import --scaffold-decisions` in v1.23, …) are opt-in — adopt them on new work; no backfill is required.

### Worth knowing: the status-aware decision gate (v1.22)

One v1.22 change is backward-compatible but worth flagging because it can make a previously-passing task **start blocking**. The decision gate for `requires_decision` tasks now reads the ADR's status, not just its filename: a decision resolves only when its ADR is `**Status:** accepted`. A non-empty ADR with **no** status line still resolves (so projects that predate status-aware parsing are unaffected), but an ADR that explicitly says `proposed` / `draft` / `rejected` / `superseded` — which used to satisfy the gate by filename match alone — will now hold `verify` / `task complete` / `task record-done` until you flip it to `accepted`. If a bump suddenly blocks a task, check the referenced ADR's `**Status:**` line. See the [decision-gate concept](concepts/decision-gate.md) and [`DECISION_REQUIRED` in troubleshooting](troubleshooting.md#decision_required-from-task-record-done-v121).

### Worth knowing: identifier & path validation (v1.26)

v1.26 tightens two schema rules so that values flowing into generated commands and filesystem paths are safe. Both are backward-compatible for conventional projects but can make a previously-parsing plan **start failing** if it used an unusual value:

- **Plan identifiers** (`Task.id`, `Phase.id`, roadmap `PhaseRef.id`, and agent names) must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` — start with a letter or digit, then letters/digits/`.`/`_`/`-`. This rejects whitespace, slashes, `..`, shell metacharacters, and option-like ids (`--json`, `-P1`). Conventional ids such as `P1-T1`, `P34-ci-branch-drift`, and `claude-code` are unaffected.
- **Agent-profile path fields** (`instruction_filename`, `context_dir`, `skill_dir`, `hook_dir`) and `agents[].profile` must be project-relative POSIX paths: absolute paths, `~`, `..`, `.`, empty segments, and backslashes are rejected. The defaults (`.context/<agent>`, `.claude/skills`, `CLAUDE.md`, `agent-profiles/<name>.yaml`, …) all pass.

If a bump suddenly reports a schema error on a task/phase id, an agent name, or an agent-profile path, rename the offending value to fit these rules.

If `doctor` reports adapter drift after a CLI bump, refresh the generated adapter files:

```sh
code-pact adapter upgrade <agent> --check --json   # inspect drift, write nothing
code-pact adapter upgrade <agent> --write          # apply safe updates
```

A CLI bump on its own is **not** a reason to run `adapter upgrade`. Since v1.30.1 (Issue #340), a bump that changes nothing about your generated adapter files raises **no** `ADAPTER_GENERATOR_STALE` warning — a stale `generator_version` stamp alone is silent. The warning (and the `--check` → `--write` flow above) appears only when the bump actually moved the generated output. See [troubleshooting.md](troubleshooting.md#adapter_generator_stale-from-adapter-doctor--global-doctor).

### Worth knowing: the event-file progress ledger (collaboration-safe state)

The progress ledger moved from a single `.code-pact/state/progress.yaml` array to **one file per event** under `.code-pact/state/events/`. The change is backward-compatible and needs no action, but a few things are worth knowing:

- **Your existing `progress.yaml` keeps working.** It is **read-merged** with any per-event files, so derived task state is unchanged. A legacy-only repo (no `state/events/`) reads byte-for-byte identically — array order is preserved, not silently re-sorted.
- **New events are written as per-event files.** `task start` / `complete` / `block` / `resume` / `record-done` now append one file under `state/events/**` and **no longer write `progress.yaml`**. Per-event files are conflict-free, so two branches can record progress and merge cleanly — that is the point of the change.
- **Migration is optional.** `code-pact plan migrate --write` converts the legacy `progress.yaml` into per-event files (dry-run by default; idempotent; it reports any task whose derived state would change under the merged ordering, so you can review before committing). It **never deletes or rewrites** `progress.yaml` — emptying or removing it is a separate, manual step once you have fully cut over.
- **`init` still writes an empty `progress.yaml`.** A freshly initialized project gets an empty `.code-pact/state/progress.yaml` as a legacy compatibility artifact; the task verbs never write to it (new events go to `state/events/`). It is harmless — leave it as-is, or remove it once you only have event files.
- **Commit `state/events/**`.** It is shared, merge-safe operational state, and CI's branch-drift gate reads the *committed* ledger. See [`cli-contract.md` § State file write guarantees](cli-contract.md#state-file-write-guarantees) for the shared-vs-local policy.

## What changed in each release

[`CHANGELOG.md`](../CHANGELOG.md) is the per-release record of what's new. For the concepts behind the larger additions, see the [concepts guides](README.md#concepts).

## Coming from a pre-v1.0 alpha (v0.6 – v0.9)?

New projects use the default `latest` tag (v1.x); pinned alphas remain installable on the `alpha` dist-tag. The detailed alpha-era, version-by-version upgrade notes are archived in [migration.md](migration.md), and the release-by-release history is in [`CHANGELOG.md`](../CHANGELOG.md).
