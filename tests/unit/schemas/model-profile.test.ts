import { describe, it, expect } from "vitest";
import { ModelProfile } from "../../../src/core/schemas/model-profile.ts";

const VALID = {
  tier: "highest_reasoning",
  purpose: ["architecture", "high_ambiguity"],
  effort_levels: ["high"],
  supports_thinking: true,
};

describe("ModelProfile", () => {
  it("accepts a valid highest_reasoning profile", () => {
    const m = ModelProfile.parse(VALID);
    expect(m.tier).toBe("highest_reasoning");
    expect(m.supports_thinking).toBe(true);
  });

  it("accepts cheap_mechanical with no thinking", () => {
    const m = ModelProfile.parse({
      tier: "cheap_mechanical",
      purpose: ["docs"],
      effort_levels: ["low"],
      supports_thinking: false,
    });
    expect(m.tier).toBe("cheap_mechanical");
  });

  it("rejects empty purpose array", () => {
    expect(() => ModelProfile.parse({ ...VALID, purpose: [] })).toThrow();
  });

  it("rejects invalid tier", () => {
    expect(() => ModelProfile.parse({ ...VALID, tier: "super_expensive" })).toThrow();
  });
});
