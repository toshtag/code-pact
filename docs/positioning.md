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

- **`design/`** — the structured source of truth for **active**
  plans. Roadmap, phase YAML, task readiness fields, decisions,
  acceptance references, and rules all live here,
  version-controlled, schema-validated, lint-able. **Completed**
  phases and **retired** decisions are ephemeral: a completed
  phase's runtime truth lives in a `.code-pact/state` archive
  snapshot and a retired decision's in a `.code-pact/state`
  decision record, so a completed `design/phases/*.yaml` or a
  retired `design/decisions/**/*.md` may be hand-deleted once its
  snapshot (for a phase) or record (for a decision) exists.
- **the progress ledger (`.code-pact/state/events/`)** — the operational log.
  An append-only event stream of `started` / `done` / `failed` /
  `blocked` / `resumed` events that drives state-machine
  transitions and renders runbook output.

Derived local caches under `.code-pact/cache/` are intentionally outside those
state surfaces. They may hold regenerable artifacts or bounded local loop-memory
episodes, but they are not shared project truth and deleting them must not
change the plan, progress state, or verification result.

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
- **No shared autonomous memory.** Local loop-memory records may
  help future phases reduce repeated investigation, but they stay
  bounded, gitignored, and advisory. They are not project rules,
  contributor-shared knowledge, or a substitute for verification.
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
a fixed flag surface within a major line.

- **`code-pact recommend`** — returns an execution plan for a
  given task: model tier, effort, planning posture, context
  budget profile, preflight steps, and `lifecycleMode`
  (`full_loop` / `record_only` / `decision_loop`).
- **`code-pact task prepare`** — single
  progress-read-only entry point per task. Returns current
  state, recommendation, context pack metadata, a structured
  `next_action`, and a `commands` dictionary listing every
  per-task verb. As the primary entry point it also writes the
  deterministic context pack to the agent profile's
  `context_dir` (default `.context/<agent>/<task-id>.md`)
  unless `--dry-run`. Replaces the older pattern of agents
  stitching `recommend` + `task context` + state inspection
  manually.
- **`code-pact task context`** — builds the deterministic
  Markdown context pack for a task and returns/prints it; it is
  a read-only diagnostic and does not write the pack file
  (`task prepare` and the low-level `pack` are the writers).
  With `--explain` the JSON envelope adds a
  per-section `bytes` + `reason_code` breakdown so the
  inclusion decisions become auditable.
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
- **`code-pact memory status` / `memory prune`** — local,
  disposable loop-memory cache maintenance. These commands
  report aggregates and apply bounded retention only; memory is
  never a correctness source and is not injected into context.
- **`code-pact phase reconcile`** — phase-level reconciliation
  of task statuses against progress events; writes phase YAML
  status updates when run with `--write`.
- **`code-pact adapter install` / `adapter upgrade` / `adapter
doctor`** — adapter lifecycle. `install` writes the
  per-agent instruction files and registers a manifest;
  `doctor` detects drift across manifest, generator, and
  contract surfaces.
- **`code-pact adapter conformance`** — focused
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
delivering on its premise. They are evaluation criteria, not public CLI
contract. The former generic Evidence Harness has been retired because
the fully archived dogfood corpus no longer produced meaningful live-task
measurements and the dedicated implementation/CI path cost more than the
current signal was worth.

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
  event AND does not exhibit the legacy `planned → done`
  shortcut. `task prepare` invocations are not currently
  observable in the progress ledger (it is a read-only command and
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

### Current evidence

There is no release-refreshed aggregate metrics snapshot. Historical
baselines remain in git history; new measurements should be introduced
only as feature-specific fixtures with a clear contract and a focused
test. The current maintained evidence is the agent-detail byte fixture
introduced for the compact evidence contract at
[`docs/maintainers/evidence/agent-detail-evidence.json`](maintainers/evidence/agent-detail-evidence.json),
which directly verifies that compact agent JSON stays under the intended
byte budget and that large command output is moved into evidence files.

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
