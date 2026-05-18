import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  appendEvent,
  atomicWriteYaml,
  loadProgressLog,
  progressPath,
} from "../../../../src/core/progress/io.ts";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";

describe("progress io", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "code-pact-progress-io-"));
    await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
    await writeFile(
      progressPath(cwd),
      stringifyYaml({ events: [] }),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("loadProgressLog returns parsed events", async () => {
    const { log, path } = await loadProgressLog(cwd);
    expect(log.events).toEqual([]);
    expect(path).toBe(progressPath(cwd));
  });

  it("atomicWriteYaml replaces the file atomically", async () => {
    const path = progressPath(cwd);
    await atomicWriteYaml(path, { events: [{ x: 1 }] });
    const raw = await readFile(path, "utf8");
    expect(parseYaml(raw)).toEqual({ events: [{ x: 1 }] });
  });

  it("appendEvent appends a started event", async () => {
    const event: ProgressEvent = {
      task_id: "P1-T1",
      status: "started",
      at: "2026-05-18T09:00:00+00:00",
      actor: "agent",
      agent: "claude-code",
    };
    const { nextLog } = await appendEvent(cwd, event);
    expect(nextLog.events).toHaveLength(1);
    const { log } = await loadProgressLog(cwd);
    expect(log.events[0]?.status).toBe("started");
  });

  it("appendEvent preserves prior events", async () => {
    const first: ProgressEvent = {
      task_id: "P1-T1",
      status: "started",
      at: "2026-05-18T09:00:00+00:00",
      actor: "agent",
    };
    const second: ProgressEvent = {
      task_id: "P1-T1",
      status: "blocked",
      reason: "waiting on review",
      at: "2026-05-18T10:00:00+00:00",
      actor: "agent",
    };
    await appendEvent(cwd, first);
    await appendEvent(cwd, second);
    const { log } = await loadProgressLog(cwd);
    expect(log.events.map((e) => e.status)).toEqual(["started", "blocked"]);
    expect(log.events[1]?.reason).toBe("waiting on review");
  });

  it("loadProgressLog throws on malformed YAML", async () => {
    await writeFile(progressPath(cwd), "events: [not-valid", "utf8");
    await expect(loadProgressLog(cwd)).rejects.toThrow();
  });
});
