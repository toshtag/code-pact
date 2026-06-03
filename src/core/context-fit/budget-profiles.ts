// P47 (Context Fit, layer a). The single source of truth for the standard
// context budget profile names and their built-in fallback byte values.
//
// These values mirror the accepted RFC (design/decisions/context-fit-rfc.md
// § "Standard profile vocabulary and fallback bytes"): they bracket the
// committed P26 dogfood baseline (docs/maintainers/measurements/summary.json),
// so each is a real percentile boundary rather than a round guess —
//   tight    30000  (above pack_size_p50_bytes)
//   balanced 60000  (above pack_size_p90_bytes)
//   wide     120000 (generous margin below the pack_size_max outlier)
//
// `wide` is intentionally NOT `full`: it is a generous byte-capped profile,
// not a promise that every pack fits without elision (a large pack can still
// elide or hit CONTEXT_OVER_BUDGET at `wide`). `full` / `max` / `large` were
// rejected in P46 precisely because they read as a no-elision guarantee.
//
// Do NOT create a second RUNTIME source of truth in CLI code or schemas —
// import this constant; it is the one place the values are computed from.
// Docs and tests MAY repeat the values as public contract assertions (a doc
// stating the byte cap, a test pinning the expected number), which is the
// intended way to lock the contract, not a duplicate source of truth.

/** The three standard context budget profiles and their fallback byte caps. */
export const STANDARD_CONTEXT_BUDGET_PROFILES = {
  tight: 30000,
  balanced: 60000,
  wide: 120000,
} as const;

/** A standard profile name: `"tight" | "balanced" | "wide"`. */
export type StandardContextBudgetProfile =
  keyof typeof STANDARD_CONTEXT_BUDGET_PROFILES;

/** The standard profile names as an array, for help text and error messages. */
export const STANDARD_CONTEXT_BUDGET_PROFILE_NAMES: readonly StandardContextBudgetProfile[] =
  Object.keys(STANDARD_CONTEXT_BUDGET_PROFILES) as StandardContextBudgetProfile[];

/** Narrows an arbitrary string to one of the three standard profile names. */
export function isStandardContextBudgetProfile(
  name: string,
): name is StandardContextBudgetProfile {
  return Object.prototype.hasOwnProperty.call(
    STANDARD_CONTEXT_BUDGET_PROFILES,
    name,
  );
}
