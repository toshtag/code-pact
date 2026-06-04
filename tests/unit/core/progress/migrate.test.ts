import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import { migrateProgressToEvents } from "../../../../src/core/progress/migrate.ts";
import { loadMergedProgress } from "../../../../src/core/progress/io.ts";
import { eventsDir, readEventFiles } from "../../../../src/core/progress/events-io.ts";
import { deriveTaskState } from "../../../../src/core/progress/task-state.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cp-migrate-"));
  await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ev = (over: Partial<ProgressEvent>): ProgressEvent => ({
  task_id: "P1-T1",
  status: "started",
  at: "2026-05-18T10:00:00.000Z",
  actor: "agent",
  agent: "claude-code",
  ...over,
});

const writeLegacy = (events: ProgressEvent[]) =>
  writeFile(join(dir, ".code-pact", "state", "progress.yaml"), toYaml({ events }), "utf8");

describe("migrateProgressToEvents (B4)", () => {
  it("golden: legacy progress.yaml → event files; merged derived state is identical", async () => {
    const legacy: ProgressEvent[] = [
      ev({ status: "started", at: "2026-05-18T10:00:00.000Z" }),
      ev({ status: "done", source: "loop", at: "2026-05-18T11:00:00.000Z" }),
    ];
    await writeLegacy(legacy);

    const before = deriveTaskState(legacy, "P1-T1").current; // legacy reducer input

    const res = await migrateProgressToEvents(dir, { write: true });
    expect(res.written).toBe(2);
    expect(res.already_present).toBe(0);
    expect(res.legacy_events).toBe(2);
    expect((await readEventFiles(dir)).length).toBe(2);

    // derived state via the merged view equals the legacy-only derived state
    const after = deriveTaskState((await loadMergedProgress(dir)).log.events, "P1-T1").current;
    expect(after).toBe(before);
    expect(after).toBe("done");
  });

  it("dry-run writes nothing and reports counts", async () => {
    await writeLegacy([ev({ status: "started" })]);
    const res = await migrateProgressToEvents(dir, { write: false });
    expect(res.dry_run).toBe(true);
    expect(res.legacy_events).toBe(1);
    expect(res.written).toBe(0);
    await expect(readdir(eventsDir(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is idempotent: a second run writes nothing new", async () => {
    await writeLegacy([
      ev({ status: "started", at: "2026-05-18T10:00:00.000Z" }),
      ev({ status: "done", source: "loop", at: "2026-05-18T11:00:00.000Z" }),
    ]);
    const first = await migrateProgressToEvents(dir, { write: true });
    expect(first.written).toBe(2);
    const second = await migrateProgressToEvents(dir, { write: true });
    expect(second.written).toBe(0);
    expect(second.already_present).toBe(2);
    expect((await readEventFiles(dir)).length).toBe(2);
  });

  it("reports a derived-state change when legacy array order disagrees with `at` order", async () => {
    // Array order says the last event is `started`, but `at` order says `done`
    // is later — so the merged view derives `done`, not `started`.
    await writeLegacy([
      ev({ status: "done", source: "loop", at: "2026-05-18T11:00:00.000Z" }),
      ev({ status: "started", at: "2026-05-18T10:00:00.000Z" }),
    ]);
    const res = await migrateProgressToEvents(dir, { write: false });
    expect(res.state_changes).toEqual([
      { task_id: "P1-T1", before: "started", after: "done" },
    ]);
  });

  it("no-op on a repo with no progress.yaml", async () => {
    const res = await migrateProgressToEvents(dir, { write: true });
    expect(res.legacy_events).toBe(0);
    expect(res.written).toBe(0);
    expect(res.state_changes).toEqual([]);
  });
});
