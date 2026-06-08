# RFC: Beginner-friendly CLI aliases

**Status:** accepted (command aliases implemented; the `dogfood.md` rename remains deferred)
**Scope:** four additive command aliases (`task next`, `phase next`, `task reconcile`, `plan import`) as thin dispatch sugar, plus one intentionally-deferred doc rename (`dogfood.md`). Surfaced by documentation UX review.
**Owners:** maintainer
**Related:** [agent-contract-v2-rfc.md](agent-contract-v2-rfc.md) (P21 — `task prepare`, the modern entry point) · [lightweight-runbook-rfc.md](lightweight-runbook-rfc.md) (P12 — `task runbook` / `phase runbook`) · [stability-taxonomy.md](stability-taxonomy.md) (the v1.0 freeze these aliases must not violate).

## Summary

Documentation review found several command/file names that are not self-explanatory to newcomers, forcing the docs to spend words compensating: `task finalize` (why, after `task complete`?), `phase import` (sounds single-phase), `runbook` (jargon), `dogfood.md`. The decision: add a small set of **additive** aliases that read better for first-time users, under compatibility rules that keep them safe. Rationale and the compatibility constraints below back [`docs/cli-contract.md` § Command aliases](../../docs/cli-contract.md#command-aliases).

## Implemented aliases

Each alias is thin dispatch sugar to the same handler — identical flags, exit codes, JSON envelope, and error codes — documented in `docs/cli-contract.md` and covered by `tests/integration/cli-aliases.test.ts` (structural equivalence plus alias-specific human-facing error wording, not blanket byte-identical output). The canonical command stays **primary** (documented, adapter-emitted, conformance-checked); aliases are **secondary Stable public aliases** — additive, not removable during v1.x, never semantically divergent.

| Canonical | Alias | Why |
| --- | --- | --- |
| `task runbook <id>` | `task next <id>` | "what do I do next?" is what newcomers ask; `runbook` stays canonical, `next` is the friendly door. |
| `phase runbook <id>` | `phase next <id>` | mirrors `task next`. |
| `task finalize <id>` | `task reconcile <id>` | verb-consistent with the existing `phase reconcile`; "reconcile design status" reads clearer than "finalize". |
| `phase import <yaml>` | `plan import <yaml>` | ingests a whole multi-phase roadmap, not one phase; fits the `plan` cluster. |

`plan adopt` was considered and intentionally **left as-is** — `adopt` is acceptable, no alias added.

## Deferred doc rename

`docs/dogfood.md` → `docs/maintainer-quick-guide.md` is deferred. "dogfood" is insider jargon, but the rename would need a compatibility stub at the old path (it is referenced by many `design/phases/*.yaml` fields, which would otherwise trip `plan lint`'s `TASK_*_REF_NOT_FOUND`, per the `migration.md` lesson). The doc is already framed as a maintainer guide, so the cost outweighs the benefit for now.

## Why aliases are constrained

The v1.0 stability taxonomy freezes the public CLI surface across the v1.x line. Aliases are **additive** (`task next` does not remove `task runbook`), so they are allowed under the taxonomy — but each documented alias is itself public surface the project must keep stable, and it splits "one obvious way to do it" into two. Hence the set is small, the canonical name stays primary, and the constraints below are load-bearing.

## Constraints any implementation must honor

1. **Additive only.** Existing names (`task finalize`, `phase import`, `task runbook`, …) keep working unchanged; aliases dispatch to the same handlers.
2. **Aliases are secondary Stable public aliases — not "free" sugar.** Once documented in `docs/cli-contract.md` an alias is public surface: it cannot be removed during v1.x and must not diverge semantically. The canonical name stays the **primary** documented command and is what conformance / `adapter` generation emits; aliases are listed *as aliases*, not as first-class entries.
3. **Alias-facing UX.** Because aliases target newcomers, their human-facing CONFIG_ERROR / usage messages name the invoked alias (and point at the canonical command), even though the JSON envelope, exit code, and error code are identical to the canonical command.
4. **Runbook output is Stable (v1.3+).** `next_steps[].command` strings must keep emitting canonical commands unless a separate compatibility note explicitly modernizes them.
5. **File renames keep a compatibility stub** at the old path (the `migration.md` precedent), updating `design/phases/*.yaml` references only if the stub is later removed.
6. **Tests + docs land together.** An alias without a documented mapping and a test is drift.

## Alternatives considered

- **Rename `dogfood.md` now** — rejected; the compat stub + `design/phases/*.yaml` reference churn outweigh the benefit, and the doc already reads as a maintainer guide. Deferred, not abandoned.
- **Alias `plan adopt`** — rejected; `adopt` is already acceptable, so a second name would only split surface.
- **Treat aliases as throwaway sugar** (removable, free to diverge) — rejected; once documented they are public surface under the v1.x freeze, so they carry the same stability obligations as canonical commands.
- **Promote aliases to first-class / teach them in onboarding docs** — not done here; onboarding keeps teaching canonical commands. Introducing aliases into beginner docs, or revisiting the rename, is a separate deliberate copy pass, not required by this decision.

## References

- RFCs: [agent-contract-v2-rfc.md](agent-contract-v2-rfc.md) (P21) · [lightweight-runbook-rfc.md](lightweight-runbook-rfc.md) (P12) · [stability-taxonomy.md](stability-taxonomy.md).
- Docs: [docs/cli-contract.md § Command aliases](../../docs/cli-contract.md#command-aliases) · [docs/migration.md](../../docs/migration.md).
