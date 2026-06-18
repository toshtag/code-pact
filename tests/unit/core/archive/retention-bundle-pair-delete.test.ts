import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { ProgressLog, type ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import { buildValidEventPack } from "../../../helpers/event-pack-fixture.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";
import { writeArchiveBundle } from "../../../../src/core/archive/archive-bundle-writer.ts";
import { loadArchiveBundles } from "../../../../src/core/archive/archive-bundle-loader.ts";
import { resolveEventPackRaw } from "../../../../src/core/archive/event-pack-reader.ts";
import { enumerateLooseMembers } from "../../../../src/core/archive/archive-bundle-writer.ts";
import { resolvePhaseSnapshotRaw } from "../../../../src/core/archive/load-phase-snapshot.ts";
import { deleteBundlePairsJournaled } from "../../../../src/core/archive/retention-bundle-pair-delete.ts";
import {
  __setDeleteIntentDirFsyncForTests,
  BundlePairNotCommittableError,
  DeleteIntentDurabilityError,
  DeleteIntentRecoveryError,
  readDeleteIntent,
  recoverPendingDeletes,
} from "../../../../src/core/archive/delete-intent-journal.ts";
import { archiveBundlePath, archiveBundlesDir, eventPackPath, phaseSnapshotPath, sha256Hex } from "../../../../src/core/archive/paths.ts";
import { computeMemberIdsSha256 } from "../../../../src/core/archive/archive-bundle-reader.ts";
import { ARCHIVE_BUNDLE_SCHEMA_VERSION, type ArchiveBundleKind } from "../../../../src/core/schemas/archive-bundle.ts";

// Bundle-PAIR journaled removal (Layer 2): remove a phase_snapshot ↔ event_pack BUNDLE
// pair both-or-neither, committed through the delete-intent journal so the two
// old-bundle retires are crash-safe. UNWIRED — exercised directly here.

const NOW = new Date("2026-06-10T00:00:00.000Z");
const TASK_FIELDS = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-bpair-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "event-packs"), { recursive: true });
});
afterEach(async () => {
  __setDeleteIntentDirFsyncForTests(null);
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** Build a done phase's snapshot bytes AND its event-pack bytes, then remove both loose
 *  copies (bundle-only from here). Returns the two canonical byte strings. */
async function pairBytes(id: string): Promise<{ snap: string; pack: string }> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), `phases:\n  - id: ${id}\n    path: design/phases/${id}.yaml\n    weight: 1\n`, "utf8");
  await writeFile(
    join(cwd, "design", "phases", `${id}.yaml`),
    `id: ${id}\nname: Phase ${id}\nweight: 1\nconfidence: high\nrisk: low\nstatus: done\nobjective: do ${id}\ndefinition_of_done:\n  - it works\nverification:\n  commands:\n    - "true"\ntasks:\n  - id: ${id}-T1\n    type: feature\n${TASK_FIELDS}\n    status: done\n`,
    "utf8",
  );
  const eventsYaml = `events:\n  - task_id: ${id}-T1\n    status: done\n    at: 2026-06-01T00:00:00.000Z\n    actor: agent\n`;
  await seedDurableEvents(cwd, eventsYaml);
  expect((await writePhaseSnapshot(cwd, id, { now: NOW })).kind).toBe("written");
  const events: ProgressEvent[] = ProgressLog.parse(parse(eventsYaml)).events;
  const pack = await buildValidEventPack(cwd, id, events);
  const snap = await readFile(phaseSnapshotPath(cwd, id), "utf8");
  const packBytes = JSON.stringify(pack, null, 2) + "\n";
  await rm(phaseSnapshotPath(cwd, id)); // bundle-only
  return { snap, pack: packBytes };
}

/** Bundle the given phases' snapshots and packs (one consolidated bundle per kind). */
async function bundlePairs(ids: string[], bytesById: Map<string, { snap: string; pack: string }>): Promise<void> {
  await writeArchiveBundle(cwd, "phase_snapshot", ids.map((id) => ({ id, bytes: bytesById.get(id)!.snap })));
  await writeArchiveBundle(cwd, "event_pack", ids.map((id) => ({ id, bytes: bytesById.get(id)!.pack })));
}

async function listBundleNames(): Promise<string[]> {
  return readdir(archiveBundlesDir(cwd)).then((ns) => ns.filter((n) => n.endsWith(".json")).sort(), () => []);
}

/** Write a Tier-1-VALID bundle directly (bypassing the writer's per-member authority foldability),
 *  so a test can plant a MISFILED member (e.g. an event_pack whose body phase_id is another id). */
async function rawBundle(kind: ArchiveBundleKind, members: { id: string; bytes: string }[]): Promise<void> {
  const records = members
    .map((m) => ({ id: m.id, sha256: sha256Hex(m.bytes), bytes: m.bytes }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const idsHash = computeMemberIdsSha256(records.map((r) => r.id));
  await mkdir(archiveBundlesDir(cwd), { recursive: true });
  await writeFile(
    archiveBundlePath(cwd, kind, idsHash),
    JSON.stringify({ schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION, kind, member_ids_sha256: idsHash, members: records }, null, 2) + "\n",
    "utf8",
  );
}

/** Resolve a phase's id from BOTH kinds' bundle stores (no loose copies). */
async function resolvesInBundles(id: string): Promise<{ phase: boolean; pack: boolean }> {
  const idx = loadArchiveBundles(cwd).index;
  return { phase: idx.get("phase_snapshot")?.has(id) ?? false, pack: idx.get("event_pack")?.has(id) ?? false };
}

describe("deleteBundlePairsJournaled — both-or-neither bundle-pair removal", () => {
  it("removes a bundle pair: reduced bundles written, old retired, journal cleared, both sides deleted", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    for (const id of ["P1", "P2", "P3"]) bytesById.set(id, await pairBytes(id));
    await bundlePairs(["P1", "P2", "P3"], bytesById);

    const out = await deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }]);
    expect(out.removed).toEqual([{ phase_id: "P1", phase_snapshot: "deleted", event_pack: "deleted" }]);
    expect(out.skipped).toEqual([]);
    // P1 is gone from BOTH bundle stores; P2/P3 survive.
    expect(await resolvesInBundles("P1")).toEqual({ phase: false, pack: false });
    expect(await resolvesInBundles("P2")).toEqual({ phase: true, pack: true });
    // Journal cleared (no pending intent).
    expect((await readDeleteIntent(cwd)).kind).toBe("absent");
  });

  it("removing ALL members of each kind deletes the bundles (empty-set marker)", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    bytesById.set("P1", await pairBytes("P1"));
    await bundlePairs(["P1"], bytesById);

    const out = await deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }]);
    expect(out.removed).toEqual([{ phase_id: "P1", phase_snapshot: "deleted", event_pack: "deleted" }]);
    expect(await listBundleNames()).toEqual([]); // both bundles deleted, no replacement
  });

  it("a pair whose pack is NOT a bundle member is deferred whole (not_bundle_member), nothing removed", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await pairBytes(id));
    // Only the phase_snapshot side is bundled; the pack side is absent from bundles.
    await writeArchiveBundle(cwd, "phase_snapshot", ["P1", "P2"].map((id) => ({ id, bytes: bytesById.get(id)!.snap })));

    const out = await deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }]);
    expect(out.removed).toEqual([]);
    expect(out.skipped).toEqual([{ phase_id: "P1", reason: "not_bundle_member" }]);
    expect(await resolvesInBundles("P1")).toEqual({ phase: true, pack: false }); // untouched
  });

  it("a `both` pair (loose copies present) → bundle_member_removed (the loose halves survive)", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await pairBytes(id));
    await bundlePairs(["P1", "P2"], bytesById);
    // Re-materialize P1's loose copies so it is `both` (loose + bundle).
    await writeFile(phaseSnapshotPath(cwd, "P1"), bytesById.get("P1")!.snap, "utf8");
    await writeFile(eventPackPath(cwd, "P1"), bytesById.get("P1")!.pack, "utf8");

    const out = await deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }]);
    expect(out.removed).toEqual([{ phase_id: "P1", phase_snapshot: "bundle_member_removed", event_pack: "bundle_member_removed" }]);
    // The loose halves still resolve (old truth remains until the loose layer drops it next run).
    expect(await readFile(phaseSnapshotPath(cwd, "P1"), "utf8")).toBe(bytesById.get("P1")!.snap);
    expect(await readFile(eventPackPath(cwd, "P1"), "utf8")).toBe(bytesById.get("P1")!.pack);
  });

  it("a MIXED-source pair (one side has a surviving loose copy, the other does not) is DEFERRED whole — no half-state", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await pairBytes(id));
    await bundlePairs(["P1", "P2"], bytesById);
    // P1 phase is `both` (re-materialize its loose copy); P1 pack stays bundle-only → MIXED source.
    await writeFile(phaseSnapshotPath(cwd, "P1"), bytesById.get("P1")!.snap, "utf8");
    const before = await listBundleNames();

    const out = await deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }]);
    expect(out.removed).toEqual([]);
    expect(out.skipped).toEqual([{ phase_id: "P1", reason: "mixed_source" }]); // removing both bundle members would orphan the pack
    expect(await listBundleNames()).toEqual(before); // nothing written, nothing retired
    expect((await readDeleteIntent(cwd)).kind).toBe("absent"); // no commit
    expect(await resolvesInBundles("P1")).toEqual({ phase: true, pack: true }); // both bundle members intact
    expect(await readFile(phaseSnapshotPath(cwd, "P1"), "utf8")).toBe(bytesById.get("P1")!.snap); // loose half intact
  });

  it("an authority-INVALID event_pack member (misfiled: id P1, body phase_id P2) → unsafe_authority, untouched", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await pairBytes(id));
    // P1 is a valid phase_snapshot member, but its event_pack member is MISFILED: filed under id
    // "P1" while its body's phase_id is "P2" → fails the event_pack authority re-validation.
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: bytesById.get("P1")!.snap }]);
    await rawBundle("event_pack", [{ id: "P1", bytes: bytesById.get("P2")!.pack }]);
    const before = await listBundleNames();

    const out = await deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }]);
    expect(out.removed).toEqual([]);
    expect(out.skipped).toEqual([{ phase_id: "P1", reason: "unsafe_authority" }]); // the kind is fail-closed
    expect(await listBundleNames()).toEqual(before); // nothing written, nothing retired
    expect((await readDeleteIntent(cwd)).kind).toBe("absent"); // no commit
  });

  it("TWO pairs sharing the same bundles are removed consistently (consolidated survivor)", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    for (const id of ["P1", "P2", "P3"]) bytesById.set(id, await pairBytes(id));
    await bundlePairs(["P1", "P2", "P3"], bytesById);

    const out = await deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }, { phase_id: "P2" }]);
    expect(out.removed.map((r) => r.phase_id).sort()).toEqual(["P1", "P2"]);
    // P1 AND P2 gone; ONLY P3 survives (the consolidated survivor bundle), never resurrected.
    expect(await resolvesInBundles("P1")).toEqual({ phase: false, pack: false });
    expect(await resolvesInBundles("P2")).toEqual({ phase: false, pack: false });
    expect(await resolvesInBundles("P3")).toEqual({ phase: true, pack: true });
  });
});

describe("deleteBundlePairsJournaled — crash safety (journal recovery)", () => {
  it("a crash AFTER the commit (before any retire) → recovery completes both retires", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await pairBytes(id));
    await bundlePairs(["P1", "P2"], bytesById);

    // Simulate process death right after the durable commit.
    await expect(deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }], { afterIntentWritten: () => { throw new Error("crash"); } })).rejects.toThrow("crash");
    // The journal is on disk (the commit), the OLD bundles are NOT yet retired → P1 still resolves.
    expect((await readDeleteIntent(cwd)).kind).toBe("present");

    const rec = await recoverPendingDeletes(cwd);
    expect(rec.completed).toEqual(["P1"]);
    expect((await readDeleteIntent(cwd)).kind).toBe("absent"); // cleared
    expect(await resolvesInBundles("P1")).toEqual({ phase: false, pack: false }); // both retired
    expect(await resolvesInBundles("P2")).toEqual({ phase: true, pack: true });
  });

  it("a crash BETWEEN the two old-bundle retires → recovery completes the rest (both gone)", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    bytesById.set("P1", await pairBytes("P1"));
    await bundlePairs(["P1"], bytesById); // empty-set case: removing P1 deletes both bundles

    let retireCount = 0;
    await expect(
      deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }], {
        beforeRetire: () => {
          retireCount += 1;
          if (retireCount === 2) throw new Error("crash mid-retire"); // die before the 2nd unlink
        },
      }),
    ).rejects.toThrow("crash mid-retire");
    expect((await readDeleteIntent(cwd)).kind).toBe("present"); // journal still names the pair

    const rec = await recoverPendingDeletes(cwd);
    expect(rec.completed).toEqual(["P1"]);
    expect(await listBundleNames()).toEqual([]); // both bundles retired, journal cleared
  });

  it("a crash BEFORE the commit (durable write fails) → no journal, both old bundles intact, a re-run completes", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await pairBytes(id));
    await bundlePairs(["P1", "P2"], bytesById);

    // Fail the survivor-bundle durable write barrier → abort BEFORE the commit.
    __setDeleteIntentDirFsyncForTests((_d, purpose) => {
      if (purpose === "bundle_write") throw new DeleteIntentDurabilityError("failed", "injected");
    });
    await expect(deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }])).rejects.toBeInstanceOf(DeleteIntentDurabilityError);
    expect((await readDeleteIntent(cwd)).kind).toBe("absent"); // NO commit → nothing pending
    expect(await resolvesInBundles("P1")).toEqual({ phase: true, pack: true }); // both old bundles intact

    // A clean re-run completes the removal.
    __setDeleteIntentDirFsyncForTests(null);
    const out = await deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }]);
    expect(out.removed).toEqual([{ phase_id: "P1", phase_snapshot: "deleted", event_pack: "deleted" }]);
    expect(await resolvesInBundles("P1")).toEqual({ phase: false, pack: false });
  });

  it("recovery is FAIL-CLOSED if a survivor bundle vanished after the commit", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await pairBytes(id));
    await bundlePairs(["P1", "P2"], bytesById);

    // Commit, then delete the just-written survivor bundle before recovery runs.
    await expect(
      deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }], {
        afterIntentWritten: async () => {
          // remove every bundle whose member set is the survivors (P2) — the reduced new bundle
          const idx = loadArchiveBundles(cwd).index;
          void idx; // (survivor bundles are the ones NOT holding P1)
          for (const f of await listBundleNames()) {
            const raw = await readFile(join(archiveBundlesDir(cwd), f), "utf8");
            if (!raw.includes('"P1"')) await rm(join(archiveBundlesDir(cwd), f)); // the reduced survivor bundle
          }
          throw new Error("crash");
        },
      }),
    ).rejects.toThrow("crash");
    await expect(recoverPendingDeletes(cwd)).rejects.toBeInstanceOf(DeleteIntentRecoveryError);
  });

  it("PRE-COMMIT: an old phase bundle that goes stale before the commit → NO journal written, no wedge", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await pairBytes(id));
    await bundlePairs(["P1", "P2"], bytesById);
    const before = await listBundleNames();

    await expect(
      deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }], {
        beforeIntentWritten: async () => {
          // After the reduced bundles are written but before the commit, stale the OLD phase bundle
          // (the {P1,P2,P3}-style bundle holding P1). The commit must be refused, not written.
          for (const f of await listBundleNames()) {
            if (f.startsWith("phase_snapshot-") && (await readFile(join(archiveBundlesDir(cwd), f), "utf8")).includes('"P1"')) {
              await writeFile(join(archiveBundlesDir(cwd), f), (await readFile(join(archiveBundlesDir(cwd), f), "utf8")) + " ", "utf8");
            }
          }
        },
      }),
    ).rejects.toBeInstanceOf(BundlePairNotCommittableError);
    expect((await readDeleteIntent(cwd)).kind).toBe("absent"); // NO journal → recovery has nothing to wedge on
    // The old bundles still resolve P1 (nothing retired) — a clean re-plan can decide afresh.
    expect((await resolvesInBundles("P1")).phase).toBe(true);
    expect(await recoverPendingDeletes(cwd).then((r) => r.completed)).toEqual([]); // no pending state
    void before;
  });

  it("PRE-COMMIT: an old event_pack bundle that goes stale before the commit → NO journal written", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await pairBytes(id));
    await bundlePairs(["P1", "P2"], bytesById);

    await expect(
      deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }], {
        beforeIntentWritten: async () => {
          for (const f of await listBundleNames()) {
            if (f.startsWith("event_pack-") && (await readFile(join(archiveBundlesDir(cwd), f), "utf8")).includes('"P1"')) {
              await writeFile(join(archiveBundlesDir(cwd), f), (await readFile(join(archiveBundlesDir(cwd), f), "utf8")) + " ", "utf8");
            }
          }
        },
      }),
    ).rejects.toBeInstanceOf(BundlePairNotCommittableError);
    expect((await readDeleteIntent(cwd)).kind).toBe("absent");
  });

  it("PRE-COMMIT: a survivor reduced bundle deleted before the commit → NO journal written", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await pairBytes(id));
    await bundlePairs(["P1", "P2"], bytesById);

    await expect(
      deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }], {
        beforeIntentWritten: async () => {
          // Delete the just-written survivor reduced bundles (the ones NOT holding P1).
          for (const f of await listBundleNames()) {
            if (!(await readFile(join(archiveBundlesDir(cwd), f), "utf8")).includes('"P1"')) await rm(join(archiveBundlesDir(cwd), f));
          }
        },
      }),
    ).rejects.toBeInstanceOf(BundlePairNotCommittableError);
    expect((await readDeleteIntent(cwd)).kind).toBe("absent");
  });

  it("an `unsupported` directory-fsync platform DEFERS every pair (no write, no retire)", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    bytesById.set("P1", await pairBytes("P1"));
    await bundlePairs(["P1"], bytesById);
    const before = await listBundleNames();
    __setDeleteIntentDirFsyncForTests((_d, purpose) => {
      if (purpose === "bundle_removal_preflight") throw new DeleteIntentDurabilityError("unsupported", "injected");
    });
    const out = await deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }]);
    expect(out.removed).toEqual([]);
    expect(out.skipped).toEqual([{ phase_id: "P1", reason: "unsupported_platform" }]);
    expect(await listBundleNames()).toEqual(before); // untouched
  });
});

describe("deleteBundlePairsJournaled — reader-awareness in the pending window", () => {
  it("a pending bundle-pair member reads as ABSENT from the bundle (the old bundle still holds it)", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await pairBytes(id));
    await bundlePairs(["P1", "P2"], bytesById);

    let observed: { phase: string; pack: string } | null = null;
    await expect(
      deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }], {
        afterIntentWritten: async () => {
          // The journal is committed but the OLD bundles still physically hold P1. A journal-aware
          // reader must treat the pending bundle member as ABSENT (pure-bundle → no copy resolves).
          const phase = await resolvePhaseSnapshotRaw(cwd, "P1");
          const pack = await resolveEventPackRaw(cwd, "P1");
          observed = { phase: phase.kind, pack: pack.kind };
          throw new Error("stop"); // leave the window open for the assertion
        },
      }),
    ).rejects.toThrow("stop");
    expect(observed).toEqual({ phase: "absent", pack: "absent" });
    // P2 (not pending) still resolves from the bundle. (The phase resolver reports a present
    // record as `valid`; the pack resolver reports it as `present` — distinct existing vocabularies.)
    expect((await resolvePhaseSnapshotRaw(cwd, "P2")).kind).toBe("valid");
    await recoverPendingDeletes(cwd); // heal
  });

  it("a pending `both` member keeps its LOOSE copy resolvable (reader-awareness hides only the bundle side)", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await pairBytes(id));
    await bundlePairs(["P1", "P2"], bytesById);
    await writeFile(phaseSnapshotPath(cwd, "P1"), bytesById.get("P1")!.snap, "utf8");
    await writeFile(eventPackPath(cwd, "P1"), bytesById.get("P1")!.pack, "utf8");

    let observed: { phase: string; pack: string } | null = null;
    await expect(
      deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }], {
        afterIntentWritten: async () => {
          const phase = await resolvePhaseSnapshotRaw(cwd, "P1");
          const pack = await resolveEventPackRaw(cwd, "P1");
          observed = { phase: phase.kind, pack: pack.kind };
          throw new Error("stop");
        },
      }),
    ).rejects.toThrow("stop");
    expect(observed).toEqual({ phase: "valid", pack: "present" }); // loose copy resolves despite the pending bundle removal
    await recoverPendingDeletes(cwd); // heal
  });

  it("readDeleteIntent rejects a writer-impossible bundle_pair (removed_ids != [phase_id]) as corrupt", async () => {
    await mkdir(archiveBundlesDir(cwd), { recursive: true });
    const j = (members: unknown): string =>
      JSON.stringify({ schema_version: 2, intents: [{ intent_kind: "bundle_pair", phase_id: "P1", members }] }, null, 2) + "\n";
    const ok = { removed_ids: ["P1"], old_bundles: [{ file: "phase_snapshot-0123456789abcdef.json", sha256: sha256Hex("a") }], new_bundle: null };
    const okPack = { removed_ids: ["P1"], old_bundles: [{ file: "event_pack-0123456789abcdef.json", sha256: sha256Hex("b") }], new_bundle: null };
    // removed_ids names a DIFFERENT id than the pair's phase_id → corrupt (a writer never emits this).
    await writeFile(join(cwd, ".code-pact", "state", "archive", "delete-intent.json"), j({ phase_snapshot: { ...ok, removed_ids: ["PX"] }, event_pack: okPack }), "utf8");
    expect((await readDeleteIntent(cwd)).kind).toBe("corrupt");
  });

  it("readDeleteIntent rejects a bundle_pair whose file names another kind's bundle as corrupt", async () => {
    await mkdir(archiveBundlesDir(cwd), { recursive: true });
    const phaseMember = { removed_ids: ["P1"], old_bundles: [{ file: "event_pack-0123456789abcdef.json", sha256: sha256Hex("a") }], new_bundle: null }; // wrong-kind prefix
    const packMember = { removed_ids: ["P1"], old_bundles: [{ file: "event_pack-0123456789abcdef.json", sha256: sha256Hex("b") }], new_bundle: null };
    const raw = JSON.stringify({ schema_version: 2, intents: [{ intent_kind: "bundle_pair", phase_id: "P1", members: { phase_snapshot: phaseMember, event_pack: packMember } }] }, null, 2) + "\n";
    await writeFile(join(cwd, ".code-pact", "state", "archive", "delete-intent.json"), raw, "utf8");
    expect((await readDeleteIntent(cwd)).kind).toBe("corrupt");
  });

  it("compaction must NOT fold a pending `both` member's loose copy (enumerateLooseMembers excludes it)", async () => {
    const bytesById = new Map<string, { snap: string; pack: string }>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await pairBytes(id));
    await bundlePairs(["P1", "P2"], bytesById);
    await writeFile(phaseSnapshotPath(cwd, "P1"), bytesById.get("P1")!.snap, "utf8");
    await writeFile(eventPackPath(cwd, "P1"), bytesById.get("P1")!.pack, "utf8");

    let looseDuringWindow: { phase: string[]; pack: string[] } | null = null;
    await expect(
      deleteBundlePairsJournaled(cwd, [{ phase_id: "P1" }], {
        afterIntentWritten: async () => {
          // The pending bundle-pair journal is committed; the OLD bundles still hold P1. Compaction's
          // loose enumeration must NOT fold P1's surviving loose copy into a new bundle (it would
          // resurrect the member + rewrite the bundle the journal's retire-gate re-reads by digest).
          looseDuringWindow = {
            phase: (await enumerateLooseMembers(cwd, "phase_snapshot")).map((m) => m.id),
            pack: (await enumerateLooseMembers(cwd, "event_pack")).map((m) => m.id),
          };
          throw new Error("stop");
        },
      }),
    ).rejects.toThrow("stop");
    expect(looseDuringWindow).toEqual({ phase: [], pack: [] }); // P1 excluded — not enumerated for folding
    await recoverPendingDeletes(cwd); // heal
  });
});
