import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import {
  readEventPackFiles,
  readEventPackFilesLenient,
} from "../../../../src/core/archive/event-pack-reader.ts";
import { serializeEventPack } from "../../../../src/core/archive/event-pack.ts";
import { readPackSources } from "../../../../src/core/progress/all-sources.ts";
import {
  archiveBundlesDir,
  phaseSnapshotPath,
  sha256Hex,
} from "../../../../src/core/archive/paths.ts";
import { computeMemberIdsSha256 } from "../../../../src/core/archive/archive-bundle-reader.ts";
import { ARCHIVE_BUNDLE_SCHEMA_VERSION } from "../../../../src/core/schemas/archive-bundle.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";
import { buildValidEventPack, writeEventPackFile } from "../../../helpers/event-pack-fixture.ts";

// Layer 1 (final reader wiring): event-packs resolve from loose ∪ bundle, and the
// pack→snapshot binding resolves a BUNDLED phase snapshot too.

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
const EVENTS_P1T1 = `events:
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
  cwd = await mkdtemp(join(tmpdir(), "code-pact-eventpack-bundle-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function scaffoldArchivedP1(): Promise<ProgressEvent[]> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await seedDurableEvents(cwd, EVENTS_P1T1);
  expect((await writePhaseSnapshot(cwd, "P1", { now: NOW })).kind).toBe("written");
  const { ProgressLog } = await import("../../../../src/core/schemas/progress-event.ts");
  const { parse } = await import("yaml");
  return ProgressLog.parse(parse(EVENTS_P1T1)).events;
}

async function writeBundle(
  kind: string,
  name: string,
  members: { id: string; bytes: string }[],
): Promise<void> {
  const dir = archiveBundlesDir(cwd);
  await mkdir(dir, { recursive: true });
  const full = members
    .map((m) => ({ id: m.id, sha256: sha256Hex(m.bytes), bytes: m.bytes }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  await writeFile(
    join(dir, name),
    JSON.stringify({
      schema_version: ARCHIVE_BUNDLE_SCHEMA_VERSION,
      kind,
      member_ids_sha256: computeMemberIdsSha256(full.map((m) => m.id)),
      members: full,
    }),
    "utf8",
  );
}

/** Canonical event_pack bytes for P1 (binds to the on-disk snapshot's sha256). */
async function packBytesP1(events: ProgressEvent[]): Promise<string> {
  return serializeEventPack(await buildValidEventPack(cwd, "P1", events));
}

describe("readEventPackFiles — loose ∪ bundle", () => {
  it("bundle-only event-pack (no loose pack file) → resolved", async () => {
    const events = await scaffoldArchivedP1();
    const bytes = await packBytesP1(events);
    await writeBundle("event_pack", "b.json", [{ id: "P1", bytes }]);
    const loaded = await readEventPackFiles(cwd);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.phaseId).toBe("P1");
    expect(loaded[0]!.entries.map((e) => e.event.status)).toEqual(["started", "done"]);
  });

  it("loose pack present + same-id bundle member → loose wins; bundle never bound", async () => {
    const events = await scaffoldArchivedP1();
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    // A same-id bundle member with valid Tier-1 (sha matches) but GARBAGE bytes: it
    // would fail bindBundleMember if loaded, but loose wins so it is never bound.
    await writeBundle("event_pack", "b.json", [{ id: "P1", bytes: '{"not":"a pack"}' }]);
    const loaded = await readEventPackFiles(cwd);
    expect(loaded).toHaveLength(1); // the loose pack, no throw
    expect(loaded[0]!.phaseId).toBe("P1");
  });

  it("strict: a Tier-1-corrupt bundle in the store → throws", async () => {
    const events = await scaffoldArchivedP1();
    await writeBundle("event_pack", "good.json", [{ id: "P1", bytes: await packBytesP1(events) }]);
    await writeFile(join(archiveBundlesDir(cwd), "bad.json"), "{ not json", "utf8");
    await expect(readEventPackFiles(cwd)).rejects.toThrow();
  });

  it("lenient: a Tier-1-corrupt bundle store → loose packs kept, error collected (no throw)", async () => {
    const events = await scaffoldArchivedP1();
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    await mkdir(archiveBundlesDir(cwd), { recursive: true });
    await writeFile(join(archiveBundlesDir(cwd), "bad.json"), "{ not json", "utf8");
    const { packs, errors } = await readEventPackFilesLenient(cwd);
    expect(packs.map((p) => p.phaseId)).toEqual(["P1"]); // loose pack survives
    expect(errors.length).toBeGreaterThan(0);
  });

  it("lenient: a bad bundle MEMBER is collected per-member while a loose pack survives", async () => {
    const events = await scaffoldArchivedP1();
    // A healthy loose P1 pack, plus a bundle whose ONLY member (a different phase P2)
    // is bundle-Tier-1-valid but not a real event_pack → it fails per-member binding.
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    await writeBundle("event_pack", "b.json", [{ id: "P2", bytes: '{"phase_id":"P2"}' }]);
    const { packs, errors } = await readEventPackFilesLenient(cwd);
    expect(packs.map((p) => p.phaseId)).toEqual(["P1"]); // loose P1 survives the member throw
    expect(errors.some((e) => e.phaseId === "P2")).toBe(true);
  });
});

describe("event-pack binding — bundled phase snapshot", () => {
  it("snapshot compacted into a bundle (loose snapshot gone) → pack still binds", async () => {
    const events = await scaffoldArchivedP1();
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    // Move the snapshot into a phase_snapshot bundle, then delete the loose snapshot.
    const snapBytes = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    await writeBundle("phase_snapshot", "snap.json", [{ id: "P1", bytes: snapBytes }]);
    await rm(phaseSnapshotPath(cwd, "P1"));
    // Strict readPackSources binds the pack against the bundled snapshot → no throw,
    // the pack's events flow through.
    const sources = await readPackSources(cwd, "strict");
    expect(sources.issues).toEqual([]);
    expect(sources.validatedPackFiles.map((e) => e.event.status).sort()).toEqual(["done", "started"]);
  });

  it("snapshot bundle has a DIFFERENT sha than the pack expects → binding fails (snapshot_sha256)", async () => {
    const events = await scaffoldArchivedP1();
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    const snapBytes = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    // Change only the path_sha256 value (a field the binding does NOT re-check, so it
    // stays schema-valid + canonical + phase_id=P1 and binds) → the bytes/sha differ
    // from what the pack's snapshot_sha256 pins → snapshot_sha256 mismatch.
    const tampered = snapBytes.replace(
      sha256Hex("design/phases/P1-x.yaml"),
      sha256Hex("design/phases/other.yaml"),
    );
    expect(tampered).not.toBe(snapBytes);
    await writeBundle("phase_snapshot", "snap.json", [{ id: "P1", bytes: tampered }]);
    await rm(phaseSnapshotPath(cwd, "P1"));
    // The bundled snapshot still binds (canonical), but its sha ≠ the pack's stored
    // snapshot_sha256 → the binding layer fails with snapshot_sha256_mismatch (NOT a
    // canonical/ARCHIVE_BUNDLE_INVALID error). Lenient collects it; assert the kind.
    const sources = await readPackSources(cwd, "lenient");
    expect(sources.validatedPackFiles).toHaveLength(0);
    expect(sources.issues.some((i) => /snapshot_sha256/.test(i.message))).toBe(true);
  });
});
