// P38-T1 — write-entrypoint coverage.
//
// Runs the shared security corpus (tests/fixtures/security-corpus.ts) through
// EVERY plan/agent write entrypoint and schema boundary, so the traversal /
// injection / option-confusion class can't be re-opened one site at a time the
// way the 1.26.0 review found it (PlanId / RelativePosixPath were applied to
// read schemas but missed on phase import, createPhase, task add, recommend,
// pack, and agent-profile path fields, across several rounds).
//
// The ENTRYPOINTS inventories below are the pinned list: a `count`/name
// assertion makes the inventory tripwire if an entrypoint is added or removed
// without updating it. (It catches inventory edits, not silent omissions —
// the PR self-report template in P38-T3 is the authoring-time backstop for
// "did you wire the new write entrypoint into the corpus?".)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BAD_PLAN_IDS,
  GOOD_PLAN_IDS,
  BAD_RELATIVE_PATHS,
  GOOD_RELATIVE_PATHS,
} from "../../fixtures/security-corpus.ts";

import { PlanId } from "../../../src/core/schemas/plan-id.ts";
import { RelativePosixPath } from "../../../src/core/schemas/relative-path.ts";
import { Task } from "../../../src/core/schemas/task.ts";
import { Phase } from "../../../src/core/schemas/phase.ts";
import { PhaseRef } from "../../../src/core/schemas/roadmap.ts";
import { AgentRef } from "../../../src/core/schemas/project.ts";
import { AgentProfile } from "../../../src/core/schemas/agent-profile.ts";
import { TaskImport, PhaseImportEntry } from "../../../src/core/schemas/phase-import.ts";

import { runInit } from "../../../src/commands/init.ts";
import { createPhase } from "../../../src/core/services/createPhase.ts";
import { runTaskAdd } from "../../../src/commands/task-add.ts";
import { runRecommend } from "../../../src/commands/recommend.ts";
import { runPack } from "../../../src/commands/pack.ts";

// --- valid fixtures so safeParse only fails on the field under test ---------

const VALID_TASK = {
  id: "P1-T1",
  type: "feature",
  ambiguity: "low",
  risk: "low",
  context_size: "small",
  write_surface: "low",
  verification_strength: "strong",
  expected_duration: "short",
  status: "planned",
} as const;

const VALID_PHASE = {
  id: "P1",
  name: "Phase one",
  weight: 10,
  confidence: "high",
  risk: "low",
  status: "planned",
  objective: "do the thing",
  definition_of_done: ["it is done"],
  verification: { commands: ["pnpm test"] },
} as const;

const VALID_PROFILE = {
  name: "claude-code",
  instruction_filename: "CLAUDE.md",
  context_dir: ".context/claude-code",
  model_map: { balanced_coding: "claude-sonnet-4-6" },
} as const;

// ---------------------------------------------------------------------------
// Schema boundaries — id fields (PlanId charset)
// ---------------------------------------------------------------------------

const ID_SCHEMA_ENTRYPOINTS: ReadonlyArray<{
  name: string;
  parse: (v: string) => { success: boolean };
}> = [
  { name: "PlanId", parse: (v) => PlanId.safeParse(v) },
  { name: "Task.id", parse: (v) => Task.safeParse({ ...VALID_TASK, id: v }) },
  { name: "Phase.id", parse: (v) => Phase.safeParse({ ...VALID_PHASE, id: v }) },
  {
    name: "Roadmap.PhaseRef.id",
    parse: (v) => PhaseRef.safeParse({ id: v, path: "design/phases/P1.yaml", weight: 10 }),
  },
  {
    name: "AgentRef.name",
    parse: (v) => AgentRef.safeParse({ name: v, profile: "agent-profiles/claude-code.yaml" }),
  },
  { name: "AgentProfile.name", parse: (v) => AgentProfile.safeParse({ ...VALID_PROFILE, name: v }) },
  { name: "TaskImport.id", parse: (v) => TaskImport.safeParse({ id: v }) },
  {
    name: "PhaseImportEntry.id",
    parse: (v) => PhaseImportEntry.safeParse({ id: v, name: "n", weight: 1, objective: "o" }),
  },
];

describe("write-entrypoint coverage — id schemas reject BAD_PLAN_IDS", () => {
  for (const ep of ID_SCHEMA_ENTRYPOINTS) {
    it.each(BAD_PLAN_IDS)(`${ep.name} rejects %j`, (bad) => {
      expect(ep.parse(bad).success).toBe(false);
    });
    it.each(GOOD_PLAN_IDS)(`${ep.name} accepts %j`, (good) => {
      expect(ep.parse(good).success).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Schema boundaries — path fields (RelativePosixPath)
// ---------------------------------------------------------------------------

const PATH_SCHEMA_ENTRYPOINTS: ReadonlyArray<{
  name: string;
  parse: (v: string) => { success: boolean };
}> = [
  { name: "RelativePosixPath", parse: (v) => RelativePosixPath.safeParse(v) },
  {
    name: "AgentProfile.instruction_filename",
    parse: (v) => AgentProfile.safeParse({ ...VALID_PROFILE, instruction_filename: v }),
  },
  {
    name: "AgentProfile.context_dir",
    parse: (v) => AgentProfile.safeParse({ ...VALID_PROFILE, context_dir: v }),
  },
  {
    name: "AgentProfile.skill_dir",
    parse: (v) => AgentProfile.safeParse({ ...VALID_PROFILE, skill_dir: v }),
  },
  {
    name: "AgentProfile.hook_dir",
    parse: (v) => AgentProfile.safeParse({ ...VALID_PROFILE, hook_dir: v }),
  },
  {
    name: "AgentRef.profile",
    parse: (v) => AgentRef.safeParse({ name: "claude-code", profile: v }),
  },
];

describe("write-entrypoint coverage — path schemas reject BAD_RELATIVE_PATHS", () => {
  for (const ep of PATH_SCHEMA_ENTRYPOINTS) {
    it.each(BAD_RELATIVE_PATHS)(`${ep.name} rejects %j`, (bad) => {
      expect(ep.parse(bad).success).toBe(false);
    });
    it.each(GOOD_RELATIVE_PATHS)(`${ep.name} accepts %j`, (good) => {
      expect(ep.parse(good).success).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Runtime write entrypoints — the command paths that build a filesystem path
// or a command string from a raw id / agent name before any schema parse.
// ---------------------------------------------------------------------------

const RUNTIME_ENTRYPOINTS = [
  "createPhase(id)",
  "task add --id",
  "recommend --agent",
  "pack --agent",
] as const;

describe("write-entrypoint coverage — runtime commands reject unsafe input", () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), "code-pact-p38-cov-"));
    await runInit({ cwd, locale: "en-US", agents: ["claude-code"], force: false, json: false });
    // Seed a real phase + task so recommend / pack reach the agent-name guard.
    await createPhase({
      cwd,
      id: "P1",
      name: "Foundation",
      weight: 10,
      objective: "Foundation for the coverage test",
      tasks: [{ ...VALID_TASK }],
    });
  }, 30_000);

  afterAll(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it.each(BAD_PLAN_IDS)("createPhase rejects unsafe id %j", async (bad) => {
    await expect(
      createPhase({ cwd, id: bad, name: "x", weight: 1, objective: "x" }),
    ).rejects.toThrow();
  });

  it.each(BAD_PLAN_IDS)("task add rejects unsafe --id %j", async (bad) => {
    await expect(
      runTaskAdd({
        cwd,
        phaseId: "P1",
        locale: "en-US",
        id: bad,
        nonInteractive: { type: "feature", description: "x" },
      }),
    ).rejects.toThrow();
  });

  it.each(BAD_PLAN_IDS)("recommend rejects unsafe --agent %j", async (bad) => {
    await expect(
      runRecommend({ cwd, phaseId: "P1", taskId: "P1-T1", agentName: bad }),
    ).rejects.toThrow();
  });

  it.each(BAD_PLAN_IDS)("pack rejects unsafe --agent %j", async (bad) => {
    await expect(
      runPack({ cwd, phaseId: "P1", taskId: "P1-T1", agentName: bad }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Inventory pin — the documented set of covered entrypoints. Update these
// lists (and wire the corpus through the new entrypoint above) whenever a
// plan/agent write entrypoint is added or removed.
// ---------------------------------------------------------------------------

describe("write-entrypoint inventory is pinned", () => {
  it("id-schema entrypoints match the documented inventory", () => {
    expect(ID_SCHEMA_ENTRYPOINTS.map((e) => e.name).sort()).toEqual(
      [
        "AgentProfile.name",
        "AgentRef.name",
        "Phase.id",
        "PhaseImportEntry.id",
        "PlanId",
        "Roadmap.PhaseRef.id",
        "Task.id",
        "TaskImport.id",
      ].sort(),
    );
  });

  it("path-schema entrypoints match the documented inventory", () => {
    expect(PATH_SCHEMA_ENTRYPOINTS.map((e) => e.name).sort()).toEqual(
      [
        "AgentProfile.context_dir",
        "AgentProfile.hook_dir",
        "AgentProfile.instruction_filename",
        "AgentProfile.skill_dir",
        "AgentRef.profile",
        "RelativePosixPath",
      ].sort(),
    );
  });

  it("runtime command entrypoints match the documented inventory", () => {
    expect([...RUNTIME_ENTRYPOINTS].sort()).toEqual(
      ["createPhase(id)", "pack --agent", "recommend --agent", "task add --id"].sort(),
    );
  });
});
