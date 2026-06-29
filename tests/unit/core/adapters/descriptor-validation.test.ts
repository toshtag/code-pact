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

const claudeLikeDescriptor: AdapterDescriptor = {
  async generateDesiredFiles() {
    return [];
  },
  capabilities: [
    "instructions_file",
    "skills_dir",
    "hooks_dir",
    "context_dir",
  ] as const,
  ownedPathRoles: {
    "CLAUDE.md": "instruction",
    ".claude/skills/context.md": "skill",
  },
  createPathGlobsByRole: {
    skill: [".claude/skills/*.md"],
  },
  profilePathContract: {
    instructionFilename: "CLAUDE.md",
    skillDir: ".claude/skills",
    hookDir: ".claude/hooks",
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

  it("accepts narrow create globs under the matching profile directory", () => {
    expect(validateAdapterDescriptor("claude-code", claudeLikeDescriptor)).toBe(
      claudeLikeDescriptor,
    );
  });

  it("rejects create globs that use recursive doublestar", () => {
    expect(() =>
      validateAdapterDescriptor("bad", {
        ...claudeLikeDescriptor,
        createPathGlobsByRole: {
          skill: [".claude/skills/**"],
        },
      }),
    ).toThrow(/must not use "\*\*"/);
  });

  it("rejects create globs under protected namespaces", () => {
    expect(() =>
      validateAdapterDescriptor("bad", {
        ...claudeLikeDescriptor,
        createPathGlobsByRole: {
          skill: [".code-pact/skills/*.md"],
        },
      }),
    ).toThrow(/protected namespace/);
  });

  it("rejects instruction and rule create globs", () => {
    expect(() =>
      validateAdapterDescriptor("bad", {
        ...baseDescriptor,
        createPathGlobsByRole: {
          instruction: ["design/*.md"],
        },
      }),
    ).toThrow(/instruction and rule paths must be exact/);

    expect(() =>
      validateAdapterDescriptor("bad", {
        ...baseDescriptor,
        capabilities: ["rules_file", "context_dir"] as const,
        ownedPathRoles: {
          ".cursor/rules/code-pact.mdc": "rule",
        },
        profilePathContract: {
          instructionFilename: ".cursor/rules/code-pact.mdc",
        },
        createPathGlobsByRole: {
          rule: [".github/*.md"],
        },
      }),
    ).toThrow(/instruction and rule paths must be exact/);
  });

  it("rejects skill or hook create globs without the matching directory contract", () => {
    expect(() =>
      validateAdapterDescriptor("bad", {
        ...baseDescriptor,
        capabilities: ["instructions_file", "skills_dir", "context_dir"] as const,
        createPathGlobsByRole: {
          skill: [".claude/skills/*.md"],
        },
      }),
    ).toThrow(/requires profilePathContract.skillDir/);

    expect(() =>
      validateAdapterDescriptor("bad", {
        ...baseDescriptor,
        capabilities: ["instructions_file", "hooks_dir", "context_dir"] as const,
        createPathGlobsByRole: {
          hook: [".claude/hooks/*.json"],
        },
      }),
    ).toThrow(/requires profilePathContract.hookDir/);
  });

  it("rejects duplicate create glob patterns", () => {
    expect(() =>
      validateAdapterDescriptor("bad", {
        ...claudeLikeDescriptor,
        createPathGlobsByRole: {
          skill: [".claude/skills/*.md", ".claude/skills/*.md"],
        },
      }),
    ).toThrow(/duplicated/);
  });

  it("rejects create globs outside the role's profile directory", () => {
    expect(() =>
      validateAdapterDescriptor("bad", {
        ...claudeLikeDescriptor,
        createPathGlobsByRole: {
          skill: ["docs/skills/*.md"],
        },
      }),
    ).toThrow(/must stay under skillDir/);
  });

  it("rejects create glob role collisions with static owned paths", () => {
    expect(() =>
      validateAdapterDescriptor("bad", {
        ...baseDescriptor,
        capabilities: [
          "instructions_file",
          "skills_dir",
          "hooks_dir",
          "context_dir",
        ] as const,
        ownedPathRoles: {
          "AGENTS.md": "instruction",
          ".claude/skills/context.md": "hook",
        },
        createPathGlobsByRole: {
          skill: [".claude/skills/*.md"],
        },
        profilePathContract: {
          instructionFilename: "AGENTS.md",
          skillDir: ".claude/skills",
          hookDir: ".claude/hooks",
        },
      }),
    ).toThrow(/overlaps owned path/);
  });
});
