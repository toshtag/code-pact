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
    const a = AgentProfile.parse({
      ...VALID,
      skill_dir: ".claude/skills",
      hook_dir: ".claude/hooks",
    });
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
    expect(() =>
      AgentProfile.parse({ ...VALID, instruction_filename: "" }),
    ).toThrow();
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

  // context_dir must be .context or .context/** — a hostile profile setting
  // context_dir: design + taskId: constitution would overwrite
  // design/constitution.md via the context pack write path.
  it.each([
    ["design"],
    ["docs"],
    ["src"],
    [".code-pact"],
    [".claude"],
    [".contextual"],
    [".context-old"],
    [".context_backup"],
    ["foo/.context"],
  ])("rejects context_dir = %j (outside .context namespace)", value => {
    expect(() =>
      AgentProfile.parse({ ...VALID, context_dir: value }),
    ).toThrow();
  });

  it.each([
    [".context"],
    [".context/custom"],
    [".context/claude-code"],
    [".context/custom/nested"],
  ])("accepts context_dir = %j (inside .context namespace)", value => {
    const a = AgentProfile.parse({ ...VALID, context_dir: value });
    expect(a.context_dir).toBe(value);
  });
});

// P47 (Context Fit, layer a) — optional `context_budget` block.
describe("AgentProfile.context_budget (P47)", () => {
  it("a missing context_budget block is valid (backward compatible)", () => {
    const a = AgentProfile.parse(VALID);
    expect(a.context_budget).toBeUndefined();
  });

  it("accepts the three standard profiles", () => {
    const a = AgentProfile.parse({
      ...VALID,
      context_budget: {
        profiles: {
          tight: { max_bytes: 30000 },
          balanced: { max_bytes: 60000 },
          wide: { max_bytes: 120000 },
        },
      },
    });
    expect(a.context_budget?.profiles.balanced?.max_bytes).toBe(60000);
  });

  it("accepts a custom profile name", () => {
    const a = AgentProfile.parse({
      ...VALID,
      context_budget: { profiles: { review_pack: { max_bytes: 45000 } } },
    });
    expect(a.context_budget?.profiles.review_pack?.max_bytes).toBe(45000);
  });

  it("accepts a default_profile that references a declared profile", () => {
    const a = AgentProfile.parse({
      ...VALID,
      context_budget: {
        default_profile: "balanced",
        profiles: { balanced: { max_bytes: 60000 } },
      },
    });
    expect(a.context_budget?.default_profile).toBe("balanced");
  });

  it("rejects max_bytes: 0", () => {
    expect(() =>
      AgentProfile.parse({
        ...VALID,
        context_budget: { profiles: { tight: { max_bytes: 0 } } },
      }),
    ).toThrow();
  });

  it("rejects a negative max_bytes", () => {
    expect(() =>
      AgentProfile.parse({
        ...VALID,
        context_budget: { profiles: { tight: { max_bytes: -1 } } },
      }),
    ).toThrow();
  });

  it("rejects a non-integer max_bytes", () => {
    expect(() =>
      AgentProfile.parse({
        ...VALID,
        context_budget: { profiles: { tight: { max_bytes: 30000.5 } } },
      }),
    ).toThrow();
  });

  it("rejects an empty profiles object", () => {
    expect(() =>
      AgentProfile.parse({ ...VALID, context_budget: { profiles: {} } }),
    ).toThrow();
  });

  it("rejects a dangling default_profile (not in profiles)", () => {
    expect(() =>
      AgentProfile.parse({
        ...VALID,
        context_budget: {
          default_profile: "wide",
          profiles: { tight: { max_bytes: 30000 } },
        },
      }),
    ).toThrow();
  });

  it.each([
    ["", "empty"],
    ["has space", "space"],
    ["a/b", "slash"],
    ["a.b", "dot"],
  ])("rejects an unsafe profile name %j (%s)", name => {
    expect(() =>
      AgentProfile.parse({
        ...VALID,
        context_budget: { profiles: { [name]: { max_bytes: 30000 } } },
      }),
    ).toThrow();
  });
});
