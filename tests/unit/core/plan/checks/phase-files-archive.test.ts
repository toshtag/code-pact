import { afterEach, beforeEach, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectMissingPhaseFiles,
  detectOrphanPhaseFiles,
} from "../../../../../src/core/plan/checks/phase-files.ts";
import { writePhaseSnapshot } from "../../../../../src/core/archive/phase-snapshot.ts";
import { phaseSnapshotPath } from "../../../../../src/core/archive/paths.ts";
import { seedDurableEvents } from "../../../../helpers/seed-events.ts";
import { Roadmap } from "../../../../../src/core/schemas/roadmap.ts";

// design-docs-ephemeral step 4a — detectMissingPhaseFiles tolerates a hand-deleted
// COMPLETED phase backed by a valid archive snapshot; fails closed otherwise.

const NOW = new Date("2026-06-10T00:00:00.000Z");

const ROADMAP_YAML = `phases:
  - id: P1
    path: design/phases/P1-x.yaml
    weight: 2
  - id: P2
    path: design/phases/P2-y.yaml
    weight: 1
`;

const TASK_FIELDS = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;

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

const P2_ACTIVE = `id: P2
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
  - id: P2-T1
    type: feature
${TASK_FIELDS}
    status: in_progress
`;

const DONE_EVENT = `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
`;

let cwd: string;
const roadmap = Roadmap.parse({
  phases: [
    { id: "P1", path: "design/phases/P1-x.yaml", weight: 2 },
    { id: "P2", path: "design/phases/P2-y.yaml", weight: 1 },
  ],
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-phasefiles-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP_YAML, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await writeFile(join(cwd, "design", "phases", "P2-y.yaml"), P2_ACTIVE, "utf8");
  await seedDurableEvents(cwd, DONE_EVENT);
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

it("live file present → no issue (snapshot never consulted)", async () => {
  expect(await detectMissingPhaseFiles(cwd, roadmap)).toEqual([]);
});

it("deleted completed phase + valid snapshot → TOLERATED (no issue)", async () => {
  await writePhaseSnapshot(cwd, "P1", { now: NOW });
  await rm(join(cwd, "design", "phases", "P1-x.yaml"));
  expect(await detectMissingPhaseFiles(cwd, roadmap)).toEqual([]);
});

it("deleted phase + NO snapshot → MISSING_PHASE_FILE (fail-closed, unchanged)", async () => {
  await rm(join(cwd, "design", "phases", "P1-x.yaml"));
  const issues = await detectMissingPhaseFiles(cwd, roadmap);
  expect(issues).toHaveLength(1);
  expect(issues[0]!.code).toBe("MISSING_PHASE_FILE");
});

it("deleted phase + CORRUPT snapshot → PHASE_SNAPSHOT_INVALID (loud fail-closed)", async () => {
  await writePhaseSnapshot(cwd, "P1", { now: NOW });
  await writeFile(phaseSnapshotPath(cwd, "P1"), "{ not json", "utf8");
  await rm(join(cwd, "design", "phases", "P1-x.yaml"));
  const issues = await detectMissingPhaseFiles(cwd, roadmap);
  expect(issues).toHaveLength(1);
  expect(issues[0]!.code).toBe("PHASE_SNAPSHOT_INVALID");
});

it("deleted phase + identity-mismatch snapshot (wrong original_path) → PHASE_SNAPSHOT_INVALID", async () => {
  await writePhaseSnapshot(cwd, "P1", { now: NOW });
  const p = phaseSnapshotPath(cwd, "P1");
  const obj = JSON.parse(await readFile(p, "utf8"));
  obj.original_path = "design/phases/P1-renamed.yaml";
  await writeFile(p, JSON.stringify(obj), "utf8");
  await rm(join(cwd, "design", "phases", "P1-x.yaml"));
  const issues = await detectMissingPhaseFiles(cwd, roadmap);
  expect(issues).toHaveLength(1);
  expect(issues[0]!.code).toBe("PHASE_SNAPSHOT_INVALID");
});

it("live present + corrupt snapshot on disk → STILL no issue (live-wins, snapshot ignored)", async () => {
  await writePhaseSnapshot(cwd, "P1", { now: NOW });
  await writeFile(phaseSnapshotPath(cwd, "P1"), "{ corrupt", "utf8");
  // P1-x.yaml is still present → the snapshot must never be read.
  expect(await detectMissingPhaseFiles(cwd, roadmap)).toEqual([]);
});

it("orphan scan refuses an external design/phases directory without listing its filenames", async () => {
  const outside = await mkdtemp(join(tmpdir(), "code-pact-phasefiles-outside-"));
  try {
    await writeFile(join(outside, "EXTERNAL_SECRET_PHASE.yaml"), P1_DONE, "utf8");
    await rm(join(cwd, "design", "phases"), { recursive: true, force: true });
    await symlink(outside, join(cwd, "design", "phases"));

    const issues = await detectOrphanPhaseFiles(cwd, roadmap);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("MISSING_PHASE_FILE");
    expect(JSON.stringify(issues)).not.toContain("EXTERNAL_SECRET_PHASE");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

// Present-but-INACCESSIBLE (non-searchable parent dir → access() EACCES) must
// fail closed, NOT be tolerated as 'absent' by the snapshot (live-wins). This is a
// permission-dependent path: chmod is a no-op for root, so the test self-skips
// there (deterministic, never flaky-fails). The chmod-free guarantee is pinned by
// the phaseFilePresence helper unit test in fs.test.ts.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
it.skipIf(isRoot)(
  "present-but-INACCESSIBLE live file + valid snapshot → fail-closed (snapshot must NOT release it)",
  async () => {
    await writePhaseSnapshot(cwd, "P1", { now: NOW });
    const phasesDir = join(cwd, "design", "phases");
    await chmod(phasesDir, 0o000);
    try {
      // Locking the dir makes BOTH refs inaccessible; the point is that P1 is NOT
      // tolerated by its valid snapshot — it is a fail-closed "cannot be accessed".
      const issues = await detectMissingPhaseFiles(cwd, roadmap);
      const p1 = issues.find((i) => i.phase_id === "P1");
      expect(p1?.code).toBe("MISSING_PHASE_FILE");
      expect(p1?.message).toContain("cannot be accessed");
      // No issue is silently absent / tolerated for the inaccessible P1.
    } finally {
      await chmod(phasesDir, 0o755); // restore so afterEach can clean up
    }
  },
);
