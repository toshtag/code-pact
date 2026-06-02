import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { runInit } from "../../../src/commands/init.ts";
import {
  Project,
  Roadmap,
  AgentProfile,
  ModelProfile,
  ProgressLog,
  BaselineSnapshot,
} from "../../../src/core/schemas/index.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-init-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readYaml(rel: string): Promise<unknown> {
  const raw = await readFile(join(dir, rel), "utf8");
  return parseYaml(raw);
}

async function readJson(rel: string): Promise<unknown> {
  const raw = await readFile(join(dir, rel), "utf8");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runInit — default options (claude-code, ja-JP)", () => {
  it("returns a created list with no skipped files", async () => {
    const result = await runInit({
      cwd: dir,
      locale: "ja-JP",
      agents: ["claude-code"],
      force: false,
      json: false,
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.created.length).toBeGreaterThan(0);
  });

  it("generates a valid project.yaml", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    const data = await readYaml(".code-pact/project.yaml");
    const project = Project.parse(data);
    expect(project.locale).toBe("ja-JP");
    expect(project.default_agent).toBe("claude-code");
    expect(project.agents).toHaveLength(1);
  });

  it("generates a valid roadmap.yaml with empty phases", async () => {
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
    const data = await readYaml("design/roadmap.yaml");
    const roadmap = Roadmap.parse(data);
    expect(roadmap.phases).toHaveLength(0);
  });

  it("generates a valid claude-code agent profile", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    const data = await readYaml(".code-pact/agent-profiles/claude-code.yaml");
    const profile = AgentProfile.parse(data);
    expect(profile.name).toBe("claude-code");
    expect(profile.model_map.highest_reasoning).toBe("claude-opus-4-8");
  });

  it("generates all three model profiles", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    for (const tierFile of ["highest-reasoning.yaml", "balanced-coding.yaml", "cheap-mechanical.yaml"]) {
      const data = await readYaml(`.code-pact/model-profiles/${tierFile}`);
      expect(() => ModelProfile.parse(data)).not.toThrow();
    }
  });

  it("generates a valid empty progress.yaml", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    const data = await readYaml(".code-pact/state/progress.yaml");
    const log = ProgressLog.parse(data);
    expect(log.events).toHaveLength(0);
  });

  it("generates a valid initial baseline snapshot", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    const data = await readJson(".code-pact/state/baselines/initial.json");
    const snap = BaselineSnapshot.parse(data);
    expect(snap.name).toBe("initial");
    expect(snap.total_weight).toBe(0);
    expect(snap.phases).toHaveLength(0);
  });

  it("generates constitution.md and rules/coding-style.md", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    const constitution = await readFile(join(dir, "design", "constitution.md"), "utf8");
    expect(constitution).toContain("Constitution");
    const codingStyle = await readFile(join(dir, "design", "rules", "coding-style.md"), "utf8");
    expect(codingStyle).toContain("tags:");
  });
});

describe("runInit — multiple agents (claude-code + codex)", () => {
  it("generates both agent profiles", async () => {
    await runInit({
      cwd: dir,
      locale: "en-US",
      agents: ["claude-code", "codex"],
      force: false,
      json: false,
    });
    const claude = AgentProfile.parse(await readYaml(".code-pact/agent-profiles/claude-code.yaml"));
    expect(claude.name).toBe("claude-code");
    const codex = AgentProfile.parse(await readYaml(".code-pact/agent-profiles/codex.yaml"));
    expect(codex.name).toBe("codex");
  });

  it("sets default_agent to the first listed agent", async () => {
    await runInit({
      cwd: dir,
      locale: "en-US",
      agents: ["codex", "claude-code"],
      force: false,
      json: false,
    });
    const project = Project.parse(await readYaml(".code-pact/project.yaml"));
    expect(project.default_agent).toBe("codex");
  });
});

describe("runInit — double init (no --force)", () => {
  it("throws ALREADY_INITIALIZED on second run", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    await expect(
      runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false }),
    ).rejects.toMatchObject({ code: "ALREADY_INITIALIZED" });
  });
});

describe("runInit — --force overwrites", () => {
  it("overwrites existing files when force is true", async () => {
    await runInit({ cwd: dir, locale: "ja-JP", agents: ["claude-code"], force: false, json: false });
    const result = await runInit({
      cwd: dir,
      locale: "en-US",
      agents: ["claude-code"],
      force: true,
      json: false,
    });
    // All files should be in created (overwritten), not skipped
    expect(result.skipped).toHaveLength(0);
    // locale should now be en-US
    const project = Project.parse(await readYaml(".code-pact/project.yaml"));
    expect(project.locale).toBe("en-US");
  });
});
