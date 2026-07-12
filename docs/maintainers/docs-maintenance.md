# Documentation maintenance

How the docs are organized and **which doc to update for which kind of change**.
The goal is that a feature or fix touches the _one_ doc that owns that concern,
instead of drifting across README / getting-started / cli-contract / dogfood /
concepts every release.

## The map

```text
README.md                       Pitch + shortest runnable entry. Links out; owns no detail.
docs/getting-started.md         First-run guide (onboarding paths + pointer to the loop).
docs/per-task-loop.md           The canonical per-task lifecycle (the single source for it).
docs/glossary.md                Plain-language term definitions.
docs/troubleshooting.md         Diagnostic code → recovery action (user-recoverable).
docs/cli-contract.md            CLI contract SEMANTICS: JSON envelopes, exit codes, error/cause codes, stability. NOT generated flag tables.
docs/cli-reference.generated.md GENERATED from src/cli/spec/* (CommandSpec) — flags/usage/examples for CommandSpec-backed surfaces. Do not hand-edit; run `pnpm gen:cli-reference`.
docs/agent-contract.md          What code-pact guarantees agents + adapter conformance.
docs/positioning.md             What code-pact is / is not + success metrics.
docs/concepts/<feature>.md      How one feature works, for users.
docs/upgrading.md               How to upgrade (forward-looking).
docs/migration.md               Archived pre-v1.0 alpha upgrade notes (compat stub).
docs/dogfood.md                 Maintainer quick guide (running code-pact on itself).
docs/maintainers/operations.md  Deeper, lower-frequency maintainer detail.
design/decisions/**/*.md       Design rationale / RFCs (the "why").
CHANGELOG.md                     Per-release record of what changed.
docs/ja/README.md               Japanese entry point only — links into the English docs. NOT a mirror.
```

## Ownership map — what to update for which change

| Change type                                               | Primary doc to update                                                                                                                                                  | Secondary                                                                                                                            | Do **not** duplicate                                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| New task command / flag                                   | `src/cli/spec/*` (the `CommandSpec`) — parse, help, and [`cli-reference.generated.md`](../cli-reference.generated.md) all derive from it; run `pnpm gen:cli-reference` | —                                                                                                                                    | Do not hand-write the task flag table into `cli-contract.md` (it points at the generated reference)                               |
| New plan/phase/adapter/decision/state/spec command / flag | `src/cli/spec/<cluster>.ts` — parse, help, and [`cli-reference.generated.md`](../cli-reference.generated.md) derive from it; run `pnpm gen:cli-reference`              | `cli-contract.md` for semantics only                                                                                                 | Do not hand-write plan/phase/adapter/decision/state/spec usage lines, flag tables, or basic examples into `cli-contract.md`       |
| New non-migrated command / flag                           | The command's `LEAF_USAGE` rich help (`src/cli/usage.ts`) + the [leaf-help coverage test](../../tests/unit/cli/leaf-help-coverage.test.ts)                             | `cli-contract.md` for its semantics                                                                                                  | Don't ship a mutating/JSON command as a 2-line stub                                                                               |
| New JSON field / envelope / error code                    | [`cli-contract.md`](../cli-contract.md) (the contract semantics)                                                                                                       | `troubleshooting.md` if user-recoverable                                                                                             | Do not put envelope shapes in the generated reference; do not repeat them outside `cli-contract.md`                               |
| Per-task lifecycle change                                 | [`per-task-loop.md`](../per-task-loop.md)                                                                                                                              | README, getting-started, agent-contract, dogfood (pointers only)                                                                     | Do not re-define the lifecycle anywhere else                                                                                      |
| New diagnostic / error code                               | [`cli-contract.md`](../cli-contract.md)                                                                                                                                | [`troubleshooting.md`](../troubleshooting.md) if user-recoverable                                                                    | Do not put recovery prose in dogfood                                                                                              |
| New concept / feature                                     | [`concepts/<feature>.md`](../concepts/)                                                                                                                                | `docs/README.md` index, `glossary.md` if new terms                                                                                   | Do not bury concept docs inside dogfood                                                                                           |
| CI / adoption guidance                                    | [`workflows/ci.md`](../workflows/ci.md) (owns the runnable Actions template)                                                                                           | `cli-contract.md` owns the `--base-ref` contract + detector specs (link to ci.md, don't add YAML); `getting-started.md` owns pinning | Do not scatter new CI steps across cli-contract / getting-started / dogfood                                                       |
| Maintainer-only operation                                 | [`maintainers/operations.md`](operations.md)                                                                                                                           | `dogfood.md` only if it belongs in the daily path                                                                                    | Do not expose it in getting-started                                                                                               |
| Design rationale                                          | [`design/decisions/**/*.md`](../../design/decisions/README.md)                                                                                                         | concept-doc summary if user-facing                                                                                                   | Do not make users read RFCs to use a feature                                                                                      |
| Release notes                                             | [`CHANGELOG.md`](../../CHANGELOG.md)                                                                                                                                   | `upgrading.md` if it changes the upgrade story                                                                                       | Do not restate release history in migration.md                                                                                    |
| Cutting a release                                         | [`maintainers/releasing.md`](releasing.md) (the runbook)                                                                                                               | CHANGELOG, `package.json`                                                                                                            | Do not hand-copy historical measurement values into prose                                                                         |
| New term                                                  | [`glossary.md`](../glossary.md)                                                                                                                                        | the doc that introduces it (one-line)                                                                                                | Do not re-define terms per-doc                                                                                                    |
| Japanese                                                  | `docs/ja/README.md` (entry point only)                                                                                                                                 | —                                                                                                                                    | Do not mirror English docs into `docs/ja/` — the English docs are the single source; only CLI/adapter runtime output is localized |

## Public vs. maintainer vs. private

| Tier                    | Where                                            | Who reads it                                              |
| ----------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| **Public / user**       | `README.md`, `docs/*` (excluding `maintainers/`) | end users, agents                                         |
| **Public / maintainer** | `docs/dogfood.md`, `docs/maintainers/*`          | contributors who run code-pact on the repo                |
| **Private**             | `.local/` (git-ignored), if used                 | maintainers only — internal history, release observations |

Rules:

- A doc should live at the **lowest tier that needs it**. Pure internal history, per-release observations, and model-specific judgement logs do not belong in public docs.
- Workflow and tutorial docs may show task-oriented command examples, but they should link to the generated CLI reference instead of carrying exhaustive migrated-cluster flag tables.
- **Public docs and `design/phases/*.yaml` must never link to private (`.local/`) paths** — that would break the public link checker, external contributors, and CI.
- The reverse is fine: private notes may link to public docs.

## Checks

- [`scripts/check-doc-links.ts`](../../scripts/check-doc-links.ts) (`pnpm check:doc-links`) verifies relative `.md` links and `.md#anchor` targets resolve, and treats a link to a hand-deleted `design/decisions/**/*.md` that is recorded as a retired decision under `.code-pact/state` as _retired_, not broken (design-docs-ephemeral step 7).
- [`scripts/check-public-md-links.ts`](../../scripts/check-public-md-links.ts) (`pnpm check:public-md-links`) is the **disk-only complement** of the record-aware check above: a clickable `.md` link whose target file is absent on disk is a 404 for a human on GitHub, regardless of any record — so a retired decision must be referenced as plain text / a code span in the public doc set (README, CHANGELOG, `docs/**`, live `design/**`, and `.github/**` `.md` + `.yml` issue templates), never as a clickable link. The archived CHANGELOG history is exempt (verbatim point-in-time links).
- [`scripts/check-doc-invariants.mjs`](../../scripts/check-doc-invariants.mjs) (`pnpm check:doc-invariants`) enforces semantic invariants the link checker can't see — e.g. the README tour stays runnable, beginner docs carry no version/RFC noise, and `dogfood.md` stays a quick guide.
- [`scripts/check-history-noise.mjs`](../../scripts/check-history-noise.mjs) (`pnpm check:history-noise`) rejects version tags (`vX.Y`) in protected public-doc prose and `src` comments. Heavy historical docs are grandfathered through [`scripts/history-noise-allowlist.txt`](../../scripts/history-noise-allowlist.txt); the checker also fails on a _stale_ entry — an allowlisted file that no longer has any version tag — so cleaning a doc forces its removal from the list.
- [`scripts/changelog-archive.mjs`](../../scripts/changelog-archive.mjs) (`pnpm check:changelog-archive`) fails when `CHANGELOG.md` is out of date with its archive — either a major older than the current one (read from `package.json`) is still inline, **or** a `history/CHANGELOG-<n>.md` archive exists but is not linked from the `## Older versions` pointer (an orphaned archive). The fix for both is `pnpm changelog:archive` (moves an older major verbatim into [`history/`](history/) and/or re-links an orphaned archive, leaving a pointer). See [`releasing.md`](releasing.md) step 3.
- [`scripts/gen-cli-reference.ts`](../../scripts/gen-cli-reference.ts) (`pnpm check:cli-reference`) fails when [`cli-reference.generated.md`](../cli-reference.generated.md) is out of date with the `CommandSpec` source; regenerate it with `pnpm gen:cli-reference`.
- [`scripts/gen-doc-blocks.ts`](../../scripts/gen-doc-blocks.ts) (`pnpm check:doc-blocks`) fails when a `<!-- @generated:<id> -->` block in a doc no longer matches its typed catalog in `src/contracts/` (e.g. the `spec import` `data.detail` table). It only checks generated-block _drift_ — never prose, style, or concept docs — so it can fail only a PR that touches the generated contract surface (the catalog, the generator, or the block itself); the fix is mechanical: `pnpm gen:doc-blocks`. See [`design/rules/doc-authoring.md`](../../design/rules/doc-authoring.md).
- `pnpm check:docs` chains every sub-check bullet above; required PR CI now runs docs checks when the change-aware classifier detects docs-only or docs-generator changes, while `pnpm test:ci:deep` and release `pnpm release:check` remain strict. (A `check-doc-invariants` rule asserts this list names each sub-command, so it can't drift behind the script.)
- It **cannot** catch _semantically_ stale links — a link whose target file still exists but whose section has moved (e.g. a "see dogfood § Release prep" pointer after Release prep moved to `operations.md`). When you move a section, grep for prose that points at its old home, not just the anchor.
- `tests/unit/error-code-surface.test.ts` hard-fails when a `code:` in `src/` is missing from `KNOWN_CODES` / `cli-contract.md` — so **every error code is always in the contract**. Its failure message also reminds you to add a `troubleshooting.md` recovery entry when the code is user-recoverable.

### Deliberately NOT auto-enforced (verify by hand at release prep)

One ownership-map rule is **human judgement**, so it is intentionally left as a manual check rather than a CI gate (a hard gate here would either over-fire on formatting edits or force a brittle exemption list — and would punish honest doc work). The release-prep runbook ([releasing.md](releasing.md#release-prep-pr-all-automatable-steps)) is where you confirm it for everything shipped since the last tag:

1. **User-recoverable error/diagnostic code → `troubleshooting.md` entry.** Not every code needs one (many are self-explanatory or CI-only); the judgement of "is this worth a recovery walkthrough?" stays with you.

> **No Japanese mirror to sync.** `docs/ja/` holds only `README.md` (an entry point into the English docs). Changing an English usage doc creates **no** `docs/ja/` obligation. Do not reintroduce mirrored `docs/ja/*` pages.
