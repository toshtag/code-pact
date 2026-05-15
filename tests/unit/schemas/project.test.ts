import { describe, it, expect } from "vitest";
import { Project } from "../../../src/core/schemas/project.ts";

const VALID = {
  name: "my-project",
  version: "0.1.0",
  locale: "ja-JP",
  default_agent: "claude-code",
  agents: [{ name: "claude-code", profile: "agent-profiles/claude-code.yaml" }],
};

describe("Project", () => {
  it("accepts a valid project", () => {
    const result = Project.parse(VALID);
    expect(result.name).toBe("my-project");
    expect(result.locale).toBe("ja-JP");
  });

  it("accepts locale as an object", () => {
    const result = Project.parse({ ...VALID, locale: { default: "en-US", cli: "ja-JP" } });
    expect(result.locale).toMatchObject({ default: "en-US", cli: "ja-JP" });
  });

  it("rejects missing name", () => {
    const { name: _, ...rest } = VALID as Record<string, unknown>;
    expect(() => Project.parse(rest)).toThrow();
  });

  it("rejects empty agents array", () => {
    expect(() => Project.parse({ ...VALID, agents: [] })).toThrow();
  });

  it("rejects missing default_agent", () => {
    const { default_agent: _, ...rest } = VALID as Record<string, unknown>;
    expect(() => Project.parse(rest)).toThrow();
  });
});
