import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  stat,
  mkdir,
  readFile,
  writeFile,
  cp,
  readdir,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  buildContextPack,
  writeContextPack,
} from "../../../src/core/pack/index.ts";
import { loadContextManifestArtifact } from "../../../src/core/context-deferral/context-store.ts";
import { __setAtomicWriteFailAfterOpenForTests } from "../../../src/io/atomic-text.ts";

const fixtureDir = new URL("../../../tests/fixtures/project-a", import.meta.url).pathname;
const contextProjectionFixtureDir = new URL(
  "../../../tests/fixtures/context-projection/",
  import.meta.url,
).pathname;

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

describe("buildContextPack — decision projection", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "code-pact-pack-decision-proj-"));
    await cp(fixtureDir, workDir, { recursive: true });
    await rm(join(workDir, ".context"), { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function updateP2Task(fields: Record<string, unknown>): Promise<void> {
    const phasePath = join(workDir, "design", "phases", "P2-core.yaml");
    const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<
      string,
      unknown
    >;
    const tasks = doc.tasks as Array<Record<string, unknown>>;
    tasks[0] = { ...tasks[0], ...fields };
    await writeFile(phasePath, stringifyYaml(doc), "utf8");
  }

  it("projects large related decisions while preserving declared decision bodies", async () => {
    const relatedMarker = "RELATED-DECISION-BODY-MARKER";
    const declaredMarker = "DECLARED-DECISION-BODY-MARKER";
    const relatedFixture = await readFile(
      join(contextProjectionFixtureDir, "large-accepted-decisions", "related.md"),
      "utf8",
    );
    const declaredFixture = await readFile(
      join(contextProjectionFixtureDir, "large-accepted-decisions", "declared.md"),
      "utf8",
    );
    const expectedProjection = await readFile(
      join(
        contextProjectionFixtureDir,
        "large-accepted-decisions",
        "expected-projected-snippet.md",
      ),
      "utf8",
    );
    await writeFile(
      join(workDir, "design", "decisions", "zzz-related-projection.md"),
      relatedFixture.replace(relatedMarker, relatedMarker.repeat(500)),
    );
    await writeFile(
      join(workDir, "design", "decisions", "declared-projection.md"),
      declaredFixture.replace(declaredMarker, declaredMarker.repeat(200)),
    );
    await updateP2Task({
      context_size: "large",
      decision_refs: ["design/decisions/declared-projection.md"],
    });

    const baseline = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    const budget = baseline.totalBytes - 1000;
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
      budgetBytes: budget,
    });

    expect(pack.content).toContain(
      "Accepted decisions with explicit implementation commitments",
    );
    expect(pack.content).toContain(expectedProjection.trim());
    expect(pack.content).not.toContain(relatedMarker);
    expect(pack.content).toContain(declaredMarker);
    expect(pack.explainMetrics?.elidedSections.map(section => section.name)).not.toContain(
      "related_decisions",
    );
    const related = pack.sections?.find(section => section.name === "related_decisions");
    expect(related?.details).toMatchObject({
      projection_kind: "decision_implementation_commitments",
      projected_decision_count: 1,
    });
    const storedOriginal = pack.pendingContextManifest?.manifest.sections.find(
      section => section.name === "related_decisions",
    );
    expect(storedOriginal?.content).toContain(relatedMarker);
    expect(storedOriginal?.content).not.toContain(declaredMarker);
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
    __setAtomicWriteFailAfterOpenForTests(null);
    await rm(workDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  async function buildBudgetedDeferredPack() {
    const phasePath = join(workDir, "design", "phases", "P2-core.yaml");
    const phaseYaml = await readFile(phasePath, "utf8");
    await writeFile(
      phasePath,
      phaseYaml.replace(/context_size: \w+/, "context_size: large"),
      "utf8",
    );
    await writeFile(
      join(workDir, "design", "constitution.md"),
      `# Constitution\n${"contract text\n".repeat(400)}`,
      "utf8",
    );
    const baseline = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      budgetBytes: baseline.totalBytes - 1000,
    });
    expect(pack.deferredContext).toBeDefined();
    expect(pack.pendingContextManifest).toBeDefined();
    return pack;
  }

  function artifactPath(ref: string): string {
    const digest = ref.replace("context:sha256:", "");
    return join(workDir, ".code-pact", "cache", "context", `${digest}.json`);
  }

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

  it("uses a caller-provided profileContextDir without reloading the profile", async () => {
    await rm(join(workDir, ".code-pact", "agent-profiles", "custom-agent.yaml"), {
      force: true,
    });
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "custom-agent",
    });

    const result = await writeContextPack(pack, {
      cwd: workDir,
      agentName: "custom-agent",
      profileContextDir: ".context/reused",
    });

    expect(result.outputPath).toBe(
      join(workDir, ".context", "reused", "P2-E1-T1.md"),
    );
    expect(await readFile(result.outputPath, "utf8")).toBe(pack.content);
    expect(await exists(join(workDir, ".context", "custom-agent"))).toBe(false);
  });

  it("prefers profileContextDir over a changed or invalid on-disk profile", async () => {
    await mkdir(join(workDir, ".code-pact", "agent-profiles"), { recursive: true });
    await writeFile(
      join(workDir, ".code-pact", "agent-profiles", "custom-agent.yaml"),
      `name: custom-agent\ninstruction_filename: /etc/passwd\ncontext_dir: .context/changed\nmodel_map: {}\n`,
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
      profileContextDir: ".context/validated",
    });

    expect(result.outputPath).toBe(
      join(workDir, ".context", "validated", "P2-E1-T1.md"),
    );
    expect(await exists(join(workDir, ".context", "changed"))).toBe(false);
  });

  it("rejects outputDir and profileContextDir together before writing artifacts", async () => {
    const pack = await buildBudgetedDeferredPack();

    await expect(
      writeContextPack(pack, {
        cwd: workDir,
        agentName: "claude-code",
        outputDir: outDir,
        profileContextDir: ".context/reused",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });

    expect(await exists(artifactPath(pack.deferredContext!.manifest_ref))).toBe(false);
    expect(await exists(join(outDir, `${pack.taskId}.md`))).toBe(false);
  });

  it("materializes deferred artifacts before writing a budgeted pack directly", async () => {
    const pack = await buildBudgetedDeferredPack();

    const result = await writeContextPack(pack, {
      cwd: workDir,
      agentName: "claude-code",
      outputDir: outDir,
    });

    expect(await readFile(result.outputPath, "utf8")).toBe(pack.content);
    const ref = pack.deferredContext!.manifest_ref;
    expect(await readFile(artifactPath(ref), "utf8")).toBe(
      pack.pendingContextManifest!.content,
    );
    await expect(loadContextManifestArtifact(workDir, ref)).resolves.toMatchObject({
      ref,
    });

    const second = await writeContextPack(pack, {
      cwd: workDir,
      agentName: "claude-code",
      outputDir: outDir,
    });
    expect(second.outputPath).toBe(result.outputPath);
  });

  it("rejects incomplete deferred metadata without writing the pack", async () => {
    const pack = await buildBudgetedDeferredPack();
    const { pendingContextManifest: _pending, ...withoutPending } = pack;

    await expect(
      writeContextPack(withoutPending, {
        cwd: workDir,
        agentName: "claude-code",
        outputDir: outDir,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    expect(await exists(join(outDir, `${pack.taskId}.md`))).toBe(false);

    const { deferredContext: _metadata, ...withoutMetadata } = pack;
    await expect(
      writeContextPack(withoutMetadata, {
        cwd: workDir,
        agentName: "claude-code",
        outputDir: outDir,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    expect(await exists(join(outDir, `${pack.taskId}.md`))).toBe(false);
  });

  it("rejects deferred metadata that does not match the pending artifact", async () => {
    const pack = await buildBudgetedDeferredPack();
    await expect(
      writeContextPack(
        {
          ...pack,
          deferredContext: {
            ...pack.deferredContext!,
            sections: [{ name: "rules", bytes: 1 }],
          },
        },
        { cwd: workDir, agentName: "claude-code", outputDir: outDir },
      ),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    expect(await exists(join(outDir, `${pack.taskId}.md`))).toBe(false);
  });

  it("rejects a budgeted pack whose content omits the manifest reference", async () => {
    const pack = await buildBudgetedDeferredPack();
    await expect(
      writeContextPack(
        {
          ...pack,
          content: pack.content.replace(pack.deferredContext!.manifest_ref, "context:sha256:" + "0".repeat(64)),
        },
        { cwd: workDir, agentName: "claude-code", outputDir: outDir },
      ),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    expect(await exists(join(outDir, `${pack.taskId}.md`))).toBe(false);
  });

  it("does not write a pack when deferred artifact materialization fails", async () => {
    const pack = await buildBudgetedDeferredPack();
    const writeError = new Error("disk full");
    (writeError as NodeJS.ErrnoException).code = "ENOSPC";
    __setAtomicWriteFailAfterOpenForTests(() => writeError);

    await expect(
      writeContextPack(pack, { cwd: workDir, agentName: "claude-code", outputDir: outDir }),
    ).rejects.toMatchObject({ code: "CONTEXT_WRITE_FAILED" });
    expect(await exists(join(outDir, `${pack.taskId}.md`))).toBe(false);
  });

  it("keeps the verified artifact when the later pack output path is refused", async () => {
    const pack = await buildBudgetedDeferredPack();
    await mkdir(join(workDir, ".context"), { recursive: true });
    await symlink(outDir, join(workDir, ".context", "blocked"));

    await expect(
      writeContextPack(pack, {
        cwd: workDir,
        agentName: "claude-code",
        outputDir: ".context/blocked",
      }),
    ).rejects.toMatchObject({ code: expect.any(String) });

    expect(await exists(artifactPath(pack.deferredContext!.manifest_ref))).toBe(true);
    expect(await exists(join(outDir, `${pack.taskId}.md`))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SECURITY: constitution reads must not follow a symlink out of the project.
// `design/constitution.md` is rendered into the agent-facing pack for
// context_size: large / ambiguity: high tasks. A malicious repo that symlinks
// it to an outside file must NOT leak that file into the pack (CWE-59).
// ---------------------------------------------------------------------------

describe("buildContextPack — constitution symlink containment", () => {
  let workDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "code-pact-pack-const-"));
    outsideDir = await mkdtemp(join(tmpdir(), "code-pact-outside-"));
    await cp(fixtureDir, workDir, { recursive: true });
    await rm(join(workDir, ".context"), { recursive: true, force: true });
    // Make the task large so the pack includes the constitution slot.
    const phasePath = join(workDir, "design", "phases", "P2-core.yaml");
    const phaseYaml = await readFile(phasePath, "utf8");
    await writeFile(
      phasePath,
      phaseYaml.replace("context_size: medium", "context_size: large"),
      "utf8",
    );
    // Remove any real constitution shipped by the fixture so each test controls it.
    await rm(join(workDir, "design", "constitution.md"), { force: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("does NOT leak an out-of-project file symlinked as design/constitution.md", async () => {
    const secret = join(outsideDir, "secret.md");
    await writeFile(secret, "# SECRET_FROM_OUTSIDE_REPO\nstolen contents\n", "utf8");
    await symlink(secret, join(workDir, "design", "constitution.md"));

    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });

    expect(pack.content).not.toContain("SECRET_FROM_OUTSIDE_REPO");
    expect(pack.includedConstitution).toBe(false);
  });

  it("still includes a real in-project design/constitution.md", async () => {
    await writeFile(
      join(workDir, "design", "constitution.md"),
      "# Project Constitution\nIN_PROJECT_CONSTITUTION_MARKER\n",
      "utf8",
    );

    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });

    expect(pack.content).toContain("IN_PROJECT_CONSTITUTION_MARKER");
    expect(pack.includedConstitution).toBe(true);
  });
});
