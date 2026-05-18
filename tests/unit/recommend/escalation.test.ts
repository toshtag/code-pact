import { describe, it, expect } from "vitest";
import { recommendEscalation } from "../../../src/core/recommend/escalation.ts";

describe("recommendEscalation", () => {
  it("cheap_mechanical → [increase_effort, increase_context, escalate_tier]", () => {
    expect(recommendEscalation("cheap_mechanical")).toEqual([
      "increase_effort",
      "increase_context",
      "escalate_tier",
    ]);
  });

  it("balanced_coding → [increase_context, increase_effort, escalate_tier, ask_human]", () => {
    expect(recommendEscalation("balanced_coding")).toEqual([
      "increase_context",
      "increase_effort",
      "escalate_tier",
      "ask_human",
    ]);
  });

  it("highest_reasoning → [increase_context, ask_human]", () => {
    expect(recommendEscalation("highest_reasoning")).toEqual(["increase_context", "ask_human"]);
  });

  it("highest_reasoning has no escalate_tier (no tier above)", () => {
    expect(recommendEscalation("highest_reasoning")).not.toContain("escalate_tier");
  });

  it("returns a fresh array each call (no shared mutable state)", () => {
    const a = recommendEscalation("balanced_coding");
    a.push("ask_human");
    const b = recommendEscalation("balanced_coding");
    expect(b).toEqual(["increase_context", "increase_effort", "escalate_tier", "ask_human"]);
  });
});
