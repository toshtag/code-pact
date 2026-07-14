import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  mkdir,
  readFile,
  writeFile,
  cp,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildContextPack,
  writeContextPack,
} from "../../../src/core/pack/index.ts";
import { resolveProfileContextOutputPath } from "../../../src/core/pack/context-output-path.ts";
import { AgentProfile } from "../../../src/core/schemas/agent-profile.ts";

const fixtureDir = new URL("../../../tests/fixtures/project-a", import.meta.url)
  .pathname;

describe("context output namespace security", () => {
  let workDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "code-pact-ctx-ns-"));
    outsideDir = await mkdtemp(join(tmpdir(), "code-pact-outside-"));
    await cp(fixtureDir, workDir, { recursive: true });
    await rm(join(workDir, ".context"), { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  // --- Schema boundary: ContextOutputDir rejects non-.context paths ---

  it.each([
    ["design"],
    ["docs"],
    ["src"],
    [".code-pact"],
    [".claude"],
    [".contextual"],
    [".context-old"],
    [".context_backup"],
    ["foo/.context"],
  ])(
    "AgentProfile rejects context_dir = %j (outside .context namespace)",
    value => {
      expect(() =>
        AgentProfile.parse({
          name: "hostile-agent",
          instruction_filename: "X.md",
          context_dir: value,
          model_map: {},
        }),
      ).toThrow();
    },
  );

  it.each([
    [".context"],
    [".context/custom"],
    [".context/claude-code"],
    [".context/custom/nested"],
  ])(
    "AgentProfile accepts context_dir = %j (inside .context namespace)",
    value => {
      const a = AgentProfile.parse({
        name: "safe-agent",
        instruction_filename: "X.md",
        context_dir: value,
        model_map: {},
      });
      expect(a.context_dir).toBe(value);
    },
  );

  // --- resolveProfileContextOutputPath ---

  it("resolveProfileContextOutputPath rejects non-.context dir", async () => {
    await expect(
      resolveProfileContextOutputPath(workDir, "design", "constitution"),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("resolveProfileContextOutputPath rejects invalid task id", async () => {
    await expect(
      resolveProfileContextOutputPath(workDir, ".context/custom", "../evil"),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("resolveProfileContextOutputPath accepts .context/custom", async () => {
    const p = await resolveProfileContextOutputPath(
      workDir,
      ".context/custom",
      "P1-T1",
    );
    expect(p).toBe(join(workDir, ".context", "custom", "P1-T1.md"));
  });

  // --- writeContextPack: profile-derived path must stay in .context/** ---

  it("writeContextPack does not overwrite design/constitution.md even with hostile profile", async () => {
    // A hostile profile sets context_dir: design to redirect context pack
    // output into design/constitution.md (taskId: constitution). The
    // ContextOutputDir schema rejects "design", so loadAgentProfile fails
    // to parse and returns null. writeContextPack then falls back to the
    // safe default .context/<agentName>. The victim file is untouched.
    await mkdir(join(workDir, ".code-pact", "agent-profiles"), {
      recursive: true,
    });
    await writeFile(
      join(workDir, ".code-pact", "agent-profiles", "hostile-agent.yaml"),
      `name: hostile-agent\ninstruction_filename: X.md\ncontext_dir: design\nmodel_map: {}\n`,
      "utf8",
    );
    await mkdir(join(workDir, "design"), { recursive: true });
    const victimPath = join(workDir, "design", "constitution.md");
    const victimContent = "# ORIGINAL CONSTITUTION\nvictim-marker\n";
    await writeFile(victimPath, victimContent, "utf8");

    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "hostile-agent",
    });

    const result = await writeContextPack(pack, {
      cwd: workDir,
      agentName: "hostile-agent",
    });

    // Output must be under .context, not design/
    expect(result.outputPath).toContain(".context");
    expect(result.outputPath).not.toContain("design");
    // Victim must be byte-identical
    expect(await readFile(victimPath, "utf8")).toBe(victimContent);
  });

  it("writeContextPack writes successfully to .context/custom/nested", async () => {
    await mkdir(join(workDir, ".code-pact", "agent-profiles"), {
      recursive: true,
    });
    await writeFile(
      join(workDir, ".code-pact", "agent-profiles", "safe-agent.yaml"),
      `name: safe-agent\ninstruction_filename: X.md\ncontext_dir: .context/custom/nested\nmodel_map: {}\n`,
      "utf8",
    );
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "safe-agent",
    });
    const result = await writeContextPack(pack, {
      cwd: workDir,
      agentName: "safe-agent",
    });
    expect(result.outputPath).toContain(
      join(".context", "custom", "nested", "P2-E1-T1.md"),
    );
    expect(await readFile(result.outputPath, "utf8")).toBe(pack.content);
  });

  // --- symlink tests ---

  it("rejects .context symlinked to outside project", async () => {
    await mkdir(join(workDir, ".code-pact", "agent-profiles"), {
      recursive: true,
    });
    await writeFile(
      join(workDir, ".code-pact", "agent-profiles", "safe-agent.yaml"),
      `name: safe-agent\ninstruction_filename: X.md\ncontext_dir: .context/custom\nmodel_map: {}\n`,
      "utf8",
    );
    const outsideTarget = join(outsideDir, "evil");
    await mkdir(outsideTarget, { recursive: true });
    await rm(join(workDir, ".context"), { recursive: true, force: true });
    await symlink(outsideTarget, join(workDir, ".context"));

    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "safe-agent",
    });

    await expect(
      writeContextPack(pack, { cwd: workDir, agentName: "safe-agent" }),
    ).rejects.toThrow();
  });

  it("rejects .context symlinked to outside project with profileContextDir", async () => {
    const outsideTarget = join(outsideDir, "evil");
    await mkdir(outsideTarget, { recursive: true });
    await rm(join(workDir, ".context"), { recursive: true, force: true });
    await symlink(outsideTarget, join(workDir, ".context"));

    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "safe-agent",
    });

    await expect(
      writeContextPack(pack, {
        cwd: workDir,
        agentName: "safe-agent",
        profileContextDir: ".context/custom",
      }),
    ).rejects.toThrow();
  });

  it("rejects final-component symlink at output path", async () => {
    await mkdir(join(workDir, ".code-pact", "agent-profiles"), {
      recursive: true,
    });
    await writeFile(
      join(workDir, ".code-pact", "agent-profiles", "safe-agent.yaml"),
      `name: safe-agent\ninstruction_filename: X.md\ncontext_dir: .context/custom\nmodel_map: {}\n`,
      "utf8",
    );
    await mkdir(join(workDir, ".context", "custom"), { recursive: true });
    const outsideTarget = join(outsideDir, "evil.md");
    await writeFile(outsideTarget, "STOLEN", "utf8");
    await symlink(
      outsideTarget,
      join(workDir, ".context", "custom", "P2-E1-T1.md"),
    );

    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "safe-agent",
    });

    await expect(
      writeContextPack(pack, { cwd: workDir, agentName: "safe-agent" }),
    ).rejects.toThrow();

    expect(await readFile(outsideTarget, "utf8")).toBe("STOLEN");
  });

  it("rejects final-component symlink at output path with profileContextDir", async () => {
    await mkdir(join(workDir, ".context", "custom"), { recursive: true });
    const outsideTarget = join(outsideDir, "evil.md");
    await writeFile(outsideTarget, "STOLEN", "utf8");
    await symlink(
      outsideTarget,
      join(workDir, ".context", "custom", "P2-E1-T1.md"),
    );

    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "safe-agent",
    });

    await expect(
      writeContextPack(pack, {
        cwd: workDir,
        agentName: "safe-agent",
        profileContextDir: ".context/custom",
      }),
    ).rejects.toThrow();

    expect(await readFile(outsideTarget, "utf8")).toBe("STOLEN");
  });
});
