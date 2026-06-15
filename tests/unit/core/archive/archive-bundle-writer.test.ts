import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ARCHIVE_BUNDLE_SCHEMA_VERSION } from "../../../../src/core/schemas/archive-bundle.ts";
import {
  buildArchiveBundle,
  bundleLooseRecords,
  enumerateLooseMembers,
  serializeArchiveBundle,
  supersedeArchiveBundle,
  verifyBundleReadback,
  writeArchiveBundle,
  type BundleWriteError,
} from "../../../../src/core/archive/archive-bundle-writer.ts";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import { writeDecisionRecord } from "../../../../src/core/archive/decision-record.ts";
import { loadArchiveBundles } from "../../../../src/core/archive/archive-bundle-loader.ts";
import { validateArchiveBundleTier1, computeMemberIdsSha256 } from "../../../../src/core/archive/archive-bundle-reader.ts";
import { decisionRecordStem } from "../../../../src/core/archive/archive-bundle-binding.ts";
import {
  archiveBundlePath,
  decisionRecordPath,
  phaseSnapshotPath,
  sha256Hex,
} from "../../../../src/core/archive/paths.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";

// Layer 2: the archive-bundle writer + readback. Folds loose records into a bundle
// and verifies it reads back identically — NO loose deletion (Layer 3).

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
const EVENTS = `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
`;
const DEC_REF = "design/decisions/foo-rfc.md";
const ACCEPTED_ADR = `# RFC\n\n**Status:** accepted (P9, 2026-06)\n\n## Summary\n\nSettled.\n`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-bundlewriter-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "decisions"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** Write P1 (done) + events + snapshot; return its canonical loose bytes. */
async function scaffoldP1Snapshot(): Promise<string> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await seedDurableEvents(cwd, EVENTS);
  expect((await writePhaseSnapshot(cwd, "P1", { now: NOW })).kind).toBe("written");
  return readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
}

describe("buildArchiveBundle + serializeArchiveBundle", () => {
  it("builds a Tier-1-valid bundle from a canonical member", async () => {
    const bytes = await scaffoldP1Snapshot();
    const bundle = buildArchiveBundle("phase_snapshot", [{ id: "P1", bytes }]);
    expect(bundle.kind).toBe("phase_snapshot");
    expect(bundle.members.map((m) => m.id)).toEqual(["P1"]);
    // The serialized output must pass the Tier-1 reader.
    const serialized = serializeArchiveBundle(bundle);
    expect(() => validateArchiveBundleTier1(serialized, "x.json")).not.toThrow();
  });

  it("empty member set → throws", () => {
    expect(() => buildArchiveBundle("phase_snapshot", [])).toThrow();
  });

  it("duplicate member id → throws", async () => {
    const bytes = await scaffoldP1Snapshot();
    expect(() =>
      buildArchiveBundle("phase_snapshot", [{ id: "P1", bytes }, { id: "P1", bytes }]),
    ).toThrow(/duplicate member id/);
  });

  it("non-canonical member bytes → throws (self-bind canonical check)", async () => {
    const bytes = await scaffoldP1Snapshot();
    expect(() => buildArchiveBundle("phase_snapshot", [{ id: "P1", bytes: bytes + " " }])).toThrow();
  });

  it("member id ≠ its own internal phase_id → throws (self-bind identity)", async () => {
    const bytes = await scaffoldP1Snapshot();
    expect(() => buildArchiveBundle("phase_snapshot", [{ id: "PX", bytes }])).toThrow();
  });
});

describe("writeArchiveBundle — write + readback (no delete)", () => {
  it("writes a bundle, the Layer-1 reader sees it, and the loose record remains", async () => {
    const bytes = await scaffoldP1Snapshot();
    const out = await writeArchiveBundle(cwd, "phase_snapshot", ["P1"].map((id) => ({ id, bytes })));
    expect(out.kind).toBe("written");
    if (out.kind === "written") expect(out.member_count).toBe(1);
    // Layer-1 reader resolves the bundle member.
    const { index } = loadArchiveBundles(cwd);
    expect(index.get("phase_snapshot")?.get("P1")?.bytes).toBe(bytes);
    // NO deletion: the loose record is still on disk.
    expect(await readFile(phaseSnapshotPath(cwd, "P1"), "utf8")).toBe(bytes);
  });

  it("idempotent: re-writing the same id set → noop_already_bundled", async () => {
    const bytes = await scaffoldP1Snapshot();
    expect((await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes }])).kind).toBe("written");
    expect((await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes }])).kind).toBe("noop_already_bundled");
  });

  it("empty member set → noop_no_members (a bundle needs ≥1 member)", async () => {
    expect((await writeArchiveBundle(cwd, "phase_snapshot", [])).kind).toBe("noop_no_members");
  });

  it("same id set, different bytes already at the path → fail-closed conflict", async () => {
    const bytes = await scaffoldP1Snapshot();
    // Pre-place a different file at the content-addressed path for id set {P1}.
    const path = archiveBundlePath(cwd, "phase_snapshot", computeMemberIdsSha256(["P1"]));
    await mkdir(join(cwd, ".code-pact", "state", "archive", "bundles"), { recursive: true });
    await writeFile(path, "different bytes\n", "utf8");
    await expect(writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes }])).rejects.toThrow(
      /different bundle already exists/,
    );
  });
});

describe("enumerateLooseMembers + bundleLooseRecords", () => {
  it("phase_snapshot: enumerates the loose snapshot and bundles it", async () => {
    await scaffoldP1Snapshot();
    const members = await enumerateLooseMembers(cwd, "phase_snapshot");
    expect(members.map((m) => m.id)).toEqual(["P1"]);
    const out = await bundleLooseRecords(cwd, "phase_snapshot");
    expect(out.kind).toBe("written");
    expect(loadArchiveBundles(cwd).index.get("phase_snapshot")?.has("P1")).toBe(true);
  });

  it("absent archive dir → no members → noop_no_members", async () => {
    // No event-packs were ever written.
    expect((await enumerateLooseMembers(cwd, "event_pack"))).toEqual([]);
    expect((await bundleLooseRecords(cwd, "event_pack")).kind).toBe("noop_no_members");
  });

  it("decision_record: the writer is kind-generic (bundles a real decision record)", async () => {
    await writeFile(join(cwd, DEC_REF), ACCEPTED_ADR, "utf8");
    expect((await writeDecisionRecord(cwd, DEC_REF, { now: NOW })).kind).toBe("written");
    const bytes = await readFile(decisionRecordPath(cwd, DEC_REF), "utf8");
    const stem = decisionRecordStem(DEC_REF);
    const out = await bundleLooseRecords(cwd, "decision_record");
    expect(out.kind).toBe("written");
    expect(loadArchiveBundles(cwd).index.get("decision_record")?.get(stem)?.bytes).toBe(bytes);
  });
});

const ROADMAP2 = `phases:
  - id: P1
    path: design/phases/P1-x.yaml
    weight: 2
  - id: P2
    path: design/phases/P2-y.yaml
    weight: 1
`;
const P2_DONE = `id: P2
name: Next
weight: 1
confidence: high
risk: low
status: done
objective: Do the next thing
definition_of_done:
  - it works
verification:
  commands:
    - pnpm test
tasks:
  - id: P2-T1
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

/** Scaffold two done phases (P1, P2) + their snapshots; return both canonical bytes. */
async function scaffoldTwoSnapshots(): Promise<{ p1: string; p2: string }> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP2, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await writeFile(join(cwd, "design", "phases", "P2-y.yaml"), P2_DONE, "utf8");
  await seedDurableEvents(cwd, EVENTS2);
  expect((await writePhaseSnapshot(cwd, "P1", { now: NOW })).kind).toBe("written");
  expect((await writePhaseSnapshot(cwd, "P2", { now: NOW })).kind).toBe("written");
  return {
    p1: await readFile(phaseSnapshotPath(cwd, "P1"), "utf8"),
    p2: await readFile(phaseSnapshotPath(cwd, "P2"), "utf8"),
  };
}

describe("multi-member bundle (sort + member_ids_sha256 over 2+ ids)", () => {
  it("members are sorted by id regardless of input order; member_ids_sha256 matches", async () => {
    const { p1, p2 } = await scaffoldTwoSnapshots();
    // Pass out of order: P2 before P1.
    const bundle = buildArchiveBundle("phase_snapshot", [
      { id: "P2", bytes: p2 },
      { id: "P1", bytes: p1 },
    ]);
    expect(bundle.members.map((m) => m.id)).toEqual(["P1", "P2"]); // sorted
    expect(bundle.member_ids_sha256).toBe(computeMemberIdsSha256(["P1", "P2"]));
    // The written bundle resolves both members via the Layer-1 reader.
    const out = await writeArchiveBundle(cwd, "phase_snapshot", [
      { id: "P2", bytes: p2 },
      { id: "P1", bytes: p1 },
    ]);
    expect(out.kind).toBe("written");
    if (out.kind === "written") expect(out.member_count).toBe(2);
    const members = loadArchiveBundles(cwd).index.get("phase_snapshot")!;
    expect(members.get("P1")?.bytes).toBe(p1);
    expect(members.get("P2")?.bytes).toBe(p2);
  });
});

describe("verifyBundleReadback — fail-closed on a corrupt/divergent readback", () => {
  it("non-JSON disk bytes → verify_bundle error, partial_applied true", async () => {
    const bytes = await scaffoldP1Snapshot();
    let caught: BundleWriteError | undefined;
    try {
      verifyBundleReadback("not json\n", "phase_snapshot", [{ id: "P1", bytes }], "x.json");
    } catch (e) {
      caught = e as BundleWriteError;
    }
    expect(caught?.phase).toBe("verify_bundle");
    expect(caught?.partial_applied).toBe(true);
  });

  it("disk member bytes differ from the folded loose bytes → verify_bundle (bundle_stale)", async () => {
    const bytes = await scaffoldP1Snapshot();
    // A valid on-disk bundle holding P1=bytes, but we claim to have folded DIFFERENT
    // loose bytes for P1 → strict-reconcile must reject (the loose changed under us).
    const diskBundle = serializeArchiveBundle(buildArchiveBundle("phase_snapshot", [{ id: "P1", bytes }]));
    const differentLoose = bytes.replace('"phase_id": "P1"', '"phase_id": "P1" ');
    expect(() =>
      verifyBundleReadback(diskBundle, "phase_snapshot", [{ id: "P1", bytes: differentLoose }], "x.json"),
    ).toThrow();
  });

  it("a folded member missing from the disk bundle → verify_bundle (count/missing)", async () => {
    const { p1, p2 } = await scaffoldTwoSnapshots();
    // On-disk bundle has only P1, but we claim to have folded P1 + P2.
    const diskBundle = serializeArchiveBundle(buildArchiveBundle("phase_snapshot", [{ id: "P1", bytes: p1 }]));
    expect(() =>
      verifyBundleReadback(
        diskBundle,
        "phase_snapshot",
        [{ id: "P1", bytes: p1 }, { id: "P2", bytes: p2 }],
        "x.json",
      ),
    ).toThrow();
  });
});

/** Refresh the on-disk P1 snapshot to a DIFFERENT-but-valid record (edit the design file,
 *  then an explicit refresh re-records it) and return the new loose bytes. The supersede
 *  scenario: a record was compacted into a bundle, then refreshed, so a fresher loose now
 *  diverges from the bundle member at the same id. */
async function refreshP1SnapshotToNewBytes(): Promise<string> {
  const edited = P1_DONE.replace("Build the base", "Build the base (edited)");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), edited, "utf8");
  const refreshed = await writePhaseSnapshot(cwd, "P1", {
    now: new Date("2026-06-11T00:00:00.000Z"),
    refresh: { expected_old_source_sha256: sha256Hex(P1_DONE), expected_new_source_sha256: sha256Hex(edited) },
  });
  expect(refreshed.kind).toBe("written");
  return readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
}

describe("supersedeArchiveBundle — intentional same-id-set replace (UNWIRED Layer-4 primitive)", () => {
  it("a stale bundle at the content address is REPLACED with the fresher member; the bundle now holds the new bytes", async () => {
    const v1 = await scaffoldP1Snapshot();
    expect((await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: v1 }])).kind).toBe("written");
    const v2 = await refreshP1SnapshotToNewBytes();
    expect(v2).not.toBe(v1); // a genuinely different (but valid) snapshot

    const out = await supersedeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: v2 }]);
    expect(out.kind).toBe("superseded");
    if (out.kind === "superseded") expect(out.member_count).toBe(1);
    // The bundle's authority for P1 is now the NEW bytes — the old member bytes are DROPPED.
    const member = loadArchiveBundles(cwd).index.get("phase_snapshot")?.get("P1");
    expect(member?.bytes).toBe(v2);
    expect(member?.bytes).not.toBe(v1);
    // Layer-3 boundary preserved: supersede touches only the bundle, never the loose record.
    expect(await readFile(phaseSnapshotPath(cwd, "P1"), "utf8")).toBe(v2);
  });

  it("OPT-IN boundary: where writeArchiveBundle FAILS CLOSED on a same-id divergence, supersedeArchiveBundle REPLACES", async () => {
    const v1 = await scaffoldP1Snapshot();
    expect((await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: v1 }])).kind).toBe("written");
    const v2 = await refreshP1SnapshotToNewBytes();

    // The default create path refuses to overwrite the diverging bundle (the #467 guard)...
    await expect(writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: v2 }])).rejects.toThrow(
      /different bundle already exists/,
    );
    // ...but the explicit supersede path adopts the fresher member.
    expect((await supersedeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: v2 }])).kind).toBe("superseded");
  });

  it("idempotent: superseding to the bytes already on disk → noop_already_bundled (no needless rewrite)", async () => {
    const v1 = await scaffoldP1Snapshot();
    expect((await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: v1 }])).kind).toBe("written");
    const v2 = await refreshP1SnapshotToNewBytes();
    expect((await supersedeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: v2 }])).kind).toBe("superseded");
    // A second supersede with the same v2 is a converged noop.
    expect((await supersedeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: v2 }])).kind).toBe(
      "noop_already_bundled",
    );
  });

  it("no existing bundle at the content address → a plain written (supersede degrades to create)", async () => {
    const v1 = await scaffoldP1Snapshot();
    const out = await supersedeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: v1 }]);
    expect(out.kind).toBe("written");
    expect(loadArchiveBundles(cwd).index.get("phase_snapshot")?.get("P1")?.bytes).toBe(v1);
  });

  it("empty member set → noop_no_members", async () => {
    expect((await supersedeArchiveBundle(cwd, "phase_snapshot", [])).kind).toBe("noop_no_members");
  });

  // ---- self-safety: a destructive replace must never overwrite the wrong target, nor turn a
  //      valid store into an unloadable one (the primitive is safe even called directly). ----

  it("a corrupt (non-bundle) file at the content-address target → fail closed (ARCHIVE_BUNDLE_INVALID, a corrupt STORE — not a write fault), target untouched", async () => {
    const v1 = await scaffoldP1Snapshot();
    const path = archiveBundlePath(cwd, "phase_snapshot", computeMemberIdsSha256(["P1"]));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not a bundle\n", "utf8");
    // The strict store load inside the supersede preflight refuses before any write. A corrupt
    // bundle is a corrupt STORE, so this surfaces ARCHIVE_BUNDLE_INVALID (raw, from
    // loadArchiveBundles) — DELIBERATELY a different class than the BundleWriteError /
    // ARCHIVE_BUNDLE_WRITE_FAILED the other preflight refusals throw, matching how
    // compactArchive already distinguishes a corrupt store from a write fault (state.ts).
    await expect(supersedeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: v1 }])).rejects.toMatchObject({
      code: "ARCHIVE_BUNDLE_INVALID",
    });
    expect(await readFile(path, "utf8")).toBe("not a bundle\n");
  });

  it("a valid bundle of a DIFFERENT KIND at the target path → refuses to replace, target untouched", async () => {
    const v1 = await scaffoldP1Snapshot();
    const path = archiveBundlePath(cwd, "phase_snapshot", computeMemberIdsSha256(["P1"]));
    await mkdir(dirname(path), { recursive: true });
    // Tier-1-valid (sha-consistent members) but declares kind "decision_record" — Tier-1 does
    // not check member-body kind-validity, so this loads; the kind guard must catch it.
    const raw =
      JSON.stringify(
        {
          schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
          kind: "decision_record",
          member_ids_sha256: computeMemberIdsSha256(["P1"]),
          members: [{ id: "P1", sha256: sha256Hex("x"), bytes: "x" }],
        },
        null,
        2,
      ) + "\n";
    await writeFile(path, raw, "utf8");
    // A wrong-kind target is a write-level REFUSAL (ARCHIVE_BUNDLE_WRITE_FAILED), the
    // counterpart class to the corrupt-store ARCHIVE_BUNDLE_INVALID above.
    await expect(supersedeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: v1 }])).rejects.toMatchObject({
      code: "ARCHIVE_BUNDLE_WRITE_FAILED",
      message: expect.stringMatching(/not "phase_snapshot"/),
    });
    expect(await readFile(path, "utf8")).toBe(raw);
  });

  it("a valid bundle with a DIFFERENT id set at the target path → refuses to replace, target untouched", async () => {
    const { p1, p2 } = await scaffoldTwoSnapshots();
    // Place a valid {P1,P2} bundle at the content-address path for the {P1} id set (a misplaced
    // file: its NAME addresses {P1} but its CONTENT is {P1,P2}).
    const p1Path = archiveBundlePath(cwd, "phase_snapshot", computeMemberIdsSha256(["P1"]));
    await mkdir(dirname(p1Path), { recursive: true });
    const misplaced = serializeArchiveBundle(
      buildArchiveBundle("phase_snapshot", [{ id: "P1", bytes: p1 }, { id: "P2", bytes: p2 }]),
    );
    await writeFile(p1Path, misplaced, "utf8");
    // Superseding the {P1} id set targets p1Path, but the file there holds {P1,P2}.
    await expect(supersedeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: p1 }])).rejects.toThrow(
      /different member id set/,
    );
    expect(await readFile(p1Path, "utf8")).toBe(misplaced);
  });

  it("superseding a member a REDUNDANT bundle still holds → refuses rather than corrupt the store (duplicate_member_conflict)", async () => {
    const { p1, p2 } = await scaffoldTwoSnapshots();
    // A valid crash-survivor store: a consolidated {P1,P2} bundle AND a redundant {P1} bundle.
    // P1 is byte-identical in both → deduped, so the store loads clean today.
    expect(
      (await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: p1 }, { id: "P2", bytes: p2 }])).kind,
    ).toBe("written");
    expect((await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: p1 }])).kind).toBe("written");
    expect(loadArchiveBundles(cwd).index.get("phase_snapshot")?.get("P1")?.bytes).toBe(p1);

    const p1v2 = await refreshP1SnapshotToNewBytes();
    // Superseding P1 in the {P1,P2} bundle would leave the redundant {P1} bundle holding the
    // OLD P1 → a cross-bundle duplicate_member_conflict. The primitive must refuse.
    await expect(
      supersedeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: p1v2 }, { id: "P2", bytes: p2 }]),
    ).rejects.toThrow(/supersede would corrupt the bundle store/);
    // Both bundles untouched; the store still loads and still resolves the OLD P1.
    expect(() => loadArchiveBundles(cwd)).not.toThrow();
    expect(loadArchiveBundles(cwd).index.get("phase_snapshot")?.get("P1")?.bytes).toBe(p1);
  });
});
