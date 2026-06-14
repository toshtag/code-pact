import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseSnapshot } from "../../../src/core/archive/phase-snapshot.ts";
import { runStateCompact } from "../../../src/commands/state-compact.ts";
import { eventPackPath } from "../../../src/core/archive/paths.ts";
import { eventFileName } from "../../../src/core/progress/event-id.ts";
import { seedDurableEvents } from "../../helpers/seed-events.ts";
import { buildValidEventPack, writeEventPackFile } from "../../helpers/event-pack-fixture.ts";

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
    // --write fails closed: the cleanup outcome is ineligible, nothing written.
    expect(r.kind).toBe("cleanup_outcome");
    if (r.kind !== "cleanup_outcome" || r.outcome.ok) return;
    expect(r.outcome.code).toBe("STATE_COMPACT_INELIGIBLE");
    if (r.outcome.code !== "STATE_COMPACT_INELIGIBLE") return;
    expect(r.outcome.block.kind).toBe("ambiguous_phase_id");
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false); // fail closed — no pack
  });

  it("dry-run: loose is a strict subset after a partial cleanup → would_already_packed, loose_relationship:strict_subset", async () => {
    const events = await scaffoldArchivedP1();
    // Pack covers both events, loose remain; then a partial cleanup removed one.
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    const started = events.find((e) => e.status === "started")!;
    await rm(join(cwd, ".code-pact", "state", "events", eventFileName(started)));
    const r = await runStateCompact({ cwd, phaseId: "P1", write: false });
    expect(r.kind).toBe("would_already_packed");
    if (r.kind !== "would_already_packed") return;
    expect(r.cleanup_pending).toBe(true);
    expect(r.loose_remaining_count).toBe(1);
    expect(r.loose_relationship).toBe("strict_subset");
  });
});

describe("runStateCompact — --write (Layer 3: writes the pack AND deletes loose)", () => {
  it("eligible (no pack) → cleanup_outcome cleaned; pack written AND every loose file deleted", async () => {
    const events = await scaffoldArchivedP1();
    const r = await runStateCompact({ cwd, phaseId: "P1", write: true });
    expect(r.kind).toBe("cleanup_outcome");
    if (r.kind !== "cleanup_outcome" || !r.outcome.ok) return;
    expect(r.outcome.kind).toBe("cleaned");
    if (r.outcome.kind !== "cleaned") return;
    expect(r.outcome.loose_deleted_count).toBe(2);
    expect(r.outcome.cleanup_remaining_loose).toBe(0);
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(true); // pack is the durable record
    // Every loose file is gone.
    for (const e of events) {
      expect(await exists(join(cwd, ".code-pact", "state", "events", eventFileName(e)))).toBe(false);
    }
  });

  it("re-run after a clean → already_cleaned (pack covers it, no loose remain)", async () => {
    await scaffoldArchivedP1();
    // The FIRST run must actually clean (deletes loose) — assert it, so a regression
    // where it returned already_cleaned prematurely can't be masked by the re-run.
    const first = await runStateCompact({ cwd, phaseId: "P1", write: true });
    expect(first.kind).toBe("cleanup_outcome");
    if (first.kind !== "cleanup_outcome" || !first.outcome.ok) return;
    expect(first.outcome.kind).toBe("cleaned");
    if (first.outcome.kind !== "cleaned") return;
    expect(first.outcome.loose_deleted_count).toBeGreaterThan(0);
    const again = await runStateCompact({ cwd, phaseId: "P1", write: true });
    expect(again.kind).toBe("cleanup_outcome");
    if (again.kind !== "cleanup_outcome" || !again.outcome.ok) return;
    expect(again.outcome.kind).toBe("already_cleaned");
  });

  it("pack covers it but a partial cleanup left a loose subset → cleaned; the remnant is removed", async () => {
    const events = await scaffoldArchivedP1();
    // Pack already covers the full event set; a prior partial cleanup left one loose.
    await writeEventPackFile(cwd, "P1", await buildValidEventPack(cwd, "P1", events));
    const started = events.find((e) => e.status === "started")!;
    await rm(join(cwd, ".code-pact", "state", "events", eventFileName(started)));
    const r = await runStateCompact({ cwd, phaseId: "P1", write: true });
    expect(r.kind).toBe("cleanup_outcome");
    if (r.kind !== "cleanup_outcome" || !r.outcome.ok) return;
    expect(r.outcome.kind).toBe("cleaned");
    if (r.outcome.kind !== "cleaned") return;
    expect(r.outcome.loose_deleted_count).toBe(1);
    expect(r.outcome.cleanup_remaining_loose).toBe(0);
    // The remaining loose file (the `done` event) is removed.
    const done = events.find((e) => e.status === "done")!;
    expect(await exists(join(cwd, ".code-pact", "state", "events", eventFileName(done)))).toBe(false);
  });
});

describe("runStateCompact — archived-phase lookup (does NOT die on PHASE_NOT_FOUND)", () => {
  it("no live YAML + snapshot present → runs (snapshot is the authority, no PHASE_NOT_FOUND crash)", async () => {
    // scaffoldArchivedP1 deletes the YAML and empties the roadmap — the normal
    // archived state. No design/phases/*.yaml has id P1, so the scan finds nothing.
    await scaffoldArchivedP1();
    const r = await runStateCompact({ cwd, phaseId: "P1", write: false });
    expect(["would_pack", "would_already_packed", "would_noop_no_events"]).toContain(r.kind);
  });

  it("empty roadmap + NO matching live YAML + snapshot present → would_pack", async () => {
    await scaffoldArchivedP1(); // YAML deleted, roadmap empty, no live P1 YAML on disk
    const r = await runStateCompact({ cwd, phaseId: "P1", write: false });
    expect(r.kind).toBe("would_pack");
  });
});

describe("runStateCompact — live phase YAML the roadmap doesn't name (sixth-review-2 fail-open fix)", () => {
  it("roadmap MISSING but an orphan live YAML with id P1 exists → ineligible(phase_file_still_present), NO pack", async () => {
    await scaffoldArchivedP1(); // snapshot present, roadmap empty
    await rm(join(cwd, "design", "roadmap.yaml")); // no roadmap at all
    // A live phase doc with id P1 sits in design/phases/ under a different name.
    await writeFile(join(cwd, "design", "phases", "P1-orphan.yaml"), P1_DONE, "utf8");
    const r = await runStateCompact({ cwd, phaseId: "P1", write: false });
    expect(r.kind).toBe("ineligible");
    if (r.kind !== "ineligible") return;
    expect(r.block.kind).toBe("phase_file_still_present");
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false); // fail closed
  });

  it("roadmap present but does NOT reference P1, yet an orphan live YAML with id P1 exists → ineligible(phase_file_still_present)", async () => {
    await scaffoldArchivedP1();
    // roadmap is non-empty but references a DIFFERENT phase, not P1.
    await writeFile(
      join(cwd, "design", "roadmap.yaml"),
      `phases:\n  - id: P9\n    path: design/phases/P9.yaml\n    weight: 1\n`,
      "utf8",
    );
    await writeFile(join(cwd, "design", "phases", "P1-orphan.yaml"), P1_DONE, "utf8");
    const r = await runStateCompact({ cwd, phaseId: "P1", write: false });
    expect(r.kind).toBe("ineligible");
    if (r.kind !== "ineligible") return;
    expect(r.block.kind).toBe("phase_file_still_present");
    expect(await exists(eventPackPath(cwd, "P1"))).toBe(false);
  });

  it("TWO orphan live YAMLs with id P1 (roadmap missing) → ineligible(ambiguous_phase_id)", async () => {
    await scaffoldArchivedP1();
    await rm(join(cwd, "design", "roadmap.yaml"));
    await writeFile(join(cwd, "design", "phases", "P1-a.yaml"), P1_DONE, "utf8");
    await writeFile(join(cwd, "design", "phases", "P1-b.yaml"), P1_DONE, "utf8");
    const r = await runStateCompact({ cwd, phaseId: "P1", write: false });
    expect(r.kind).toBe("ineligible");
    if (r.kind !== "ineligible") return;
    expect(r.block.kind).toBe("ambiguous_phase_id");
  });
});
