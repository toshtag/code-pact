import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import {
  readEventPackFiles,
  validateEventPackTier1,
  computeEventIdsSha256,
} from "../../../../src/core/archive/event-pack-reader.ts";
import {
  validateEventPackBinding,
  bindPackToSnapshot,
  newSnapshotRawCache,
} from "../../../../src/core/archive/event-pack-binding.ts";
import { loadPhaseSnapshot } from "../../../../src/core/archive/load-phase-snapshot.ts";
import { phaseSnapshotPath } from "../../../../src/core/archive/paths.ts";
import { readFile } from "node:fs/promises";
import { readAllProgressEventSources } from "../../../../src/core/progress/all-sources.ts";
import { computeEventId, eventFileName } from "../../../../src/core/progress/event-id.ts";
import type { LoadedEventFile } from "../../../../src/core/progress/events-io.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";
import {
  buildValidEventPack,
  writeEventPackFile,
} from "../../../helpers/event-pack-fixture.ts";

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

const DONE_EVENT_P1T1 = `events:
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
  cwd = await mkdtemp(join(tmpdir(), "code-pact-eventpack-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/**
 * Scaffold a project with P1 done, its loose events, and a P1 phase snapshot.
 * Returns the P1-T1 events so a test can pack them.
 */
async function scaffoldArchivedP1(): Promise<ProgressEvent[]> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await seedDurableEvents(cwd, DONE_EVENT_P1T1);
  const written = await writePhaseSnapshot(cwd, "P1", { now: NOW });
  expect(written.kind).toBe("written");
  // Return the events (parsed from the seed) for packing.
  const { ProgressLog } = await import("../../../../src/core/schemas/progress-event.ts");
  const { parse } = await import("yaml");
  return ProgressLog.parse(parse(DONE_EVENT_P1T1)).events;
}

describe("event pack — Tier 1 (schema / per-entry / order / checksum)", () => {
  it("a valid pack round-trips through readEventPackFiles", async () => {
    const events = await scaffoldArchivedP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    await writeEventPackFile(cwd, "P1", pack);
    const loaded = await readEventPackFiles(cwd);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.phaseId).toBe("P1");
    expect(loaded[0]!.entries.map((e) => e.event.status)).toEqual(["started", "done"]);
  });

  it("wrong filename phase-id (stem != body phase_id) → EVENT_PACK_INVALID", async () => {
    const events = await scaffoldArchivedP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    expect(() => validateEventPackTier1("P2", JSON.stringify(pack), "P2.json")).toThrow(
      /EVENT_PACK_INVALID|phase_id/,
    );
  });

  it("duplicate event id within a pack → EVENT_PACK_INVALID", async () => {
    const events = await scaffoldArchivedP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    // Duplicate the first entry.
    const tampered = { ...pack, events: [pack.events[0]!, pack.events[0]!, ...pack.events.slice(1)] };
    expect(() => validateEventPackTier1("P1", JSON.stringify(tampered), "P1.json")).toThrow(
      /duplicate event id|EVENT_PACK_INVALID/,
    );
  });

  it("event_ids_sha256 mismatch (stored != recomputed) → EVENT_PACK_INVALID", async () => {
    const events = await scaffoldArchivedP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    const tampered = { ...pack, event_ids_sha256: "0".repeat(64) };
    expect(() => validateEventPackTier1("P1", JSON.stringify(tampered), "P1.json")).toThrow(
      /event_ids_sha256 mismatch|EVENT_PACK_INVALID/,
    );
  });

  it("out-of-order events → EVENT_PACK_INVALID", async () => {
    const events = await scaffoldArchivedP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    // Reverse the (correctly sorted) events. event_ids_sha256 is order-independent
    // (it sorts), so the order check fires before the checksum passes.
    const reversed = { ...pack, events: [...pack.events].reverse() };
    expect(() => validateEventPackTier1("P1", JSON.stringify(reversed), "P1.json")).toThrow(
      /not in deterministic|EVENT_PACK_INVALID/,
    );
  });
});

describe("event pack — Tier 2 binding (snapshot identity)", () => {
  const looseByIdOf = (entries: LoadedEventFile[]) => {
    const m = new Map<string, LoadedEventFile>();
    for (const e of entries) m.set(e.id, e);
    return m;
  };

  it("a valid pack binds with no issues", async () => {
    const events = await scaffoldArchivedP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    await writeEventPackFile(cwd, "P1", pack);
    const loaded = (await readEventPackFiles(cwd))[0]!;
    const issues = await validateEventPackBinding(cwd, loaded, looseByIdOf([]), newSnapshotRawCache());
    expect(issues).toEqual([]);
  });

  it("snapshot_sha256 mismatch → binding fails (snapshot_sha256_mismatch)", async () => {
    const events = await scaffoldArchivedP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    const tampered = { ...pack, snapshot_sha256: "0".repeat(64) };
    await writeEventPackFile(cwd, "P1", tampered);
    const loaded = (await readEventPackFiles(cwd))[0]!;
    const issues = await validateEventPackBinding(cwd, loaded, looseByIdOf([]), newSnapshotRawCache());
    expect(issues.some((i) => i.kind === "snapshot_sha256_mismatch")).toBe(true);
  });

  it("a packed event for a task_id NOT in the snapshot → binding fails (task_id_not_in_snapshot)", async () => {
    const events = await scaffoldArchivedP1();
    // Add a foreign-task event whose filename/id are self-consistent.
    const foreign: ProgressEvent = {
      task_id: "P9-T9",
      status: "done",
      at: "2026-06-01T02:00:00.000Z",
      actor: "agent",
    };
    const pack = await buildValidEventPack(cwd, "P1", [...events, foreign]);
    await writeEventPackFile(cwd, "P1", pack);
    const loaded = (await readEventPackFiles(cwd))[0]!;
    const issues = await validateEventPackBinding(cwd, loaded, looseByIdOf([]), newSnapshotRawCache());
    expect(issues.some((i) => i.kind === "task_id_not_in_snapshot")).toBe(true);
  });
});

describe("event pack — completeness (pack must capture ALL phase events)", () => {
  it("loose has started+done but pack has done-only → binding fails (pack_missing_phase_event)", async () => {
    // The pack dropped the non-terminal `started` event. Replay over loose∪pack
    // would still derive done (loose fills the gap), but the pack is incomplete:
    // Layer-2 readback deletes the loose files, so the started event would be lost.
    const events = await scaffoldArchivedP1(); // started + done in loose
    const doneOnly = events.filter((e) => e.status === "done");
    const pack = await buildValidEventPack(cwd, "P1", doneOnly);
    await writeEventPackFile(cwd, "P1", pack);
    const loaded = (await readEventPackFiles(cwd))[0]!;
    // looseEventsById carries the FULL loose set (started + done).
    const looseBy = new Map<string, LoadedEventFile>();
    const sources = await readAllProgressEventSources(cwd, { mode: "lenient" });
    for (const f of sources.looseFiles) looseBy.set(f.id, f);
    const issues = await validateEventPackBinding(cwd, loaded, looseBy, newSnapshotRawCache());
    expect(issues.some((i) => i.kind === "pack_missing_phase_event")).toBe(true);
  });

  it("a complete pack (all loose events for the phase) binds clean", async () => {
    const events = await scaffoldArchivedP1();
    const pack = await buildValidEventPack(cwd, "P1", events); // started + done
    await writeEventPackFile(cwd, "P1", pack);
    const loaded = (await readEventPackFiles(cwd))[0]!;
    const looseBy = new Map<string, LoadedEventFile>();
    const sources = await readAllProgressEventSources(cwd, { mode: "lenient" });
    for (const f of sources.looseFiles) looseBy.set(f.id, f);
    expect(await validateEventPackBinding(cwd, loaded, looseBy, newSnapshotRawCache())).toEqual([]);
  });
});

describe("event pack — B2 same-task injection (semantic replay)", () => {
  it("a later `failed` after the winning `done` → binding fails (semantic_replay_conflict)", async () => {
    const events = await scaffoldArchivedP1();
    const laterFailed: ProgressEvent = {
      task_id: "P1-T1",
      status: "failed",
      at: "2026-06-02T00:00:00.000Z",
      actor: "agent",
    };
    const pack = await buildValidEventPack(cwd, "P1", [...events, laterFailed]);
    await writeEventPackFile(cwd, "P1", pack);
    const loaded = (await readEventPackFiles(cwd))[0]!;
    const looseBy = new Map<string, LoadedEventFile>();
    const issues = await validateEventPackBinding(cwd, loaded, looseBy, newSnapshotRawCache());
    expect(issues.some((i) => i.kind === "semantic_replay_conflict")).toBe(true);
  });

  it("a LATER forged `done` (not in snapshot evidence ids) becomes the winning event → binding fails (Finding A)", async () => {
    // The snapshot records the REAL done event_id as evidence. A pack that adds a
    // later forged `done` makes the forged event the winning terminal one. Even
    // though the derived state is still `done` and the forged event is itself a
    // `done`, its id is NOT in the snapshot's evidence ids → must be rejected.
    const events = await scaffoldArchivedP1();
    const laterDone: ProgressEvent = {
      task_id: "P1-T1",
      status: "done",
      at: "2026-06-05T00:00:00.000Z", // later than the real done
      actor: "agent",
    };
    const pack = await buildValidEventPack(cwd, "P1", [...events, laterDone]);
    await writeEventPackFile(cwd, "P1", pack);
    const loaded = (await readEventPackFiles(cwd))[0]!;
    const issues = await validateEventPackBinding(cwd, loaded, new Map(), newSnapshotRawCache());
    expect(issues.some((i) => i.kind === "semantic_replay_conflict")).toBe(true);
    expect(issues.some((i) => i.message.includes("winning terminal event"))).toBe(true);
  });
});

describe("event pack — B1 no cross-pack mutual support", () => {
  it("a forged pack holding ANOTHER pack's evidence event does not make the first pack valid", async () => {
    // Setup: P1 archived; its done event id is evidence in the snapshot. Remove
    // the loose done event so it lives ONLY in a forged second pack. Pack A (P1)
    // must NOT resolve its evidence from Pack B's events.
    const events = await scaffoldArchivedP1();
    const doneEvent = events.find((e) => e.status === "done")!;
    const doneId = computeEventId(doneEvent);

    // Pack A for P1 WITHOUT the done event (only the started event).
    const startedOnly = events.filter((e) => e.status === "started");
    const packA = await buildValidEventPack(cwd, "P1", startedOnly);

    // Delete the loose done event file so the done id is not in the loose set.
    await rm(join(cwd, ".code-pact", "state", "events", eventFileName(doneEvent)), { force: true });

    await writeEventPackFile(cwd, "P1", packA);
    const loaded = (await readEventPackFiles(cwd))[0]!;
    // Pack A's binding resolves evidence from loose ∪ ownPack(A) only. ownPack(A)
    // has NO done event, loose has none either → the snapshot's done event_id is
    // unresolved. Even if another pack held it, it would not help.
    const issues = await validateEventPackBinding(cwd, loaded, new Map(), newSnapshotRawCache());
    expect(issues.some((i) => i.kind === "evidence_unresolved")).toBe(true);
    expect(issues.some((i) => i.message.includes(doneId))).toBe(true);
  });
});

describe("readAllProgressEventSources — strict drops/throws unbound packs", () => {
  it("an unbound pack (snapshot_sha256 tampered) throws in strict mode", async () => {
    const events = await scaffoldArchivedP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    await writeEventPackFile(cwd, "P1", { ...pack, snapshot_sha256: "0".repeat(64) });
    await expect(readAllProgressEventSources(cwd, { mode: "strict" })).rejects.toThrow(
      /EVENT_PACK_INVALID|snapshot binding/,
    );
  });

  it("an unbound pack is collected (not thrown) and dropped in lenient mode", async () => {
    const events = await scaffoldArchivedP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    await writeEventPackFile(cwd, "P1", { ...pack, snapshot_sha256: "0".repeat(64) });
    const sources = await readAllProgressEventSources(cwd, { mode: "lenient" });
    expect(sources.issues.some((i) => i.code === "EVENT_PACK_INVALID")).toBe(true);
    expect(sources.validatedPackFiles).toHaveLength(0); // unbound pack dropped
  });

  it("a valid pack's events flow into validatedPackFiles in strict mode", async () => {
    const events = await scaffoldArchivedP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    await writeEventPackFile(cwd, "P1", pack);
    const sources = await readAllProgressEventSources(cwd, { mode: "strict" });
    expect(sources.validatedPackFiles.map((e) => e.event.status).sort()).toEqual(["done", "started"]);
  });
});

describe("bindPackToSnapshot — the pure core the rev reader shares (Finding C)", () => {
  it("applies full semantic replay (a later forged done is rejected by the pure core too)", async () => {
    // The rev reader (readEventPacksAtRev) calls bindPackToSnapshot, so the same
    // forged-later-done that the workspace binding rejects must be rejected here.
    const events = await scaffoldArchivedP1();
    const laterDone: ProgressEvent = {
      task_id: "P1-T1",
      status: "done",
      at: "2026-06-05T00:00:00.000Z",
      actor: "agent",
    };
    const pack = await buildValidEventPack(cwd, "P1", [...events, laterDone]);
    await writeEventPackFile(cwd, "P1", pack);
    const loaded = (await readEventPackFiles(cwd))[0]!;
    const res = await loadPhaseSnapshot(cwd, "P1");
    expect(res.kind).toBe("valid");
    if (res.kind !== "valid") return;
    const raw = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    const issues = bindPackToSnapshot(loaded, res.snapshot, raw, new Map());
    expect(issues.some((i) => i.kind === "semantic_replay_conflict")).toBe(true);
  });

  it("a snapshot_sha256 that doesn't match the given raw bytes → mismatch (pure core)", async () => {
    const events = await scaffoldArchivedP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    await writeEventPackFile(cwd, "P1", pack);
    const loaded = (await readEventPackFiles(cwd))[0]!;
    const res = await loadPhaseSnapshot(cwd, "P1");
    if (res.kind !== "valid") throw new Error("snapshot not valid");
    // Pass DIFFERENT raw bytes than the pack's snapshot_sha256 was computed over.
    const issues = bindPackToSnapshot(loaded, res.snapshot, "different bytes", new Map());
    expect(issues.some((i) => i.kind === "snapshot_sha256_mismatch")).toBe(true);
  });
});

describe("computeEventIdsSha256 — deterministic, order-independent", () => {
  it("same id set in any input order hashes identically", () => {
    const a: LoadedEventFile = {
      id: "a".repeat(64),
      file: "20260601T000000000Z-" + "a".repeat(64) + ".yaml",
      event: { task_id: "T1", status: "started", at: "2026-06-01T00:00:00.000Z", actor: "agent" },
    };
    const b: LoadedEventFile = {
      id: "b".repeat(64),
      file: "20260601T010000000Z-" + "b".repeat(64) + ".yaml",
      event: { task_id: "T1", status: "done", at: "2026-06-01T01:00:00.000Z", actor: "agent" },
    };
    expect(computeEventIdsSha256([a, b])).toBe(computeEventIdsSha256([b, a]));
  });
});
