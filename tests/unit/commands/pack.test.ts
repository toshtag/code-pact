import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPack } from "../../../src/commands/pack.ts";
import { parseFrontMatter } from "../../../src/core/pack/front-matter.ts";

const fixtureDir = new URL("../../../tests/fixtures/project-a", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// front-matter parser unit tests
// ---------------------------------------------------------------------------

describe("parseFrontMatter", () => {
  it("parses tags and applies_to from valid front-matter", () => {
    const input = `---\ntags: [coding, style]\napplies_to: [feature]\n---\n\n# Body\n`;
    const { frontMatter, body } = parseFrontMatter(input);
    expect(frontMatter.tags).toEqual(["coding", "style"]);
    expect(frontMatter.applies_to).toEqual(["feature"]);
    expect(body).toContain("# Body");
  });

  it("returns empty frontMatter for file without front-matter", () => {
    const input = `# No front-matter here\n`;
    const { frontMatter, body } = parseFrontMatter(input);
    expect(frontMatter).toEqual({});
    expect(body).toContain("# No front-matter");
  });

  it("returns empty frontMatter when closing --- is missing", () => {
    const input = `---\ntags: [x]\n`;
    const { frontMatter } = parseFrontMatter(input);
    expect(frontMatter).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// runPack against project-a fixture
// Output is always directed to a tmpdir so the fixture stays clean.
// ---------------------------------------------------------------------------

describe("runPack — project-a / P2-E1-T1", () => {
  let tmpOut: string;

  beforeEach(async () => {
    tmpOut = await mkdtemp(join(tmpdir(), "code-pact-pack-test-"));
  });

  afterEach(async () => {
    await rm(tmpOut, { recursive: true, force: true });
  });

  it("returns a result with outputPath and charCount > 0", async () => {
    const result = await runPack({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      outputDir: tmpOut,
    });
    expect(result.charCount).toBeGreaterThan(0);
    expect(result.outputPath).toContain("P2-E1-T1.md");
  });

  it("written file contains phase and task IDs", async () => {
    const result = await runPack({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      outputDir: tmpOut,
    });
    const content = await readFile(result.outputPath, "utf8");
    expect(content).toContain("P2");
    expect(content).toContain("P2-E1-T1");
  });

  it("includes coding-style and testing rules (applies_to: feature)", async () => {
    const result = await runPack({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      outputDir: tmpOut,
    });
    expect(result.includedRules).toContain("coding-style.md");
    expect(result.includedRules).toContain("testing.md");
  });

  it("excludes docs-only rule (applies_to: [docs] vs task type feature)", async () => {
    const result = await runPack({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      outputDir: tmpOut,
    });
    expect(result.includedRules).not.toContain("docs-only.md");
  });

  it("includes the related ADR decision", async () => {
    const result = await runPack({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      outputDir: tmpOut,
    });
    expect(result.includedDecisions).toContain("P2-E1-T1-use-parseargs.md");
  });

  it("output contains progress event schema hint", async () => {
    const result = await runPack({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      outputDir: tmpOut,
    });
    const content = await readFile(result.outputPath, "utf8");
    expect(content).toContain("progress.yaml");
    expect(content).toContain("status: done");
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("runPack — error cases", () => {
  it("throws PHASE_NOT_FOUND for unknown phase", async () => {
    await expect(
      runPack({ cwd: fixtureDir, phaseId: "NOPE", taskId: "X", agentName: "claude-code" }),
    ).rejects.toMatchObject({ code: "PHASE_NOT_FOUND" });
  });

  it("throws TASK_NOT_FOUND for unknown task in valid phase", async () => {
    await expect(
      runPack({ cwd: fixtureDir, phaseId: "P2", taskId: "NOPE", agentName: "claude-code" }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("rejects an unsafe --agent (path traversal) with CONFIG_ERROR, never reading outside agent-profiles/", async () => {
    await expect(
      runPack({ cwd: fixtureDir, phaseId: "P2", taskId: "P2-E1-T1", agentName: "../evil" }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});

// ---------------------------------------------------------------------------
// runPack without rules/decisions directories
// ---------------------------------------------------------------------------

describe("runPack — project with no rules dir", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-pack-norules-"));
    await mkdir(join(dir, ".code-pact", "state", "baselines"), { recursive: true });
    await mkdir(join(dir, "design", "phases"), { recursive: true });
    await writeFile(
      join(dir, "design", "roadmap.yaml"),
      "phases:\n  - id: P1\n    path: design/phases/P1-minimal.yaml\n    weight: 5\n",
      "utf8",
    );
    await writeFile(
      join(dir, "design", "phases", "P1-minimal.yaml"),
      [
        "id: P1",
        "name: Minimal",
        "weight: 5",
        "confidence: high",
        "risk: low",
        "status: planned",
        "objective: Minimal phase.",
        "definition_of_done:",
        "  - Done",
        "verification:",
        "  commands:",
        "    - echo ok",
        "tasks:",
        "  - id: P1-T1",
        "    type: feature",
        "    ambiguity: low",
        "    risk: low",
        "    context_size: small",
        "    write_surface: low",
        "    verification_strength: weak",
        "    expected_duration: short",
        "    status: planned",
      ].join("\n"),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("succeeds with empty rules and decisions when dirs are absent", async () => {
    const result = await runPack({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      agentName: "claude-code",
    });
    expect(result.includedRules).toHaveLength(0);
    expect(result.includedDecisions).toHaveLength(0);
    expect(result.charCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// v0.5.1 context quality — write_surface, context_size, ambiguity
// ---------------------------------------------------------------------------

describe("runPack — v0.5.1 context quality", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-pack-quality-"));
    await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
    await mkdir(join(dir, "design", "rules"), { recursive: true });
    await mkdir(join(dir, "design", "decisions"), { recursive: true });
    await mkdir(join(dir, "design", "phases"), { recursive: true });

    await writeFile(
      join(dir, "design", "roadmap.yaml"),
      "phases:\n  - id: PQ\n    path: design/phases/PQ-quality.yaml\n    weight: 5\n",
      "utf8",
    );
    await writeFile(
      join(dir, "design", "rules", "generic.md"),
      "---\ntags: [general]\napplies_to: []\n---\n\n# Generic rule\n",
      "utf8",
    );
    await writeFile(
      join(dir, "design", "rules", "docs-only.md"),
      "---\ntags: [docs]\napplies_to: [docs]\n---\n\n# Docs rule\n",
      "utf8",
    );
    await writeFile(
      join(dir, "design", "decisions", "PQ-T1-decision.md"),
      "# Decision\n\nUse X over Y.\n",
      "utf8",
    );
    await writeFile(
      join(dir, "design", "decisions", "PQ-other-decision.md"),
      "# Other Decision\n\nAnother decision unrelated to PQ-T1.\n",
      "utf8",
    );
    await writeFile(
      join(dir, "design", "constitution.md"),
      "# Project Constitution\n\nAlways write tests.\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writePhaseYaml(tasks: Array<Record<string, string>>) {
    const taskLines = tasks.flatMap((t) => [
      `  - id: ${t.id}`,
      `    type: ${t.type ?? "feature"}`,
      `    ambiguity: ${t.ambiguity ?? "low"}`,
      `    risk: ${t.risk ?? "low"}`,
      `    context_size: ${t.context_size ?? "medium"}`,
      `    write_surface: ${t.write_surface ?? "medium"}`,
      `    verification_strength: ${t.verification_strength ?? "weak"}`,
      `    expected_duration: ${t.expected_duration ?? "short"}`,
      `    status: ${t.status ?? "planned"}`,
    ]);
    const lines = [
      "id: PQ",
      "name: Quality",
      "weight: 5",
      "confidence: high",
      "risk: low",
      "status: planned",
      "objective: Quality phase.",
      "definition_of_done:",
      "  - Done",
      "verification:",
      "  commands:",
      "    - echo ok",
      "tasks:",
      ...taskLines,
    ];
    await writeFile(join(dir, "design", "phases", "PQ-quality.yaml"), lines.join("\n"), "utf8");
  }

  it("write_surface: high includes all rules (bypasses applies_to filter)", async () => {
    await writePhaseYaml([{ id: "PQ-T1", write_surface: "high" }]);
    const result = await runPack({ cwd: dir, phaseId: "PQ", taskId: "PQ-T1", agentName: "claude-code", outputDir: dir });
    expect(result.includedRules).toContain("docs-only.md");
    expect(result.includedRules).toContain("generic.md");
  });

  it("write_surface: medium excludes docs-only rule for feature task", async () => {
    await writePhaseYaml([{ id: "PQ-T1", write_surface: "medium" }]);
    const result = await runPack({ cwd: dir, phaseId: "PQ", taskId: "PQ-T1", agentName: "claude-code", outputDir: dir });
    expect(result.includedRules).not.toContain("docs-only.md");
    expect(result.includedRules).toContain("generic.md");
  });

  it("context_size: large sets includedConstitution and includes constitution in output", async () => {
    await writePhaseYaml([{ id: "PQ-T1", context_size: "large" }]);
    const result = await runPack({ cwd: dir, phaseId: "PQ", taskId: "PQ-T1", agentName: "claude-code", outputDir: dir });
    expect(result.includedConstitution).toBe(true);
    const content = await readFile(join(dir, "PQ-T1.md"), "utf8");
    expect(content).toContain("Project Constitution");
  });

  it("context_size: large includes all decisions (not just task-id-matched)", async () => {
    await writePhaseYaml([{ id: "PQ-T1", context_size: "large" }]);
    const result = await runPack({ cwd: dir, phaseId: "PQ", taskId: "PQ-T1", agentName: "claude-code", outputDir: dir });
    expect(result.includedDecisions).toContain("PQ-T1-decision.md");
    expect(result.includedDecisions).toContain("PQ-other-decision.md");
  });

  it("context_size: small yields no rules, decisions, or constitution", async () => {
    await writePhaseYaml([{ id: "PQ-T1", context_size: "small" }]);
    const result = await runPack({ cwd: dir, phaseId: "PQ", taskId: "PQ-T1", agentName: "claude-code", outputDir: dir });
    expect(result.includedRules).toHaveLength(0);
    expect(result.includedDecisions).toHaveLength(0);
    expect(result.includedConstitution).toBe(false);
  });

  it("ambiguity: high includes constitution", async () => {
    await writePhaseYaml([{ id: "PQ-T1", ambiguity: "high" }]);
    const result = await runPack({ cwd: dir, phaseId: "PQ", taskId: "PQ-T1", agentName: "claude-code", outputDir: dir });
    expect(result.includedConstitution).toBe(true);
  });

  it("ambiguity: high with done events in phase shows completed tasks section in output", async () => {
    await writePhaseYaml([
      { id: "PQ-T0", status: "done" },
      { id: "PQ-T1", ambiguity: "high" },
    ]);
    await writeFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      [
        "events:",
        "  - task_id: PQ-T0",
        "    status: done",
        '    at: "2026-05-15T10:00:00+09:00"',
        "    actor: agent",
        "    agent: claude-code",
        "    evidence:",
        "      - pnpm test",
      ].join("\n"),
      "utf8",
    );
    const result = await runPack({ cwd: dir, phaseId: "PQ", taskId: "PQ-T1", agentName: "claude-code", outputDir: dir });
    const content = await readFile(join(dir, "PQ-T1.md"), "utf8");
    expect(content).toContain("Completed Tasks in This Phase");
    expect(content).toContain("PQ-T0");
    // suppress unused result warning
    expect(result.charCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// BUG-004 regression — pack must write to agent profile context_dir
// ---------------------------------------------------------------------------

describe("runPack — BUG-004: output follows agent profile context_dir", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-pack-bug004-"));
    await mkdir(join(dir, ".code-pact", "state", "baselines"), { recursive: true });
    await mkdir(join(dir, ".code-pact", "agent-profiles"), { recursive: true });
    await mkdir(join(dir, "design", "phases"), { recursive: true });
    await writeFile(
      join(dir, "design", "roadmap.yaml"),
      "phases:\n  - id: P1\n    path: design/phases/P1-minimal.yaml\n    weight: 5\n",
      "utf8",
    );
    await writeFile(
      join(dir, "design", "phases", "P1-minimal.yaml"),
      [
        "id: P1", "name: Minimal", "weight: 5", "confidence: high", "risk: low",
        "status: planned", "objective: Minimal.", "definition_of_done:", "  - Done",
        "verification:", "  commands:", "    - echo ok",
        "tasks:",
        "  - id: P1-T1", "    type: feature", "    ambiguity: low", "    risk: low",
        "    context_size: small", "    write_surface: low",
        "    verification_strength: weak", "    expected_duration: short", "    status: planned",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(dir, ".code-pact", "agent-profiles", "test-agent.yaml"),
      "name: test-agent\ninstruction_filename: AGENT.md\ncontext_dir: .context/custom\nmodel_map: {}\n",
      "utf8",
    );
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("writes to context_dir from agent profile when outputDir is not specified", async () => {
    const result = await runPack({ cwd: dir, phaseId: "P1", taskId: "P1-T1", agentName: "test-agent" });
    expect(result.outputPath).toContain(join(".context", "custom"));
  });

  it("outputDir still overrides agent profile context_dir", async () => {
    const override = join(dir, "override");
    const result = await runPack({
      cwd: dir, phaseId: "P1", taskId: "P1-T1", agentName: "test-agent", outputDir: override,
    });
    expect(result.outputPath).toContain("override");
    expect(result.outputPath).not.toContain("custom");
  });
});
