import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runInit } from "../../../src/commands/init.ts";
import { runAdapterInstall } from "../../../src/commands/adapter-install.ts";
import { runAdapterUpgrade } from "../../../src/commands/adapter-upgrade.ts";
import {
  computeContentHash,
  readManifest,
  writeManifest,
  manifestPath,
} from "../../../src/core/adapters/manifest.ts";
import type { AdapterManifest } from "../../../src/core/schemas/adapter-manifest.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-adapter-upgrade-test-"));
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

async function freshInstall(): Promise<void> {
  await runAdapterInstall({
    cwd: dir,
    agentName: "claude-code",
    force: false,
    locale: "en-US",
    generatorVersionOverride: "0.9.0-alpha.0",
  });
}

async function readManifestMut(): Promise<AdapterManifest> {
  const m = await readManifest(dir, "claude-code");
  if (m === null) throw new Error("manifest expected");
  return m;
}

// ---------------------------------------------------------------------------
// Manifest preconditions
// ---------------------------------------------------------------------------

describe("adapter upgrade — preconditions", () => {
  it("throws MANIFEST_NOT_FOUND when no manifest exists (--check)", async () => {
    await expect(
      runAdapterUpgrade({
        cwd: dir,
        agentName: "claude-code",
        mode: "check",
        force: false,
        acceptModified: false,
        locale: "en-US",
      }),
    ).rejects.toMatchObject({ code: "MANIFEST_NOT_FOUND" });
  });

  it("throws MANIFEST_NOT_FOUND when no manifest exists (--write)", async () => {
    await expect(
      runAdapterUpgrade({
        cwd: dir,
        agentName: "claude-code",
        mode: "write",
        force: false,
        acceptModified: false,
        locale: "en-US",
      }),
    ).rejects.toMatchObject({ code: "MANIFEST_NOT_FOUND" });
  });

  it("throws AGENT_NOT_FOUND for unknown agent name", async () => {
    await expect(
      runAdapterUpgrade({
        cwd: dir,
        agentName: "no-such-agent",
        mode: "check",
        force: false,
        acceptModified: false,
        locale: "en-US",
      }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// Idempotent / clean state
// ---------------------------------------------------------------------------

describe("adapter upgrade — clean state", () => {
  beforeEach(async () => {
    await freshInstall();
  });

  it("--check on fresh install reports clean: true with every action: skip", async () => {
    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "check",
      force: false,
      acceptModified: false,
      locale: "en-US",
    });
    expect(result.clean).toBe(true);
    expect(result.plan.every((p) => p.action === "skip")).toBe(true);
  });

  it("--write on fresh install is a no-op (manifest hashes unchanged)", async () => {
    const before = await readManifestMut();
    const beforeHashes = before.files.map((f) => f.sha256);

    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "write",
      force: false,
      acceptModified: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    expect(result.clean).toBe(true);

    const after = await readManifestMut();
    const afterHashes = after.files.map((f) => f.sha256);
    expect(afterHashes).toEqual(beforeHashes);
  });
});

// ---------------------------------------------------------------------------
// managed-clean × stale (safe update, no --accept-modified)
// ---------------------------------------------------------------------------

describe("adapter upgrade — managed-clean × stale", () => {
  beforeEach(async () => {
    await freshInstall();
    // Simulate "generator output moved on" by setting the manifest hash for
    // CLAUDE.md to match a different content than what's on disk and what
    // the generator now produces. Easiest: leave disk and generator the same
    // (the real-world case is generator moved on), and falsify the manifest
    // hash so it doesn't match disk. But that yields managed-modified, not
    // managed-clean. So instead, we both rewrite disk AND the manifest hash
    // to the SAME sentinel value; manifest==disk so managed-clean, while
    // generator output remains different → desired-stale.
    const m = await readManifestMut();
    const file = m.files.find((f) => f.path === "CLAUDE.md")!;
    const sentinel = "SENTINEL CONTENT — generator moved on after install\n";
    await writeFile(join(dir, "CLAUDE.md"), sentinel, "utf8");
    file.sha256 = computeContentHash(sentinel);
    await writeManifest(dir, "claude-code", m);
  });

  it("--check reports action: update, clean: false", async () => {
    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "check",
      force: false,
      acceptModified: false,
      locale: "en-US",
    });
    expect(result.clean).toBe(false);
    const claude = result.plan.find((p) => p.relPath === "CLAUDE.md")!;
    expect(claude.local).toBe("managed-clean");
    expect(claude.desired).toBe("stale");
    expect(claude.action).toBe("update");
  });

  it("--write applies the update WITHOUT --accept-modified", async () => {
    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "write",
      force: false,
      acceptModified: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    const claude = result.plan.find((p) => p.relPath === "CLAUDE.md")!;
    expect(claude.action).toBe("update");

    // Disk content is now the desired (regenerated) content, not the sentinel.
    const after = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(after).not.toContain("SENTINEL CONTENT");
    expect(after).toContain("Claude Code");

    // Manifest hash refreshed to the new desired hash.
    const m = await readManifestMut();
    expect(m.files.find((f) => f.path === "CLAUDE.md")!.sha256).toBe(
      computeContentHash(after),
    );
  });
});

// ---------------------------------------------------------------------------
// managed-modified × current (manifest-only update)
// ---------------------------------------------------------------------------

describe("adapter upgrade — managed-modified × current", () => {
  beforeEach(async () => {
    await freshInstall();
    // Corrupt the manifest hash but leave disk and generator in sync.
    const m = await readManifestMut();
    m.files.find((f) => f.path === "CLAUDE.md")!.sha256 = "0".repeat(64);
    await writeManifest(dir, "claude-code", m);
  });

  it("--check reports action: update_manifest (manifest hash drift only)", async () => {
    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "check",
      force: false,
      acceptModified: false,
      locale: "en-US",
    });
    expect(result.clean).toBe(false);
    const claude = result.plan.find((p) => p.relPath === "CLAUDE.md")!;
    expect(claude.local).toBe("managed-modified");
    expect(claude.desired).toBe("current");
    expect(claude.action).toBe("update_manifest");
  });

  it("--write refreshes ONLY the manifest hash (no --accept-modified needed)", async () => {
    const diskBefore = await readFile(join(dir, "CLAUDE.md"), "utf8");
    await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "write",
      force: false,
      acceptModified: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    const diskAfter = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(diskAfter).toBe(diskBefore); // content untouched

    const m = await readManifestMut();
    // Manifest hash now matches current disk hash.
    expect(m.files.find((f) => f.path === "CLAUDE.md")!.sha256).toBe(
      computeContentHash(diskAfter),
    );
  });
});

// ---------------------------------------------------------------------------
// managed-modified × stale (refuse semantics, --accept-modified to overwrite)
// ---------------------------------------------------------------------------

describe("adapter upgrade — managed-modified × stale", () => {
  beforeEach(async () => {
    await freshInstall();
    // User edits CLAUDE.md → diskHash != manifestHash (managed-modified)
    // AND disk content != current desired (stale).
    await writeFile(join(dir, "CLAUDE.md"), "USER LOCAL MODS\n", "utf8");
  });

  it("--check reports action: refuse (regardless of --accept-modified)", async () => {
    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "check",
      force: false,
      acceptModified: true, // even with the flag, check still reports refuse
      locale: "en-US",
    });
    const claude = result.plan.find((p) => p.relPath === "CLAUDE.md")!;
    expect(claude.local).toBe("managed-modified");
    expect(claude.desired).toBe("stale");
    expect(claude.action).toBe("refuse");
    expect(result.clean).toBe(false);
  });

  it("--write WITHOUT --accept-modified refuses; file and manifest preserved", async () => {
    const diskBefore = await readFile(join(dir, "CLAUDE.md"), "utf8");
    const manifestBefore = await readManifestMut();
    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "write",
      force: false,
      acceptModified: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    const claude = result.plan.find((p) => p.relPath === "CLAUDE.md")!;
    expect(claude.action).toBe("refuse");

    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(diskBefore);
    const manifestAfter = await readManifestMut();
    expect(manifestAfter.files.find((f) => f.path === "CLAUDE.md")!.sha256).toBe(
      manifestBefore.files.find((f) => f.path === "CLAUDE.md")!.sha256,
    );
  });

  it("--write WITH --accept-modified overwrites the user's edits and refreshes manifest", async () => {
    await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "write",
      force: false,
      acceptModified: true,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    const after = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(after).not.toBe("USER LOCAL MODS\n");
    expect(after).toContain("Claude Code");

    const m = await readManifestMut();
    expect(m.files.find((f) => f.path === "CLAUDE.md")!.sha256).toBe(
      computeContentHash(after),
    );
  });

  it("--write --force does NOT override managed-modified (safety invariant)", async () => {
    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "write",
      force: true, // --force is unmanaged-only — must NOT bypass managed-modified protection
      acceptModified: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    const claude = result.plan.find((p) => p.relPath === "CLAUDE.md")!;
    expect(claude.action).toBe("refuse"); // not update / replace_unmanaged
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe("USER LOCAL MODS\n");
  });
});

// ---------------------------------------------------------------------------
// managed-missing
// ---------------------------------------------------------------------------

describe("adapter upgrade — managed-missing", () => {
  beforeEach(async () => {
    await freshInstall();
    await unlink(join(dir, "CLAUDE.md"));
  });

  it("--check reports action: write", async () => {
    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "check",
      force: false,
      acceptModified: false,
      locale: "en-US",
    });
    const claude = result.plan.find((p) => p.relPath === "CLAUDE.md")!;
    expect(claude.local).toBe("managed-missing");
    expect(claude.action).toBe("write");
    expect(result.clean).toBe(false);
  });

  it("--write recreates the file and keeps the manifest hash consistent", async () => {
    await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "write",
      force: false,
      acceptModified: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    const after = await readFile(join(dir, "CLAUDE.md"), "utf8");
    const m = await readManifestMut();
    expect(m.files.find((f) => f.path === "CLAUDE.md")!.sha256).toBe(
      computeContentHash(after),
    );
  });
});

// ---------------------------------------------------------------------------
// unmanaged (--force unmanaged-only invariant)
// ---------------------------------------------------------------------------

describe("adapter upgrade — unmanaged files", () => {
  beforeEach(async () => {
    await freshInstall();
    // Simulate an unmanaged file: drop CLAUDE.md from the manifest while
    // leaving the file on disk. Now disk hash exists, manifest hash is null.
    const m = await readManifestMut();
    m.files = m.files.filter((f) => f.path !== "CLAUDE.md");
    await writeManifest(dir, "claude-code", m);
  });

  it("--check reports action: warn (regardless of --force)", async () => {
    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "check",
      force: true,
      acceptModified: false,
      locale: "en-US",
    });
    const claude = result.plan.find((p) => p.relPath === "CLAUDE.md")!;
    expect(claude.local).toBe("unmanaged");
    expect(claude.action).toBe("warn");
    expect(result.clean).toBe(false);
  });

  it("--write without --force skips unmanaged × current", async () => {
    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "write",
      force: false,
      acceptModified: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    const claude = result.plan.find((p) => p.relPath === "CLAUDE.md")!;
    expect(claude.action).toBe("skip");
    // Manifest still does not list CLAUDE.md (we didn't adopt it).
    const m = await readManifestMut();
    expect(m.files.find((f) => f.path === "CLAUDE.md")).toBeUndefined();
  });

  it("--write --force adopts unmanaged × current (manifest only, no content write)", async () => {
    const before = await readFile(join(dir, "CLAUDE.md"), "utf8");
    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "write",
      force: true,
      acceptModified: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    const claude = result.plan.find((p) => p.relPath === "CLAUDE.md")!;
    expect(claude.action).toBe("adopt");
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(before); // untouched

    const m = await readManifestMut();
    expect(m.files.find((f) => f.path === "CLAUDE.md")!.sha256).toBe(
      computeContentHash(before),
    );
  });

  it("--write --force replace_unmanaged when content differs from desired", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "STALE UNMANAGED CONTENT\n", "utf8");
    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "write",
      force: true,
      acceptModified: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    const claude = result.plan.find((p) => p.relPath === "CLAUDE.md")!;
    expect(claude.action).toBe("replace_unmanaged");
    const after = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(after).not.toBe("STALE UNMANAGED CONTENT\n");
    expect(after).toContain("Claude Code");
  });
});

// ---------------------------------------------------------------------------
// --regen-skills (role-scoped force)
// ---------------------------------------------------------------------------

describe("adapter upgrade — --regen-skills role scoping", () => {
  beforeEach(async () => {
    await freshInstall();
  });

  it("scopes --force-equivalent to skill role only on upgrade --write", async () => {
    // Drop an instruction-role AND a skill-role entry from the manifest so
    // both files become unmanaged. --regen-skills should adopt the skill
    // file but NOT the instruction file.
    const m = await readMutableManifest(dir, "claude-code");
    m.files = m.files.filter(
      (f) => f.path !== "CLAUDE.md" && f.path !== ".claude/skills/context.md",
    );
    await writeManifest(dir, "claude-code", m);

    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "write",
      force: false,
      acceptModified: false,
      regenSkills: true,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });

    const claude = result.plan.find((p) => p.relPath === "CLAUDE.md")!;
    const skill = result.plan.find((p) => p.relPath === ".claude/skills/context.md")!;

    expect(claude.action).toBe("skip"); // instruction not affected by --regen-skills
    expect(skill.action).toBe("adopt"); // skill adopted via role-scoped force
  });

  it("--regen-skills still respects the managed-modified protection", async () => {
    // User-modify the skill file.
    await writeFile(
      join(dir, ".claude/skills/context.md"),
      "USER MOD\n",
      "utf8",
    );
    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "write",
      force: false,
      acceptModified: false,
      regenSkills: true,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    const skill = result.plan.find((p) => p.relPath === ".claude/skills/context.md")!;
    expect(skill.action).toBe("refuse"); // --regen-skills cannot override managed-modified
    expect(await readFile(join(dir, ".claude/skills/context.md"), "utf8")).toBe(
      "USER MOD\n",
    );
  });
});

// ---------------------------------------------------------------------------
// new (file added to desired since last install)
// ---------------------------------------------------------------------------

describe("adapter upgrade — new desired file", () => {
  beforeEach(async () => {
    await freshInstall();
    // Simulate "generator now emits a file that wasn't there at install" by
    // dropping a manifest entry AND deleting the corresponding disk file.
    // Then on upgrade, the file is `new` (no manifest, no disk) → write.
    const m = await readManifestMut();
    const skillPath = ".claude/skills/context.md";
    m.files = m.files.filter((f) => f.path !== skillPath);
    await writeManifest(dir, "claude-code", m);
    await unlink(join(dir, skillPath));
  });

  it("--check reports action: write for new files", async () => {
    const result = await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "check",
      force: false,
      acceptModified: false,
      locale: "en-US",
    });
    const ctx = result.plan.find((p) => p.relPath === ".claude/skills/context.md")!;
    expect(ctx.local).toBe("new");
    expect(ctx.action).toBe("write");
  });

  it("--write creates the new file and adds the manifest entry", async () => {
    await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "write",
      force: false,
      acceptModified: false,
      locale: "en-US",
      generatorVersionOverride: "0.9.0-alpha.0",
    });
    expect(existsSync(join(dir, ".claude/skills/context.md"))).toBe(true);
    const m = await readManifestMut();
    expect(m.files.find((f) => f.path === ".claude/skills/context.md")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Side-effect verification
// ---------------------------------------------------------------------------

describe("adapter upgrade — --check is fully read-only", () => {
  beforeEach(async () => {
    await freshInstall();
    // Set up a drift state so the plan has non-skip actions.
    await writeFile(join(dir, "CLAUDE.md"), "USER MOD\n", "utf8");
  });

  it("--check does not modify the manifest or any file", async () => {
    const beforeManifest = await readFile(manifestPath(dir, "claude-code"), "utf8");
    const beforeFile = await readFile(join(dir, "CLAUDE.md"), "utf8");
    await runAdapterUpgrade({
      cwd: dir,
      agentName: "claude-code",
      mode: "check",
      force: true,
      acceptModified: true,
      locale: "en-US",
    });
    expect(await readFile(manifestPath(dir, "claude-code"), "utf8")).toBe(
      beforeManifest,
    );
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(beforeFile);
  });
});

// Helper used above — placed at the end for legibility.
async function readMutableManifest(
  cwd: string,
  agent: string,
): Promise<AdapterManifest> {
  const m = await readManifest(cwd, agent);
  if (m === null) throw new Error("manifest expected");
  return m;
}
