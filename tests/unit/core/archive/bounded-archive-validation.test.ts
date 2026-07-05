import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import { writeDecisionRecord } from "../../../../src/core/archive/decision-record.ts";
import { applyArchiveRetention } from "../../../../src/core/archive/archive-retention.ts";
import { compactArchive } from "../../../../src/core/archive/archive-bundle-cleanup.ts";
import { writeArchiveBundle } from "../../../../src/core/archive/archive-bundle-writer.ts";
import { loadArchiveBundles } from "../../../../src/core/archive/archive-bundle-loader.ts";
import { decisionRecordStem } from "../../../../src/core/archive/archive-bundle-binding.ts";
import { buildValidEventPack } from "../../../helpers/event-pack-fixture.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";
import { ProgressLog, type ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import { phaseSnapshotPath, eventPackPath, decisionRecordPath } from "../../../../src/core/archive/paths.ts";

// BOUNDED-ARCHIVE VALIDATION (the v2.0 "ゴミが溜まらない" gate). The removal surface is complete:
// `state archive-retention --write` removes EVERY would_drop record kind — a loose independent
// record, a loose phase↔pack pair, a bundle phase↔pack pair, and an independent bundle record
// (a decision, or a pack-less phase) — and a `source: both` record converges in ≤ 2 runs. A MIXED
// pair (one side `both`, the other bundle-only) is deferred, but `state compact-archive` first makes
// both sides uniform so the next retention run removes them. These tests prove, end to end, that the
// old UNREFERENCED tail is actually bounded (compaction bounds the bundle COUNT; retention bounds the
// old TRUTH) — not just relocated into bundles.

const TASK_FIELDS = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;
const ADR = `# RFC\n\n**Status:** accepted (P9, 2026-06)\n\n## Summary\n\nSettled.\n`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-bounded-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "event-packs"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "decisions"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

const exists = (p: string): Promise<boolean> => readFile(p, "utf8").then(() => true, () => false);
const resolvesInBundle = (kind: "phase_snapshot" | "event_pack" | "decision_record", id: string): boolean =>
  loadArchiveBundles(cwd).index.get(kind)?.has(id) ?? false;

/** Archive `ids` as done phase snapshots (each at its given timestamp) and seed their done events. */
async function archivePhases(specs: { id: string; at: string }[]): Promise<void> {
  const roadmap = `phases:\n${specs.map((s) => `  - id: ${s.id}\n    path: design/phases/${s.id}.yaml\n    weight: 1`).join("\n")}\n`;
  await writeFile(join(cwd, "design", "roadmap.yaml"), roadmap, "utf8");
  for (const s of specs) {
    await writeFile(
      join(cwd, "design", "phases", `${s.id}.yaml`),
      `id: ${s.id}\nname: Phase ${s.id}\nweight: 1\nconfidence: high\nrisk: low\nstatus: done\nobjective: do ${s.id}\ndefinition_of_done:\n  - it works\nverification:\n  commands:\n    - "true"\ntasks:\n  - id: ${s.id}-T1\n    type: feature\n${TASK_FIELDS}\n    status: done\n`,
      "utf8",
    );
  }
  await seedDurableEvents(cwd, `events:\n${specs.map((s) => `  - task_id: ${s.id}-T1\n    status: done\n    at: 2026-06-01T00:00:00.000Z\n    actor: agent`).join("\n")}\n`);
  for (const s of specs) expect((await writePhaseSnapshot(cwd, s.id, { now: new Date(s.at) })).kind).toBe("written");
}

/** Build a phase's event-pack bytes from its loose snapshot. */
async function packBytes(id: string): Promise<string> {
  const events: ProgressEvent[] = ProgressLog.parse({ events: [{ task_id: `${id}-T1`, status: "done", at: "2026-06-01T00:00:00.000Z", actor: "agent" }] }).events;
  return JSON.stringify(await buildValidEventPack(cwd, id, events), null, 2) + "\n";
}

/** Drop the roadmap to no phases — everything archived becomes the unreferenced tail. */
const unreferenceAll = (): Promise<void> => writeFile(join(cwd, "design", "roadmap.yaml"), "phases: []\n", "utf8");

describe("bounded-archive validation — every would_drop kind is removed (v2.0 gate)", () => {
  it("a mixed store (loose pair + bundle pair + independent bundle decision) is bounded in ONE retention run", async () => {
    // P1 (old) loose pair; P2 (old) bundle pair; P3 (newer) the keep. A bundle decision D1 (old) +
    // two newer decisions so D1 is the unreferenced drop.
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
      { id: "P3", at: "2026-03-01T00:00:00.000Z" },
    ]);
    // P1 → loose pair (loose snapshot + loose pack).
    await writeFile(eventPackPath(cwd, "P1"), await packBytes("P1"), "utf8");
    // P2 → bundle pair (snapshot + pack bundled, loose removed).
    const p2snap = await readFile(phaseSnapshotPath(cwd, "P2"), "utf8");
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P2", bytes: p2snap }]);
    await writeArchiveBundle(cwd, "event_pack", [{ id: "P2", bytes: await packBytes("P2") }]);
    await rm(phaseSnapshotPath(cwd, "P2"));
    // Decisions: D_OLD bundle-only (the drop), D_A / D_B loose (the keeps).
    for (const [d, at] of [["d-old", "2026-01-01"], ["d-a", "2026-02-01"], ["d-b", "2026-03-01"]] as const) {
      await writeFile(join(cwd, "design", "decisions", `${d}-rfc.md`), ADR, "utf8");
      await writeDecisionRecord(cwd, `design/decisions/${d}-rfc.md`, { now: new Date(`${at}T00:00:00.000Z`) });
    }
    const dOldStem = decisionRecordStem("design/decisions/d-old-rfc.md");
    const dOldBytes = await readFile(decisionRecordPath(cwd, "design/decisions/d-old-rfc.md"), "utf8");
    await writeArchiveBundle(cwd, "decision_record", [{ id: dOldStem, bytes: dOldBytes }]);
    await rm(decisionRecordPath(cwd, "design/decisions/d-old-rfc.md"));

    await unreferenceAll();
    const out = await applyArchiveRetention(cwd, { keepLatest: 1 });
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    const event = out.find((o) => o.kind === "event_pack")!;
    const decision = out.find((o) => o.kind === "decision_record")!;

    // P1 (loose pair) + P2 (bundle pair) BOTH fully deleted; P3 the keep survives.
    expect(phase.deleted.sort()).toEqual(["P1", "P2"]);
    expect(event.deleted.sort()).toEqual(["P1", "P2"]);
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false);
    expect(resolvesInBundle("phase_snapshot", "P2")).toBe(false);
    expect(resolvesInBundle("event_pack", "P2")).toBe(false);
    expect(await exists(phaseSnapshotPath(cwd, "P3"))).toBe(true);
    // The bundle decision D_OLD is deleted; the keeps survive.
    expect(decision.deleted).toContain(dOldStem);
    expect(resolvesInBundle("decision_record", dOldStem)).toBe(false);
    // BOUNDED: nothing of the old tail remains; nothing was silently dropped (every drop is reported).
    expect([...phase.skipped, ...event.skipped, ...decision.skipped]).toEqual([]);
  });

  it("a `source: both` bundle pair converges to fully gone in exactly 2 runs", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    const p1snap = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    const p1pack = await packBytes("P1");
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: p1snap }]);
    await writeArchiveBundle(cwd, "event_pack", [{ id: "P1", bytes: p1pack }]);
    await writeFile(eventPackPath(cwd, "P1"), p1pack, "utf8"); // P1 pack is `both`; P1 snapshot is `both` (loose still present)
    await unreferenceAll();

    const run1 = await applyArchiveRetention(cwd, { keepLatest: 1 });
    expect(run1.find((o) => o.kind === "phase_snapshot")!.bundle_member_removed).toContain("P1");
    expect(run1.find((o) => o.kind === "event_pack")!.bundle_member_removed).toContain("P1");
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true); // loose halves survive run 1

    const run2 = await applyArchiveRetention(cwd, { keepLatest: 1 });
    expect(run2.find((o) => o.kind === "phase_snapshot")!.deleted).toContain("P1"); // now fully gone
    expect(run2.find((o) => o.kind === "event_pack")!.deleted).toContain("P1");
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false);
    // BOTH bundle members gone — no surviving copy of either side resolves.
    expect(resolvesInBundle("phase_snapshot", "P1")).toBe(false);
    expect(resolvesInBundle("event_pack", "P1")).toBe(false);
  });

  it("a MIXED-source pair is resolved by compact-FIRST, then removed by retention (transient, not a leak)", async () => {
    await archivePhases([
      { id: "P1", at: "2026-01-01T00:00:00.000Z" },
      { id: "P2", at: "2026-02-01T00:00:00.000Z" },
    ]);
    // P1 phase is `both` (loose + bundle); P1 pack is bundle-only → MIXED. P2 the keep (loose).
    const p1snap = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P1", bytes: p1snap }]); // P1 snapshot now `both`
    await writeArchiveBundle(cwd, "event_pack", [{ id: "P1", bytes: await packBytes("P1") }]); // P1 pack bundle-only
    await unreferenceAll();

    // Retention alone DEFERS the mixed pair WHOLE (no half-state) — BOTH sides skipped, BOTH intact.
    const deferRun = await applyArchiveRetention(cwd, { keepLatest: 1 });
    expect(deferRun.find((o) => o.kind === "phase_snapshot")!.skipped.find((s) => s.id === "P1")?.reason).toBe("needs_bundle_member_removal");
    expect(deferRun.find((o) => o.kind === "event_pack")!.skipped.find((s) => s.id === "P1")?.reason).toBe("needs_bundle_member_removal");
    expect(deferRun.find((o) => o.kind === "event_pack")!.deleted).not.toContain("P1"); // the pack side is NOT removed alone
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(true);
    expect(resolvesInBundle("phase_snapshot", "P1")).toBe(true);
    expect(resolvesInBundle("event_pack", "P1")).toBe(true); // both bundle members intact (no half-state)

    // compact-FIRST: the loose P1 snapshot is byte-identical to its bundle member → deleted, so P1's
    // snapshot side becomes bundle-only. Now BOTH sides are uniform (bundle-only) → a clean bundle pair.
    await compactArchive(cwd, "phase_snapshot");
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false); // loose half compacted away

    // Retention now removes the (uniform) bundle pair fully — BOTH sides deleted, BOTH bundle members gone.
    const run = await applyArchiveRetention(cwd, { keepLatest: 1 });
    expect(run.find((o) => o.kind === "phase_snapshot")!.deleted).toContain("P1");
    expect(run.find((o) => o.kind === "event_pack")!.deleted).toContain("P1");
    expect(resolvesInBundle("phase_snapshot", "P1")).toBe(false);
    expect(resolvesInBundle("event_pack", "P1")).toBe(false);
  });

  it("a recovered loose pair vs a recovered bundle pair report DISTINCT intent_kind (recovered is not flattened)", async () => {
    // The #480 P2.1 contract: the public `recovered` is TAGGED, so a reader never mistakes a bundle-pair
    // recovery (loose copy may survive) for a loose-pair recovery (fully gone). One journal carries BOTH
    // a committed loose pair (P1) AND a committed bundle pair (P2); one recovery completes both, and the
    // outcome must report each with its OWN intent_kind — not a flat list of ids.
    const { writeDeleteIntent } = await import("../../../../src/core/archive/delete-intent-journal.ts");
    const { sha256Hex, archiveBundlePath } = await import("../../../../src/core/archive/paths.ts");
    const { computeMemberIdsSha256 } = await import("../../../../src/core/archive/archive-bundle-reader.ts");
    const { basename } = await import("node:path");
    await archivePhases([{ id: "P1", at: "2026-01-01T00:00:00.000Z" }, { id: "P2", at: "2026-02-01T00:00:00.000Z" }]);

    // P1 → a committed LOOSE pair (loose snapshot + loose pack on disk; the journal names them).
    await writeFile(eventPackPath(cwd, "P1"), await packBytes("P1"), "utf8");

    // P2 → a committed BUNDLE pair: P2 is the ONLY member of each kind's bundle, so the removal is an
    // empty-set (new_bundle null) — recovery just retires the old bundle after a digest re-check.
    const p2snap = await readFile(phaseSnapshotPath(cwd, "P2"), "utf8");
    await writeArchiveBundle(cwd, "phase_snapshot", [{ id: "P2", bytes: p2snap }]);
    await writeArchiveBundle(cwd, "event_pack", [{ id: "P2", bytes: await packBytes("P2") }]);
    await rm(phaseSnapshotPath(cwd, "P2"));
    const idsHash = computeMemberIdsSha256(["P2"]);
    const phaseBundleFile = basename(archiveBundlePath(cwd, "phase_snapshot", idsHash));
    const packBundleFile = basename(archiveBundlePath(cwd, "event_pack", idsHash));
    const oldBundle = async (file: string): Promise<{ file: string; sha256: string }> => ({
      file,
      sha256: sha256Hex(await readFile(join(cwd, ".code-pact", "state", "archive", "bundles", file), "utf8")),
    });

    await writeDeleteIntent(cwd, [
      { intent_kind: "loose_pair", phase_id: "P1", phase_sha256: sha256Hex("x"), pack_sha256: sha256Hex("y") },
      {
        intent_kind: "bundle_pair",
        phase_id: "P2",
        members: {
          phase_snapshot: { removed_ids: ["P2"], old_bundles: [await oldBundle(phaseBundleFile)], new_bundle: null },
          event_pack: { removed_ids: ["P2"], old_bundles: [await oldBundle(packBundleFile)], new_bundle: null },
        },
      },
    ]);
    await unreferenceAll();

    const out = await applyArchiveRetention(cwd, { keepLatest: 5 });
    const phase = out.find((o) => o.kind === "phase_snapshot")!;
    // BOTH recoveries appear, each with its OWN intent_kind — DISTINCT, never flattened to bare ids.
    expect(phase.recovered).toContainEqual({ id: "P1", intent_kind: "loose_pair" });
    expect(phase.recovered).toContainEqual({ id: "P2", intent_kind: "bundle_pair" });
    expect(await exists(phaseSnapshotPath(cwd, "P1"))).toBe(false); // loose pair recovery removed both files
    expect(resolvesInBundle("phase_snapshot", "P2")).toBe(false); // bundle pair recovery retired the bundle
  });
});
