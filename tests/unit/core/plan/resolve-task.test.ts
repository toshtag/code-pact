// Unit tests for src/core/plan/resolve-task.ts (P14-T6).
//
// The helper consolidates eight duplicated `resolveTaskPhase`
// implementations that previously lived inside each task-* command.
// These tests cover the helper directly; the existing per-command
// unit tests (which assert the same TASK_NOT_FOUND / AMBIGUOUS_TASK_ID
// emission shape) are the load-bearing regression net for the
// "behaviour-preserving refactor" claim and pass unchanged.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPlanState } from "../../../../src/core/plan/state.ts";
import {
  resolveTaskInPlanState,
  resolveTaskInRoadmap,
} from "../../../../src/core/plan/resolve-task.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-resolve-task-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function writeRoadmap(phases: { id: string; file: string }[]): Promise<void> {
  await writeFile(
    join(cwd, "design", "roadmap.yaml"),
    `phases:\n${phases
      .map(
        (p) =>
          `  - id: ${p.id}\n    path: design/phases/${p.file}\n    weight: 10\n`,
      )
      .join("")}`,
    "utf8",
  );
}

function phaseYaml(id: string, taskIds: string[]): string {
  return `id: ${id}
name: ${id}
weight: 10
confidence: medium
risk: low
status: planned
objective: ten-character objective filler
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
}

async function writePhase(filename: string, content: string): Promise<void> {
  await writeFile(join(cwd, "design", "phases", filename), content, "utf8");
}

describe("resolveTaskInRoadmap (I/O variant)", () => {
  it("returns { phaseId, phasePath } for a single match", async () => {
    await writeRoadmap([{ id: "P1", file: "P1.yaml" }]);
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"]));

    const result = await resolveTaskInRoadmap(cwd, "P1-T1");
    expect(result.phaseId).toBe("P1");
    expect(result.phasePath).toBe("design/phases/P1.yaml");
  });

  it("throws TASK_NOT_FOUND when no phase contains the task", async () => {
    await writeRoadmap([{ id: "P1", file: "P1.yaml" }]);
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"]));

    await expect(resolveTaskInRoadmap(cwd, "MISSING")).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
      message: 'Task "MISSING" not found in any phase.',
    });
  });

  it("throws AMBIGUOUS_TASK_ID with .phases listing every colliding phase", async () => {
    await writeRoadmap([
      { id: "P1", file: "P1.yaml" },
      { id: "P2", file: "P2.yaml" },
    ]);
    // Same task id in two phases — the impossible-in-practice state
    // that the resolver must still detect and report.
    await writePhase("P1.yaml", phaseYaml("P1", ["DUPE"]));
    await writePhase("P2.yaml", phaseYaml("P2", ["DUPE"]));

    let captured: (NodeJS.ErrnoException & { phases?: string[] }) | undefined;
    try {
      await resolveTaskInRoadmap(cwd, "DUPE");
    } catch (err) {
      captured = err as NodeJS.ErrnoException & { phases?: string[] };
    }
    expect(captured).toBeDefined();
    expect(captured!.code).toBe("AMBIGUOUS_TASK_ID");
    expect(captured!.message).toBe(
      'Task "DUPE" exists in multiple phases: P1, P2',
    );
    expect(captured!.phases).toEqual(["P1", "P2"]);
  });

  it("picks the correct phase + relative path among multiple", async () => {
    await writeRoadmap([
      { id: "P1", file: "P1.yaml" },
      { id: "P2", file: "P2.yaml" },
      { id: "P3", file: "P3.yaml" },
    ]);
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"]));
    await writePhase("P2.yaml", phaseYaml("P2", ["P2-T1", "P2-T2"]));
    await writePhase("P3.yaml", phaseYaml("P3", ["P3-T1"]));

    const result = await resolveTaskInRoadmap(cwd, "P2-T2");
    expect(result.phaseId).toBe("P2");
    expect(result.phasePath).toBe("design/phases/P2.yaml");
  });

  it("propagates the underlying ENOENT when roadmap.yaml is missing", async () => {
    // The helper does not invent its own error code for a missing
    // roadmap — that's a CONFIG_ERROR-style precondition the CLI
    // surface enforces upstream. Just make sure the raw error is
    // a recognisable ENOENT for any caller that wants to special-
    // case it.
    await expect(resolveTaskInRoadmap(cwd, "anything")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("resolveTaskInPlanState (pure variant)", () => {
  it("returns { phaseId, phase, task } for a single match", async () => {
    await writeRoadmap([{ id: "P1", file: "P1.yaml" }]);
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"]));
    const state = await loadPlanState(cwd);

    const result = resolveTaskInPlanState(state, "P1-T1");
    expect(result.phaseId).toBe("P1");
    expect(result.phase.id).toBe("P1");
    expect(result.task.id).toBe("P1-T1");
  });

  it("throws TASK_NOT_FOUND when the loaded PlanState has no match", async () => {
    await writeRoadmap([{ id: "P1", file: "P1.yaml" }]);
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"]));
    const state = await loadPlanState(cwd);

    expect(() => resolveTaskInPlanState(state, "MISSING")).toThrow(
      /not found in any phase/,
    );
  });

  it("detects ambiguity that PlanState.taskIndex silently elides", async () => {
    // PlanState.taskIndex picks the first match on collision; the
    // pure variant of the resolver must NOT inherit that behaviour
    // — it has to scan and surface every collision via .phases.
    await writeRoadmap([
      { id: "P1", file: "P1.yaml" },
      { id: "P2", file: "P2.yaml" },
    ]);
    await writePhase("P1.yaml", phaseYaml("P1", ["DUPE"]));
    await writePhase("P2.yaml", phaseYaml("P2", ["DUPE"]));
    const state = await loadPlanState(cwd);

    // taskIndex would silently return one match without complaint:
    expect(state.taskIndex.get("DUPE")?.phaseId).toBe("P1");

    // The resolver does not:
    let captured: (NodeJS.ErrnoException & { phases?: string[] }) | undefined;
    try {
      resolveTaskInPlanState(state, "DUPE");
    } catch (err) {
      captured = err as NodeJS.ErrnoException & { phases?: string[] };
    }
    expect(captured).toBeDefined();
    expect(captured!.code).toBe("AMBIGUOUS_TASK_ID");
    expect(captured!.message).toBe(
      'Task "DUPE" exists in multiple phases: P1, P2',
    );
    expect(captured!.phases).toEqual(["P1", "P2"]);
  });
});
