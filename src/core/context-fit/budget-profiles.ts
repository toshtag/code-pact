// The single source of truth for the standard context budget profile
// names and their built-in fallback byte values.
//
// These values bracket the committed dogfood baseline
// (docs/maintainers/measurements/summary.json), so each is a real
// percentile boundary rather than a round guess —
//   tight    30000  (above pack_size_p50_bytes)
//   balanced 60000  (above pack_size_p90_bytes)
//   wide     120000 (generous margin below the pack_size_max outlier)
//
// `wide` is intentionally NOT `full`: it is a generous byte-capped profile,
// not a promise that every pack fits without elision (a large pack can still
// elide or hit CONTEXT_OVER_BUDGET at `wide`). `full` / `max` / `large` were
// rejected precisely because they read as a no-elision guarantee.
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

/**
 * The standard profile names as a literal tuple, for help text, error messages,
 * and — importantly — as the single source the recommend-result schema derives
 * its `recommendedProfile` enum from (so the schema enum and the pure mapping
 * helper that emits these names cannot silently diverge). Kept as a `[...] as
 * const` tuple (not `Object.keys`, which would widen to `string[]` and drop the
 * literal types `z.enum` needs).
 */
export const STANDARD_CONTEXT_BUDGET_PROFILE_NAMES = [
  "tight",
  "balanced",
  "wide",
] as const satisfies readonly StandardContextBudgetProfile[];

// Exhaustiveness guard (compile-time only, zero runtime cost). `satisfies` above
// already rejects a tuple entry that is not a profile name; this rejects the
// other direction — a profile added to STANDARD_CONTEXT_BUDGET_PROFILES but not
// to the tuple. Together they pin the tuple to be EXACTLY the object's keys, so
// the schema enum derived from it can never silently under- or over-populate.
type _AssertProfileNamesExhaustive = StandardContextBudgetProfile extends
  (typeof STANDARD_CONTEXT_BUDGET_PROFILE_NAMES)[number]
  ? true
  : ["missing profile name in STANDARD_CONTEXT_BUDGET_PROFILE_NAMES"];
const _profileNamesExhaustive: _AssertProfileNamesExhaustive = true;
void _profileNamesExhaustive;

/** Narrows an arbitrary string to one of the three standard profile names. */
export function isStandardContextBudgetProfile(
  name: string,
): name is StandardContextBudgetProfile {
  return Object.prototype.hasOwnProperty.call(
    STANDARD_CONTEXT_BUDGET_PROFILES,
    name,
  );
}
