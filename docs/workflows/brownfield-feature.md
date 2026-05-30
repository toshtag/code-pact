# Brownfield workflow — adopting code-pact on an existing project

> 🌐 日本語版: [既存に導入 (brownfield)](../ja/workflows/brownfield-feature.md)

This guide is for projects with **existing production code, existing docs, and probably an existing `CLAUDE.md` / `AGENTS.md` / agent rules file**. You want to drive **a specific feature or refactor** through `code-pact`, not retroactively backfill the entire repo's history.

If you're starting from an empty repo, read [`greenfield.md`](greenfield.md) instead. For the command sequences themselves, see [`docs/getting-started.md`](../getting-started.md) — this document covers **scope**, **coexistence with existing agent files**, and **the smallest sensible adoption surface**.

## Scope: one feature, not the whole repo

The mistake to avoid: trying to retroactively express every past feature as a phase. `code-pact` is forward-looking. Its sweet spot is **driving the next piece of work** through a deterministic CLI loop, not auditing what already happened.

The smallest viable adoption surface for a brownfield repo is:

- One phase whose objective names the feature you're building next.
- Two to six tasks under it, each task = one PR.
- One adapter installed (the agent you actually use).

Everything else stays untouched. `code-pact` writes only to `design/`, `.code-pact/`, the adapter's instruction files (`CLAUDE.md` / `AGENTS.md` / etc.), and a `.context/` directory for the agent's per-task pack output. Your existing build, test, deploy, and docs stay where they are.

## Which onboarding path

| If you... | Use |
| --- | --- |
| ...had an agent read the codebase and produce a work plan already | [Existing-plan adoption (`plan adopt`)](../getting-started.md#existing-plan-adoption--plan-adopt) |
| ...want your agent to draft the breakdown now and emit YAML | [Agent-first](../getting-started.md#path-3--ai-assisted) |
| ...prefer to write the phase + tasks by hand | [Manual path](../getting-started.md#path-2--manual) |
| ...just want to smoke-test the install against this repo | [Smoke test (tutorial)](../getting-started.md#path-1--tutorial) — `code-pact tutorial` writes nothing to this repo |

For brownfield, the most natural flow is **agent-driven**: point your coding agent at the existing code, have it produce the next feature's phase + task breakdown, then ingest that deterministically — `plan adopt` for a structured markdown/plan it emits, or `phase import` for a YAML it emits. The brief/constitution wizards are usually skippable here: a brownfield project's intent and principles already live in its existing docs and `CLAUDE.md`, which the agent already reads — grounding the plan in those beats re-typing them. Reach for the **Manual** path when you want precise, hand-authored control over the breakdown.

## Coexisting with an existing `CLAUDE.md` or `AGENTS.md`

If the repo already has a hand-written `CLAUDE.md` (or `AGENTS.md`, `.cursor/rules/`, …), `adapter install` will refuse to overwrite it. There are three resolution paths:

### Option A — adopt the existing file into the manifest

If your existing instruction file is fine as-is and you only want `code-pact` to *track* it (so future upgrades know about it), use the v0.9 `--force` semantics. `--force` is **unmanaged-adoption only**: it never overwrites a managed-modified file, it only brings an existing on-disk file into the manifest.

```sh
code-pact adapter install claude-code --force --json
```

After adoption, the file is `managed`. Future `adapter upgrade --check` runs will report drift if `code-pact`'s templates change relative to your file.

### Option B — let code-pact own it, after you copy what you want out

Move your existing `CLAUDE.md` content into the project somewhere appropriate (`design/constitution.md` for project-wide principles, `design/rules/*.md` for tagged rules), then delete your hand-written `CLAUDE.md` and run `adapter install` cleanly.

This is the cleanest long-term setup. `code-pact` regenerates `CLAUDE.md` from `design/` + adapter templates, so your principles live in one place.

### Option C — keep them separate

If your existing `CLAUDE.md` is doing something `code-pact` can't (e.g. project-specific MCP server config), install a *different* adapter:

```sh
code-pact adapter install generic
```

The `generic` adapter writes `docs/code-pact/agent-instructions.md`, which is a separate file from `CLAUDE.md`. Your hand-written `CLAUDE.md` and `code-pact`'s `agent-instructions.md` coexist; you tell the agent to read both. Less elegant, but unambiguous.

## Verification command for the feature

When you create the brownfield phase, pick a verification command that exercises **only the feature you're building** — not the whole test suite. The phase's `verify.commands` runs on every `task complete`, so a 10-minute full-suite invocation will train you to skip the loop.

Good brownfield verify commands:

- `pnpm test -- path/to/new-feature.test.ts`
- `pnpm exec vitest run src/new-feature/`
- `node --check src/new-feature/index.ts`

You can always switch the verify command later by editing `design/phases/<phase>.yaml` directly — the YAML is the source of truth.

## What not to do

- **Don't retro-fill old phases.** P1 is your *new* feature, not a historical reconstruction.
- **Don't `--force` an `adapter install` to overwrite a hand-edited `CLAUDE.md` you wrote five minutes ago.** v0.9 `--force` is unmanaged-adoption only and will not actually overwrite, but the intent itself is wrong — pick Option B or C above.
- **Don't assume `.code-pact/` is auto-gitignored — it isn't.** `init` adds only `/.local/` (private planning notes — *this* is what the `LOCAL_NOT_GITIGNORED` warning checks) and `/.context/` (regenerable context packs) to `.gitignore`. It does **not** ignore `.code-pact/`, so you decide what to track. The common convention: **commit the project config** (`.code-pact/project.yaml`, `agent-profiles/`, `model-profiles/`) so the team and CI share it; treat `.code-pact/state/` (the append-only `progress.yaml`, locks, baselines) and `.code-pact/adapters/*.manifest.yaml` as committed-for-history or per-developer, as your team prefers. `design/` is always the committed source of truth. See [`docs/cli-contract.md`](../cli-contract.md) for the full state-file write contract.
  - **CI note (v1.26+).** `validate` / `recommend` / `task prepare` read the project config above, so it must be in the CI checkout. If you also use the P34 `CONTROL_PLANE_BRANCH_NOT_DRIVEN` gate (`validate --strict --base-ref`), the **committed** `.code-pact/state/progress.yaml` is the ledger it reads — commit it (it isn't auto-ignored), or `git add -f .code-pact/state/progress.yaml` if your repo deliberately ignores `.code-pact/`. Force-adding only `progress.yaml` is not enough if the config is ignored too.

## Next reading

- [`docs/getting-started.md`](../getting-started.md) — command sequences for every onboarding approach.
- [`docs/cli-contract.md`](../cli-contract.md) — full `adapter install --force` semantics, `task complete` contract, error code reference.
- [`docs/upgrading.md`](../upgrading.md) — if you're upgrading an existing `code-pact` project (not adopting on a brand new one), the upgrade guide is the right entry point instead.
