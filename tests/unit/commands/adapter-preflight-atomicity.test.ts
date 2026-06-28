import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runInit } from "../../../src/commands/init.ts";
import { runAdapterInstall } from "../../../src/commands/adapter-install.ts";
import { runAdapterUpgrade } from "../../../src/commands/adapter-upgrade.ts";
import { manifestPath } from "../../../src/core/adapters/manifest.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-preflight-atomicity-"));
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

const cases = [
  ["context_dir final", ".context/claude-code", "final"],
  ["context_dir parent", ".context/claude-code", "parent"],
  ["hook_dir final", ".claude/hooks", "final"],
  ["hook_dir parent", ".claude/hooks", "parent"],
] as const;

async function replaceWithInProjectSymlink(
  relPath: string,
  component: "final" | "parent",
): Promise<void> {
  const linkRel = component === "final" ? relPath : relPath.split("/")[0]!;
  const linkAbs = join(dir, linkRel);
  const targetAbs = join(
    dir,
    component === "final"
      ? `.symlink-target-${linkRel.replaceAll("/", "-")}`
      : `.symlink-target-${linkRel.slice(1)}`,
  );

  await mkdir(dirname(linkAbs), { recursive: true });
  if (existsSync(linkAbs)) {
    // Preserve an installed subtree so the command's failed run can be checked
    // for byte-identical generated files through the new alias.
    await rename(linkAbs, targetAbs);
  } else {
    await mkdir(targetAbs, { recursive: true });
  }
  await symlink(targetAbs, linkAbs, "dir");
}

async function snapshotInstalledFiles(): Promise<Record<string, string>> {
  const paths = [
    ".code-pact/agent-profiles/claude-code.yaml",
    ".code-pact/adapters/claude-code.manifest.yaml",
    "CLAUDE.md",
    ".claude/skills/context.md",
    ".claude/skills/verify.md",
    ".claude/skills/progress.md",
  ];
  return Object.fromEntries(
    await Promise.all(paths.map(async (path) => [path, await readFile(join(dir, path), "utf8")])),
  );
}

describe("adapter strict placeholder preflight is mutation-atomic", () => {
  it.each(cases)("install --model rejects an in-project %s symlink before pinning", async (_name, relPath, component) => {
    const profilePath = join(dir, ".code-pact", "agent-profiles", "claude-code.yaml");
    const profileBefore = await readFile(profilePath, "utf8");
    await replaceWithInProjectSymlink(relPath, component);

    await expect(
      runAdapterInstall({
        cwd: dir,
        agentName: "claude-code",
        force: false,
        locale: "en-US",
        modelVersion: "sonnet-4.6",
        generatorVersionOverride: "test",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });

    expect(await readFile(profilePath, "utf8")).toBe(profileBefore);
    expect(existsSync(manifestPath(dir, "claude-code"))).toBe(false);
  });

  it.each(cases)("upgrade --write --model rejects an in-project %s symlink without partial mutation", async (_name, relPath, component) => {
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "test",
    });
    await replaceWithInProjectSymlink(relPath, component);
    const before = await snapshotInstalledFiles();

    await expect(
      runAdapterUpgrade({
        cwd: dir,
        agentName: "claude-code",
        mode: "write",
        force: false,
        acceptModified: false,
        locale: "en-US",
        modelVersion: "sonnet-4.6",
        generatorVersionOverride: "test",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });

    expect(await snapshotInstalledFiles()).toEqual(before);
  });
});
