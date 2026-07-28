# Review contracts

A **review contract** is the part of a task's declaration that describes what a
review of that task has to cover: which layers of the system the change reaches,
which operating systems must be proven, and what evidence the review should look
for. It belongs to the task **before the task is locked**, and once locked it is
immutable.

The problem it exists to solve is the repair loop: a change gets reviewed, a
downstream layer nobody had named turns out to be affected, the change is
repaired, and the cycle repeats — each round discovering one more layer. Naming
the whole boundary up front makes the second, third, and fourth round visible
during planning instead of during review.

> **A declaration is not execution evidence.**
> This contract validates the *planned* review boundary. It does not prove that
> the declared evidence ran, that the required platforms were exercised, or that
> external CI passed. Later work in the same phase adds those checks. Read every
> `claim` below as "what the author asserts", not "what has been demonstrated".

## The two modes

Every contract declares `version: 1` and a `mode`.

### `minimal`

For work whose review boundary is genuinely a single layer. It records only why
the restricted form is honest:

```yaml
review_contract:
  version: 1
  mode: minimal
  rationale: >
    Documentation-only change with no executable, platform, or security
    boundary.
```

`minimal` is available **only** when all four of these hold:

| Field           | Required value                  |
| --------------- | ------------------------------- |
| `type`          | `docs` or `mechanical_refactor` |
| `ambiguity`     | `low`                           |
| `risk`          | `low`                           |
| `write_surface` | `low`                           |

Anything else — a `feature`, a `bugfix`, a medium-risk refactor — must declare a
boundary contract. "This one is small" is precisely the judgement that keeps
turning out to be wrong, so it is not a judgement the contract accepts.

A `minimal` contract must not also carry `stages`, `platforms`, or `evidence`.
Those fields would be ignored, and a silently ignored declaration is worse than
no declaration at all.

### `boundary`

The full form. It disposes of five stages, decides three platforms, and names at
least one piece of evidence:

```yaml
review_contract:
  version: 1
  mode: boundary
  stages:
    - stage: producer
      disposition: in_scope
      claim: The scope script emits flat argv.
      refs:
        - scripts/verification-scope.mjs
    - stage: consumer
      disposition: in_scope
      claim: The classifier validates the producer envelope.
      refs:
        - src/core/verify/classify.ts
    - stage: runner
      disposition: in_scope
      claim: Validated argv reaches a bounded process runner.
      refs:
        - src/core/process/bounded-command.ts
    - stage: os
      disposition: in_scope
      claim: Windows launch semantics are exercised on Windows.
      refs:
        - src/core/process/executable-resolution.ts
    - stage: security
      disposition: in_scope
      claim: Shell and filesystem authority boundaries fail closed.
      refs:
        - scripts/check-fs-authority.mjs
  platforms:
    - platform: linux
      disposition: required
      level: integration
      refs:
        - tests/integration/verification-scope.test.ts
    - platform: macos
      disposition: not_required
      rationale: No macOS-specific launch or filesystem behavior changes.
    - platform: windows
      disposition: required
      level: actual_platform
      refs:
        - tests/unit/core/windows-command-launch.test.ts
  evidence:
    - id: flat-argv-contract
      claim: Producer and consumer agree on a non-empty flat argv.
      level: integration
      refs:
        - tests/integration/verification-scope.test.ts
    - id: windows-runtime
      claim: The real Windows package-manager launch succeeds.
      level: actual_platform
      platform: windows
      refs:
        - tests/unit/core/windows-command-launch.test.ts
```

## Stage semantics

A boundary contract decides **all five** stages, each exactly once, in any order:

| Stage      | The question it answers                                                     |
| ---------- | --------------------------------------------------------------------------- |
| `producer` | What generates the data, command, or artifact this change touches?           |
| `consumer` | What reads or validates it on the other side?                                |
| `runner`   | What actually executes the result — a process, a job, a request?             |
| `os`       | Does behavior differ by operating system?                                    |
| `security` | Does this cross a shell, filesystem, network, or credential authority?       |

Each stage takes one of two dispositions:

- **`in_scope`** — requires a non-empty `claim` (what this layer is asserted to
  do) and at least one `ref`.
- **`not_applicable`** — requires a non-empty `rationale` (why the layer cannot
  be affected) and **no** refs. A layer that cannot be affected has nothing to
  point at.

Marking a stage `not_applicable` is a normal, expected answer. The contract asks
you to *decide*, not to claim everything is in scope.

## Platform semantics

The matrix decides all three of `linux`, `macos`, and `windows`, each exactly
once:

- **`required`** — needs a `level` of `integration` or `actual_platform`, plus at
  least one `ref`. A required platform proven only by `unit`-level evidence is
  rejected: a mocked platform is not the platform.
- **`not_required`** — needs a `rationale` and **no** refs or level.

**The OS rule.** If the `os` stage is `in_scope`, at least one platform must be
`required` at `actual_platform` level. An assertion that operating-system
behavior changes is only settled by running on the real operating system.

## Evidence levels

| Level             | Meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `unit`            | In-process assertion over a pure function or a mocked boundary.          |
| `integration`     | Real components wired together on the running platform.                  |
| `actual_platform` | Executed on the real operating system being claimed — not emulated.      |

Every boundary contract names at least one evidence entry. Each entry needs a
unique `id` within the task, a non-empty `claim`, a `level`, and at least one
`ref`.

An `actual_platform` entry must also name a `platform`, and that platform must be
`required` in the matrix **at `actual_platform` level**. You cannot claim real
Windows proof for a platform the contract says needs none.

## Ref coverage

Refs are checked against the task's own declared scope, not against the
filesystem. A boundary contract routinely names test files the task is about to
*create*, which do not exist at lock time — so existence is deliberately not a
lock condition. (Plan lint still existence-checks `reads` and `acceptance_refs`
separately.)

| Refs on                | Must be covered by                 |
| ---------------------- | ---------------------------------- |
| a stage entry          | the task's `reads` or `writes`      |
| a platform entry       | the task's `writes` or `acceptance_refs` |
| an evidence entry      | the task's `writes` or `acceptance_refs` |

Stage refs describe *the code under review*, so the task must already read or
write it. Platform and evidence refs describe *proof*, so they must be something
the task produces or already accepts as evidence.

Coverage uses the same glob matcher as `reads` and `writes` — a declared
`src/core/verify/**` covers `src/core/verify/classify.ts`. Every ref must be a
safe repository-relative POSIX path; absolute paths and `..` escapes are
rejected.

## Where the contract is enforced

| Surface                       | Behavior                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Task schema (parse)           | Shape only. Unknown keys are rejected on every object so a mistyped key fails loudly instead of being silently stripped.                  |
| `task add`                    | `--review-contract-file <path>` attaches a contract; an invalid one is `TASK_REVIEW_CONTRACT_INVALID`, exit 2, **no phase YAML write**.    |
| `plan lint`                   | `TASK_REVIEW_CONTRACT_MISSING` (advisory, never fails `--strict`) and `TASK_REVIEW_CONTRACT_INVALID` (error).                              |
| `task lock` / `task start`    | A **supplied** contract that does not hold is `TASK_REVIEW_CONTRACT_INVALID`, exit 2, **no lock file written**. Under `review_contract_policy: required`, a **missing** contract is `TASK_REVIEW_CONTRACT_REQUIRED`, exit 2, no lock file and no progress event. |
| Contract lock                 | The whole contract is stored in `contract.review_contract` and folded into the registration digest.                                       |
| Post-lock drift               | Any change to a stage, platform, claim, evidence entry, or ref surfaces as `TASK_CONTRACT_DRIFT` with `review_contract` in `changed_fields`. |

Every surface calls the same validator, so `plan lint` can never accept a
contract that `task add` or `task lock` refuses.

## Authoring a contract

Write the contract fragment to a file and pass it to `task add`:

```bash
code-pact task add P90 --description "Harden the runner boundary" --type feature --write src/core/process/bounded-command.ts --review-contract-file contract.yaml --json
```

The file holds the contract **itself** — `version`, `mode`, and the boundary
fields — not a whole task spec. YAML and JSON both work. `--spec-file` already
carries its own `review_contract`, so the two flags are mutually exclusive; there
is no defined precedence between two contracts, so combining them is refused
rather than silently resolved.

`init --sample-phase` and `code-pact tutorial` generate a worked example of each
mode: the `feature` walkthrough task carries a full boundary contract, and the
`docs` task carries a minimal one.

## The rollout policy

Whether a **missing** contract blocks a new lock is a property of the project,
declared in `.code-pact/project.yaml`:

```yaml
review_contract_policy: required   # advisory | required
```

| Value                  | A task with no `review_contract`                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| field absent (default) | Locks. Read as `advisory` — the state every project is in immediately after upgrading.          |
| `advisory`             | Locks. `plan lint` still reports `TASK_REVIEW_CONTRACT_MISSING`.                                 |
| `required`             | Refused: `TASK_REVIEW_CONTRACT_REQUIRED`, exit 2, no lock file and no progress event.            |

Three properties are deliberate:

- **Absence is not a default written into your file.** The schema has no default,
  so normalizing an existing `project.yaml` never grows the field. "Never heard of
  review contracts" stays distinguishable from "decided not to require them".
- **A typo is not a silent opt-out.** Any value outside the two above is rejected
  by the project schema, so `validate` and `doctor` report it and the lock path
  fails with `CONFIG_ERROR` rather than quietly reverting to `advisory`.
- **`init` writes `required` explicitly.** A new project has no legacy tasks to
  strand, and its generated sample phase ships valid contracts, so it can lock
  its own tutorial task on day one.

The refusal applies to **new** locks only. Existing lock files, archived phases,
done tasks, and already-started work are never rewritten and never
retro-validated.

## Migrating an existing plan

Upgrading cannot make an existing plan unlockable: without the policy field your
project reads as `advisory`, which is exactly its current behavior. To opt in:

1. `plan lint` reports `TASK_REVIEW_CONTRACT_MISSING` for every active task with
   no contract. It is `affects_exit: false`, so it never fails `--strict`.
2. Add contracts task by task, at your own pace.
3. When the active tasks are covered, set `review_contract_policy: required`.
   From then on a new lock without a contract is refused.

An *invalid* contract is a hard error under either policy, because a contract
only exists if someone wrote it after the field did — that cannot be a migration
artifact. It also keeps its own, more specific code: under `required`, a contract
that is present but wrong is still `TASK_REVIEW_CONTRACT_INVALID`, never
"missing".

## Backward compatibility

`review_contract` is optional in the task schema and in the contract lock, so:

- historical `done` tasks and archived phase snapshots stay readable;
- lock files written before the field existed still parse;
- a pre-contract lock of a pre-contract task has the field absent on **both**
  sides, so the digests agree and no drift is reported.

The bootstrap task that introduced this contract was itself locked by a build
that did not know the field existed, and its lock therefore has no
`review_contract`. That is a property of history, not an exemption: there is no
task-id allowlist anywhere in the implementation.

## What this does not prove

- That the declared evidence was executed.
- That the required platforms were actually exercised.
- That external CI completed, or completed green.
- That the claims are true.

Those are separate gates. This contract's only job is to make the review boundary
explicit before the work starts, so the gaps are found during planning rather
than one round of review at a time.

## Related

- [CLI contract](cli-contract.md) — the full error and diagnostic code surface.
- [Task readiness fields](concepts/task-readiness-fields.md) — `reads`, `writes`,
  `acceptance_refs`, and the glob subset the ref-coverage rule reuses.
