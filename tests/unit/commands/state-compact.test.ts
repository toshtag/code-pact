import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseSnapshot } from "../../../src/core/archive/phase-snapshot.ts";
import { runStateCompact } from "../../../src/commands/state-compact.ts";
import { eventPackPath } from "../../../src/core/archive/paths.ts";
import { eventFileName } from "../../../src/core/progress/event-id.ts";
import { seedDurableEvents } from "../../helpers/seed-events.ts";

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

const STARTED_DONE = `events:
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
  cwd = await mkdtemp(join(tmpdir(), "code-pact-statecompact-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/** Archived P1: snapshot written, loose events present, phase YAML deleted. */
async function scaffoldArchivedP1() {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await seedDurableEvents(cwd, STARTED_DONE);
  expect((await writePhaseSnapshot(cwd, "P1", { now: NOW })).kind).toBe("written");
  await rm(join(cwd, "design", "phases", "P1-x.yaml"));
  await writeFile(join(cwd, "design", "roadmap.yaml"), "phases: []\n", "utf8");
  const { ProgressLog } = await import("../../../src/core/schemas/progress-event.ts");
  const { parse } = await import("yaml");
  return ProgressLog.parse(parse(STARTED_DONE)).events;
}

describe("runStateCompact — dry-run", () => {
  it("eligible phase → would_pack with counts + cleanup_pending, writes nothing", async () => {
    await scaffoldArchivedP1();
    const r = await runStateCompact({ cwd, phaseId: "P1", write: false });
    expect(r.kind).toBe("would_pack");
    if (r.kind !== "would_pack") return;
    expect(r.would_pack_event_count).toBe(2);
    expect(r.would_leave_loose_count).toBe(2);
    expect(r.cleanup_pending).toBe(true);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false); // dry-run wrote nothing
  });

  it("phase YAML still present → ineligible(phase_file_still_present)", async () => {
    await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
    await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
    await seedDurableEvents(cwd, STARTED_DONE);
    expect((await writePhaseSnapshot(cwd, "P1", { now: NOW })).kind).toBe("written");
    const r = await runStateCompact({ cwd, phaseId: "P1", write: false });
    expect(r.kind).toBe("ineligible");
    if (r.kind !== "ineligible") return;
    expect(r.block.kind).toBe("phase_file_still_present");
  });

  it("duplicate phase id (AMBIGUOUS_PHASE_ID) → ineligible(ambiguous_phase_id), no pack", async () => {
    await scaffoldArchivedP1();
    await writeFile(join(cwd, "design", "phases", "P1-a.yaml"), P1_DONE, "utf8");
    await writeFile(join(cwd, "design", "phases", "P1-b.yaml"), P1_DONE, "utf8");
    await writeFile(
      join(cwd, "design", "roadmap.yaml"),
      `phases:\n  - id: P1\n    path: design/phases/P1-a.yaml\n    weight: 1\n  - id: P1\n    path: design/phases/P1-b.yaml\n    weight: 1\n`,
      "utf8",
    );
    const r = await runStateCompact({ cwd, phaseId: "P1", write: true });
    expect(r.kind).toBe("ineligible");
    if (r.kind !== "ineligible") return;
    expect(r.block.kind).toBe("ambiguous_phase_id");
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false); // fail closed — no pack
  });
});

describe("runStateCompact — --write", () => {
  it("eligible → packed with cleanup_pending:true, loose_deleted_count:0, files UNTOUCHED", async () => {
    const events = await scaffoldArchivedP1();
    const r = await runStateCompact({ cwd, phaseId: "P1", write: true });
    expect(r.kind).toBe("packed");
    if (r.kind !== "packed") return;
    expect(r.packed_event_count).toBe(2);
    expect(r.loose_remaining_count).toBe(2);
    expect(r.loose_deleted_count).toBe(0);
    expect(r.cleanup_pending).toBe(true);
    expect(r.next_action).toMatch(/Layer 3/);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true);
    // Layer 2 leaves loose files on disk.
    for (const e of events) {
      expect(await exists(join(cwd, ".code-pact", "state", "events", eventFileName(e)))).toBe(true);
    }
  });

  it("re-run after packing → already_packed cleanup_pending:true (loose still remain)", async () => {
    await scaffoldArchivedP1();
    expect((await runStateCompact({ cwd, phaseId: "P1", write: true })).kind).toBe("packed");
    const again = await runStateCompact({ cwd, phaseId: "P1", write: true });
    expect(again.kind).toBe("already_packed");
    if (again.kind !== "already_packed") return;
    expect(again.cleanup_pending).toBe(true);
  });
});

describe("runStateCompact — archived-phase lookup (sixth-review must-have)", () => {
  it("design/phases/P1.yaml ABSENT + snapshot PRESENT → runs (does NOT die on PHASE_NOT_FOUND)", async () => {
    // scaffoldArchivedP1 deletes the YAML and empties the roadmap — the normal
    // archived state. state compact must treat the snapshot as the authority.
    await scaffoldArchivedP1();
    const r = await runStateCompact({ cwd, phaseId: "P1", write: false });
    // Any non-throwing verdict is acceptable; the point is it does NOT raise
    // PHASE_NOT_FOUND. Here the eligible phase yields would_pack.
    expect(["would_pack", "would_already_packed", "would_noop_no_events"]).toContain(r.kind);
  });

  it("works even with NO roadmap at all (snapshot is the sole authority)", async () => {
    await scaffoldArchivedP1();
    await rm(join(cwd, "design", "roadmap.yaml"));
    const r = await runStateCompact({ cwd, phaseId: "P1", write: false });
    expect(r.kind).toBe("would_pack");
  });
});
