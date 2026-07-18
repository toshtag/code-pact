# Glossary

Plain-language definitions for the terms used across these docs. When a term
shows up unexplained elsewhere, it is defined here. For the command lifecycle
these terms describe, see [the per-task loop](per-task-loop.md).

## Core ideas

| Term | What it means |
| --- | --- |
| **agent** | The AI coding tool you use — Claude Code, Codex, Cursor, Gemini CLI, etc. code-pact does not include one; it gives the agent you already use a common set of commands to call. |
| **control plane** | The thin layer that sits between your agent and your project. code-pact is the control plane: the agent asks it "what's the context for this task?", "record that I finished", "did verification pass?" — and it keeps the project's state consistent. |
| **design intent vs. operational fact** | Two separate records code-pact keeps on purpose. **Design intent** is what you planned (`design/`). **Operational fact** is what actually happened (the **progress ledger** — see below). They are allowed to differ; commands tell you when they do. |
| **roadmap** | The ordered list of phases for a project, stored in `design/roadmap.yaml`. |
| **phase** | A group of related tasks with one objective and one verification command. Stored as `design/phases/<phase>.yaml`. |
| **task** | The unit of work an agent picks up. Identified as `P1-T1` (see below). |
| **P1-T1 (task / phase IDs)** | The naming scheme for work items. `P1` = phase 1, `P1-T1` = task 1 of phase 1. The numbers are just sequence, not priority. |

## State and the per-task loop

| Term | What it means |
| --- | --- |
| **progress ledger** | The append-only log of what happened: `started` / `done` / `blocked` / `resumed` / `failed` events; code-pact never edits a past event. Stored as one file per event under `.code-pact/state/events/` (merge-safe for collaboration); a legacy monolithic `.code-pact/state/progress.yaml`, if present, is still read and merged. |
| **derived state** | A task's current state, computed from its latest progress event: `planned` (no events yet) → `started` → `done`, with `blocked` / `resumed` / `failed` along the way. See [the lifecycle diagram](per-task-loop.md). |
| **design status** | The `status` field inside a phase YAML (`planned` / `in_progress` / `done`). This is design intent — it is **not** changed by `task complete`; you flip it with `task finalize` once the work is actually done. |
| **context pack** | Deterministic Markdown content code-pact builds for a single task, containing exactly what the agent needs to implement it: the task description, the files it should read, relevant decisions, and acceptance criteria. `task context` builds and returns/prints it; `task prepare` (and the low-level `pack`) write it to the agent profile's `context_dir` (default `.context/<agent>/<task-id>.md`). |
| **verification command** | The shell command a phase declares to prove its tasks work (e.g. `pnpm test`). `task complete` runs it and only records `done` if it passes. |
| **finalize / reconcile** | `task finalize` flips one task's design status to `done`; `phase reconcile` does it for a whole phase at once. Both sync design intent up to the operational fact after the work is done. |
| **record-done** | Records a `done` event **without** running `task complete`'s verification commands — the proof is `--evidence`, and the event is marked `source: external`. Two uses: (1) work completed **outside** the loop (already merged, or not verifiable from the working tree); (2) the `record_only` lane, where you run verification yourself and record the result. It does not run loop verification, but the decision gate still applies. `record_only` is a lighter loop, **not** lighter verification. |
| **source (loop / external)** | A field on a `done` progress event: `loop` = completed through the normal `task complete` flow; `external` = recorded by `task record-done`. Lets later diagnostics tell loop-verified completion from externally-asserted completion. |

## Planning and schema

| Term | What it means |
| --- | --- |
| **brief / constitution** | Two short documents that capture project intent. The **brief** says what you are building and for whom; the **constitution** lists the principles every decision should respect. Stored in `design/`. The constitution is scaffolded by `init`; the brief is optional and created on demand by `plan brief` (or `plan prompt`), not by `init`. |
| **plan adopt** | A command that converts an existing structured plan (a `roadmap.md` / `TODO.md` / `tasks.md`, or a draft YAML) into code-pact phases and tasks — no AI round-trip. |
| **task readiness fields** | Optional fields a task can declare to shape its context pack and enable checks: `depends_on`, `reads`, `writes`, `decision_refs`, `acceptance_refs`. All optional; tasks work without them. See [task readiness fields](concepts/task-readiness-fields.md). |
| **write audit** | When you finalize a task, code-pact compares the files it declared in `writes` against the files actually changed, and reports mismatches as advisories. `--audit-strict` turns those advisories into a non-zero exit (for CI). |
| **decision gate** | The enforced check that a `requires_decision` task has an **accepted** ADR before it can complete — it blocks `verify` / `task complete` / `task record-done` until one exists. See [the decision gate](concepts/decision-gate.md). |
| **ADR (decision record)** | An Architecture Decision Record: a markdown file under `design/decisions/` whose `**Status:**` line (`accepted` / `proposed` / `draft` / `rejected` / `superseded`) the decision gate reads. `accepted` resolves the gate. |

## Output and diagnostics

| Term | What it means |
| --- | --- |
| **envelope** | The shape of a `--json` response: `{ "ok": true, "data": {…} }` on success, or `{ "ok": false, "error": { "code", "message" } }` on failure. The "envelope" is just that consistent wrapper. |
| **exit codes** | `0` success · `1` a check failed (e.g. verification) · `2` a usage/validation error · `3` an internal error. The full table is in [cli-contract.md](cli-contract.md#exit-codes). |
| **advisory** | A warning code that reports something worth knowing but does **not** fail the command — its `affects_exit` is `false`, so it stays advisory **even under `--strict`** (it is counted under `advisories`, never `errors`/`warnings`). Distinct from an exit-relevant *warning* (`affects_exit` unset/true), which default lint reports informationally but `--strict` / `--audit-strict` **do** promote to a failure. |
| **recommendation (recommend)** | The execution plan code-pact suggests for a task: which model tier, how much effort, how much to plan, and which **lifecycle** to run (`lifecycleMode`: `full_loop` / `record_only` / `decision_loop` — `record_only` is the lighter lane for small, strongly-verified work, completed via `record-done` without skipping verification). Returned on its own by `recommend`, and bundled into `task prepare`. |
| **contextFit (recommended context budget)** | An optional, additive recommendation field on the `recommend` / `task prepare` result (P48): a standard context budget profile (`tight` / `balanced` / `wide`), its byte value, and a one-line reason, derived deterministically from `context_size` / `ambiguity` / `write_surface`. It is a **suggestion only** — never auto-applied. Re-sizing the context pack stays explicit via `--context-budget <profile>`. Distinct from the categorical `budgetProfile`; no network, model, or tokenizer is used. |
| **explain metrics (context fit)** | The additive byte metrics on `task context --explain --json` (P49): `natural_bytes` (the pre-budget pack size), `final_bytes` (equals `total_bytes` / `context_pack_bytes`), `saved_bytes` / `saved_ratio` (budget-driven elision only), `minimum_achievable_bytes` (the achievable floor — the same value `CONTEXT_OVER_BUDGET` reports), `elided_sections` (budget-elided sections only), and `budget_bytes` (present only when a budget was applied). All **byte-based, not token-based**, computed locally and deterministically — no summarization, model, tokenizer, or network. They make the existing budget behavior observable; they add no new context reduction. |
| **Context Fit advisories** | The four opt-in `plan lint --include-quality` advisories (P50, Context Fit layer d) that flag likely context-size risk **before** a task runs: `TASK_CONTEXT_PACK_LARGE` (natural pack > balanced 60000 bytes), `TASK_CONTEXT_BUDGET_UNACHIEVABLE` (recommended budget — default-agent same-name override when available, else built-in fallback — below the shared `minimum_achievable_bytes` floor), `TASK_DECLARED_DECISION_LARGE` (a `decision_refs` body > tight 30000 bytes), and `TASK_READS_MATCH_TOO_MANY` (a `reads` glob matching > 100 files). All are `affects_exit: false` (never change the exit code, even under `--strict`), use **deterministic byte/count thresholds**, and are **local** — they reuse the P49 explain metrics and P48 recommendation, read files, and expand globs, with **no model / tokenizer / summarization / compression / network**. They are **readiness signals, not correctness failures**: a large pack, decision, or read glob can be legitimate. They change no pack content and apply no budget automatically. |
| **dry-run** | Preview mode — the command shows what it *would* change but writes nothing. Pass `--write` to actually apply it. |

## Adapters and integration

| Term | What it means |
| --- | --- |
| **adapter** | The piece that generates an agent's own instruction files from code-pact's contract — e.g. the `claude-code` adapter writes `CLAUDE.md` and `.claude/skills/`. One adapter per agent. |
| **adapter conformance** | A read-only check that an installed adapter's generated files still tell the agent everything the contract requires. Run `adapter conformance <agent>`; you do not edit the check yourself. |
| **adapter doctor / drift** | "Drift" is when generated adapter files no longer match what the current code-pact would produce. `adapter doctor` detects it; `adapter upgrade --write` fixes it. |
| **dogfooding** | Running code-pact on its own development. The code-pact repo manages its own roadmap with code-pact; [dogfood.md](dogfood.md) is that walkthrough. |
