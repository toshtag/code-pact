import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveTaskInRoadmap } from "../../../../src/core/plan/resolve-task.ts";
import { PhaseSnapshotInvalidError } from "../../../../src/core/plan/state.ts";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";

// Step 4a (touch point E): resolveTaskInRoadmap tolerates a hand-deleted COMPLETED
// phase (so `task context`/`task prepare` on a LIVE target still resolve) but runs
// the SAME collision check as the loaders before returning — a drifted snapshot
// whose archived id collides with a live id fails closed, even when the target was
// found in a live phase.

const NOW = new Date("2026-06-10T00:00:00.000Z");

const TF = `    ambiguity: low
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
name: F
weight: 2
confidence: high
risk: low
status: done
objective: Build the base layer
definition_of_done:
  - it works
verification:
  commands:
    - pnpm test
tasks:
  - id: P1-T1
    type: feature
${TF}
    status: done
`;

const P2 = (firstTaskId: string) => `id: P2
name: N
weight: 1
confidence: high
risk: low
status: in_progress
objective: Build the next increment
definition_of_done:
  - done
verification:
  commands:
    - pnpm test
tasks:
  - id: ${firstTaskId}
    type: feature
${TF}
    status: in_progress
    depends_on:
      - P1-T1
`;

const PROGRESS = `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
`;

let cwd: string;
async function scaffold(p2FirstTask = "P2-T1") {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await writeFile(join(cwd, "design", "phases", "P2-y.yaml"), P2(p2FirstTask), "utf8");
  await seedDurableEvents(cwd, PROGRESS);
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-resolve-archive-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("resolveTaskInRoadmap — archived tolerance (E)", () => {
  it("resolves a LIVE target even when another phase was hand-deleted + snapshotted", async () => {
    await scaffold();
    await writePhaseSnapshot(cwd, "P1", { now: NOW });
    await rm(join(cwd, "design", "phases", "P1-x.yaml"));
    const r = await resolveTaskInRoadmap(cwd, "P2-T1");
    expect(r).toEqual({ phaseId: "P2", phasePath: "design/phases/P2-y.yaml" });
  });

  it("a deleted phase with NO snapshot still throws ENOENT (fail-closed)", async () => {
    await scaffold();
    await rm(join(cwd, "design", "phases", "P1-x.yaml"));
    await expect(resolveTaskInRoadmap(cwd, "P2-T1")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a collision throws PhaseSnapshotInvalidError even when an UNRELATED live target was found first", async () => {
    // P2 gets two live tasks: P2-CLEAN (the resolve target, found early) and P1-T1
    // (which collides with the archived P1-T1). Snapshot P1 while non-colliding,
    // then introduce the collision, delete P1. Resolving the CLEAN target must still
    // throw — the collision check runs after the full scan, not bypassed by an early hit.
    const P2_TWO = `id: P2
name: N
weight: 1
confidence: high
risk: low
status: in_progress
objective: Build the next increment
definition_of_done:
  - done
verification:
  commands:
    - pnpm test
tasks:
  - id: P2-CLEAN
    type: feature
${TF}
    status: in_progress
  - id: P1-T1
    type: feature
${TF}
    status: in_progress
`;
    await scaffold("P2-T1");
    await writePhaseSnapshot(cwd, "P1", { now: NOW });
    await writeFile(join(cwd, "design", "phases", "P2-y.yaml"), P2_TWO, "utf8");
    await rm(join(cwd, "design", "phases", "P1-x.yaml"));
    await expect(resolveTaskInRoadmap(cwd, "P2-CLEAN")).rejects.toBeInstanceOf(
      PhaseSnapshotInvalidError,
    );
  });

  it("a corrupt snapshot for a deleted phase throws PhaseSnapshotInvalidError", async () => {
    await scaffold();
    await writePhaseSnapshot(cwd, "P1", { now: NOW });
    await writeFile(
      join(cwd, ".code-pact", "state", "archive", "phases", "P1.json"),
      "{ nope",
      "utf8",
    );
    await rm(join(cwd, "design", "phases", "P1-x.yaml"));
    await expect(resolveTaskInRoadmap(cwd, "P2-T1")).rejects.toBeInstanceOf(
      PhaseSnapshotInvalidError,
    );
  });
});
