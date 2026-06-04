import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import { loadMergedProgress } from "../../../../src/core/progress/io.ts";
import { eventFileName } from "../../../../src/core/progress/event-id.ts";
import {
  eventsDir,
  readEventFiles,
  writeEventFile,
} from "../../../../src/core/progress/events-io.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cp-events-"));
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

async function writeLegacy(events: ProgressEvent[]): Promise<void> {
  await writeFile(
    join(dir, ".code-pact", "state", "progress.yaml"),
    toYaml({ events }),
    "utf8",
  );
}

describe("merged progress — legacy-only fast path (B3)", () => {
  it("returns legacy events in ARRAY order, unsorted, when no event files exist", async () => {
    // Array order deliberately disagrees with `at` order.
    await writeLegacy([
      ev({ task_id: "P1-T2", at: "2026-05-18T12:00:00.000Z" }),
      ev({ task_id: "P1-T1", at: "2026-05-18T10:00:00.000Z" }),
    ]);
    const { log } = await loadMergedProgress(dir);
    expect(log.events.map((e) => e.task_id)).toEqual(["P1-T2", "P1-T1"]);
  });

  it("treats a missing progress.yaml as an empty log", async () => {
    const { log } = await loadMergedProgress(dir);
    expect(log.events).toEqual([]);
  });
});

describe("merged progress — event files (B1/B2/B3)", () => {
  it("writer is idempotent: same event twice -> one file, alreadyExisted second time", async () => {
    const e = ev({ status: "done", source: "loop", at: "2026-05-18T11:00:00.000Z" });
    const first = await writeEventFile(dir, e);
    const second = await writeEventFile(dir, e);
    expect(first.alreadyExisted).toBe(false);
    expect(second.alreadyExisted).toBe(true);
    expect(second.id).toBe(first.id);
    expect((await readdir(eventsDir(dir))).length).toBe(1);
  });

  it("fails closed when an existing file's content does not match its filename id (EEXIST verify)", async () => {
    const e = ev({ status: "started", at: "2026-05-18T10:00:00.000Z" });
    await mkdir(eventsDir(dir), { recursive: true });
    // Put a DIFFERENT (valid) event at e's canonical path — a corrupt/partial
    // write or manual edit. The writer must NOT report idempotent success.
    await writeFile(
      join(eventsDir(dir), eventFileName(e)),
      toYaml(ev({ status: "done", source: "loop", at: "2026-05-18T10:00:00.000Z" })),
      "utf8",
    );
    await expect(writeEventFile(dir, e)).rejects.toMatchObject({
      code: "EVENT_FILE_ID_MISMATCH",
    });
  });

  it("readEventFiles rejects a file whose content id != filename id", async () => {
    await mkdir(eventsDir(dir), { recursive: true });
    const lyingName = `20260518T100000000Z-${"a".repeat(64)}.yaml`;
    await writeFile(
      join(eventsDir(dir), lyingName),
      toYaml(ev({ status: "started", at: "2026-05-18T10:00:00.000Z" })),
      "utf8",
    );
    await expect(readEventFiles(dir)).rejects.toMatchObject({ code: "EVENT_FILE_ID_MISMATCH" });
  });

  it("readEventFiles rejects a file whose stored id != content id", async () => {
    const { path } = await writeEventFile(
      dir,
      ev({ status: "started", at: "2026-05-18T10:00:00.000Z" }),
    );
    // Tamper only the stored `id`; filename + body stay self-consistent.
    const doc = parseYaml(await readFile(path, "utf8")) as Record<string, unknown>;
    doc.id = "b".repeat(64);
    await writeFile(path, toYaml(doc), "utf8");
    await expect(readEventFiles(dir)).rejects.toMatchObject({ code: "EVENT_FILE_ID_MISMATCH" });
  });

  it("EEXIST fails closed when the existing file has a WRONG stored id (writer shares the reader invariant)", async () => {
    const e = ev({ status: "started", at: "2026-05-18T10:00:00.000Z" });
    await mkdir(eventsDir(dir), { recursive: true });
    // Correct body + correct filename, but a corrupted stored `id`. The writer
    // must NOT report idempotent success over this (the reader would reject it).
    await writeFile(
      join(eventsDir(dir), eventFileName(e)),
      toYaml({ ...e, id: "b".repeat(64) }),
      "utf8",
    );
    await expect(writeEventFile(dir, e)).rejects.toMatchObject({ code: "EVENT_FILE_ID_MISMATCH" });
  });

  it("readEventFiles rejects a file whose at-compact prefix disagrees with event.at", async () => {
    const e = ev({ status: "started", at: "2026-05-18T10:00:00.000Z" });
    await mkdir(eventsDir(dir), { recursive: true });
    // Correct content id in the name, but a lying at-compact prefix.
    const lyingName = eventFileName(e).replace(/^\d{8}T\d{9}Z/, "20990101T000000000Z");
    await writeFile(join(eventsDir(dir), lyingName), toYaml(e), "utf8");
    await expect(readEventFiles(dir)).rejects.toMatchObject({ code: "EVENT_FILE_ID_MISMATCH" });
  });

  it("readEventFiles tags an unparseable event body INVALID_YAML (not SCHEMA_ERROR)", async () => {
    await mkdir(eventsDir(dir), { recursive: true });
    // Structurally valid event-file name, but the body is not parseable YAML.
    const name = `20260518T100000000Z-${"a".repeat(64)}.yaml`;
    await writeFile(join(eventsDir(dir), name), "{ unclosed flow mapping", "utf8");
    await expect(readEventFiles(dir)).rejects.toMatchObject({ code: "INVALID_YAML" });
  });

  it("readEventFiles tags a parseable-but-invalid event body SCHEMA_ERROR (not EVENT_FILE_ID_MISMATCH)", async () => {
    await mkdir(eventsDir(dir), { recursive: true });
    // Parses as YAML, but is not a ProgressEvent — the schema check must fire
    // BEFORE the id check, so the code is SCHEMA_ERROR rather than a mismatch.
    const name = `20260518T100000000Z-${"a".repeat(64)}.yaml`;
    await writeFile(join(eventsDir(dir), name), toYaml({ status: "not_a_status" }), "utf8");
    await expect(readEventFiles(dir)).rejects.toMatchObject({ code: "SCHEMA_ERROR" });
  });

  it("readEventFiles rejects a present-but-non-string stored id", async () => {
    const { path } = await writeEventFile(
      dir,
      ev({ status: "started", at: "2026-05-18T10:00:00.000Z" }),
    );
    const doc = parseYaml(await readFile(path, "utf8")) as Record<string, unknown>;
    doc.id = 123; // present but not a string
    await writeFile(path, toYaml(doc), "utf8");
    await expect(readEventFiles(dir)).rejects.toMatchObject({ code: "EVENT_FILE_ID_MISMATCH" });
  });

  it("readEventFiles ignores in-progress temp files (dot-prefixed, never match the event-file pattern)", async () => {
    await writeEventFile(dir, ev({ status: "started", at: "2026-05-18T10:00:00.000Z" }));
    // a leftover temp from an interrupted/crashed write must be ignored, not parsed
    await writeFile(
      join(eventsDir(dir), `.tmp-123-0-20260518T100000000Z-${"a".repeat(64)}.yaml`),
      "partial: yam", // intentionally incomplete/odd content
      "utf8",
    );
    expect(await readEventFiles(dir)).toHaveLength(1); // only the published event
  });

  it("two distinct concurrent events both survive (no lost update)", async () => {
    await Promise.all([
      writeEventFile(dir, ev({ status: "started", at: "2026-05-18T10:00:00.000Z" })),
      writeEventFile(dir, ev({ status: "done", source: "loop", at: "2026-05-18T10:05:00.000Z" })),
    ]);
    expect((await readEventFiles(dir)).length).toBe(2);
  });

  it("merges + sorts event files by (at, id), independent of filesystem order", async () => {
    await writeEventFile(dir, ev({ status: "done", source: "loop", at: "2026-05-18T10:05:00.000Z" }));
    await writeEventFile(dir, ev({ status: "started", at: "2026-05-18T10:00:00.000Z" }));
    const { log } = await loadMergedProgress(dir);
    expect(log.events.map((e) => e.status)).toEqual(["started", "done"]);
  });

  it("dedups a legacy event that was also migrated to an event file", async () => {
    const e = ev({ status: "started", at: "2026-05-18T10:00:00.000Z" });
    await writeLegacy([e]);
    await writeEventFile(dir, e); // same content -> same id
    const { log } = await loadMergedProgress(dir);
    expect(log.events).toHaveLength(1);
  });

  it("merges legacy + new event files into one ordered, deduped stream", async () => {
    await writeLegacy([ev({ status: "started", at: "2026-05-18T10:00:00.000Z" })]);
    await writeEventFile(dir, ev({ status: "done", source: "loop", at: "2026-05-18T10:30:00.000Z" }));
    const { log } = await loadMergedProgress(dir);
    expect(log.events.map((e) => e.status)).toEqual(["started", "done"]);
  });

  it("merge sorts by `at` — an earlier event file precedes a LATER-`at` legacy event (not legacy-first)", async () => {
    await writeLegacy([ev({ status: "done", source: "loop", at: "2026-05-18T12:00:00.000Z" })]); // later
    await writeEventFile(dir, ev({ status: "started", at: "2026-05-18T10:00:00.000Z" })); // earlier
    const { log } = await loadMergedProgress(dir);
    // event-file event (earlier `at`) sorts first; would be ["done","started"] if the merge favored legacy-first
    expect(log.events.map((e) => e.status)).toEqual(["started", "done"]);
  });
});
