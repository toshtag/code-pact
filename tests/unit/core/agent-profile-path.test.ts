import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInit } from "../../../src/commands/init.ts";
import {
  resolveAgentProfileRel,
  resolveAgentProfilePath,
} from "../../../src/core/agent-profile-path.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-profile-path-"));
  await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Point an agent's project.yaml profile at a custom relative path.
async function setProfileRel(agentName: string, rel: string): Promise<void> {
  const p = join(dir, ".code-pact", "project.yaml");
  const text = await readFile(p, "utf8");
  // The default is `profile: agent-profiles/<name>.yaml`; rewrite it.
  const next = text.replace(
    new RegExp(`profile: agent-profiles/${agentName}\\.yaml`),
    `profile: ${rel}`,
  );
  expect(next).not.toBe(text); // ensure the replacement actually landed
  await writeFile(p, next, "utf8");
}

describe("resolveAgentProfileRel / resolveAgentProfilePath", () => {
  it("returns the conventional path for a freshly initialised agent", async () => {
    expect(await resolveAgentProfileRel(dir, "claude-code")).toBe(
      "agent-profiles/claude-code.yaml",
    );
    expect(await resolveAgentProfilePath(dir, "claude-code")).toBe(
      join(dir, ".code-pact", "agent-profiles", "claude-code.yaml"),
    );
  });

  it("honors a non-default agents[].profile from project.yaml", async () => {
    await setProfileRel("claude-code", "custom/cc.yaml");
    expect(await resolveAgentProfileRel(dir, "claude-code")).toBe("custom/cc.yaml");
    expect(await resolveAgentProfilePath(dir, "claude-code")).toBe(
      join(dir, ".code-pact", "custom", "cc.yaml"),
    );
  });

  it("honors a custom profile even when an unrelated project.yaml field is invalid", async () => {
    await setProfileRel("claude-code", "custom/cc.yaml");
    // Corrupt an unrelated field (default_agent must be a PlanId). A full
    // Project.safeParse would reject the whole file, but the resolver reads
    // only the agent's own profile, so the custom path must still win.
    const p = join(dir, ".code-pact", "project.yaml");
    const text = await readFile(p, "utf8");
    const next = text.replace(/default_agent: .*/, 'default_agent: "not a valid id!!"');
    expect(next).not.toBe(text);
    await writeFile(p, next, "utf8");
    expect(await resolveAgentProfileRel(dir, "claude-code")).toBe("custom/cc.yaml");
  });

  it("rejects an unsafe agents[].profile with CONFIG_ERROR (no silent fallback)", async () => {
    await setProfileRel("claude-code", "../../etc/evil.yaml");
    // The project explicitly declared an invalid path; surfacing it beats
    // silently reading/writing the default file elsewhere.
    await expect(resolveAgentProfileRel(dir, "claude-code")).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  it("falls back to the convention when project.yaml has no matching agent", async () => {
    // codex is not enabled in this project; resolve must not throw.
    expect(await resolveAgentProfileRel(dir, "codex")).toBe(
      "agent-profiles/codex.yaml",
    );
  });

  it("falls back to the convention when project.yaml is absent/unreadable", async () => {
    await rm(join(dir, ".code-pact", "project.yaml"), { force: true });
    expect(await resolveAgentProfileRel(dir, "claude-code")).toBe(
      "agent-profiles/claude-code.yaml",
    );
  });

  it("rejects an unsafe agent name before it becomes a path segment", async () => {
    await expect(resolveAgentProfilePath(dir, "../evil")).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });
});

describe("adapter list honors a custom profile path", () => {
  it("reports the project.yaml agents[].profile path in profilePath", async () => {
    const { runAdapterList } = await import("../../../src/commands/adapter-list.ts");
    await setProfileRel("claude-code", "custom/cc.yaml");
    const result = await runAdapterList({ cwd: dir });
    const cc = result.agents.find((a) => a.name === "claude-code");
    expect(cc?.profilePath).toBe(join(dir, ".code-pact", "custom", "cc.yaml"));
  });

  it("fails with CONFIG_ERROR on an invalid matching agents[].profile (no silent fallback)", async () => {
    const { runAdapterList } = await import("../../../src/commands/adapter-list.ts");
    await setProfileRel("claude-code", "../../etc/evil.yaml");
    await expect(runAdapterList({ cwd: dir })).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });
});

describe("adapter generation honors a custom profile path end-to-end", () => {
  it("reads and pins model_version to the project's profile path, not the default", async () => {
    const { runGenerateAdapter } = await import("../../../src/commands/adapter.ts");

    // Move the profile to a non-default location and repoint project.yaml.
    await mkdir(join(dir, ".code-pact", "custom"), { recursive: true });
    const defaultPath = join(dir, ".code-pact", "agent-profiles", "claude-code.yaml");
    const customPath = join(dir, ".code-pact", "custom", "cc.yaml");
    await writeFile(customPath, await readFile(defaultPath, "utf8"), "utf8");
    await rm(defaultPath, { force: true });
    await setProfileRel("claude-code", "custom/cc.yaml");

    await runGenerateAdapter({
      cwd: dir,
      agentName: "claude-code",
      force: true,
      locale: "en-US",
      modelVersion: "opus-4.8",
    });

    // The model_version pin landed in the CUSTOM profile (resolver honored it).
    const custom = await readFile(customPath, "utf8");
    expect(custom).toContain("model_version: opus-4.8");
    // The default path stays gone — generation did not recreate/read it.
    await expect(readFile(defaultPath, "utf8")).rejects.toThrow();
    // And the model-aware guidance was generated from that profile.
    const claudeMd = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("Model guidance (opus-4.8)");
  });
});
