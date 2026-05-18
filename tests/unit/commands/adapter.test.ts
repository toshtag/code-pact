import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInit } from "../../../src/commands/init.ts";
import { runInitCore } from "../../../src/commands/init.ts";
import { runGenerateAdapter } from "../../../src/commands/adapter.ts";
import { deriveSkillName } from "../../../src/core/adapters/claude.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-adapter-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// claude-code adapter
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — claude-code", () => {
  beforeEach(async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
  });

  it("returns created list with CLAUDE.md and skill files", async () => {
    const result = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    expect(result.agentName).toBe("claude-code");
    const names = result.created.map((p) => p.replace(dir, ""));
    expect(names.some((n) => n.includes("CLAUDE.md"))).toBe(true);
    expect(names.some((n) => n.includes("context.md"))).toBe(true);
    expect(names.some((n) => n.includes("verify.md"))).toBe(true);
    expect(names.some((n) => n.includes("progress.md"))).toBe(true);
  });

  it("CLAUDE.md contains model tier entries", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("highest_reasoning");
    expect(content).toContain("claude-opus-4-7");
    expect(content).toContain("balanced_coding");
    expect(content).toContain("cheap_mechanical");
  });

  it("CLAUDE.md instructs the agent to use task context + task complete", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("code-pact task context");
    expect(content).toContain("code-pact task complete");
  });

  it("CLAUDE.md does NOT reference unimplemented `progress --add-event`", async () => {
    // task complete (v0.2) writes progress.yaml on the agent's behalf,
    // so the file is now mentioned descriptively, but the unsupported
    // `progress --add-event` form must still never appear.
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).not.toContain("--add-event");
  });

  it("skips existing files when force is false", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const second = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    expect(second.created).toHaveLength(0);
    expect(second.skipped.length).toBeGreaterThan(0);
  });

  it("overwrites when force is true", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const second = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: true, locale: "en-US" });
    expect(second.created.length).toBeGreaterThan(0);
    expect(second.skipped).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// codex adapter
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — codex", () => {
  beforeEach(async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["codex"], force: false, json: false });
  });

  it("creates AGENTS.md", async () => {
    const result = await runGenerateAdapter({ cwd: dir, agentName: "codex", force: false, locale: "en-US" });
    const names = result.created.map((p) => p.replace(dir, ""));
    expect(names.some((n) => n.includes("AGENTS.md"))).toBe(true);
  });

  it("AGENTS.md contains model tier entries", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "codex", force: false, locale: "en-US" });
    const content = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(content).toContain("highest_reasoning");
    expect(content).toContain("o3");
    expect(content).toContain("balanced_coding");
    expect(content).toContain("cheap_mechanical");
  });
});

// ---------------------------------------------------------------------------
// generic adapter
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — generic", () => {
  beforeEach(async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["generic"], force: false, json: false });
  });

  it("writes docs/code-pact/agent-instructions.md", async () => {
    const result = await runGenerateAdapter({ cwd: dir, agentName: "generic", force: false, locale: "en-US" });
    expect(result.agentName).toBe("generic");
    const names = result.created.map((p) => p.replace(dir, ""));
    expect(names.some((n) => n.includes("docs/code-pact/agent-instructions.md"))).toBe(true);
  });

  it("agent-instructions.md instructs the agent to use task context + verify", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "generic", force: false, locale: "en-US" });
    const content = await readFile(
      join(dir, "docs", "code-pact", "agent-instructions.md"),
      "utf8",
    );
    expect(content).toContain("code-pact task context");
    expect(content).toContain("code-pact task complete");
  });

  it("agent-instructions.md does NOT reference unimplemented commands or npx", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "generic", force: false, locale: "en-US" });
    const content = await readFile(
      join(dir, "docs", "code-pact", "agent-instructions.md"),
      "utf8",
    );
    // `progress --add-event` never existed and must never be advertised.
    expect(content).not.toContain("--add-event");
    // Generic adapter is for the contributor-distributed binary, not npx.
    expect(content).not.toContain("npx code-pact");
  });

  it("creates .context/generic/ directory for context packs", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "generic", force: false, locale: "en-US" });
    // Directory existence is implied by mkdir recursive; verify by reading.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(dir, ".context"));
    expect(entries).toContain("generic");
  });
});

// ---------------------------------------------------------------------------
// cursor adapter (experimental, v0.2)
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — cursor", () => {
  beforeEach(async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["cursor"], force: false, json: false });
  });

  it("writes .cursor/rules/code-pact.mdc", async () => {
    const result = await runGenerateAdapter({ cwd: dir, agentName: "cursor", force: false, locale: "en-US" });
    expect(result.agentName).toBe("cursor");
    const names = result.created.map((p) => p.replace(dir, ""));
    expect(names.some((n) => n.includes(".cursor/rules/code-pact.mdc"))).toBe(
      true,
    );
  });

  it("emits a Cursor-format mdc with frontmatter and alwaysApply: true", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "cursor", force: false, locale: "en-US" });
    const content = await readFile(
      join(dir, ".cursor", "rules", "code-pact.mdc"),
      "utf8",
    );
    // Frontmatter must be the very first thing in the file so Cursor
    // recognises it as a rule. The .mdc format is documented at
    // https://cursor.com/docs/context/rules.
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("alwaysApply: true");
    // Empty globs is intentional: the rule applies project-wide.
    expect(content).toContain("globs: []");
    expect(content).toMatch(/description:\s/);
  });

  it("instructs the agent to use task context + task complete", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "cursor", force: false, locale: "en-US" });
    const content = await readFile(
      join(dir, ".cursor", "rules", "code-pact.mdc"),
      "utf8",
    );
    expect(content).toContain("code-pact task context");
    expect(content).toContain("code-pact task complete");
  });

  it("flags itself as experimental in the file body", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "cursor", force: false, locale: "en-US" });
    const content = await readFile(
      join(dir, ".cursor", "rules", "code-pact.mdc"),
      "utf8",
    );
    expect(content).toMatch(/experimental/i);
  });

  it("does NOT write the deprecated `.cursorrules` legacy file", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "cursor", force: false, locale: "en-US" });
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, ".cursorrules"))).toBe(false);
  });

  it("creates .context/cursor/ directory for context packs", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "cursor", force: false, locale: "en-US" });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(dir, ".context"));
    expect(entries).toContain("cursor");
  });
});

// ---------------------------------------------------------------------------
// gemini-cli adapter (experimental, v0.2)
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — gemini-cli", () => {
  beforeEach(async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["gemini-cli"], force: false, json: false });
  });

  it("writes GEMINI.md at project root", async () => {
    const result = await runGenerateAdapter({ cwd: dir, agentName: "gemini-cli", force: false, locale: "en-US" });
    expect(result.agentName).toBe("gemini-cli");
    const names = result.created.map((p) => p.replace(dir, ""));
    expect(names.some((n) => n.endsWith("/GEMINI.md"))).toBe(true);
  });

  it("GEMINI.md instructs the agent to use task context + task complete", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "gemini-cli", force: false, locale: "en-US" });
    const content = await readFile(join(dir, "GEMINI.md"), "utf8");
    expect(content).toContain("code-pact task context");
    expect(content).toContain("code-pact task complete");
  });

  it("flags itself as experimental and links the official source", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "gemini-cli", force: false, locale: "en-US" });
    const content = await readFile(join(dir, "GEMINI.md"), "utf8");
    expect(content).toMatch(/experimental/i);
    expect(content).toContain("github.com/google-gemini/gemini-cli");
  });

  it("does NOT emit YAML frontmatter (Gemini CLI expects plain markdown)", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "gemini-cli", force: false, locale: "en-US" });
    const content = await readFile(join(dir, "GEMINI.md"), "utf8");
    expect(content.startsWith("---\n")).toBe(false);
  });

  it("creates .context/gemini-cli/ directory for context packs", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "gemini-cli", force: false, locale: "en-US" });
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(dir, ".context"));
    expect(entries).toContain("gemini-cli");
  });
});

// ---------------------------------------------------------------------------
// Model-aware adapter (v0.5)
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — claude-code model-aware (v0.5)", () => {
  beforeEach(async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
  });

  it("--model opus-4.7: CLAUDE.md includes effort guidance with high/medium/low", async () => {
    await runGenerateAdapter({
      cwd: dir, agentName: "claude-code", force: true, locale: "en-US",
      modelVersion: "opus-4.7",
    });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("Model guidance (opus-4.7)");
    expect(content).toContain("`high`");
    expect(content).toContain("`medium`");
    expect(content).toContain("`low`");
    expect(content).toContain("Extended thinking");
  });

  it("--model opus-4.6: includes effort guidance with high/medium/low", async () => {
    await runGenerateAdapter({
      cwd: dir, agentName: "claude-code", force: true, locale: "en-US",
      modelVersion: "opus-4.6",
    });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("Model guidance (opus-4.6)");
    expect(content).toContain("`high`");
  });

  it("--model sonnet-4.6: notes that effort:high is NOT supported", async () => {
    await runGenerateAdapter({
      cwd: dir, agentName: "claude-code", force: true, locale: "en-US",
      modelVersion: "sonnet-4.6",
    });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("Model guidance (sonnet-4.6)");
    expect(content).toContain("not supported");
    expect(content).toContain("highest_reasoning");
  });

  it("no --model: CLAUDE.md does not include Model guidance section", async () => {
    await runGenerateAdapter({
      cwd: dir, agentName: "claude-code", force: true, locale: "en-US",
    });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).not.toContain("Model guidance");
  });

  it("unknown model string: includes fallback note instead of crashing", async () => {
    await runGenerateAdapter({
      cwd: dir, agentName: "claude-code", force: true, locale: "en-US",
      modelVersion: "future-model-99",
    });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("Model guidance (future-model-99)");
    expect(content).toContain("No model-specific guidance available");
  });

  it("model_version from profile.yaml is used when no CLI override", async () => {
    // Write model_version into the agent profile yaml
    const { writeFile: wf } = await import("node:fs/promises");
    const profilePath = join(dir, ".code-pact", "agent-profiles", "claude-code.yaml");
    const original = await readFile(profilePath, "utf8");
    await wf(profilePath, original + "model_version: opus-4.7\n", "utf8");

    await runGenerateAdapter({
      cwd: dir, agentName: "claude-code", force: true, locale: "en-US",
    });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("Model guidance (opus-4.7)");
  });

  it("CLI modelVersion overrides model_version from profile.yaml", async () => {
    const { writeFile: wf } = await import("node:fs/promises");
    const profilePath = join(dir, ".code-pact", "agent-profiles", "claude-code.yaml");
    const original = await readFile(profilePath, "utf8");
    await wf(profilePath, original + "model_version: opus-4.7\n", "utf8");

    await runGenerateAdapter({
      cwd: dir, agentName: "claude-code", force: true, locale: "en-US",
      modelVersion: "sonnet-4.6",  // CLI override wins
    });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("Model guidance (sonnet-4.6)");
    expect(content).not.toContain("Model guidance (opus-4.7)");
  });
});

// ---------------------------------------------------------------------------
// Error: unknown agent
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — unknown agent", () => {
  beforeEach(async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
  });

  it("throws AGENT_NOT_FOUND for unrecognised agent name", async () => {
    await expect(
      runGenerateAdapter({ cwd: dir, agentName: "gemini", force: false, locale: "en-US" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// deriveSkillName unit tests (v0.5.2)
// ---------------------------------------------------------------------------

describe("deriveSkillName", () => {
  it("pnpm test → test", () => expect(deriveSkillName("pnpm test")).toBe("test"));
  it("pnpm typecheck → typecheck", () => expect(deriveSkillName("pnpm typecheck")).toBe("typecheck"));
  it("pnpm build → build", () => expect(deriveSkillName("pnpm build")).toBe("build"));
  it("npm run lint → lint", () => expect(deriveSkillName("npm run lint")).toBe("lint"));
  it("yarn dev → dev", () => expect(deriveSkillName("yarn dev")).toBe("dev"));
  it("bun run test:unit → test-unit", () => expect(deriveSkillName("bun run test:unit")).toBe("test-unit"));
  it("make build → build", () => expect(deriveSkillName("make build")).toBe("build"));
});

// ---------------------------------------------------------------------------
// Skill generation from verification commands (v0.5.2)
// ---------------------------------------------------------------------------

describe("runGenerateAdapter — v0.5.2 skill generation", () => {
  beforeEach(async () => {
    await runInitCore({
      cwd: dir,
      locale: "en-US",
      agents: ["claude-code"],
      force: false,
      json: false,
      createSamplePhase: true,
      verifyCommand: "pnpm test",
    });
  });

  it("generates test.md skill from verification command pnpm test", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const skillContent = await readFile(join(dir, ".claude", "skills", "test.md"), "utf8");
    expect(skillContent).toContain("/test");
    expect(skillContent).toContain("pnpm test");
  });

  it("generated skill is listed in created result", async () => {
    const result = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const names = result.created.map((p) => p.replace(dir, ""));
    expect(names.some((n) => n.includes("test.md"))).toBe(true);
  });

  it("re-run without force skips existing skill files", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    const second = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    expect(second.skipped.some((p) => p.includes("test.md"))).toBe(true);
  });

  it("--regen-skills regenerates skill files without overwriting CLAUDE.md", async () => {
    // First run — create all files
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US" });
    // Overwrite CLAUDE.md with sentinel content
    await writeFile(join(dir, "CLAUDE.md"), "SENTINEL", "utf8");
    // Overwrite test.md with old content
    await writeFile(join(dir, ".claude", "skills", "test.md"), "OLD", "utf8");

    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false, locale: "en-US", regenSkills: true });

    // CLAUDE.md must NOT have been overwritten
    const claudeMd = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(claudeMd).toBe("SENTINEL");

    // test.md must have been regenerated
    const skillContent = await readFile(join(dir, ".claude", "skills", "test.md"), "utf8");
    expect(skillContent).not.toBe("OLD");
    expect(skillContent).toContain("pnpm test");
  });

  it("no roadmap → no crash, only fixed skills are created", async () => {
    // Remove roadmap to simulate project without phases
    const { rm: fsRm } = await import("node:fs/promises");
    await fsRm(join(dir, "design", "roadmap.yaml"));

    const result = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: true, locale: "en-US" });
    const names = result.created.map((p) => p.replace(dir, ""));
    // Fixed skills must exist
    expect(names.some((n) => n.includes("context.md"))).toBe(true);
    expect(names.some((n) => n.includes("verify.md"))).toBe(true);
    expect(names.some((n) => n.includes("progress.md"))).toBe(true);
    // No dynamic skill from roadmap
    expect(names.some((n) => n.includes("test.md"))).toBe(false);
  });

  it("multiple phases with the same command produce one skill file", async () => {
    // Add a second phase with the same verification command
    const roadmapContent = await readFile(join(dir, "design", "roadmap.yaml"), "utf8");
    await mkdir(join(dir, "design", "phases"), { recursive: true });
    await writeFile(
      join(dir, "design", "phases", "P2-extra.yaml"),
      [
        "id: P2", "name: Extra", "weight: 5", "confidence: high", "risk: low",
        "status: planned", "objective: Extra phase.", "definition_of_done:", "  - Done",
        "verification:", "  commands:", "    - pnpm test",
        "tasks: []",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(dir, "design", "roadmap.yaml"),
      roadmapContent + "  - id: P2\n    path: design/phases/P2-extra.yaml\n    weight: 5\n",
      "utf8",
    );

    const result = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: true, locale: "en-US" });
    const skillFiles = result.created.filter((p) => p.includes("test.md"));
    expect(skillFiles).toHaveLength(1);
  });
});
