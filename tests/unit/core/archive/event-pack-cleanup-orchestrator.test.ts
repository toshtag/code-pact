import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import {
  runEventPackCleanup,
  buildPostLoopOutcome,
  type UnlinkGatedLooseResult,
} from "../../../../src/core/archive/event-pack-cleanup-run.ts";
import type { LooseCleanupReconciliation } from "../../../../src/core/archive/event-pack-cleanup-reconcile.ts";
import { eventPackPath } from "../../../../src/core/archive/paths.ts";
import { eventFileName } from "../../../../src/core/progress/event-id.ts";
import { eventsDir } from "../../../../src/core/progress/events-io.ts";
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
  cwd = await mkdtemp(join(tmpdir(), "code-pact-orchestrator-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(join(eventsDir(cwd), file));
    return true;
  } catch {
    return false;
  }
};

/** Archive P1: snapshot + loose, phase YAML deleted. NO pack written (cell 10). */
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

/** Archive P1 AND write a full valid pack (cells 11/12/14). */
async function archivedWithPack(): Promise<ProgressEvent[]> {
  const events = await scaffoldArchivedP1();
  await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
  return events;
}

const looseFileOf = (events: ProgressEvent[], status: string): string =>
  eventFileName(events.find((e) => e.status === status)!);

// ---------------------------------------------------------------------------

describe("buildPostLoopOutcome — terminal CleanupOutcome from post-loop facts (PURE)", () => {
  const emptyLoop: UnlinkGatedLooseResult = { deleted: [], vanished: [], skipped: [], abort: null };
  const cleanRecon: LooseCleanupReconciliation = {
    terminal: null,
    skipped: [],
    cleanup_remaining_loose: 0,
    vanished_count: 0,
    advisories: [],
  };

  it("cleaned (normal): deleted>0 → partial_applied:true, loose_deleted_count:N, remaining:0", () => {
    const r = buildPostLoopOutcome({ ...emptyLoop, deleted: ["a", "b"] }, cleanRecon, false);
    expect(r).toMatchObject({
      ok: true, kind: "cleaned", partial_applied: true, loose_deleted_count: 2,
      cleanup_remaining_loose: 0, vanished_count: 0, cleanup_pending: false, cleanup_started: true,
    });
  });

  it("cleaned (all-vanished, no pack write): deleted:0 + vanished>0 → partial_applied:false", () => {
    const r = buildPostLoopOutcome({ ...emptyLoop, vanished: ["a"] }, cleanRecon, false);
    expect(r).toMatchObject({
      ok: true, kind: "cleaned", partial_applied: false, loose_deleted_count: 0, vanished_count: 1,
    });
  });

  it("cleaned (all-vanished after a cell-10 pack write): deleted:0 + vanished>0 + packWritten → partial_applied:true", () => {
    const r = buildPostLoopOutcome({ ...emptyLoop, vanished: ["a"] }, cleanRecon, true);
    expect(r).toMatchObject({
      ok: true, kind: "cleaned", partial_applied: true, loose_deleted_count: 0, vanished_count: 1,
    });
  });

  it("vanished_count sums the loop's vanishes and the reconciliation's", () => {
    const r = buildPostLoopOutcome(
      { ...emptyLoop, deleted: ["a"], vanished: ["b"] },
      { ...cleanRecon, vanished_count: 2 },
      false,
    );
    expect(r.vanished_count).toBe(3);
  });

  it("loop abort (live_task_owner) → CLEANUP_FAILED, NO pack_stale block, partial reflects prior deletes", () => {
    const r = buildPostLoopOutcome(
      { ...emptyLoop, deleted: ["a"], abort: { path: "x", reason: "live_task_owner", detail: "d" } },
      { ...cleanRecon, cleanup_remaining_loose: 1, skipped: [] },
      false,
    );
    expect(r).toMatchObject({
      ok: false, code: "STATE_COMPACT_CLEANUP_FAILED", partial_applied: true, loose_deleted_count: 1,
      cleanup_started: true,
    });
    expect((r as { block?: string }).block).toBeUndefined();
  });

  it("loop abort (pack_missing_event) → CLEANUP_FAILED with pack_stale_after_cleanup block", () => {
    const r = buildPostLoopOutcome(
      { ...emptyLoop, abort: { path: "x", reason: "pack_missing_event", detail: "d" } },
      cleanRecon,
      false,
    );
    expect(r).toMatchObject({
      ok: false, code: "STATE_COMPACT_CLEANUP_FAILED", block: "pack_stale_after_cleanup",
      partial_applied: false, loose_deleted_count: 0,
    });
  });

  it("abort (G6 live_task_owner) does NOT borrow a reconciliation pack_stale block — the abort reason is the signal", () => {
    const r = buildPostLoopOutcome(
      { ...emptyLoop, abort: { path: "x", reason: "live_task_owner", detail: "d" } },
      // A partial post-abort reconciliation that incidentally found a not-in-pack survivor.
      { terminal: "STATE_COMPACT_CLEANUP_FAILED", block: "pack_stale_after_cleanup", cleanup_remaining_loose: 1, vanished_count: 0, skipped: [{ path: "s", reason: "appeared_during_cleanup" }], advisories: [] },
      false,
    );
    expect(r).toMatchObject({ ok: false, code: "STATE_COMPACT_CLEANUP_FAILED" });
    expect((r as { block?: string }).block).toBeUndefined(); // G6 abort carries no pack_stale block
  });

  it("reconciliation FAILED → CLEANUP_FAILED carrying the reconciliation block", () => {
    const r = buildPostLoopOutcome(
      { ...emptyLoop, deleted: ["a"] },
      { terminal: "STATE_COMPACT_CLEANUP_FAILED", block: "pack_stale_after_cleanup", cleanup_remaining_loose: 1, vanished_count: 0, skipped: [{ path: "s", reason: "appeared_during_cleanup" }], advisories: [] },
      false,
    );
    expect(r).toMatchObject({
      ok: false, code: "STATE_COMPACT_CLEANUP_FAILED", block: "pack_stale_after_cleanup",
      cleanup_remaining_loose: 1,
    });
  });

  it("reconciliation INCOMPLETE → CLEANUP_INCOMPLETE", () => {
    const r = buildPostLoopOutcome(
      { ...emptyLoop, deleted: ["a"] },
      { terminal: "STATE_COMPACT_CLEANUP_INCOMPLETE", cleanup_remaining_loose: 1, vanished_count: 0, skipped: [{ path: "s", reason: "unreadable" }], advisories: [] },
      false,
    );
    expect(r).toMatchObject({
      ok: false, code: "STATE_COMPACT_CLEANUP_INCOMPLETE", cleanup_remaining_loose: 1,
    });
  });

  it("INVARIANT: a `cleaned` with 0 deleted AND 0 vanished is incoherent → throws", () => {
    expect(() => buildPostLoopOutcome(emptyLoop, cleanRecon, false)).toThrow(/invariant/i);
    // Even with a pack write, deleted 0 + vanished 0 is still incoherent.
    expect(() => buildPostLoopOutcome(emptyLoop, cleanRecon, true)).toThrow(/invariant/i);
  });
});

describe("runEventPackCleanup — end-to-end truth table (REAL unlink)", () => {
  it("cell 12 (pack + full loose) → cleaned; both loose files removed from disk", async () => {
    const events = await archivedWithPack();
    const r = await runEventPackCleanup(cwd, "P1");
    expect(r).toMatchObject({ ok: true, kind: "cleaned", loose_deleted_count: 2, cleanup_remaining_loose: 0, partial_applied: true });
    for (const e of events) expect(await exists(eventFileName(e))).toBe(false);
  });

  it("cell 14 (subset) → cleaned; the remnant is removed", async () => {
    const events = await archivedWithPack();
    await rm(join(eventsDir(cwd), looseFileOf(events, "started")));
    const r = await runEventPackCleanup(cwd, "P1");
    expect(r).toMatchObject({ ok: true, kind: "cleaned", loose_deleted_count: 1, cleanup_remaining_loose: 0 });
    expect(await exists(looseFileOf(events, "done"))).toBe(false);
  });

  it("cell 11 (pack, no loose) → already_cleaned (cleanup never started)", async () => {
    const events = await archivedWithPack();
    for (const e of events) await rm(join(eventsDir(cwd), eventFileName(e)));
    const r = await runEventPackCleanup(cwd, "P1");
    expect(r).toMatchObject({ ok: true, kind: "already_cleaned", cleanup_started: false, partial_applied: false });
  });

  it("cell 10 (loose, no pack) → writes the pack THEN cleans → cleaned, partial_applied:true", async () => {
    const events = await scaffoldArchivedP1(); // no pack
    const r = await runEventPackCleanup(cwd, "P1");
    expect(r).toMatchObject({ ok: true, kind: "cleaned", loose_deleted_count: 2, partial_applied: true });
    // pack on disk, loose removed.
    await stat(eventPackPath(cwd, "P1"));
    for (const e of events) expect(await exists(eventFileName(e))).toBe(false);
  });

  it("ineligible: the live phase YAML still present → ineligible(phase_file_still_present), nothing removed", async () => {
    await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
    await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
    await seedDurableEvents(cwd, STARTED_DONE);
    expect((await writePhaseSnapshot(cwd, "P1", { now: NOW })).kind).toBe("written");
    const r = await runEventPackCleanup(cwd, "P1");
    expect(r).toMatchObject({ ok: false, code: "STATE_COMPACT_INELIGIBLE", cleanup_started: false });
    if (r.ok) return;
    if (r.code !== "STATE_COMPACT_INELIGIBLE") return;
    expect(r.block.kind).toBe("phase_file_still_present");
  });

  it("G6 live owner re-uses the task_id → CLEANUP_FAILED; loose NOT removed (abort on the first file)", async () => {
    const events = await archivedWithPack();
    await writeFile(join(cwd, "design", "phases", "P99-reuser.yaml"), P99_REUSES_P1T1, "utf8");
    const r = await runEventPackCleanup(cwd, "P1");
    expect(r).toMatchObject({ ok: false, code: "STATE_COMPACT_CLEANUP_FAILED" });
    for (const e of events) expect(await exists(eventFileName(e))).toBe(true);
  });

  it("cell 10 verify_pack failure → STATE_COMPACT_WRITE_FAILED(verify_pack, partial_applied:true), no unlink", async () => {
    const events = await scaffoldArchivedP1();
    const r = await runEventPackCleanup(cwd, "P1", {
      apply: {
        beforeVerify: async () => {
          await writeFile(eventPackPath(cwd, "P1"), "{ corrupted after write", "utf8");
        },
      },
    });
    expect(r).toMatchObject({ ok: false, code: "STATE_COMPACT_WRITE_FAILED", cleanup_started: false });
    if (r.ok || r.code !== "STATE_COMPACT_WRITE_FAILED") return;
    expect(r.phase).toBe("verify_pack");
    expect(r.partial_applied).toBe(true);
    // No unlink happened.
    for (const e of events) expect(await exists(eventFileName(e))).toBe(true);
  });

  it("all-vanished race (cell 12, every loose deleted before its gate) → cleaned, deleted:0 / vanished:N / partial_applied:false", async () => {
    const events = await archivedWithPack();
    const r = await runEventPackCleanup(cwd, "P1", {
      loop: {
        beforeGate: async (file) => {
          await rm(join(eventsDir(cwd), file)); // vanish each target before its gate
        },
      },
    });
    expect(r).toMatchObject({ ok: true, kind: "cleaned", loose_deleted_count: 0, partial_applied: false, cleanup_remaining_loose: 0 });
    expect(r.vanished_count).toBe(2);
    void events;
  });

  it("cell 10 all-vanished AFTER the pack write → cleaned, partial_applied:true, deleted:0, vanished:N (NOT already_cleaned)", async () => {
    const events = await scaffoldArchivedP1(); // no pack — cell 10
    const r = await runEventPackCleanup(cwd, "P1", {
      // After the pack is written + verified, every loose vanishes before the
      // re-prepare reaches the loop. The pack write was OUR mutation → cleaned, not
      // already_cleaned (which would falsely report partial_applied:false).
      afterWrite: async () => {
        for (const e of events) await rm(join(eventsDir(cwd), eventFileName(e)));
      },
    });
    expect(r).toMatchObject({ ok: true, kind: "cleaned", partial_applied: true, loose_deleted_count: 0, cleanup_remaining_loose: 0 });
    expect(r.vanished_count).toBe(2); // the pre-write loose count, all vanished
    await stat(eventPackPath(cwd, "P1")); // the pack was written
  });
});
