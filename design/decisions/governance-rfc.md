# RFC: Governance

**Status:** accepted (P14, 2026-05)
**Scope:** new advisory write lock (`.code-pact/locks/write.lock`) acquired by design-mutating CLI command handlers; new public error code `LOCK_HELD`; reserved-id creation-time block on `phase add` / `phase import` for `TUTORIAL`; task→phase resolver core extraction to `src/core/plan/resolve-task.ts`; docs-only governance for protected-path strict-mode, declared-writes review surface, roadmap mutation policy, and phase status manual-flip convention.
**Owners:** maintainer
**Related:** [design/decisions/task-readiness-schema-rfc.md](task-readiness-schema-rfc.md) (P10 — provides `writes` + `TASK_WRITES_PROTECTED_PATH`). [design/decisions/finalization-reconciliation-rfc.md](finalization-reconciliation-rfc.md) (P11 — provides `task finalize` / `phase reconcile` — the two commands that gain lock acquisition). [design/decisions/lightweight-runbook-rfc.md](lightweight-runbook-rfc.md) (P12 — defers task→phase resolver extraction to P14). [design/decisions/planning-ux-init-hardening-rfc.md](planning-ux-init-hardening-rfc.md) (P13 — introduces TUTORIAL sample-phase artifact; P14 hardens it via creation-time block).

## Summary

Before P14, nothing stopped two design-mutating commands from racing on the same files, `TUTORIAL` could be created as an ordinary phase, and the task→phase resolver was copy-pasted across commands. This RFC adds an **advisory write lock** (surfaced as the `LOCK_HELD` error code), **reserves the `TUTORIAL` phase id** at creation time, and **extracts the resolver** to one module — plus docs-only governance for protected paths, the declared-writes review surface, and the phase-status manual-flip convention. User-facing walkthrough: [docs/concepts/governance.md](../../docs/concepts/governance.md).

## Status lifecycle

- This document opens at status **proposed** in PR1.
- After review approval, and **before** PR1 merges (or in a small follow-up PR per the P11/P12/P13 precedent), the maintainer flips the status line at the top of this file to **accepted**.
- P14-T1 (RFC acceptance) is considered done only after PR1 — with the status line reading `accepted` — has landed on main.
- Subsequent implementation PRs (P14-T2..T8) treat the accepted document as load-bearing. They may not change RFC decisions without a separate RFC-update PR.

## Background

P10–P13 built four layers on top of v1.0's append-only progress / Stable CLI contract:

- **P10** added optional readiness fields on the Task schema (`depends_on`, `decision_refs`, `reads`, `writes`, `acceptance_refs`) with twelve additive lint codes. `TASK_WRITES_PROTECTED_PATH` shipped as a warning-only advisory against a hardcoded seed set (`.git/**`, `node_modules/**`, `.code-pact/**`, `design/roadmap.yaml`, `design/phases/*.yaml`).
- **P11** added `task finalize` / `phase reconcile` as deterministic design-YAML mutations with dry-run-first + `--write` opt-in. `phase_status_candidate` is advisory; phase status is flipped by hand in release prep.
- **P12** added `task runbook` / `phase runbook` as read-only sequencing guidance. The reconcile classifier was extracted to a core module so the runbook builders could reuse it. The task→phase resolver extraction was explicitly deferred to P14.
- **P13** added `init --sample-phase` for scripted bootstrap, `task add` non-interactive flags, and `suggested_next_steps[]` additive output on `plan prompt` / `phase import`. The sample-phase artifact was renamed to `TUTORIAL` to avoid collision with the natural first user phase. Reserved-id hard enforcement was deferred to P14.

What's missing: a deterministic answer to *who can write what, and when*. The current state:

- Two concurrent `task finalize --write` or `phase reconcile --write` invocations would race on the phase YAML write. `docs/cli-contract.md` explicitly notes this is out of scope for v1.0 and defers to v1.x.
- `phase add --id TUTORIAL` succeeds today even though TUTORIAL is conceptually the sample-phase reservation. The `DUPLICATE_PHASE_ID` mechanic catches the practical case (a user re-running init), but doesn't prevent a user from deliberately stomping the reserved id.
- The task→phase resolver is duplicated across 8 sites (7 commands + 1 manual scan in task-runbook). Future commands that resolve task ids will keep adding to the pile.
- `design/roadmap.yaml` writes are structurally already enforced through `createPhase` (the single chokepoint), but this contract is not documented — a future contributor adding a new command that mutates roadmap.yaml could break the invariant unknowingly.

## Problem statement

1. **Concurrent design-write races have no semantic guard.** atomic-text gives file-level durability but no semaphore. Two simultaneous `task finalize --write` operations on different tasks of the same phase will both succeed; one's write will overwrite the other's.
2. **`TUTORIAL` is documented as reserved but not enforced.** docs/concepts/sample-phase.md says the id is reserved for the tutorial artifact, but `phase add --id TUTORIAL` will happily create a real phase with that id, undoing the rename benefit P13 delivered.
3. **The task→phase resolver is duplicated 8 ways.** Every existing task-* command rolls its own scan. A future command that resolves task ids will copy the eighth time. Diagnostic consistency is one bug fix away from drift.
4. **Mutation policy is implicit.** It happens that today only `createPhase` writes roadmap.yaml; only design-mutating commands write phase YAML; only the progress log gets `task complete` events. A new contributor would need to read every command to know which files each one touches.
5. **`plan lint --strict` semantics aren't documented for governance use.** Users running `--strict` in CI today get `TASK_WRITES_PROTECTED_PATH` warnings turning into exit failures — but the dogfood corpus has legitimate `TASK_WRITES_PROTECTED_PATH` advisories on P10-T1, P10-T6, and P11-T1 (which declare writes against design YAML files). Release prep would fail under `--strict` if the user doesn't know to omit the flag.

## Goals

- Add an **advisory write lock** at `.code-pact/locks/write.lock`, acquired at the CLI command handler level for every design-mutating command (the seven `cmd*` entry points listed in § Advisory lock model). Lock contention raises a new public error code `LOCK_HELD` with `data.lock_holder` carrying `{ pid, hostname, cmd, created_at }` for diagnostic display. Read-only commands do **not** acquire the lock.
- **Block `phase add --id TUTORIAL` and `phase import` of TUTORIAL phase entries** at creation time. The block lives in `createPhase` (single chokepoint); `writeSamplePhase` continues to succeed via an internal-only `_isSampleCreation: true` bypass. `phase import` additionally preflights for the TUTORIAL id before any `createPhase` call, so failure mode is byte-identical (zero writes on rejection). Reuses `CONFIG_ERROR`; no new error code.
- **Extract the task→phase resolver** into `src/core/plan/resolve-task.ts` exposing `resolveTaskInRoadmap` (I/O variant) and `resolveTaskInPlanState` (pure variant). Migrate the 8 duplicate sites. Pure refactor — existing tests pass unchanged.
- **Document four governance decisions** in docs/cli-contract.md and docs/migration.md:
  - Protected-path `--strict` semantics + the "don't use `--strict` in release prep" guidance.
  - Declared writes are a review surface (governance signal), not enforcement (P15+).
  - Roadmap mutation policy table: who writes roadmap.yaml, who doesn't.
  - Phase status manual-flip convention (no auto-flip in v1.5.0; future RFC owns the design).
- Preserve every existing Stable contract. Existing commands' success paths are unchanged; the only new failure mode is `LOCK_HELD` (transient, retryable) and `CONFIG_ERROR` for reserved-id violations.

## Non-goals

- **Configurable protected paths.** `PROTECTED_PATHS` stays hardcoded. A `project.yaml`-driven override is a P15+ candidate.
- **Actual write enforcement against declared `writes`.** No git-diff comparison, no runner integration. Declared writes remain a review surface only. P15+ candidate.
- **Phase status auto-flip implementation.** Manual flip remains the release-prep convention. A future RFC may design a `phase reconcile --phase-status` flag or a new `phase finalize` command; P14 does NOT.
- **`--force-lock` flag for stale lock recovery.** If a stale lock exists (e.g. a crashed process), the user must remove the file manually. Auto-detection (PID liveness check + age threshold) is a P15+ design problem.
- **Progress.yaml write locking.** The append-only contract documented in docs/cli-contract.md (worst-case is event reordering, not corruption) makes lock-free safe. P14 does not change progress.yaml semantics. _[Update — collaboration-safe-state RFC: this premise was incorrect. The monolithic read-append-rewrite writer can **lose** a concurrent event, not merely reorder it. P14's decision not to lock still stands, but the real fix is per-event files, not a write lock — see that RFC.]_
- **Lock TTL / automatic stale detection.** P14 ships a manual-recovery lock; TTL is P15+.
- **Cross-phase / multi-project locking.** Single project, single lock file.
- **Configurable reserved-id list.** TUTORIAL is the only reserved id in P14. Adding more requires schema design.
- **`RESERVED_ID_USAGE` advisory plan-lint diagnostic on existing TUTORIAL phases.** P14 only blocks creation-time; existing TUTORIAL phases in user projects are not flagged.
- **New `--strict` semantics.** P14 uses the existing binary `errors + warnings === 0` promotion. Selective per-code promotion (e.g. "promote only `TASK_WRITES_PROTECTED_PATH`") is P15+.
- **LLM / RAG / MCP / multi-agent orchestration / scheduler / issue-tracker integration.** Excluded from the v1.x window.
- **New task or phase schema field.** P14 is entirely additive on existing surfaces.
- **New commands.** P14 adds one new public error code (`LOCK_HELD`); everything else is additive on existing commands.

## Governance model

P14 introduces a thin governance layer with three load-bearing rules:

1. **Design-YAML mutations are serialized by an advisory write lock acquired at the CLI command handler level.** Concurrent `task finalize --write` / `phase reconcile --write` / `createPhase`-routed invocations on the same project block each other via `.code-pact/locks/write.lock`. Read-only commands (`task runbook`, `phase runbook`, `plan analyze`, `task status`, `validate`, `doctor`, `recommend`, `task context`, `plan lint`, `plan normalize`) do NOT acquire the lock.
2. **`TUTORIAL` is a reserved id, enforced at creation time.** Only `init --sample-phase` (via `writeSamplePhase` → internal bypass on `createPhase`) may create a phase with id `TUTORIAL`. `phase add --id TUTORIAL` and `phase import` containing a TUTORIAL entry both raise `CONFIG_ERROR`.
3. **`design/roadmap.yaml` writes are routed through `createPhase`.** This is already structurally true; P14 documents it. Future commands that mutate the roadmap must go through `createPhase` (or be explicitly added to the writer list in a follow-up RFC).

Everything else in this RFC is documentation + small refactor:

- Protected-path `--strict` semantics existed before P14 — `--strict` already promotes `TASK_WRITES_PROTECTED_PATH` to exit-relevant. P14 documents this and adds release-prep guidance.
- Declared writes are surfaced for review by `task finalize` and `task runbook` (P11 / P12). P14 documents the surface as governance signal, not enforcement.
- Phase status manual-flip is the release-prep convention since v1.2.0. P14 documents this and explicitly defers auto-flip to a future RFC.
- The task→phase resolver extraction is a pure refactor — no observable behaviour change.

## Protected path policy

`PROTECTED_PATHS` from `src/core/glob.ts:177-183` stays hardcoded. The seed remains:

- `.git/**`
- `node_modules/**`
- `.code-pact/**`
- `design/roadmap.yaml`
- `design/phases/*.yaml`

`plan lint` continues to emit `TASK_WRITES_PROTECTED_PATH` as `severity: "warning"`. Under `plan lint --strict`, the warning becomes exit-relevant per the existing binary promotion (`strict ? errors + warnings === 0 : errors === 0`). No new lint logic.

**Release-prep guidance.** docs/dogfood.md explicitly states: do **NOT** run `plan lint --strict` in release prep against the dogfood corpus. P10-T1, P10-T6, and P11-T1 declare legitimate writes against `design/roadmap.yaml` and `design/phases/*.yaml` (these tasks are themselves the writers of those files). Under `--strict`, the release-prep verification step would fail. The default `plan lint --json` (no `--strict`) treats them as advisories, which is the intended posture for governance tasks.

Configurable seed (`project.yaml`-driven override) is **P15+**.

## Declared writes enforcement model

P14 does **not** implement actual write enforcement against declared `writes`. Such enforcement requires either:

- A runner that observes file-system writes during command execution, or
- VCS integration (e.g. `git diff` between two commits) to verify declared `writes` covered the actual changes.

Both options are significant scope expansions. P14 defers them to P15+.

What P14 does ship: **clarify that declared `writes` is a review surface**. `task finalize --json` includes `declared_writes` in its envelope (P11). `task runbook --json` includes `state_summary.declared_writes` (P12). These surfaces are governance signal — they let a reviewer (human or agent) compare declared intent to actual change. The signal is **not currently enforced** by code-pact.

docs/concepts/finalization-reconciliation.md and docs/concepts/runbook.md gain a "Declared writes as a governance review surface" subsection explaining this contract and pointing at P15+ as the home for enforcement.

## Roadmap mutation policy

A new section in docs/cli-contract.md documents the structural truth:

| Command | Writes `design/roadmap.yaml`? | Mechanism |
| --- | --- | --- |
| `init` (sample-phase path) | yes | `writeSamplePhase()` → `createPhase` (bypass flag) |
| `phase add` (flag-based) | yes | `runPhaseAdd` → `createPhase` |
| `phase new` (wizard) | yes | `runPhaseNew` → `createPhase` |
| `phase import` | yes (per imported phase) | `runPhaseImport` → `createPhase` |
| `task complete` | no | progress.yaml only |
| `task finalize --write` | no | phase YAML only |
| `phase reconcile --write` | no | phase YAML only |
| `task add` | no | phase YAML only |
| `task start` / `block` / `resume` / `status` | no | progress.yaml or read-only |

The four `createPhase` callers are the **only** code paths that mutate `roadmap.yaml`. This is enforced structurally (no other code calls into `roadmap.yaml`'s saver), so P14 does not need new enforcement code — only documentation.

Future commands that need to mutate roadmap.yaml MUST go through `createPhase` (or land an RFC-update that extends the writer list).

## Phase status policy

Phase status is **never auto-flipped** in v1.5.0. The convention since v1.2.0 has been:

1. Run `phase reconcile <id> --write` to flip task statuses.
2. Hand-edit the phase's own `status` field in the phase YAML file (or commit it via a release-prep PR).

`phase_status_candidate` is advisory only — the v1.2 contract states "phase status is never written by phase reconcile" and v1.4 / v1.5 preserve that.

A future RFC may design auto-flip via:

- A `phase reconcile --write --phase-status` flag, or
- A new `phase finalize <phase-id> --write` command, or
- Something else.

P14 explicitly does NOT design or implement this. docs/migration.md and docs/concepts/finalization-reconciliation.md document the manual-flip convention with a pointer to the future RFC.

## Advisory lock model

### Lock file location and format

Path: `.code-pact/locks/write.lock` (single file). In *this* repo `.code-pact/` is in `.gitignore` (root anchor `/.code-pact/`), so the lock directory is excluded from VCS. Note that `init` does **not** gitignore `.code-pact/` for consumer projects — a consumer that tracks `.code-pact/` config should ignore `.code-pact/locks/` itself, since the lock is per-run runtime state, not a work product.

Content: JSON with diagnostic metadata.

```json
{
  "pid": 12345,
  "hostname": "tochi-laptop.local",
  "cmd": "task finalize P9-T5 --write",
  "created_at": "2026-05-21T10:15:00.000Z"
}
```

### Acquisition mechanism

Uses `node:fs.writeFile` with `{ flag: "wx" }` (write + exclusive create). This is atomic across platforms — if the file exists, the call rejects with `EEXIST`. No POSIX `flock` or advisory-lock dependency.

```typescript
// src/core/locks/write-lock.ts (sketch)
export type LockHolder = {
  pid: number;
  hostname: string;
  cmd: string;
  created_at: string;
};

export type LockHandle = {
  release: () => Promise<void>;
};

export async function acquireWriteLock(
  cwd: string,
  cmd: string,
): Promise<LockHandle> {
  // Test escape: respects CODE_PACT_DISABLE_LOCKS=1 for tests
  // unrelated to lock behaviour. Lock-specific tests delete this
  // env var in their `beforeEach` to exercise real acquisition.
  if (process.env.CODE_PACT_DISABLE_LOCKS === "1") {
    return { release: async () => {} };
  }

  const lockPath = join(cwd, ".code-pact", "locks", "write.lock");
  const lockDir = dirname(lockPath);
  await mkdir(lockDir, { recursive: true });

  const holder: LockHolder = {
    pid: process.pid,
    hostname: hostname(),
    cmd,
    created_at: new Date().toISOString(),
  };

  try {
    await writeFile(lockPath, JSON.stringify(holder), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Lock already held — read existing holder for diagnostics.
      let existing: LockHolder | null = null;
      try {
        const raw = await readFile(lockPath, "utf8");
        existing = JSON.parse(raw) as LockHolder;
      } catch {
        existing = null;  // Lock exists but unreadable / unparseable
      }
      const e = new Error(
        `Another code-pact mutation is in progress: ${existing?.cmd ?? "unknown"} (pid: ${existing?.pid ?? "?"})`,
      );
      (e as NodeJS.ErrnoException).code = "LOCK_HELD";
      (e as NodeJS.ErrnoException & { lock_holder?: LockHolder | null; lock_path?: string }).lock_holder = existing;
      (e as NodeJS.ErrnoException & { lock_holder?: LockHolder | null; lock_path?: string }).lock_path = lockPath;
      throw e;
    }
    throw err;
  }

  return {
    release: async () => {
      try {
        await unlink(lockPath);
      } catch {
        // Best-effort release; lock file may be removed externally.
      }
    },
  };
}
```

### Integration points

The lock is acquired at the **CLI command handler level** (the `cmd*` functions in `src/cli.ts`), NOT inside `createPhase` or other core services. This design lets `phase import` hold a single lock around its multi-phase apply loop (batch transactionality), while `createPhase` itself stays lock-agnostic.

| Command | Lock acquisition point (in `src/cli.ts`) | Coverage |
| --- | --- | --- |
| `init --sample-phase` (or wizard answers yes) | `cmdInit`, just before calling `writeSamplePhase` | Single createPhase call (the sample-phase write) |
| `phase add` | `cmdPhaseAdd`, just before `runPhaseAdd` | Single createPhase call |
| `phase new` (wizard) | `cmdPhaseNew`, after wizard prompts finish, before `runPhaseNew` | Single createPhase call |
| `phase import` | `cmdPhaseImport`, just before `runPhaseImport` | **All createPhase calls in the multi-phase apply loop** — single acquisition covers the entire batch |
| `task add` (both wizard and non-interactive paths) | `cmdTaskAdd`, just before `runTaskAdd` | Single phase YAML write |
| `task finalize --write` | `cmdTaskFinalize`, when `--write` is set, just before `runTaskFinalize` | Single phase YAML write |
| `phase reconcile --write` | `cmdPhaseReconcile`, when `--write` is set, just before `runPhaseReconcile` | The entire reconcile batch (all flips in one lock) |

All acquisitions use try/finally to ensure release on failure. `createPhase` is invoked from inside an outer lock in every CLI path; it does not attempt to acquire its own lock. The few non-CLI callers (e.g. tests that invoke `createPhase` directly) run with `CODE_PACT_DISABLE_LOCKS=1` to skip acquisition entirely.

`task finalize` dry-run and `phase reconcile` dry-run do **not** acquire the lock (they don't write).

`phase import` batch transactionality is intentional: any failure mid-loop (e.g. a `CONFIG_ERROR` from one phase's YAML schema) leaves earlier phases already written, but no concurrent mutation can interleave between the early writes and the failure point. The TUTORIAL reserved-id preflight (see § Reserved id policy / `phase import` preflight semantics) catches that specific case before lock acquisition, ensuring roadmap.yaml is byte-identical on TUTORIAL rejection. Other partial-failure modes (mid-loop schema errors etc.) remain non-transactional in P14 — but the lock ensures they're not made worse by concurrent races.

### Read-only commands

`task runbook`, `phase runbook`, `plan analyze`, `task status`, `validate`, `doctor`, `recommend`, `task context`, `plan lint`, `plan normalize --check` do **not** acquire the lock. They safely observe state concurrently with mutations (with the understanding that they may see a transitional state if a mutation is mid-flight).

### Failure mode

On `EEXIST`:

- Throws an Error with `.code = "LOCK_HELD"`
- `.lock_holder` carries the diagnostic struct (or `null` if the lock file was unreadable)
- `.lock_path` carries the full path so the user knows where to delete if they're certain no command is running
- CLI handler maps to JSON envelope: `{ ok: false, error: { code: "LOCK_HELD", message }, data: { lock_holder, lock_path } }` with exit code 2

### Stale lock recovery (P14 manual; P15+ candidate for automation)

If a previous command crashed without releasing the lock, the lock file persists. P14 does NOT auto-detect or auto-clean. The user must:

1. Verify no `code-pact` command is running.
2. Manually delete `.code-pact/locks/write.lock`.
3. Re-run the command.

Future automation (PID liveness check, age-based stale detection, `--force-lock` flag) is P15+ scope. The conservative manual-recovery default in P14 avoids races where two processes both decide the other is stale.

### Test escape

Parallel test execution (`vitest` runs many tests concurrently in the same project tree) would deadlock if every mutation test acquired the same lock. The helper respects `process.env.CODE_PACT_DISABLE_LOCKS === "1"` and returns a no-op `LockHandle` in that case.

**Scope of the escape:** `CODE_PACT_DISABLE_LOCKS=1` is set in the **vitest setup file** (`tests/setup.ts` or equivalent) so the default for all tests is lock-disabled. This is appropriate because most tests exercise OTHER behaviour and would deadlock waiting on lock acquisition.

**Lock-specific tests must override this default.** The unit tests for the lock helper itself (`tests/unit/core/locks/write-lock.test.ts`) and the integration tests that exercise the `LOCK_HELD` envelope (`tests/integration/json-stdout.test.ts` LOCK_HELD entry) must **explicitly delete** `process.env.CODE_PACT_DISABLE_LOCKS` in their `beforeEach` so they exercise real acquisition / EEXIST paths. Tests assert both the success path (acquire → release → re-acquire works) and the failure path (existing lock → LOCK_HELD with `lock_holder`).

**Public contract status:** `CODE_PACT_DISABLE_LOCKS` is **NOT** documented in `docs/cli-contract.md` or any other public-facing surface. It is a test-only escape hatch with no compatibility guarantee — future releases may remove it without notice. Users who need lock-free behaviour in production should not rely on this env var; lock contention is a transient retryable failure and the correct response is to wait + retry, not to disable locks.

## Reserved id policy

P14 reserves the id `TUTORIAL` (and only that id) for the sample-phase artifact.

### Block point

`createPhase` is the single chokepoint that writes phase YAML + roadmap entries. P14 adds a validation:

```typescript
// src/core/services/createPhase.ts (sketch of the addition)
export type CreatePhaseInput = {
  // ... existing fields ...
  /**
   * Internal-only escape hatch: allows the sample-phase generator
   * (writeSamplePhase in src/commands/init.ts) to create a phase
   * with the reserved id "TUTORIAL". Public callers must omit this
   * flag.
   */
  _isSampleCreation?: boolean;
};

export async function createPhase(opts: CreatePhaseInput): Promise<CreatePhaseResult> {
  // ... existing validation (id collision check) ...

  if (opts.id === "TUTORIAL" && opts._isSampleCreation !== true) {
    const err = new Error(
      `Phase id "TUTORIAL" is reserved for the sample-phase artifact created by \`init --sample-phase\`. Pick a different id.`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }

  // ... rest of existing createPhase ...
}
```

`writeSamplePhase` is updated to pass `_isSampleCreation: true`. No other call site sets this flag.

### Coverage

The block fires on:

- `phase add --id TUTORIAL ...` (flag-based; reuses CONFIG_ERROR exit 2)
- `phase new` (wizard) — if the user types `TUTORIAL` as the id, CONFIG_ERROR fires at the createPhase boundary
- `phase import` of a YAML containing a TUTORIAL phase entry — **rejected via preflight** (see below)

The block does **NOT** fire on:

- `init --sample-phase` (via `writeSamplePhase` with the bypass flag)
- `validate` / `plan lint` / `plan analyze` against an existing TUTORIAL phase (no warning; existing data is not flagged)
- Any read-only command

### `phase import` preflight semantics

`phase import` mutates multiple phases in a single command invocation. If the TUTORIAL block lived only inside `createPhase`, a multi-phase import could land earlier phases on disk before the TUTORIAL entry is encountered and rejected mid-loop — a **partial import** with inconsistent post-state.

P14 prevents this by adding a **preflight scan** in `runPhaseImport`:

```typescript
// src/commands/phase-import.ts (sketch of the addition)
async function runPhaseImport(opts: PhaseImportOptions): Promise<PhaseImportResult> {
  const input = await loadAndValidateInput(opts);

  // Reserved-id preflight: reject the entire input if ANY phase
  // entry uses a reserved id. Runs before the first createPhase
  // call, so the roadmap stays byte-identical on failure.
  const reservedHits = input.phases.filter((p) => p.id === "TUTORIAL");
  if (reservedHits.length > 0) {
    const ids = reservedHits.map((p) => p.id).join(", ");
    const err = new Error(
      `Phase id "${ids}" is reserved for the sample-phase artifact created by \`init --sample-phase\`. Pick a different id in the import file.`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }

  // Existing import logic — calls createPhase per phase under the
  // command-level lock acquired by cmdPhaseImport.
  for (const phaseInput of input.phases) {
    await createPhase(phaseInput);
  }
  return /* ... */;
}
```

This matches the existing `phase import` pattern for `DUPLICATE_PHASE_ID` (which already preflights before writing).

**Order of operations** (for clarity, since lock and preflight both relate to "before write"):

1. `cmdPhaseImport` (in `src/cli.ts`) acquires the write lock once via `acquireWriteLock(cwd, "phase import")`.
2. `cmdPhaseImport` calls `runPhaseImport(opts)` while holding the lock.
3. Inside `runPhaseImport`, the TUTORIAL reserved-id preflight runs **before** the first `createPhase` call.
4. If the preflight detects `id: TUTORIAL`, `runPhaseImport` throws with `code: "CONFIG_ERROR"` — **the lock is still held** at this point, but no phase YAML or roadmap entry has been written.
5. `cmdPhaseImport`'s `finally` block releases the lock via `LockHandle.release()`.

Failure mode: `phase import` containing TUTORIAL → `CONFIG_ERROR` exit 2, roadmap byte-identical, **zero phase YAML files written**, lock released. The lock acquisition is not wasted work — it serializes the rejected `phase import` against concurrent mutations even though no mutation occurred.

### Error code

**Reuses `CONFIG_ERROR`** (per user decision and brief recommendation). No new `RESERVED_ID` code in `KNOWN_CODES.public`. The error message identifies the reserved id and recommends `init --sample-phase` as the sanctioned path.

### Backward compatibility

Existing projects with a TUTORIAL phase (whether created by `init --sample-phase` or by some other means in v1.4.x) are **untouched**. P14 only blocks new creation; it does not retroactively reject existing data. `validate` / `plan lint` / `plan analyze` do not emit a warning on existing TUTORIAL phases.

### Future advisory

A future RFC may add a `RESERVED_ID_USAGE` plan-lint advisory that flags existing TUTORIAL phases as `severity: "warning"` (visible in `plan lint --json`). P14 does NOT ship this — too aggressive for an existing-data scenario.

## Task→phase resolver refactor

### Current state

Eight sites duplicate the same scan:

```
loadRoadmap → for each ref in roadmap.phases → loadPhase → check tasks[].id
if 0 hits → TASK_NOT_FOUND
if >1 hits → AMBIGUOUS_TASK_ID
otherwise return the single hit
```

Seven sites return `phaseId: string`. One (`task-finalize.ts`) returns `{ phaseId, file }`. One additional site (`task-runbook.ts`) uses `PlanState.taskIndex` then manually rescans for ambiguity (because `taskIndex` silently keeps first match).

### New helper

New module `src/core/plan/resolve-task.ts`:

```typescript
export type ResolvedTask = {
  phaseId: string;
  phasePath: string;  // unified field name (was `file` in task-finalize)
};

export type ResolvedTaskWithEntry = {
  phaseId: string;
  phase: Phase;
  task: Task;
};

/**
 * I/O variant: reads roadmap.yaml + each referenced phase YAML
 * from disk, scans for the task, and returns the unique hit's
 * phaseId + relative path. Throws TASK_NOT_FOUND on zero hits,
 * AMBIGUOUS_TASK_ID on multiple hits.
 *
 * Used by commands that have not yet loaded PlanState.
 */
export async function resolveTaskInRoadmap(
  cwd: string,
  taskId: string,
): Promise<ResolvedTask> { /* ... */ }

/**
 * Pure variant: given an already-loaded PlanState, scans the
 * embedded phase tasks for the task id. Throws TASK_NOT_FOUND /
 * AMBIGUOUS_TASK_ID. Returns the phase + task entries so the
 * caller doesn't need to refetch.
 *
 * Used by commands that already work with PlanState (task-runbook).
 */
export function resolveTaskInPlanState(
  state: PlanState,
  taskId: string,
): ResolvedTaskWithEntry { /* ... */ }
```

### Migration

Seven commands (task-context, task-start, task-block, task-resume, task-complete, task-status, task-finalize) replace their private `resolveTaskPhase` with a call to `resolveTaskInRoadmap`. `task-finalize` adapts the return-field name from `file` to `phasePath` (internal API change, not user-visible).

`task-runbook` replaces its manual scan with `resolveTaskInPlanState`. The ambiguity detection now lives in the helper, not in the caller.

### Pure refactor — no behavioural change

Error codes (`TASK_NOT_FOUND`, `AMBIGUOUS_TASK_ID`) are emitted at the same boundaries, with the same exit codes, and the same JSON envelope shape. Existing unit tests in `tests/unit/commands/task-*.test.ts` pass **unchanged** — this is the load-bearing safety check for the refactor.

New unit tests in `tests/unit/core/plan/resolve-task.test.ts` cover the helper directly (single match / not-found / ambiguous / empty-roadmap edge cases).

## CLI contract / JSON envelope

All P14 additions are additive on existing envelopes:

- **`LOCK_HELD` envelope:** `{ ok: false, error: { code: "LOCK_HELD", message }, data: { lock_holder: { pid, hostname, cmd, created_at } | null, lock_path: string } }`. Exit code 2.
- **Reserved-id (TUTORIAL) envelope:** Reuses `{ ok: false, error: { code: "CONFIG_ERROR", message } }`. Exit code 2. Message names the reserved id and points at `init --sample-phase`.
- **All existing JSON envelopes are unchanged** (`task complete`, `task finalize`, `phase reconcile`, `task runbook`, `phase runbook`, `task add`, `init`, `phase import`, `plan prompt`, etc.).
- **The 8 task→phase resolver migration is invisible to users.** Same error codes, same envelope shapes, same exit codes.

Exit codes unchanged (0 success, 2 for argument/configuration errors including LOCK_HELD).

## Error / diagnostic taxonomy

One new public error code:

| Code | Exit | Category | Trigger |
| --- | --- | --- | --- |
| `LOCK_HELD` | 2 | **public** (new) | Another code-pact mutation is in progress on the same project. `data.lock_holder` carries the diagnostic struct. Retryable — wait for the holder to release |

Reused codes:

| Code | Trigger in P14 |
| --- | --- |
| `CONFIG_ERROR` | `phase add --id TUTORIAL` / `phase import` containing TUTORIAL entry; `task add` partial-flags (existing P13); missing required flags |
| `TASK_NOT_FOUND` | Task→phase resolver (8 sites, unchanged) |
| `AMBIGUOUS_TASK_ID` | Task→phase resolver (8 sites, unchanged) |
| `PHASE_NOT_FOUND` | (unchanged) |
| `DUPLICATE_PHASE_ID` | (unchanged) |
| `TASK_WRITES_PROTECTED_PATH` | (unchanged; documented as exit-relevant under `--strict`) |

`KNOWN_CODES.public` in `tests/unit/error-code-surface.test.ts` gains exactly **one entry** (`LOCK_HELD`).

## Backward compatibility

- `task complete` / `task finalize` / `phase reconcile` / `task context` / `task start` / `task block` / `task resume` / `task status` / `plan analyze` / `plan lint` / `validate` / `doctor` / `recommend` / `task add` / `init` / `phase import` / `phase add` / `phase new` / `plan prompt` / `task runbook` / `phase runbook` — **success-path behaviour unchanged**. Same flags, JSON envelope, exit codes.
- **New failure modes:**
  - Design-mutating commands may now return `LOCK_HELD` (exit 2) under concurrent invocation. Single-process users see no change.
  - `phase add --id TUTORIAL` / `phase import` of TUTORIAL → `CONFIG_ERROR` (exit 2). Existing projects with TUTORIAL phases are untouched (no validate / lint warning).
- **`progress.yaml`** remains read-only for the new lock. The append-only operational-log contract is preserved unchanged.
- **`task context` pack output** is unchanged. The byte-identical pack regression test against the golden fixture passes without modification.
- **`tests/integration/json-stdout.test.ts`** continues to pass for every Stable command; new entries added for the LOCK_HELD envelope and the TUTORIAL reserved-id CONFIG_ERROR path.
- **`KNOWN_CODES.public`** gains exactly one new entry (`LOCK_HELD`). No existing code is renamed, recategorized, or has its severity changed.
- **No new task or phase schema field.** v1.4.x phase YAMLs parse and behave identically.
- **The task→phase resolver refactor is invisible.** Existing per-command unit tests pass unchanged.

In semver terms, v1.5.0 is a **minor** release.

## Migration story

Target: existing projects upgrading from v1.4.x to v1.5.0.

- **No required action.** Existing single-user, single-process workflows see no change.
- **CI under `plan lint --strict`.** No new errors / warnings — `LOCK_HELD` only appears under concurrent mutations, which CI typically does not run.
- **Multi-agent or multi-process automation.** Concurrent design-mutation invocations now serialize via the lock. Tooling consuming JSON envelopes should add `LOCK_HELD` to its retry-on-transient list (alongside whatever exists today). Recovery is automatic on retry.
- **`phase add --id TUTORIAL` / `phase import` containing TUTORIAL.** Now returns `CONFIG_ERROR` (exit 2). Users who genuinely want a phase with id `TUTORIAL` need to pick a different id; the recommended sanctioned path is `init --sample-phase`. Existing TUTORIAL phases are untouched.
- **`plan lint --strict` in release prep.** The recommended posture documented in docs/dogfood.md: **do not pass `--strict`** in release prep against this project's dogfood corpus. The default `plan lint --json` treats `TASK_WRITES_PROTECTED_PATH` as warnings, which is the right posture for governance tasks declaring writes against design YAML files.
- **Docs.** docs/migration.md gains a `v1.4.x → v1.5.0` section. docs/concepts/governance.md is the conceptual walkthrough.

## Alternatives considered

- **Implement actual write enforcement against declared `writes` in P14.** Rejected. Requires either a runner (significant new architecture) or a VCS dependency (`git diff`-based comparison) — both are major scope expansions. P14 documents declared writes as review surface and defers enforcement to P15+. The cost of "no enforcement" is that a task could declare `writes` it doesn't actually touch; the existing P12 runbook + P11 finalize already surface this declaration for human review.
- **Promote `TASK_WRITES_PROTECTED_PATH` selectively to error (independent of `--strict`).** Rejected for v1.5.0. Would require new lint logic — currently `--strict` is binary (all warnings → exit-relevant). Selective promotion is a bigger contract change than P14 wants to take. Users who want strict protected-path checking already get it via `--strict` (along with all other warnings).
- **Implement phase status auto-flip in P14.** Rejected per user decision. Manual flip is the v1.2.0+ convention; adding a `--phase-status` flag or `phase finalize` command in P14 would either expand scope significantly or commit to a design decision (which command/flag, with what semantics) without enough usage signal. Future RFC owns the design and implementation.
- **Lock progress.yaml writes too.** Rejected. The append-only contract documented in docs/cli-contract.md (worst case is event reordering, not corruption) makes lock-free safe for progress writes. Locking progress.yaml would add lock-acquisition overhead to high-frequency commands (`task start` / `task block` / `task resume` / `task complete`) for no integrity benefit. _[Update — collaboration-safe-state RFC: the "worst case is reordering" premise was wrong (the monolithic writer can lose a concurrent event). Rejecting a lock was still right, but because the correct fix is per-event files, not because lock-free was already safe — see that RFC.]_
- **Acquire the lock inside `createPhase` rather than at the CLI handler level.** Rejected. Per-`createPhase` acquisition would mean `phase import` releases and re-acquires the lock between each imported phase, allowing concurrent mutations to interleave between phases of a single import. Command-level acquisition gives multi-phase batch transactionality (the entire import runs under one lock), and keeps `createPhase` as a simple write helper with no concurrency concerns.
- **Use POSIX `flock` for the lock.** Rejected. Not cross-platform safe — Windows has different semantics, and `node:fs` doesn't expose POSIX advisory locks portably. The `writeFile { flag: "wx" }` approach is atomic across all Node.js platforms.
- **Auto-detect stale locks via PID liveness in P14.** Rejected. Race conditions are subtle: two processes both checking liveness can both decide the other is stale and clobber a real lock. Manual recovery is conservative and clear. Stale detection + `--force-lock` is P15+.
- **Use a dedicated lock-file library (proper-lockfile, etc.).** Rejected. Adds a runtime dependency, conflicting with the project's runtime-dependency policy (only `yaml` and `zod`). The simple `writeFile { flag: "wx" }` mechanism is enough for P14's needs.
- **Add a new `RESERVED_ID` error code.** Rejected. The brief recommended reusing `CONFIG_ERROR`; the user confirmed. `RESERVED_ID` would add API surface for a niche failure mode that's structurally a configuration error (user passed an invalid id).
- **Lock the entire `.code-pact/` directory (multiple lock files, per-resource).** Rejected for P14. Single `write.lock` is simpler and covers the actual races (concurrent design mutations). Per-resource locks (one per phase, etc.) are P15+ if needed.
- **Make `LOCK_HELD` retryable automatically (busy-loop in the CLI).** Rejected. Different invocations have different patience budgets; the CLI should fail fast and let the caller (human or agent) decide whether to retry. Auto-retry is a tooling concern, not a CLI concern.
- **Land the task→phase resolver as part of a future P15 refactor instead of P14.** Rejected. P12 RFC explicitly deferred to P14; deferring again would push the duplication into more commands (any new task-* command added meanwhile would copy site #9, #10). P14 is the right home.

## Open questions

1. **`task add` wizard prompt vs lock acquisition window.** Acquiring the lock at the CLI command handler level means a TTY user running `task add` interactively holds the lock through wizard prompts (which can take seconds). Two options: (a) acquire at command start (current design — covers both prompts + write), or (b) acquire only just before `atomicWriteText(phasePath, ...)` inside `runTaskAdd` (narrower window, but lock model becomes inconsistent across commands). P14 chooses **(a)** for consistency. Revisit if usage signal suggests prompt-hold is too long.
2. **Lock release on uncaught exception or `kill -9`.** Try/finally guarantees release on caught exceptions but not on SIGKILL. The lock file persists as a stale lock until the user manually removes it. P15+ candidate for liveness-based automation (and the eventual `--force-lock` flag).
3. **Lock path resolution under symlinked `.code-pact/`.** P14 uses `join(cwd, ".code-pact", "locks", "write.lock")` directly. If a user symlinks `.code-pact/` to another location, the lock follows the symlink. No special handling. Acceptable for P14.
4. **`writeSamplePhase` invocations beyond `init`.** Currently only `runInitCore` calls `writeSamplePhase`. If a future command needs to recreate the tutorial artifact (`init --regenerate-sample` etc.), it must also pass the `_isSampleCreation: true` bypass. P14 doesn't add such a command; documented for future implementers.
5. **`phase import` partial-failure modes other than TUTORIAL.** The TUTORIAL block is caught by **preflight** (zero writes on failure). Other failure modes (schema errors on phase #5 of an 8-phase import, mid-loop DUPLICATE_PHASE_ID etc.) remain **non-transactional** in P14 — earlier phases are already written on disk when the loop aborts. The command-level lock prevents concurrent mutations from interleaving but does NOT roll back partial writes. Full transactional rollback would require either staging to a temp directory then atomically moving, or VCS integration. P15+ candidate; documented as a known limitation in `docs/cli-contract.md`.
6. **Test escape `CODE_PACT_DISABLE_LOCKS=1` lifecycle.** vitest setup sets the env var globally (so unrelated tests don't deadlock). Lock-specific tests delete the env var in `beforeEach`. The env var is intentionally undocumented in public surfaces. Question: should future releases harden this further (e.g. require a `--unsafe-disable-locks` CLI flag in addition to the env var)? Defer to P15+ if security signal warrants.
7. **Stale lock from a different hostname.** If `.code-pact/locks/write.lock` was created on host A and host B (different machine, shared NFS) sees it, the holder's PID is meaningless to host B. P14's `lock_holder.hostname` field surfaces this for diagnostic clarity, but P14 does not auto-detect cross-host staleness. P15+ candidate (probably will never matter for the local-CLI use case).
8. **`--force-lock` flag.** Brief notes "dangerous; P15+ candidate". Confirmed deferred. Users must manually delete the lock file for v1.5.0.

## Implementation slicing

This RFC, once accepted, is followed by **eight** implementation PRs (1:1 with phase tasks). PR1 is the RFC PR (this one); a small follow-up `chore/p14-rfc-accepted` PR flips Status proposed→accepted per the established P11/P12/P13 precedent.

| PR | Task | Scope | Code | Docs |
| --- | --- | --- | --- | --- |
| **PR1 (this RFC PR)** | P14-T1 | RFC + phase YAML + roadmap entry | — | — |
| **PR2** | P14-T2 | Protected-path strict-mode docs | — | docs/cli-contract.md + docs/dogfood.md |
| **PR3** | P14-T3 | Declared writes review-surface docs | — | docs/concepts/finalization-reconciliation.md + docs/concepts/runbook.md |
| **PR4** | P14-T4 | Roadmap mutation policy docs + phase status manual-flip docs + reserved-id (TUTORIAL) creation-time block | createPhase validation + bypass flag, writeSamplePhase update, runPhaseImport preflight | docs/cli-contract.md + docs/migration.md + docs/concepts/finalization-reconciliation.md |
| **PR5** | P14-T5 | Advisory lock implementation | src/core/locks/write-lock.ts + KNOWN_CODES.public + 7 CLI integration points + tests | docs/cli-contract.md |
| **PR6** | P14-T6 | Task→phase resolver core extraction | src/core/plan/resolve-task.ts + 8-site migration + new helper unit tests; existing tests unchanged | — |
| **PR7** | P14-T7 | Docs / migration / dogfood / governance concept doc | — | docs/migration.md + docs/getting-started.md + docs/dogfood.md + docs/concepts/sample-phase.md + new docs/concepts/governance.md |
| **PR8** | P14-T8 | v1.5.0 release prep + governance dogfood validation | package.json + CHANGELOG + P14 phase YAML status flip via reconcile + manual phase status + dogfood log | — |

## References

- [design/decisions/task-readiness-schema-rfc.md](task-readiness-schema-rfc.md) — P10. Provides `writes` + `TASK_WRITES_PROTECTED_PATH`. P14 documents the strict-mode posture without code change.
- [design/decisions/finalization-reconciliation-rfc.md](finalization-reconciliation-rfc.md) — P11. Provides `task finalize` / `phase reconcile`. P14 adds lock acquisition at their CLI handler entry points.
- [design/decisions/lightweight-runbook-rfc.md](lightweight-runbook-rfc.md) — P12. Defers task→phase resolver extraction to P14; P14 closes that out.
- [design/decisions/planning-ux-init-hardening-rfc.md](planning-ux-init-hardening-rfc.md) — P13. Introduces TUTORIAL sample-phase artifact; P14 hardens via creation-time block.
- [design/decisions/stability-taxonomy.md](stability-taxonomy.md) — Stability bands. `LOCK_HELD` ships as part of the public surface.
- [src/core/services/createPhase.ts](../../src/core/services/createPhase.ts) — Single chokepoint for roadmap.yaml writes + new reserved-id block.
- [src/io/atomic-text.ts](../../src/io/atomic-text.ts) — Existing atomic-text contract; P14's lock is layered on top.
- [src/core/glob.ts](../../src/core/glob.ts) — `PROTECTED_PATHS` export; unchanged in P14.
- [src/core/plan/state.ts](../../src/core/plan/state.ts) — `loadPlanState` + `PlanState.taskIndex`; resolver helper is adjacent.
- [tests/unit/error-code-surface.test.ts](../../tests/unit/error-code-surface.test.ts) — `KNOWN_CODES.public` (P14 adds `LOCK_HELD`).
- [tests/integration/json-stdout.test.ts](../../tests/integration/json-stdout.test.ts) — Stable JSON-only-stdout regression net (extended by P14-T4 / T5).
- [docs/cli-contract.md](../../docs/cli-contract.md) — Destination for governance documentation.
- [docs/migration.md](../../docs/migration.md) — Destination for v1.4.x → v1.5.0 section.
