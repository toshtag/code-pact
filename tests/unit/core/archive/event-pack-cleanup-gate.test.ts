import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import {
  evaluateDeleteGate,
  planLooseCleanup,
  prepareLooseCleanup,
  looseEventRelPath,
  type DeleteGateContext,
} from "../../../../src/core/archive/event-pack-cleanup-gate.ts";
import { eventFileName } from "../../../../src/core/progress/event-id.ts";
import { eventsDir, parseEventFileName } from "../../../../src/core/progress/events-io.ts";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";
import { buildValidEventPack, writeEventPackFile } from "../../../helpers/event-pack-fixture.ts";

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

/** A LIVE phase with a DIFFERENT id (P99) that re-uses task id P1-T1. */
const P99_REUSES_P1T1 = `id: P99
name: Re-user
weight: 1
confidence: high
risk: low
status: in_progress
objective: re-use a task id
definition_of_done:
  - it works
verification:
  commands:
    - pnpm test
tasks:
  - id: P1-T1
    type: feature
${TASK_FIELDS}
    status: planned
`;

const STARTED_DONE = `events:
  - task_id: P1-T1
    status: started
    at: 2026-06-01T00:00:00.000Z
    actor: agent
  - task_id: P1-T1
    status: done
    at: 2026-06-01T01:00:00.000Z
    actor: agent
`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-cleanup-gate-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** Archive P1 (snapshot written, loose present, phase YAML deleted). */
async function scaffoldArchivedP1(): Promise<ProgressEvent[]> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await seedDurableEvents(cwd, STARTED_DONE);
  expect((await writePhaseSnapshot(cwd, "P1", { now: NOW })).kind).toBe("written");
  await rm(join(cwd, "design", "phases", "P1-x.yaml"));
  await writeFile(join(cwd, "design", "roadmap.yaml"), "phases: []\n", "utf8");
  const { ProgressLog } = await import("../../../../src/core/schemas/progress-event.ts");
  const { parse } = await import("yaml");
  return ProgressLog.parse(parse(STARTED_DONE)).events;
}

/** Archive P1 AND write a full valid pack; return events + a gate ctx bound to it. */
async function archivedWithPack(): Promise<{ events: ProgressEvent[]; ctx: DeleteGateContext }> {
  const events = await scaffoldArchivedP1();
  const pack = await buildValidEventPack(cwd, "P1", events);
  await writeEventPackFile(cwd, "P1", pack);
  const ctx: DeleteGateContext = {
    snapshotTaskIds: new Set(["P1-T1"]),
    packIds: new Set(pack.events.map((e) => e.id)),
    packSnapshotSha256: pack.snapshot_sha256,
    cwd,
    phaseId: "P1",
  };
  return { events, ctx };
}

const looseFileOf = (events: ProgressEvent[], status: string): string =>
  eventFileName(events.find((e) => e.status === status)!);

describe("evaluateDeleteGate — per-file dispositions (NO unlink)", () => {
  it("all gates pass → unlink", async () => {
    const { events, ctx } = await archivedWithPack();
    const v = await evaluateDeleteGate(cwd, looseFileOf(events, "done"), ctx);
    expect(v.disposition).toBe("unlink");
  });

  it("G2: a non-event-file name → skip(not_event_file)", async () => {
    const { ctx } = await archivedWithPack();
    const v = await evaluateDeleteGate(cwd, "README.txt", ctx);
    expect(v).toEqual({ disposition: "skip", reason: "not_event_file" });
  });

  it("G1: a basename that escapes the events dir (path traversal) → skip(path_escape)", async () => {
    const { ctx } = await archivedWithPack();
    // Resolves to outside the project — G1 (resolveWithinProject) must refuse it
    // BEFORE the file is ever opened. (A real readdir yields plain basenames; this is
    // an exported-function hardening pin.)
    const v = await evaluateDeleteGate(cwd, "../../../../../../../../etc/passwd", ctx);
    expect(v).toEqual({ disposition: "skip", reason: "path_escape" });
  });

  it("G3a: a well-formed event name that is absent → vanished", async () => {
    const { ctx } = await archivedWithPack();
    const absentName = `20260601T000000000Z-${"a".repeat(64)}.yaml`;
    const v = await evaluateDeleteGate(cwd, absentName, ctx);
    expect(v.disposition).toBe("vanished");
  });

  it("G1/G3b: a directory at the event path (not a regular file) → skip(not_regular_file)", async () => {
    const { ctx } = await archivedWithPack();
    const dirName = `20260601T000000000Z-${"b".repeat(64)}.yaml`;
    await mkdir(join(eventsDir(cwd), dirName));
    const v = await evaluateDeleteGate(cwd, dirName, ctx);
    expect(v).toEqual({ disposition: "skip", reason: "not_regular_file" });
  });

  it("G1/G3b: a SYMLINK at the event path → skip(not_regular_file), target never followed", async () => {
    const { events, ctx } = await archivedWithPack();
    // A symlink whose name is a valid event filename, pointing at a real, valid
    // event file. Following it would read a body that passes G4 — so the gate must
    // refuse to follow (O_NOFOLLOW) and skip it as not_regular_file.
    const linkName = `20260601T000000000Z-${"d".repeat(64)}.yaml`;
    await symlink(join(eventsDir(cwd), looseFileOf(events, "done")), join(eventsDir(cwd), linkName));
    const v = await evaluateDeleteGate(cwd, linkName, ctx);
    expect(v).toEqual({ disposition: "skip", reason: "not_regular_file" });
  });

  it("G4: an unparseable body under a valid event name → skip(parse_failed)", async () => {
    const { ctx } = await archivedWithPack();
    const name = `20260601T000000000Z-${"c".repeat(64)}.yaml`;
    await writeFile(join(eventsDir(cwd), name), "{ not: valid yaml :::", "utf8");
    const v = await evaluateDeleteGate(cwd, name, ctx);
    expect(v).toEqual({ disposition: "skip", reason: "parse_failed" });
  });

  it("G4: a valid event body under a filename with the WRONG id → skip(id_mismatch)", async () => {
    const { events, ctx } = await archivedWithPack();
    const realName = looseFileOf(events, "done");
    const parsed = parseEventFileName(realName)!;
    // Flip one hex char of the id so the filename id ≠ the content id.
    const flipped = (parsed.id[0] === "a" ? "b" : "a") + parsed.id.slice(1);
    const mismatchName = `${parsed.atCompact}-${flipped}.yaml`;
    const body = await readFile(join(eventsDir(cwd), realName), "utf8");
    await writeFile(join(eventsDir(cwd), mismatchName), body, "utf8");
    const v = await evaluateDeleteGate(cwd, mismatchName, ctx);
    expect(v).toEqual({ disposition: "skip", reason: "id_mismatch" });
  });

  it("G5: the event's task_id is not in the snapshot → skip(task_not_in_snapshot)", async () => {
    const { events } = await archivedWithPack();
    // A ctx whose snapshot does NOT contain P1-T1.
    const foreignCtx: DeleteGateContext = {
      snapshotTaskIds: new Set(["P9-T9"]),
      packIds: new Set(),
      packSnapshotSha256: "0".repeat(64),
      cwd,
    phaseId: "P1",
    };
    const v = await evaluateDeleteGate(cwd, looseFileOf(events, "done"), foreignCtx);
    expect(v).toEqual({ disposition: "skip", reason: "task_not_in_snapshot" });
  });

  it("G6: a LIVE phase (different id) owns the task_id → abort(live_task_owner)", async () => {
    const { events, ctx } = await archivedWithPack();
    // P99 is live and re-uses P1-T1 — phase-id discovery for P1 misses it, but the
    // loose P1-T1 event is still live under P99, so deleting it must abort.
    await writeFile(join(cwd, "design", "phases", "P99-reuser.yaml"), P99_REUSES_P1T1, "utf8");
    const v = await evaluateDeleteGate(cwd, looseFileOf(events, "done"), ctx);
    expect(v.disposition).toBe("abort");
    if (v.disposition !== "abort") return;
    expect(v.reason).toBe("live_task_owner");
  });

  it("G6: an unparseable live phase YAML → abort(live_owner_discovery_incomplete), fail closed", async () => {
    const { events, ctx } = await archivedWithPack();
    await writeFile(join(cwd, "design", "phases", "P2-broken.yaml"), "{ not a phase", "utf8");
    const v = await evaluateDeleteGate(cwd, looseFileOf(events, "done"), ctx);
    expect(v.disposition).toBe("abort");
    if (v.disposition !== "abort") return;
    expect(v.reason).toBe("live_owner_discovery_incomplete");
  });

  it("G7: the verified pack does NOT cover the present loose id → abort(pack_missing_event)", async () => {
    const { events, ctx } = await archivedWithPack();
    // ctx with an empty pack id-set: the loose file is present but not covered.
    const emptyPackCtx: DeleteGateContext = { ...ctx, packIds: new Set() };
    const v = await evaluateDeleteGate(cwd, looseFileOf(events, "done"), emptyPackCtx);
    expect(v.disposition).toBe("abort");
    if (v.disposition !== "abort") return;
    expect(v.reason).toBe("pack_missing_event");
  });

  it("G8: pack snapshot_sha256 ≠ the current snapshot bytes → abort(snapshot_diverged)", async () => {
    const { events, ctx } = await archivedWithPack();
    const divergedCtx: DeleteGateContext = { ...ctx, packSnapshotSha256: "0".repeat(64) };
    const v = await evaluateDeleteGate(cwd, looseFileOf(events, "done"), divergedCtx);
    expect(v.disposition).toBe("abort");
    if (v.disposition !== "abort") return;
    expect(v.reason).toBe("snapshot_diverged");
  });

  it("ordering: a global gate (G6 owner) wins over a per-file concern", async () => {
    // The file is a clean unlink candidate EXCEPT a live phase owns its task — the
    // abort must win, never a skip/unlink.
    const { events, ctx } = await archivedWithPack();
    await writeFile(join(cwd, "design", "phases", "P99-reuser.yaml"), P99_REUSES_P1T1, "utf8");
    const v = await evaluateDeleteGate(cwd, looseFileOf(events, "started"), ctx);
    expect(v.disposition).toBe("abort");
  });
});

describe("planLooseCleanup — dry-run over the loose target set (NO unlink)", () => {
  const eventExists = async (file: string): Promise<boolean> => {
    try {
      await readFile(join(eventsDir(cwd), file), "utf8");
      return true;
    } catch {
      return false;
    }
  };

  it("cell 12 (equal): pack covers all loose → every loose file is unlinkable, nothing removed", async () => {
    const { events } = await archivedWithPack();
    const r = await planLooseCleanup(cwd, "P1");
    expect(r.kind).toBe("ready");
    if (r.kind !== "ready") return;
    expect(r.relationship).toBe("equal");
    expect(r.unlinkable.sort()).toEqual(
      [looseFileOf(events, "started"), looseFileOf(events, "done")].sort(),
    );
    expect(r.skipped).toEqual([]);
    expect(r.vanished).toEqual([]);
    expect(r.aborts).toEqual([]);
    // Dry-run removed NOTHING.
    for (const e of events) expect(await eventExists(eventFileName(e))).toBe(true);
  });

  it("cell 14 (strict_subset): a partial cleanup already removed one loose → the remnant is unlinkable", async () => {
    const { events } = await archivedWithPack();
    await rm(join(eventsDir(cwd), looseFileOf(events, "started"))); // partial cleanup
    const r = await planLooseCleanup(cwd, "P1");
    expect(r.kind).toBe("ready");
    if (r.kind !== "ready") return;
    expect(r.relationship).toBe("strict_subset");
    expect(r.unlinkable).toEqual([looseFileOf(events, "done")]);
    expect(r.skipped).toEqual([]);
    expect(r.aborts).toEqual([]);
  });

  it("cell 11 (already clean): a pack covers the phase and no loose remains → already_clean", async () => {
    const { events } = await archivedWithPack();
    for (const e of events) await rm(join(eventsDir(cwd), eventFileName(e)));
    const r = await planLooseCleanup(cwd, "P1");
    expect(r.kind).toBe("already_clean");
  });

  it("cell 10 (no pack yet): loose present, no pack → needs_pack_write (cleanup not yet applicable)", async () => {
    await scaffoldArchivedP1(); // loose present, NO pack written
    const r = await planLooseCleanup(cwd, "P1");
    expect(r.kind).toBe("needs_pack_write");
  });

  it("cell 9 (no events): an attested archived phase with no events → noop_no_events", async () => {
    await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
    await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
    const w = await writePhaseSnapshot(cwd, "P1", {
      now: NOW,
      attestations: { "P1-T1": { reason: "verified out of band" } },
    });
    expect(w.kind).toBe("written");
    await rm(join(cwd, "design", "phases", "P1-x.yaml"));
    await writeFile(join(cwd, "design", "roadmap.yaml"), "phases: []\n", "utf8");
    const r = await planLooseCleanup(cwd, "P1");
    expect(r.kind).toBe("noop_no_events");
  });

  it("ineligible: a live phase YAML still present → ineligible(phase_file_still_present)", async () => {
    await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
    await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
    await seedDurableEvents(cwd, STARTED_DONE);
    expect((await writePhaseSnapshot(cwd, "P1", { now: NOW })).kind).toBe("written");
    const r = await planLooseCleanup(cwd, "P1");
    expect(r.kind).toBe("ineligible");
    if (r.kind !== "ineligible") return;
    expect(r.block.kind).toBe("phase_file_still_present");
  });

  it("G6 reachable in the dry-run: a live phase re-uses the task id → the loose file is reported under aborts (and nothing is removed)", async () => {
    const { events } = await archivedWithPack();
    // A live P99 owns P1-T1. phase-id discovery for P1 still passes (P99 ≠ P1), so
    // the plan is ready, but the per-file gate aborts on the live owner.
    await writeFile(join(cwd, "design", "phases", "P99-reuser.yaml"), P99_REUSES_P1T1, "utf8");
    const r = await planLooseCleanup(cwd, "P1");
    expect(r.kind).toBe("ready");
    if (r.kind !== "ready") return;
    expect(r.unlinkable).toEqual([]);
    expect(r.aborts.length).toBeGreaterThan(0);
    expect(r.aborts.every((a) => a.reason === "live_task_owner")).toBe(true);
    expect(r.aborts.map((a) => a.path)).toContain(looseEventRelPath(looseFileOf(events, "done")));
  });

  it("self-consistent: G0 sees `equal` but one loose file vanishes before the re-read → result is strict_subset (re-read state wins, not G0)", async () => {
    const { events } = await archivedWithPack();
    // afterPlan fires AFTER G0 (which sees equal) and BEFORE the re-read; delete one
    // loose file in between, so the re-read enumerates a strict subset. The returned
    // relationship must reflect the re-read, not G0's stale `equal`.
    const r = await planLooseCleanup(cwd, "P1", {
      afterPlan: async () => {
        await rm(join(eventsDir(cwd), looseFileOf(events, "started")));
      },
    });
    expect(r.kind).toBe("ready");
    if (r.kind !== "ready") return;
    expect(r.relationship).toBe("strict_subset");
    expect(r.unlinkable).toEqual([looseFileOf(events, "done")]);
  });

  it("self-consistent: G0 sees `equal` but ALL loose vanish before the re-read → already_clean (NOT ready/equal/unlinkable:[])", async () => {
    const { events } = await archivedWithPack();
    const r = await planLooseCleanup(cwd, "P1", {
      afterPlan: async () => {
        for (const e of events) await rm(join(eventsDir(cwd), eventFileName(e)));
      },
    });
    expect(r.kind).toBe("already_clean");
  });
});

describe("prepareLooseCleanup — shared cleanup-ready builder (NO unlink)", () => {
  it("ready: a covering pack + full loose → ctx (pack/snapshot) + target basenames + relationship equal", async () => {
    const { events } = await archivedWithPack();
    const r = await prepareLooseCleanup(cwd, "P1");
    expect(r.kind).toBe("ready");
    if (r.kind !== "ready") return;
    expect(r.relationship).toBe("equal");
    expect(r.target.sort()).toEqual(
      [looseFileOf(events, "started"), looseFileOf(events, "done")].sort(),
    );
    expect(r.ctx.snapshotTaskIds.has("P1-T1")).toBe(true);
    // The gate ctx's pack id-set covers both events (the pack the target is bound to).
    expect(r.ctx.packIds.size).toBe(2);
  });

  it("ready: a strict subset (a loose file removed) → relationship strict_subset, target is the remnant", async () => {
    const { events } = await archivedWithPack();
    await rm(join(eventsDir(cwd), looseFileOf(events, "started")));
    const r = await prepareLooseCleanup(cwd, "P1");
    expect(r.kind).toBe("ready");
    if (r.kind !== "ready") return;
    expect(r.relationship).toBe("strict_subset");
    expect(r.target).toEqual([looseFileOf(events, "done")]);
  });

  it("already_clean: a covering pack + no loose → already_clean", async () => {
    const { events } = await archivedWithPack();
    for (const e of events) await rm(join(eventsDir(cwd), eventFileName(e)));
    expect((await prepareLooseCleanup(cwd, "P1")).kind).toBe("already_clean");
  });

  it("needs_pack_write: loose present, no pack → needs_pack_write", async () => {
    await scaffoldArchivedP1();
    expect((await prepareLooseCleanup(cwd, "P1")).kind).toBe("needs_pack_write");
  });
});
