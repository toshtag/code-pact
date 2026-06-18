import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import { writeDecisionRecord } from "../../../../src/core/archive/decision-record.ts";
import {
  applyArchiveRetention,
  planArchiveRetention,
  resolveKeepLatest,
  type RetentionPlan,
} from "../../../../src/core/archive/archive-retention.ts";
import { writeArchiveBundle } from "../../../../src/core/archive/archive-bundle-writer.ts";
import { loadArchiveBundles } from "../../../../src/core/archive/archive-bundle-loader.ts";
import {
  __setDeleteIntentDirFsyncForTests,
  DeleteIntentDurabilityError,
  writeDeleteIntent,
} from "../../../../src/core/archive/delete-intent-journal.ts";
import { phaseSnapshotPath, decisionRecordPath, eventPackPath, archiveBundlesDir, archiveDeleteIntentPath, archiveEventPacksDir, sha256Hex } from "../../../../src/core/archive/paths.ts";
import { computeMemberIdsSha256 } from "../../../../src/core/archive/archive-bundle-reader.ts";
import { decisionRecordStem } from "../../../../src/core/archive/archive-bundle-binding.ts";
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
  __setDeleteIntentDirFsyncForTests(null); // clear any injected durability-barrier failure
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
const exists = (p: string): Promise<boolean> => readFile(p, "utf8").then(() => true, () => false);

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

describe("planArchiveRetention — source:both STRICT-RECONCILE (a retention delete removes BOTH copies)", () => {
  const ADR = `# RFC\n\n**Status:** accepted (P9, 2026-06)\n\n## Summary\n\nX.\n`;
  // Write a Tier-1-VALID bundle holding `members` directly (loadArchiveBundles tolerates any
  // member-body bytes — only the wrapper sha/order/checksum are validated here).
  async function rawBundle(kind: string, members: { id: string; bytes: string }[]): Promise<void> {
    const dir = archiveBundlesDir(cwd);
    await mkdir(dir, { recursive: true });
    const full = members
      .map((m) => ({ id: m.id, sha256: sha256Hex(m.bytes), bytes: m.bytes }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    await writeFile(
      join(dir, `${kind}-shadow.json`),
      JSON.stringify({
        schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
        kind,
        member_ids_sha256: computeMemberIdsSha256(full.map((m) => m.id)),
        members: full,
      }),
      "utf8",
    );
  }
  // A different-but-valid serialization (compact JSON) of the same record — both copies are
  // individually valid yet byte-DIVERGENT, the case the reviewer flagged as still unsafe.
  const compact = (raw: string): string => JSON.stringify(JSON.parse(raw));

  it("phase_snapshot in BOTH loose+bundle with divergent (compact) shadow → blocked bundle_stale, never dropped", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    await setRoadmap([]); // both unreferenced; keepLatest 1 would otherwise drop P1
    const loose = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    await rawBundle("phase_snapshot", [{ id: "P1", bytes: compact(loose) }]); // shadow ≠ loose bytes
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 1 }), "phase_snapshot");
    expect(plan.would_drop).toEqual([]);
    expect(plan.blocked.find((i) => i.id === "P1")!.reason).toBe("bundle_stale");
  });

  it("decision_record in BOTH loose+bundle with divergent shadow → blocked bundle_stale, never dropped", async () => {
    const DEC = "design/decisions/foo-rfc.md";
    await writeFile(join(cwd, DEC), ADR, "utf8");
    await writeDecisionRecord(cwd, DEC, { now: new Date("2026-01-01T00:00:00.000Z") });
    await setRoadmap([]);
    const stem = decisionRecordStem(DEC);
    const loose = await readFile(decisionRecordPath(cwd, DEC), "utf8");
    await rawBundle("decision_record", [{ id: stem, bytes: compact(loose) }]);
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 1 }), "decision_record");
    expect(plan.would_drop).toEqual([]);
    expect(plan.blocked.find((i) => i.id === stem)!.reason).toBe("bundle_stale");
  });

  it("event_pack in BOTH loose+bundle with divergent shadow → blocked bundle_stale, never dropped", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const events = ProgressLog.parse({
      events: [{ task_id: "P1-T1", status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
    }).events;
    const pack = await buildValidEventPack(cwd, "P1", events);
    await writeEventPackFile(cwd, "P1", pack); // loose (2-space) valid
    await rawBundle("event_pack", [{ id: "P1", bytes: JSON.stringify(pack) }]); // compact shadow ≠ loose
    await setRoadmap([]);
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 1 }), "event_pack");
    expect(plan.would_drop).toEqual([]);
    expect(plan.blocked.find((i) => i.id === "P1")!.reason).toBe("bundle_stale");
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

describe("planArchiveRetention — a pending delete-intent hides the pair from the planner", () => {
  it("a phase named in a pending delete-intent is absent from the plan (dry-run consistency)", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    await setRoadmap([]); // both unreferenced
    // P1 is mid-deletion (a pending intent). The planner must treat it as already gone.
    await writeDeleteIntent(cwd, [{ intent_kind: "loose_pair", phase_id: "P1", phase_sha256: sha256Hex("x"), pack_sha256: sha256Hex("y") }]);
    const plan = planFor(await planArchiveRetention(cwd, { keepLatest: 5 }), "phase_snapshot");
    const ids = [...plan.would_keep, ...plan.would_drop, ...plan.blocked].map((i) => i.id);
    expect(ids).not.toContain("P1"); // logically absent — not re-planned for drop
    expect(ids).toContain("P2");
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

describe("applyArchiveRetention — destructive LOOSE-ONLY delete (PR-2a)", () => {
  it("deletes a loose-only would_drop phase snapshot that has NO event_pack (an independent record); keeps the would_keep", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    await setRoadmap([]); // both unreferenced; keepLatest 1 → P2 keep, P1 drop — and P1 has NO pack
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    // A phase snapshot with no event_pack is independent (nothing binds to it), so it is a single
    // atomic unlink — safe to delete in PR-2a.
    expect(phase.deleted).toEqual(["P1"]);
    expect(phase.skipped).toEqual([]);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false); // old truth dropped
    expect(await exists(phaseSnapshotPath(cwd, "P2"))).toBe(true); // kept
  });

  it("a referenced record is NEVER deleted (the apply re-plans as the authority)", async () => {
    await archivePhases([{ id: "P1", at: "2020-01-01T00:00:00.000Z" }]); // very old but still in roadmap
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    expect(out.find((o) => o.kind === "phase_snapshot")!.deleted).toEqual([]);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true);
  });

  it("a byte-identical BOTH INDEPENDENT phase (no pack) → bundle_member_removed (the loose copy survives)", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const looseP1 = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: looseP1 }]); // P1 now loose+bundle, no pack → independent
    await setRoadmap([]);
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    expect(phase.deleted).toEqual([]); // NOT deleted — the loose copy still resolves
    expect(phase.bundle_member_removed).toContain("P1"); // the bundle member IS removed (the loose layer drops the loose next run)
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true); // loose half survives
    expect(loadArchiveBundles(cwd).index.get("phase_snapshot")?.has("P1") ?? false).toBe(false); // bundle member gone
  });

  it("a bundle-only INDEPENDENT phase (no pack) → deleted (the bundle member is removed, no copy resolves)", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const looseP1 = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: looseP1 }]);
    await rm(phaseSnapshotPath(cwd, "P1")); // P1 now bundle-only, no pack → independent
    await setRoadmap([]);
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    expect(phase.deleted).toContain("P1"); // independent bundle phase removed (no copy resolves)
    expect(loadArchiveBundles(cwd).index.get("phase_snapshot")?.has("P1") ?? false).toBe(false); // bundle member gone
  });

  it("a loose phase + loose pack PAIR is DELETED via the journal (both gone, both-or-neither)", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const events = ProgressLog.parse({
      events: [{ task_id: "P1-T1", status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
    }).events;
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    await setRoadmap([]); // P1 (phase + pack) both loose, both would_drop
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    // The loose pair is removed crash-safe via the delete-intent journal — both gone.
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    const event = out.find((o) => o.kind === "event_pack")!;
    expect(phase.deleted).toContain("P1");
    expect(event.deleted).toContain("P1");
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false);
    expect(await exists(phaseSnapshotPath(cwd, "P2"))).toBe(true); // kept
  });

  it("a loose pair is removed via the JOURNAL, not the per-record gate — the apply's beforeGate is never called for it", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const events = ProgressLog.parse({
      events: [{ task_id: "P1-T1", status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
    }).events;
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    await setRoadmap([]); // P1 phase + pack both loose would_drop = a journal-able pair
    const gated: string[] = [];
    // The pair goes through deleteLoosePairsJournaled (its OWN gate), so the apply's per-record
    // beforeGate is never called for P1 — yet the pair IS deleted (both-or-neither, via the journal).
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 }, { beforeGate: (kind, id) => void gated.push(`${kind}:${id}`) });
    expect(gated).not.toContain("event_pack:P1");
    expect(gated).not.toContain("phase_snapshot:P1");
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false);
    expect(out.find((o) => o.kind === "event_pack")!.deleted).toContain("P1");
  });

  it("RECOVERS a crashed prior pair-delete FIRST (before planning) — a pending journal is completed", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const events = ProgressLog.parse({
      events: [{ task_id: "P1-T1", status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
    }).events;
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    await setRoadmap([]);
    // Simulate a prior crash mid-delete: a pending journal naming P1, both files still present.
    await writeDeleteIntent(cwd, [{ intent_kind: "loose_pair", phase_id: "P1", phase_sha256: sha256Hex("p"), pack_sha256: sha256Hex("k") }]);
    const out = await applyArchiveRetention(cwd, { keepLatest: 5 }); // keepLatest high → nothing NEW would drop
    // Recovery completed P1's deletion (both gone) and cleared the journal, before the planner ran.
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false);
    expect(await readFile(archiveDeleteIntentPath(cwd), "utf8").then(() => true, () => false)).toBe(false);
    // The recovery-completed drop of old truth is REPORTED — in `recovered` (not `deleted`, which is
    // reserved for THIS run's plan decisions) — on both bound kinds. Never a silent deletion.
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    const event = out.find((o) => o.kind === "event_pack")!;
    expect(phase.recovered).toEqual([{ id: "P1", intent_kind: "loose_pair" }]);
    expect(event.recovered).toEqual([{ id: "P1", intent_kind: "loose_pair" }]);
    expect(phase.deleted).not.toContain("P1");
    expect(event.deleted).not.toContain("P1");
  });

  it("HALF-VANISHED pair (pack vanishes at the gate) → ONLY event_pack reports vanished; the present phase is skipped", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const events = ProgressLog.parse({
      events: [{ task_id: "P1-T1", status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
    }).events;
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    await setRoadmap([]); // P1 is a loose-loose pair at plan time
    // Between the plan and the journal gate, the pack vanishes (e.g. an out-of-lock removal).
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 }, {
      beforePairGate: async (kind, id) => {
        if (kind === "event_pack" && id === "P1") await rm(eventPackPath(cwd, "P1"));
      },
    });
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    const event = out.find((o) => o.kind === "event_pack")!;
    expect(event.vanished).toContain("P1"); // the pack was genuinely gone
    expect(phase.vanished).not.toContain("P1"); // the phase is PRESENT — never falsely vanished
    expect(phase.skipped.find((s) => s.id === "P1")?.reason).toBe("requires_atomic_pair_removal");
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true); // and it really is still on disk
  });

  it("HALF-VANISHED pair (phase vanishes at the gate) → ONLY phase_snapshot reports vanished; the present pack is skipped", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const events = ProgressLog.parse({
      events: [{ task_id: "P1-T1", status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
    }).events;
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    await setRoadmap([]);
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 }, {
      beforePairGate: async (kind, id) => {
        if (kind === "phase_snapshot" && id === "P1") await rm(phaseSnapshotPath(cwd, "P1"));
      },
    });
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    const event = out.find((o) => o.kind === "event_pack")!;
    expect(phase.vanished).toContain("P1");
    expect(event.vanished).not.toContain("P1"); // the pack is PRESENT
    expect(event.skipped.find((s) => s.id === "P1")?.reason).toBe("requires_atomic_pair_removal");
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true);
  });

  it("BOTH-VANISHED pair (both sides vanish at the gate) → both kinds report vanished, no journal", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const events = ProgressLog.parse({
      events: [{ task_id: "P1-T1", status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
    }).events;
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    await setRoadmap([]);
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 }, {
      beforePairGate: async (_kind, id) => {
        if (id === "P1") {
          await rm(eventPackPath(cwd, "P1"), { force: true });
          await rm(phaseSnapshotPath(cwd, "P1"), { force: true });
        }
      },
    });
    expect(out.find((o) => o.kind === "phase_snapshot")!.vanished).toContain("P1");
    expect(out.find((o) => o.kind === "event_pack")!.vanished).toContain("P1");
    expect(await readFile(archiveDeleteIntentPath(cwd), "utf8").then(() => true, () => false)).toBe(false); // nothing committed
  });

  it("reports a HALF-recovered journal (pack already gone, phase present) in recovered[] too", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const events = ProgressLog.parse({
      events: [{ task_id: "P1-T1", status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
    }).events;
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    await setRoadmap([]);
    await writeDeleteIntent(cwd, [{ intent_kind: "loose_pair", phase_id: "P1", phase_sha256: sha256Hex("p"), pack_sha256: sha256Hex("k") }]);
    await rm(eventPackPath(cwd, "P1")); // crash AFTER the pack unlink, BEFORE the phase unlink
    const out = await applyArchiveRetention(cwd, { keepLatest: 5 });
    // Recovery completes the phase unlink (idempotent on the gone pack) and reports P1 recovered.
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    expect(out.find((o) => o.kind === "phase_snapshot")!.recovered).toEqual([{ id: "P1", intent_kind: "loose_pair" }]);
    expect(out.find((o) => o.kind === "event_pack")!.recovered).toEqual([{ id: "P1", intent_kind: "loose_pair" }]);
  });

  it("on a platform that cannot fsync a directory (unsupported), a loose pair is DEFERRED, not deleted", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const events = ProgressLog.parse({
      events: [{ task_id: "P1-T1", status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
    }).events;
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    await setRoadmap([]);
    // The journal's durable commit barrier reports the platform cannot fsync a directory.
    __setDeleteIntentDirFsyncForTests(() => {
      throw new DeleteIntentDurabilityError("unsupported", "directory fsync unsupported");
    });
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    // Durable pair deletion is unavailable → the pair is deferred (same conservative posture as PR-2a).
    expect(out.find((o) => o.kind === "phase_snapshot")!.skipped.find((s) => s.id === "P1")?.reason).toBe("requires_atomic_pair_removal");
    expect(out.find((o) => o.kind === "event_pack")!.skipped.find((s) => s.id === "P1")?.reason).toBe("requires_atomic_pair_removal");
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true); // not deleted
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true);
    // CRITICAL: no journal was left on disk — so a later mutation's recovery cannot silently
    // delete the pair the run reported as deferred (the preflight aborts before any journal write).
    expect(await readFile(archiveDeleteIntentPath(cwd), "utf8").then(() => true, () => false)).toBe(false);
  });

  it("a loose pack whose phase is bundle-only is SKIPPED — deleting it would strand the surviving snapshot's evidence", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const events = ProgressLog.parse({
      events: [{ task_id: "P1-T1", status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
    }).events;
    const pack = await buildValidEventPack(cwd, "P1", events); // BEFORE compacting the snapshot away
    const looseP1 = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: looseP1 }]);
    await rm(phaseSnapshotPath(cwd, "P1")); // phase P1 now bundle-only (its loose can't be deleted in PR-2a)
    await writeEventPackFile(cwd, "P1", pack); // pack loose, would_drop
    await setRoadmap([]);
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    // The snapshot survives (bundle-only), and its progress_events evidence resolves from this pack
    // — deleting the pack would leave the snapshot's evidence dangling. The pack is a bound pair
    // half, so it is deferred whole; the snapshot stays in the bundle.
    expect(out.find((o) => o.kind === "event_pack")!.deleted).toEqual([]);
    expect(out.find((o) => o.kind === "event_pack")!.skipped.find((s) => s.id === "P1")?.reason).toBe(
      "requires_atomic_pair_removal",
    );
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true); // the loose pack is NOT deleted
    expect(out.find((o) => o.kind === "phase_snapshot")!.skipped.find((s) => s.id === "P1")?.reason).toBe(
      "needs_bundle_member_removal",
    );
  });

  it("a loose pack whose phase is source:both is SKIPPED — the pair is not co-removable", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const events = ProgressLog.parse({
      events: [{ task_id: "P1-T1", status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
    }).events;
    const looseP1 = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: looseP1 }]); // phase P1 now source:both (loose kept)
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events)); // pack loose, would_drop
    await setRoadmap([]);
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    // phase P1 is `both` → not loose-only removable in PR-2a → its pack (a bound pair half) is
    // deferred whole, never deleted.
    expect(out.find((o) => o.kind === "event_pack")!.deleted).toEqual([]);
    expect(out.find((o) => o.kind === "event_pack")!.skipped.find((s) => s.id === "P1")?.reason).toBe(
      "requires_atomic_pair_removal",
    );
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true);
  });

  it("event_pack loose store unreadable (partial view) → NO phase snapshot is deleted (fail-closed)", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    await setRoadmap([]); // phase P1 loose would_drop (no pack); phase store is fine
    // Make the loose event-pack dir UNREADABLE without touching the bundle store or the phase
    // store: a FILE at the event-packs dir path → readdir gives ENOTDIR (a non-ENOENT error) →
    // the event_pack source map cannot be built → the planner emits a `(store)` block. The apply
    // then cannot enumerate packs, so it must NOT delete any phase snapshot (a pack it could not
    // see could be bound to / depended on by the snapshot). The phase store being fine is exactly
    // what makes phase P1 a would_drop — so this proves the apply's own fail-closed guard, not the
    // planner blocking the phase.
    await writeFile(archiveEventPacksDir(cwd), "not a directory", "utf8");
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    expect(out.find((o) => o.kind === "phase_snapshot")!.deleted).toEqual([]);
    expect(out.find((o) => o.kind === "phase_snapshot")!.skipped.find((s) => s.id === "P1")?.reason).toBe(
      "requires_atomic_pair_removal",
    );
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true);
  });

  it("a phase snapshot whose event_pack is NOT removable (bundle-only) is SKIPPED — never orphan the pack", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    // P1 phase snapshot stays LOOSE (would_drop); its event_pack is BUNDLE-ONLY (can't be removed).
    const events = ProgressLog.parse({
      events: [{ task_id: "P1-T1", status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
    }).events;
    const pack = await buildValidEventPack(cwd, "P1", events);
    await writeArchiveBundle(cwd, "event_pack", [{ id: "P1", bytes: JSON.stringify(pack, null, 2) + "\n" }]);
    await setRoadmap([]);
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    // Deleting the loose phase snapshot would orphan the surviving bundle pack → the pair is kept.
    expect(out.find((o) => o.kind === "phase_snapshot")!.deleted).toEqual([]);
    expect(out.find((o) => o.kind === "phase_snapshot")!.skipped.find((s) => s.id === "P1")?.reason).toBe(
      "requires_atomic_pair_removal",
    );
    expect(out.find((o) => o.kind === "event_pack")!.skipped.find((s) => s.id === "P1")?.reason).toBe(
      "needs_bundle_member_removal",
    );
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true);
  });

  it("a phase snapshot whose event_pack is source:both is SKIPPED (a both pack is not removable in PR-2a)", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const events = ProgressLog.parse({
      events: [{ task_id: "P1-T1", status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
    }).events;
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events)); // loose pack
    const loosePack = await readFile(eventPackPath(cwd, "P1"), "utf8");
    await writeArchiveBundle(cwd, "event_pack", [{ id: "P1", bytes: loosePack }]); // byte-identical bundle → source:both
    await setRoadmap([]);
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    // The phase has an event_pack (here a `both` one) → a bound pair → the phase is deferred whole.
    expect(out.find((o) => o.kind === "phase_snapshot")!.skipped.find((s) => s.id === "P1")?.reason).toBe(
      "requires_atomic_pair_removal",
    );
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true);
  });

  it("phase loose SWAPPED to another valid record between plan and unlink → skipped authority_changed, NOT deleted", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    await setRoadmap([]); // P1 would_drop
    const original = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    const out = await applyArchiveRetention(
      cwd,
      { keepLatest: 1 },
      {
        beforeGate: async (kind, id) => {
          // After the plan read P1, swap it to a DIFFERENT-but-authority-valid serialization.
          if (kind === "phase_snapshot" && id === "P1") {
            await writeFile(phaseSnapshotPath(cwd, "P1"), JSON.stringify(JSON.parse(original)), "utf8");
          }
        },
      },
    );
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    expect(phase.deleted).toEqual([]); // the on-disk bytes changed since the plan → not deleted
    expect(phase.skipped.find((s) => s.id === "P1")?.reason).toBe("authority_changed");
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true); // the swapped copy survives
  });

  it("decision loose SWAPPED between plan and unlink → skipped authority_changed, NOT deleted", async () => {
    const D1 = "design/decisions/d1-rfc.md";
    const D2 = "design/decisions/d2-rfc.md";
    const ADR = `# RFC\n\n**Status:** accepted (P9, 2026-06)\n\n## Summary\n\nX.\n`;
    await writeFile(join(cwd, D1), ADR, "utf8");
    await writeFile(join(cwd, D2), ADR, "utf8");
    await writeDecisionRecord(cwd, D1, { now: new Date("2026-01-01T00:00:00.000Z") });
    await writeDecisionRecord(cwd, D2, { now: new Date("2026-02-01T00:00:00.000Z") });
    await setRoadmap([]); // both unreferenced; keepLatest 1 → D2 keep, D1 (older) would_drop
    const stem1 = decisionRecordStem(D1);
    const original = await readFile(decisionRecordPath(cwd, D1), "utf8");
    const out = await applyArchiveRetention(
      cwd,
      { keepLatest: 1 },
      {
        beforeGate: async (kind, id) => {
          if (kind === "decision_record" && id === stem1) {
            await writeFile(decisionRecordPath(cwd, D1), JSON.stringify(JSON.parse(original)), "utf8");
          }
        },
      },
    );
    const dec = out.find((o) => o.kind === "decision_record")!;
    expect(dec.deleted).toEqual([]);
    expect(dec.skipped.find((s) => s.id === stem1)?.reason).toBe("authority_changed");
  });

  it("IDEMPOTENT: a record whose loose is already gone is a clean no-op (re-plan never sees it)", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    await setRoadmap([]);
    // Remove P1's loose BEFORE the run: the apply's internal re-plan (the authority) never sees
    // it, so it is neither deleted nor skipped — exactly how a second --write after the first
    // is a clean no-op. (The vanish-BETWEEN-re-plan-and-unlink race is handled by the gate's
    // ENOENT → vanished path; this asserts the already-gone case.)
    await rm(phaseSnapshotPath(cwd, "P1"));
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    expect(phase.deleted).toEqual([]);
    expect(phase.skipped).toEqual([]);
    expect(await exists(phaseSnapshotPath(cwd, "P2"))).toBe(true);
  });
});

describe("applyArchiveRetention — bundle-pair removal (CLI wiring, Layer 2)", () => {
  /** Make an already-archived `id` a BUNDLE pair: build its pack from the loose snapshot, bundle the
   *  snapshot AND the pack, then remove the loose copies (bundle-only). */
  async function toBundlePair(id: string): Promise<{ snap: string; pack: string }> {
    const events = ProgressLog.parse({ events: [{ task_id: `${id}-T1`, status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }] }).events;
    const packBytes = JSON.stringify(await buildValidEventPack(cwd, id, events), null, 2) + "\n";
    const snap = await readFile(phaseSnapshotPath(cwd, id), "utf8");
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id, bytes: snap }]);
    await writeArchiveBundle(cwd, "event_pack", [{ id, bytes: packBytes }]);
    await rm(phaseSnapshotPath(cwd, id));
    return { snap, pack: packBytes };
  }

  it("a would_drop BUNDLE pair (phase + pack both bundled) is REMOVED both-or-neither → deleted", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    await toBundlePair("P1"); // P1 phase + pack → a bundle pair; P2 stays loose (the keep)
    await setRoadmap([]); // both unreferenced; keepLatest 1 keeps P2 (latest), drops P1

    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    const event = out.find((o) => o.kind === "event_pack")!;
    expect(phase.deleted).toContain("P1"); // no copy of P1 resolves anymore
    expect(event.deleted).toContain("P1");
    expect(phase.bundle_member_removed).toEqual([]);
    // P1 is gone from BOTH bundle stores; P2 (loose) survives.
    const idx = loadArchiveBundles(cwd).index;
    expect(idx.get("phase_snapshot")?.has("P1") ?? false).toBe(false);
    expect(idx.get("event_pack")?.has("P1") ?? false).toBe(false);
    expect(await exists(phaseSnapshotPath(cwd, "P2"))).toBe(true);
  });

  it("a MIXED pair (phase `both`, pack `bundle`) is DEFERRED whole — never a snapshot-without-pack half-state", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const { snap } = await toBundlePair("P1");
    await writeFile(phaseSnapshotPath(cwd, "P1"), snap, "utf8"); // phase `both`; pack stays bundle-only → MIXED
    await setRoadmap([]);

    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    const event = out.find((o) => o.kind === "event_pack")!;
    expect(phase.bundle_member_removed).not.toContain("P1");
    expect(event.deleted).not.toContain("P1");
    expect(phase.skipped.find((s) => s.id === "P1")?.reason).toBe("needs_bundle_member_removal");
    expect(event.skipped.find((s) => s.id === "P1")?.reason).toBe("needs_bundle_member_removal");
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true); // phase loose survives
    expect(loadArchiveBundles(cwd).index.get("event_pack")?.has("P1") ?? false).toBe(true); // pack bundle survives (not orphaned)
  });

  it("a MIXED pair (phase `bundle`, pack `both`) is DEFERRED whole — never an orphan pack", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const { pack } = await toBundlePair("P1");
    await writeEventPackFile(cwd, "P1", JSON.parse(pack)); // pack `both`; phase stays bundle-only → MIXED
    await setRoadmap([]);

    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    const event = out.find((o) => o.kind === "event_pack")!;
    expect(phase.deleted).not.toContain("P1");
    expect(event.bundle_member_removed).not.toContain("P1");
    expect(phase.skipped.find((s) => s.id === "P1")?.reason).toBe("needs_bundle_member_removal");
    expect(event.skipped.find((s) => s.id === "P1")?.reason).toBe("needs_bundle_member_removal");
    expect(loadArchiveBundles(cwd).index.get("phase_snapshot")?.has("P1") ?? false).toBe(true); // phase bundle survives
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true); // pack loose survives
  });

  it("a `source: both` pair converges in ≤2 runs: run 1 bundle_member_removed, run 2 deleted", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const { snap, pack } = await toBundlePair("P1");
    // Re-materialize P1's loose copies so it is `both` (loose + bundle on each side).
    await writeFile(phaseSnapshotPath(cwd, "P1"), snap, "utf8");
    await writeEventPackFile(cwd, "P1", JSON.parse(pack));
    await setRoadmap([]);

    // RUN 1: the bundle members are removed; the loose copies SURVIVE → bundle_member_removed.
    const run1 = await applyArchiveRetention(cwd, { keepLatest: 1 });
    const phase1 = run1.find((o) => o.kind === "phase_snapshot")!;
    const event1 = run1.find((o) => o.kind === "event_pack")!;
    expect(phase1.bundle_member_removed).toContain("P1");
    expect(event1.bundle_member_removed).toContain("P1");
    expect(phase1.deleted).not.toContain("P1"); // NOT deleted — the loose copy still resolves
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true); // loose half survives
    const idx1 = loadArchiveBundles(cwd).index;
    expect(idx1.get("phase_snapshot")?.has("P1") ?? false).toBe(false); // bundle half gone

    // RUN 2: P1 is now `source: loose` (a loose pair) → the loose layer deletes it.
    const run2 = await applyArchiveRetention(cwd, { keepLatest: 1 });
    const phase2 = run2.find((o) => o.kind === "phase_snapshot")!;
    expect(phase2.deleted).toContain("P1"); // now fully deleted (no copy resolves)
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    expect(await exists(phaseSnapshotPath(cwd, "P2"))).toBe(true);
  });

  it("a crashed prior BUNDLE-pair delete is RECOVERED by the next run (reported `recovered`, not `deleted`)", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    await toBundlePair("P1");
    await toBundlePair("P2"); // both bundled so removing P1 leaves a P2 survivor bundle
    await setRoadmap([]);

    // Simulate a crash right after the bundle-pair commit (journal present, old bundles not retired).
    const { deleteBundlePairsJournaled } = await import("../../../../src/core/archive/retention-bundle-pair-delete.ts");
    await expect(
      deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }], { afterIntentWritten: () => { throw new Error("crash"); } }),
    ).rejects.toThrow("crash");

    // The next retention run RECOVERS the committed delete FIRST, then plans. keepLatest 5 → nothing
    // new drops, so P1 appears ONLY as `recovered` (a prior commit completed), never `deleted`.
    const out = await applyArchiveRetention(cwd, { keepLatest: 5 });
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    const event = out.find((o) => o.kind === "event_pack")!;
    expect(phase.recovered).toContainEqual({ id: "P1", intent_kind: "bundle_pair" });
    expect(event.recovered).toContainEqual({ id: "P1", intent_kind: "bundle_pair" });
    expect(phase.deleted).not.toContain("P1"); // recovery is NOT this run's plan decision
    expect(loadArchiveBundles(cwd).index.get("phase_snapshot")?.has("P1") ?? false).toBe(false); // retired
  });

  it("a recovered `both` bundle pair is reported `recovered` ONLY this run (not also `deleted`), then deleted NEXT run", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const { snap, pack } = await toBundlePair("P1");
    await toBundlePair("P2"); // P2 bundled so removing P1 leaves a P2 survivor bundle
    await writeFile(phaseSnapshotPath(cwd, "P1"), snap, "utf8"); // P1 is `both` — loose copies survive the bundle retire
    await writeEventPackFile(cwd, "P1", JSON.parse(pack));
    await setRoadmap([]);

    const { deleteBundlePairsJournaled } = await import("../../../../src/core/archive/retention-bundle-pair-delete.ts");
    await expect(
      deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }], { afterIntentWritten: () => { throw new Error("crash"); } }),
    ).rejects.toThrow("crash");

    // RUN 1: recovery retires P1's bundle members; P1's surviving loose copies are NOT also dropped
    // this run (that would double-bucket the id as recovered AND deleted). P1 is recovered ONLY.
    const run1 = await applyArchiveRetention(cwd, { keepLatest: 1 });
    const phase1 = run1.find((o) => o.kind === "phase_snapshot")!;
    expect(phase1.recovered).toContainEqual({ id: "P1", intent_kind: "bundle_pair" });
    expect(phase1.deleted).not.toContain("P1"); // never in two buckets in one run
    expect(phase1.bundle_member_removed).not.toContain("P1");
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true); // loose half deferred to next run

    // RUN 2: P1 is now a plain `source: loose` would_drop → the loose layer deletes it (converged).
    const run2 = await applyArchiveRetention(cwd, { keepLatest: 1 });
    expect(run2.find((o) => o.kind === "phase_snapshot")!.deleted).toContain("P1");
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
  });
});

describe("applyArchiveRetention — INDEPENDENT bundle records (single-kind Layer-1 wiring)", () => {
  const D1 = "design/decisions/old-rfc.md";
  const D2 = "design/decisions/new-rfc.md";
  const ADR = `# RFC\n\n**Status:** accepted (P9, 2026-06)\n\n## Summary\n\nSettled.\n`;

  it("an unreferenced bundle-only DECISION beyond keep-latest → deleted (single-kind removal, no journal)", async () => {
    await writeFile(join(cwd, D1), ADR, "utf8");
    await writeFile(join(cwd, D2), ADR, "utf8");
    expect((await writeDecisionRecord(cwd, D1, { now: new Date("2026-01-01T00:00:00.000Z") })).kind).toBe("written");
    expect((await writeDecisionRecord(cwd, D2, { now: new Date("2026-02-01T00:00:00.000Z") })).kind).toBe("written");
    // Bundle D1 (the older one) as bundle-only; D2 stays loose (the keep).
    const stem1 = decisionRecordStem(D1);
    const bytes1 = await readFile(decisionRecordPath(cwd, D1), "utf8");
    await writeArchiveBundle(cwd, "decision_record", [{ id: stem1, bytes: bytes1 }]);
    await rm(decisionRecordPath(cwd, D1));
    await setRoadmap(["LP"]); // a live phase that references no decision → D1/D2 unreferenced; scan succeeds

    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    const decision = out.find((o) => o.kind === "decision_record")!;
    expect(decision.deleted).toContain(stem1); // the bundle decision member is removed (no copy resolves)
    expect(loadArchiveBundles(cwd).index.get("decision_record")?.has(stem1) ?? false).toBe(false);
  });

  it("a `source: both` bundle DECISION → bundle_member_removed (the loose copy survives, dropped next run)", async () => {
    await writeFile(join(cwd, D1), ADR, "utf8");
    await writeFile(join(cwd, D2), ADR, "utf8");
    await writeDecisionRecord(cwd, D1, { now: new Date("2026-01-01T00:00:00.000Z") });
    await writeDecisionRecord(cwd, D2, { now: new Date("2026-02-01T00:00:00.000Z") });
    const stem1 = decisionRecordStem(D1);
    const bytes1 = await readFile(decisionRecordPath(cwd, D1), "utf8");
    await writeArchiveBundle(cwd, "decision_record", [{ id: stem1, bytes: bytes1 }]); // D1 now `both` (loose + bundle)
    await setRoadmap(["LP"]);

    const run1 = await applyArchiveRetention(cwd, { keepLatest: 1 });
    const decision1 = run1.find((o) => o.kind === "decision_record")!;
    expect(decision1.bundle_member_removed).toContain(stem1); // bundle member removed, loose survives
    expect(decision1.deleted).not.toContain(stem1);
    expect(await exists(decisionRecordPath(cwd, D1))).toBe(true);

    const run2 = await applyArchiveRetention(cwd, { keepLatest: 1 });
    expect(run2.find((o) => o.kind === "decision_record")!.deleted).toContain(stem1); // loose layer finishes it
    expect(await exists(decisionRecordPath(cwd, D1))).toBe(false);
  });
});

describe("applyArchiveRetention — independent bundle removal accounting when the kind is fail-closed", () => {
  const D1 = "design/decisions/keepme-rfc.md";
  const D2 = "design/decisions/newer-rfc.md";
  const ADR = `# RFC\n\n**Status:** accepted (P9, 2026-06)\n\n## Summary\n\nSettled.\n`;

  /** Write a Tier-1-valid bundle directly (bypassing the writer's per-member authority foldability),
   *  so a test can plant a MISFILED member that makes the whole kind fail-closed. */
  async function rawBundle(kind: string, members: { id: string; bytes: string }[]): Promise<void> {
    const recs = members.map((m) => ({ id: m.id, sha256: sha256Hex(m.bytes), bytes: m.bytes })).sort((a, b) => (a.id < b.id ? -1 : 1));
    const idsHash = computeMemberIdsSha256(recs.map((r) => r.id));
    await mkdir(archiveBundlesDir(cwd), { recursive: true });
    await writeFile(join(archiveBundlesDir(cwd), `${kind}-${idsHash.slice(0, 16)}.json`), JSON.stringify({ schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION, kind, member_ids_sha256: idsHash, members: recs }, null, 2) + "\n", "utf8");
  }

  it("a would_drop independent DECISION + an UNRELATED authority-invalid member → the requested id is skipped, never lost", async () => {
    await writeFile(join(cwd, D1), ADR, "utf8");
    await writeFile(join(cwd, D2), ADR, "utf8");
    await writeDecisionRecord(cwd, D1, { now: new Date("2026-01-01T00:00:00.000Z") });
    await writeDecisionRecord(cwd, D2, { now: new Date("2026-02-01T00:00:00.000Z") });
    const stem1 = decisionRecordStem(D1);
    const bytes1 = await readFile(decisionRecordPath(cwd, D1), "utf8");
    const bytes2 = await readFile(decisionRecordPath(cwd, D2), "utf8");
    // Bundle D1 (valid, the OLDER one → would_drop) ALONGSIDE a MISFILED member (a valid decision's bytes
    // under a bogus id) → the decision kind is fail-closed. D2 stays LOOSE (the keep), so D1 is would_drop.
    await rawBundle("decision_record", [{ id: stem1, bytes: bytes1 }, { id: "bogus-decoy-0000000000000000", bytes: bytes2 }]);
    await rm(decisionRecordPath(cwd, D1)); // D1 now bundle-only
    await setRoadmap(["LP"]);

    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    const decision = out.find((o) => o.kind === "decision_record")!;
    // D1 was would_drop and is bundle-backed but the kind is fail-closed → reported skipped, NOT silently dropped.
    expect(decision.deleted).not.toContain(stem1);
    expect(decision.bundle_member_removed).not.toContain(stem1);
    expect(decision.skipped.find((s) => s.id === stem1)?.reason).toBe("needs_bundle_member_removal");
    // Exactly one terminal bucket for the requested id.
    const buckets = [decision.deleted, decision.bundle_member_removed, decision.vanished, decision.skipped.map((s) => s.id), decision.recovered.map((r) => r.id)];
    expect(buckets.filter((b) => b.includes(stem1)).length).toBe(1);
    expect(loadArchiveBundles(cwd).index.get("decision_record")?.has(stem1) ?? false).toBe(true); // D1 still resolves (not removed)
  });

  it("a would_drop independent pack-less PHASE + an UNRELATED authority-invalid member → the requested id is skipped, never lost", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const looseP1 = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    const looseP2 = await readFile(phaseSnapshotPath(cwd, "P2"), "utf8");
    // P1 valid bundle (would_drop, no pack) ALONGSIDE a MISFILED member (P2's bytes under id "PX") → kind fail-closed.
    await rawBundle("phase_snapshot", [{ id: "P1", bytes: looseP1 }, { id: "PX", bytes: looseP2 }]);
    await rm(phaseSnapshotPath(cwd, "P1"));
    await setRoadmap([]);

    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    expect(phase.deleted).not.toContain("P1");
    expect(phase.bundle_member_removed).not.toContain("P1");
    expect(phase.skipped.find((s) => s.id === "P1")?.reason).toBe("needs_bundle_member_removal");
    const buckets = [phase.deleted, phase.bundle_member_removed, phase.vanished, phase.skipped.map((s) => s.id), phase.recovered.map((r) => r.id)];
    expect(buckets.filter((b) => b.includes("P1")).length).toBe(1); // exactly one bucket
    expect(loadArchiveBundles(cwd).index.get("phase_snapshot")?.has("P1") ?? false).toBe(true); // still resolves
  });
});
