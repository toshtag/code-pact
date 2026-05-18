import { describe, expect, it } from "vitest";
import {
  detectDuplicatePhaseIds,
  detectDuplicateTaskIds,
  detectOrphanProgressEvents,
  detectPhaseIdMismatches,
  detectPhaseIdNaming,
  detectTaskIdPhasePrefix,
} from "../../../../src/core/plan/checks.ts";
import type { PhaseEntry } from "../../../../src/core/plan/state.ts";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import type { Task } from "../../../../src/core/schemas/task.ts";
import type { Phase } from "../../../../src/core/schemas/phase.ts";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    type: "feature",
    ambiguity: "low",
    risk: "low",
    context_size: "small",
    write_surface: "low",
    verification_strength: "medium",
    expected_duration: "short",
    status: "planned",
    ...overrides,
  };
}

function phase(
  id: string,
  tasks: Task[] = [],
  overrides: Partial<Phase> = {},
): Phase {
  return {
    id,
    name: id,
    weight: 10,
    confidence: "medium",
    risk: "low",
    status: "planned",
    objective: "Test objective long enough",
    definition_of_done: ["does the thing"],
    verification: { commands: ["pnpm test"] },
    tasks,
    ...overrides,
  };
}

function entry(p: Phase, refId = p.id): PhaseEntry {
  return {
    ref: { id: refId, path: `design/phases/${p.id}.yaml`, weight: p.weight },
    absPath: `/tmp/${p.id}.yaml`,
    phase: p,
  };
}

describe("detectDuplicateTaskIds", () => {
  it("returns empty when all task ids are unique", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1"), task("P1-T2")])),
      entry(phase("P2", [task("P2-T1")])),
    ];
    expect(detectDuplicateTaskIds(entries)).toEqual([]);
  });

  it("reports the second occurrence across phases", () => {
    const entries = [
      entry(phase("P1", [task("SHARED-T1")])),
      entry(phase("P2", [task("SHARED-T1")])),
    ];
    const issues = detectDuplicateTaskIds(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("DUPLICATE_TASK_ID");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain("SHARED-T1");
    expect(issues[0]?.task_id).toBe("SHARED-T1");
  });
});

describe("detectDuplicatePhaseIds", () => {
  it("returns empty when phase ids are unique", () => {
    const entries = [entry(phase("P1")), entry(phase("P2"))];
    expect(detectDuplicatePhaseIds(entries)).toEqual([]);
  });

  it("reports the second occurrence", () => {
    const entries = [entry(phase("P1")), entry(phase("P1"))];
    const issues = detectDuplicatePhaseIds(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("DUPLICATE_PHASE_ID");
    expect(issues[0]?.severity).toBe("error");
  });
});

describe("detectPhaseIdMismatches", () => {
  it("returns empty when phase.id matches ref.id", () => {
    const entries = [entry(phase("P1"), "P1")];
    expect(detectPhaseIdMismatches(entries)).toEqual([]);
  });

  it("reports when phase.id does not match the roadmap ref", () => {
    const entries = [entry(phase("P1"), "P9")];
    const issues = detectPhaseIdMismatches(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("PHASE_ID_MISMATCH");
    expect(issues[0]?.severity).toBe("error");
  });
});

describe("detectOrphanProgressEvents", () => {
  function ev(task_id: string): ProgressEvent {
    return {
      task_id,
      status: "done",
      at: "2026-05-18T09:00:00+00:00",
      actor: "agent",
    };
  }

  it("returns empty when every event references a known task", () => {
    const index = new Map([["P1-T1", true]]);
    expect(detectOrphanProgressEvents([ev("P1-T1")], index)).toEqual([]);
  });

  it("reports unknown task ids as warnings", () => {
    const index = new Map([["P1-T1", true]]);
    const issues = detectOrphanProgressEvents([ev("GHOST")], index);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("ORPHAN_PROGRESS_EVENT");
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.task_id).toBe("GHOST");
  });

  it("deduplicates repeated unknown task ids so the user sees each ghost once", () => {
    const index = new Map([["P1-T1", true]]);
    const issues = detectOrphanProgressEvents(
      [ev("GHOST"), ev("GHOST"), ev("GHOST")],
      index,
    );
    expect(issues).toHaveLength(1);
  });
});

describe("detectPhaseIdNaming", () => {
  it("accepts P<N> style ids", () => {
    expect(detectPhaseIdNaming([entry(phase("P1")), entry(phase("P42"))])).toEqual(
      [],
    );
  });

  it("warns for non-conforming phase ids", () => {
    const issues = detectPhaseIdNaming([entry(phase("Phase1"))]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("PHASE_ID_NAMING");
    expect(issues[0]?.severity).toBe("warning");
  });
});

describe("detectTaskIdPhasePrefix", () => {
  it("accepts <phase>-T<N> style task ids", () => {
    const entries = [entry(phase("P1", [task("P1-T1"), task("P1-T2")]))];
    expect(detectTaskIdPhasePrefix(entries)).toEqual([]);
  });

  it("warns when the task id does not start with the phase id", () => {
    const entries = [entry(phase("P1", [task("P2-T1")]))];
    const issues = detectTaskIdPhasePrefix(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_ID_PHASE_PREFIX");
    expect(issues[0]?.severity).toBe("warning");
  });
});
