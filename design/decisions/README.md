# Design decisions (RFC index)

Every significant change to `code-pact` is recorded here as an RFC before it
ships. Each file states a **Status**, **Scope**, **Owners**, and **Related**
decisions; the longer ones open with a plain-language **Summary**. These are
the *why* behind the code — the user-facing *how* lives in [`docs/`](../../docs/README.md).

> RFC files are referenced by `acceptance_refs` / `decision_refs` in
> `design/phases/*.yaml`. **Do not rename or move them** — update the index
> here instead.

| Phase | Decision | What it decided |
| --- | --- | --- |
| v1.0 | [Stability taxonomy](stability-taxonomy.md) | Froze the public CLI surface at v1.0 and defined the Stable / Experimental / Deprecated bands. |
| P10 | [Task Readiness Schema](task-readiness-schema-rfc.md) | Added the optional task fields (`depends_on` / `reads` / `writes` / `decision_refs` / `acceptance_refs`). |
| P11 | [Finalization & Reconciliation](finalization-reconciliation-rfc.md) | Added `task finalize` / `phase reconcile` to flip design status to `done` after `task complete`. |
| P12 | [Lightweight Runbook](lightweight-runbook-rfc.md) | Added read-only `task runbook` / `phase runbook` sequencing guidance. |
| P13 | [Planning UX & init hardening](planning-ux-init-hardening-rfc.md) | Made the sample phase opt-in (`init --sample-phase`, `TUTORIAL`), added non-interactive `task add`. |
| P14 | [Governance](governance-rfc.md) | Added the advisory write lock (`LOCK_HELD`), reserved `TUTORIAL`, and extracted the task→phase resolver. |
| P16 | [Agent contract adapter hardening](agent-contract-rfc.md) | Hardened the agent/adapter contract and conformance surface. |
| P18 | [Spec Kit bridge](spec-kit-bridge-rfc.md) | Added the read-only one-way importer for Spec Kit `tasks.md` / `spec.md` / `plan.md`. |
| P19 | [Cross-phase dependencies](cross-phase-deps-rfc.md) | Allowed cross-phase `depends_on` and the aggregated `phase runbook --across-phases`. |
| P20 | [Evidence harness](evidence-harness-rfc.md) | Added the internal-only deterministic dogfood measurement harness. |
| P21 | [Agent Contract v2](agent-contract-v2-rfc.md) | Added `task prepare`, `task context --explain`, and `adapter conformance`. |
| P22 | [Adapter schema v2 — cancelled](P22-cancelled-adapter-schema-v2.md) | **Cancelled.** Recorded why adapter schema v2 / template-signature tracking was not pursued. |
| P24 | [Context budget enforcement](context-budget-rfc.md) | Added `--budget-bytes` and the `CONTEXT_OVER_BUDGET` contract. |
| P26 | [Evidence Harness v2](evidence-harness-v2-rfc.md) | Added aggregate stats and the lifecycle-adherence baselines reported in positioning. |
| P27 | [CLI maintainability](cli-maintainability-rfc.md) | Split the monolithic `src/cli.ts` into a command-cluster layout. |
| P28 | [Spec-conformance remediation](spec-conformance-rfc.md) | Established the RFC-conformance test convention. |
| P30 | [Adapter contract hardening](adapter-contract-hardening-rfc.md) | Further hardened the adapter contract checks. |
| — | [Deterministic roadmap stabilization](deterministic-roadmap-stabilization-rfc.md) | Made AI-assisted roadmap generation reproducible. |
| — | [Beginner-friendly CLI aliases](cli-alias-ux-rfc.md) | Added additive aliases `task next` / `phase next` / `task reconcile` / `plan import` (thin sugar to the canonical handlers). The `dogfood.md` rename stays deferred. |

## ADR status convention

Each ADR opens with a status line on the second line of the file:

```
# <RFC title>

**Status:** accepted (<phase or scope>, <YYYY-MM>)
```

YAML frontmatter is also recognized (`status: accepted` between `---` delimiters at the very top); when both are present, the frontmatter wins.

The status word governs the [decision gate](../../docs/cli-contract.md#error-codes) that protects `requires_decision` tasks (since v1.22, RFC §3-C):

| Word | Gate verdict |
| --- | --- |
| `accepted` | resolves the gate |
| `proposed` / `draft` / `rejected` / `superseded` | does **not** resolve |
| empty file | does **not** resolve |
| explicit unknown word (e.g. a typo) | does **not** resolve |
| **no status line** (non-empty body) | resolves as accepted — the only lenient case, for backward compat with projects that pre-date status-aware parsing |

Resolution chooses one of two paths:

- **`task.decision_refs` (explicit references)** — every referenced ADR must be `accepted`. A single `proposed` / missing / empty / unknown ref fails the gate. This is the strong contract.
- **Filename scan over `design/decisions/`** (no `decision_refs`) — the gate resolves if **any** `.md` whose filename contains the task id is accepted. The any-accepted-wins rule preserves the substring-collision compat (e.g. `P1-T1` also matches `P1-T10-*.md`) that has shipped since v0.x.

When a decision is intentionally not yet settled, leave the ADR at `proposed`. `plan lint --include-quality` surfaces `TASK_DECISION_UNRESOLVED` early; `verify` / `task complete` / `task record-done` block completion until the status is flipped to `accepted`.

`code-pact phase import --scaffold-decisions` (and `plan adopt --write --scaffold-decisions`) generates these `proposed` stubs for you — one per `requires_decision` task that has no ADR yet (RFC §3-D). The stub opens at `proposed`, so it does **not** pass the gate; filling it in and flipping **Status** to `accepted` is the human act that releases it. Opt-in (off by default); existing ADRs are never overwritten.

## Rules

Enforcement rules referenced by the CLI live alongside the decisions:

| Doc | What it covers |
| --- | --- |
| [rules/json-output.md](../rules/json-output.md) | JSON output formatting rules. |
| [rules/protected-paths.md](../rules/protected-paths.md) | Protected-path enforcement rules. |
