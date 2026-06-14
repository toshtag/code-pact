import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reconcileSurvivors } from "../../../../src/core/archive/event-pack-cleanup-reconcile.ts";
import { looseEventRelPath } from "../../../../src/core/archive/event-pack-cleanup-gate.ts";
import { writeEventFile, eventsDir } from "../../../../src/core/progress/events-io.ts";
import { eventFileName } from "../../../../src/core/progress/event-id.ts";
import { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-reconcile-"));
  await mkdir(eventsDir(cwd), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** Seed one loose event file; return its basename + content id. */
async function seed(taskId: string, at: string): Promise<{ file: string; id: string }> {
  const event = ProgressEvent.parse({ task_id: taskId, status: "done", at, actor: "agent" });
  const w = await writeEventFile(cwd, event);
  return { file: eventFileName(event), id: w.id };
}

const SNAP = new Set(["P1-T1"]);

describe("reconcileSurvivors — R0–R5 post-run classification (NO unlink)", () => {
  it("no present event files → terminal null, remaining 0, nothing skipped, no advisories", async () => {
    const r = await reconcileSurvivors(cwd, {
      target: [],
      packIds: new Set(),
      snapshotTaskIds: SNAP,
      loopSkipped: [],
    });
    expect(r.terminal).toBeNull();
    expect(r.cleanup_remaining_loose).toBe(0);
    expect(r.skipped).toEqual([]);
    expect(r.vanished_count).toBe(0);
    expect(r.advisories).toEqual([]);
  });

  it("R1.2: present in-scope survivor in the pack WITH a loop skip record → INCOMPLETE, keeps the reason", async () => {
    const { file, id } = await seed("P1-T1", "2026-06-01T00:00:00.000Z");
    const r = await reconcileSurvivors(cwd, {
      target: [file],
      packIds: new Set([id]),
      snapshotTaskIds: SNAP,
      loopSkipped: [{ path: looseEventRelPath(file), reason: "unreadable" }],
    });
    expect(r.terminal).toBe("STATE_COMPACT_CLEANUP_INCOMPLETE");
    expect(r.cleanup_remaining_loose).toBe(1);
    expect(r.skipped).toEqual([{ path: looseEventRelPath(file), reason: "unreadable" }]);
  });

  it("R1.1: present in-scope survivor NOT in the pack → CLEANUP_FAILED, pack_stale_after_cleanup", async () => {
    const { file } = await seed("P1-T1", "2026-06-01T00:00:00.000Z");
    const r = await reconcileSurvivors(cwd, {
      target: [file], // in-scope via the target even though its id is not in the pack
      packIds: new Set(),
      snapshotTaskIds: SNAP,
      loopSkipped: [],
    });
    expect(r.terminal).toBe("STATE_COMPACT_CLEANUP_FAILED");
    expect(r.block).toBe("pack_stale_after_cleanup");
    expect(r.cleanup_remaining_loose).toBe(1);
  });

  it("R1.3: present in-scope survivor in the pack with NO skip record → INCOMPLETE, appeared_during_cleanup", async () => {
    const { file, id } = await seed("P1-T1", "2026-06-01T00:00:00.000Z");
    const r = await reconcileSurvivors(cwd, {
      target: [], // not a target — it appeared mid-run; in-scope via the pack id
      packIds: new Set([id]),
      snapshotTaskIds: SNAP,
      loopSkipped: [],
    });
    expect(r.terminal).toBe("STATE_COMPACT_CLEANUP_INCOMPLETE");
    expect(r.skipped).toEqual([
      { path: looseEventRelPath(file), reason: "appeared_during_cleanup" },
    ]);
  });

  it("R1.0: an id-unknown survivor (broken body) scoped by its FILENAME id → INCOMPLETE, *_after_cleanup, counted", async () => {
    const name = `20260601T000000000Z-${"a".repeat(64)}.yaml`;
    await writeFile(join(eventsDir(cwd), name), "{ not: valid event :::", "utf8");
    const r = await reconcileSurvivors(cwd, {
      target: [],
      packIds: new Set([`${"a".repeat(64)}`]), // filename id in the pack → in-scope (R0 ii)
      snapshotTaskIds: SNAP,
      loopSkipped: [],
    });
    expect(r.terminal).toBe("STATE_COMPACT_CLEANUP_INCOMPLETE");
    expect(r.cleanup_remaining_loose).toBe(1);
    expect(r.skipped).toEqual([
      { path: looseEventRelPath(name), reason: "parse_failed_after_cleanup" },
    ]);
  });

  it("R5: an out-of-scope event file (foreign task, id not in pack, no skip) → advisory, NOT counted, terminal null", async () => {
    const { file } = await seed("P9-T9", "2026-06-02T00:00:00.000Z");
    const r = await reconcileSurvivors(cwd, {
      target: [],
      packIds: new Set(),
      snapshotTaskIds: SNAP, // P9-T9 ∉ snapshot
      loopSkipped: [],
    });
    expect(r.terminal).toBeNull();
    expect(r.cleanup_remaining_loose).toBe(0); // not this phase's survivor
    expect(r.skipped).toEqual([]);
    expect(r.advisories).toEqual([
      { code: "unclassified_loose_after_cleanup", path: looseEventRelPath(file) },
    ]);
  });

  it("R0 (i) is basename-matched: a target passed as a relative PATH still scopes the survivor (no undercount)", async () => {
    const { file } = await seed("P1-T1", "2026-06-01T00:00:00.000Z");
    const r = await reconcileSurvivors(cwd, {
      // Pass the full project-relative PATH, not the basename — and make (ii)/(iii)/
      // (iv) all miss (empty pack, empty snapshot, no skip) so ONLY (i) can scope it.
      target: [looseEventRelPath(file)],
      packIds: new Set(),
      snapshotTaskIds: new Set(),
      loopSkipped: [],
    });
    // Scoped via (i) despite the path form → classified (id known, not in pack → R1.1),
    // NOT dropped to an advisory/undercount.
    expect(r.terminal).toBe("STATE_COMPACT_CLEANUP_FAILED");
    expect(r.cleanup_remaining_loose).toBe(1);
    expect(r.advisories).toEqual([]);
  });

  it("vanished during reconciliation (deleted after readdir, before the content read) → counted in vanished_count, NOT a survivor", async () => {
    const { file, id } = await seed("P1-T1", "2026-06-01T00:00:00.000Z");
    const r = await reconcileSurvivors(
      cwd,
      { target: [file], packIds: new Set([id]), snapshotTaskIds: SNAP, loopSkipped: [] },
      { afterReaddir: async () => rm(join(eventsDir(cwd), file)) },
    );
    expect(r.terminal).toBeNull();
    expect(r.cleanup_remaining_loose).toBe(0); // not a present survivor
    expect(r.skipped).toEqual([]);
    expect(r.vanished_count).toBe(1); // but the vanish IS observed for the public count
  });

  it("R5: a broken (unparseable) event file with NO filename/pack/skip tie → advisory, not counted", async () => {
    const name = `20260601T000000000Z-${"e".repeat(64)}.yaml`;
    await writeFile(join(eventsDir(cwd), name), "{ not: valid :::", "utf8");
    const r = await reconcileSurvivors(cwd, {
      target: [],
      packIds: new Set(), // filename id not in the pack
      snapshotTaskIds: SNAP, // and its task can't be read anyway
      loopSkipped: [],
    });
    expect(r.terminal).toBeNull();
    expect(r.cleanup_remaining_loose).toBe(0); // another phase's / stray broken file
    expect(r.skipped).toEqual([]);
    expect(r.vanished_count).toBe(0);
    expect(r.advisories).toEqual([
      { code: "unclassified_loose_after_cleanup", path: looseEventRelPath(name) },
    ]);
  });

  it("R1.1 via the disk adapter: a swapped body (filename id in pack, CONTENT id not in pack) → FAILED, not R1.0", async () => {
    const filenameId = "f".repeat(64);
    const name = `20260601T000000000Z-${filenameId}.yaml`;
    // A PARSEABLE event whose content id ≠ the filename id (a swapped body). The
    // content id is computable, so this is R1.1 (known, not-in-pack), NOT R1.0.
    await writeFile(
      join(eventsDir(cwd), name),
      "task_id: P1-T1\nstatus: done\nat: 2026-06-01T00:00:00.000Z\nactor: agent\n",
      "utf8",
    );
    const r = await reconcileSurvivors(cwd, {
      target: [],
      packIds: new Set([filenameId]), // filename id ties it in (R0 ii); content id is NOT in the pack
      snapshotTaskIds: SNAP,
      loopSkipped: [],
    });
    expect(r.terminal).toBe("STATE_COMPACT_CLEANUP_FAILED");
    expect(r.block).toBe("pack_stale_after_cleanup");
    expect(r.cleanup_remaining_loose).toBe(1);
  });

  it("FAILED dominates: one not-in-pack survivor + one in-pack skip → terminal FAILED, both counted", async () => {
    const a = await seed("P1-T1", "2026-06-01T00:00:00.000Z");
    const b = await seed("P1-T1", "2026-06-01T01:00:00.000Z");
    const r = await reconcileSurvivors(cwd, {
      target: [a.file, b.file],
      packIds: new Set([b.id]), // a NOT in pack → FAILED; b in pack
      snapshotTaskIds: SNAP,
      loopSkipped: [{ path: looseEventRelPath(b.file), reason: "unreadable" }],
    });
    expect(r.terminal).toBe("STATE_COMPACT_CLEANUP_FAILED");
    expect(r.block).toBe("pack_stale_after_cleanup");
    expect(r.cleanup_remaining_loose).toBe(2);
  });
});
