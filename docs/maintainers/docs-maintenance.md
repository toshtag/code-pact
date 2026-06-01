# Documentation maintenance

How the docs are organized and **which doc to update for which kind of change**.
The goal is that a feature or fix touches the *one* doc that owns that concern,
instead of drifting across README / getting-started / cli-contract / dogfood /
concepts every release.

## The map

```text
README.md                       Pitch + shortest runnable entry. Links out; owns no detail.
docs/getting-started.md         First-run guide (onboarding paths + pointer to the loop).
docs/per-task-loop.md           The canonical per-task lifecycle (the single source for it).
docs/glossary.md                Plain-language term definitions.
docs/troubleshooting.md         Diagnostic code → recovery action (user-recoverable).
docs/cli-contract.md            The public CLI contract: flags, exit codes, envelopes, error codes.
docs/agent-contract.md          What code-pact guarantees agents + adapter conformance.
docs/positioning.md             What code-pact is / is not + success metrics.
docs/concepts/<feature>.md      How one feature works, for users.
docs/upgrading.md               How to upgrade (forward-looking).
docs/migration.md               Archived pre-v1.0 alpha upgrade notes (compat stub).
docs/dogfood.md                 Maintainer quick guide (running code-pact on itself).
docs/maintainers/operations.md  Deeper, lower-frequency maintainer detail.
design/decisions/*.md           Design rationale / RFCs (the "why").
CHANGELOG.md                     Per-release record of what changed.
docs/ja/*                        Japanese mirror of first-run / user guides only.
```

## Ownership map — what to update for which change

| Change type | Primary doc to update | Secondary | Do **not** duplicate |
| --- | --- | --- | --- |
| New CLI command / flag / JSON field | [`cli-contract.md`](../cli-contract.md) | `getting-started.md` only if beginner-facing | Do not repeat envelope shapes outside `cli-contract.md` |
| Per-task lifecycle change | [`per-task-loop.md`](../per-task-loop.md) | README, getting-started, agent-contract, dogfood (pointers only) | Do not re-define the lifecycle anywhere else |
| New diagnostic / error code | [`cli-contract.md`](../cli-contract.md) | [`troubleshooting.md`](../troubleshooting.md) if user-recoverable | Do not put recovery prose in dogfood |
| New concept / feature | [`concepts/<feature>.md`](../concepts/) | `docs/README.md` index, `glossary.md` if new terms | Do not bury concept docs inside dogfood |
| CI / adoption guidance | [`workflows/ci.md`](../workflows/ci.md) (owns the runnable Actions template) | `cli-contract.md` owns the `--base-ref` contract + detector specs (link to ci.md, don't add YAML); `getting-started.md` owns pinning | Do not scatter new CI steps across cli-contract / getting-started / dogfood |
| Maintainer-only operation | [`maintainers/operations.md`](operations.md) | `dogfood.md` only if it belongs in the daily path | Do not expose it in getting-started |
| Design rationale | [`design/decisions/*.md`](../../design/decisions/README.md) | concept-doc summary if user-facing | Do not make users read RFCs to use a feature |
| Release notes | [`CHANGELOG.md`](../../CHANGELOG.md) | `upgrading.md` if it changes the upgrade story | Do not restate release history in migration.md |
| Cutting a release | [`maintainers/releasing.md`](releasing.md) (the runbook) | CHANGELOG, `package.json`, `design/measurements/` | Do not hand-copy measurement values into prose |
| New term | [`glossary.md`](../glossary.md) | the doc that introduces it (one-line) | Do not re-define terms per-doc |
| Japanese | `docs/ja/*` (first-run / user guides only) | link to the English primary for everything else | Do not partially translate reference contracts |

## Public vs. maintainer vs. private

| Tier | Where | Who reads it |
| --- | --- | --- |
| **Public / user** | `README.md`, `docs/*` (excluding `maintainers/`) | end users, agents |
| **Public / maintainer** | `docs/dogfood.md`, `docs/maintainers/*` | contributors who run code-pact on the repo |
| **Private** | `.local/` (git-ignored), if used | maintainers only — internal history, release observations |

Rules:

- A doc should live at the **lowest tier that needs it**. Pure internal history, per-release observations, and model-specific judgement logs do not belong in public docs.
- **Public docs and `design/phases/*.yaml` must never link to private (`.local/`) paths** — that would break the public link checker, external contributors, and CI.
- The reverse is fine: private notes may link to public docs.

## Checks

- [`scripts/check-doc-links.mjs`](../../scripts/check-doc-links.mjs) (`pnpm check:doc-links`) verifies relative `.md` links and `.md#anchor` targets resolve.
- [`scripts/check-doc-invariants.mjs`](../../scripts/check-doc-invariants.mjs) (`pnpm check:doc-invariants`) enforces semantic invariants the link checker can't see — e.g. the README tour stays runnable, beginner docs carry no version/RFC noise, and `dogfood.md` stays a quick guide.
- `pnpm check:docs` runs both, and CI runs it on every matrix entry.
- It **cannot** catch *semantically* stale links — a link whose target file still exists but whose section has moved (e.g. a "see dogfood § Release prep" pointer after Release prep moved to `operations.md`). When you move a section, grep for prose that points at its old home, not just the anchor.
- `tests/unit/error-code-surface.test.ts` hard-fails when a `code:` in `src/` is missing from `KNOWN_CODES` / `cli-contract.md` — so **every error code is always in the contract**. Its failure message also reminds you to add a `troubleshooting.md` recovery entry when the code is user-recoverable.

### Deliberately NOT auto-enforced (verify by hand at release prep)

Two ownership-map rules are **human judgement**, so they are intentionally left as a manual check rather than a CI gate (a hard gate here would either over-fire on formatting edits or force a brittle exemption list — and would punish honest doc work). The release-prep runbook ([releasing.md](releasing.md#release-prep-pr-all-automatable-steps)) is where you confirm them for everything shipped since the last tag:

1. **User-recoverable error/diagnostic code → `troubleshooting.md` entry.** Not every code needs one (many are self-explanatory or CI-only); the judgement of "is this worth a recovery walkthrough?" stays with you.
2. **EN usage-doc change → matching `docs/ja/*` update.** Only the mirrored usage docs (`per-task-loop.md`, `getting-started.md`, `glossary.md`, `workflows/*`) — reference contracts stay English-only on purpose. A `git diff <last-tag>..HEAD -- docs/per-task-loop.md docs/getting-started.md docs/glossary.md docs/workflows/` that shows EN changes with no `docs/ja/` counterpart is the signal to sync.
