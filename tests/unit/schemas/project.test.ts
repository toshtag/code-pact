import { describe, it, expect } from "vitest";
import { AgentRef, Project } from "../../../src/core/schemas/project.ts";

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

describe("AgentRef.enabled", () => {
  it("defaults enabled to true when omitted", () => {
    const result = AgentRef.parse({
      name: "claude-code",
      profile: "agent-profiles/claude-code.yaml",
    });
    expect(result.enabled).toBe(true);
  });

  it("accepts explicit enabled: true", () => {
    const result = AgentRef.parse({
      name: "claude-code",
      profile: "agent-profiles/claude-code.yaml",
      enabled: true,
    });
    expect(result.enabled).toBe(true);
  });

  it("accepts explicit enabled: false", () => {
    const result = AgentRef.parse({
      name: "claude-code",
      profile: "agent-profiles/claude-code.yaml",
      enabled: false,
    });
    expect(result.enabled).toBe(false);
  });

  it("rejects non-boolean enabled", () => {
    expect(() =>
      AgentRef.parse({
        name: "claude-code",
        profile: "agent-profiles/claude-code.yaml",
        enabled: "yes",
      }),
    ).toThrow();
  });

  it("Project preserves agents[].enabled defaulting through nested parse", () => {
    const result = Project.parse(VALID);
    expect(result.agents[0].enabled).toBe(true);
  });
});
