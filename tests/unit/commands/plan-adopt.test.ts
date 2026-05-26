import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { runPlanAdopt, PlanAdoptError } from "../../../src/commands/plan-adopt.ts";

const EMPTY_ROADMAP = `phases: []\n`;

async function setupProject(dir: string, roadmap = EMPTY_ROADMAP): Promise<void> {
  await mkdir(join(dir, "design", "phases"), { recursive: true });
  await writeFile(join(dir, "design", "roadmap.yaml"), roadmap, "utf8");
}

async function write(dir: string, name: string, body: string): Promise<string> {
  await writeFile(join(dir, name), body, "utf8");
  return name;
}

async function readRoadmapIds(dir: string): Promise<string[]> {
  const raw = await readFile(join(dir, "design", "roadmap.yaml"), "utf8");
  const doc = parseYaml(raw) as { phases: { id: string }[] };
  return doc.phases.map((p) => p.id);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-plan-adopt-"));
});
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// YAML detection
// ---------------------------------------------------------------------------

describe("runPlanAdopt — phase_import_yaml", () => {
  it("detects top-level phases: as phase_import_yaml and dry-runs without writing", async () => {
    await setupProject(dir);
    const fromPath = await write(
      dir,
      "roadmap.yaml.in",
      `phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: Establish foundation
    verify_commands: ["pnpm test"]
    tasks:
      - id: P1-T1
        description: scaffold
`,
    );
    const result = await runPlanAdopt({ cwd: dir, fromPath, write: false });
    expect(result.kind).toBe("would_adopt");
    expect(result.source_type).toBe("phase_import_yaml");
    expect(result.phases_detected).toBe(1);
    expect(result.tasks_detected).toBe(1);
    expect(result.import_result).toBeNull();
    expect(result.generated_import_yaml).toContain("verify_commands");
    // dry-run must not touch the roadmap
    expect(await readRoadmapIds(dir)).toEqual([]);
  });

  it("surfaces the verification.commands mis-shape as an adopt warning", async () => {
    await setupProject(dir);
    const fromPath = await write(
      dir,
      "in.yaml",
      `phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: Used the nested shape
    verification:
      commands: ["pnpm test"]
`,
    );
    const result = await runPlanAdopt({ cwd: dir, fromPath, write: false });
    expect(result.source_type).toBe("phase_import_yaml");
    expect(result.warnings.some((w) => w.code === "PHASE_VERIFY_COMMANDS_MISSHAPED")).toBe(true);
  });
});

describe("runPlanAdopt — single_phase_yaml", () => {
  it("wraps a single Phase-shaped object and normalises verify_commands", async () => {
    await setupProject(dir);
    const fromPath = await write(
      dir,
      "phase.yaml",
      `id: P1
name: Foundation
objective: A single phase
verify_commands: ["pnpm test"]
tasks:
  - id: P1-T1
    description: do the thing
`,
    );
    const result = await runPlanAdopt({ cwd: dir, fromPath, write: false });
    expect(result.source_type).toBe("single_phase_yaml");
    expect(result.phases_detected).toBe(1);
    expect(result.tasks_detected).toBe(1);
    expect(result.generated_import_yaml).toContain("phases:");
  });

  it("accepts legacy verification.commands and warns + normalises", async () => {
    await setupProject(dir);
    const fromPath = await write(
      dir,
      "phase.yaml",
      `id: P1
name: Foundation
objective: legacy shape single phase
verification:
  commands: ["pnpm build"]
tasks:
  - id: P1-T1
    description: do it
`,
    );
    const result = await runPlanAdopt({ cwd: dir, fromPath, write: false });
    expect(result.source_type).toBe("single_phase_yaml");
    expect(result.warnings.some((w) => w.code === "PHASE_VERIFY_COMMANDS_MISSHAPED")).toBe(true);
    expect(result.generated_import_yaml).toContain("verify_commands");
    expect(result.generated_import_yaml).toContain("pnpm build");
  });
});

// ---------------------------------------------------------------------------
// Markdown detection
// ---------------------------------------------------------------------------

describe("runPlanAdopt — markdown", () => {
  it("adopts phase-marker headings with bullet tasks", async () => {
    await setupProject(dir);
    const fromPath = await write(
      dir,
      "roadmap.md",
      `# Plan

## Phase 1: Foundations
- Scaffold the package
- [ ] Define the schema

## Phase 2: Docs
- Write the README
`,
    );
    const result = await runPlanAdopt({ cwd: dir, fromPath, write: false });
    expect(result.source_type).toBe("markdown");
    expect(result.phases_detected).toBe(2);
    expect(result.tasks_detected).toBe(3);
    // README task should infer type docs
    expect(result.generated_import_yaml).toContain("type: docs");
    // readiness advisory present exactly once
    expect(result.warnings.filter((w) => w.code === "READINESS_FIELDS_NOT_INFERRED")).toHaveLength(1);
  });

  it("infers a single phase for a flat list and warns PHASE_ID_INFERRED", async () => {
    await setupProject(dir);
    const fromPath = await write(
      dir,
      "TODO.md",
      `# TODO

- first thing
- second thing
`,
    );
    const result = await runPlanAdopt({ cwd: dir, fromPath, write: false });
    expect(result.source_type).toBe("markdown");
    expect(result.phases_detected).toBe(1);
    expect(result.warnings.some((w) => w.code === "PHASE_ID_INFERRED")).toBe(true);
  });

  it("warns CHECKED_TASK_SKIPPED for done checkboxes", async () => {
    await setupProject(dir);
    const fromPath = await write(
      dir,
      "tasks.md",
      `## Phase 1
- [x] done already
- [ ] still open
`,
    );
    const result = await runPlanAdopt({ cwd: dir, fromPath, write: false });
    expect(result.tasks_detected).toBe(1);
    expect(result.warnings.some((w) => w.code === "CHECKED_TASK_SKIPPED")).toBe(true);
  });

  it("seeds phase ids after existing P-numbered roadmap phases", async () => {
    await setupProject(
      dir,
      `phases:
  - id: P1
    path: design/phases/P1-existing.yaml
    weight: 10
`,
    );
    const fromPath = await write(dir, "more.md", `## Milestone X\n- a new task\n`);
    const result = await runPlanAdopt({ cwd: dir, fromPath, write: false });
    expect(result.generated_import_yaml).toContain("id: P2");
    expect(result.generated_import_yaml).not.toContain("id: P1");
  });

  it("throws no_plan_items_detected for prose with no list items", async () => {
    await setupProject(dir);
    const fromPath = await write(
      dir,
      "narrative.md",
      `# Narrative\n\nThis describes the work in prose with no bullets.\n`,
    );
    await expect(runPlanAdopt({ cwd: dir, fromPath, write: false })).rejects.toMatchObject({
      code: "CONFIG_ERROR",
      detail: "no_plan_items_detected",
    });
  });
});

// ---------------------------------------------------------------------------
// Path safety + write
// ---------------------------------------------------------------------------

describe("runPlanAdopt — safety and write", () => {
  it("rejects an unsafe (traversal) path", async () => {
    await setupProject(dir);
    await expect(
      runPlanAdopt({ cwd: dir, fromPath: "../etc/passwd", write: false }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR", detail: "unsafe_path" });
  });

  it("--write applies the import via applyParsedPhaseImport and creates phases/tasks", async () => {
    await setupProject(dir);
    const fromPath = await write(
      dir,
      "roadmap.md",
      `## Phase 1: Foundations
- Scaffold the package
- Wire the CLI
`,
    );
    const result = await runPlanAdopt({ cwd: dir, fromPath, write: true });
    expect(result.kind).toBe("adopted");
    expect(result.import_result).not.toBeNull();
    expect(result.import_result!.imported_phases).toHaveLength(1);
    expect(result.import_result!.imported_tasks).toHaveLength(2);
    // roadmap now carries the new phase
    expect(await readRoadmapIds(dir)).toEqual(["P1"]);
  });

  it("instance is a PlanAdoptError with a stable detail enum", async () => {
    await setupProject(dir);
    try {
      await runPlanAdopt({ cwd: dir, fromPath: "missing.md", write: false });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanAdoptError);
      expect((err as PlanAdoptError).detail).toBe("file_not_found");
    }
  });
});
