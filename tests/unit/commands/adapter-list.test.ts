import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInit } from "../../../src/commands/init.ts";
import { runAdapterInstall } from "../../../src/commands/adapter-install.ts";
import { runAdapterList } from "../../../src/commands/adapter-list.ts";
import { ADAPTER_MANIFEST_DIR_SEGMENTS } from "../../../src/core/adapters/manifest.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-adapter-list-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runAdapterList — without project.yaml", () => {
  it("lists every registered adapter as supported but not enabled", async () => {
    const result = await runAdapterList({ cwd: dir });
    expect(result.agents.map((a) => a.name).sort()).toEqual(
      ["claude-code", "codex", "cursor", "gemini-cli", "generic"].sort(),
    );
    for (const a of result.agents) {
      expect(a.supported).toBe(true);
      expect(a.enabled).toBe(false);
      expect(a.manifestPresent).toBe(false);
    }
  });

  it("flags cursor and gemini-cli as experimental", async () => {
    const result = await runAdapterList({ cwd: dir });
    const byName = new Map(result.agents.map((a) => [a.name, a]));
    expect(byName.get("cursor")?.experimental).toBe(true);
    expect(byName.get("gemini-cli")?.experimental).toBe(true);
    expect(byName.get("claude-code")?.experimental).toBe(false);
    expect(byName.get("codex")?.experimental).toBe(false);
    expect(byName.get("generic")?.experimental).toBe(false);
  });

  it("returns profile and manifest paths even when the files do not exist", async () => {
    const result = await runAdapterList({ cwd: dir });
    const claude = result.agents.find((a) => a.name === "claude-code")!;
    expect(claude.profilePath).toBe(
      join(dir, ".code-pact", "agent-profiles", "claude-code.yaml"),
    );
    expect(claude.manifestPath).toBe(
      join(dir, ".code-pact", "adapters", "claude-code.manifest.yaml"),
    );
  });
});

describe("runAdapterList — with project.yaml", () => {
  beforeEach(async () => {
    await runInit({
      cwd: dir,
      locale: "en-US",
      agents: ["claude-code"],
      force: false,
      json: false,
    });
  });

  it("marks the enabled agent from project.yaml", async () => {
    const result = await runAdapterList({ cwd: dir });
    const byName = new Map(result.agents.map((a) => [a.name, a]));
    expect(byName.get("claude-code")?.enabled).toBe(true);
    expect(byName.get("codex")?.enabled).toBe(false);
  });

  it("reports manifestPresent: false before install", async () => {
    const result = await runAdapterList({ cwd: dir });
    const claude = result.agents.find((a) => a.name === "claude-code")!;
    expect(claude.manifestPresent).toBe(false);
    expect(claude.fileCount).toBeUndefined();
    expect(claude.generatorVersion).toBeUndefined();
    expect(claude.lastGeneratedAt).toBeUndefined();
  });

  it("reports manifest details after install", async () => {
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0-test",
    });
    const result = await runAdapterList({ cwd: dir });
    const claude = result.agents.find((a) => a.name === "claude-code")!;
    expect(claude.manifestPresent).toBe(true);
    expect(claude.fileCount).toBeGreaterThan(0);
    expect(claude.generatorVersion).toBe("0.9.0-alpha.0-test");
    expect(claude.lastGeneratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(claude.manifestInvalid).toBeUndefined();
  });

  it("flags manifestInvalid when the manifest file is malformed YAML", async () => {
    await mkdir(join(dir, ...ADAPTER_MANIFEST_DIR_SEGMENTS), { recursive: true });
    await writeFile(
      join(dir, ...ADAPTER_MANIFEST_DIR_SEGMENTS, "claude-code.manifest.yaml"),
      "schema_version: 1\n  files: [oops:\n",
      "utf8",
    );
    const result = await runAdapterList({ cwd: dir });
    const claude = result.agents.find((a) => a.name === "claude-code")!;
    expect(claude.manifestPresent).toBe(true);
    expect(claude.manifestInvalid).toBe(true);
    expect(claude.fileCount).toBeUndefined();
  });

  it("flags manifestInvalid when the YAML parses but fails schema", async () => {
    await mkdir(join(dir, ...ADAPTER_MANIFEST_DIR_SEGMENTS), { recursive: true });
    await writeFile(
      join(dir, ...ADAPTER_MANIFEST_DIR_SEGMENTS, "claude-code.manifest.yaml"),
      "schema_version: 99\nagent_name: claude-code\n",
      "utf8",
    );
    const result = await runAdapterList({ cwd: dir });
    const claude = result.agents.find((a) => a.name === "claude-code")!;
    expect(claude.manifestPresent).toBe(true);
    expect(claude.manifestInvalid).toBe(true);
  });
});

describe("runAdapterList — multi-agent project", () => {
  it("reports per-agent state independently", async () => {
    // Project enables claude-code AND codex
    await mkdir(join(dir, ".code-pact", "agent-profiles"), { recursive: true });
    await mkdir(join(dir, ".code-pact", "model-profiles"), { recursive: true });
    await writeFile(
      join(dir, ".code-pact", "project.yaml"),
      [
        "name: demo",
        "version: 0.1.0",
        "locale: en-US",
        "default_agent: claude-code",
        "agents:",
        "  - name: claude-code",
        "    profile: agent-profiles/claude-code.yaml",
        "  - name: codex",
        "    profile: agent-profiles/codex.yaml",
        "    enabled: false",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runAdapterList({ cwd: dir });
    const byName = new Map(result.agents.map((a) => [a.name, a]));
    expect(byName.get("claude-code")?.enabled).toBe(true);
    expect(byName.get("codex")?.enabled).toBe(false); // explicitly disabled
    expect(byName.get("generic")?.enabled).toBe(false); // not listed
  });
});
