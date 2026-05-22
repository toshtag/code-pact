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
