import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import {
  compactArchive,
  deleteLooseCoveredByBundle,
  planCompactArchive,
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

  it("idempotent: a second run finds nothing loose (no redundant bundle, no deletes)", async () => {
    await scaffold();
    await compactArchive(cwd, "phase_snapshot");
    const bundlesAfter1 = loadArchiveBundles(cwd).bundles.length;
    const out2 = await compactArchive(cwd, "phase_snapshot");
    expect(out2.bundle.kind).toBe("noop_no_members"); // nothing new to bundle
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

  it("redundant-bundle-safe: a later new loose record bundles ONLY itself", async () => {
    await scaffold(true); // P1 + P2 loose
    // First, compact only P1 by pre-deleting P2's loose so the first run sees just P1.
    const p2bytes = await readFile(phaseSnapshotPath(cwd, "P2"), "utf8");
    await rm(phaseSnapshotPath(cwd, "P2"));
    await compactArchive(cwd, "phase_snapshot"); // bundles {P1}, deletes P1
    // Now restore P2 as a new loose record and compact again.
    await writeFile(phaseSnapshotPath(cwd, "P2"), p2bytes, "utf8");
    const out = await compactArchive(cwd, "phase_snapshot");
    expect(out.bundle.kind).toBe("written");
    if (out.bundle.kind === "written") expect(out.bundle.member_count).toBe(1); // ONLY P2, not P1 again
    expect(out.delete.deleted).toEqual(["P2"]);
    // Both phases resolve from bundles; no loose remain.
    const idx = loadArchiveBundles(cwd).index.get("phase_snapshot")!;
    expect(idx.has("P1")).toBe(true);
    expect(idx.has("P2")).toBe(true);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    expect(await exists(phaseSnapshotPath(cwd, "P2"))).toBe(false);
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

  it("loose differs from a same-id bundle member → would_skip(bundle_stale), not would_delete", async () => {
    const bytes = await scaffold(); // loose P1 stays on disk
    const differing = bytes.replace(
      sha256Hex("design/phases/P1-x.yaml"),
      sha256Hex("design/phases/elsewhere.yaml"),
    );
    await writePhaseSnapshotBundle("snap.json", [{ id: "P1", bytes: differing }]);
    const plan = await planCompactArchive(cwd, "phase_snapshot");
    expect(plan.would_delete).toEqual([]); // the dry-run must NOT promise a delete the gate skips
    expect(plan.would_skip.map((s) => s.reason)).toContain("bundle_stale");
  });
});
