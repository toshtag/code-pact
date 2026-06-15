import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import {
  compactArchive,
  deleteLooseCoveredByBundle,
  planCompactArchive,
  retireSupersededBundles,
} from "../../../../src/core/archive/archive-bundle-cleanup.ts";
import { writeArchiveBundle } from "../../../../src/core/archive/archive-bundle-writer.ts";
import { planEventPack } from "../../../../src/core/archive/event-pack.ts";
import { loadArchiveBundles } from "../../../../src/core/archive/archive-bundle-loader.ts";
import { resolveMissingPhaseRef } from "../../../../src/core/archive/load-phase-snapshot.ts";
import {
  archiveBundlesDir,
  phaseSnapshotPath,
  sha256Hex,
} from "../../../../src/core/archive/paths.ts";
import { computeMemberIdsSha256 } from "../../../../src/core/archive/archive-bundle-reader.ts";
import { ARCHIVE_BUNDLE_SCHEMA_VERSION } from "../../../../src/core/schemas/archive-bundle.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";

// Layer 3: the gated delete. Removes a loose record once a verified bundle holds it
// byte-identically — re-checked per record at delete time. compactArchive folds then
// drops in one redundant-bundle-safe pass (the actual file-count reduction).

const NOW = new Date("2026-06-10T00:00:00.000Z");
const TASK_FIELDS = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;
const ROADMAP1 = `phases:
  - id: P1
    path: design/phases/P1-x.yaml
    weight: 2
`;
const ROADMAP2 = `phases:
  - id: P1
    path: design/phases/P1-x.yaml
    weight: 2
  - id: P2
    path: design/phases/P2-y.yaml
    weight: 1
`;
const phaseYaml = (id: string) => `id: ${id}
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
    - pnpm test
tasks:
  - id: ${id}-T1
    type: feature
${TASK_FIELDS}
    status: done
`;
const EVENTS2 = `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
  - task_id: P2-T1
    status: done
    at: 2026-06-02T00:00:00.000Z
    actor: agent
`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-bundle-cleanup-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "phases"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** Scaffold P1 (+ optionally P2) done with snapshots; return P1's canonical bytes. */
async function scaffold(twoPhases = false): Promise<string> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), twoPhases ? ROADMAP2 : ROADMAP1, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), phaseYaml("P1"), "utf8");
  if (twoPhases) await writeFile(join(cwd, "design", "phases", "P2-y.yaml"), phaseYaml("P2"), "utf8");
  await seedDurableEvents(cwd, EVENTS2);
  expect((await writePhaseSnapshot(cwd, "P1", { now: NOW })).kind).toBe("written");
  if (twoPhases) expect((await writePhaseSnapshot(cwd, "P2", { now: NOW })).kind).toBe("written");
  return readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

async function writePhaseSnapshotBundle(name: string, members: { id: string; bytes: string }[]): Promise<void> {
  const dir = archiveBundlesDir(cwd);
  await mkdir(dir, { recursive: true });
  const full = members
    .map((m) => ({ id: m.id, sha256: sha256Hex(m.bytes), bytes: m.bytes }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  await writeFile(
    join(dir, name),
    JSON.stringify({
      schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
      kind: "phase_snapshot",
      member_ids_sha256: computeMemberIdsSha256(full.map((m) => m.id)),
      members: full,
    }),
    "utf8",
  );
}

describe("deleteLooseCoveredByBundle", () => {
  it("deletes a loose record a verified bundle holds; the reader still resolves it", async () => {
    const bytes = await scaffold();
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes }]);
    const out = await deleteLooseCoveredByBundle(cwd, "phase_snapshot");
    expect(out.deleted).toEqual(["P1"]);
    expect(out.remaining_loose).toBe(0);
    expect(out.partial_applied).toBe(true);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false); // loose gone
    // The bundle still resolves the phase (live-wins is moot; loose absent → bundle).
    const res = await resolveMissingPhaseRef(cwd, { id: "P1", path: "design/phases/P1-x.yaml" });
    expect(res.kind).toBe("tolerated");
  });

  it("a loose record NOT in any bundle → skip(not_in_bundle), never deleted", async () => {
    await scaffold(); // loose P1, no bundle
    const out = await deleteLooseCoveredByBundle(cwd, "phase_snapshot");
    expect(out.deleted).toEqual([]);
    expect(out.skipped).toEqual([{ id: "P1", reason: "not_in_bundle", detail: undefined }]);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true); // kept
  });

  it("loose ≠ bundle member bytes (same id) → skip(bundle_stale), never deleted", async () => {
    const bytes = await scaffold();
    // A canonical, valid P1 snapshot whose bytes DIFFER from the loose one (tamper the
    // path_sha256 value: schema-valid, phase_id P1, so bind passes; reconcile rejects).
    const tampered = bytes.replace(
      sha256Hex("design/phases/P1-x.yaml"),
      sha256Hex("design/phases/elsewhere.yaml"),
    );
    expect(tampered).not.toBe(bytes);
    await writePhaseSnapshotBundle("snap.json", [{ id: "P1", bytes: tampered }]);
    const out = await deleteLooseCoveredByBundle(cwd, "phase_snapshot");
    expect(out.deleted).toEqual([]);
    expect(out.skipped[0]?.reason).toBe("bundle_stale");
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true); // kept (fail-closed)
  });

  it("gate-time vanish (file removed before its gate) → vanished, not deleted", async () => {
    const bytes = await scaffold();
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes }]);
    const out = await deleteLooseCoveredByBundle(cwd, "phase_snapshot", {
      beforeGate: async (id) => {
        if (id === "P1") await rm(phaseSnapshotPath(cwd, "P1"));
      },
    });
    expect(out.deleted).toEqual([]);
    expect(out.vanished).toEqual(["P1"]);
  });

  it("unlink-time vanish (file removed in the gate→unlink window) → vanished, not a survivor", async () => {
    const bytes = await scaffold();
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes }]);
    const out = await deleteLooseCoveredByBundle(cwd, "phase_snapshot", {
      beforeUnlink: async (id) => {
        if (id === "P1") await rm(phaseSnapshotPath(cwd, "P1"));
      },
    });
    expect(out.deleted).toEqual([]);
    expect(out.vanished).toEqual(["P1"]);
    expect(out.partial_applied).toBe(false);
  });

  it("a Tier-1-corrupt bundle store → throws before any unlink (fail-closed)", async () => {
    await scaffold();
    await mkdir(archiveBundlesDir(cwd), { recursive: true });
    await writeFile(join(archiveBundlesDir(cwd), "bad.json"), "{ not json", "utf8");
    await expect(deleteLooseCoveredByBundle(cwd, "phase_snapshot")).rejects.toThrow();
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true); // nothing deleted
  });
});

describe("compactArchive — fold + drop (file-count reduction)", () => {
  it("bundles a loose record then deletes it; truth resolves from the bundle", async () => {
    await scaffold();
    const out = await compactArchive(cwd, "phase_snapshot");
    expect(out.bundle.kind).toBe("written");
    expect(out.delete.deleted).toEqual(["P1"]);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    expect(loadArchiveBundles(cwd).index.get("phase_snapshot")?.get("P1")).toBeTruthy();
  });

  it("idempotent: a second run is a converged noop (consolidated bundle already exists)", async () => {
    await scaffold();
    await compactArchive(cwd, "phase_snapshot");
    const bundlesAfter1 = loadArchiveBundles(cwd).bundles.length;
    const out2 = await compactArchive(cwd, "phase_snapshot");
    expect(out2.bundle.kind).toBe("noop_already_bundled"); // the consolidated bundle is already there
    expect(out2.retired_bundles).toEqual([]);
    expect(out2.delete.deleted).toEqual([]);
    expect(loadArchiveBundles(cwd).bundles.length).toBe(bundlesAfter1); // no duplicate bundle
  });

  it("SAFETY: deleting a loose snapshot does NOT strand event-pack compaction (resolves from the bundle)", async () => {
    // The crux of the Layer-3 prerequisite: planEventPack resolves the snapshot from
    // loose ∪ bundle, so its verdict is IDENTICAL whether the snapshot is a loose file
    // or only in a bundle — never a spurious snapshot_missing once the loose is gone.
    const bytes = await scaffold();
    await writePhaseSnapshotBundle("snap.json", [{ id: "P1", bytes }]);
    // ARCHIVE P1 so planEventPack actually reaches the snapshot read (a live phase
    // YAML would short-circuit to ineligible BEFORE the snapshot, making this vacuous).
    await rm(join(cwd, "design", "phases", "P1-x.yaml"));
    await writeFile(join(cwd, "design", "roadmap.yaml"), "phases: []\n", "utf8");
    const planLoose = await planEventPack(cwd, "P1"); // loose snapshot still present
    expect(planLoose.kind).toBe("write"); // P1-T1 loose events are unpacked → a real plan
    await deleteLooseCoveredByBundle(cwd, "phase_snapshot"); // loose snapshot gone, bundled
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    const planBundle = await planEventPack(cwd, "P1"); // resolves the snapshot from the bundle
    expect(planBundle.kind).toBe("write"); // identical verdict — snapshot resolved from bundle
  });

  it("CONVERGES: a later new loose record consolidates with the existing bundle (one bundle, both members)", async () => {
    await scaffold(true); // P1 + P2 loose
    // First, compact only P1 by pre-deleting P2's loose so the first run sees just P1.
    const p2bytes = await readFile(phaseSnapshotPath(cwd, "P2"), "utf8");
    await rm(phaseSnapshotPath(cwd, "P2"));
    await compactArchive(cwd, "phase_snapshot"); // bundle {P1}, delete loose P1
    expect(loadArchiveBundles(cwd).bundles.length).toBe(1);
    // Now restore P2 as a new loose record and compact again → CONSOLIDATE into one bundle.
    await writeFile(phaseSnapshotPath(cwd, "P2"), p2bytes, "utf8");
    const out = await compactArchive(cwd, "phase_snapshot");
    expect(out.bundle.kind).toBe("written");
    if (out.bundle.kind === "written") expect(out.bundle.member_count).toBe(2); // P1 + P2 consolidated
    expect(out.retired_bundles.length).toBe(1); // the old {P1} bundle is retired
    expect(out.delete.deleted).toEqual(["P2"]);
    // Exactly ONE bundle now holds both phases; no loose remain; the count did NOT grow.
    expect(loadArchiveBundles(cwd).bundles.length).toBe(1);
    const idx = loadArchiveBundles(cwd).index.get("phase_snapshot")!;
    expect(idx.has("P1")).toBe(true);
    expect(idx.has("P2")).toBe(true);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    expect(await exists(phaseSnapshotPath(cwd, "P2"))).toBe(false);
  });
});

describe("compactArchive — bundle CONSOLIDATION (the bound: bundle count converges to 1/kind)", () => {
  it("two separate bundles → consolidated into ONE; both old bundles retired; no truth lost", async () => {
    await scaffold(true); // P1 + P2 snapshots on disk
    const p1 = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    const p2 = await readFile(phaseSnapshotPath(cwd, "P2"), "utf8");
    // Two pre-existing bundles (as if from two prior compaction runs); loose removed.
    await writePhaseSnapshotBundle("a.json", [{ id: "P1", bytes: p1 }]);
    await writePhaseSnapshotBundle("b.json", [{ id: "P2", bytes: p2 }]);
    await rm(phaseSnapshotPath(cwd, "P1"));
    await rm(phaseSnapshotPath(cwd, "P2"));
    expect(loadArchiveBundles(cwd).bundles.length).toBe(2);

    const out = await compactArchive(cwd, "phase_snapshot");
    expect(out.bundle.kind).toBe("written"); // a new consolidated bundle {P1,P2}
    if (out.bundle.kind === "written") expect(out.bundle.member_count).toBe(2);
    expect(out.retired_bundles.sort()).toEqual(["bundles/a.json", "bundles/b.json"]);
    // Converged: exactly ONE bundle holds both; both phases still resolve.
    const after = loadArchiveBundles(cwd);
    expect(after.bundles.length).toBe(1);
    expect(after.index.get("phase_snapshot")!.has("P1")).toBe(true);
    expect(after.index.get("phase_snapshot")!.has("P2")).toBe(true);
  });

  it("dry-run would_retire_bundles PREDICTS exactly what --write retires", async () => {
    await scaffold(true);
    const p1 = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    const p2 = await readFile(phaseSnapshotPath(cwd, "P2"), "utf8");
    await writePhaseSnapshotBundle("a.json", [{ id: "P1", bytes: p1 }]);
    await writePhaseSnapshotBundle("b.json", [{ id: "P2", bytes: p2 }]);
    await rm(phaseSnapshotPath(cwd, "P1"));
    await rm(phaseSnapshotPath(cwd, "P2"));
    const plan = await planCompactArchive(cwd, "phase_snapshot");
    expect(plan.would_retire_bundles.sort()).toEqual(["bundles/a.json", "bundles/b.json"]);
    // The write actually retires the SAME set the dry-run predicted.
    const out = await compactArchive(cwd, "phase_snapshot");
    expect(out.retired_bundles.sort()).toEqual(plan.would_retire_bundles.sort());
  });

  it("retire GATE: a VANISHED keep authority → throws, retires nothing (delete authority is on-disk)", async () => {
    await scaffold(true);
    const p1 = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    await rm(phaseSnapshotPath(cwd, "P1"));
    await writePhaseSnapshotBundle("covered.json", [{ id: "P1", bytes: p1 }]);
    // keepFile names a bundle that does NOT exist on disk → must refuse, never unlink on a
    // caller-asserted (but absent) authority. (This is the truth-loss hole the gate closes.)
    await expect(
      retireSupersededBundles(cwd, "phase_snapshot", "bundles/nonexistent.json"),
    ).rejects.toThrow();
    expect(loadArchiveBundles(cwd).index.get("phase_snapshot")!.has("P1")).toBe(true); // survives
  });

  it("retire GATE: a bundle the on-disk KEEP bundle does NOT fully cover is KEPT; a covered one is retired", async () => {
    await scaffold(true);
    const p1 = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    const p2 = await readFile(phaseSnapshotPath(cwd, "P2"), "utf8");
    await rm(phaseSnapshotPath(cwd, "P1"));
    await rm(phaseSnapshotPath(cwd, "P2"));
    await writePhaseSnapshotBundle("keep.json", [{ id: "P1", bytes: p1 }]); // the on-disk authority: covers P1 only
    await writePhaseSnapshotBundle("covered.json", [{ id: "P1", bytes: p1 }]); // covered by keep
    await writePhaseSnapshotBundle("uncovered.json", [{ id: "P2", bytes: p2 }]); // P2 NOT in keep
    const retired = await retireSupersededBundles(cwd, "phase_snapshot", "bundles/keep.json");
    expect(retired).toEqual(["bundles/covered.json"]); // only the fully-covered bundle
    expect(loadArchiveBundles(cwd).index.get("phase_snapshot")!.has("P2")).toBe(true); // uncovered survives
  });

  it("CRASH-SAFE reconverge: a leftover stale overlapping old bundle is retired on the next run", async () => {
    await scaffold(true);
    const p1 = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    // First compaction → the real consolidated {P1,P2} bundle (canonical bytes) + loose gone.
    await compactArchive(cwd, "phase_snapshot");
    expect(loadArchiveBundles(cwd).bundles.length).toBe(1);
    // Simulate a crash that left a stale old {P1} bundle behind (its P1 member is byte-
    // identical to the consolidated one — the cross-bundle uniqueness rule tolerates it).
    await writePhaseSnapshotBundle("old.json", [{ id: "P1", bytes: p1 }]);
    expect(loadArchiveBundles(cwd).bundles.length).toBe(2);

    const out = await compactArchive(cwd, "phase_snapshot");
    // The full set already exists as the consolidated bundle → noop write; the stale {P1}
    // bundle is retired (its member lives byte-identically in the consolidated one).
    expect(out.bundle.kind).toBe("noop_already_bundled");
    expect(out.retired_bundles).toEqual(["bundles/old.json"]);
    expect(loadArchiveBundles(cwd).bundles.length).toBe(1); // reconverged
  });
});

describe("planCompactArchive — read-only dry-run partition (matches compactArchive/the delete gate)", () => {
  it("loose not in any bundle → would_bundle", async () => {
    await scaffold();
    const plan = await planCompactArchive(cwd, "phase_snapshot");
    expect(plan.would_bundle).toEqual(["P1"]);
    expect(plan.would_delete).toEqual([]);
    expect(plan.would_skip).toEqual([]);
  });

  it("loose byte-identical to a verified bundle member → would_delete", async () => {
    const bytes = await scaffold();
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes }]);
    const plan = await planCompactArchive(cwd, "phase_snapshot");
    expect(plan.would_delete).toEqual(["P1"]);
    expect(plan.would_bundle).toEqual([]);
  });

  it("loose differs from a same-id bundle member (single content-addressed bundle, nothing to fold) → would_supersede, not would_delete", async () => {
    const bytes = await scaffold(); // loose P1 stays on disk — the FRESHER record
    const differing = bytes.replace(
      sha256Hex("design/phases/P1-x.yaml"),
      sha256Hex("design/phases/elsewhere.yaml"),
    );
    // A content-addressed bundle holding the STALE P1 bytes (writeArchiveBundle places it at
    // its own content address — the precondition for an in-place supersede).
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: differing }]);
    const plan = await planCompactArchive(cwd, "phase_snapshot");
    // The fresher loose adopts over the stale bundle member (supersession), not a blind delete.
    expect(plan.would_delete).toEqual([]);
    expect(plan.would_supersede).toEqual(["P1"]);
    expect(plan.would_skip).toEqual([]);
  });

  it("loose differs but the bundle is MISNAMED (not at its content address) → deferred as bundle_stale (no would_supersede)", async () => {
    const bytes = await scaffold();
    const differing = bytes.replace(
      sha256Hex("design/phases/P1-x.yaml"),
      sha256Hex("design/phases/elsewhere.yaml"),
    );
    await writePhaseSnapshotBundle("snap.json", [{ id: "P1", bytes: differing }]); // non-content-addressed
    const plan = await planCompactArchive(cwd, "phase_snapshot");
    expect(plan.would_supersede).toEqual([]);
    expect(plan.would_delete).toEqual([]);
    expect(plan.would_skip.map((s) => s.reason)).toContain("bundle_stale");
  });
});

describe("compactArchive — supersession (adopt a fresher diverging loose into the bundle)", () => {
  /** A fresh, valid, DIFFERENT P1 snapshot: rewrite the recorded source path hash (stays
   *  canonical + id-consistent, so it is foldable, but ≠ the original bytes). */
  const fresher = (v1: string): string =>
    v1.replace(sha256Hex("design/phases/P1-x.yaml"), sha256Hex("design/phases/elsewhere.yaml"));

  it("a single content-addressed bundle + a fresher diverging loose → SUPERSEDES the member, deletes the loose, store stays valid", async () => {
    const v1 = await scaffold();
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: v1 }]); // bundle holds the STALE v1
    const v2 = fresher(v1);
    await writeFile(phaseSnapshotPath(cwd, "P1"), v2, "utf8"); // refresh the loose to the fresher v2

    const out = await compactArchive(cwd, "phase_snapshot");
    expect(out.bundle.kind).toBe("superseded"); // the bundle member was replaced in place
    expect(out.delete.deleted).toContain("P1"); // the now-adopted loose is removed
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    // The store still loads and its authority for P1 is now the FRESH bytes.
    expect(() => loadArchiveBundles(cwd)).not.toThrow();
    expect(loadArchiveBundles(cwd).index.get("phase_snapshot")?.get("P1")?.bytes).toBe(v2);

    // A second run is a converged noop — the loose is gone and the bundle already holds v2.
    const again = await compactArchive(cwd, "phase_snapshot");
    expect(again.bundle.kind).toBe("noop_already_bundled");
    expect(again.delete.deleted).toEqual([]);
  });

  it("DEFER then ADOPT: a pending fold blocks supersede on run 1; run 2 (nothing left to fold) adopts it", async () => {
    const v1 = await scaffold(true); // loose P1 + loose P2 on disk
    const p2 = await readFile(phaseSnapshotPath(cwd, "P2"), "utf8");
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: v1 }]); // bundle {P1@v1}
    const v2 = fresher(v1);
    await writeFile(phaseSnapshotPath(cwd, "P1"), v2, "utf8"); // P1 loose now diverges

    // Run 1: P2 is a new fold → would_bundle non-empty → P1 supersede is DEFERRED (loose stays).
    const plan1 = await planCompactArchive(cwd, "phase_snapshot");
    expect(plan1.would_bundle).toContain("P2");
    expect(plan1.would_supersede).toEqual([]);
    expect(plan1.would_skip.map((s) => s.reason)).toContain("bundle_stale");
    const run1 = await compactArchive(cwd, "phase_snapshot");
    expect(run1.bundle.kind).not.toBe("superseded"); // consolidation, not adoption
    expect(run1.delete.deleted).toContain("P2"); // the new fold was deleted
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true); // P1 loose deferred, kept
    expect(loadArchiveBundles(cwd).index.get("phase_snapshot")?.get("P1")?.bytes).toBe(v1); // still stale

    // Run 2: P2 folded already (nothing new to fold), single content-addressed bundle → ADOPT P1.
    const plan2 = await planCompactArchive(cwd, "phase_snapshot");
    expect(plan2.would_supersede).toEqual(["P1"]);
    const run2 = await compactArchive(cwd, "phase_snapshot");
    expect(run2.bundle.kind).toBe("superseded");
    expect(run2.delete.deleted).toContain("P1");
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    const idx = loadArchiveBundles(cwd).index.get("phase_snapshot");
    expect(idx?.get("P1")?.bytes).toBe(v2); // adopted
    expect(idx?.get("P2")?.bytes).toBe(p2); // still present
  });

  it("a fresher loose whose bytes are NOT foldable is never adopted → stays a bundle_stale skip", async () => {
    const v1 = await scaffold();
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: v1 }]);
    await writeFile(phaseSnapshotPath(cwd, "P1"), v1 + "\ngarbage", "utf8"); // diverges but not foldable

    const plan = await planCompactArchive(cwd, "phase_snapshot");
    expect(plan.would_supersede).toEqual([]);
    expect(plan.would_skip.map((s) => s.reason)).toContain("bundle_stale");
    const out = await compactArchive(cwd, "phase_snapshot");
    expect(out.bundle.kind).toBe("noop_already_bundled"); // bundle untouched (no adoption)
    expect(out.delete.deleted).toEqual([]); // the unfoldable loose is NOT deleted
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true);
    expect(loadArchiveBundles(cwd).index.get("phase_snapshot")?.get("P1")?.bytes).toBe(v1); // unchanged
  });

  it("MIXED in one run: a {P1,P2} bundle with a diverging P1 loose and a byte-identical P2 loose → supersede P1, delete both loose", async () => {
    const v1 = await scaffold(true); // loose P1 + loose P2 on disk
    const p2 = await readFile(phaseSnapshotPath(cwd, "P2"), "utf8");
    // One content-addressed bundle holding the stale P1 and the (will-stay-identical) P2.
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: v1 }, { id: "P2", bytes: p2 }]);
    const v2 = v1.replace(sha256Hex("design/phases/P1-x.yaml"), sha256Hex("design/phases/elsewhere.yaml"));
    await writeFile(phaseSnapshotPath(cwd, "P1"), v2, "utf8"); // P1 loose now diverges; P2 loose stays == bundle

    const plan = await planCompactArchive(cwd, "phase_snapshot");
    expect(plan.would_supersede).toEqual(["P1"]); // P1 adopted
    expect(plan.would_delete).toEqual(["P2"]); // P2 already byte-identical → just delete

    const out = await compactArchive(cwd, "phase_snapshot");
    expect(out.bundle.kind).toBe("superseded");
    expect(out.delete.deleted.sort()).toEqual(["P1", "P2"]); // BOTH loose removed in one run
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    expect(await exists(phaseSnapshotPath(cwd, "P2"))).toBe(false);
    const idx = loadArchiveBundles(cwd).index.get("phase_snapshot");
    expect(idx?.get("P1")?.bytes).toBe(v2); // P1 adopted into the bundle
    expect(idx?.get("P2")?.bytes).toBe(p2); // P2 unchanged
  });
});
