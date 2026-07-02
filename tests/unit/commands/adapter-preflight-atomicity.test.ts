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
    await Promise.all(
      paths.map(async path => [path, await readFile(join(dir, path), "utf8")]),
    ),
  );
}

describe("adapter strict placeholder preflight is mutation-atomic", () => {
  it.each(cases)(
    "install --model rejects an in-project %s symlink before pinning",
    async (_name, relPath, component) => {
      const profilePath = join(
        dir,
        ".code-pact",
        "agent-profiles",
        "claude-code.yaml",
      );
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
    },
  );

  it.each(cases)(
    "upgrade --write --model rejects an in-project %s symlink without partial mutation",
    async (_name, relPath, component) => {
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
    },
  );
});

// ---------------------------------------------------------------------------
// hook_dir is NOT pre-created: the placeholder mkdir was removed because
// hook_dir is RelativePosixPath.optional() (arbitrary project-relative path).
// The generated file write loop creates parent dirs via mkdir(dirname, recursive).
// This test verifies that a clean install still succeeds without a pre-created
// hook_dir — the hooks are written by the file loop, not by the placeholder.
// ---------------------------------------------------------------------------

describe("hook_dir is not pre-created but hook files are written via recursive mkdir", () => {
  it("install succeeds without pre-creating hook_dir — hooks land via write-loop mkdir", async () => {
    // Clean install — hook_dir (.claude/hooks) does not exist yet.
    expect(existsSync(join(dir, ".claude", "hooks"))).toBe(false);

    const result = await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "test",
    });

    // Install succeeds (exit 0 equivalent — no throw).
    expect(result.created.length).toBeGreaterThan(0);

    // The hook_dir was NOT pre-created as an empty directory by a placeholder
    // mkdir — it only exists if a hook file was actually written into it.
    // If the adapter generates hook files, the parent dir is created by the
    // write loop's mkdir(dirname(absPath), { recursive: true }).
    // If no hook files are generated, .claude/hooks should NOT exist.
    const hookFiles = result.files.filter(f =>
      f.relPath.startsWith(".claude/hooks/"),
    );
    if (hookFiles.length > 0) {
      // Hook files were generated → directory exists (created by write loop).
      expect(existsSync(join(dir, ".claude", "hooks"))).toBe(true);
    } else {
      // No hook files → directory was NOT pre-created.
      expect(existsSync(join(dir, ".claude", "hooks"))).toBe(false);
    }
  });
});
