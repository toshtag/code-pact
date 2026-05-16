import { describe, it, expect } from "vitest";
import { AgentProfile } from "../../../src/core/schemas/agent-profile.ts";

const VALID = {
  name: "claude-code",
  instruction_filename: "CLAUDE.md",
  context_dir: ".context/claude-code",
  model_map: {
    highest_reasoning: "claude-opus-4-7",
    balanced_coding: "claude-sonnet-4-6",
    cheap_mechanical: "claude-haiku-4-5",
  },
};

describe("AgentProfile", () => {
  it("accepts a full claude-code profile", () => {
    const a = AgentProfile.parse(VALID);
    expect(a.name).toBe("claude-code");
    expect(a.model_map.highest_reasoning).toBe("claude-opus-4-7");
  });

  it("accepts optional skill_dir and hook_dir", () => {
    const a = AgentProfile.parse({ ...VALID, skill_dir: ".claude/skills", hook_dir: ".claude/hooks" });
    expect(a.skill_dir).toBe(".claude/skills");
  });

  it("accepts a partial model_map (not all tiers required)", () => {
    const a = AgentProfile.parse({
      ...VALID,
      model_map: { balanced_coding: "claude-sonnet-4-6" },
    });
    expect(a.model_map.balanced_coding).toBe("claude-sonnet-4-6");
  });

  it("rejects missing name", () => {
    const { name: _, ...rest } = VALID as Record<string, unknown>;
    expect(() => AgentProfile.parse(rest)).toThrow();
  });

  it("rejects empty instruction_filename", () => {
    expect(() => AgentProfile.parse({ ...VALID, instruction_filename: "" })).toThrow();
  });
});
