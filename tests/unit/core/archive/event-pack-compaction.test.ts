import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import {
  planEventPack,
  applyEventPackPlan,
  EventPackWriteError,
} from "../../../../src/core/archive/event-pack.ts";
import { eventPackPath, phaseSnapshotPath } from "../../../../src/core/archive/paths.ts";
import { eventFileName } from "../../../../src/core/progress/event-id.ts";
import { EventPack } from "../../../../src/core/schemas/event-pack.ts";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";
import { buildValidEventPack, writeEventPackFile } from "../../../helpers/event-pack-fixture.ts";

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

const STARTED_DONE_P1T1 = `events:
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
  cwd = await mkdtemp(join(tmpdir(), "code-pact-l2-compact-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/**
 * Scaffold an ARCHIVED P1: snapshot written, loose events present, phase YAML
 * DELETED (the post-`phase archive` state where `state compact` operates).
 * Returns the seeded events (started + done) for packing.
 */
async function scaffoldArchivedP1(progressYaml = STARTED_DONE_P1T1) {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await seedDurableEvents(cwd, progressYaml);
  expect((await writePhaseSnapshot(cwd, "P1", { now: NOW })).kind).toBe("written");
  // Simulate `phase archive --write` deleting the YAML (+ leaving it out of the roadmap).
  await rm(join(cwd, "design", "phases", "P1-x.yaml"));
  await writeFile(join(cwd, "design", "roadmap.yaml"), "phases: []\n", "utf8");
  const { ProgressLog } = await import("../../../../src/core/schemas/progress-event.ts");
  const { parse } = await import("yaml");
  return ProgressLog.parse(parse(progressYaml)).events;
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

describe("planEventPack — eligibility blocks", () => {
  it("phase YAML still present → ineligible(phase_file_still_present)", async () => {
    await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
    await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
    await seedDurableEvents(cwd, STARTED_DONE_P1T1);
    expect((await writePhaseSnapshot(cwd, "P1", { now: NOW })).kind).toBe("written");
    // YAML still on disk.
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("ineligible");
    if (plan.kind !== "ineligible") return;
    expect(plan.block.kind).toBe("phase_file_still_present");
  });

  it("no snapshot → ineligible(snapshot_missing)", async () => {
    await writeFile(join(cwd, "design", "roadmap.yaml"), "phases: []\n", "utf8");
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("ineligible");
    if (plan.kind !== "ineligible") return;
    expect(plan.block.kind).toBe("snapshot_missing");
  });

  it("duplicate phase id in the roadmap (AMBIGUOUS_PHASE_ID) → ineligible(ambiguous_phase_id), NO pack written", async () => {
    // Control-plane corruption: the id maps to two roadmap entries, each with a
    // live YAML on disk. The snapshot also exists. state compact must fail closed
    // — never compact while duplicate live phases may exist.
    const events = await scaffoldArchivedP1(); // snapshot written, YAML deleted, roadmap empty
    // Re-introduce TWO live P1 phases with the SAME id.
    await writeFile(join(cwd, "design", "phases", "P1-a.yaml"), P1_DONE, "utf8");
    await writeFile(join(cwd, "design", "phases", "P1-b.yaml"), P1_DONE, "utf8");
    await writeFile(
      join(cwd, "design", "roadmap.yaml"),
      `phases:\n  - id: P1\n    path: design/phases/P1-a.yaml\n    weight: 1\n  - id: P1\n    path: design/phases/P1-b.yaml\n    weight: 1\n`,
      "utf8",
    );
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("ineligible");
    if (plan.kind !== "ineligible") return;
    expect(plan.block.kind).toBe("ambiguous_phase_id");
    if (plan.block.kind !== "ambiguous_phase_id") return;
    expect(plan.block.phase_paths.sort()).toEqual([
      "design/phases/P1-a.yaml",
      "design/phases/P1-b.yaml",
    ]);
    // No pack written by a dry-run plan; assert the eligible events would have
    // packed (so the block is the ONLY reason it stopped).
    expect(events.length).toBeGreaterThan(0);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false);
  });

  it("orphan live YAML with matching id (roadmap doesn't name it) → ineligible(phase_file_still_present)", async () => {
    // The fail-open the roadmap-only check missed: a live phase doc with id P1
    // sitting in design/phases/ under a name the roadmap never references.
    await scaffoldArchivedP1(); // snapshot present, roadmap empty, no live P1 YAML
    await rm(join(cwd, "design", "roadmap.yaml")); // no roadmap at all
    await writeFile(join(cwd, "design", "phases", "P1-orphan.yaml"), P1_DONE, "utf8");
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("ineligible");
    if (plan.kind !== "ineligible") return;
    expect(plan.block.kind).toBe("phase_file_still_present");
    if (plan.block.kind !== "phase_file_still_present") return;
    expect(plan.block.phase_path).toBe("design/phases/P1-orphan.yaml");
  });

  it("design/phases/ unreadable (not a dir) → ineligible(phase_discovery_incomplete), fail closed", async () => {
    await scaffoldArchivedP1();
    await rm(join(cwd, "design", "roadmap.yaml"));
    // Replace the phases dir with a regular file so readdir fails with ENOTDIR.
    await rm(join(cwd, "design", "phases"), { recursive: true, force: true });
    await writeFile(join(cwd, "design", "phases"), "not a dir", "utf8");
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("ineligible");
    if (plan.kind !== "ineligible") return;
    expect(plan.block.kind).toBe("phase_discovery_incomplete");
  });

  it("a SINGLE unparseable phase YAML in design/phases/ → ineligible(phase_discovery_incomplete), not skipped", async () => {
    // The dir is readable, but one file in it is not a parseable Phase. The scan
    // must NOT skip it (it could be a broken live target phase doc) — fail closed.
    await scaffoldArchivedP1();
    await rm(join(cwd, "design", "roadmap.yaml"));
    await writeFile(join(cwd, "design", "phases", "P1-broken.yaml"), "{ not: valid phase", "utf8");
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("ineligible");
    if (plan.kind !== "ineligible") return;
    expect(plan.block.kind).toBe("phase_discovery_incomplete");
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false); // fail closed — no pack
  });

  it("corrupt snapshot → ineligible(snapshot_invalid)", async () => {
    await scaffoldArchivedP1();
    await writeFile(phaseSnapshotPath(cwd, "P1"), "{ corrupt", "utf8");
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("ineligible");
    if (plan.kind !== "ineligible") return;
    expect(plan.block.kind).toBe("snapshot_invalid");
  });

  it("snapshot evidence unresolvable (loose done event hand-deleted) → ineligible(snapshot_evidence_broken)", async () => {
    const events = await scaffoldArchivedP1();
    // Delete the loose `done` event so the snapshot's progress_events id dangles.
    const doneEvent = events.find((e) => e.status === "done")!;
    await rm(join(cwd, ".code-pact", "state", "events", eventFileName(doneEvent)));
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("ineligible");
    if (plan.kind !== "ineligible") return;
    expect(plan.block.kind).toBe("snapshot_evidence_broken");
  });
});

describe("planEventPack — write + completeness", () => {
  it("snapshot + loose events, no pack → write plan capturing ALL statuses", async () => {
    await scaffoldArchivedP1(); // started + done
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("write");
    if (plan.kind !== "write") return;
    expect(plan.pack.events.map((e) => e.event.status).sort()).toEqual(["done", "started"]);
    expect(plan.loose_count).toBe(2);
  });

  it("apply writes the pack; readback succeeds; loose files REMAIN (no unlink)", async () => {
    const events = await scaffoldArchivedP1();
    const plan = await planEventPack(cwd, "P1");
    if (plan.kind !== "write") throw new Error("expected write");
    const outcome = await applyEventPackPlan(cwd, plan);
    expect(outcome.kind).toBe("written");
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true);
    // Layer 2 NEVER unlinks: every loose file still on disk.
    for (const e of events) {
      expect(await exists(join(cwd, ".code-pact", "state", "events", eventFileName(e)))).toBe(true);
    }
    // The written pack round-trips through the schema.
    EventPack.parse(JSON.parse(await readFile(eventPackPath(cwd, "P1"), "utf8")));
  });
});

describe("planEventPack — existing-pack state machine (sixth-review pins)", () => {
  it("(a) existing valid pack + ZERO loose → already_packed cleanup_pending:false, NOT pack_stale", async () => {
    const events = await scaffoldArchivedP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    await writeEventPackFile(cwd, "P1", pack);
    // Delete ALL loose files (the post-Layer-3 normal state).
    for (const e of events) {
      await rm(join(cwd, ".code-pact", "state", "events", eventFileName(e)));
    }
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("noop_already_packed");
    if (plan.kind !== "noop_already_packed") return;
    expect(plan.cleanup_pending).toBe(false);
    expect(plan.loose_remaining_count).toBe(0);
  });

  it("(b) existing valid pack + loose remain + matching hash → already_packed cleanup_pending:true", async () => {
    const events = await scaffoldArchivedP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    await writeEventPackFile(cwd, "P1", pack); // loose still on disk
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("noop_already_packed");
    if (plan.kind !== "noop_already_packed") return;
    expect(plan.cleanup_pending).toBe(true);
    expect(plan.loose_remaining_count).toBe(2);
  });

  it("(c) existing valid pack + loose remain + hash differs → ineligible(pack_stale)", async () => {
    const events = await scaffoldArchivedP1();
    // Pack only the `done` event (a subset) → its event_ids_sha256 ≠ the full loose set's.
    const doneOnly = events.filter((e) => e.status === "done");
    const pack = await buildValidEventPack(cwd, "P1", doneOnly);
    await writeEventPackFile(cwd, "P1", pack);
    const plan = await planEventPack(cwd, "P1");
    // The completeness check (pack_missing_phase_event) fires first as pack_invalid:
    // the pack omits the started event for a snapshot task. Either pack_stale or
    // pack_invalid is a correct fail-closed verdict; assert it is NOT a write/noop.
    expect(plan.kind).toBe("ineligible");
    if (plan.kind !== "ineligible") return;
    expect(["pack_stale", "pack_invalid"]).toContain(plan.block.kind);
  });

  it("existing pack that fails Tier-1 → ineligible(pack_invalid)", async () => {
    await scaffoldArchivedP1();
    await writeEventPackFile(cwd, "P1", { not: "a valid pack" });
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("ineligible");
    if (plan.kind !== "ineligible") return;
    expect(plan.block.kind).toBe("pack_invalid");
  });
});

describe("planEventPack — noop_no_events", () => {
  it("snapshot present, zero loose events for its tasks, no pack → noop_no_events", async () => {
    // Archive with NO progress events: scaffold needs a snapshot, so attest the done task.
    await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
    await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
    // No seedDurableEvents → P1-T1 has no events; attest so the snapshot can be written.
    const w = await writePhaseSnapshot(cwd, "P1", {
      now: NOW,
      attestations: { "P1-T1": { reason: "verified out of band" } },
    });
    expect(w.kind).toBe("written");
    await rm(join(cwd, "design", "phases", "P1-x.yaml"));
    await writeFile(join(cwd, "design", "roadmap.yaml"), "phases: []\n", "utf8");
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("noop_no_events");
  });
});

describe("applyEventPackPlan — write/verify fail-closed (NO unlink anywhere)", () => {
  it("readback-verify failure → EventPackWriteError(verify_pack, partial_applied:true); pack STILL on disk", async () => {
    await scaffoldArchivedP1();
    const writePlan = await planEventPack(cwd, "P1");
    if (writePlan.kind !== "write") throw new Error("expected write");
    // beforeVerify hook corrupts the just-written pack so readback fails.
    await expect(
      applyEventPackPlan(cwd, writePlan, {
        beforeVerify: async () => {
          await writeFile(eventPackPath(cwd, "P1"), "{ corrupted after write", "utf8");
        },
      }),
    ).rejects.toMatchObject({ phase: "verify_pack", partial_applied: true });
    // Layer 2 does NOT delete the bad pack.
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true);
  });

  it("snapshot swapped on disk between plan and verify → verify_pack fails (readback re-reads the snapshot)", async () => {
    await scaffoldArchivedP1();
    const writePlan = await planEventPack(cwd, "P1");
    if (writePlan.kind !== "write") throw new Error("expected write");
    // beforeVerify swaps the on-disk snapshot bytes (valid JSON, but DIFFERENT —
    // pad with whitespace so sha256Hex changes while the parse still succeeds).
    await expect(
      applyEventPackPlan(cwd, writePlan, {
        beforeVerify: async () => {
          const cur = await readFile(phaseSnapshotPath(cwd, "P1"), "utf8");
          await writeFile(phaseSnapshotPath(cwd, "P1"), cur + "\n", "utf8");
        },
      }),
    ).rejects.toMatchObject({ phase: "verify_pack", partial_applied: true });
    // The pack (bound to the ORIGINAL snapshot_sha256) stays on disk — Layer 2
    // does not delete it; the operator is told via next_action.
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true);
  });

  it("a loose event added between plan and verify → verify_pack fails (re-plan uses CURRENT loose)", async () => {
    // The just-written pack was built from 2 loose events; if a 3rd loose event
    // for a snapshot task appears before verify, the re-plan sees a different loose
    // set (hash differs) → pack_stale → verify_pack failure. The verify must use the
    // CURRENT loose, not the stale plan-time set.
    await scaffoldArchivedP1();
    const writePlan = await planEventPack(cwd, "P1");
    if (writePlan.kind !== "write") throw new Error("expected write");
    await expect(
      applyEventPackPlan(cwd, writePlan, {
        beforeVerify: async () => {
          // Add a NEW loose event for the snapshot's task P1-T1 (a later resumed).
          await seedDurableEvents(
            cwd,
            `events:\n  - task_id: P1-T1\n    status: blocked\n    at: 2026-06-01T02:00:00.000Z\n    actor: agent\n    reason: x\n`,
          );
        },
      }),
    ).rejects.toMatchObject({ phase: "verify_pack", partial_applied: true });
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true); // not deleted
  });

  it("loose files DELETED between write and verify → verify_pack fails (no stale loose_remaining_count)", async () => {
    // Option A: Layer 2 never unlinks, so a faithful write leaves EXACTLY the loose
    // set it packed. If a concurrent delete removes the loose files before verify,
    // the re-plan reports already_packed cleanup_pending:false (zero loose) — which
    // does NOT match the write (cleanup_pending:true, loose_remaining_count==2). The
    // apply must fail closed rather than return the stale pre-write count.
    const events = await scaffoldArchivedP1();
    const writePlan = await planEventPack(cwd, "P1");
    if (writePlan.kind !== "write") throw new Error("expected write");
    await expect(
      applyEventPackPlan(cwd, writePlan, {
        beforeVerify: async () => {
          for (const e of events) {
            await rm(join(cwd, ".code-pact", "state", "events", eventFileName(e)));
          }
        },
      }),
    ).rejects.toMatchObject({ phase: "verify_pack", partial_applied: true });
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true); // pack not deleted
  });

  it("a live phase YAML reappears between plan and verify → verify_pack fails", async () => {
    await scaffoldArchivedP1();
    const writePlan = await planEventPack(cwd, "P1");
    if (writePlan.kind !== "write") throw new Error("expected write");
    await expect(
      applyEventPackPlan(cwd, writePlan, {
        beforeVerify: async () => {
          // A live phase doc with id P1 reappears in design/phases/ → the re-plan's
          // discovery scan finds it → phase_file_still_present → verify failure.
          await writeFile(join(cwd, "design", "phases", "P1-back.yaml"), P1_DONE, "utf8");
        },
      }),
    ).rejects.toMatchObject({ phase: "verify_pack", partial_applied: true });
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true);
  });

  it("ExpectedState fail-closed: a concurrent writer creates the pack before rename → write_pack error, partial_applied:false", async () => {
    await scaffoldArchivedP1();
    const writePlan = await planEventPack(cwd, "P1");
    if (writePlan.kind !== "write") throw new Error("expected write");
    // beforeWrite hook places a file at the destination → atomicWriteText {absent} throws.
    let err: unknown;
    try {
      await applyEventPackPlan(cwd, writePlan, {
        beforeWrite: async () => {
          await mkdir(join(cwd, ".code-pact", "state", "archive", "event-packs"), { recursive: true });
          await writeFile(eventPackPath(cwd, "P1"), "concurrent\n", "utf8");
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EventPackWriteError);
    expect((err as EventPackWriteError).phase).toBe("write_pack");
    expect((err as EventPackWriteError).partial_applied).toBe(false);
  });

  it("idempotency: apply, then re-plan sees the pack → already_packed (not a second write)", async () => {
    await scaffoldArchivedP1();
    const first = await planEventPack(cwd, "P1");
    if (first.kind !== "write") throw new Error("expected write");
    expect((await applyEventPackPlan(cwd, first)).kind).toBe("written");
    // Re-plan: pack now exists + loose remain + same hash → already_packed.
    const second = await planEventPack(cwd, "P1");
    expect(second.kind).toBe("noop_already_packed");
    if (second.kind !== "noop_already_packed") return;
    expect(second.cleanup_pending).toBe(true);
  });

  it("re-plan inside apply sees a pack written between plan and apply → already_packed pass-through", async () => {
    const events = await scaffoldArchivedP1();
    const stalePlan = await planEventPack(cwd, "P1");
    if (stalePlan.kind !== "write") throw new Error("expected write");
    // A valid pack lands out-of-band BEFORE apply runs; apply's internal re-plan
    // reclassifies to already_packed and passes through (no throw, no second write).
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    const outcome = await applyEventPackPlan(cwd, stalePlan);
    expect(outcome.kind).toBe("noop_already_packed");
  });
});

describe("planEventPack — corrupt UNRELATED pack does not block the target (sixth-review-3)", () => {
  it("P1 valid pack + zero P1 loose + a corrupt P0 pack → P1 is already_packed (NOT snapshot_evidence_broken)", async () => {
    // P1 fully compacted: valid pack, loose deleted. Evidence resolves only from
    // the P1 pack. A corrupt UNRELATED P0 pack must not discard the P1 pack from
    // the durable map (per-file lenient read) — else P1 would falsely report
    // snapshot_evidence_broken.
    const events = await scaffoldArchivedP1();
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    for (const e of events) {
      await rm(join(cwd, ".code-pact", "state", "events", eventFileName(e)));
    }
    // Plant a corrupt P0 pack alongside.
    await writeEventPackFile(cwd, "P0", { not: "a valid pack" });
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("noop_already_packed");
    if (plan.kind !== "noop_already_packed") return;
    expect(plan.cleanup_pending).toBe(false);
  });

  it("P1 CORRUPT target pack + zero loose → ineligible(pack_invalid), NOT snapshot_evidence_broken", async () => {
    const events = await scaffoldArchivedP1();
    for (const e of events) {
      await rm(join(cwd, ".code-pact", "state", "events", eventFileName(e)));
    }
    // The TARGET pack itself is corrupt.
    await writeEventPackFile(cwd, "P1", { not: "valid" });
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("ineligible");
    if (plan.kind !== "ineligible") return;
    expect(plan.block.kind).toBe("pack_invalid");
  });

  it("P1 target pack Tier-1-valid but snapshot_sha256 mismatch + zero loose → pack_invalid, NOT snapshot_evidence_broken", async () => {
    // The third-review blocker: a Tier-1-valid pack that fails Tier-2 binding is
    // dropped from validatedPackFiles by the lenient read. With loose at zero the
    // evidence would otherwise be unresolved and misreport snapshot_evidence_broken;
    // the existing-pack Tier-2 binding must run FIRST and pin pack_invalid.
    const events = await scaffoldArchivedP1();
    const pack = await buildValidEventPack(cwd, "P1", events);
    pack.snapshot_sha256 = "0".repeat(64); // wrong binding — Tier-1 still passes
    await writeEventPackFile(cwd, "P1", pack);
    for (const e of events) {
      await rm(join(cwd, ".code-pact", "state", "events", eventFileName(e)));
    }
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("ineligible");
    if (plan.kind !== "ineligible") return;
    expect(plan.block.kind).toBe("pack_invalid");
    if (plan.block.kind !== "pack_invalid") return;
    expect(plan.block.detail).toMatch(/snapshot_sha256|binding|snapshot/i);
  });

  it("P1 target pack Tier-1-valid but a foreign task_id (not in snapshot) + zero loose → pack_invalid, NOT snapshot_evidence_broken", async () => {
    // Tier-2 task-membership failure: same lenient-drop path, same misdiagnosis
    // risk. Recompute event_ids_sha256 so the tampered pack stays Tier-1-valid.
    const events = await scaffoldArchivedP1();
    const foreign: ProgressEvent = {
      task_id: "P9-T9",
      status: "done",
      at: "2026-06-02T00:00:00.000Z",
      actor: "agent",
    };
    const pack = await buildValidEventPack(cwd, "P1", [...events, foreign]);
    await writeEventPackFile(cwd, "P1", pack);
    for (const e of events) {
      await rm(join(cwd, ".code-pact", "state", "events", eventFileName(e)));
    }
    const plan = await planEventPack(cwd, "P1");
    expect(plan.kind).toBe("ineligible");
    if (plan.kind !== "ineligible") return;
    expect(plan.block.kind).toBe("pack_invalid");
  });
});
