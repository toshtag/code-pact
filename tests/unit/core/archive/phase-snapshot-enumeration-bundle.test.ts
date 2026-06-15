import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import {
  discoverUnreferencedSnapshots,
  enumerateArchivedPhaseSnapshots,
} from "../../../../src/core/archive/load-phase-snapshot.ts";
import {
  readArchivedTaskIds,
  validateSnapshotEventEvidence,
} from "../../../../src/core/archive/snapshot-evidence.ts";
import { archiveBundlesDir, phaseSnapshotPath, sha256Hex } from "../../../../src/core/archive/paths.ts";
import { computeMemberIdsSha256 } from "../../../../src/core/archive/archive-bundle-reader.ts";
import { ARCHIVE_BUNDLE_SCHEMA_VERSION } from "../../../../src/core/schemas/archive-bundle.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";

// Layer 1: bundle-only phase snapshots must be visible to the GLOBAL enumeration
// readers (readArchivedTaskIds / validateSnapshotEventEvidence /
// discoverUnreferencedSnapshots), not just the per-ref resolveMissingPhaseRef.

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
const EVENTS_P1T1 = `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-snapenum-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "phases"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** Write P1 (done) + its loose events + its phase snapshot; return the snapshot's
 *  canonical bytes (read before any compaction). */
async function scaffoldP1Snapshot(): Promise<string> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await seedDurableEvents(cwd, EVENTS_P1T1);
  expect((await writePhaseSnapshot(cwd, "P1", { now: NOW })).kind).toBe("written");
  return readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
}

async function writePhaseSnapshotBundle(
  name: string,
  members: { id: string; bytes: string }[],
): Promise<void> {
  const dir = archiveBundlesDir(cwd);
  await mkdir(dir, { recursive: true });
  const full = members
    .map((m) => ({ id: m.id, sha256: sha256Hex(m.bytes), bytes: m.bytes }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  await writeFile(
    join(dir, name),
    JSON.stringify({
      schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
      kind: "phase_snapshot",
      member_ids_sha256: computeMemberIdsSha256(full.map((m) => m.id)),
      members: full,
    }),
    "utf8",
  );
}

/** Move P1's snapshot into a phase_snapshot bundle and delete the loose file. */
async function compactP1IntoBundle(): Promise<void> {
  const bytes = await scaffoldP1Snapshot();
  await writePhaseSnapshotBundle("snap.json", [{ id: "P1", bytes }]);
  await rm(phaseSnapshotPath(cwd, "P1"));
}

describe("enumerateArchivedPhaseSnapshots — loose ∪ bundle", () => {
  it("bundle-only snapshot is enumerated as valid", async () => {
    await compactP1IntoBundle();
    const { entries, skipped } = await enumerateArchivedPhaseSnapshots(cwd);
    expect(skipped).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.fileStem).toBe("P1");
    expect(entries[0]!.res.kind).toBe("valid");
  });

  it("loose snapshot present is isolated from a stale same-id bundle (loose wins, no skip)", async () => {
    await scaffoldP1Snapshot(); // loose snapshot stays
    // A same-id bundle member with valid Tier-1 but garbage bytes: loose wins → it is
    // never bound, so it produces neither an entry override nor a skip.
    await writePhaseSnapshotBundle("snap.json", [{ id: "P1", bytes: '{"not":"a snapshot"}' }]);
    const { entries, skipped } = await enumerateArchivedPhaseSnapshots(cwd);
    expect(skipped).toEqual([]);
    expect(entries.filter((e) => e.fileStem === "P1")).toHaveLength(1);
    expect(entries.find((e) => e.fileStem === "P1")!.res.kind).toBe("valid");
  });

  it("a Tier-1-corrupt bundle store → fail-soft directory skip; loose snapshots kept", async () => {
    await scaffoldP1Snapshot(); // loose snapshot stays
    await mkdir(archiveBundlesDir(cwd), { recursive: true });
    await writeFile(join(archiveBundlesDir(cwd), "bad.json"), "{ not json", "utf8");
    const { entries, skipped } = await enumerateArchivedPhaseSnapshots(cwd);
    expect(entries.some((e) => e.fileStem === "P1" && e.res.kind === "valid")).toBe(true);
    expect(skipped.some((s) => s.scope === "directory")).toBe(true);
  });

  it("bundle member filed under P1 whose body phase_id is P99 → invalid (self-bind identity)", async () => {
    const bytes = await scaffoldP1Snapshot();
    // File the P1-bodied snapshot under member id P99 → id ≠ internal phase_id.
    await rm(phaseSnapshotPath(cwd, "P1"));
    await writePhaseSnapshotBundle("snap.json", [{ id: "P99", bytes }]);
    const { entries } = await enumerateArchivedPhaseSnapshots(cwd);
    const p99 = entries.find((e) => e.fileStem === "P99");
    expect(p99?.res.kind).toBe("invalid"); // bindBundleMember rejects id↔phase_id mismatch
    // It must NOT inject task ids (a misidentified member is never trusted).
    const { taskIds } = await readArchivedTaskIds(cwd);
    expect(taskIds.has("P1-T1")).toBe(false);
  });

  it("corrupt LOOSE snapshot + valid same-id bundle → loose wins (still invalid; bundle does NOT override)", async () => {
    const bytes = await scaffoldP1Snapshot();
    await writeFile(phaseSnapshotPath(cwd, "P1"), "{ corrupt", "utf8"); // loose now corrupt
    await writePhaseSnapshotBundle("snap.json", [{ id: "P1", bytes }]); // valid bundle copy
    const { entries } = await enumerateArchivedPhaseSnapshots(cwd);
    const p1 = entries.filter((e) => e.fileStem === "P1");
    expect(p1).toHaveLength(1); // no double-count
    expect(p1[0]!.res.kind).toBe("invalid"); // loose wins even when corrupt; bundle not used
  });
});

describe("readArchivedTaskIds — bundle-only snapshot feeds the legacy gate", () => {
  it("a bundle-only snapshot's task ids are collected", async () => {
    await compactP1IntoBundle();
    const { taskIds, skipped } = await readArchivedTaskIds(cwd);
    expect(skipped).toEqual([]);
    expect(taskIds.has("P1-T1")).toBe(true);
  });
});

describe("validateSnapshotEventEvidence — bundle-only snapshot is validated", () => {
  it("a bundle-only snapshot's progress_events evidence is checked (unresolved → issue)", async () => {
    await compactP1IntoBundle();
    // Empty resolved map → the snapshot's done-evidence event_id cannot resolve, so
    // the bundle-only snapshot must produce an `unresolved` issue (proving it was read).
    const { result } = await validateSnapshotEventEvidence(cwd, new Map());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.phase_id === "P1" && i.reason === "unresolved")).toBe(true);
    }
  });
});

describe("discoverUnreferencedSnapshots — bundle-only unreferenced snapshot", () => {
  it("a bundle-only unreferenced snapshot is discovered (existence-only task entry)", async () => {
    await compactP1IntoBundle();
    // P1 is NOT a live roadmap phase id here → it is unreferenced.
    const { entries, invalid } = await discoverUnreferencedSnapshots(cwd, new Set());
    expect(invalid).toEqual([]);
    expect(entries.some((e) => e.task_id === "P1-T1" && e.phase_id === "P1")).toBe(true);
  });

  it("a corrupt snapshot bundle is a fail-soft discovery issue (not silent green)", async () => {
    await mkdir(archiveBundlesDir(cwd), { recursive: true });
    await writeFile(join(archiveBundlesDir(cwd), "bad.json"), "{ not json", "utf8");
    const { entries, invalid } = await discoverUnreferencedSnapshots(cwd, new Set());
    expect(entries).toEqual([]);
    expect(invalid.some((i) => i.scope === "directory")).toBe(true); // surfaced, not silent
  });
});
