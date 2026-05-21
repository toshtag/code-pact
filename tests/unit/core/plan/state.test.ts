import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectPlanArtifacts,
  loadPlanState,
} from "../../../../src/core/plan/state.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-plan-state-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function writeRoadmap(content: string): Promise<void> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), content, "utf8");
}

async function writePhase(filename: string, content: string): Promise<void> {
  await writeFile(join(cwd, "design", "phases", filename), content, "utf8");
}

async function writeProgress(content: string): Promise<void> {
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
  await writeFile(
    join(cwd, ".code-pact", "state", "progress.yaml"),
    content,
    "utf8",
  );
}

const PHASE_YAML = (id: string, taskIds: string[] = []): string => `
id: ${id}
name: ${id}
weight: 10
confidence: medium
risk: low
status: planned
objective: A long enough objective sentence
definition_of_done:
  - thing is done
verification:
  commands:
    - pnpm test
tasks:
${taskIds
  .map(
    (t) => `  - id: ${t}
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short
    status: planned`,
  )
  .join("\n")}
`;

describe("loadPlanState (strict)", () => {
  it("returns a complete snapshot with task index and null progress when the log is absent", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", PHASE_YAML("P1", ["P1-T1"]));

    const state = await loadPlanState(cwd);
    expect(state.phases).toHaveLength(1);
    expect(state.taskIndex.has("P1-T1")).toBe(true);
    expect(state.progress).toBeNull();
  });

  it("throws ParseError when a phase file fails schema validation", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", "id: P1\nname: invalid\n");

    await expect(loadPlanState(cwd)).rejects.toThrow();
  });

  it("throws ParseError when the roadmap references an unsafe phase path", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: ../outside.yaml\n    weight: 10\n`,
    );

    await expect(loadPlanState(cwd)).rejects.toThrow();
  });

  it("loads progress events when progress.yaml exists", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", PHASE_YAML("P1", ["P1-T1"]));
    await writeProgress(
      `events:\n  - task_id: P1-T1\n    status: done\n    at: "2026-05-18T09:00:00+00:00"\n    actor: agent\n`,
    );

    const state = await loadPlanState(cwd);
    expect(state.progress?.events).toHaveLength(1);
  });
});

describe("collectPlanArtifacts (lenient)", () => {
  it("returns a populated state when all files are valid", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", PHASE_YAML("P1", ["P1-T1"]));

    const result = await collectPlanArtifacts(cwd);
    expect(result.state).not.toBeNull();
    expect(result.fileIssues).toEqual([]);
    expect(result.skippedChecks).toEqual([]);
  });

  it("falls back to scanning design/phases/ when the roadmap is unparseable, and records skipped checks", async () => {
    await writeRoadmap("not: { valid: yaml: at all\n");
    await writePhase("P1.yaml", PHASE_YAML("P1", ["P1-T1"]));
    await writePhase("P2.yaml", PHASE_YAML("P2", ["P2-T1"]));

    const result = await collectPlanArtifacts(cwd);
    expect(result.state).toBeNull();
    expect(result.fallbackPhases.map((p) => p.phase.id).sort()).toEqual([
      "P1",
      "P2",
    ]);
    expect(result.skippedChecks).toContain("MISSING_PHASE_FILE");
    expect(result.skippedChecks).toContain("ORPHAN_PHASE_FILE");
    expect(result.fileIssues.some((i) => i.code === "INVALID_YAML")).toBe(true);
  });

  it("collects schema errors per phase file instead of stopping at the first invalid one", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n  - id: P2\n    path: design/phases/P2.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", "id: P1\nname: half-defined\n");
    await writePhase("P2.yaml", PHASE_YAML("P2", ["P2-T1"]));

    const result = await collectPlanArtifacts(cwd);
    expect(result.state).not.toBeNull();
    expect(result.state?.phases.map((p) => p.phase.id)).toEqual(["P2"]);
    expect(
      result.fileIssues.some(
        (i) => i.code === "SCHEMA_ERROR" && i.file === "design/phases/P1.yaml",
      ),
    ).toBe(true);
  });

  it("reports unsafe roadmap phase paths as roadmap schema errors", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: /tmp/outside.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", PHASE_YAML("P1", ["P1-T1"]));

    const result = await collectPlanArtifacts(cwd);
    expect(result.state).toBeNull();
    expect(result.fileIssues.some((i) => i.code === "SCHEMA_ERROR")).toBe(true);
    expect(result.skippedChecks).toContain("MISSING_PHASE_FILE");
  });
});
