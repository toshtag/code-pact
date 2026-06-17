import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import { writeArchiveBundle } from "../../../../src/core/archive/archive-bundle-writer.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";
import { phaseSnapshotPath, archiveBundlesDir } from "../../../../src/core/archive/paths.ts";
import { planBundleMemberRemoval } from "../../../../src/core/archive/bundle-member-removal.ts";

// Bundle-member removal — Layer 1a: the READ-ONLY planner. A bundle is content-addressed
// by its member-id SET, so removal = rebuild the kind's bundle minus the removed members.
// The planner computes (read-only) the removable ids, the survivors, the new consolidated
// bundle (or empty-set verdict), and the old bundles that would be retired. It mutates nothing.

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
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

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
    expect(plan.retire_bundles).toEqual([oldBundle]); // the old {P1,P2,P3} bundle is superseded
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
    expect(plan.retire_bundles).toEqual([theBundle]);
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
    expect(plan.retire_bundles).toEqual(olds); // both old bundles superseded by the consolidated one
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
    expect(plan.retire_bundles).not.toContain(plan.new_bundle!.file);
    expect(plan.retire_bundles.length).toBe(1);
    expect(await listBundles()).toContain(plan.new_bundle!.file); // the keep is an existing file
  });

  it("a corrupt bundle store throws (fail-closed) — no plan on a partial view", async () => {
    await mkdir(archiveBundlesDir(cwd), { recursive: true });
    await writeFile(join(archiveBundlesDir(cwd), "phase_snapshot-deadbeefdeadbeef.json"), "{ not a bundle", "utf8");
    expect(() => planBundleMemberRemoval(cwd, "phase_snapshot", ["P1"])).toThrow();
  });
});
