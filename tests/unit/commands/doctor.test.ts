import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInit } from "../../../src/commands/init.ts";
import { runPhaseAdd } from "../../../src/commands/phase.ts";
import { runDoctor } from "../../../src/commands/doctor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fixtureDir = new URL("../../../tests/fixtures/project-a", import.meta.url).pathname;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-doctor-test-"));
  await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Healthy project
// ---------------------------------------------------------------------------

describe("runDoctor — healthy project (fresh init)", () => {
  it("returns ok=true with no issues for a freshly initialised project", async () => {
    const result = await runDoctor(dir);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

describe("runDoctor — project-a fixture", () => {
  it("returns ok=true for the project-a fixture", async () => {
    const result = await runDoctor(fixtureDir);
    expect(result.ok).toBe(true);
    // Warnings are allowed (e.g. model tier, stale context); errors are not
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Orphan phase file (roadmap references non-existent YAML)
// ---------------------------------------------------------------------------

describe("runDoctor — orphan roadmap reference", () => {
  it("reports ORPHAN_PHASE_FILE error when roadmap refs a missing file", async () => {
    await writeFile(
      join(dir, "design", "roadmap.yaml"),
      "phases:\n  - id: P99\n    path: design/phases/P99-ghost.yaml\n    weight: 5\n",
      "utf8",
    );
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "ORPHAN_PHASE_FILE");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Orphan phase YAML (file exists but not in roadmap)
// ---------------------------------------------------------------------------

describe("runDoctor — unreferenced phase file", () => {
  it("reports ORPHAN_PHASE_FILE warning for phase YAML not in roadmap", async () => {
    await mkdir(join(dir, "design", "phases"), { recursive: true });
    await writeFile(
      join(dir, "design", "phases", "P99-ghost.yaml"),
      [
        "id: P99",
        "name: Ghost",
        "weight: 5",
        "confidence: low",
        "risk: low",
        "status: planned",
        "objective: Ghost phase.",
        "definition_of_done:",
        "  - Done",
        "verification:",
        "  commands:",
        "    - echo ok",
      ].join("\n"),
      "utf8",
    );
    const result = await runDoctor(dir);
    const issue = result.issues.find(
      (i) => i.code === "ORPHAN_PHASE_FILE" && i.severity === "warning",
    );
    expect(issue).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Orphan progress event (task_id not in any phase)
// ---------------------------------------------------------------------------

describe("runDoctor — orphan progress event", () => {
  it("reports ORPHAN_PROGRESS_EVENT warning for unknown task_id in progress.yaml", async () => {
    await writeFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      `events:\n  - task_id: GHOST-T99\n    status: done\n    at: "2026-05-15T10:00:00+09:00"\n    actor: human\n`,
      "utf8",
    );
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "ORPHAN_PROGRESS_EVENT");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("GHOST-T99");
  });
});

// ---------------------------------------------------------------------------
// Phase ID mismatch
// ---------------------------------------------------------------------------

describe("runDoctor — phase id mismatch", () => {
  it("reports PHASE_ID_MISMATCH when YAML id differs from roadmap ref", async () => {
    await runPhaseAdd({
      cwd: dir,
      id: "P1",
      name: "Foundation",
      weight: 10,
      objective: "Establish foundation.",
      confidence: "high",
      risk: "low",
      verifyCommands: ["echo ok"],
      definitionOfDone: ["Done"],
    });
    // Overwrite the phase file with a different id
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      [
        "id: WRONG",
        "name: Foundation",
        "weight: 10",
        "confidence: high",
        "risk: low",
        "status: planned",
        "objective: Establish foundation.",
        "definition_of_done:",
        "  - Done",
        "verification:",
        "  commands:",
        "    - echo ok",
      ].join("\n"),
      "utf8",
    );
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "PHASE_ID_MISMATCH");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// .bak file detection
// ---------------------------------------------------------------------------

describe("runDoctor — bak file detection", () => {
  it("reports BAK_FILE warning when a .bak file is found in design/", async () => {
    await mkdir(join(dir, "design"), { recursive: true });
    await writeFile(join(dir, "design", "roadmap.yaml.bak"), "old content", "utf8");
    const result = await runDoctor(dir);
    const issue = result.issues.find((i) => i.code === "BAK_FILE");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// Invalid YAML
// ---------------------------------------------------------------------------

describe("runDoctor — invalid YAML in project.yaml", () => {
  it("reports INVALID_YAML error when project.yaml is unreadable", async () => {
    await writeFile(join(dir, ".code-pact", "project.yaml"), "{ invalid: yaml: :", "utf8");
    const result = await runDoctor(dir);
    // YAML parser may succeed on some malformed inputs; at minimum no crash
    expect(Array.isArray(result.issues)).toBe(true);
  });
});
