import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, mkdir, readFile, writeFile, cp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildContextPack,
  writeContextPack,
} from "../../../src/core/pack/index.ts";

const fixtureDir = new URL("../../../tests/fixtures/project-a", import.meta.url).pathname;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("buildContextPack — purity", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "code-pact-pack-core-"));
    // Copy the project-a fixture into a temp dir so we can assert that
    // buildContextPack does NOT create .context/ on its own. The fixture
    // may have a stale .context/ from previous runs (gitignored but
    // present on disk), so wipe it after the copy.
    await cp(fixtureDir, workDir, { recursive: true });
    await rm(join(workDir, ".context"), { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("returns markdown content with task and phase ids", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(pack.taskId).toBe("P2-E1-T1");
    expect(pack.phaseId).toBe("P2");
    expect(pack.agent).toBe("claude-code");
    expect(pack.charCount).toBeGreaterThan(0);
    expect(pack.content).toContain("P2-E1-T1");
  });

  it("does NOT create .context/ directory as a side effect", async () => {
    const contextBefore = await exists(join(workDir, ".context"));
    expect(contextBefore).toBe(false);

    await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });

    const contextAfter = await exists(join(workDir, ".context"));
    expect(contextAfter).toBe(false);
  });

  it("throws PHASE_NOT_FOUND when phase id is missing", async () => {
    await expect(
      buildContextPack({
        cwd: workDir,
        phaseId: "P99",
        taskId: "P99-T1",
        agentName: "claude-code",
      }),
    ).rejects.toMatchObject({ code: "PHASE_NOT_FOUND" });
  });

  it("throws TASK_NOT_FOUND when task id is missing in phase", async () => {
    await expect(
      buildContextPack({
        cwd: workDir,
        phaseId: "P2",
        taskId: "P2-NONEXISTENT",
        agentName: "claude-code",
      }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});

describe("writeContextPack — side effects", () => {
  let workDir: string;
  let outDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "code-pact-pack-write-"));
    outDir = await mkdtemp(join(tmpdir(), "code-pact-pack-out-"));
    await cp(fixtureDir, workDir, { recursive: true });
    await rm(join(workDir, ".context"), { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  it("writes the pack content to outputDir/<taskId>.md", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const result = await writeContextPack(pack, {
      cwd: workDir,
      agentName: "claude-code",
      outputDir: outDir,
    });
    expect(result.outputPath.endsWith("P2-E1-T1.md")).toBe(true);
    const onDisk = await readFile(result.outputPath, "utf8");
    expect(onDisk).toBe(pack.content);
  });

  it("falls back to .context/<agentName> when no profile and no outputDir", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "unconfigured-agent",
    });
    const result = await writeContextPack(pack, {
      cwd: workDir,
      agentName: "unconfigured-agent",
    });
    expect(result.outputPath).toContain(join(".context", "unconfigured-agent"));
  });

  it("writes atomically: creates a missing nested dir and leaves no temp file", async () => {
    // The fallback context_dir does not exist yet under workDir. This proves
    // the atomic write path recreates the parent dir on its own (no separate
    // mkdir(outDir) in writeContextPack) AND leaves no `.tmp-*` artifact from
    // the temp-file + rename — the cli-contract.md atomic-write guarantee.
    // `unconfigured-agent` has no profile, so the dir falls back to
    // `.context/<agentName>`, which does not exist under the fresh workDir.
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "unconfigured-agent",
    });
    const contextDir = join(workDir, ".context", "unconfigured-agent");
    expect(await exists(contextDir)).toBe(false);

    const result = await writeContextPack(pack, {
      cwd: workDir,
      agentName: "unconfigured-agent",
    });

    expect(result.outputPath).toBe(join(contextDir, "P2-E1-T1.md"));
    expect(await readFile(result.outputPath, "utf8")).toBe(pack.content);
    // No temp file (`<path>.tmp-<pid>-<ts>`) is left behind after the rename.
    const entries = await readdir(contextDir);
    expect(entries).toEqual(["P2-E1-T1.md"]);
  });

  it("respects agent profile context_dir over fallback", async () => {
    // Place an agent profile that points at .context/custom
    await mkdir(join(workDir, ".code-pact", "agent-profiles"), { recursive: true });
    await writeFile(
      join(workDir, ".code-pact", "agent-profiles", "custom-agent.yaml"),
      `name: custom-agent\ninstruction_filename: X.md\ncontext_dir: .context/custom\nmodel_map: {}\n`,
      "utf8",
    );
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "custom-agent",
    });
    const result = await writeContextPack(pack, {
      cwd: workDir,
      agentName: "custom-agent",
    });
    expect(result.outputPath).toContain(join(".context", "custom"));
  });
});
