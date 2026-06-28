import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInitCore } from "../../../src/commands/init.ts";
import { runAdapterInstall } from "../../../src/commands/adapter-install.ts";
import { runAdapterUpgrade } from "../../../src/commands/adapter-upgrade.ts";
import {
  computeContentHash,
  writeManifest,
} from "../../../src/core/adapters/manifest.ts";

const { readFileSpy } = vi.hoisted(() => ({ readFileSpy: vi.fn() }));

vi.mock("node:fs/promises", async importActual => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      readFileSpy(String(args[0]));
      return actual.readFile(...args);
    },
  };
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-mutation-authority-"));
  await runInitCore({
    cwd: dir,
    locale: "en-US",
    agents: ["claude-code"],
    force: false,
    json: false,
    createSamplePhase: true,
    verifyCommand: "deploy",
  });
  readFileSpy.mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function targetReads(...targets: string[]): string[] {
  const wanted = new Set(targets);
  return readFileSpy.mock.calls
    .map(([path]) => String(path))
    .filter(path => wanted.has(path));
}

async function forgeManifest(
  files: Array<{
    path: string;
    sha256: string;
    role: "instruction" | "skill" | "hook" | "rule";
  }>,
): Promise<void> {
  await writeManifest(dir, "claude-code", {
    schema_version: 1,
    agent_name: "claude-code",
    generator_version: "0.0.0",
    adapter_schema_version: 1,
    generated_at: "2026-01-01T00:00:00.000Z",
    profile_fingerprint: {
      instruction_filename: "CLAUDE.md",
      context_dir: ".context/claude-code",
    },
    files: files.map(file => ({ ...file, managed: true })),
  });
}

describe("adapter install/upgrade read authority", () => {
  it("never reads a profile-redirected .env and gives the same refusal for matching and mismatching hashes", async () => {
    const target = join(dir, ".env");
    const content = "API_TOKEN=low-entropy-secret\n";
    await writeFile(target, content, "utf8");
    const profilePath = join(
      dir,
      ".code-pact",
      "agent-profiles",
      "claude-code.yaml",
    );
    await writeFile(
      profilePath,
      (await readFile(profilePath, "utf8")).replace(
        "instruction_filename: CLAUDE.md",
        "instruction_filename: .env",
      ),
      "utf8",
    );

    const installRows: unknown[] = [];
    const upgradeRows: unknown[] = [];
    for (const sha256 of [computeContentHash(content), "0".repeat(64)]) {
      await forgeManifest([{ path: ".env", sha256, role: "instruction" }]);

      readFileSpy.mockClear();
      const install = await runAdapterInstall({
        cwd: dir,
        agentName: "claude-code",
        force: false,
        locale: "en-US",
        generatorVersionOverride: "test",
      });
      installRows.push(install.files.find(f => f.relPath === ".env"));
      expect(targetReads(target)).toEqual([]);

      for (const mode of ["check", "write"] as const) {
        readFileSpy.mockClear();
        const upgrade = await runAdapterUpgrade({
          cwd: dir,
          agentName: "claude-code",
          mode,
          force: false,
          acceptModified: false,
          locale: "en-US",
          generatorVersionOverride: "test",
        });
        upgradeRows.push(upgrade.plan.find(f => f.relPath === ".env"));
        expect(targetReads(target)).toEqual([]);
      }
    }

    expect(installRows[0]).toEqual(installRows[1]);
    expect(installRows[0]).toMatchObject({
      action: "refuse",
      reason: "unowned_generated_path",
    });
    expect(upgradeRows[0]).toEqual(upgradeRows[2]);
    expect(upgradeRows[1]).toEqual(upgradeRows[3]);
    expect(upgradeRows[0]).toMatchObject({
      local: "unverifiable",
      action: "refuse",
      reason: "unowned_generated_path",
    });
  });

  it("never reads an existing dynamic skill and ignores a forged manifest hash", async () => {
    const relPath = ".claude/skills/deploy.md";
    const target = join(dir, relPath);
    const content = "# hand-authored deploy notes\n";
    await mkdir(join(dir, ".claude", "skills"), { recursive: true });
    await writeFile(target, content, "utf8");

    const rows: unknown[] = [];
    for (const sha256 of [computeContentHash(content), "f".repeat(64)]) {
      await forgeManifest([{ path: relPath, sha256, role: "skill" }]);
      readFileSpy.mockClear();
      const result = await runAdapterUpgrade({
        cwd: dir,
        agentName: "claude-code",
        mode: "check",
        force: false,
        acceptModified: false,
        locale: "en-US",
      });
      rows.push(result.plan.find(f => f.relPath === relPath));
      expect(targetReads(target)).toEqual([]);
    }
    expect(rows[0]).toEqual(rows[1]);
    expect(rows[0]).toMatchObject({
      local: "unverifiable",
      desired: "unverifiable",
      action: "warn",
      reason: "dynamic_file_unverifiable",
    });
  });

  it("rejects an owned-looking symlink before reading its target, independent of hash", async () => {
    const lexical = join(dir, "CLAUDE.md");
    const target = join(dir, "real-claude.md");
    const content = "# private target\n";
    await writeFile(target, content, "utf8");
    await symlink("real-claude.md", lexical);

    const rows: unknown[] = [];
    for (const sha256 of [computeContentHash(content), "a".repeat(64)]) {
      await forgeManifest([{ path: "CLAUDE.md", sha256, role: "instruction" }]);
      readFileSpy.mockClear();
      const result = await runAdapterUpgrade({
        cwd: dir,
        agentName: "claude-code",
        mode: "check",
        force: false,
        acceptModified: false,
        locale: "en-US",
      });
      rows.push(result.plan.find(f => f.relPath === "CLAUDE.md"));
      expect(targetReads(lexical, target)).toEqual([]);
    }
    expect(rows[0]).toEqual(rows[1]);
    expect(rows[0]).toMatchObject({
      local: "unverifiable",
      action: "refuse",
      reason: "symlink_traversal",
    });
  });

  it("does not stat-classify or read an unowned orphan in check or write mode", async () => {
    const relPath = "src/private.ts";
    const target = join(dir, relPath);
    await mkdir(join(dir, "src"), { recursive: true });
    const content = "export const privateValue = 1;\n";

    const rows: unknown[] = [];
    for (const mode of ["check", "write"] as const) {
      for (const state of ["matching", "mismatching", "missing"] as const) {
        if (state === "missing") {
          await rm(target, { force: true });
        } else {
          await writeFile(target, content, "utf8");
        }
        await forgeManifest([
          {
            path: relPath,
            sha256:
              state === "matching"
                ? computeContentHash(content)
                : "b".repeat(64),
            role: "instruction",
          },
        ]);
        readFileSpy.mockClear();
        const result = await runAdapterUpgrade({
          cwd: dir,
          agentName: "claude-code",
          mode,
          force: false,
          acceptModified: false,
          locale: "en-US",
          generatorVersionOverride: "test",
        });
        rows.push(result.plan.find(f => f.relPath === relPath));
        expect(targetReads(target)).toEqual([]);
      }
    }

    for (const row of rows) {
      expect(row).toEqual(rows[0]);
      expect(row).toMatchObject({
        local: "unverifiable",
        action: "warn",
        reason: "unowned_orphan_not_pruned",
      });
    }
  });
});
