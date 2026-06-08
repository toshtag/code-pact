# RFC: Governance

**Status:** accepted (P14, 2026-05)
**Scope:** advisory write lock (`.code-pact/locks/write.lock`) + public error code `LOCK_HELD`; creation-time block of the reserved `TUTORIAL` phase id; task→phase resolver extraction; docs-only governance for protected-path strict-mode, the declared-writes review surface, roadmap mutation policy, and phase-status manual-flip.
**Owners:** maintainer
**Related:** [task-readiness-schema](task-readiness-schema-rfc.md) (P10 — `writes` + `TASK_WRITES_PROTECTED_PATH`) · [finalization-reconciliation](finalization-reconciliation-rfc.md) (P11 — the `finalize`/`reconcile` handlers that gain lock acquisition) · [lightweight-runbook](lightweight-runbook-rfc.md) (P12 — deferred the resolver extraction here) · [planning-ux-init-hardening](planning-ux-init-hardening-rfc.md) (P13 — introduced `TUTORIAL`).

## Summary

A deterministic answer to *who can write what, and when*: an **advisory write lock** (surfaced as `LOCK_HELD`) that serializes design-YAML mutations, a **creation-time reservation of the `TUTORIAL` phase id**, and a single **task→phase resolver** module — plus docs-only governance for protected paths, the declared-writes review surface, roadmap mutation, and the phase-status manual-flip convention. User-facing walkthrough: [docs/concepts/governance.md](../../docs/concepts/governance.md).

## Governance model

Three load-bearing rules:

1. **Design-YAML mutations are serialized by an advisory write lock** acquired at the CLI command-handler level (`init --sample-phase`, `phase add`/`new`/`import`, `task add`, `task finalize --write`, `phase reconcile --write`). Read-only commands never acquire it. `phase import` holds one lock across its whole apply loop (batch transactionality).
2. **`TUTORIAL` is reserved, enforced at creation time.** Only `init --sample-phase` may create it (an internal bypass on the `createPhase` chokepoint); `phase add --id TUTORIAL` and a `TUTORIAL` entry in `phase import` raise `CONFIG_ERROR`.
3. **`design/roadmap.yaml` writes route through `createPhase`** (already structurally true; documented so a future writer doesn't break the invariant).

Everything else here is documentation plus a pure refactor.

## Advisory lock model

- **Location / format:** a single file `.code-pact/locks/write.lock`, JSON `{ pid, hostname, cmd, created_at }`. Per-run runtime state — a consumer that tracks `.code-pact/` config should ignore `locks/`.
- **Mechanism:** `writeFile(..., { flag: "wx" })` — atomic exclusive create, cross-platform. `EEXIST` → throw `LOCK_HELD` carrying `lock_holder` + `lock_path`. No POSIX `flock`, no lock-file dependency (runtime deps stay `yaml` + `zod`).
- **Acquired at the CLI handler, not inside `createPhase`** — so `phase import` runs its whole batch under one lock while `createPhase` stays concurrency-agnostic. try/finally releases on failure; the lock is held (harmlessly) even when a preflight rejects before any write.
- **Stale recovery is manual in P14:** confirm no command is running, delete the file, retry. PID-liveness / age detection / a `--force-lock` flag are P15+ — auto-detection races two processes into both clobbering a live lock.
- **Test escape:** `CODE_PACT_DISABLE_LOCKS=1`, set globally in the vitest setup so unrelated tests don't deadlock; lock-specific tests delete it to exercise real acquisition. Undocumented in public surfaces, with no compatibility guarantee.

## Reserved id policy

`TUTORIAL` — and only that id — is reserved. The block lives in `createPhase`, gated by an internal `_isSampleCreation` flag that only `writeSamplePhase` sets. `phase import` additionally **preflights** for `TUTORIAL` before the first write, so the roadmap stays byte-identical on rejection (matching the existing `DUPLICATE_PHASE_ID` preflight). Reuses `CONFIG_ERROR` — no new code. Existing `TUTORIAL` phases are never retroactively flagged.

## Protected path policy

`PROTECTED_PATHS` (`.git/**`, `node_modules/**`, `.code-pact/**`, `design/roadmap.yaml`, `design/phases/*.yaml`) stays hardcoded. `plan lint` emits `TASK_WRITES_PROTECTED_PATH` as a warning; `--strict` promotes it via the existing binary rule. **Release-prep guidance:** do not run `plan lint --strict` against the dogfood corpus — governance tasks here legitimately declare writes against design YAML. A configurable seed is P15+.

## Declared writes enforcement model

Declared `writes` is a **review surface, not enforcement**: `task finalize --json` / `task runbook --json` surface it so a reviewer (human or agent) can compare declared intent to the actual change. Real enforcement — a write-observing runner or a `git diff` comparison — is P15+.

## Roadmap mutation policy

The four `createPhase` callers (`init` sample-phase, `phase add`, `phase new`, `phase import`) are the **only** code paths that write `design/roadmap.yaml`; `task complete`/`finalize`, `phase reconcile`, `task add`, and the `task start`/`block`/`resume`/`status` family do not. Documented in `docs/cli-contract.md`; a future roadmap writer must go through `createPhase`.

## Phase status policy

Phase status is **never auto-flipped**. The convention: `phase reconcile <id> --write` flips task statuses; the phase's own `status` field is then hand-edited (or committed in a release-prep PR). `phase_status_candidate` is advisory only. Auto-flip — a `phase reconcile --phase-status` flag or a new `phase finalize` command — is explicitly deferred to a future RFC.

## Task→phase resolver refactor

The scan duplicated across eight sites is extracted to `src/core/plan/resolve-task.ts` (`resolveTaskInRoadmap`, the I/O variant, and `resolveTaskInPlanState`, the pure variant). A pure refactor — the same `TASK_NOT_FOUND` / `AMBIGUOUS_TASK_ID` at the same boundaries; existing per-command tests pass unchanged.

## CLI contract / error taxonomy

Additive on every existing envelope. One new public code:

| Code | Exit | Trigger |
| --- | --- | --- |
| `LOCK_HELD` | 2 | Another mutation is in progress on the same project. `data.lock_holder` (`{ pid, hostname, cmd, created_at }`, or `null` if unreadable) + `data.lock_path`. Transient — wait and retry. |

`CONFIG_ERROR` is reused for the `TUTORIAL` reservation. `KNOWN_CODES.public` gains exactly one entry (`LOCK_HELD`). v1.5.0 is a **minor** release: every existing success path, envelope, and exit code is unchanged, and `progress.yaml` stays lock-free (its append-only contract is untouched).

## Alternatives considered

- **Enforce declared `writes` in P14** — rejected; it needs a runner or VCS integration. Deferred to P15+, with `finalize`/`runbook` already surfacing the declaration for review.
- **Lock `progress.yaml` writes too** — rejected; lock-free was judged safe. *(Later corrected by [collaboration-safe-state](collaboration-safe-state-rfc.md): the monolithic read-append-rewrite writer can **lose** a concurrent event, not merely reorder it — so the real fix is per-event files, not a lock. Declining the lock still stood.)*
- **Acquire the lock inside `createPhase`** — rejected; it would let a concurrent mutation interleave between phases of one `phase import`. Handler-level acquisition gives batch transactionality and keeps `createPhase` a simple write helper.
- **POSIX `flock` / a lock-file library** — rejected; not cross-platform / adds a runtime dependency. `writeFile { flag: "wx" }` suffices.
- **Auto-detect stale locks / `--force-lock` in P14** — rejected; liveness checks race. Manual recovery is conservative; automation is P15+.
- **A new `RESERVED_ID` code, selective `--strict` promotion, or phase-status auto-flip in P14** — all rejected as needless surface or premature design: reuse `CONFIG_ERROR`, keep `--strict` binary, defer auto-flip to a future RFC.

## Open questions

1. **`task add` holds the lock through its wizard prompts** — handler-level acquisition was chosen for consistency over a narrower window; revisit if prompt-hold proves too long.
2. **Release on `kill -9`** — try/finally cannot cover SIGKILL, so a stale lock needs manual removal. P15+ liveness automation.
3. **`phase import` partial failures other than `TUTORIAL`** stay non-transactional (earlier phases are already written when the loop aborts); the lock prevents interleaving but not partial writes. Full rollback is P15+.
4. **`writeSamplePhase` beyond `init`** — any future tutorial-recreation command must also pass the `_isSampleCreation` bypass.

## References

- RFCs: [task-readiness-schema](task-readiness-schema-rfc.md) (P10) · [finalization-reconciliation](finalization-reconciliation-rfc.md) (P11) · [lightweight-runbook](lightweight-runbook-rfc.md) (P12) · [planning-ux-init-hardening](planning-ux-init-hardening-rfc.md) (P13) · [stability-taxonomy](stability-taxonomy.md) (`LOCK_HELD` joins the public surface).
- Code: [createPhase.ts](../../src/core/services/createPhase.ts) (the chokepoint + reserved-id block) · [glob.ts](../../src/core/glob.ts) (`PROTECTED_PATHS`).
- Docs: [docs/cli-contract.md](../../docs/cli-contract.md) · [docs/migration.md](../../docs/migration.md) · [docs/concepts/governance.md](../../docs/concepts/governance.md).
