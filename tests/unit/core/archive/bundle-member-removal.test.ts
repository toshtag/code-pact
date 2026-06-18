import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import { writeArchiveBundle } from "../../../../src/core/archive/archive-bundle-writer.ts";
import { computeMemberIdsSha256 } from "../../../../src/core/archive/archive-bundle-reader.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";
import { phaseSnapshotPath, archiveBundlePath, archiveBundlesDir, sha256Hex } from "../../../../src/core/archive/paths.ts";
import { planBundleMemberRemoval, removeBundleMembers } from "../../../../src/core/archive/bundle-member-removal.ts";
import {
  __setDeleteIntentDirFsyncForTests,
  __setDeleteIntentFileFsyncForTests,
  DeleteIntentDurabilityError,
} from "../../../../src/core/archive/delete-intent-journal.ts";

// Bundle-member removal — Layer 1: the READ-ONLY planner AND the DESTRUCTIVE single-kind apply.
// A bundle is content-addressed by its member-id SET, so removal = rebuild the kind's bundle minus
// the removed members. The planner computes (read-only) the removable ids, the survivors, the new
// consolidated bundle (or empty-set verdict), and the old bundles that would be retired. The apply
// (`removeBundleMembers`) durably writes the new bundle BEFORE retiring the old ones (crash-safe
// ordering), preflights the dir-fsync capability (unsupported → defer), and reports a removed id
// only once every old bundle that held it is gone (a stale retire → `skipped`, never a false delete).

const TASK_FIELDS = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-bmr-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "phases"), { recursive: true });
});
afterEach(async () => {
  __setDeleteIntentDirFsyncForTests(null);
  __setDeleteIntentFileFsyncForTests(null);
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** Write a Tier-1-VALID bundle directly (bypassing the writer's per-member authority foldability),
 *  so a test can plant a MISFILED member (id "P1" whose bytes are another phase's snapshot). */
async function rawBundle(members: { id: string; bytes: string }[]): Promise<void> {
  const records = members
    .map((m) => ({ id: m.id, sha256: sha256Hex(m.bytes), bytes: m.bytes }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const bundle = {
    schema_version: 1,
    kind: "phase_snapshot",
    member_ids_sha256: computeMemberIdsSha256(records.map((r) => r.id)),
    members: records,
  };
  const file = archiveBundlePath(cwd, "phase_snapshot", bundle.member_ids_sha256);
  await mkdir(archiveBundlesDir(cwd), { recursive: true });
  await writeFile(file, JSON.stringify(bundle, null, 2) + "\n", "utf8");
}

/** Archive a done phase as a snapshot and return its canonical bytes (the loose file is removed,
 *  so the snapshot lives only where a caller puts it — here, a bundle). */
async function snapshotBytes(id: string): Promise<string> {
  await writeFile(
    join(cwd, "design", "roadmap.yaml"),
    `phases:\n  - id: ${id}\n    path: design/phases/${id}.yaml\n    weight: 1\n`,
    "utf8",
  );
  await writeFile(
    join(cwd, "design", "phases", `${id}.yaml`),
    `id: ${id}\nname: Phase ${id}\nweight: 1\nconfidence: high\nrisk: low\nstatus: done\nobjective: do ${id}\ndefinition_of_done:\n  - it works\nverification:\n  commands:\n    - "true"\ntasks:\n  - id: ${id}-T1\n    type: feature\n${TASK_FIELDS}\n    status: done\n`,
    "utf8",
  );
  await seedDurableEvents(cwd, `events:\n  - task_id: ${id}-T1\n    status: done\n    at: 2026-06-01T00:00:00.000Z\n    actor: agent\n`);
  expect((await writePhaseSnapshot(cwd, id, { now: new Date("2026-01-01T00:00:00.000Z") })).kind).toBe("written");
  const bytes = await readFile(phaseSnapshotPath(cwd, id), "utf8");
  await rm(phaseSnapshotPath(cwd, id)); // bundle-only from here
  return bytes;
}

/** Write one bundle holding `ids` as phase_snapshot members. */
async function bundlePhases(ids: string[], bytesById: Map<string, string>): Promise<void> {
  await writeArchiveBundle(cwd, "phase_snapshot", ids.map((id) => ({ id, bytes: bytesById.get(id)! })));
}

async function listBundles(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(archiveBundlesDir(cwd)).then((ns) => ns.filter((n) => n.endsWith(".json")).sort(), () => []);
}

describe("planBundleMemberRemoval — read-only removal plan", () => {
  it("removing one member: removable + survivors + a new consolidated bundle + the old bundle retired", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2", "P3"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2", "P3"], bytesById);
    const [oldBundle] = await listBundles();

    const plan = planBundleMemberRemoval(cwd, "phase_snapshot", ["P1"]);
    expect(plan.removable).toEqual(["P1"]);
    expect(plan.not_member).toEqual([]);
    expect(plan.survivors).toEqual(["P2", "P3"]);
    expect(plan.new_bundle).not.toBeNull();
    expect(plan.new_bundle!.file).toMatch(/^phase_snapshot-[0-9a-f]{16}\.json$/);
    expect(plan.new_bundle!.file).not.toBe(oldBundle); // a different content address (smaller set)
    expect(plan.retire_bundles.map((r) => r.file)).toEqual([oldBundle]); // the old {P1,P2,P3} bundle
  });

  it("an id that is NOT a current member → not_member (no-op), nothing else changes", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2"], bytesById);
    const [theBundle] = await listBundles();

    const plan = planBundleMemberRemoval(cwd, "phase_snapshot", ["P9"]);
    expect(plan.removable).toEqual([]);
    expect(plan.not_member).toEqual(["P9"]);
    expect(plan.survivors).toEqual(["P1", "P2"]);
    // Nothing removable → a pure no-op: nothing written, nothing retired (the existing bundle stays).
    expect(plan.new_bundle).toBeNull();
    expect(plan.retire_bundles).toEqual([]);
    expect(await listBundles()).toEqual([theBundle]); // untouched
  });

  it("removing ALL members → empty-set verdict (new_bundle null) + the bundle retired (to be deleted)", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2"], bytesById);
    const [theBundle] = await listBundles();

    const plan = planBundleMemberRemoval(cwd, "phase_snapshot", ["P1", "P2"]);
    expect(plan.removable).toEqual(["P1", "P2"]);
    expect(plan.survivors).toEqual([]);
    expect(plan.new_bundle).toBeNull(); // no survivors → no replacement bundle
    expect(plan.retire_bundles.map((r) => r.file)).toEqual([theBundle]);
  });

  it("MULTIPLE old bundles of the kind: removing a member consolidates the survivors, retiring all old bundles", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2", "P3", "P4"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2"], bytesById);
    await bundlePhases(["P3", "P4"], bytesById);
    const olds = await listBundles();
    expect(olds.length).toBe(2);

    const plan = planBundleMemberRemoval(cwd, "phase_snapshot", ["P1"]);
    expect(plan.removable).toEqual(["P1"]);
    expect(plan.survivors).toEqual(["P2", "P3", "P4"]);
    expect(plan.new_bundle).not.toBeNull();
    expect(plan.retire_bundles.map((r) => r.file)).toEqual(olds); // both old bundles superseded
  });

  it("when a bundle already sits at addr(survivors), it is the KEEP — only the bundle holding the removed member is retired", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2", "P3"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P2", "P3"], bytesById); // the survivor set already exists as a bundle
    await bundlePhases(["P1"], bytesById); // and P1 lives in its own bundle

    const plan = planBundleMemberRemoval(cwd, "phase_snapshot", ["P1"]);
    expect(plan.removable).toEqual(["P1"]);
    expect(plan.survivors).toEqual(["P2", "P3"]);
    // The new bundle's address already exists (the {P2,P3} bundle) → it is the keep, not retired;
    // only the {P1} bundle is retired.
    expect(plan.retire_bundles.map((r) => r.file)).not.toContain(plan.new_bundle!.file);
    expect(plan.retire_bundles.length).toBe(1);
    expect(await listBundles()).toContain(plan.new_bundle!.file); // the keep is an existing file
  });

  it("a corrupt bundle store throws (fail-closed) — no plan on a partial view", async () => {
    await mkdir(archiveBundlesDir(cwd), { recursive: true });
    await writeFile(join(archiveBundlesDir(cwd), "phase_snapshot-deadbeefdeadbeef.json"), "{ not a bundle", "utf8");
    expect(() => planBundleMemberRemoval(cwd, "phase_snapshot", ["P1"])).toThrow();
  });

  it("an authority-INVALID current member (misfiled: id P1, body phase_id PX) → unsafe, kind fail-closed", async () => {
    const pxBytes = await snapshotBytes("PX"); // a valid PX snapshot...
    const p2Bytes = await snapshotBytes("P2");
    await rawBundle([{ id: "P1", bytes: pxBytes }, { id: "P2", bytes: p2Bytes }]); // ...filed under member id "P1"

    const plan = planBundleMemberRemoval(cwd, "phase_snapshot", ["P1"]);
    expect(plan.unsafe).toBe(true);
    expect(plan.invalid).toEqual(["P1"]); // the misfiled member is authority-invalid
    expect(plan.removable).toEqual([]); // never treats a Tier-1-present member as removable truth
    expect(plan.new_bundle).toBeNull();
    expect(plan.retire_bundles).toEqual([]);
  });
});

describe("removeBundleMembers — destructive single-kind apply", () => {
  it("removes a bundle-only member: writes the consolidated new bundle, retires the old, reports deleted", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2", "P3"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2", "P3"], bytesById);

    const out = await removeBundleMembers(cwd, "phase_snapshot", ["P1"]);
    expect(out.removed).toEqual([{ id: "P1", outcome: "deleted" }]); // no loose copy → fully deleted
    expect(out.unsafe_invalid).toEqual([]);
    expect(out.skipped_stale).toEqual([]);
    // The store now holds ONE bundle = the {P2,P3} consolidation; P1 is gone everywhere.
    expect((await listBundles()).length).toBe(1);
    const after = planBundleMemberRemoval(cwd, "phase_snapshot", []);
    expect(after.survivors).toEqual(["P2", "P3"]);
  });

  it("a `both` member (also loose) → bundle_member_removed (NOT deleted — the loose copy still resolves)", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2"], bytesById);
    await writeFile(phaseSnapshotPath(cwd, "P1"), bytesById.get("P1")!, "utf8"); // P1 is now BOTH (loose + bundle)

    const out = await removeBundleMembers(cwd, "phase_snapshot", ["P1"]);
    expect(out.removed).toEqual([{ id: "P1", outcome: "bundle_member_removed" }]);
    expect(await readFile(phaseSnapshotPath(cwd, "P1"), "utf8")).toBe(bytesById.get("P1")); // loose half survives
  });

  it("removing ALL members → the bundle is deleted, no replacement written", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2"], bytesById);

    const out = await removeBundleMembers(cwd, "phase_snapshot", ["P1", "P2"]);
    expect(out.removed.map((r) => r.id).sort()).toEqual(["P1", "P2"]);
    expect(await listBundles()).toEqual([]); // empty-set → bundle deleted
  });

  it("an authority-invalid kind is left UNTOUCHED (unsafe_invalid), no bundle written or retired", async () => {
    const pxBytes = await snapshotBytes("PX");
    const p2Bytes = await snapshotBytes("P2");
    await rawBundle([{ id: "P1", bytes: pxBytes }, { id: "P2", bytes: p2Bytes }]);
    const before = await listBundles();

    const out = await removeBundleMembers(cwd, "phase_snapshot", ["P1"]);
    expect(out.removed).toEqual([]);
    expect(out.unsafe_invalid).toEqual(["P1"]);
    expect(await listBundles()).toEqual(before); // untouched
  });

  it("a retire bundle SWAPPED between plan and unlink (bytes changed) → skipped_stale, NOT retired", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2", "P3"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2", "P3"], bytesById);

    const out = await removeBundleMembers(cwd, "phase_snapshot", ["P1"], {
      beforeRetire: async (file) => {
        // After the new bundle is durably written, swap the old bundle's bytes (append a byte).
        const abs = join(archiveBundlesDir(cwd), file);
        await writeFile(abs, (await readFile(abs, "utf8")) + " ", "utf8");
      },
    });
    expect(out.skipped_stale.length).toBe(1); // the old bundle no longer matches the plan → not retired
    // ACCOUNTING (the load-bearing honesty bit): the old {P1,P2,P3} bundle wasn't retired, so P1 STILL
    // resolves from it → P1 must NOT be reported `deleted`; it is `skipped: bundle_stale`.
    expect(out.removed).toEqual([]);
    expect(out.skipped).toEqual([{ id: "P1", reason: "bundle_stale" }]);
    // CONVERGENCE: the skip leaves a consistent store (new {P2,P3} + old {P1,P2,P3}; P2/P3 dedupe by
    // identical sha256, P1 still resolves from the old bundle). A plain re-run (no swap) completes it.
    expect(() => planBundleMemberRemoval(cwd, "phase_snapshot", ["P1"])).not.toThrow();
    const again = await removeBundleMembers(cwd, "phase_snapshot", ["P1"]);
    expect(again.removed).toEqual([{ id: "P1", outcome: "deleted" }]);
    expect(again.skipped).toEqual([]);
    expect((await listBundles()).length).toBe(1); // converged to the {P2,P3} consolidation only
  });

  it("a STALE retire target that does NOT hold the removed id → that id is still removed (precise accounting)", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2", "P3", "P4"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2"], bytesById); // P1 lives here
    await bundlePhases(["P3", "P4"], bytesById); // P3/P4 here — both bundles are superseded by {P2,P3,P4}

    const out = await removeBundleMembers(cwd, "phase_snapshot", ["P1"], {
      beforeRetire: async (file) => {
        // Swap ONLY the {P3,P4} bundle (it does not hold P1) — the {P1,P2} bundle retires cleanly.
        const abs = join(archiveBundlesDir(cwd), file);
        const content = await readFile(abs, "utf8");
        if (content.includes('"id": "P3"')) await writeFile(abs, content + " ", "utf8");
      },
    });
    expect(out.skipped_stale.length).toBe(1); // the {P3,P4} bundle was not retired
    expect(out.removed).toEqual([{ id: "P1", outcome: "deleted" }]); // its OWN bundle {P1,P2} retired → P1 gone
    expect(out.skipped).toEqual([]); // a stale bundle not holding P1 does not block P1's removal
  });

  it("a byte-identical KEEP already on disk still re-confirms the dir-fsync barrier before any retire", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2", "P3"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2", "P3"], bytesById);
    await bundlePhases(["P2", "P3"], bytesById); // the survivor set ALREADY exists byte-identically (the keep)
    const before = await listBundles();
    // Inject a bundle_write barrier failure: the idempotent keep path MUST go through it, so the
    // op fails closed and the old {P1,P2,P3} bundle is NOT retired (a non-durable keep must never
    // let a durable old-bundle unlink proceed).
    __setDeleteIntentDirFsyncForTests((_d, purpose) => {
      if (purpose === "bundle_write") throw new DeleteIntentDurabilityError("failed", "injected");
    });
    await expect(removeBundleMembers(cwd, "phase_snapshot", ["P1"])).rejects.toBeInstanceOf(DeleteIntentDurabilityError);
    expect(await listBundles()).toEqual(before); // nothing retired — the {P1,P2,P3} bundle survives
  });

  it("a byte-identical KEEP already on disk must fsync the keep's FILE DATA before any retire", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2", "P3"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2", "P3"], bytesById);
    await bundlePhases(["P2", "P3"], bytesById); // the survivor set already exists byte-identically (the keep)
    const before = await listBundles();
    // Inject a FILE-data fsync failure (distinct from the directory barrier): adopting a pre-existing
    // keep as the survivor authority must prove its DATA is durable, else a non-durable keep could let
    // a durable old-bundle unlink proceed → survivor truth loss. So the op must fail closed, nothing retired.
    __setDeleteIntentFileFsyncForTests((purpose) => {
      if (purpose === "bundle_write") throw new DeleteIntentDurabilityError("failed", "injected file fsync");
    });
    await expect(removeBundleMembers(cwd, "phase_snapshot", ["P1"])).rejects.toBeInstanceOf(DeleteIntentDurabilityError);
    expect(await listBundles()).toEqual(before); // nothing retired — the {P1,P2,P3} bundle survives
  });

  it("if the survivor bundle vanishes between the durable write and the retire → old bundle NOT retired, nothing removed", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2", "P3"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2", "P3"], bytesById);
    const oldBundle = (await listBundles())[0];

    // After the new {P2,P3} survivor bundle is durably written, delete it just before the old retire.
    // Retiring the old {P1,P2,P3} now would also lose P2/P3 → the op must refuse (re-derive survivor
    // authority from disk before destroying old authority).
    await expect(
      removeBundleMembers(cwd, "phase_snapshot", ["P1"], {
        beforeRetire: async () => {
          for (const f of await listBundles()) {
            if (f !== oldBundle) await rm(join(archiveBundlesDir(cwd), f)); // remove the survivor bundle
          }
        },
      }),
    ).rejects.toThrow(/survivor bundle .* vanished/);
    expect(await listBundles()).toContain(oldBundle); // the old {P1,P2,P3} bundle is NOT retired
  });

  it("if the survivor bundle is CORRUPTED between the durable write and the retire → old bundle NOT retired", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2", "P3"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2", "P3"], bytesById);
    const oldBundle = (await listBundles())[0];

    await expect(
      removeBundleMembers(cwd, "phase_snapshot", ["P1"], {
        beforeRetire: async () => {
          for (const f of await listBundles()) {
            if (f !== oldBundle) await writeFile(join(archiveBundlesDir(cwd), f), "{ corrupted", "utf8"); // corrupt the survivor bundle
          }
        },
      }),
    ).rejects.toThrow(/survivor bundle/);
    expect(await listBundles()).toContain(oldBundle); // the old {P1,P2,P3} bundle is NOT retired
  });

  it("an `unsupported` directory-fsync platform DEFERS the whole kind — no unlink, nothing reported removed", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2"], bytesById);
    const before = await listBundles();
    // The preflight barrier reports the platform cannot fsync a directory → an honest defer.
    __setDeleteIntentDirFsyncForTests((_d, purpose) => {
      if (purpose === "bundle_removal_preflight") throw new DeleteIntentDurabilityError("unsupported", "injected");
    });
    const out = await removeBundleMembers(cwd, "phase_snapshot", ["P1"]);
    expect(out.removed).toEqual([]); // NO destructive action — nothing claimed removed
    expect(out.skipped).toEqual([{ id: "P1", reason: "unsupported_platform" }]);
    expect(await listBundles()).toEqual(before); // the old bundle is untouched (no unlink)
  });

  it("a durability barrier failure (new-bundle dir fsync) fails closed — no retire", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2", "P3"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2", "P3"], bytesById);
    const before = await listBundles();
    __setDeleteIntentDirFsyncForTests((_d, purpose) => {
      if (purpose === "bundle_write") throw new DeleteIntentDurabilityError("failed", "injected");
    });
    await expect(removeBundleMembers(cwd, "phase_snapshot", ["P1"])).rejects.toBeInstanceOf(DeleteIntentDurabilityError);
    // The barrier threw before any retire → the old bundle is NOT retired (still present).
    expect(await listBundles()).toEqual(expect.arrayContaining(before));
  });

  it("the RETIRE-phase dir-fsync barrier is REQUIRED too — a failure there fails closed (no silent non-durable retire)", async () => {
    const bytesById = new Map<string, string>();
    for (const id of ["P1", "P2"]) bytesById.set(id, await snapshotBytes(id));
    await bundlePhases(["P1", "P2"], bytesById);
    // Remove ALL members: new_bundle is null, so there is NO bundle_write barrier — the only
    // durability barrier is the post-retire `bundle_retire` dir-fsync. It must be fail-closed.
    __setDeleteIntentDirFsyncForTests((_d, purpose) => {
      if (purpose === "bundle_retire") throw new DeleteIntentDurabilityError("failed", "injected");
    });
    await expect(removeBundleMembers(cwd, "phase_snapshot", ["P1", "P2"])).rejects.toBeInstanceOf(DeleteIntentDurabilityError);
  });
});
