import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { runInit } from "../../../src/commands/init.ts";
import { runPhaseAdd, runPhaseLs, runPhaseShow } from "../../../src/commands/phase.ts";
import { Phase } from "../../../src/core/schemas/phase.ts";
import { Roadmap } from "../../../src/core/schemas/roadmap.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-phase-test-"));
  // Each test needs an initialized project
  await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readYaml(rel: string): Promise<unknown> {
  const raw = await readFile(join(dir, rel), "utf8");
  return parseYaml(raw);
}

const BASE_ADD_OPTS = {
  name: "Foundation",
  weight: 12,
  objective: "Establish project foundation.",
  confidence: "high" as const,
  risk: "low" as const,
  verifyCommands: ["pnpm test"],
  definitionOfDone: ["CI passes"],
};

// ---------------------------------------------------------------------------
// phase add
// ---------------------------------------------------------------------------

describe("runPhaseAdd", () => {
  it("creates the phase YAML file", async () => {
    await runPhaseAdd({ cwd: dir, id: "P1", ...BASE_ADD_OPTS });
    const data = await readYaml("design/phases/P1-foundation.yaml");
    const phase = Phase.parse(data);
    expect(phase.id).toBe("P1");
    expect(phase.name).toBe("Foundation");
    expect(phase.weight).toBe(12);
    expect(phase.status).toBe("planned");
  });

  it("appends a PhaseRef to roadmap.yaml", async () => {
    await runPhaseAdd({ cwd: dir, id: "P1", ...BASE_ADD_OPTS });
    const roadmap = Roadmap.parse(await readYaml("design/roadmap.yaml"));
    expect(roadmap.phases).toHaveLength(1);
    expect(roadmap.phases[0]?.id).toBe("P1");
    expect(roadmap.phases[0]?.weight).toBe(12);
  });

  it("appends multiple phases preserving order", async () => {
    await runPhaseAdd({ cwd: dir, id: "P1", ...BASE_ADD_OPTS });
    await runPhaseAdd({ cwd: dir, id: "P2", ...BASE_ADD_OPTS, name: "Core", weight: 18 });
    const roadmap = Roadmap.parse(await readYaml("design/roadmap.yaml"));
    expect(roadmap.phases).toHaveLength(2);
    expect(roadmap.phases[0]?.id).toBe("P1");
    expect(roadmap.phases[1]?.id).toBe("P2");
  });

  it("slugifies the phase name for the filename", async () => {
    await runPhaseAdd({ cwd: dir, id: "P1", ...BASE_ADD_OPTS, name: "My Cool Phase!" });
    const roadmap = Roadmap.parse(await readYaml("design/roadmap.yaml"));
    expect(roadmap.phases[0]?.path).toBe("design/phases/P1-my-cool-phase.yaml");
  });

  it("returns the relative path and PhaseRef", async () => {
    const result = await runPhaseAdd({ cwd: dir, id: "P1", ...BASE_ADD_OPTS });
    expect(result.path).toBe("design/phases/P1-foundation.yaml");
    expect(result.ref.id).toBe("P1");
  });

  it("throws DUPLICATE_PHASE_ID on duplicate id", async () => {
    await runPhaseAdd({ cwd: dir, id: "P1", ...BASE_ADD_OPTS });
    await expect(
      runPhaseAdd({ cwd: dir, id: "P1", ...BASE_ADD_OPTS }),
    ).rejects.toMatchObject({ code: "DUPLICATE_PHASE_ID" });
  });
});

// ---------------------------------------------------------------------------
// phase ls
// ---------------------------------------------------------------------------

describe("runPhaseLs", () => {
  it("returns empty array when roadmap has no phases", async () => {
    const items = await runPhaseLs({ cwd: dir });
    expect(items).toHaveLength(0);
  });

  it("returns all phases when no status filter", async () => {
    await runPhaseAdd({ cwd: dir, id: "P1", ...BASE_ADD_OPTS });
    await runPhaseAdd({ cwd: dir, id: "P2", ...BASE_ADD_OPTS, name: "Core", weight: 18 });
    const items = await runPhaseLs({ cwd: dir });
    expect(items).toHaveLength(2);
  });

  it("filters by status", async () => {
    await runPhaseAdd({ cwd: dir, id: "P1", ...BASE_ADD_OPTS });
    // P1 is planned; nothing is done
    const done = await runPhaseLs({ cwd: dir, status: "done" });
    expect(done).toHaveLength(0);
    const planned = await runPhaseLs({ cwd: dir, status: "planned" });
    expect(planned).toHaveLength(1);
  });

  it("each item has the required fields", async () => {
    await runPhaseAdd({ cwd: dir, id: "P1", ...BASE_ADD_OPTS });
    const [item] = await runPhaseLs({ cwd: dir });
    expect(item).toMatchObject({ id: "P1", name: "Foundation", weight: 12, status: "planned", risk: "low" });
  });
});

// ---------------------------------------------------------------------------
// phase show
// ---------------------------------------------------------------------------

describe("runPhaseShow", () => {
  it("returns the full Phase object for a known id", async () => {
    await runPhaseAdd({ cwd: dir, id: "P1", ...BASE_ADD_OPTS });
    const phase = await runPhaseShow({ cwd: dir, id: "P1" });
    expect(Phase.safeParse(phase).success).toBe(true);
    expect(phase.id).toBe("P1");
    expect(phase.verification.commands).toContain("pnpm test");
  });

  it("throws PHASE_NOT_FOUND for unknown id", async () => {
    await expect(runPhaseShow({ cwd: dir, id: "NOPE" })).rejects.toMatchObject({
      code: "PHASE_NOT_FOUND",
    });
  });
});

// ---------------------------------------------------------------------------
// fixture: project-a
// ---------------------------------------------------------------------------

describe("runPhaseLs against project-a fixture", () => {
  it("reads both phases from the fixture roadmap", async () => {
    const fixtureDir = new URL("../../../tests/fixtures/project-a", import.meta.url).pathname;
    const items = await runPhaseLs({ cwd: fixtureDir });
    expect(items).toHaveLength(2);
    const ids = items.map((i) => i.id);
    expect(ids).toContain("P1");
    expect(ids).toContain("P2");
  });

  it("phase show returns valid Phase for P2", async () => {
    const fixtureDir = new URL("../../../tests/fixtures/project-a", import.meta.url).pathname;
    const phase = await runPhaseShow({ cwd: fixtureDir, id: "P2" });
    expect(phase.id).toBe("P2");
    expect(phase.requires_decision).toBe(true);
    expect(phase.tasks?.length).toBeGreaterThan(0);
  });
});
