# Greenfield workflow

This guide is for projects where **no production code exists yet**. You are starting from an empty git repo (or one with only scaffolding) and want `code-pact` to structure the build from day one.

If you're adding `code-pact` to an existing codebase, read [`brownfield-feature.md`](brownfield-feature.md) instead. For the command sequences themselves, see [`docs/getting-started.md`](../getting-started.md) — this document covers **what to write in the prompts**, **how to shape the first phases**, and **which onboarding path matches a greenfield project**.

## Which onboarding path

| If you... | Use |
| --- | --- |
| ...just want to verify the install works against a throwaway repo | [Tutorial path](../getting-started.md#path-1--tutorial) |
| ...already have a clear mental model of the first 1-2 phases | [Manual path](../getting-started.md#path-2--manual) |
| ...want an AI agent to draft the full roadmap from a brief | [AI-assisted path](../getting-started.md#path-3--ai-assisted) |

For most greenfield projects with non-trivial scope, **AI-assisted is the highest-leverage path** — you give your agent the brief and constitution, it produces a phase breakdown in one pass, and `phase import` ingests the YAML deterministically.

## What to put in the brief and constitution

Two interactive wizards, run once at the start of the project, write the foundation that every later prompt and context pack will reference. Filling them with real content is what makes the AI-assisted path produce a useful roadmap instead of generic scaffolding.

```sh
code-pact plan brief         # → design/brief.md
code-pact plan constitution  # → design/constitution.md
```

`plan brief` asks three questions: **what we're building**, **who it's for**, **what makes it different**. Be specific. "A CLI tool that..." beats "A developer tool". Concrete users beat "developers". A real differentiator beats a vague one.

`plan constitution` collects a description plus **core principles** as a comma-separated list. Principles are not aspirations — they are the constraints the agent should treat as non-negotiable. Examples that actually constrain behaviour:

- *"All public surfaces ship JSON-only stdout under `--json`."*
- *"No LLM API calls from this CLI."*
- *"Atomic-write every file under `design/` and `.code-pact/state/`."*

Avoid principles like "write clean code" or "be user-friendly" — they don't change any decision.

## How to shape the first phases

A greenfield project typically wants a **foundations phase first**, then **one feature phase per externally-observable capability**, then **a stabilization phase before any v1 cut**. This pattern matches `code-pact`'s own roadmap (`P1 Foundations` → `P2..P7 incremental capabilities` → `P8 Stable Control Plane`) and is what most AI agents will produce when prompted via `plan prompt`.

| Phase shape | Typical contents |
| --- | --- |
| **Foundations (P1)** | Project scaffolding, core schemas, the smallest end-to-end skeleton that exercises every subsystem once. Heavy on `type: architecture` tasks. |
| **Capability phases (P2..Pn)** | One phase per coherent capability, scoped so a single PR pattern (one task = one PR) is realistic. `type: feature` dominates. |
| **Stabilization (Pn+1)** | Coverage backfill, public-contract freeze, migration docs, no new features. `type: test` and `type: docs` dominate. |

Weights are an annotated estimate, not a budget. 5–30 is the typical band per phase. Equal weights across phases is fine for a first pass.

## When to keep the sample phase

The `init` wizard offers to create a **sample phase** (`P1 Welcome`) by default. For greenfield projects with non-trivial scope, **delete it once `plan prompt` + `phase import` have produced your real `P1`** — the AI-generated phase id will collide with the sample phase, so importing without removing the sample first raises `DUPLICATE_PHASE_ID`. See [`docs/concepts/sample-phase.md`](../concepts/sample-phase.md) for the keep/rename/delete decision in full.

## Recommended first PR

The smallest useful first PR on a greenfield project is **one task in P1 that exercises the verify command end-to-end**. That confirms:

- `code-pact init` produced a valid `design/` tree and `.code-pact/project.yaml`.
- `adapter install` produced a `CLAUDE.md` / `AGENTS.md` / agent-instructions.md that the agent can actually read.
- `task complete` runs `pnpm test` (or whatever verify command you picked) and writes a `done` event.

After that single round trip, the rest of the roadmap is mechanical.

## Next reading

- [`docs/getting-started.md`](../getting-started.md) — command sequences for all three onboarding paths.
- [`docs/concepts/sample-phase.md`](../concepts/sample-phase.md) — keep / rename / delete decision for the wizard's sample phase.
- [`docs/cli-contract.md`](../cli-contract.md) — full flag and JSON envelope reference.
