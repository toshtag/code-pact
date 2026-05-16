import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInit } from "../../../src/commands/init.ts";
import { runGenerateAdapter } from "../../../src/commands/adapter.ts";

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
    const result = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false });
    expect(result.agentName).toBe("claude-code");
    const names = result.created.map((p) => p.replace(dir, ""));
    expect(names.some((n) => n.includes("CLAUDE.md"))).toBe(true);
    expect(names.some((n) => n.includes("context.md"))).toBe(true);
    expect(names.some((n) => n.includes("verify.md"))).toBe(true);
    expect(names.some((n) => n.includes("progress.md"))).toBe(true);
  });

  it("CLAUDE.md contains model tier entries", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("highest_reasoning");
    expect(content).toContain("claude-opus-4-7");
    expect(content).toContain("balanced_coding");
    expect(content).toContain("cheap_mechanical");
  });

  it("CLAUDE.md instructs the agent to use task context + verify", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("code-pact task context");
    expect(content).toContain("code-pact verify");
  });

  it("CLAUDE.md does NOT reference unimplemented progress --add-event", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false });
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).not.toContain("--add-event");
    expect(content).not.toContain("progress.yaml");
  });

  it("skips existing files when force is false", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false });
    const second = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false });
    expect(second.created).toHaveLength(0);
    expect(second.skipped.length).toBeGreaterThan(0);
  });

  it("overwrites when force is true", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: false });
    const second = await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: true });
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
    const result = await runGenerateAdapter({ cwd: dir, agentName: "codex", force: false });
    const names = result.created.map((p) => p.replace(dir, ""));
    expect(names.some((n) => n.includes("AGENTS.md"))).toBe(true);
  });

  it("AGENTS.md contains model tier entries", async () => {
    await runGenerateAdapter({ cwd: dir, agentName: "codex", force: false });
    const content = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(content).toContain("highest_reasoning");
    expect(content).toContain("o3");
    expect(content).toContain("balanced_coding");
    expect(content).toContain("cheap_mechanical");
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
      runGenerateAdapter({ cwd: dir, agentName: "gemini", force: false }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });
});
