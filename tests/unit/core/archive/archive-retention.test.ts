import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import { writeDecisionRecord } from "../../../../src/core/archive/decision-record.ts";
import { planArchiveRetention, resolveKeepLatest, type RetentionPlan } from "../../../../src/core/archive/archive-retention.ts";
import { phaseSnapshotPath, decisionRecordPath, archiveBundlesDir, sha256Hex } from "../../../../src/core/archive/paths.ts";
import { computeMemberIdsSha256 } from "../../../../src/core/archive/archive-bundle-reader.ts";
import { ARCHIVE_BUNDLE_SCHEMA_VERSION } from "../../../../src/core/schemas/archive-bundle.ts";
import { buildValidEventPack, writeEventPackFile } from "../../../helpers/event-pack-fixture.ts";
import { ProgressLog } from "../../../../src/core/schemas/progress-event.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";

// Conservative keep-latest-N retention planner (dry-run authority). The gate: a record
// referenced by the live graph (roadmap / live-task depends_on / decision_refs) is ALWAYS
// blocked (kept) regardless of age; of the UNREFERENCED, the latest N per kind are kept and
// older dropped; event_pack follows its phase snapshot. Anything the planner cannot reason
// about (invalid / ambiguous / scan failure) is blocked, never silently dropped.

const TASK_FIELDS = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;

/** A done phase YAML with one done task, optionally cross-phase `depends_on`. */
function phaseYaml(id: string, opts: { dependsOn?: string[]; decisionRefs?: string[] } = {}): string {
  const dep = opts.dependsOn?.length ? `    depends_on: [${opts.dependsOn.join(", ")}]\n` : "";
  const dec = opts.decisionRefs?.length
    ? `    decision_refs:\n${opts.decisionRefs.map((r) => `      - ${r}`).join("\n")}\n`
    : "";
  return `id: ${id}
name: Phase ${id}
weight: 1
confidence: high
risk: low
status: done
objective: do ${id}
definition_of_done:
  - it works
verification:
  commands:
    - "true"
tasks:
  - id: ${id}-T1
    type: feature
${TASK_FIELDS}
    status: done
${dep}${dec}`;
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-retention-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "decisions"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

type PhaseSpec = { id: string; at: string; dependsOn?: string[]; decisionRefs?: string[] };

/** Write the roadmap + each phase YAML, seed done events, and archive each phase snapshot
 *  at its given `at` timestamp. Returns nothing; snapshots land under archive/phases/. */
async function archivePhases(specs: PhaseSpec[]): Promise<void> {
  const roadmap = `phases:\n${specs.map((s) => `  - id: ${s.id}\n    path: design/phases/${s.id}.yaml\n    weight: 1`).join("\n")}\n`;
  await writeFile(join(cwd, "design", "roadmap.yaml"), roadmap, "utf8");
  for (const s of specs) {
    await writeFile(join(cwd, "design", "phases", `${s.id}.yaml`), phaseYaml(s.id, s), "utf8");
  }
  const events = `events:\n${specs
    .map((s) => `  - task_id: ${s.id}-T1\n    status: done\n    at: 2026-06-01T00:00:00.000Z\n    actor: agent`)
    .join("\n")}\n`;
  await seedDurableEvents(cwd, events);
  for (const s of specs) {
    expect((await writePhaseSnapshot(cwd, s.id, { now: new Date(s.at) })).kind).toBe("written");
  }
}

/** Rewrite the roadmap to list ONLY `keepIds` (others become unreferenced archived tail).
 *  The dropped phases' YAMLs are removed too (they are no longer live). */
async function setRoadmap(keepIds: string[], liveYaml: Record<string, { dependsOn?: string[]; decisionRefs?: string[] }> = {}): Promise<void> {
  // An empty list must serialize as `phases: []` (a bare `phases:` parses as null → invalid).
  const roadmap =
    keepIds.length === 0
      ? "phases: []\n"
      : `phases:\n${keepIds.map((id) => `  - id: ${id}\n    path: design/phases/${id}.yaml\n    weight: 1`).join("\n")}\n`;
  await writeFile(join(cwd, "design", "roadmap.yaml"), roadmap, "utf8");
  // Ensure each kept phase has a live YAML (with any requested live refs).
  for (const id of keepIds) {
    await writeFile(join(cwd, "design", "phases", `${id}.yaml`), phaseYaml(id, liveYaml[id] ?? {}), "utf8");
  }
}

const planFor = (plans: RetentionPlan[], kind: string): RetentionPlan => plans.find((p) => p.kind === kind)!;

describe("resolveKeepLatest", () => {
  it("defaults to 20, accepts ≥1, rejects 0 / negative / non-integer", () => {
    expect(resolveKeepLatest(undefined)).toBe(20);
    expect(resolveKeepLatest("5")).toBe(5);
    expect(() => resolveKeepLatest("0")).toThrow(/≥ 1/);
    expect(() => resolveKeepLatest("-1")).toThrow();
    expect(() => resolveKeepLatest("x")).toThrow();
  });
});

describe("planArchiveRetention — phase_snapshot keep-latest N over the unreferenced pool", () => {
  it("unreferenced snapshots beyond keepLatest → oldest would_drop, latest N would_keep", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
      { id: "P3", at: "2026-03-01T00:00:00.000Z" },
    ]);
    await setRoadmap([]); // all three now unreferenced
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 2 }), "phase_snapshot");
    expect(plan.would_keep.map((i) => i.id).sort()).toEqual(["P2", "P3"]); // latest 2
    expect(plan.would_drop.map((i) => i.id)).toEqual(["P1"]); // oldest
    expect(plan.blocked).toEqual([]);
    expect(plan.would_keep.every((i) => i.reason === "within_keep_latest")).toBe(true);
    expect(plan.would_drop[0]!.reason).toBe("older_than_keep_latest");
  });

  it("the canonical tail: referenced records are NOT counted in N (P4 roadmap, P5 task-dep both blocked)", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
      { id: "P3", at: "2026-03-01T00:00:00.000Z" },
      { id: "P4", at: "2026-04-01T00:00:00.000Z" },
      { id: "P5", at: "2026-05-01T00:00:00.000Z" },
    ]);
    // Keep P4 referenced by the roadmap; add a live phase LP whose task depends_on P5-T1.
    await setRoadmap(["P4", "LP"], { LP: { dependsOn: ["P5-T1"] } });
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 2 }), "phase_snapshot");
    // P3, P2 are the latest 2 UNREFERENCED → keep; P1 → drop. P4, P5 → blocked (referenced).
    expect(plan.would_keep.map((i) => i.id).sort()).toEqual(["P2", "P3"]);
    expect(plan.would_drop.map((i) => i.id)).toEqual(["P1"]);
    const blocked = Object.fromEntries(plan.blocked.map((i) => [i.id, i.reason]));
    expect(blocked.P4).toBe("referenced_by_roadmap");
    expect(blocked.P5).toBe("referenced_by_live_task_dependency");
    // The reference is explained (so a user can answer "why isn't this dropped?").
    expect(plan.blocked.find((i) => i.id === "P5")!.references).toEqual([{ type: "task_depends_on", from: "LP-T1", to: "P5-T1" }]);
  });

  it("tie-break: equal snapshotted_at → deterministic id ASC for the kept set", async () => {
    const at = "2026-03-01T00:00:00.000Z";
    await archivePhases([
      { id: "PB", at },
      { id: "PA", at },
      { id: "PC", at },
    ]);
    await setRoadmap([]);
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 2 }), "phase_snapshot");
    // Same timestamp → id ASC: PA, PB kept; PC dropped.
    expect(plan.would_keep.map((i) => i.id).sort()).toEqual(["PA", "PB"]);
    expect(plan.would_drop.map((i) => i.id)).toEqual(["PC"]);
  });
});

describe("planArchiveRetention — the reference gate is fail-CLOSED", () => {
  it("a roadmap-referenced phase is blocked regardless of age", async () => {
    await archivePhases([{ id: "P1", at: "2020-01-01T00:00:00.000Z" }]); // very old
    // P1 stays in the roadmap → referenced.
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 1 }), "phase_snapshot");
    expect(plan.would_drop).toEqual([]);
    expect(plan.blocked.map((i) => i.reason)).toEqual(["referenced_by_roadmap"]);
  });

  it("AMBIGUOUS task id (same id in two archived snapshots) → both blocked, never dropped", async () => {
    await archivePhases([
      { id: "PX", at: "2026-01-01T00:00:00.000Z" },
      { id: "PY", at: "2026-02-01T00:00:00.000Z" },
    ]);
    await setRoadmap([]);
    // Forge a task-id collision: rewrite PY's snapshot to also contain task "PX-T1".
    const pyPath = phaseSnapshotPath(cwd, "PY");
    const py = JSON.parse(await readFile(pyPath, "utf8"));
    const pxTask = JSON.parse(await readFile(phaseSnapshotPath(cwd, "PX"), "utf8")).tasks[0];
    py.tasks.push(pxTask); // PY now also holds PX-T1
    await writeFile(pyPath, JSON.stringify(py, null, 2) + "\n", "utf8");
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 5 }), "phase_snapshot");
    expect(plan.would_drop).toEqual([]); // ambiguity blocks both — nothing dropped
    expect(plan.blocked.map((i) => i.reason)).toEqual(["ambiguous", "ambiguous"]);
  });

  it("an INVALID archived snapshot is blocked, NOT ignored-then-treated-droppable", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    await setRoadmap([]);
    await writeFile(phaseSnapshotPath(cwd, "P1"), "{ not a valid snapshot", "utf8"); // corrupt
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 5 }), "phase_snapshot");
    expect(plan.blocked.find((i) => i.id === "P1")!.reason).toBe("invalid");
    expect(plan.would_drop).toEqual([]); // P2 fits within keepLatest 5; P1 is blocked not dropped
  });

  it("a missing/unreadable roadmap → ALL phase retention blocked (fail-closed, never all-unreferenced)", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    await rm(join(cwd, "design", "roadmap.yaml")); // live reference set is now UNKNOWN
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 1 }), "phase_snapshot");
    expect(plan.would_drop).toEqual([]);
    expect(plan.would_keep).toEqual([]);
    expect(plan.blocked.every((i) => i.reason === "reference_scan_failed")).toBe(true);
    expect(plan.blocked.length).toBe(2);
  });

  it("a CORRUPT bundle store (partial enumeration view) → ALL phase snapshots blocked, NONE dropped", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    await setRoadmap([]); // would otherwise be unreferenced + droppable
    // A Tier-1-invalid bundle makes the store load throw → the enumeration is a PARTIAL view
    // (bundle-only snapshots are invisible) → never rank/drop on it.
    await mkdir(join(cwd, ".code-pact", "state", "archive", "bundles"), { recursive: true });
    await writeFile(join(cwd, ".code-pact", "state", "archive", "bundles", "phase_snapshot-deadbeefdeadbeef.json"), "{ not a bundle", "utf8");
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 1 }), "phase_snapshot");
    expect(plan.would_drop).toEqual([]);
    expect(plan.would_keep).toEqual([]);
    expect(plan.blocked.filter((i) => i.id === "P1" || i.id === "P2").map((i) => i.reason)).toEqual([
      "reference_scan_failed",
      "reference_scan_failed",
    ]);
  });
});

describe("planArchiveRetention — event_pack AUTHORITY (a pack is validated, not just id-followed)", () => {
  const eventsFor = (id: string) =>
    ProgressLog.parse({
      events: [{ task_id: `${id}-T1`, status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
    }).events;

  it("a MISFILED pack (filename P1, body phase_id P2) is NOT dropped with P1 → blocked invalid", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const pack = await buildValidEventPack(cwd, "P1", eventsFor("P1"));
    await writeEventPackFile(cwd, "P1", { ...pack, phase_id: "P2" }); // file P1.json, body says P2
    await setRoadmap([]); // both unreferenced → keepLatest 1 makes P1 the would_drop phase
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 1 }), "event_pack");
    expect(plan.would_drop).toEqual([]);
    expect(plan.blocked.find((i) => i.id === "P1")!.reason).toBe("invalid");
  });

  it("a pack with a broken event_ids_sha256 is NOT dropped with its phase → blocked invalid", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const pack = await buildValidEventPack(cwd, "P1", eventsFor("P1"));
    await writeEventPackFile(cwd, "P1", { ...pack, event_ids_sha256: "0".repeat(64) }); // tampered checksum
    await setRoadmap([]);
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 1 }), "event_pack");
    expect(plan.would_drop).toEqual([]);
    expect(plan.blocked.find((i) => i.id === "P1")!.reason).toBe("invalid");
  });

  it("a bundle-only event_pack member that is Tier-1-invalid for the kind → blocked invalid, not dropped", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    // A valid bundle WRAPPER (correct sha/order/member_ids_sha256) whose member BYTES are an
    // event_pack misfiled to P2 — loadArchiveBundles Tier-1 passes, but the pack is invalid.
    const bad = { ...(await buildValidEventPack(cwd, "P1", eventsFor("P1"))), phase_id: "P2" };
    const bytes = JSON.stringify(bad, null, 2) + "\n";
    const dir = archiveBundlesDir(cwd);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "ep.json"),
      JSON.stringify({
        schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
        kind: "event_pack",
        member_ids_sha256: computeMemberIdsSha256(["P1"]),
        members: [{ id: "P1", sha256: sha256Hex(bytes), bytes }],
      }),
      "utf8",
    );
    await setRoadmap([]);
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 1 }), "event_pack");
    expect(plan.would_drop).toEqual([]);
    expect(plan.blocked.find((i) => i.id === "P1")!.reason).toBe("invalid");
  });
});

describe("planArchiveRetention — event_pack is DEPENDENT on its phase snapshot", () => {
  it("a pack drops only when its phase snapshot drops; otherwise it is kept", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    // Build event packs for both phases (so archive/event-packs has P1, P2).
    const { buildValidEventPack, writeEventPackFile } = await import("../../../helpers/event-pack-fixture.ts");
    const { ProgressLog } = await import("../../../../src/core/schemas/progress-event.ts");
    for (const id of ["P1", "P2"]) {
      const events = ProgressLog.parse({
        events: [{ task_id: `${id}-T1`, status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
      }).events;
      await writeEventPackFile(cwd, id, await buildValidEventPack(cwd, id, events));
    }
    await setRoadmap([]); // both phases unreferenced
    const plans = await planArchiveRetention(cwd, { keepLatest: 1 });
    const phase = planFor(plans, "phase_snapshot");
    const pack = planFor(plans, "event_pack");
    // P2 kept (latest 1), P1 dropped → pack P1 drops with it, pack P2 kept.
    expect(phase.would_drop.map((i) => i.id)).toEqual(["P1"]);
    expect(pack.would_drop.map((i) => i.id)).toEqual(["P1"]);
    expect(pack.blocked.map((i) => i.id)).toContain("P2");
    expect(pack.blocked.find((i) => i.id === "P2")!.reason).toBe("dependent_on_kept_phase_snapshot");
  });
});

describe("planArchiveRetention — archive AUTHORITY validation (schema-valid ≠ trustworthy)", () => {
  const ADR = `# RFC\n\n**Status:** accepted (P9, 2026-06)\n\n## Summary\n\nX.\n`;
  const tamper = async (path: string, mut: (o: Record<string, unknown>) => void): Promise<void> => {
    const o = JSON.parse(await readFile(path, "utf8"));
    mut(o);
    await writeFile(path, JSON.stringify(o, null, 2) + "\n", "utf8");
  };

  it("phase snapshot whose body phase_id != its filename → blocked invalid, NEVER dropped", async () => {
    await archivePhases([{ id: "P1", at: "2026-01-01T00:00:00.000Z" }]);
    await setRoadmap([]);
    await tamper(phaseSnapshotPath(cwd, "P1"), (o) => (o.phase_id = "PZ")); // misfiled: P1.json claims to be PZ
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 5 }), "phase_snapshot");
    expect(plan.would_drop).toEqual([]);
    expect(plan.blocked.map((i) => [i.id, i.reason])).toEqual([["P1", "invalid"]]);
  });

  it("phase snapshot whose path_sha256 does not cover its original_path → blocked invalid", async () => {
    await archivePhases([{ id: "P1", at: "2026-01-01T00:00:00.000Z" }]);
    await setRoadmap([]);
    await tamper(phaseSnapshotPath(cwd, "P1"), (o) => (o.path_sha256 = "0".repeat(64)));
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 5 }), "phase_snapshot");
    expect(plan.would_drop).toEqual([]);
    expect(plan.blocked.find((i) => i.id === "P1")!.reason).toBe("invalid");
  });

  it("decision record whose canonical_ref disagrees with its filename stem → blocked invalid", async () => {
    const DEC = "design/decisions/foo-rfc.md";
    await writeFile(join(cwd, DEC), ADR, "utf8");
    await writeDecisionRecord(cwd, DEC, { now: new Date("2026-01-01T00:00:00.000Z") });
    await setRoadmap([]);
    await tamper(decisionRecordPath(cwd, DEC), (o) => {
      o.canonical_ref = "design/decisions/other-rfc.md"; // id no longer matches stem(canonical_ref)
      o.original_path = "design/decisions/other-rfc.md";
    });
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 5 }), "decision_record");
    expect(plan.would_drop).toEqual([]);
    expect(plan.blocked.some((i) => i.reason === "invalid")).toBe(true);
  });

  it("decision record whose path_sha256 mismatches its canonical_ref → blocked invalid", async () => {
    const DEC = "design/decisions/foo-rfc.md";
    await writeFile(join(cwd, DEC), ADR, "utf8");
    await writeDecisionRecord(cwd, DEC, { now: new Date("2026-01-01T00:00:00.000Z") });
    await setRoadmap([]);
    await tamper(decisionRecordPath(cwd, DEC), (o) => (o.path_sha256 = "0".repeat(64)));
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 5 }), "decision_record");
    expect(plan.would_drop).toEqual([]);
    expect(plan.blocked.find((i) => i.reason === "invalid")).toBeDefined();
  });

  it("the core planArchiveRetention rejects keepLatest < 1 (the delete authority can't bypass the bound)", async () => {
    await expect(planArchiveRetention(cwd, { keepLatest: 0 })).rejects.toThrow(/≥ 1/);
  });
});

describe("planArchiveRetention — decision_record", () => {
  const DEC = "design/decisions/foo-rfc.md";
  const ADR = `# RFC\n\n**Status:** accepted (P9, 2026-06)\n\n## Summary\n\nSettled.\n`;

  it("a decision referenced by a live task decision_refs is blocked; an unreferenced one obeys keep-latest", async () => {
    await writeFile(join(cwd, DEC), ADR, "utf8");
    expect((await writeDecisionRecord(cwd, DEC, { now: new Date("2026-01-01T00:00:00.000Z") })).kind).toBe("written");
    // A live phase whose task references the decision.
    await setRoadmap(["LP"], { LP: { decisionRefs: [DEC] } });
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 1 }), "decision_record");
    expect(plan.would_drop).toEqual([]);
    expect(plan.blocked.map((i) => i.reason)).toEqual(["referenced_by_decision_link"]);
    expect(plan.blocked[0]!.references?.[0]?.type).toBe("decision_ref");
  });

  it("decision reference scan fails (roadmap unreadable) → decision retention blocked, never dropped", async () => {
    await writeFile(join(cwd, DEC), ADR, "utf8");
    await writeDecisionRecord(cwd, DEC, { now: new Date("2026-01-01T00:00:00.000Z") });
    // No roadmap exists → the live reference set is UNKNOWN → fail-closed.
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 1 }), "decision_record");
    expect(plan.would_drop).toEqual([]);
    expect(plan.blocked.map((i) => i.reason)).toEqual(["reference_scan_failed"]);
  });
});
