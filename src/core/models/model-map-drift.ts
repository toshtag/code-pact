// Single source of truth for the MODEL_MAP_STALE *condition*: a claude-code
// `model_map` entry whose vendor id is a known Claude id that is no longer the
// current catalog default (i.e. the profile was generated before a model bump).
//
// `doctor` (the diagnostic that emits the `MODEL_MAP_STALE` advisory) and
// `adapter upgrade --write` (which surfaces a remaining-advisory hint after a
// write) both call this so they can never disagree about whether drift exists.
// Pure + offline: compares against the bundled catalog only, never the network.
//
// Scope is the caller's responsibility — only run this against the claude-code
// profile, since the catalog describes Claude vendor ids exclusively. A tier
// whose id is unknown to the catalog is a *different* condition
// (`MODEL_ID_UNKNOWN`) and is intentionally NOT reported here.

import { CLAUDE_KNOWN_VENDOR_MODEL_IDS, CLAUDE_TIER_MODEL_IDS } from "./catalog.ts";

export type ModelTierKey = keyof typeof CLAUDE_TIER_MODEL_IDS;

export type ModelMapDrift = {
  tier: ModelTierKey;
  /** The id currently pinned in the profile's model_map. */
  current: string;
  /** The current catalog default for this tier. */
  expected: string;
};

/**
 * Detect `model_map` entries that are a known-but-not-current Claude vendor id.
 * Returns one entry per stale tier, in catalog tier order. An absent tier
 * (caller surfaces `MISSING_MODEL_TIER`), an unknown id (`MODEL_ID_UNKNOWN`),
 * and a tier already at the default are all non-drift and produce no entry.
 */
export function detectModelMapDrift(
  modelMap: Partial<Record<ModelTierKey, string>>,
): ModelMapDrift[] {
  const known = new Set(CLAUDE_KNOWN_VENDOR_MODEL_IDS);
  const drift: ModelMapDrift[] = [];
  for (const tier of Object.keys(CLAUDE_TIER_MODEL_IDS) as ModelTierKey[]) {
    const current = modelMap[tier];
    if (!current) continue; // absence is MISSING_MODEL_TIER, not staleness
    if (!known.has(current)) continue; // unknown id is MODEL_ID_UNKNOWN, not staleness
    const expected = CLAUDE_TIER_MODEL_IDS[tier];
    if (current !== expected) drift.push({ tier, current, expected });
  }
  return drift;
}
