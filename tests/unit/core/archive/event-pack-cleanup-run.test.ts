import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import {
  unlinkGatedLoose,
} from "../../../../src/core/archive/event-pack-cleanup-run.ts";
import {
  looseEventRelPath,
  type DeleteGateContext,
} from "../../../../src/core/archive/event-pack-cleanup-gate.ts";
import { phaseSnapshotPath } from "../../../../src/core/archive/paths.ts";
import { eventFileName } from "../../../../src/core/progress/event-id.ts";
import { eventsDir } from "../../../../src/core/progress/events-io.ts";
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

/** A LIVE phase with a DIFFERENT id (P99) that re-uses task id P1-T1. */
const P99_REUSES_P1T1 = `id: P99
name: Re-user
weight: 1
confidence: high
risk: low
status: in_progress
objective: re-use a task id
definition_of_done:
  - it works
verification:
  commands:
    - pnpm test
tasks:
  - id: P1-T1
    type: feature
${TASK_FIELDS}
    status: planned
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
  cwd = await mkdtemp(join(tmpdir(), "code-pact-cleanup-run-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(join(eventsDir(cwd), file));
    return true;
  } catch {
    return false;
  }
};

/** Archive P1 + write a full valid pack; return events, a gate ctx, and the loose
 *  target filenames in [started, done] order. */
async function archivedWithPack(): Promise<{
  events: ProgressEvent[];
  ctx: DeleteGateContext;
  startedFile: string;
  doneFile: string;
  target: string[];
}> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await seedDurableEvents(cwd, STARTED_DONE);
  expect((await writePhaseSnapshot(cwd, "P1", { now: NOW })).kind).toBe("written");
  await rm(join(cwd, "design", "phases", "P1-x.yaml"));
  await writeFile(join(cwd, "design", "roadmap.yaml"), "phases: []\n", "utf8");
  const { ProgressLog } = await import("../../../../src/core/schemas/progress-event.ts");
  const { parse } = await import("yaml");
  const events = ProgressLog.parse(parse(STARTED_DONE)).events;

  const pack = await buildValidEventPack(cwd, "P1", events);
  await writeEventPackFile(cwd, "P1", pack);
  const ctx: DeleteGateContext = {
    snapshotTaskIds: new Set(["P1-T1"]),
    packIds: new Set(pack.events.map((e) => e.id)),
    packSnapshotSha256: pack.snapshot_sha256,
    snapshotPath: phaseSnapshotPath(cwd, "P1"),
  };
  const startedFile = eventFileName(events.find((e) => e.status === "started")!);
  const doneFile = eventFileName(events.find((e) => e.status === "done")!);
  return { events, ctx, startedFile, doneFile, target: [startedFile, doneFile] };
}

describe("unlinkGatedLoose — the gated unlink loop (THE destructive core)", () => {
  it("all gates pass → every target file is unlinked and gone from disk; abort null", async () => {
    const { ctx, startedFile, doneFile, target } = await archivedWithPack();
    const r = await unlinkGatedLoose(cwd, target, ctx);
    expect(r.abort).toBeNull();
    expect(r.deleted.sort()).toEqual([startedFile, doneFile].sort());
    expect(r.skipped).toEqual([]);
    expect(r.vanished).toEqual([]);
    expect(await exists(startedFile)).toBe(false);
    expect(await exists(doneFile)).toBe(false);
  });

  it("G6 live owner present from the start → aborts on the first file, NOTHING deleted", async () => {
    const { ctx, startedFile, doneFile, target } = await archivedWithPack();
    await writeFile(join(cwd, "design", "phases", "P99-reuser.yaml"), P99_REUSES_P1T1, "utf8");
    const r = await unlinkGatedLoose(cwd, target, ctx);
    expect(r.abort).not.toBeNull();
    expect(r.abort?.reason).toBe("live_task_owner");
    expect(r.deleted).toEqual([]);
    // Fail-closed: no file removed once a live owner is detected.
    expect(await exists(startedFile)).toBe(true);
    expect(await exists(doneFile)).toBe(true);
  });

  it("ordered abort: an owner appears before the 2nd file's gate → 1st deleted, loop stops, 2nd remains", async () => {
    const { ctx, startedFile, doneFile, target } = await archivedWithPack();
    const r = await unlinkGatedLoose(cwd, target, ctx, {
      beforeGate: async (file) => {
        // Inject the live owner right before the SECOND file (done) is gated.
        if (file === doneFile) {
          await writeFile(join(cwd, "design", "phases", "P99-reuser.yaml"), P99_REUSES_P1T1, "utf8");
        }
      },
    });
    expect(r.deleted).toEqual([startedFile]); // first removed before the abort
    expect(r.abort?.reason).toBe("live_task_owner");
    expect(await exists(startedFile)).toBe(false);
    expect(await exists(doneFile)).toBe(true); // never removed
  });

  it("a foreign-task file in the target → skip(task_not_in_snapshot); the rest are deleted", async () => {
    const { ctx, startedFile, doneFile, target } = await archivedWithPack();
    // A ctx whose snapshot does NOT include P1-T1's sibling — seed a foreign loose
    // event and add it to the target.
    await seedDurableEvents(
      cwd,
      `events:\n  - task_id: P9-T9\n    status: done\n    at: 2026-06-02T00:00:00.000Z\n    actor: agent\n`,
    );
    const { ProgressLog } = await import("../../../../src/core/schemas/progress-event.ts");
    const foreignFile = eventFileName(
      ProgressLog.parse({
        events: [{ task_id: "P9-T9", status: "done", at: "2026-06-02T00:00:00.000Z", actor: "agent" }],
      }).events[0]!,
    );
    const r = await unlinkGatedLoose(cwd, [...target, foreignFile], ctx);
    expect(r.abort).toBeNull();
    expect(r.deleted.sort()).toEqual([startedFile, doneFile].sort());
    expect(r.skipped).toEqual([{ path: looseEventRelPath(foreignFile), reason: "task_not_in_snapshot" }]);
    expect(await exists(foreignFile)).toBe(true); // a non-snapshot file is never removed
  });

  it("gate-time vanish: the file is deleted before its gate → vanished, not deleted", async () => {
    const { ctx, startedFile, doneFile, target } = await archivedWithPack();
    const r = await unlinkGatedLoose(cwd, target, ctx, {
      beforeGate: async (file) => {
        if (file === startedFile) await rm(join(eventsDir(cwd), startedFile));
      },
    });
    expect(r.abort).toBeNull();
    expect(r.vanished).toEqual([startedFile]);
    expect(r.deleted).toEqual([doneFile]);
  });

  it("unlink-time vanish: the file is deleted in the gate→unlink window → vanished (ENOENT), not deleted", async () => {
    const { ctx, startedFile, doneFile, target } = await archivedWithPack();
    const r = await unlinkGatedLoose(cwd, target, ctx, {
      beforeUnlink: async (file) => {
        // Race a delete AFTER the gate passed but BEFORE our unlink.
        if (file === startedFile) await rm(join(eventsDir(cwd), startedFile));
      },
    });
    expect(r.abort).toBeNull();
    expect(r.vanished).toEqual([startedFile]); // ENOENT at unlink → vanished, not a survivor
    expect(r.deleted).toEqual([doneFile]);
  });

  it("a skip FIRST does not stop the loop — subsequent files are still deleted", async () => {
    const { ctx, startedFile, doneFile } = await archivedWithPack();
    await seedDurableEvents(
      cwd,
      `events:\n  - task_id: P9-T9\n    status: done\n    at: 2026-06-02T00:00:00.000Z\n    actor: agent\n`,
    );
    const { ProgressLog } = await import("../../../../src/core/schemas/progress-event.ts");
    const foreignFile = eventFileName(
      ProgressLog.parse({
        events: [{ task_id: "P9-T9", status: "done", at: "2026-06-02T00:00:00.000Z", actor: "agent" }],
      }).events[0]!,
    );
    // Foreign (skippable) file FIRST, then the two good files — the skip must use
    // `continue`, not stop the loop.
    const r = await unlinkGatedLoose(cwd, [foreignFile, startedFile, doneFile], ctx);
    expect(r.abort).toBeNull();
    expect(r.skipped).toEqual([{ path: looseEventRelPath(foreignFile), reason: "task_not_in_snapshot" }]);
    expect(r.deleted.sort()).toEqual([startedFile, doneFile].sort());
    expect(await exists(foreignFile)).toBe(true);
  });

  it("unlink-time vanish on the SECOND file → vanished:[doneFile], deleted:[startedFile]", async () => {
    const { ctx, startedFile, doneFile, target } = await archivedWithPack();
    const r = await unlinkGatedLoose(cwd, target, ctx, {
      beforeUnlink: async (file) => {
        if (file === doneFile) await rm(join(eventsDir(cwd), doneFile));
      },
    });
    expect(r.abort).toBeNull();
    expect(r.deleted).toEqual([startedFile]);
    expect(r.vanished).toEqual([doneFile]);
  });
});
