import { describe, it, expect } from "vitest";
import { recommendContextFit } from "../../../../src/core/recommend/context-fit.ts";
import { STANDARD_CONTEXT_BUDGET_PROFILES } from "../../../../src/core/context-fit/budget-profiles.ts";

// Public contract assertions — the byte values are pinned here intentionally
// (the single runtime source of truth is budget-profiles.ts; tests may repeat
// the values to lock the contract).
const TIGHT = 30000;
const BALANCED = 60000;
const WIDE = 120000;

describe("recommendContextFit — deterministic profile mapping (RFC § Layer (b))", () => {
  it("small + low ambiguity + low write_surface -> tight", () => {
    const r = recommendContextFit({
      contextSize: "small",
      ambiguity: "low",
      writeSurface: "low",
    });
    expect(r.recommendedProfile).toBe("tight");
    expect(r.recommendedBudgetBytes).toBe(TIGHT);
  });

  it("small + medium ambiguity + medium write_surface -> tight", () => {
    const r = recommendContextFit({
      contextSize: "small",
      ambiguity: "medium",
      writeSurface: "medium",
    });
    expect(r.recommendedProfile).toBe("tight");
  });

  it("small + high ambiguity -> wide", () => {
    const r = recommendContextFit({
      contextSize: "small",
      ambiguity: "high",
      writeSurface: "low",
    });
    expect(r.recommendedProfile).toBe("wide");
    expect(r.recommendedBudgetBytes).toBe(WIDE);
  });

  it("medium -> balanced", () => {
    const r = recommendContextFit({
      contextSize: "medium",
      ambiguity: "low",
      writeSurface: "low",
    });
    expect(r.recommendedProfile).toBe("balanced");
    expect(r.recommendedBudgetBytes).toBe(BALANCED);
  });

  it("large -> wide", () => {
    const r = recommendContextFit({
      contextSize: "large",
      ambiguity: "low",
      writeSurface: "low",
    });
    expect(r.recommendedProfile).toBe("wide");
    expect(r.recommendedBudgetBytes).toBe(WIDE);
  });

  it("write_surface high (small context, low ambiguity) -> wide", () => {
    const r = recommendContextFit({
      contextSize: "small",
      ambiguity: "low",
      writeSurface: "high",
    });
    expect(r.recommendedProfile).toBe("wide");
  });

  it("write_surface high also overrides a medium context (would be balanced)", () => {
    const r = recommendContextFit({
      contextSize: "medium",
      ambiguity: "low",
      writeSurface: "high",
    });
    expect(r.recommendedProfile).toBe("wide");
  });
});

describe("recommendContextFit — requires_decision never shrinks", () => {
  it("requires_decision=true does not shrink a tight recommendation", () => {
    const base = {
      contextSize: "small",
      ambiguity: "low",
      writeSurface: "low",
    } as const;
    const without = recommendContextFit(base);
    const withDecision = recommendContextFit({ ...base, requiresDecision: true });
    expect(withDecision.recommendedProfile).toBe(without.recommendedProfile);
    expect(withDecision.recommendedBudgetBytes).toBe(without.recommendedBudgetBytes);
  });

  it("requires_decision=true does not shrink a wide recommendation", () => {
    const r = recommendContextFit({
      contextSize: "large",
      ambiguity: "low",
      writeSurface: "low",
      requiresDecision: true,
    });
    expect(r.recommendedProfile).toBe("wide");
    expect(r.recommendedBudgetBytes).toBe(WIDE);
  });
});

describe("recommendContextFit — agent-profile same-name override", () => {
  it("override wins for tight", () => {
    const r = recommendContextFit({
      contextSize: "small",
      ambiguity: "low",
      writeSurface: "low",
      agentContextBudgetProfiles: { tight: { max_bytes: 11111 } },
    });
    expect(r.recommendedProfile).toBe("tight");
    expect(r.recommendedBudgetBytes).toBe(11111);
    expect(r.reason).toContain("agent profile override");
  });

  it("override wins for balanced", () => {
    const r = recommendContextFit({
      contextSize: "medium",
      ambiguity: "low",
      writeSurface: "low",
      agentContextBudgetProfiles: { balanced: { max_bytes: 22222 } },
    });
    expect(r.recommendedProfile).toBe("balanced");
    expect(r.recommendedBudgetBytes).toBe(22222);
  });

  it("override wins for wide", () => {
    const r = recommendContextFit({
      contextSize: "large",
      ambiguity: "low",
      writeSurface: "low",
      agentContextBudgetProfiles: { wide: { max_bytes: 33333 } },
    });
    expect(r.recommendedProfile).toBe("wide");
    expect(r.recommendedBudgetBytes).toBe(33333);
  });

  it("falls back to the built-in value when no same-name override exists", () => {
    const r = recommendContextFit({
      contextSize: "small",
      ambiguity: "low",
      writeSurface: "low",
      // Only a 'balanced' override declared; the recommendation is 'tight', so
      // the built-in fallback applies.
      agentContextBudgetProfiles: { balanced: { max_bytes: 99999 } },
    });
    expect(r.recommendedProfile).toBe("tight");
    expect(r.recommendedBudgetBytes).toBe(TIGHT);
    expect(r.reason).toContain("built-in fallback");
  });

  it("custom profile names are ignored by the recommendation", () => {
    const r = recommendContextFit({
      contextSize: "small",
      ambiguity: "low",
      writeSurface: "low",
      agentContextBudgetProfiles: { surgical: { max_bytes: 5000 } },
    });
    // The custom name is never emitted; the recommendation is a standard name
    // and its bytes come from the built-in fallback, not the custom entry.
    expect(r.recommendedProfile).toBe("tight");
    expect(r.recommendedBudgetBytes).toBe(TIGHT);
  });
});

describe("recommendContextFit — reason string", () => {
  it("records the driving signal and the byte source", () => {
    const r = recommendContextFit({
      contextSize: "medium",
      ambiguity: "low",
      writeSurface: "low",
    });
    expect(r.reason).toBe("context_size=medium -> balanced; bytes from built-in fallback");
  });

  it("byte values match the single source of truth", () => {
    expect(STANDARD_CONTEXT_BUDGET_PROFILES.tight).toBe(TIGHT);
    expect(STANDARD_CONTEXT_BUDGET_PROFILES.balanced).toBe(BALANCED);
    expect(STANDARD_CONTEXT_BUDGET_PROFILES.wide).toBe(WIDE);
  });
});
