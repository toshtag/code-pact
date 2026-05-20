# Community

This document explains **where to file what** when interacting with the `code-pact` repository, and the **scope discipline** that keeps the project narrow. For the technical mechanics of contributing (commit style, branch naming, JSON output rules, tag signing, npm publish policy), see [`CONTRIBUTING.md`](../CONTRIBUTING.md) at the repository root.

## Where to file what

| You want to... | File a... | Template / entry point |
| --- | --- | --- |
| Report a wrong behaviour, crash, or unexpected error | **Issue** | [Bug report](https://github.com/toshtag/code-pact/issues/new?template=bug-report.yml) |
| Propose a new flag, command, or behaviour change | **Issue** | [Feature request](https://github.com/toshtag/code-pact/issues/new?template=feature-request.yml) |
| Ask a usage question, share a workflow, discuss design tradeoffs | **Discussion** | GitHub Discussions (see [status](#github-discussions) below) |
| Ship code | **Pull request** | [`.github/pull_request_template.md`](../.github/pull_request_template.md) |

The bug report template asks for `code-pact --version`, the relevant `--json` envelope, and ideally `code-pact doctor --json`. The JSON envelope is the stable contract, so pasting it makes the report actionable without back-and-forth.

The feature request template asks for a **scope check** at the bottom — does the change require something on the [Non-goals (MVP) list](../README.md#non-goals-mvp), and does it affect a `Stable (v1.0)` surface. See [Scope discipline](#scope-discipline) below for why.

## GitHub Discussions

GitHub Discussions is the intended home for design-tradeoff conversations, usage questions, and workflow sharing — anything that does not have a clear "this should change in the CLI" outcome on day one. The intent is to keep the **issue tracker focused on actionable items**: a bug to fix, a feature to ship, a doc to add.

> **Current status:** GitHub Discussions may not be enabled on this repository yet. Until it is, open an Issue with the `discussion` label and the maintainer will convert it to a Discussion once the tab is available. This document will be updated when the tab is enabled.

## Scope discipline

`code-pact` deliberately ships a narrow surface. The Non-goals list in the README is not a wish-list of "things we will eventually add" — it is an active scope guard:

- No LLM API calls
- No web UI, daemon, or vector database
- No GitHub / Linear / Jira integrations
- No multi-agent orchestration
- No RAG / semantic search

Per phase, additional non-goals appear in each `design/phases/<phase>.yaml` under the `non_goals:` key. Those are scoped to the phase and may be reconsidered in later phases without ceremony.

The **MVP non-goals are different**. Re-introducing an item from that list is possible in principle, but it requires an explicit scope tradeoff in the proposal. Concretely:

1. Open a Feature request issue, filling in the scope-check section honestly. Explain the user problem that cannot be solved while staying inside the existing non-goals, and what `code-pact` would lose (narrowness, deterministic surface, no-LLM contract) by accepting the change.
2. If the proposal survives discussion, the maintainer adds the `rfc` label and the issue becomes the canonical record of the scope decision. The issue is not closed when the corresponding PR merges — it stays open until the decision is documented in a phase YAML or `docs/cli-contract.md`.
3. If the proposal is rejected, the issue is closed with a short rationale linking to this section. The same item can be re-proposed later when context has changed; closures are not permanent.

The point of this process is not to gate-keep, it is to make the cost of widening the surface **visible to both the proposer and future maintainers**. `code-pact`'s value comes from being predictable and narrow; adding `n+1` of something to "match what other tools have" usually costs more than it returns.

## Internal planning notes

Per [`CONTRIBUTING.md`](../CONTRIBUTING.md#language-policy), internal planning notes that are not meant for public consumption belong in `.local/` (gitignored). Public-facing design history lives in `design/decisions/` (see the seed corpus added by P9-T6). If you are unsure which one applies, default to a Discussion — public is recoverable, private is harder to surface later.

## Code of conduct

The project does not ship a separate Code of Conduct file at this time. Treat issues, PRs, and discussions as professional correspondence: be specific, be concrete, prefer evidence over assertion. Disagreements about design are normal and expected; disagreements about people are not in scope.

## Related docs

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — branch / commit / JSON output / tag signing / npm publish mechanics.
- [`docs/getting-started.md`](getting-started.md) — first-thirty-minutes onboarding (three paths).
- [`docs/cli-contract.md`](cli-contract.md) — the stable surface this community process is built to protect.
