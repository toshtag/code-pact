import { describe, expect, it } from "vitest";

import {
  detectTaskDependsOnCycle,
  detectTaskDependsOnSelfReference,
  detectTaskDependsOnUnresolved,
} from "../../src/core/plan/checks.ts";
import {
  archivedKnownTaskIds,
  collectPlanArtifacts,
} from "../../src/core/plan/state.ts";

describe("repository plan dependency graph", () => {
  it("contains no unresolved, self-referential, or cyclic task dependencies", async () => {
    const { state, fallbackPhases, archivedTaskIndex, fileIssues } =
      await collectPlanArtifacts(process.cwd());

    expect(fileIssues).toEqual([]);

    const phases = state?.phases ?? fallbackPhases;
    const knownArchivedTaskIds = archivedKnownTaskIds(
      state ?? {
        archivedTaskIndex,
        cwd: process.cwd(),
        roadmapPath: "design/roadmap.yaml",
        roadmap: { phases: [] },
        phases: fallbackPhases,
        progress: null,
        taskIndex: new Map(),
      },
    );

    const issues = [
      ...detectTaskDependsOnUnresolved(phases, knownArchivedTaskIds),
      ...detectTaskDependsOnSelfReference(phases),
      ...detectTaskDependsOnCycle(phases),
    ];

    expect(issues).toEqual([]);
  }, 60_000);
});
