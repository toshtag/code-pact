import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { runPhaseImport } from "../../../src/commands/phase-import.ts";
import { Phase } from "../../../src/core/schemas/phase.ts";

const EMPTY_ROADMAP = `phases: []\n`;

async function setupEmptyProject(dir: string): Promise<void> {
  await mkdir(join(dir, "design", "phases"), { recursive: true });
  await writeFile(join(dir, "design", "roadmap.yaml"), EMPTY_ROADMAP, "utf8");
}

async function readRoadmap(dir: string): Promise<{
  raw: string;
  doc: { phases: { id: string; path: string; weight: number }[] };
}> {
  const raw = await readFile(join(dir, "design", "roadmap.yaml"), "utf8");
  const doc = parseYaml(raw) as {
    phases: { id: string; path: string; weight: number }[];
  };
  return { raw, doc };
}

async function listPhaseFiles(dir: string): Promise<string[]> {
  const { doc } = await readRoadmap(dir);
  return doc.phases.map((p) => p.path).sort();
}

async function writeInput(
  dir: string,
  contents: string,
  filename = "draft.yaml",
): Promise<string> {
  const p = join(dir, filename);
  await writeFile(p, contents, "utf8");
  return p;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-phase-import-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("runPhaseImport — happy path", () => {
  it("imports phases without tasks", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: Establish project foundation
  - id: P2
    name: Core
    weight: 18
    objective: Implement CLI
`,
    );

    const result = await runPhaseImport({ cwd: dir, inputPath });

    expect(result.imported_phases).toHaveLength(2);
    expect(result.imported_phases.map((p) => p.id)).toEqual(["P1", "P2"]);
    expect(result.imported_tasks).toEqual([]);
    expect(result.skipped_phases).toEqual([]);

    const { doc } = await readRoadmap(dir);
    expect(doc.phases.map((p) => p.id)).toEqual(["P1", "P2"]);
  });

  it("imports phases AND tasks; tasks are visible after parse", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: Establish foundation
    tasks:
      - id: P1-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: medium
        verification_strength: strong
        expected_duration: short
        status: planned
        description: First task
      - id: P1-T2
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: medium
        verification_strength: strong
        expected_duration: short
        status: planned
`,
    );

    const result = await runPhaseImport({ cwd: dir, inputPath });
    expect(result.imported_tasks).toEqual(["P1-T1", "P1-T2"]);

    // Confirm the written phase YAML round-trips through the Phase schema
    // and actually carries the tasks (the assertion that protects
    // task-context visibility post-import).
    const phaseRaw = await readFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      "utf8",
    );
    const phase = Phase.parse(parseYaml(phaseRaw) as unknown);
    expect(phase.tasks?.map((t) => t.id)).toEqual(["P1-T1", "P1-T2"]);
  });

  it("accepts the optional task readiness fields emitted by `plan prompt --schema-only`", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: Establish foundation
    tasks:
      - id: P1-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: medium
        verification_strength: strong
        expected_duration: short
        status: planned
        description: First task
        depends_on:
          - P0-T9
        reads:
          - src/lib/**
        writes:
          - src/feature/**
        decision_refs:
          - design/decisions/P1-T1-rfc.md
        acceptance_refs:
          - tests/unit/feature.test.ts
`,
    );

    const result = await runPhaseImport({ cwd: dir, inputPath });
    expect(result.imported_tasks).toEqual(["P1-T1"]);

    const phaseRaw = await readFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      "utf8",
    );
    const phase = Phase.parse(parseYaml(phaseRaw) as unknown);
    const task = phase.tasks!.find((t) => t.id === "P1-T1")!;
    expect(task.depends_on).toEqual(["P0-T9"]);
    expect(task.reads).toEqual(["src/lib/**"]);
    expect(task.writes).toEqual(["src/feature/**"]);
    expect(task.decision_refs).toEqual(["design/decisions/P1-T1-rfc.md"]);
    expect(task.acceptance_refs).toEqual(["tests/unit/feature.test.ts"]);
  });

  it("honors optional fields (confidence/risk/non_goals/requires_decision)", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: Establish foundation
    confidence: high
    risk: low
    non_goals:
      - Build full billing
    requires_decision: true
    verify_commands:
      - "echo ok"
    definition_of_done:
      - All tests pass
`,
    );

    await runPhaseImport({ cwd: dir, inputPath });

    const phaseRaw = await readFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      "utf8",
    );
    const phase = Phase.parse(parseYaml(phaseRaw) as unknown);
    expect(phase.confidence).toBe("high");
    expect(phase.risk).toBe("low");
    expect(phase.non_goals).toEqual(["Build full billing"]);
    expect(phase.requires_decision).toBe(true);
    expect(phase.verification.commands).toEqual(["echo ok"]);
    expect(phase.definition_of_done).toEqual(["All tests pass"]);
  });
});

// ---------------------------------------------------------------------------
// Validation failures (no writes)
// ---------------------------------------------------------------------------

describe("runPhaseImport — validation failures leave files byte-identical", () => {
  it("malformed YAML → CONFIG_ERROR, no writes", async () => {
    await setupEmptyProject(dir);
    const before = await readRoadmap(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: not a number
`,
    );

    await expect(
      runPhaseImport({ cwd: dir, inputPath }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });

    const after = await readRoadmap(dir);
    expect(after.raw).toBe(before.raw);
    expect(await listPhaseFiles(dir)).toEqual([]);
  });

  it("duplicate phase id within input → DUPLICATE_PHASE_ID, no writes", async () => {
    await setupEmptyProject(dir);
    const before = await readRoadmap(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: A
    weight: 1
    objective: a
  - id: P1
    name: B
    weight: 1
    objective: b
`,
    );

    await expect(
      runPhaseImport({ cwd: dir, inputPath }),
    ).rejects.toMatchObject({ code: "DUPLICATE_PHASE_ID" });

    const after = await readRoadmap(dir);
    expect(after.raw).toBe(before.raw);
  });

  it("duplicate task id within input → AMBIGUOUS_TASK_ID, no writes", async () => {
    await setupEmptyProject(dir);
    const before = await readRoadmap(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: A
    weight: 1
    objective: a
    tasks:
      - id: DUP-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: low
        verification_strength: weak
        expected_duration: short
        status: planned
  - id: P2
    name: B
    weight: 1
    objective: b
    tasks:
      - id: DUP-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: low
        verification_strength: weak
        expected_duration: short
        status: planned
`,
    );

    await expect(
      runPhaseImport({ cwd: dir, inputPath }),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_TASK_ID" });

    const after = await readRoadmap(dir);
    expect(after.raw).toBe(before.raw);
  });

  it("missing input file → CONFIG_ERROR", async () => {
    await setupEmptyProject(dir);
    await expect(
      runPhaseImport({ cwd: dir, inputPath: "nope.yaml" }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});

// ---------------------------------------------------------------------------
// Existing phase collisions
// ---------------------------------------------------------------------------

describe("runPhaseImport — collisions with existing roadmap", () => {
  async function seedWithExistingP1(): Promise<string> {
    await setupEmptyProject(dir);
    const firstInput = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Existing
    weight: 5
    objective: Existing P1
    tasks:
      - id: EXIST-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: low
        verification_strength: weak
        expected_duration: short
        status: planned
`,
      "seed.yaml",
    );
    await runPhaseImport({ cwd: dir, inputPath: firstInput });
    return firstInput;
  }

  it("colliding phase id without --force → DUPLICATE_PHASE_ID, no writes", async () => {
    await seedWithExistingP1();
    const before = await readRoadmap(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: New attempt
    weight: 10
    objective: Try to overwrite P1
  - id: P2
    name: Should not land either
    weight: 5
    objective: pre-write check blocks the whole input
`,
      "second.yaml",
    );

    await expect(
      runPhaseImport({ cwd: dir, inputPath }),
    ).rejects.toMatchObject({ code: "DUPLICATE_PHASE_ID" });

    const after = await readRoadmap(dir);
    expect(after.raw).toBe(before.raw);
  });

  it("--force skips colliding phases AND their tasks; imports the rest", async () => {
    await seedWithExistingP1();
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: New attempt
    weight: 10
    objective: Try to overwrite P1
    tasks:
      - id: SHOULD-NOT-LAND
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: low
        verification_strength: weak
        expected_duration: short
        status: planned
  - id: P2
    name: Brand new
    weight: 5
    objective: gets imported
`,
      "force.yaml",
    );

    const result = await runPhaseImport({ cwd: dir, inputPath, force: true });
    expect(result.imported_phases.map((p) => p.id)).toEqual(["P2"]);
    expect(result.imported_tasks).toEqual([]);
    expect(result.skipped_phases).toEqual(["P1"]);

    // Confirm SHOULD-NOT-LAND did NOT make it onto disk: scan every phase
    // file we actually wrote and assert the task id is absent.
    const { doc } = await readRoadmap(dir);
    for (const ref of doc.phases) {
      const raw = await readFile(join(dir, ref.path), "utf8");
      const phase = Phase.parse(parseYaml(raw) as unknown);
      expect(phase.tasks?.some((t) => t.id === "SHOULD-NOT-LAND")).not.toBe(true);
    }
  });

  it("--force does NOT bypass task collisions with existing kept phases", async () => {
    await seedWithExistingP1();
    const before = await readRoadmap(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P2
    name: New
    weight: 5
    objective: brand new phase, but reuses an existing task id
    tasks:
      - id: EXIST-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: low
        verification_strength: weak
        expected_duration: short
        status: planned
`,
      "task-collision.yaml",
    );

    await expect(
      runPhaseImport({ cwd: dir, inputPath, force: true }),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_TASK_ID" });

    const after = await readRoadmap(dir);
    expect(after.raw).toBe(before.raw);
  });
});

// ---------------------------------------------------------------------------
// Lenient import (TaskImport defaults)
// ---------------------------------------------------------------------------

describe("runPhaseImport — lenient import (AI-generated YAML)", () => {
  it("imports tasks with only id+description; fills defaults and reports completed_fields", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 10
    objective: Establish foundation
    tasks:
      - id: P1-T1
        description: Implement auth module
      - id: P1-T2
        description: Write tests
`,
    );

    const result = await runPhaseImport({ cwd: dir, inputPath });

    expect(result.imported_tasks).toEqual(["P1-T1", "P1-T2"]);
    // Both tasks had all detail fields missing → completed_fields has entries for both
    expect(result.completed_fields).toHaveLength(2);
    const t1Entry = result.completed_fields.find((cf) => cf.taskId === "P1-T1");
    expect(t1Entry).toBeDefined();
    expect(t1Entry!.fields).toContain("type");
    expect(t1Entry!.fields).toContain("ambiguity");
    expect(t1Entry!.fields).toContain("risk");
    expect(t1Entry!.fields).toContain("status");

    // Confirm the written phase passes Phase schema validation and has the tasks
    const phaseRaw = await readFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      "utf8",
    );
    const phase = Phase.parse(parseYaml(phaseRaw) as unknown);
    expect(phase.tasks?.map((t) => t.id)).toEqual(["P1-T1", "P1-T2"]);
    // Defaults should have been applied
    const firstTask = phase.tasks?.[0];
    expect(firstTask).toBeDefined();
    expect(firstTask!.type).toBe("feature");
    expect(firstTask!.status).toBe("planned");
    expect(firstTask!.ambiguity).toBe("medium");
  });

  it("imports tasks with all fields present; completed_fields is empty", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 10
    objective: Establish foundation
    tasks:
      - id: P1-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: low
        verification_strength: weak
        expected_duration: short
        status: planned
`,
    );

    const result = await runPhaseImport({ cwd: dir, inputPath });

    expect(result.imported_tasks).toEqual(["P1-T1"]);
    expect(result.completed_fields).toEqual([]);
  });

  it("partial fields: only some fields present; completed_fields tracks missing ones", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 10
    objective: Establish foundation
    tasks:
      - id: P1-T1
        type: bugfix
        status: in_progress
`,
    );

    const result = await runPhaseImport({ cwd: dir, inputPath });

    expect(result.imported_tasks).toEqual(["P1-T1"]);
    const t1Entry = result.completed_fields.find((cf) => cf.taskId === "P1-T1");
    expect(t1Entry).toBeDefined();
    // type and status were present, so they should NOT be in completed_fields
    expect(t1Entry!.fields).not.toContain("type");
    expect(t1Entry!.fields).not.toContain("status");
    // Missing detail fields should appear
    expect(t1Entry!.fields).toContain("ambiguity");
    expect(t1Entry!.fields).toContain("risk");
    expect(t1Entry!.fields).toContain("context_size");
  });

  it("--strict rejects tasks with missing fields", async () => {
    await setupEmptyProject(dir);
    const before = await readRoadmap(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 10
    objective: Establish foundation
    tasks:
      - id: P1-T1
        description: Only id provided
`,
    );

    await expect(
      runPhaseImport({ cwd: dir, inputPath, strict: true }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });

    // No writes
    const after = await readRoadmap(dir);
    expect(after.raw).toBe(before.raw);
  });

  it("--strict accepts tasks with all required fields present", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 10
    objective: Establish foundation
    tasks:
      - id: P1-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: low
        verification_strength: weak
        expected_duration: short
        status: planned
`,
    );

    const result = await runPhaseImport({ cwd: dir, inputPath, strict: true });

    expect(result.imported_tasks).toEqual(["P1-T1"]);
    expect(result.completed_fields).toEqual([]);
  });

  it("duplicate task ids in lenient import → AMBIGUOUS_TASK_ID, no writes", async () => {
    await setupEmptyProject(dir);
    const before = await readRoadmap(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: A
    weight: 5
    objective: first
    tasks:
      - id: SHARED-T1
        description: Task in P1
  - id: P2
    name: B
    weight: 5
    objective: second
    tasks:
      - id: SHARED-T1
        description: Same id in P2
`,
    );

    await expect(
      runPhaseImport({ cwd: dir, inputPath }),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_TASK_ID" });

    const after = await readRoadmap(dir);
    expect(after.raw).toBe(before.raw);
  });
});

// ---------------------------------------------------------------------------
// PR1 — verification.commands mis-shape advisory (PHASE_VERIFY_COMMANDS_MISSHAPED)
// ---------------------------------------------------------------------------

describe("runPhaseImport — verification.commands mis-shape advisory", () => {
  it("warnings is always present (field-presence-fixed) and empty for clean input", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 10
    objective: Clean canonical input
    verify_commands:
      - "echo ok"
`,
    );
    const result = await runPhaseImport({ cwd: dir, inputPath });
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("verification.commands ONLY → warning emitted AND verify command falls to default", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 10
    objective: Used the full Phase shape by mistake
    verification:
      commands:
        - "pnpm exec vitest run src/feature/"
`,
    );
    const result = await runPhaseImport({ cwd: dir, inputPath });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.code).toBe("PHASE_VERIFY_COMMANDS_MISSHAPED");
    expect(result.warnings[0]!.phase_id).toBe("P1");

    // The nested commands were dropped by zod → phase falls back to the
    // createPhase default, NOT the value the author intended.
    const phaseRaw = await readFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      "utf8",
    );
    const phase = Phase.parse(parseYaml(phaseRaw) as unknown);
    expect(phase.verification.commands).toEqual(["pnpm test"]);
    expect(phase.verification.commands).not.toContain(
      "pnpm exec vitest run src/feature/",
    );
  });

  it("BOTH verify_commands and verification.commands → warning AND verify_commands is canonical", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 10
    objective: Declares both shapes
    verify_commands:
      - "echo canonical"
    verification:
      commands:
        - "echo legacy-ignored"
`,
    );
    const result = await runPhaseImport({ cwd: dir, inputPath });

    // Regression guard: a warning must fire even though verify_commands is
    // present — otherwise the "if verify_commands exists, skip the warning"
    // shortcut would let the silently-ignored legacy block go unnoticed.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.code).toBe("PHASE_VERIFY_COMMANDS_MISSHAPED");
    expect(result.warnings[0]!.phase_id).toBe("P1");

    const phaseRaw = await readFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      "utf8",
    );
    const phase = Phase.parse(parseYaml(phaseRaw) as unknown);
    expect(phase.verification.commands).toEqual(["echo canonical"]);
    expect(phase.verification.commands).not.toContain("echo legacy-ignored");
  });
});

// ---------------------------------------------------------------------------
// P10 — Task Readiness Schema additions
// ---------------------------------------------------------------------------

describe("runPhaseImport — P10 Task Readiness Schema fields", () => {
  it("forwards declared depends_on / decision_refs / reads / writes / acceptance_refs to the written phase", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 10
    objective: Establish foundation
    tasks:
      - id: P1-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: low
        verification_strength: weak
        expected_duration: short
        status: planned
        depends_on:
          - P1-T2
        decision_refs:
          - design/decisions/stability-taxonomy.md
        reads:
          - src/core/schemas/task.ts
          - tests/**/*.test.ts
        writes:
          - src/core/schemas/task.ts
        acceptance_refs:
          - docs/cli-contract.md
      - id: P1-T2
        type: docs
        ambiguity: low
        risk: low
        context_size: small
        write_surface: low
        verification_strength: weak
        expected_duration: short
        status: planned
`,
    );

    const result = await runPhaseImport({ cwd: dir, inputPath });
    expect(result.imported_tasks).toEqual(["P1-T1", "P1-T2"]);
    // P10 fields are optional in TaskImport, so absent fields must
    // never appear in completed_fields (no synthetic default).
    const t1Entry = result.completed_fields.find((cf) => cf.taskId === "P1-T1");
    expect(t1Entry?.fields ?? []).not.toContain("depends_on");
    expect(t1Entry?.fields ?? []).not.toContain("reads");

    const phaseRaw = await readFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      "utf8",
    );
    const phase = Phase.parse(parseYaml(phaseRaw) as unknown);
    const t1 = phase.tasks?.find((t) => t.id === "P1-T1");
    expect(t1).toBeDefined();
    expect(t1!.depends_on).toEqual(["P1-T2"]);
    expect(t1!.decision_refs).toEqual([
      "design/decisions/stability-taxonomy.md",
    ]);
    expect(t1!.reads).toEqual([
      "src/core/schemas/task.ts",
      "tests/**/*.test.ts",
    ]);
    expect(t1!.writes).toEqual(["src/core/schemas/task.ts"]);
    expect(t1!.acceptance_refs).toEqual(["docs/cli-contract.md"]);

    // The task without P10 fields must not gain any.
    const t2 = phase.tasks?.find((t) => t.id === "P1-T2");
    expect(t2).toBeDefined();
    expect(t2!.depends_on).toBeUndefined();
    expect(t2!.decision_refs).toBeUndefined();
    expect(t2!.reads).toBeUndefined();
    expect(t2!.writes).toBeUndefined();
    expect(t2!.acceptance_refs).toBeUndefined();
  });

  it("legacy v1.0.x-shaped task (no P10 fields) imports unchanged", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 10
    objective: Establish foundation
    tasks:
      - id: P1-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: low
        verification_strength: weak
        expected_duration: short
        status: planned
`,
    );

    const result = await runPhaseImport({ cwd: dir, inputPath });
    expect(result.imported_tasks).toEqual(["P1-T1"]);
    // No P10 field in input → no P10 field in completed_fields.
    expect(result.completed_fields).toEqual([]);

    const phaseRaw = await readFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      "utf8",
    );
    const phase = Phase.parse(parseYaml(phaseRaw) as unknown);
    const t1 = phase.tasks?.[0];
    expect(t1?.depends_on).toBeUndefined();
    expect(t1?.decision_refs).toBeUndefined();
    expect(t1?.reads).toBeUndefined();
    expect(t1?.writes).toBeUndefined();
    expect(t1?.acceptance_refs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// v1.4 P13-T4: suggested_next_steps additive field
// ---------------------------------------------------------------------------

describe("runPhaseImport — suggested_next_steps (P13-T4)", () => {
  it("is always present (field-presence-fixed)", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 10
    objective: Phase A
`,
    );
    const result = await runPhaseImport({ cwd: dir, inputPath });
    expect(Array.isArray(result.suggested_next_steps)).toBe(true);
  });

  it("emits canonical post-import sequence (plan lint → phase runbook → task runbook)", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: Establish foundation
    tasks:
      - id: P1-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: medium
        verification_strength: strong
        expected_duration: short
        status: planned
        description: First task
`,
    );
    const result = await runPhaseImport({ cwd: dir, inputPath });
    const joined = result.suggested_next_steps.join("\n");
    expect(joined).toMatch(/plan lint --include-quality/);
    expect(joined).toMatch(/clarify advisor(?:y|ies)/);
    expect(joined).toContain("TASK_DECISION_UNRESOLVED");
    expect(joined).toMatch(/phase runbook P1/);
    expect(joined).toMatch(/task runbook P1-T1/);
  });

  it("emits one phase-runbook step per imported phase", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 10
    objective: First
  - id: P2
    name: Core
    weight: 10
    objective: Second
`,
    );
    const result = await runPhaseImport({ cwd: dir, inputPath });
    const phaseRunbookSteps = result.suggested_next_steps.filter((s) =>
      s.includes("phase runbook"),
    );
    expect(phaseRunbookSteps.length).toBe(2);
    expect(phaseRunbookSteps[0]).toMatch(/phase runbook P1/);
    expect(phaseRunbookSteps[1]).toMatch(/phase runbook P2/);
  });

  it("prepends a defaults-review hint when completed_fields is non-empty (lenient mode)", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 10
    objective: Lenient-mode test
    tasks:
      - id: P1-T1
        description: only id + description provided
`,
    );
    const result = await runPhaseImport({ cwd: dir, inputPath });
    expect(result.completed_fields.length).toBeGreaterThan(0);
    expect(result.suggested_next_steps[0]).toMatch(/completed_fields/);
    expect(result.suggested_next_steps[0]).toMatch(/source-of-truth/);
  });

  it("omits the defaults-review hint when completed_fields is empty", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 10
    objective: All fields explicit
    tasks:
      - id: P1-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: medium
        verification_strength: strong
        expected_duration: short
        status: planned
        description: Fully specified
`,
    );
    const result = await runPhaseImport({ cwd: dir, inputPath });
    expect(result.completed_fields).toEqual([]);
    // First step should be `plan lint`, not the defaults-review hint.
    expect(result.suggested_next_steps[0]).toMatch(/plan lint/);
  });

  it("returns empty suggested_next_steps when nothing was imported (every phase skipped)", async () => {
    await setupEmptyProject(dir);
    // First import lands P1.
    const first = await writeInput(
      dir,
      `phases:
  - id: P1
    name: First
    weight: 10
    objective: Already imported
`,
    );
    await runPhaseImport({ cwd: dir, inputPath: first });

    // Second import re-attempts P1 with --force → skipped, no imports.
    const second = await writeInput(
      dir,
      `phases:
  - id: P1
    name: First again
    weight: 10
    objective: Collides
`,
    );
    const result = await runPhaseImport({
      cwd: dir,
      inputPath: second,
      force: true,
    });
    expect(result.imported_phases).toEqual([]);
    expect(result.skipped_phases).toEqual(["P1"]);
    expect(result.suggested_next_steps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --scaffold-decisions (RFC §3-D)
// ---------------------------------------------------------------------------

describe("runPhaseImport — scaffold decisions (RFC §3-D)", () => {
  async function adrExists(d: string, rel: string): Promise<boolean> {
    try {
      await readFile(join(d, rel), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  const phaseWithDecisionTask = (extra = ""): string =>
    `phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: Establish foundation
    tasks:
      - id: P1-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: low
        verification_strength: weak
        expected_duration: short
        status: planned
        description: x
        requires_decision: true${extra}
`;

  it("scaffolds design/decisions/<id>.md (proposed) for a task-level requires_decision task", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(dir, phaseWithDecisionTask());
    const result = await runPhaseImport({ cwd: dir, inputPath, scaffoldDecisions: true });

    expect(result.scaffolded_decisions).toEqual(["design/decisions/P1-T1.md"]);
    expect(result.scaffold_skipped).toEqual([]);
    expect(await adrExists(dir, "design/decisions/P1-T1.md")).toBe(true);
    const content = await readFile(join(dir, "design", "decisions", "P1-T1.md"), "utf8");
    expect(content).toContain("**Status:** proposed");
  });

  it("does NOT scaffold without the flag", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(dir, phaseWithDecisionTask());
    const result = await runPhaseImport({ cwd: dir, inputPath });
    expect(result.scaffolded_decisions).toEqual([]);
    expect(result.scaffold_skipped).toEqual([]);
    expect(await adrExists(dir, "design/decisions/P1-T1.md")).toBe(false);
  });

  it("scaffolds for a PHASE-level requires_decision task (effective-gate parity)", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: Establish foundation
    requires_decision: true
    tasks:
      - id: P1-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: low
        verification_strength: weak
        expected_duration: short
        status: planned
        description: x
`,
    );
    const result = await runPhaseImport({ cwd: dir, inputPath, scaffoldDecisions: true });
    expect(result.scaffolded_decisions).toEqual(["design/decisions/P1-T1.md"]);
  });

  it("scaffolds a missing decision_ref under design/decisions/, leaving the task shape unchanged", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      phaseWithDecisionTask(`
        decision_refs:
          - design/decisions/P1-T1-rfc.md`),
    );
    const result = await runPhaseImport({ cwd: dir, inputPath, scaffoldDecisions: true });
    expect(result.scaffolded_decisions).toEqual(["design/decisions/P1-T1-rfc.md"]);
    expect(await adrExists(dir, "design/decisions/P1-T1-rfc.md")).toBe(true);
    // Task shape unchanged: decision_refs preserved as written.
    const phaseRaw = await readFile(join(dir, "design", "phases", "P1-foundation.yaml"), "utf8");
    const phase = Phase.parse(parseYaml(phaseRaw) as unknown);
    expect(phase.tasks!.find((t) => t.id === "P1-T1")!.decision_refs).toEqual([
      "design/decisions/P1-T1-rfc.md",
    ]);
  });

  it("never overwrites an existing decision_ref file", async () => {
    await setupEmptyProject(dir);
    await mkdir(join(dir, "design", "decisions"), { recursive: true });
    await writeFile(join(dir, "design", "decisions", "P1-T1-rfc.md"), "original\n", "utf8");
    const inputPath = await writeInput(
      dir,
      phaseWithDecisionTask(`
        decision_refs:
          - design/decisions/P1-T1-rfc.md`),
    );
    const result = await runPhaseImport({ cwd: dir, inputPath, scaffoldDecisions: true });
    expect(result.scaffolded_decisions).toEqual([]);
    const content = await readFile(join(dir, "design", "decisions", "P1-T1-rfc.md"), "utf8");
    expect(content).toBe("original\n");
  });

  it("reports a safe decision_ref OUTSIDE design/decisions/ as scaffold_skipped; phases still imported", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      phaseWithDecisionTask(`
        decision_refs:
          - docs/foo.md`),
    );
    const result = await runPhaseImport({ cwd: dir, inputPath, scaffoldDecisions: true });
    expect(result.imported_phases).toHaveLength(1);
    expect(result.scaffolded_decisions).toEqual([]);
    expect(result.scaffold_skipped).toEqual([
      { ref: "docs/foo.md", reason: "outside design/decisions/" },
    ]);
    expect(await adrExists(dir, "docs/foo.md")).toBe(false);
  });

  it("rejects an UNSAFE decision_ref with CONFIG_ERROR and writes nothing (atomic)", async () => {
    await setupEmptyProject(dir);
    const before = (await readRoadmap(dir)).raw;
    const inputPath = await writeInput(
      dir,
      phaseWithDecisionTask(`
        decision_refs:
          - ../escape.md`),
    );
    await expect(
      runPhaseImport({ cwd: dir, inputPath, scaffoldDecisions: true }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect((await readRoadmap(dir)).raw).toBe(before);
    expect(await listPhaseFiles(dir)).toEqual([]);
  });

  it("rejects an UNSAFE task id (P1/T1) with CONFIG_ERROR and writes nothing", async () => {
    await setupEmptyProject(dir);
    const before = (await readRoadmap(dir)).raw;
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: Establish foundation
    tasks:
      - id: P1/T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: low
        verification_strength: weak
        expected_duration: short
        status: planned
        description: x
        requires_decision: true
`,
    );
    await expect(
      runPhaseImport({ cwd: dir, inputPath, scaffoldDecisions: true }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect((await readRoadmap(dir)).raw).toBe(before);
    expect(await listPhaseFiles(dir)).toEqual([]);
  });

  it("rejects an UNSAFE phase id (../evil) at parse with CONFIG_ERROR and writes nothing", async () => {
    await setupEmptyProject(dir);
    const before = (await readRoadmap(dir)).raw;
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: ../evil
    name: Foundation
    weight: 12
    objective: Establish foundation
`,
    );
    await expect(
      runPhaseImport({ cwd: dir, inputPath }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect((await readRoadmap(dir)).raw).toBe(before);
    expect(await listPhaseFiles(dir)).toEqual([]);
  });

  it("rejects an UNSAFE task id with shell metacharacters at parse with CONFIG_ERROR", async () => {
    await setupEmptyProject(dir);
    const before = (await readRoadmap(dir)).raw;
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: Establish foundation
    tasks:
      - id: "P1-T1; echo owned"
        type: feature
`,
    );
    await expect(
      runPhaseImport({ cwd: dir, inputPath }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect((await readRoadmap(dir)).raw).toBe(before);
    expect(await listPhaseFiles(dir)).toEqual([]);
  });

  it("does not scaffold when a matching ADR filename already exists (default path)", async () => {
    await setupEmptyProject(dir);
    await mkdir(join(dir, "design", "decisions"), { recursive: true });
    await writeFile(join(dir, "design", "decisions", "P1-T1-existing.md"), "**Status:** accepted\n", "utf8");
    const inputPath = await writeInput(dir, phaseWithDecisionTask());
    const result = await runPhaseImport({ cwd: dir, inputPath, scaffoldDecisions: true });
    expect(result.scaffolded_decisions).toEqual([]);
    expect(await adrExists(dir, "design/decisions/P1-T1.md")).toBe(false);
  });

  it("substring collision: scaffolding P1-T1 is skipped when P1-T10.md already exists (pins the shared filename rule)", async () => {
    await setupEmptyProject(dir);
    await mkdir(join(dir, "design", "decisions"), { recursive: true });
    await writeFile(join(dir, "design", "decisions", "P1-T10.md"), "**Status:** accepted\n", "utf8");
    const inputPath = await writeInput(dir, phaseWithDecisionTask());
    const result = await runPhaseImport({ cwd: dir, inputPath, scaffoldDecisions: true });
    expect(result.scaffolded_decisions).toEqual([]);
    expect(await adrExists(dir, "design/decisions/P1-T1.md")).toBe(false);
  });

  it("does not scaffold a task without requires_decision", async () => {
    await setupEmptyProject(dir);
    const inputPath = await writeInput(
      dir,
      `phases:
  - id: P1
    name: Foundation
    weight: 12
    objective: Establish foundation
    tasks:
      - id: P1-T1
        type: feature
        ambiguity: low
        risk: low
        context_size: small
        write_surface: low
        verification_strength: weak
        expected_duration: short
        status: planned
        description: x
`,
    );
    const result = await runPhaseImport({ cwd: dir, inputPath, scaffoldDecisions: true });
    expect(result.scaffolded_decisions).toEqual([]);
    expect(await adrExists(dir, "design/decisions/P1-T1.md")).toBe(false);
  });
});
