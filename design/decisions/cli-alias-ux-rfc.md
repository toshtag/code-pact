# RFC: Beginner-friendly CLI aliases

**Status:** proposed (not yet scheduled)
**Scope:** *candidate* additive command aliases and one doc rename, surfaced by documentation UX review. No implementation is authorized by this RFC — it records the design space and the compatibility constraints so a future phase can decide deliberately.
**Owners:** maintainer
**Related:** [agent-contract-v2-rfc.md](agent-contract-v2-rfc.md) (P21 — introduced `task prepare`, the modern entry point these aliases relate to). [lightweight-runbook-rfc.md](lightweight-runbook-rfc.md) (P12 — `task runbook` / `phase runbook`). [stability-taxonomy.md](stability-taxonomy.md) (the v1.0 freeze these aliases must not violate).

## Summary

Documentation review found that several command and file names are not self-explanatory to newcomers, so the docs spend words compensating: `task finalize` (why, after `task complete`?), `phase import` (sounds single-phase), `runbook` (jargon), and the file name `dogfood.md`. This RFC catalogs **additive** aliases that would read better for first-time users, alongside the compatibility rules that make them safe — or risky. It decides nothing; it exists so the trade-offs are written down before anyone changes the Stable CLI surface.

## Why this is a separate, deferred decision

The v1.0 stability taxonomy freezes the public CLI surface (command names, flags, exit codes, envelope shapes, error codes) across the v1.x line. Aliases are **additive** — adding `task next` does not remove `task runbook` — so they are *allowed* under the taxonomy. But every alias is still public surface the project then has to keep stable forever, and it splits "one obvious way to do it" into two. That cost is real, so aliases should be added only with intent, not reflexively. Hence: documented here, implemented later (if at all).

## Candidate aliases

| Today | Candidate alias | Rationale | Risk / notes |
| --- | --- | --- | --- |
| `task runbook <id>` | `task next <id>` | "what do I do next?" is what newcomers actually ask | Semantics must match exactly. `runbook` stays the canonical/contract name; `next` is the friendly door. |
| `phase runbook <id>` | `phase next <id>` | mirrors `task next` | Same as above. |
| `task finalize <id>` | `task reconcile <id>` | aligns with the existing `phase reconcile`; "reconcile design status" is clearer than "finalize" | Verb consistency with `phase reconcile` is the main win. |
| `phase import <yaml>` | `plan import <yaml>` (or `roadmap import`) | the command imports a whole multi-phase roadmap, not one phase | `plan import` fits the existing `plan` cluster; docs could prefer it for newcomers. |
| `plan adopt <path>` | (leave as-is) | `adopt` ("adopt an existing plan") is acceptable | Low priority — listed only for completeness. |

## Candidate doc rename

| Today | Candidate | Rationale | Risk / notes |
| --- | --- | --- | --- |
| `docs/dogfood.md` | `docs/maintainer-quick-guide.md` | "dogfood" is insider jargon; the file is a maintainer quick guide | **Must** keep `docs/dogfood.md` as a compatibility stub — it is referenced by many `design/phases/*.yaml` fields and would otherwise trip `plan lint`'s `TASK_*_REF_NOT_FOUND` (same lesson as the `migration.md` archive). |

## Constraints any implementation must honor

1. **Additive only.** Existing names (`task finalize`, `phase import`, `task runbook`, …) keep working unchanged. Aliases dispatch to the same handlers.
2. **One canonical name per surface in the contract.** `docs/cli-contract.md` documents the canonical command; aliases are listed as aliases, not duplicated as first-class entries. Conformance/`adapter` generation keeps emitting the canonical names.
3. **Runbook output is Stable (v1.3+).** `next_steps[].command` strings must keep emitting canonical commands unless a separate compatibility note explicitly modernizes them.
4. **File renames keep a compatibility stub** at the old path (the `migration.md` precedent), and update `design/phases/*.yaml` references only if the stub is later removed.
5. **Tests + docs land together.** An alias without a documented mapping and a test is drift.

## Recommendation

Treat aliases as a small, opt-in UX phase, prioritized as: `task next` / `phase next` (highest newcomer value, exact-semantics) > `task reconcile` (verb consistency) > `plan import` (docs-preference, maybe alias-only). The `dogfood.md` rename is lowest priority and highest bookkeeping cost; defer unless a broader docs reorg is happening anyway. Until a phase adopts this, the docs compensate with plain-language framing and the glossary — which is the cheaper lever.
