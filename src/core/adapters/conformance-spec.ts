// Single source of truth for the v1.11+ agent contract surface that
// adapter conformance checks (`adapter conformance` command, P21-T5)
// and the v1.7 contract drift check in `adapter doctor` both consume.
//
// The constants below are imported by:
//
//   - `src/commands/adapter-doctor.ts` — its `detectContractDrift`
//     helper anchors on `AGENT_CONTRACT_SECTION_HEADING` and
//     `AGENT_CONTRACT_AXIS_HEADINGS`.
//   - `src/commands/adapter-conformance.ts` — the new P21-T5 read-only
//     conformance command consumes every list here.
//   - `src/core/adapters/{claude,codex,generic}.ts` — adapter
//     templates do not import the constants directly (templates carry
//     localised body text), but they MUST keep the literal surfaces
//     mentioned somewhere in the generated instruction so a fresh
//     `adapter install` passes conformance by construction.
//
// New variants require an RFC. Adding a surface here without updating
// the adapter templates causes existing installs to fail conformance
// until the templates are refreshed — that is the intended pressure.

/**
 * Verbatim heading anchoring the agent contract section. English-locked
 * per `design/decisions/agent-contract-rfc.md` so substring matching is
 * locale-independent.
 */
export const AGENT_CONTRACT_SECTION_HEADING = "## Agent contract";

/**
 * The three axis sub-headings that compose the agent contract. All
 * three must be present in the instruction file for conformance to
 * pass.
 */
export const AGENT_CONTRACT_AXIS_HEADINGS: ReadonlyArray<string> = [
  "### When to invoke code-pact",
  "### What to verify first",
  "### How to handle failures",
];

/**
 * CLI surfaces the agent MUST be told about as part of the per-task
 * lifecycle. Every entry must be substring-matched in the instruction
 * file for conformance to pass; a single missing entry fails the
 * `required_cli_surface_mentions` check.
 *
 * v1.11+ P21 elevates `task prepare` to the primary per-task entry
 * point — adapters that pre-date this surface will report missing
 * `task prepare` and need to be re-installed.
 */
export const LIFECYCLE_REQUIRED_SURFACES: ReadonlyArray<string> = [
  "code-pact task prepare",
  "code-pact task start",
  "code-pact task complete",
  "code-pact task finalize",
];

/**
 * CLI surfaces the agent MUST also know about as supporting / fallback
 * commands. Same substring match rule as `LIFECYCLE_REQUIRED_SURFACES`;
 * any missing entry fails conformance.
 */
export const DIAGNOSTIC_REQUIRED_SURFACES: ReadonlyArray<string> = [
  "code-pact task context",
  "code-pact verify",
  "code-pact validate",
];

/**
 * Failure modes the agent MUST be told how to handle. Each entry is a
 * substring matched against the instruction file body; presence is the
 * check, not exact heading shape — adapters are free to phrase the
 * guidance under any heading they like, provided the keyword appears.
 */
export const REQUIRED_FAILURE_GUIDANCE: ReadonlyArray<string> = [
  "blocked dependency",
  "verification failure",
  "adapter drift",
  "missing context pack",
];

// ---------------------------------------------------------------------------
// P30 — Adapter contract hardening
//
// These constants back the v1.x P30 checks that enforce the post-P29
// `task prepare` primary contract in adapter guidance. See
// design/decisions/adapter-contract-hardening-rfc.md.
// ---------------------------------------------------------------------------

/**
 * Release that first ships the P29-aligned templates (the ones that
 * satisfy the P30 checks). The P30 checks run at `required` severity for
 * adapters whose manifest `generator_version` is semver >= this, and
 * `advisory` below — so installs that predate the hardened templates
 * warn rather than hard-fail.
 *
 * Confirmed at the 1.14.0 release prep: P30 ships in 1.14.0, so adapters
 * generated at or after 1.14.0 carry the hardened templates and are held
 * to the `required` tier. The released 1.13.x line (whose templates still
 * lead with `recommend`) stays `advisory` until re-upgraded — which is
 * why the threshold is strictly greater than 1.13.3.
 */
export const ADAPTER_CONTRACT_HARDENING_FROM_VERSION = "1.14.0";

/**
 * The surface that must be presented as the PRIMARY per-task entrypoint.
 */
export const PRIMARY_ENTRYPOINT_SURFACE = "code-pact task prepare";

/**
 * Surfaces that `task prepare` must appear ahead of — they are
 * diagnostics, not the primary loop. If any of these is introduced
 * before `task prepare`, the guidance is teaching the pre-P29 loop.
 */
export const PRIMARY_PRECEDES_SURFACES: ReadonlyArray<string> = [
  "code-pact recommend",
  "code-pact task context",
];

/**
 * Anti-patterns that must NOT appear in generated instructions or their
 * examples. Each `pattern` is matched against the instruction body.
 * `task finalize ... --agent` is the exact P29 bug class (finalize takes
 * no `--agent`); this is the conformance-layer analogue of P29's parser
 * roundtrip test.
 */
export const CONTRACT_ANTIPATTERNS: ReadonlyArray<{
  id: string;
  pattern: RegExp;
  note: string;
}> = [
  {
    id: "finalize_agent_flag",
    pattern: /task finalize[^\n]*--agent/,
    note: "`task finalize` takes no `--agent`; emits CONFIG_ERROR (P29).",
  },
];

/**
 * Activation rules that must be DOCUMENTED in the guidance, detected by
 * locale-independent anchor tokens (the prose is localised; the CLI /
 * error tokens are not). PRESENCE is the contract — this verifies the
 * rule is documented, NOT that an agent obeys it at runtime.
 */
export const ACTIVATION_RULE_ANCHORS: ReadonlyArray<{
  id: string;
  anchor: string;
}> = [
  { id: "finalize_after_complete", anchor: "task finalize --write" },
  { id: "wait_for_dependencies", anchor: "wait_for_dependencies" },
  { id: "context_over_budget", anchor: "CONTEXT_OVER_BUDGET" },
];
