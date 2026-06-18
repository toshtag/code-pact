import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import { buildValidEventPack, writeEventPackFile } from "../../../helpers/event-pack-fixture.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";
import { ProgressLog } from "../../../../src/core/schemas/progress-event.ts";
import {
  archiveDeleteIntentPath,
  eventPackPath,
  phaseSnapshotPath,
  sha256Hex,
} from "../../../../src/core/archive/paths.ts";
import {
  __setDeleteIntentDirFsyncForTests,
  clearDeleteIntent,
  DeleteIntentDurabilityError,
  DeleteIntentRecoveryError,
  PendingDeleteIntentError,
  readDeleteIntent,
  recoverPendingDeletes,
  writeDeleteIntent,
} from "../../../../src/core/archive/delete-intent-journal.ts";
import {
  deleteLoosePairsJournaled,
  type LoosePairToDelete,
} from "../../../../src/core/archive/retention-pair-delete.ts";
import { enumerateArchivedPhaseSnapshots, resolvePhaseSnapshotRaw } from "../../../../src/core/archive/load-phase-snapshot.ts";
import { readEventPackFiles, resolveEventPackRaw } from "../../../../src/core/archive/event-pack-reader.ts";
import { planCompactArchive } from "../../../../src/core/archive/archive-bundle-cleanup.ts";
import { writeArchiveBundle } from "../../../../src/core/archive/archive-bundle-writer.ts";

// Crash-safe both-or-neither deletion of a loose phase_snapshot ↔ event_pack pair,
// committed through the delete-intent journal. The journal write is the COMMIT: a
// crash before it → both retained; a crash after it → recovery completes both. See
// design/decisions/retention-pair-delete-journal-rfc.md.

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-pair-delete-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "phases"), { recursive: true });
});
afterEach(async () => {
  __setDeleteIntentDirFsyncForTests(null); // clear any injected barrier failure
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** Inject a directory-fsync barrier failure for ONE purpose; all other barriers
 *  succeed (return without a real fsync — the test exercises control flow). */
function failDirFsyncFor(target: string): void {
  __setDeleteIntentDirFsyncForTests((_dir, purpose) => {
    if (purpose === target) throw new DeleteIntentDurabilityError("failed", `injected ${purpose} fsync failure`);
  });
}

const TASK_FIELDS = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;

/** Archive ONE done phase as a loose snapshot + a loose event pack (a deletable
 *  pair), and return the pair with the digests the planner would capture. */
async function setupPair(phaseId: string): Promise<LoosePairToDelete> {
  await writeFile(
    join(cwd, "design", "roadmap.yaml"),
    `phases:\n  - id: ${phaseId}\n    path: design/phases/${phaseId}.yaml\n    weight: 1\n`,
    "utf8",
  );
  await writeFile(
    join(cwd, "design", "phases", `${phaseId}.yaml`),
    `id: ${phaseId}
name: Phase ${phaseId}
weight: 1
confidence: high
risk: low
status: done
objective: do ${phaseId}
definition_of_done:
  - it works
verification:
  commands:
    - "true"
tasks:
  - id: ${phaseId}-T1
    type: feature
${TASK_FIELDS}
    status: done
`,
    "utf8",
  );
  await seedDurableEvents(
    cwd,
    `events:\n  - task_id: ${phaseId}-T1\n    status: done\n    at: 2026-06-01T00:00:00.000Z\n    actor: agent\n`,
  );
  expect((await writePhaseSnapshot(cwd, phaseId, { now: new Date("2026-01-01T00:00:00.000Z") })).kind).toBe("written");
  const events = ProgressLog.parse({
    events: [{ task_id: `${phaseId}-T1`, status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }],
  }).events;
  await writeEventPackFile(cwd, phaseId, await buildValidEventPack(cwd, phaseId, events));
  const phaseRaw = await readFile(phaseSnapshotPath(cwd, phaseId), "utf8");
  const packRaw = await readFile(eventPackPath(cwd, phaseId), "utf8");
  return { phase_id: phaseId, phase_sha256: sha256Hex(phaseRaw), pack_sha256: sha256Hex(packRaw) };
}

const exists = (p: string): Promise<boolean> => readFile(p, "utf8").then(() => true, () => false);
const intentExists = (): Promise<boolean> => exists(archiveDeleteIntentPath(cwd));

describe("delete-intent journal — primitives", () => {
  it("write → read round-trips the committed pairs", async () => {
    await mkdir(join(cwd, ".code-pact", "state", "archive"), { recursive: true });
    const intents = [{ intent_kind: "loose_pair" as const, phase_id: "P1", phase_sha256: sha256Hex("a"), pack_sha256: sha256Hex("b") }];
    await writeDeleteIntent(cwd, intents);
    const read = await readDeleteIntent(cwd);
    expect(read.kind).toBe("present");
    if (read.kind === "present") expect(read.intent.intents).toEqual(intents);
  });

  it("clear is idempotent — clearing an absent journal is a no-op", async () => {
    await clearDeleteIntent(cwd); // never written
    expect(await intentExists()).toBe(false);
  });

  it("INVARIANT 1 — no journal → recovery is a no-op (archive untouched)", async () => {
    const out = await recoverPendingDeletes(cwd);
    expect(out.completed).toEqual([]);
  });

  it("a CORRUPT journal fails recovery closed (never silently ignored)", async () => {
    await mkdir(join(cwd, ".code-pact", "state", "archive"), { recursive: true });
    await writeFile(archiveDeleteIntentPath(cwd), "{ not a valid intent", "utf8");
    const read = await readDeleteIntent(cwd);
    expect(read.kind).toBe("corrupt");
    if (read.kind === "corrupt") expect(read.cause).toBe("parse_error"); // a mangled file, not an I/O fault
    await expect(recoverPendingDeletes(cwd)).rejects.toBeInstanceOf(DeleteIntentRecoveryError);
  });
});

describe("deleteLoosePairsJournaled — crash-safe both-or-neither", () => {
  it("INVARIANT 5 (both deleted) — the happy path removes both files and clears the journal", async () => {
    const pair = await setupPair("P1");
    const out = await deleteLoosePairsJournaled(cwd, [pair]);
    expect(out.deleted).toEqual(["P1"]);
    expect(out.retained).toEqual([]);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false);
    expect(await intentExists()).toBe(false); // journal cleared on success
  });

  it("INVARIANT 2 — crash AFTER intent written: recovery completes both unlinks", async () => {
    const pair = await setupPair("P1");
    // Simulate a crash the instant the intent is committed, before any unlink.
    await expect(
      deleteLoosePairsJournaled(cwd, [pair], {
        afterIntentWritten: () => {
          throw new Error("crash");
        },
      }),
    ).rejects.toThrow("crash");
    // Intermediate: journal present, BOTH files still present.
    expect(await intentExists()).toBe(true);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true);
    // Recovery rolls forward to both-gone.
    expect((await recoverPendingDeletes(cwd)).completed).toEqual(["P1"]);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false);
    expect(await intentExists()).toBe(false);
  });

  it("INVARIANT 3 — crash AFTER pack unlinked (the dangling intermediate): recovery completes the phase", async () => {
    const pair = await setupPair("P1");
    await expect(
      deleteLoosePairsJournaled(cwd, [pair], {
        afterPackUnlinked: () => {
          throw new Error("crash");
        },
      }),
    ).rejects.toThrow("crash");
    // Intermediate: pack GONE, phase PRESENT — the dangling-evidence state. The
    // journal makes it recoverable rather than a permanent break.
    expect(await intentExists()).toBe(true);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true);
    expect((await recoverPendingDeletes(cwd)).completed).toEqual(["P1"]);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false);
    expect(await intentExists()).toBe(false);
  });

  it("INVARIANT 4 — crash AFTER phase unlinked (both gone, intent not cleared): recovery clears the journal", async () => {
    const pair = await setupPair("P1");
    await expect(
      deleteLoosePairsJournaled(cwd, [pair], {
        afterPhaseUnlinked: () => {
          throw new Error("crash");
        },
      }),
    ).rejects.toThrow("crash");
    // Intermediate: both gone, journal still present.
    expect(await intentExists()).toBe(true);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false);
    // Recovery is idempotent — re-unlinks to ENOENT, then clears the journal.
    expect((await recoverPendingDeletes(cwd)).completed).toEqual(["P1"]);
    expect(await intentExists()).toBe(false);
  });

  it("INVARIANT 6 — a stale (changed) member is NOT committed: both retained, no journal", async () => {
    const pair = await setupPair("P1");
    // Re-serialize the phase snapshot to different bytes (same record, compact JSON)
    // so its on-disk digest no longer matches the plan's `phase_sha256`.
    const phaseRaw = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    await writeFile(phaseSnapshotPath(cwd, "P1"), JSON.stringify(JSON.parse(phaseRaw)), "utf8");
    const out = await deleteLoosePairsJournaled(cwd, [pair]);
    expect(out.deleted).toEqual([]);
    // The phase is stale (authority_changed); the pack was removable but its pair didn't commit.
    expect(out.retained).toEqual([
      { phase_id: "P1", phase: { kind: "skip", reason: "authority_changed" }, pack: { kind: "skip", reason: "requires_atomic_pair_removal" } },
    ]);
    expect(await intentExists()).toBe(false); // nothing committed
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true); // both retained
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true);
  });

  it("INVARIANT 7 — a member with no loose copy (already gone) is NOT committed: ONLY that side is vanished", async () => {
    const pair = await setupPair("P1");
    await rm(eventPackPath(cwd, "P1")); // the pack has no loose copy
    const out = await deleteLoosePairsJournaled(cwd, [pair]);
    expect(out.deleted).toEqual([]);
    // The pack is genuinely gone (vanished); the present phase is NOT reported vanished.
    expect(out.retained).toEqual([
      { phase_id: "P1", phase: { kind: "skip", reason: "requires_atomic_pair_removal" }, pack: { kind: "vanished" } },
    ]);
    expect(await intentExists()).toBe(false);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true); // the phase is untouched
  });

  it("INVARIANT 8 — both members are gated against the planner's digest authority (one stale side blocks the pair)", async () => {
    const pair = await setupPair("P1");
    // The pack digest still matches, but the phase digest is from a different plan.
    const out = await deleteLoosePairsJournaled(cwd, [{ ...pair, phase_sha256: sha256Hex("a different plan") }]);
    expect(out.deleted).toEqual([]);
    expect(out.retained).toEqual([
      { phase_id: "P1", phase: { kind: "skip", reason: "authority_changed" }, pack: { kind: "skip", reason: "requires_atomic_pair_removal" } },
    ]);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true);
  });

  it("NO-OVERWRITE — a pending journal blocks a new pair delete (the caller must recover first)", async () => {
    const pair = await setupPair("P1");
    // A leftover journal from an unrecovered prior crash (names a different pair).
    await writeDeleteIntent(cwd, [{ intent_kind: "loose_pair", phase_id: "P9", phase_sha256: sha256Hex("x"), pack_sha256: sha256Hex("y") }]);
    await expect(deleteLoosePairsJournaled(cwd, [pair])).rejects.toBeInstanceOf(PendingDeleteIntentError);
    // The existing journal is untouched (its recovery authority is preserved) and
    // nothing was deleted.
    const read = await readDeleteIntent(cwd);
    expect(read.kind === "present" && read.intent.intents[0]!.phase_id).toBe("P9");
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true);
  });

  it("writeDeleteIntent itself refuses to overwrite an existing journal", async () => {
    await mkdir(join(cwd, ".code-pact", "state", "archive"), { recursive: true });
    await writeDeleteIntent(cwd, [{ intent_kind: "loose_pair", phase_id: "P1", phase_sha256: sha256Hex("a"), pack_sha256: sha256Hex("b") }]);
    await expect(
      writeDeleteIntent(cwd, [{ intent_kind: "loose_pair", phase_id: "P2", phase_sha256: sha256Hex("c"), pack_sha256: sha256Hex("d") }]),
    ).rejects.toBeInstanceOf(PendingDeleteIntentError);
    const read = await readDeleteIntent(cwd);
    expect(read.kind === "present" && read.intent.intents[0]!.phase_id).toBe("P1"); // the first commit survives
  });

  it("a duplicate phase_id in the input is rejected (no commit, both retained)", async () => {
    const pair = await setupPair("P1");
    await expect(deleteLoosePairsJournaled(cwd, [pair, pair])).rejects.toThrow(/duplicate phase_id/);
    expect(await intentExists()).toBe(false);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true);
  });

  it("ENFORCES loose-only — a pair with a bundle copy is NOT journaled (needs_bundle_member_removal)", async () => {
    const pair = await setupPair("P1");
    // Give P1's phase snapshot a bundle copy → P1 is `both`, not loose-only. The journal
    // must refuse it (so the reader filter never wrongly hides the surviving bundle copy).
    const looseP1 = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: looseP1 }]);
    const out = await deleteLoosePairsJournaled(cwd, [pair]);
    expect(out.deleted).toEqual([]);
    expect(out.retained).toEqual([
      { phase_id: "P1", phase: { kind: "skip", reason: "needs_bundle_member_removal" }, pack: { kind: "skip", reason: "needs_bundle_member_removal" } },
    ]);
    expect(await intentExists()).toBe(false); // never committed
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true);
  });

  it("ENFORCES loose-only — a pair whose EVENT_PACK has a bundle copy is NOT journaled either", async () => {
    const pair = await setupPair("P1");
    // Give P1's event_pack a bundle copy (the loose pack is canonical, so writeArchiveBundle accepts it).
    const loosePack = await readFile(eventPackPath(cwd, "P1"), "utf8");
    await writeArchiveBundle(cwd, "event_pack", [{ id: "P1", bytes: loosePack }]);
    const out = await deleteLoosePairsJournaled(cwd, [pair]);
    expect(out.deleted).toEqual([]);
    expect(out.retained).toEqual([
      { phase_id: "P1", phase: { kind: "skip", reason: "needs_bundle_member_removal" }, pack: { kind: "skip", reason: "needs_bundle_member_removal" } },
    ]);
    expect(await intentExists()).toBe(false);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true);
  });

  it("a multi-pair batch commits all gated pairs in ONE intent, then removes each pair", async () => {
    const p1 = await setupPair("P1");
    const p2 = await setupPair("P2");
    const out = await deleteLoosePairsJournaled(cwd, [p1, p2]);
    expect(out.deleted.sort()).toEqual(["P1", "P2"]);
    for (const id of ["P1", "P2"]) {
      expect(await exists(phaseSnapshotPath(cwd, id))).toBe(false);
      expect(await exists(eventPackPath(cwd, id))).toBe(false);
    }
    expect(await intentExists()).toBe(false);
  });
});

describe("deleteLoosePairsJournaled — durability barriers are REQUIRED (fail-closed, not best-effort)", () => {
  it("a COMMIT dir-fsync failure fails closed at the PREFLIGHT — no journal, no member unlinked", async () => {
    const pair = await setupPair("P1");
    failDirFsyncFor("commit");
    await expect(deleteLoosePairsJournaled(cwd, [pair])).rejects.toBeInstanceOf(DeleteIntentDurabilityError);
    // The commit barrier is PREFLIGHTED before the journal is written, so a failure leaves NO
    // journal on disk (nothing for recovery to complete) and no member unlinked — both retained.
    // This is what makes an `unsupported` platform's "defer" honest: it can't leave a committed
    // journal that a later recovery would silently complete.
    expect(await intentExists()).toBe(false);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true);
  });

  it("a MEMBER-dir fsync failure fails closed — the journal is NOT cleared (recovery will retry)", async () => {
    const pair = await setupPair("P1");
    failDirFsyncFor("event_packs"); // commit + others succeed; the member-dir barrier throws
    await expect(deleteLoosePairsJournaled(cwd, [pair])).rejects.toBeInstanceOf(DeleteIntentDurabilityError);
    // The barrier threw before clearDeleteIntent → the journal survives, so a later
    // recoverPendingDeletes re-runs the deletion (idempotent) rather than stranding it.
    expect(await intentExists()).toBe(true);
  });

  it("a CLEAR dir fsync failure is reported (not swallowed as success)", async () => {
    const pair = await setupPair("P1");
    failDirFsyncFor("clear");
    await expect(deleteLoosePairsJournaled(cwd, [pair])).rejects.toBeInstanceOf(DeleteIntentDurabilityError);
  });

  it("a schema-valid but NON-CANONICAL journal (compact bytes) is corrupt — not the writer's form", async () => {
    await mkdir(join(cwd, ".code-pact", "state", "archive"), { recursive: true });
    // Valid intent, but compact JSON (no 2-space indent / trailing newline) — a hand-edit.
    const compact = JSON.stringify({ schema_version: 2, intents: [{ intent_kind: "loose_pair", phase_id: "P1", phase_sha256: sha256Hex("a"), pack_sha256: sha256Hex("b") }] });
    await writeFile(archiveDeleteIntentPath(cwd), compact, "utf8");
    const read = await readDeleteIntent(cwd);
    expect(read.kind).toBe("corrupt");
    if (read.kind === "corrupt") expect(read.cause).toBe("parse_error");
  });

  it("a schema-valid but DUPLICATE-id journal is corrupt → recovery fail-closed", async () => {
    await mkdir(join(cwd, ".code-pact", "state", "archive"), { recursive: true });
    const dup =
      JSON.stringify(
        {
          schema_version: 2,
          intents: [
            { intent_kind: "loose_pair", phase_id: "P1", phase_sha256: sha256Hex("a"), pack_sha256: sha256Hex("b") },
            { intent_kind: "loose_pair", phase_id: "P1", phase_sha256: sha256Hex("c"), pack_sha256: sha256Hex("d") },
          ],
        },
        null,
        2,
      ) + "\n";
    await writeFile(archiveDeleteIntentPath(cwd), dup, "utf8");
    const read = await readDeleteIntent(cwd);
    expect(read.kind).toBe("corrupt");
    if (read.kind === "corrupt") expect(read.cause).toBe("parse_error");
    await expect(recoverPendingDeletes(cwd)).rejects.toBeInstanceOf(DeleteIntentRecoveryError);
  });
});

describe("reader-awareness — a pending delete-intent hides the pair from readers", () => {
  /** Write a pending journal naming `phaseId` (a pair mid-deletion). */
  async function pendIntent(phaseId: string): Promise<void> {
    await writeDeleteIntent(cwd, [{ intent_kind: "loose_pair", phase_id: phaseId, phase_sha256: sha256Hex("p"), pack_sha256: sha256Hex("k") }]);
  }

  it("resolvePhaseSnapshotRaw reads a pending phase as ABSENT (its loose file still present)", async () => {
    await setupPair("P1");
    expect((await resolvePhaseSnapshotRaw(cwd, "P1")).kind).toBe("valid"); // before the intent
    await pendIntent("P1");
    expect((await resolvePhaseSnapshotRaw(cwd, "P1")).kind).toBe("absent"); // logically absent now
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true); // the file is physically still there
  });

  it("resolveEventPackRaw reads a pending pack as ABSENT", async () => {
    await setupPair("P1");
    expect((await resolveEventPackRaw(cwd, "P1")).kind).toBe("present");
    await pendIntent("P1");
    expect((await resolveEventPackRaw(cwd, "P1")).kind).toBe("absent");
  });

  it("enumerateArchivedPhaseSnapshots and readEventPackFiles exclude a pending pair", async () => {
    await setupPair("P1");
    await setupPair("P2");
    await pendIntent("P1"); // only P1 is mid-deletion
    const stems = (await enumerateArchivedPhaseSnapshots(cwd)).entries.map((e) => e.fileStem);
    expect(stems).toEqual(["P2"]); // P1 hidden
    const packIds = (await readEventPackFiles(cwd)).map((p) => p.pack.phase_id);
    expect(packIds).toEqual(["P2"]);
  });

  it("the crash→recovery HALF-STATE (journal present, pack gone, phase present) reads as absent — no dangling", async () => {
    await setupPair("P1");
    await pendIntent("P1");
    await rm(eventPackPath(cwd, "P1")); // simulate: pack already unlinked, phase not yet
    // The snapshot reads absent (so its progress_events evidence is never validated
    // against the now-gone pack), and the pack reads absent — the pair is hidden whole.
    expect((await resolvePhaseSnapshotRaw(cwd, "P1")).kind).toBe("absent");
    expect((await resolveEventPackRaw(cwd, "P1")).kind).toBe("absent");
    expect((await enumerateArchivedPhaseSnapshots(cwd)).entries.map((e) => e.fileStem)).toEqual([]);
  });

  it("readers are READ-ONLY — consulting the journal never mutates or clears it", async () => {
    await setupPair("P1");
    await pendIntent("P1");
    await resolvePhaseSnapshotRaw(cwd, "P1");
    await enumerateArchivedPhaseSnapshots(cwd);
    await readEventPackFiles(cwd);
    expect(await intentExists()).toBe(true); // the recovery authority is untouched
  });

  it("once the journal is cleared (recovery done), surviving records read normally again", async () => {
    await setupPair("P1");
    await pendIntent("P1");
    expect((await resolvePhaseSnapshotRaw(cwd, "P1")).kind).toBe("absent");
    await clearDeleteIntent(cwd); // recovery completed (here the files happen to survive)
    expect((await resolvePhaseSnapshotRaw(cwd, "P1")).kind).toBe("valid"); // visible again
  });

  it("the COMPACTION planner (planCompactArchive) never folds a pending pair — both phase and pack kinds", async () => {
    await setupPair("P1");
    await setupPair("P2");
    await pendIntent("P1"); // P1 is mid-deletion
    for (const kind of ["phase_snapshot", "event_pack"] as const) {
      const plan = await planCompactArchive(cwd, kind);
      const ids = [...plan.would_bundle, ...plan.would_delete, ...plan.would_supersede, ...plan.would_skip.map((s) => s.id)];
      expect(ids).not.toContain("P1"); // logically absent — compaction must not touch a mid-deletion record
      expect(ids).toContain("P2"); // P2 is a normal loose record, foldable
    }
  });
});
