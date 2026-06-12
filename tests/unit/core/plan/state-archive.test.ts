import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectPlanArtifacts,
  loadPlanState,
  PhaseSnapshotInvalidError,
} from "../../../../src/core/plan/state.ts";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import { phaseSnapshotPath } from "../../../../src/core/archive/paths.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";

// Step 4a (rows C + D): the strict + lenient loaders tolerate a hand-deleted
// COMPLETED phase via its snapshot, populate archivedTaskIndex, and fail-closed
// (throw / FileIssue) on a collision — never a silencer.

const NOW = new Date("2026-06-10T00:00:00.000Z");

const TASK_FIELDS = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;

const ROADMAP = `phases:
  - id: P1
    path: design/phases/P1-x.yaml
    weight: 2
  - id: P2
    path: design/phases/P2-y.yaml
    weight: 1
`;

const P1_DONE = `id: P1
name: Foundations
weight: 2
confidence: high
risk: low
status: done
objective: Build the base
definition_of_done:
  - it works
verification:
  commands:
    - pnpm test
tasks:
  - id: P1-T1
    type: feature
${TASK_FIELDS}
    status: done
`;

// P2 has a live task whose id COLLIDES with P1's archived task id, for the
// collision cases. `collide` toggles P2-T1's id to P1-T1.
const P2 = (opts?: { collide?: boolean; dependsOnP1?: boolean }) => `id: P2
name: Next
weight: 1
confidence: high
risk: low
status: in_progress
objective: Next work
definition_of_done:
  - done
verification:
  commands:
    - pnpm test
tasks:
  - id: ${opts?.collide ? "P1-T1" : "P2-T1"}
    type: feature
${TASK_FIELDS}
    status: in_progress${
      opts?.dependsOnP1
        ? `
    depends_on:
      - P1-T1`
        : ""
    }
`;

const DONE_EVENT = `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
`;

let cwd: string;
async function scaffold(p2?: string) {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await writeFile(join(cwd, "design", "phases", "P2-y.yaml"), p2 ?? P2(), "utf8");
  await seedDurableEvents(cwd, DONE_EVENT);
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-state-archive-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("loadPlanState (strict) — archived index", () => {
  it("tolerated deleted phase → skipped from phases, ids in archivedTaskIndex", async () => {
    await scaffold(P2({ dependsOnP1: true }));
    await writePhaseSnapshot(cwd, "P1", { now: NOW });
    await rm(join(cwd, "design", "phases", "P1-x.yaml"));

    const state = await loadPlanState(cwd);
    expect(state.phases.map((p) => p.phase.id)).toEqual(["P2"]); // P1 gone
    expect(state.archivedTaskIndex.has("P1-T1")).toBe(true);
    expect(state.taskIndex.has("P1-T1")).toBe(false); // never live
  });

  it("deleted phase with NO snapshot → throws ENOENT (fail-closed, unchanged)", async () => {
    await scaffold();
    await rm(join(cwd, "design", "phases", "P1-x.yaml"));
    await expect(loadPlanState(cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("archived id collides with a LIVE id → throws PhaseSnapshotInvalidError", async () => {
    // Snapshot P1 while P2 is non-colliding (the writer refuses a live duplicate),
    // THEN introduce the collision by swapping P2 to also own P1-T1, then delete P1.
    // This is the hand-edited / drifted snapshot the reader must catch itself.
    await scaffold(); // P2-T1, no collision
    await writePhaseSnapshot(cwd, "P1", { now: NOW });
    await writeFile(join(cwd, "design", "phases", "P2-y.yaml"), P2({ collide: true }), "utf8");
    await rm(join(cwd, "design", "phases", "P1-x.yaml"));
    await expect(loadPlanState(cwd)).rejects.toBeInstanceOf(PhaseSnapshotInvalidError);
  });

  it("corrupt snapshot for a deleted phase → throws PhaseSnapshotInvalidError", async () => {
    await scaffold();
    await writePhaseSnapshot(cwd, "P1", { now: NOW });
    await writeFile(phaseSnapshotPath(cwd, "P1"), "{ nope", "utf8");
    await rm(join(cwd, "design", "phases", "P1-x.yaml"));
    await expect(loadPlanState(cwd)).rejects.toBeInstanceOf(PhaseSnapshotInvalidError);
  });
});

describe("collectPlanArtifacts (lenient) — archived index", () => {
  it("tolerated deleted phase → archivedTaskIndex populated, no parse FileIssue", async () => {
    await scaffold(P2({ dependsOnP1: true }));
    await writePhaseSnapshot(cwd, "P1", { now: NOW });
    await rm(join(cwd, "design", "phases", "P1-x.yaml"));

    const { state, archivedTaskIndex, fileIssues } = await collectPlanArtifacts(cwd);
    expect(archivedTaskIndex.has("P1-T1")).toBe(true);
    expect(state?.archivedTaskIndex.has("P1-T1")).toBe(true);
    expect(fileIssues.some((i) => i.file === "design/phases/P1-x.yaml")).toBe(false);
  });

  it("collision → PHASE_SNAPSHOT_INVALID FileIssue, colliding id EXCLUDED (no throw)", async () => {
    await scaffold(); // snapshot P1 while non-colliding
    await writePhaseSnapshot(cwd, "P1", { now: NOW });
    await writeFile(join(cwd, "design", "phases", "P2-y.yaml"), P2({ collide: true }), "utf8");
    await rm(join(cwd, "design", "phases", "P1-x.yaml"));

    const { archivedTaskIndex, fileIssues } = await collectPlanArtifacts(cwd);
    expect(fileIssues.some((i) => i.code === "PHASE_SNAPSHOT_INVALID")).toBe(true);
    expect(archivedTaskIndex.has("P1-T1")).toBe(false); // colliding id excluded
  });

  it("no-roadmap fallback → empty archivedTaskIndex, no throw", async () => {
    await writeFile(join(cwd, "design", "roadmap.yaml"), "not: [valid", "utf8");
    const { archivedTaskIndex, state } = await collectPlanArtifacts(cwd);
    expect(archivedTaskIndex.size).toBe(0);
    expect(state).toBeNull();
  });
});
