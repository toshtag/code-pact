# Token-Efficient Development

Code Pact development should reduce total input and rework for users without
creating an unbounded design-review loop for Code Pact itself.

## Scope Closure

For one implementation scope, use at most:

- one implementation review
- one fix-confirmation review

The first review must present all blockers it can find for the current scope.
Each blocker must include severity, reproduction condition, impact, affected
file, fix condition, and required test.

The second review is limited to confirming the first review's blockers. New
findings become backlog unless the fix introduced a regression, security issue,
data loss, public API break, or CI failure. Any exception needs a reproducer.

Do not run a third review for the same scope unless an automated test fails and
the issue is a release blocker.

## Blockers

Release blockers are correctness failures, security issues, data loss, public
contract breaks, required test or CI failures, and boundedness invariant
failures.

Backlog items include naming improvements, future extensions, ahead-of-time
design for unimplemented features, theoretical portability edges, and
unmeasured performance concerns. Backlog does not block the current scope.

## Artifact Identity

Review requests include a tree hash. If the same tree hash is submitted again,
the review result is `unchanged`; do not repeat the same review.

## Agent Self-Review

Before external review, run one self-review and report one summary covering:

- declared writes match the diff
- no out-of-scope feature was added
- each acceptance criterion has a test or stated evidence
- public JSON output was checked where affected
- default output is byte-identical where required
- success, failure, missing cache, and corrupt cache paths are covered where in scope
- `git diff --check` passes
- required verification commands pass

Do not split review into iterative "what should I check next" prompts.

## Development-Efficiency Gate

Run this before external review and during release preparation:

```sh
pnpm check:development-efficiency
```

Before starting a planned architecture or docs-only task, run the prospective
gate:

```sh
pnpm check:development-efficiency -- --next-task <task-id>
```

The check uses `P72-T4` as the baseline. After that baseline, two consecutive
current design-only tasks fail with `DEVELOPMENT_DESIGN_LOOP_EXCEEDED`. A
runtime, test, or script implementation task resets the current streak to zero;
the historical maximum remains diagnostic only. `release:check` runs this gate.

This page is linked from [CONTRIBUTING.md](../../CONTRIBUTING.md) and
[Maintainer operations](operations.md) so the workflow is discoverable.
