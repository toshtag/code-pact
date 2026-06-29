import { describe, expect, it } from "vitest";
import { validateAdapterDescriptor } from "../../../../src/core/adapters/descriptor-validation.ts";
import type { AdapterDescriptor } from "../../../../src/core/adapters/types.ts";

const baseDescriptor: AdapterDescriptor = {
  async generateDesiredFiles() {
    return [];
  },
  capabilities: ["instructions_file", "context_dir"] as const,
  ownedPathRoles: {
    "AGENTS.md": "instruction",
  },
  profilePathContract: {
    instructionFilename: "AGENTS.md",
  },
  adapterSchemaVersion: 1,
};

describe("validateAdapterDescriptor", () => {
  it("accepts exact owned paths that match the profile contract", () => {
    expect(validateAdapterDescriptor("codex", baseDescriptor)).toBe(
      baseDescriptor,
    );
  });

  it("rejects glob metacharacters in ownedPathRoles", () => {
    expect(() =>
      validateAdapterDescriptor("bad", {
        ...baseDescriptor,
        ownedPathRoles: {
          ".claude/skills/*.md": "skill",
        },
        capabilities: ["skills_dir", "context_dir"] as const,
        profilePathContract: {
          instructionFilename: "AGENTS.md",
          skillDir: ".claude/skills",
        },
      }),
    ).toThrow(/must be an exact path/);
  });

  it("rejects an instruction profile path outside ownedPathRoles", () => {
    expect(() =>
      validateAdapterDescriptor("bad", {
        ...baseDescriptor,
        profilePathContract: {
          instructionFilename: "PRIVATE.md",
        },
      }),
    ).toThrow(/not present in ownedPathRoles/);
  });
});
