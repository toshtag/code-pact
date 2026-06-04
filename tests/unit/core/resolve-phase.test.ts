import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolvePhaseRef,
  resolvePhaseInRoadmap,
  resolvePhaseInPlanState,
  findUniquePhaseInPlanState,
} from "../../../src/core/plan/resolve-phase.ts";
import type { Roadmap } from "../../../src/core/schemas/roadmap.ts";
import type { PlanState } from "../../../src/core/plan/state.ts";

// PR1a: phase-id resolution must fail closed on a duplicate id (AMBIGUOUS_PHASE_ID)
// instead of silently returning the first match.

function roadmap(...refs: Array<{ id: string; path: string; weight?: number }>): Roadmap {
  return { phases: refs.map((r) => ({ id: r.id, path: r.path, weight: r.weight ?? 10 })) };
}

// Minimal PlanState stub — only `.phases` is read by the resolver.
function planState(
  ...entries: Array<{ id: string; path: string }>
): PlanState {
  return {
    phases: entries.map((e) => ({
      ref: { id: e.id, path: e.path, weight: 10 },
      absPath: `/abs/${e.path}`,
      phase: { id: e.id } as never,
    })),
  } as unknown as PlanState;
}

describe("resolvePhaseRef (pure, over a Roadmap)", () => {
  it("returns the single matching ref", () => {
    const ref = resolvePhaseRef(
      roadmap({ id: "P1", path: "design/phases/P1-foundations.yaml" }),
      "P1",
    );
    expect(ref.id).toBe("P1");
    expect(ref.path).toBe("design/phases/P1-foundations.yaml");
  });

  it("throws PHASE_NOT_FOUND on zero matches", () => {
    try {
      resolvePhaseRef(roadmap({ id: "P1", path: "design/phases/P1-a.yaml" }), "P9");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("PHASE_NOT_FOUND");
    }
  });

  it("throws AMBIGUOUS_PHASE_ID (with .phases paths) on a duplicate id", () => {
    try {
      resolvePhaseRef(
        roadmap(
          { id: "P1", path: "design/phases/P1-a.yaml" },
          { id: "P1", path: "design/phases/P1-b.yaml" },
        ),
        "P1",
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("AMBIGUOUS_PHASE_ID");
      expect(
        (err as NodeJS.ErrnoException & { phases?: string[] }).phases,
      ).toEqual(["design/phases/P1-a.yaml", "design/phases/P1-b.yaml"]);
    }
  });
});

describe("resolvePhaseInRoadmap (I/O)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-resolve-phase-test-"));
    await mkdir(join(dir, "design"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves a unique phase id from roadmap.yaml", async () => {
    await writeFile(
      join(dir, "design", "roadmap.yaml"),
      ["phases:", "  - id: P1", "    path: design/phases/P1-a.yaml", "    weight: 10"].join("\n") + "\n",
      "utf8",
    );
    const ref = await resolvePhaseInRoadmap(dir, "P1");
    expect(ref.id).toBe("P1");
  });

  it("fails closed (AMBIGUOUS_PHASE_ID) on a duplicate id in roadmap.yaml", async () => {
    await writeFile(
      join(dir, "design", "roadmap.yaml"),
      [
        "phases:",
        "  - id: P1",
        "    path: design/phases/P1-a.yaml",
        "    weight: 10",
        "  - id: P1",
        "    path: design/phases/P1-b.yaml",
        "    weight: 10",
      ].join("\n") + "\n",
      "utf8",
    );
    await expect(resolvePhaseInRoadmap(dir, "P1")).rejects.toMatchObject({
      code: "AMBIGUOUS_PHASE_ID",
    });
  });
});

describe("resolvePhaseInPlanState / findUniquePhaseInPlanState (pure, over PlanState)", () => {
  it("resolvePhaseInPlanState returns the unique entry", () => {
    const entry = resolvePhaseInPlanState(
      planState({ id: "P1", path: "design/phases/P1-a.yaml" }),
      "P1",
    );
    expect(entry.phase.id).toBe("P1");
  });

  it("resolvePhaseInPlanState throws PHASE_NOT_FOUND when absent", () => {
    expect(() =>
      resolvePhaseInPlanState(planState({ id: "P1", path: "x.yaml" }), "P9"),
    ).toThrow(/not found/);
  });

  it("both variants throw AMBIGUOUS_PHASE_ID on a duplicate id", () => {
    const dup = planState(
      { id: "P1", path: "design/phases/P1-a.yaml" },
      { id: "P1", path: "design/phases/P1-b.yaml" },
    );
    expect(() => resolvePhaseInPlanState(dup, "P1")).toThrow(
      /defined in multiple/,
    );
    expect(() => findUniquePhaseInPlanState(dup, "P1")).toThrow(
      /defined in multiple/,
    );
  });

  it("findUniquePhaseInPlanState returns undefined (no throw) when absent", () => {
    expect(
      findUniquePhaseInPlanState(planState({ id: "P1", path: "x.yaml" }), "P9"),
    ).toBeUndefined();
  });
});
