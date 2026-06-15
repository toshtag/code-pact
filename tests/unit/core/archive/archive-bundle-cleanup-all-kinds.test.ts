import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import { writePhaseSnapshot, planPhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import { writeDecisionRecord } from "../../../../src/core/archive/decision-record.ts";
import { planEventPack } from "../../../../src/core/archive/event-pack.ts";
import { runDecisionRetire } from "../../../../src/commands/decision-retire.ts";
import {
  compactArchive,
  deleteLooseCoveredByBundle,
} from "../../../../src/core/archive/archive-bundle-cleanup.ts";
import { writeArchiveBundle } from "../../../../src/core/archive/archive-bundle-writer.ts";
import { decisionRecordStem } from "../../../../src/core/archive/archive-bundle-binding.ts";
import {
  decisionRecordPath,
  eventPackPath,
  phaseSnapshotPath,
} from "../../../../src/core/archive/paths.ts";
import { buildValidEventPack, writeEventPackFile } from "../../../helpers/event-pack-fixture.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";
import { archiveBundlesDir, sha256Hex } from "../../../../src/core/archive/paths.ts";
import { computeMemberIdsSha256 } from "../../../../src/core/archive/archive-bundle-reader.ts";
import { ARCHIVE_BUNDLE_SCHEMA_VERSION } from "../../../../src/core/schemas/archive-bundle.ts";

/** Write a bundle file DIRECTLY (bypassing the writer's own validation) so a test can
 *  plant a Tier-1-valid-bundle whose MEMBER is not Tier-1-valid for its kind. */
async function writeRawBundle(c: string, kind: string, name: string, members: { id: string; bytes: string }[]): Promise<void> {
  const dir = archiveBundlesDir(c);
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

// Layer 3 — destructive deletion exercised through the REAL produce/command paths of
// EVERY kind, proving the authority migration (loose → bundle) is complete: deleting a
// bundled loose record changes no producer/command verdict.

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
  cwd = await mkdtemp(join(tmpdir(), "code-pact-cleanup-allkinds-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "decisions"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function scaffoldP1(): Promise<ProgressEvent[]> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await seedDurableEvents(cwd, EVENTS);
  expect((await writePhaseSnapshot(cwd, "P1", { now: NOW })).kind).toBe("written");
  const { ProgressLog } = await import("../../../../src/core/schemas/progress-event.ts");
  const { parse } = await import("yaml");
  return ProgressLog.parse(parse(EVENTS)).events;
}

describe("event_pack: deleting a bundled loose pack does not change planEventPack's verdict (Blocker 1)", () => {
  it("planEventPack recognizes the bundled pack instead of regenerating a subset", async () => {
    const events = await scaffoldP1();
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    const packBytes = await readFile(eventPackPath(cwd, "P1"), "utf8");
    await writeArchiveBundle(cwd, "event_pack", [{ id: "P1", bytes: packBytes }]);
    const planLoose = await planEventPack(cwd, "P1"); // loose pack present
    const out = await deleteLooseCoveredByBundle(cwd, "event_pack");
    expect(out.deleted).toEqual(["P1"]);
    expect(await readFile(eventPackPath(cwd, "P1"), "utf8").then(() => true, () => false)).toBe(false);
    const planBundle = await planEventPack(cwd, "P1"); // resolves the pack from the bundle
    expect(planBundle.kind).toBe(planLoose.kind); // identical verdict — bundle == loose
    // Specifically NOT regenerated as a fresh subset write (loose pack was recognized).
    expect(planBundle.kind).not.toBe("write");
    // Deeper than .kind: the cleanup state machine must be identical too (a matching
    // kind with a drifted loose_relationship / cleanup_pending would still misbehave).
    if (planBundle.kind === "noop_already_packed" && planLoose.kind === "noop_already_packed") {
      expect(planBundle.loose_relationship).toBe(planLoose.loose_relationship);
    }
  });
});

describe("event_pack bundle WRITER rejects a Tier-1-invalid pack (P1.1 — no bad authority artifact)", () => {
  it("writeArchiveBundle(event_pack, semantically-invalid pack) throws and writes no bundle", async () => {
    const events = await scaffoldP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    // Schema-valid + canonical but Tier-1-invalid (wrong event_ids_sha256).
    const tampered = { ...pack, event_ids_sha256: "0".repeat(64) };
    const tamperedBytes = JSON.stringify(tampered, null, 2) + "\n";
    await expect(writeArchiveBundle(cwd, "event_pack", [{ id: "P1", bytes: tamperedBytes }])).rejects.toThrow();
    // The store must not contain a bad event_pack bundle.
    const { readdir } = await import("node:fs/promises");
    const { archiveBundlesDir } = await import("../../../../src/core/archive/paths.ts");
    const names = await readdir(archiveBundlesDir(cwd)).catch(() => [] as string[]);
    expect(names).toEqual([]);
  });
});

describe("phase_snapshot refresh of a bundle-only record materializes a fresh loose (P1.2 honesty)", () => {
  it("an EXPLICIT refresh of a bundle-only existing → verdict is write (materialize), not refresh", async () => {
    const oldYaml = P1_DONE;
    await scaffoldP1();
    await compactArchive(cwd, "phase_snapshot"); // bundle + delete the loose snapshot
    // Change the phase YAML (objective) so source_sha256 drifts, and refresh EXPLICITLY.
    const newYaml = oldYaml.replace("Build the base", "Build the base anew");
    await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), newYaml, "utf8");
    const plan = await planPhaseSnapshot(cwd, "P1", {
      now: NOW,
      refresh: {
        expected_old_source_sha256: sha256Hex(oldYaml),
        expected_new_source_sha256: sha256Hex(newYaml),
      },
    });
    // The producer VERDICT changes: a refresh would expect loose bytes that no longer
    // exist, so it becomes a fresh write (ExpectedState absent). Logical effect is the
    // same — the new loose record supersedes the stale bundle member via loose-wins.
    expect(plan.kind).toBe("write");
  });
});

describe("decision_record: deleting a bundled loose record keeps a retired decision retired (Blocker 2)", () => {
  it("runDecisionRetire reports already-retired from the bundle, not not_retired", async () => {
    await writeFile(join(cwd, DEC_REF), ACCEPTED_ADR, "utf8");
    expect((await writeDecisionRecord(cwd, DEC_REF, { now: NOW })).kind).toBe("written");
    const recBytes = await readFile(decisionRecordPath(cwd, DEC_REF), "utf8");
    await writeArchiveBundle(cwd, "decision_record", [{ id: decisionRecordStem(DEC_REF), bytes: recBytes }]);
    const out = await deleteLooseCoveredByBundle(cwd, "decision_record");
    expect(out.deleted).toEqual([decisionRecordStem(DEC_REF)]);
    await rm(join(cwd, DEC_REF)); // retire the live .md
    const res = await runDecisionRetire({ cwd, path: DEC_REF, write: false, now: NOW });
    // Bundle-only record → recognized as already retired, NOT not_retired.
    expect(res.kind).toBe("would_already_retired");
  });
});

describe("phase_snapshot: a bundle-only existing record makes the producer a noop, not a re-materialize (Blocker 3)", () => {
  it("planPhaseSnapshot is noop_same_source after compaction, not a fresh write", async () => {
    await scaffoldP1();
    const out = await compactArchive(cwd, "phase_snapshot");
    expect(out.delete.deleted).toEqual(["P1"]);
    expect(await readFile(phaseSnapshotPath(cwd, "P1"), "utf8").then(() => true, () => false)).toBe(false);
    // Re-running the producer must SEE the bundle-only record (noop), not treat it as
    // missing and re-materialize a loose copy.
    const plan = await planPhaseSnapshot(cwd, "P1", { now: NOW });
    expect(plan.kind).toBe("noop_same_source");
  });
});

describe("event_pack delete gate runs full Tier-1 on the bundle member (P1)", () => {
  it("a byte-identical loose+bundle pair that is not Tier-1-valid → skip(bundle_member_invalid)", async () => {
    const events = await scaffoldP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    // A schema-valid, canonical event-pack with a WRONG event_ids_sha256: bindBundleMember
    // accepts it (schema + canonical + id) but validateEventPackTier1 rejects it.
    const tampered = { ...pack, event_ids_sha256: "0".repeat(64) };
    const tamperedBytes = JSON.stringify(tampered, null, 2) + "\n";
    await writeEventPackFile(cwd, "P1", tampered);
    // Plant the bad bundle DIRECTLY — the writer (P1.1) would reject it, so this
    // exercises the delete gate's own defense-in-depth Tier-1 check on a hand-crafted bundle.
    await writeRawBundle(cwd, "event_pack", "ep.json", [{ id: "P1", bytes: tamperedBytes }]);
    const del = await deleteLooseCoveredByBundle(cwd, "event_pack");
    expect(del.deleted).toEqual([]);
    expect(del.skipped[0]?.reason).toBe("bundle_member_invalid");
    expect(await readFile(eventPackPath(cwd, "P1"), "utf8").then(() => true, () => false)).toBe(true);
  });
});
