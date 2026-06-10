import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  archivedEntriesFromSnapshot,
  loadPhaseSnapshot,
  mergeArchivedTaskIndex,
  resolveMissingPhaseRef,
  type ArchivedTaskEntry,
} from "../../../../src/core/archive/load-phase-snapshot.ts";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import { phaseSnapshotPath, sha256Hex } from "../../../../src/core/archive/paths.ts";

const NOW = new Date("2026-06-10T00:00:00.000Z");

const ROADMAP = `phases:
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
  - id: P1-T2
    type: docs
${TASK_FIELDS}
    status: cancelled
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
    depends_on:
      - P1-T1
`;

const DONE_EVENT_P1T1 = `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-loadsnap-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "phases"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** Scaffold a project with P1 (done) + P2 (active) and write a valid P1 snapshot. */
async function scaffoldWithP1Snapshot(): Promise<string> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await writeFile(join(cwd, "design", "phases", "P2-y.yaml"), P2_ACTIVE, "utf8");
  await writeFile(join(cwd, ".code-pact", "state", "progress.yaml"), DONE_EVENT_P1T1, "utf8");
  const outcome = await writePhaseSnapshot(cwd, "P1", { now: NOW });
  expect(outcome.kind).toBe("written");
  return (outcome as { path: string }).path;
}

describe("loadPhaseSnapshot", () => {
  it("absent file → absent", async () => {
    expect(await loadPhaseSnapshot(cwd, "P1")).toEqual({ kind: "absent" });
  });

  it("valid written snapshot → valid with parsed body", async () => {
    await scaffoldWithP1Snapshot();
    const res = await loadPhaseSnapshot(cwd, "P1");
    expect(res.kind).toBe("valid");
    if (res.kind !== "valid") return;
    expect(res.snapshot.phase_id).toBe("P1");
    expect(res.snapshot.original_path).toBe("design/phases/P1-x.yaml");
  });

  it("JSON garbage → invalid (not absent)", async () => {
    await writeFile(phaseSnapshotPath(cwd, "P1"), "{not json", "utf8");
    expect((await loadPhaseSnapshot(cwd, "P1")).kind).toBe("invalid");
  });

  it("valid JSON but schema-invalid (unknown key, strictObject) → invalid", async () => {
    const snapPath = await scaffoldWithP1Snapshot();
    const obj = JSON.parse(await readFile(snapPath, "utf8"));
    obj.surprise = "extra";
    await writeFile(snapPath, JSON.stringify(obj), "utf8");
    expect((await loadPhaseSnapshot(cwd, "P1")).kind).toBe("invalid");
  });

  it("present-but-unreadable (a directory at the path) → invalid, NOT absent", async () => {
    await mkdir(phaseSnapshotPath(cwd, "P1"), { recursive: true });
    expect((await loadPhaseSnapshot(cwd, "P1")).kind).toBe("invalid");
  });

  it("unsafe phase id (rejected by assertSafePlanId) → invalid, fail-closed", async () => {
    expect((await loadPhaseSnapshot(cwd, "../evil")).kind).toBe("invalid");
  });
});

describe("resolveMissingPhaseRef", () => {
  const ref = { id: "P1", path: "design/phases/P1-x.yaml" };

  it("valid + identity match → tolerated", async () => {
    await scaffoldWithP1Snapshot();
    const res = await resolveMissingPhaseRef(cwd, ref);
    expect(res.kind).toBe("tolerated");
  });

  it("absent snapshot → fail_missing", async () => {
    const res = await resolveMissingPhaseRef(cwd, ref);
    expect(res.kind).toBe("fail_missing");
  });

  it("corrupt snapshot → fail_invalid", async () => {
    await writeFile(phaseSnapshotPath(cwd, "P1"), "{nope", "utf8");
    expect((await resolveMissingPhaseRef(cwd, ref)).kind).toBe("fail_invalid");
  });

  it("phase_id mismatch → fail_invalid", async () => {
    const snapPath = await scaffoldWithP1Snapshot();
    const obj = JSON.parse(await readFile(snapPath, "utf8"));
    obj.phase_id = "PX";
    await writeFile(snapPath, JSON.stringify(obj), "utf8");
    // ref.id is "P1" but the file is at P1.json with body phase_id "PX".
    expect((await resolveMissingPhaseRef(cwd, ref)).kind).toBe("fail_invalid");
  });

  it("original_path mismatch (ref path differs) → fail_invalid", async () => {
    await scaffoldWithP1Snapshot();
    const res = await resolveMissingPhaseRef(cwd, {
      id: "P1",
      path: "design/phases/P1-renamed.yaml",
    });
    expect(res.kind).toBe("fail_invalid");
  });

  it("path_sha256 not covering original_path → fail_invalid", async () => {
    const snapPath = await scaffoldWithP1Snapshot();
    const obj = JSON.parse(await readFile(snapPath, "utf8"));
    obj.path_sha256 = sha256Hex("design/phases/something-else.yaml");
    await writeFile(snapPath, JSON.stringify(obj), "utf8");
    expect((await resolveMissingPhaseRef(cwd, ref)).kind).toBe("fail_invalid");
  });
});

describe("archivedEntriesFromSnapshot", () => {
  it("projects each task (done + cancelled) with status/phase_id/path/evidence", async () => {
    await scaffoldWithP1Snapshot();
    const res = await loadPhaseSnapshot(cwd, "P1");
    if (res.kind !== "valid") throw new Error("expected valid");
    const entries = archivedEntriesFromSnapshot(res.snapshot);
    expect(entries.map((e) => e.task_id).sort()).toEqual(["P1-T1", "P1-T2"]);
    const t1 = entries.find((e) => e.task_id === "P1-T1")!;
    expect(t1).toMatchObject({
      phase_id: "P1",
      original_path: "design/phases/P1-x.yaml",
      status: "done",
    });
    expect(t1.terminal_evidence.kind).toBe("progress_events");
    const t2 = entries.find((e) => e.task_id === "P1-T2")!;
    expect(t2.status).toBe("cancelled");
    expect(t2.terminal_evidence.kind).toBe("design_status");
  });
});

describe("mergeArchivedTaskIndex — collision fail-closed (never pick a winner)", () => {
  const entry = (phase_id: string, task_id: string): ArchivedTaskEntry => ({
    phase_id,
    original_path: `design/phases/${phase_id}.yaml`,
    task_id,
    status: "done",
    terminal_evidence: { kind: "progress_events", event_ids: ["a".repeat(64)] },
  });

  it("no collision → fully populated index, no collisions", () => {
    const r = mergeArchivedTaskIndex(new Set(["L-1"]), [entry("P1", "P1-T1"), entry("P1", "P1-T2")]);
    expect(r.collisions).toEqual([]);
    expect([...r.index.keys()].sort()).toEqual(["P1-T1", "P1-T2"]);
  });

  it("archived id == a LIVE id → PHASE_SNAPSHOT_INVALID; colliding id ABSENT from index", () => {
    const r = mergeArchivedTaskIndex(new Set(["T-1"]), [entry("P1", "T-1")]);
    expect(r.collisions).toHaveLength(1);
    expect(r.collisions[0]!.kind).toBe("live");
    expect(r.index.has("T-1")).toBe(false);
  });

  it("same id across two snapshots → collision; absent from BOTH (no winner)", () => {
    const r = mergeArchivedTaskIndex(new Set(), [entry("P1", "T-1"), entry("P2", "T-1")]);
    expect(r.collisions.some((c) => c.task_id === "T-1")).toBe(true);
    expect(r.index.has("T-1")).toBe(false);
  });

  it("duplicate id WITHIN one snapshot → collision; that id absent", () => {
    const r = mergeArchivedTaskIndex(new Set(), [entry("P1", "T-1"), entry("P1", "T-1")]);
    expect(r.collisions.some((c) => c.task_id === "T-1")).toBe(true);
    expect(r.index.has("T-1")).toBe(false);
  });

  it("drop is per-id, not per-phase: a non-colliding sibling survives", () => {
    // P1 has T-1 (collides with live) and T-2 (clean). Only T-1 is dropped.
    const r = mergeArchivedTaskIndex(new Set(["T-1"]), [entry("P1", "T-1"), entry("P1", "T-2")]);
    expect(r.index.has("T-1")).toBe(false);
    expect(r.index.has("T-2")).toBe(true);
  });
});
