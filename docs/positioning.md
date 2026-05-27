# Positioning

This document defines what `code-pact` is, what it deliberately
is not, the surfaces it exposes, and the metrics by which the
project measures whether it is delivering on its premise. Unfamiliar
with a term used here? See the [glossary](glossary.md).

## What code-pact is

`code-pact` is a **vendor-neutral execution control plane for
AI coding agents**. It standardizes how any supported agent
fetches per-task context, records progress, and verifies
completion against a project's design source of truth.

The project keeps two state surfaces:

- **`design/`** — the structured source of truth. Roadmap,
  phase YAML, task readiness fields, decisions, acceptance
  references, and rules all live here, version-controlled,
  schema-validated, lint-able.
- **`.code-pact/state/progress.yaml`** — the operational log.
  An append-only event stream of `started` / `done` / `failed` /
  `blocked` / `resumed` events that drives state-machine
  transitions and renders runbook output.

Around those two surfaces, `code-pact` ships a small set of
stable verbs an agent uses to advance work. The CLI is the
contract; everything else (instruction files, skills, hooks
generated per agent) is derived from it via adapters.

## What code-pact is not

The project's scope is held narrow on purpose. The following
are explicitly out of scope and will not ship in any version
of `code-pact`:

- **No LLM API calls.** `code-pact` does not embed model
  clients, does not route requests to any provider, and does
  not consume tokens at runtime. The agent the user has
  configured does the inference.
- **No orchestration framework.** There is no event bus, no
  task queue, no daemon, no scheduler. The agent invokes
  `code-pact` as a CLI; `code-pact` returns and exits.
- **No RAG, no vector database, no semantic search.** Context
  selection is deterministic — driven by task readiness
  fields (`context_size`, `ambiguity`, `write_surface`,
  `depends_on`, `reads`, `writes`, `decision_refs`,
  `acceptance_refs`), not by embedding similarity.
- **No web UI, no desktop app.** All interaction is via the
  CLI and the generated per-agent instruction files.
- **No external tracker integration.** No GitHub Issues, no
  Linear, no Jira sync. The user wires those into their own
  agent or CI as needed.
- **No multi-agent orchestration.** Each invocation operates
  on one task for one agent. Coordinating multiple agents
  against the same task is out of scope.

These non-goals are load-bearing. Each one rules out a class
of complexity that would otherwise dilute the deterministic
"single CLI surface for the agent to call" promise.

## Core surfaces

The CLI is organised around a per-task lifecycle plus a small
set of phase-level and adapter-level commands. Each verb has
a stable JSON envelope, a documented exit code contract, and
a fixed flag surface across the v1.x line.

- **`code-pact recommend`** — returns an execution plan for a
  given task: model tier, effort, planning posture, context
  budget profile, preflight steps.
- **`code-pact task prepare`** *(v1.11+)* — single
  progress-read-only entry point per task. Returns current
  state, recommendation, context pack metadata, a structured
  `next_action`, and a `commands` dictionary listing every
  per-task verb. Replaces the older pattern of agents stitching
  `recommend` + `task context` + state inspection manually.
- **`code-pact task context`** — builds the deterministic
  Markdown context pack for a task and writes it to
  `.context/<agent>/<task-id>.md`. With `--explain` *(v1.11+)*
  the JSON envelope adds a per-section `bytes` + `reason_code`
  breakdown so the inclusion decisions become auditable.
- **`code-pact task start` / `task complete` / `task
  finalize`** — the state-machine transitions. `start` records
  the `started` event; `complete` runs the verification
  commands declared on the task and appends `done` on pass;
  `finalize` reconciles declared writes against actual git
  changes.
- **`code-pact task block` / `task resume`** — explicit
  blocked-state transitions for dependency or external waits.
- **`code-pact verify`** — runs the declared verification
  commands for a task without recording an event. Used to
  pre-flight a `task complete`.
- **`code-pact phase reconcile`** — phase-level reconciliation
  of task statuses against progress events; writes phase YAML
  status updates when run with `--write`.
- **`code-pact adapter install` / `adapter upgrade` / `adapter
  doctor`** — adapter lifecycle. `install` writes the
  per-agent instruction files and registers a manifest;
  `doctor` detects drift across manifest, generator, and
  contract surfaces.
- **`code-pact adapter conformance`** *(v1.11+)* — focused
  read-only check that the installed adapter satisfies the
  agent contract: required CLI surface mentions, three
  contract axes, failure guidance, per-file checksum.
- **`code-pact validate`** — CI-friendly health check across
  schema, manifest, and plan integrity.
- **`code-pact plan lint`** — diagnostic linter over phase
  YAML files; `--strict` mode promotes warnings to failures
  for CI gating.

## Success metrics

These are the project's own measures of whether `code-pact` is
delivering on its premise. Baseline values were measured by
the Evidence Harness v2 (P26) against the dogfood corpus and
are recomputed on every harness run.

- **Context pack p50 / p90 / max bytes.** The cost of being
  the agent's context source. The promise is that
  task-specific reads stay tight against the task's actual
  needs; the inverse (a fat constant pack) would mean the
  context machinery is dead weight.
- **First-pass verification rate.** Percentage of `task
  complete` invocations whose declared verification passes on
  the first attempt, across the dogfood corpus. A proxy for
  whether the context pack delivered what the agent needed to
  implement the task correctly.
- **Task lifecycle adherence rate.** Percentage of agent
  sessions where the recommended lifecycle (`task prepare ─►
  task start ─► implement ─► verify ─► task complete ─► task
  finalize`) was followed without skipping or reordering. A
  proxy for whether the contract is legible enough to act on.
  The v2 operational definition counts a task as adherent when
  it has at least one `started` event before its first `done`
  event AND does not exhibit the legacy v0.6 `planned → done`
  shortcut. `task prepare` invocations are not currently
  observable in `progress.yaml` (it is a read-only command and
  emits no event), so the metric measures state-machine
  adherence only — a future phase may add prepare-event
  tracking and tighten the definition.
- **Undeclared write rate.** Files changed by a task whose
  paths are not covered by the task's declared `writes` globs.
  A proxy for whether the task readiness schema is rich
  enough to describe the work the agent actually did.
- **Adapter drift detection rate.** Frequency at which
  `adapter doctor` and `adapter conformance` surface real
  drift between expected and actual adapter state across the
  dogfood corpus. A proxy for whether the adapter contract is
  enforced operationally rather than only declared. The v2
  gate counts an agent as drifted when `adapter doctor`
  returns any error-severity issue; warning-only states (e.g.
  `ADAPTER_GENERATOR_STALE` alone) keep the agent counted as
  clean.

### Baseline values

The current numbers live in **one** place —
[`design/measurements/summary.json`](../design/measurements/summary.json)
(plus the per-task CSVs beside it) — generated by the Evidence Harness v2
and refreshed on each release with `pnpm harness --corpus . --write`. They
are deliberately **not** copied into this prose, so the figures can never
drift between the narrative and the source of truth. The file records the
metric values, the dogfood-corpus git SHA, the denominators
(`tasks_done` / `tasks_total` / `agents_enabled`), and the generation date.

Two standing caveats on that snapshot:

- **Lifecycle adherence sits below 100%** — the gap is historical tasks
  (mostly pre-v0.7) that used the legacy `planned → done` shortcut, not
  current behaviour.
- **Undeclared-write rate is `deferred`** ([rationale](../design/decisions/evidence-harness-v2-rfc.md#non-goals-out-of-scope-for-p26))
  — it awaits a future phase that attributes git commits to tasks via
  lifecycle instrumentation.

Reproduce or refresh: `pnpm harness --corpus . --check` (read-only) or
`--write` (overwrite the committed snapshot).

## How positioning relates to scope

When a feature is proposed, it is evaluated against the four
non-negotiables this document encodes:

1. Does it preserve the "agent calls a stable CLI; that is
   the entire contract" promise?
2. Does it stay vendor-neutral, or does it bake a single
   agent's assumptions into the project state?
3. Is the work expressible as deterministic context-shaping
   and progress-state-machine machinery, or does it require
   inference?
4. Does it move one of the success metrics above, or is it
   work that has no measurable connection to the project's
   stated outcome?

Features that fail any of these are not necessarily wrong; they
belong in a different project, or in a layer above
`code-pact`, not inside it.
