// Vitest setup file (P14 governance test escape).
//
// Disables the P14 advisory write lock by default for every test so
// unrelated tests don't acquire a real lock and don't deadlock against
// each other when they reuse a project tree (the integration helpers
// run multiple CLI invocations against the same temp dir back-to-back).
//
// Lock-specific tests — `tests/unit/core/locks/write-lock.test.ts` and
// the LOCK_HELD entries in `tests/integration/json-stdout.test.ts` —
// MUST exercise the real acquisition path. Those tests `delete
// process.env.CODE_PACT_DISABLE_LOCKS` in their own `beforeEach` (and
// pass `env: { CODE_PACT_DISABLE_LOCKS: "" }` to subprocess CLI
// invocations) so the helper's `=== "1"` short-circuit no longer fires.
//
// The escape is INTERNAL — it is not documented in docs/cli-contract.md
// or any public-facing surface. See design/decisions/governance-rfc.md
// § Advisory lock model → Test escape for the contract.

process.env.CODE_PACT_DISABLE_LOCKS = "1";

process.env.CODE_PACT_STATE_HOME ??=
  `${process.env.TMPDIR ?? "/tmp"}/code-pact-vitest-state-${process.pid}`;
