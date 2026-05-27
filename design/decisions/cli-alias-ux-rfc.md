# RFC: Beginner-friendly CLI aliases

**Status:** accepted (command aliases implemented; the `dogfood.md` rename remains deferred)
**Scope:** additive command aliases (`task next`, `phase next`, `task reconcile`, `plan import`) and one *still-deferred* doc rename, surfaced by documentation UX review. The four command aliases are implemented as thin dispatch sugar; the `dogfood.md` rename is intentionally not done (see below).
**Owners:** maintainer
**Related:** [agent-contract-v2-rfc.md](agent-contract-v2-rfc.md) (P21 — introduced `task prepare`, the modern entry point these aliases relate to). [lightweight-runbook-rfc.md](lightweight-runbook-rfc.md) (P12 — `task runbook` / `phase runbook`). [stability-taxonomy.md](stability-taxonomy.md) (the v1.0 freeze these aliases must not violate).

## Summary

Documentation review found that several command and file names are not self-explanatory to newcomers, so the docs spend words compensating: `task finalize` (why, after `task complete`?), `phase import` (sounds single-phase), `runbook` (jargon), and the file name `dogfood.md`. This RFC catalogs **additive** aliases that read better for first-time users, alongside the compatibility rules that keep them safe.

**Implemented:** `task next` → `task runbook`, `phase next` → `phase runbook`, `task reconcile` → `task finalize`, `plan import` → `phase import`. Each is thin dispatch sugar to the same handler (same flags / exit codes / envelope / error codes), documented in [`docs/cli-contract.md` § Command aliases](../../docs/cli-contract.md#command-aliases), and covered by `tests/integration/cli-aliases.test.ts` (structural-equivalence assertions plus alias-specific human-facing error wording — not blanket byte-identical output). Canonical commands remain the **primary** documented and adapter-emitted commands; the aliases are **secondary Stable public aliases**: additive, not removable during v1.x, and never semantically divergent from their canonical command.

**Not done:** the `dogfood.md` → `maintainer-quick-guide.md` rename — its bookkeeping cost (a compat stub + many `design/phases/*.yaml` references) outweighs the benefit, and the doc is already clearly framed as a maintainer guide.

## Why aliases are constrained

The v1.0 stability taxonomy freezes the public CLI surface (command names, flags, exit codes, envelope shapes, error codes) across the v1.x line. Aliases are **additive** — adding `task next` does not remove `task runbook` — so they are *allowed* under the taxonomy. But each alias, once documented, is itself public surface the project must keep stable, and it splits "one obvious way to do it" into two. That is why the set is small, the canonical name stays primary, and the constraints below are load-bearing.

## Implemented aliases

| Canonical | Alias | Why |
| --- | --- | --- |
| `task runbook <id>` | `task next <id>` | "what do I do next?" is what newcomers actually ask. `runbook` stays the canonical/contract name; `next` is the friendly door. |
| `phase runbook <id>` | `phase next <id>` | mirrors `task next`. |
| `task finalize <id>` | `task reconcile <id>` | verb-consistent with the existing `phase reconcile`; "reconcile design status" reads clearer than "finalize". |
| `phase import <yaml>` | `plan import <yaml>` | the command ingests a whole multi-phase roadmap, not one phase; `plan import` fits the `plan` cluster. |

`plan adopt` was considered and intentionally **left as-is** (`adopt` is acceptable; no alias added).

## Deferred doc rename

| Today | Deferred candidate | Why deferred |
| --- | --- | --- |
| `docs/dogfood.md` | `docs/maintainer-quick-guide.md` | "dogfood" is insider jargon, but the rename would need a compatibility stub (it is referenced by many `design/phases/*.yaml` fields, which would otherwise trip `plan lint`'s `TASK_*_REF_NOT_FOUND`, per the `migration.md` lesson). The doc is already framed as a maintainer guide, so the cost outweighs the benefit for now. |

## Constraints any implementation must honor

1. **Additive only.** Existing names (`task finalize`, `phase import`, `task runbook`, …) keep working unchanged. Aliases dispatch to the same handlers.
2. **Aliases are secondary Stable public aliases — not "free" sugar.** Once an alias is documented in `docs/cli-contract.md` it is public surface users may depend on: it cannot be removed, and it must not diverge semantically from its canonical command. The canonical name stays the **primary** documented command and is what conformance / `adapter` generation emits; aliases are listed *as aliases*, not duplicated as first-class entries.
3. **Alias-facing UX.** Because aliases target newcomers, their human-facing CONFIG_ERROR / usage messages name the invoked alias (and point at the canonical command), even though the JSON envelope shape, exit code, and error code are identical to the canonical command.
4. **Runbook output is Stable (v1.3+).** `next_steps[].command` strings must keep emitting canonical commands unless a separate compatibility note explicitly modernizes them.
5. **File renames keep a compatibility stub** at the old path (the `migration.md` precedent), and update `design/phases/*.yaml` references only if the stub is later removed.
6. **Tests + docs land together.** An alias without a documented mapping and a test is drift.

## Outcome

The four command aliases shipped together (one small PR + a UX-polish follow-up that made alias error messages name the alias). The `dogfood.md` rename stayed deferred. Onboarding docs continue to teach the canonical commands; the aliases are discoverable from `docs/cli-contract.md`. Introducing the aliases into beginner docs, or revisiting the rename, would be a separate deliberate copy pass — not required by this decision.
