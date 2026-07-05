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
import { archivePhasesDir, phaseSnapshotPath } from "../../../../src/core/archive/paths.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";

// Step 4b — UNREFERENCED archived phase (roadmap ref GONE). Snapshot P1 while it is
// still a roadmap phase, THEN drop its ref from roadmap.yaml so P1 is unreferenced.

const NOW = new Date("2026-06-10T00:00:00.000Z");
const TF = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;

const ROADMAP_BOTH = `phases:
  - id: P1
    path: design/phases/P1-x.yaml
    weight: 2
  - id: P2
    path: design/phases/P2-y.yaml
    weight: 1
`;
// Only P2 — P1's ref removed (the post-archive state step 7 will produce).
const ROADMAP_P2_ONLY = `phases:
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
const P2 = (dependsOnP1 = false, firstId = "P2-T1") => `id: P2
name: N
weight: 1
confidence: high
risk: low
status: in_progress
objective: Build the next increment
definition_of_done:
  - done it well
verification:
  commands:
    - pnpm test
tasks:
  - id: ${firstId}
    type: feature
${TF}
    status: in_progress${dependsOnP1 ? `\n    depends_on:\n      - P1-T1` : ""}
`;
const PROGRESS = `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
`;

let cwd: string;
/** Write P1+P2 with P1 in the roadmap, snapshot P1, then drop P1's ref + delete its file. */
async function makeUnreferencedP1(p2 = P2(true)) {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP_BOTH, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await writeFile(join(cwd, "design", "phases", "P2-y.yaml"), p2, "utf8");
  await seedDurableEvents(cwd, PROGRESS);
  const o = await writePhaseSnapshot(cwd, "P1", { now: NOW });
  expect(o.kind).toBe("written");
  // Now archive-remove P1: drop its roadmap ref AND its live file.
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP_P2_ONLY, "utf8");
  await rm(join(cwd, "design", "phases", "P1-x.yaml"));
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-4b-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("loadPlanState (strict) — unreferenced discovery", () => {
  it("a live task depends_on an unreferenced snapshot id → id known, P1 not in phases", async () => {
    await makeUnreferencedP1();
    const state = await loadPlanState(cwd);
    expect(state.phases.map((p) => p.phase.id)).toEqual(["P2"]);
    expect(state.archivedTaskIndex.has("P1-T1")).toBe(true); // discovered, existence-only
  });

  it("a corrupt unreferenced snapshot → NO throw (silent skip in strict)", async () => {
    await makeUnreferencedP1(P2(false)); // no live dep on P1-T1
    await writeFile(phaseSnapshotPath(cwd, "P1"), "{ corrupt", "utf8");
    // strict loader must not throw on a self-invalid unreferenced file.
    const state = await loadPlanState(cwd);
    expect(state.archivedTaskIndex.has("P1-T1")).toBe(false);
  });

  it("an UNREADABLE archive dir (regular file) → NO throw (directory-soft)", async () => {
    await makeUnreferencedP1(P2(false));
    await rm(archivePhasesDir(cwd), { recursive: true });
    await writeFile(archivePhasesDir(cwd), "not a dir", "utf8");
    const state = await loadPlanState(cwd);
    expect(state.archivedTaskIndex.size).toBe(0);
  });

  it("a VALID unreferenced snapshot whose id collides with a LIVE id → throws (hard)", async () => {
    // Snapshot P1 while P2 is non-colliding (writer refuses a live duplicate), THEN
    // rename P2's live task to P1-T1 → the archived P1-T1 now collides with live P1-T1.
    await makeUnreferencedP1(P2(false));
    await writeFile(join(cwd, "design", "phases", "P2-y.yaml"), P2(false, "P1-T1"), "utf8");
    await expect(loadPlanState(cwd)).rejects.toBeInstanceOf(PhaseSnapshotInvalidError);
  });
});

describe("collectPlanArtifacts (lenient → plan lint) — unreferenced discovery", () => {
  it("corrupt unreferenced snapshot → affects_exit:false warning, id NOT loaded", async () => {
    await makeUnreferencedP1(P2(false));
    await writeFile(phaseSnapshotPath(cwd, "P1"), "{ corrupt", "utf8");
    const { archivedTaskIndex, fileIssues } = await collectPlanArtifacts(cwd);
    expect(archivedTaskIndex.has("P1-T1")).toBe(false);
    const adv = fileIssues.find((i) => i.code === "PHASE_SNAPSHOT_INVALID");
    expect(adv?.severity).toBe("warning");
    expect(adv?.affects_exit).toBe(false);
  });

  it("unreadable archive dir → directory-scope affects_exit:false warning", async () => {
    await makeUnreferencedP1(P2(false));
    await rm(archivePhasesDir(cwd), { recursive: true });
    await writeFile(archivePhasesDir(cwd), "not a dir", "utf8");
    const { fileIssues } = await collectPlanArtifacts(cwd);
    const adv = fileIssues.find((i) => i.code === "PHASE_SNAPSHOT_INVALID");
    expect(adv?.severity).toBe("warning");
    expect(adv?.affects_exit).toBe(false);
    expect(adv?.file).toBe(".code-pact/state/archive/phases");
  });

  it("valid unreferenced + live dep → no advisory, dep id known", async () => {
    await makeUnreferencedP1(P2(true));
    const { archivedTaskIndex, fileIssues } = await collectPlanArtifacts(cwd);
    expect(archivedTaskIndex.has("P1-T1")).toBe(true);
    expect(fileIssues.some((i) => i.code === "PHASE_SNAPSHOT_INVALID")).toBe(false);
  });

  it("collision → ERROR FileIssue (not the soft warning)", async () => {
    await makeUnreferencedP1(P2(false));
    await writeFile(join(cwd, "design", "phases", "P2-y.yaml"), P2(false, "P1-T1"), "utf8");
    const { fileIssues } = await collectPlanArtifacts(cwd);
    const err = fileIssues.find(
      (i) => i.code === "PHASE_SNAPSHOT_INVALID" && i.severity === "error",
    );
    expect(err).toBeDefined();
    expect(err?.affects_exit).not.toBe(false);
  });
});
