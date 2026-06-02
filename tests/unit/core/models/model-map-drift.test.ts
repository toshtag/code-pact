import { describe, it, expect } from "vitest";
import { detectModelMapDrift } from "../../../../src/core/models/model-map-drift.ts";
import { CLAUDE_TIER_MODEL_IDS } from "../../../../src/core/models/catalog.ts";

// detectModelMapDrift is the single source of truth for the MODEL_MAP_STALE
// *condition*, shared by doctor and the `adapter upgrade --write` hint. These
// tests pin the rule independent of either caller.

describe("detectModelMapDrift", () => {
  it("returns no drift for a model_map at the current catalog defaults (fresh)", () => {
    expect(detectModelMapDrift({ ...CLAUDE_TIER_MODEL_IDS })).toEqual([]);
  });

  it("returns no drift for an empty model_map (absence is MISSING_MODEL_TIER, not staleness)", () => {
    expect(detectModelMapDrift({})).toEqual([]);
  });

  it("flags a known-but-not-current id as stale, naming current + expected", () => {
    const drift = detectModelMapDrift({
      ...CLAUDE_TIER_MODEL_IDS,
      highest_reasoning: "claude-opus-4-7",
    });
    expect(drift).toEqual([
      {
        tier: "highest_reasoning",
        current: "claude-opus-4-7",
        expected: CLAUDE_TIER_MODEL_IDS.highest_reasoning,
      },
    ]);
  });

  it("does not flag an unknown id as stale (that is MODEL_ID_UNKNOWN, a separate condition)", () => {
    expect(
      detectModelMapDrift({
        ...CLAUDE_TIER_MODEL_IDS,
        highest_reasoning: "claude-opus-9-9",
      }),
    ).toEqual([]);
  });

  it("reports every stale tier, in catalog tier order", () => {
    const drift = detectModelMapDrift({
      highest_reasoning: "claude-opus-4-7",
      balanced_coding: CLAUDE_TIER_MODEL_IDS.balanced_coding, // fresh — excluded
      cheap_mechanical: "claude-opus-4-6", // known id, wrong tier default → stale
    });
    expect(drift.map((d) => d.tier)).toEqual(["highest_reasoning", "cheap_mechanical"]);
  });
});
