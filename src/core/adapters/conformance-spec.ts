// Single source of truth for the agent contract surface that
// adapter conformance checks (`adapter conformance` command) and the
// contract drift check in `adapter doctor` both consume.
//
// The constants below are imported by:
//
//   - `src/commands/adapter-doctor.ts` — its `detectContractDrift`
//     helper anchors on `AGENT_CONTRACT_SECTION_HEADING` and
//     `AGENT_CONTRACT_AXIS_HEADINGS`.
//   - `src/commands/adapter-conformance.ts` — the read-only
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
// Adapter contract hardening
//
// These constants back the checks that enforce the `task prepare`
// primary contract in adapter guidance. See
// design/decisions/adapter-contract-hardening-rfc.md.
// ---------------------------------------------------------------------------

/**
 * Release that first ships the hardened templates (the ones that
 * satisfy these checks). The checks run at `required` severity for
 * adapters whose manifest `generator_version` is semver >= this, and
 * `advisory` below — so installs that predate the hardened templates
 * warn rather than hard-fail.
 *
 * Adapters generated at or after 1.14.0 carry the hardened templates and
 * are held to the `required` tier. The released 1.13.x line (whose
 * templates still lead with `recommend`) stays `advisory` until
 * re-upgraded — which is why the threshold is strictly greater than 1.13.3.
 */
export const ADAPTER_CONTRACT_HARDENING_FROM_VERSION = "1.14.0";

/**
 * The surface that must be presented as the PRIMARY per-task entrypoint.
 */
export const PRIMARY_ENTRYPOINT_SURFACE = "code-pact task prepare";

/**
 * Surfaces that `task prepare` must appear ahead of — they are
 * diagnostics, not the primary loop. If any of these is introduced
 * before `task prepare`, the guidance is teaching the superseded loop.
 */
export const PRIMARY_PRECEDES_SURFACES: ReadonlyArray<string> = [
  "code-pact recommend",
  "code-pact task context",
];

/**
 * Anti-patterns that must NOT appear in generated instructions or their
 * examples. Each `pattern` is matched against the instruction body.
 * `task finalize ... --agent` is the exact bug class (finalize takes
 * no `--agent`); this is the conformance-layer analogue of the parser
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

// ---------------------------------------------------------------------------
// Recommendation consumption guidance
//
// The agent contract must tell agents to CONSUME the recommendation
// (data.recommendation → tier/effort/planning/lifecycleMode), to report a
// limitation when the runtime cannot switch model, and to use the lightweight
// `record_only` lane via `task record-done`. These checks verify the guidance
// is PRESENT in the generated instruction — not that an agent obeys it.
//
// They are gated on their OWN release threshold (NOT
// ADAPTER_CONTRACT_HARDENING_FROM_VERSION): reusing the 1.14.0 threshold would
// make every 1.14–1.25 adapter non-compliant at once. Below the new threshold
// the checks are advisory.
// ---------------------------------------------------------------------------

/**
 * Release that first ships the consumption-guidance templates. These
 * checks run at `required` for adapters whose manifest `generator_version` is
 * semver >= this, and `advisory` below. PLACEHOLDER — confirm at release prep
 * that this equals the version the guidance actually ships in.
 */
export const RECOMMENDATION_CONSUMPTION_FROM_VERSION = "1.26.0";

/**
 * Each entry is one conformance check: every `anchor` must be substring-matched
 * in the instruction body for the check to pass. Anchors are short, stable
 * tokens (code literals + an English-locked phrase) so localized wording
 * changes do not break them.
 */
export const RECOMMENDATION_CONSUMPTION_ANCHORS: ReadonlyArray<{
  id: string;
  anchors: ReadonlyArray<string>;
}> = [
  {
    id: "recommendation_consumption_guidance_present",
    anchors: ["data.recommendation"],
  },
  {
    id: "lifecycle_mode_guidance_present",
    anchors: ["lifecycleMode", "record_only"],
  },
  {
    id: "cannot_switch_model_fallback_present",
    anchors: ["cannot switch model"],
  },
];

// ---------------------------------------------------------------------------
// Bounded repair guidance
//
// P51 adds a repair policy to the recommendation contract. These checks are
// intentionally gated on their own release threshold: adapters generated after
// the recommendation-consumption guidance but before bounded-repair guidance
// must warn rather than become non-compliant all at once.
// ---------------------------------------------------------------------------

/**
 * Release that first ships the bounded-repair guidance templates. These checks
 * run at `required` for adapters whose manifest `generator_version` is semver
 * >= this, and `advisory` below.
 */
export const BOUNDED_REPAIR_GUIDANCE_FROM_VERSION = "2.2.0";

export const BOUNDED_REPAIR_GUIDANCE_ANCHORS: ReadonlyArray<{
  id: string;
  anchors: ReadonlyArray<string>;
}> = [
  {
    id: "repair_policy_guidance_present",
    anchors: [
      "repairPolicy",
      "maxRepairAttempts",
      "command_failed",
    ],
  },
  {
    id: "repair_policy_json_paths_present",
    anchors: [
      "data.recommendation.repairPolicy",
      "data.repairPolicy",
      "data.recommendation.allowedEscalation",
      "data.allowedEscalation",
    ],
  },
  {
    id: "bounded_repair_runtime_constraints_present",
    anchors: [
      "same_model_same_effort_same_context",
      "failure_delta",
    ],
  },
  {
    id: "bounded_repair_stop_guidance_present",
    anchors: [
      "stopOnRepeatedFingerprint",
      "use_allowed_escalation",
    ],
  },
  {
    id: "bounded_repair_nonretryable_guidance_present",
    anchors: [
      "timed_out",
      "aborted",
      "decision_required",
      "unsafe_write",
      "invalid_state",
      "unknown",
    ],
  },
];

// ---------------------------------------------------------------------------
// Structural projection guidance
//
// P54 adds deterministic structural projections to budgeted context packs.
// These anchors verify that generated instructions tell agents to consume the
// projected form first and retrieve exact originals only for concrete missing
// details. The threshold is independent from bounded repair guidance so older
// 2.2-2.4 adapters do not become non-compliant merely because a newer Code Pact
// knows about projection guidance.
// ---------------------------------------------------------------------------

/**
 * Release that first ships projection-consumption guidance templates. These
 * checks run at `required` for adapters whose manifest `generator_version` is
 * semver >= this, and `advisory` below.
 */
export const STRUCTURAL_PROJECTION_GUIDANCE_FROM_VERSION = "2.5.0";

export const STRUCTURAL_PROJECTION_GUIDANCE_COMMON_ANCHORS: ReadonlyArray<string> = [
  "data.deferred_context.retrieve_command",
];

export const STRUCTURAL_PROJECTION_GUIDANCE_VARIANTS: ReadonlyArray<{
  id: string;
  anchors: ReadonlyArray<string>;
}> = [
  {
    id: "en-US",
    anchors: [
      "deterministic structural projections",
      "projected form first",
      "specific missing detail",
      "do not construct a retrieval command from the manifest reference",
    ],
  },
  {
    id: "ja-JP",
    anchors: [
      "決定論的な構造 projection",
      "まず projected form を使用",
      "具体的な不足",
      "manifest reference から取得 command を組み立てない",
    ],
  },
];

export const STRUCTURAL_PROJECTION_GUIDANCE_ANCHORS: ReadonlyArray<{
  id: string;
  commonAnchors: ReadonlyArray<string>;
  variants: ReadonlyArray<{
    id: string;
    anchors: ReadonlyArray<string>;
  }>;
}> = [
  {
    id: "structural_projection_guidance_present",
    commonAnchors: STRUCTURAL_PROJECTION_GUIDANCE_COMMON_ANCHORS,
    variants: STRUCTURAL_PROJECTION_GUIDANCE_VARIANTS,
  },
];
