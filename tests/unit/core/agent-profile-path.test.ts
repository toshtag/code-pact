import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInit } from "../../../src/commands/init.ts";
import {
  loadValidatedAdapterProfile,
  resolveAgentProfileRel,
  resolveAgentProfilePath,
} from "../../../src/core/agent-profile-path.ts";
import { adapterRegistry } from "../../../src/core/adapters/index.ts";

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

  it("honors a non-default agents[].profile inside the owned profile namespace", async () => {
    await setProfileRel("claude-code", "agent-profiles/custom/cc.yaml");
    expect(await resolveAgentProfileRel(dir, "claude-code")).toBe("agent-profiles/custom/cc.yaml");
    expect(await resolveAgentProfilePath(dir, "claude-code")).toBe(
      join(dir, ".code-pact", "agent-profiles", "custom", "cc.yaml"),
    );
  });

  it("honors a custom profile even when an unrelated project.yaml field is invalid", async () => {
    await setProfileRel("claude-code", "agent-profiles/custom/cc.yaml");
    // Corrupt an unrelated field (default_agent must be a PlanId). A full
    // Project.safeParse would reject the whole file, but the resolver reads
    // only the agent's own profile, so the custom path must still win.
    const p = join(dir, ".code-pact", "project.yaml");
    const text = await readFile(p, "utf8");
    const next = text.replace(/default_agent: .*/, 'default_agent: "not a valid id!!"');
    expect(next).not.toBe(text);
    await writeFile(p, next, "utf8");
    expect(await resolveAgentProfileRel(dir, "claude-code")).toBe("agent-profiles/custom/cc.yaml");
  });

  it("rejects agent profiles outside .code-pact/agent-profiles for reads", async () => {
    await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
    await writeFile(
      join(dir, ".code-pact", "state", "private-agent-profile.yaml"),
      await readFile(
        join(dir, ".code-pact", "agent-profiles", "claude-code.yaml"),
        "utf8",
      ),
      "utf8",
    );
    await setProfileRel("claude-code", "state/private-agent-profile.yaml");
    await expect(resolveAgentProfilePath(dir, "claude-code")).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  it("rejects an unsafe agents[].profile with CONFIG_ERROR (no silent fallback)", async () => {
    await setProfileRel("claude-code", "../../etc/evil.yaml");
    // The project explicitly declared an invalid path; surfacing it beats
    // silently reading/writing the default file elsewhere.
    await expect(resolveAgentProfileRel(dir, "claude-code")).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  it("rejects a present-but-unparseable project.yaml with CONFIG_ERROR (no fallback)", async () => {
    // Malformed YAML — present but broken. Falling back would mask it.
    await writeFile(join(dir, ".code-pact", "project.yaml"), "agents: {unclosed", "utf8");
    await expect(resolveAgentProfileRel(dir, "claude-code")).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  it("rejects project.yaml with a missing agents field (parses, but broken)", async () => {
    await writeFile(
      join(dir, ".code-pact", "project.yaml"),
      "name: demo\nversion: 0.1.0\nlocale: en-US\ndefault_agent: claude-code\n",
      "utf8",
    );
    await expect(resolveAgentProfileRel(dir, "claude-code")).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  it("rejects project.yaml with a non-array agents field", async () => {
    await writeFile(
      join(dir, ".code-pact", "project.yaml"),
      "name: demo\nversion: 0.1.0\nlocale: en-US\ndefault_agent: claude-code\nagents: nope\n",
      "utf8",
    );
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

  it("falls back to the convention when project.yaml is absent (ENOENT)", async () => {
    await rm(join(dir, ".code-pact", "project.yaml"), { force: true });
    expect(await resolveAgentProfileRel(dir, "claude-code")).toBe(
      "agent-profiles/claude-code.yaml",
    );
  });

  it("rejects a present-but-unreadable project.yaml with CONFIG_ERROR (EISDIR)", async () => {
    // Replace the file with a directory → readFile fails with EISDIR (not
    // ENOENT). Present-but-unreadable must surface, not fall back.
    const p = join(dir, ".code-pact", "project.yaml");
    await rm(p, { force: true });
    await mkdir(p);
    await expect(resolveAgentProfileRel(dir, "claude-code")).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  it("rejects an unsafe agent name before it becomes a path segment", async () => {
    await expect(resolveAgentProfilePath(dir, "../evil")).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  it("rejects a profile whose declared name does not match the requested agent", async () => {
    const profilePath = join(
      dir,
      ".code-pact",
      "agent-profiles",
      "claude-code.yaml",
    );
    const text = await readFile(profilePath, "utf8");
    await writeFile(
      profilePath,
      text.replace(/^name: claude-code$/m, "name: codex"),
      "utf8",
    );

    await expect(
      loadValidatedAdapterProfile(
        dir,
        "claude-code",
        adapterRegistry["claude-code"],
      ),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});

describe("adapter list honors a custom profile path", () => {
  it("reports the project.yaml agents[].profile path in profilePath", async () => {
    const { runAdapterList } = await import("../../../src/commands/adapter-list.ts");
    await setProfileRel("claude-code", "agent-profiles/custom/cc.yaml");
    const result = await runAdapterList({ cwd: dir });
    const cc = result.agents.find((a) => a.name === "claude-code");
    expect(cc?.profilePath).toBe(join(dir, ".code-pact", "agent-profiles", "custom", "cc.yaml"));
  });

  it("fails with CONFIG_ERROR on an invalid matching agents[].profile (no silent fallback)", async () => {
    const { runAdapterList } = await import("../../../src/commands/adapter-list.ts");
    await setProfileRel("claude-code", "../../etc/evil.yaml");
    await expect(runAdapterList({ cwd: dir })).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
  });
});

describe("resolver-using commands do not fall back on a broken project.yaml", () => {
  it("adapter install fails with CONFIG_ERROR on malformed project.yaml", async () => {
    const { runGenerateAdapter } = await import("../../../src/commands/adapter.ts");
    await writeFile(join(dir, ".code-pact", "project.yaml"), "agents: {unclosed", "utf8");
    await expect(
      runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: true, locale: "en-US" }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("adapter list fails with CONFIG_ERROR on a non-array agents field (no silent fallback)", async () => {
    const { runAdapterList } = await import("../../../src/commands/adapter.ts");
    await writeFile(
      join(dir, ".code-pact", "project.yaml"),
      "name: demo\nversion: 0.1.0\nlocale: en-US\ndefault_agent: claude-code\nagents: nope\n",
      "utf8",
    );
    await expect(runAdapterList({ cwd: dir })).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("adapter doctor surfaces an invalid agents[].profile as CONFIG_ERROR (not silent)", async () => {
    const { runGenerateAdapter, runAdapterDoctor } = await import("../../../src/commands/adapter.ts");
    // Install first so a manifest exists — otherwise inspectAgent returns at the
    // missing-manifest check before it ever loads the profile.
    await runGenerateAdapter({ cwd: dir, agentName: "claude-code", force: true, locale: "en-US" });
    await setProfileRel("claude-code", "../../etc/evil.yaml");
    await expect(
      runAdapterDoctor({ cwd: dir, agentName: "claude-code", locale: "en-US" }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("adapter doctor without --agent does not return a clean bill on a broken project.yaml", async () => {
    const { runAdapterDoctor } = await import("../../../src/commands/adapter.ts");
    await writeFile(join(dir, ".code-pact", "project.yaml"), "agents: {unclosed", "utf8");
    await expect(
      runAdapterDoctor({ cwd: dir, locale: "en-US" }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});

describe("adapter generation honors a custom profile path end-to-end", () => {
  it("reads and pins model_version to the project's profile path, not the default", async () => {
    const { runGenerateAdapter } = await import("../../../src/commands/adapter.ts");

    // Move the profile to a non-default but still writable location under
    // `.code-pact/agent-profiles/**` and repoint project.yaml.
    await mkdir(join(dir, ".code-pact", "agent-profiles", "custom"), { recursive: true });
    const defaultPath = join(dir, ".code-pact", "agent-profiles", "claude-code.yaml");
    const customPath = join(dir, ".code-pact", "agent-profiles", "custom", "cc.yaml");
    await writeFile(customPath, await readFile(defaultPath, "utf8"), "utf8");
    await rm(defaultPath, { force: true });
    await setProfileRel("claude-code", "agent-profiles/custom/cc.yaml");

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
