import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInit } from "../../../src/commands/init.ts";
import { runAdapterInstall } from "../../../src/commands/adapter-install.ts";
import { runAdapterUpgrade } from "../../../src/commands/adapter-upgrade.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-fs-proof-"));
  await runInit({
    cwd: dir,
    locale: "en-US",
    agents: ["claude-code"],
    force: false,
    json: false,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function snapshotDir(target: string): Promise<string | null> {
  try {
    return await readFile(join(target, "CANARY"), "utf8");
  } catch {
    return null;
  }
}

async function makeSymlinkDir(
  linkRel: string,
  canaryContent: string,
): Promise<void> {
  const linkAbs = join(dir, linkRel);
  const targetAbs = join(
    dir,
    `.symlink-target-${linkRel.replaceAll("/", "-")}`,
  );
  await mkdir(targetAbs, { recursive: true });
  await writeFile(join(targetAbs, "CANARY"), canaryContent, "utf8");
  if (existsSync(linkAbs)) {
    await rm(linkAbs, { recursive: true, force: true });
  }
  await mkdir(join(dir, linkRel.split("/").slice(0, -1).join("/")), {
    recursive: true,
  });
  await symlink(targetAbs, linkAbs, "dir");
}

describe("adapter install fs operation proof — no unauthorized path touched", () => {
  it("install does not read, write, or delete through a symlinked .claude/skills", async () => {
    // Install first to create the real .claude/skills
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "test",
    });

    // Save original skill content for reference
    await readFile(join(dir, ".claude/skills/context.md"), "utf8");

    // Replace .claude/skills with a symlink to a canary directory
    await rm(join(dir, ".claude/skills"), { recursive: true, force: true });
    await makeSymlinkDir(".claude/skills", "attacker-canary");

    // Re-install — must refuse the symlinked skill paths, not write through them.
    // The install does not throw (other files like CLAUDE.md still proceed),
    // but the symlinked skills are refused with symlink_traversal reason.
    const result = await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "test",
    });

    // Every skill file must be refused for symlink_traversal
    const skillResults = result.files.filter(f => f.role === "skill");
    expect(skillResults.length).toBeGreaterThan(0);
    for (const f of skillResults) {
      expect(f.action).toBe("refuse");
      expect(f.reason).toBe("symlink_traversal");
    }

    // The symlink target's CANARY must be untouched — no write went through the symlink
    const canary = await snapshotDir(
      join(dir, ".symlink-target-.claude-skills"),
    );
    expect(canary).toBe("attacker-canary");
  });

  it("upgrade does not prune through a symlinked owned orphan path", async () => {
    // Install to create the initial adapter state
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "test",
    });

    // Create a symlinked directory that looks like an owned path
    // .claude/skills is owned by the adapter; if we symlink it, prune must refuse
    const skillsDir = join(dir, ".claude/skills");
    // Read original skill content for reference
    await readFile(join(skillsDir, "context.md"), "utf8");

    // Replace with symlink
    await rm(skillsDir, { recursive: true, force: true });
    await makeSymlinkDir(".claude/skills", "prune-canary");

    // Upgrade --write must refuse the symlinked paths, not delete through them.
    // The upgrade does not throw (it returns a plan with refused entries),
    // but the symlinked skills are refused with symlink_traversal reason.
    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "write",
      force: false,
      acceptModified: false,
      locale: "en-US",
      generatorVersionOverride: "test",
    });

    // Every skill file must be refused for symlink_traversal
    const skillPlan = result.plan.filter(p => p.role === "skill");
    expect(skillPlan.length).toBeGreaterThan(0);
    for (const p of skillPlan) {
      expect(p.action).toBe("refuse");
      expect(p.reason).toBe("symlink_traversal");
    }

    // The symlink target must still exist with CANARY intact — no delete went through
    const canary = await snapshotDir(
      join(dir, ".symlink-target-.claude-skills"),
    );
    expect(canary).toBe("prune-canary");
  });

  it("install does not write context files through a symlinked .context", async () => {
    // Replace .context with a symlink before install
    await rm(join(dir, ".context"), { recursive: true, force: true });
    await makeSymlinkDir(".context/claude-code", "context-canary");

    // Install must catch the symlink before writing
    await expect(
      runAdapterInstall({
        cwd: dir,
        agentName: "claude-code",
        force: false,
        locale: "en-US",
        generatorVersionOverride: "test",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });

    // Canary must be untouched
    const canary = await snapshotDir(
      join(dir, ".symlink-target-.context-claude-code"),
    );
    expect(canary).toBe("context-canary");
  });

  it("install does not write the manifest through a symlinked .code-pact/adapters", async () => {
    // Install first to create the real manifest
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "test",
    });

    // Replace .code-pact/adapters with a symlink
    const adaptersDir = join(dir, ".code-pact/adapters");
    const targetAbs = join(dir, ".symlink-target-adapters");
    await mkdir(targetAbs, { recursive: true });
    await writeFile(join(targetAbs, "CANARY"), "manifest-canary", "utf8");
    await rm(adaptersDir, { recursive: true, force: true });
    await symlink(targetAbs, adaptersDir, "dir");

    // Re-install must refuse the symlinked manifest path.
    // readManifest throws ADAPTER_MANIFEST_INVALID (the symlinked adapters dir
    // resolves outside the project, so the manifest read fails closed).
    await expect(
      runAdapterInstall({
        cwd: dir,
        agentName: "claude-code",
        force: false,
        locale: "en-US",
        generatorVersionOverride: "test",
      }),
    ).rejects.toMatchObject({
      code: "ADAPTER_MANIFEST_INVALID",
    });

    // Canary must be untouched
    const canary = await snapshotDir(join(dir, ".symlink-target-adapters"));
    expect(canary).toBe("manifest-canary");
  });

  it("install does not create hook_dir through a symlink", async () => {
    // Create a symlinked hook_dir (.claude/hooks)
    await makeSymlinkDir(".claude/hooks", "hook-canary");

    // Install must catch the symlinked hook_dir before model pin
    await expect(
      runAdapterInstall({
        cwd: dir,
        agentName: "claude-code",
        force: false,
        locale: "en-US",
        generatorVersionOverride: "test",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });

    // Canary must be untouched
    const canary = await snapshotDir(
      join(dir, ".symlink-target-.claude-hooks"),
    );
    expect(canary).toBe("hook-canary");
  });

  it("upgrade does not write context files through a symlinked .context after install", async () => {
    // Install first
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "test",
    });

    // Replace .context/claude-code with a symlink
    await rm(join(dir, ".context/claude-code"), {
      recursive: true,
      force: true,
    });
    await makeSymlinkDir(".context/claude-code", "upgrade-context-canary");

    // Upgrade --write must catch the symlink
    await expect(
      runAdapterUpgrade({
        cwd: dir,
        agentName: "claude-code",
        mode: "write",
        force: false,
        acceptModified: false,
        locale: "en-US",
        generatorVersionOverride: "test",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });

    // Canary must be untouched
    const canary = await snapshotDir(
      join(dir, ".symlink-target-.context-claude-code"),
    );
    expect(canary).toBe("upgrade-context-canary");
  });
});
