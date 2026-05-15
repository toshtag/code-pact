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
