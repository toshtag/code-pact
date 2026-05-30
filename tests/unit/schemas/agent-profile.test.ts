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

  // Path fields must be project-relative POSIX paths so they cannot escape the
  // project root when joined onto cwd for mkdir / writeFile / readFile.
  it.each([
    ["context_dir", "../outside"],
    ["context_dir", "a/../b"],
    ["context_dir", "/tmp"],
    ["context_dir", "~/evil"],
    ["context_dir", "a\\b"],
    ["hook_dir", "../hooks"],
    ["skill_dir", "a//b"],
    ["skill_dir", "/abs"],
    ["instruction_filename", "../CLAUDE.md"],
    ["instruction_filename", "/etc/passwd"],
  ])("rejects unsafe %s = %j", (field, value) => {
    expect(() => AgentProfile.parse({ ...VALID, [field]: value })).toThrow();
  });

  it("accepts the conventional relative path fields", () => {
    const a = AgentProfile.parse({
      ...VALID,
      instruction_filename: ".cursor/rules/code-pact.mdc",
      context_dir: ".context/cursor",
      skill_dir: ".claude/skills",
      hook_dir: ".claude/hooks",
    });
    expect(a.context_dir).toBe(".context/cursor");
  });
});
