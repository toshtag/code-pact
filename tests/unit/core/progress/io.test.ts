import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  atomicWriteYaml,
  loadProgressLog,
  progressPath,
} from "../../../../src/core/progress/io.ts";
import { brandOwnedWrite } from "../../../../src/core/project-fs/branded-paths-internal.ts";

describe("progress io", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "code-pact-progress-io-"));
    await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
    await writeFile(progressPath(cwd), stringifyYaml({ events: [] }), "utf8");
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
    await atomicWriteYaml(brandOwnedWrite(path), { events: [{ x: 1 }] });
    const raw = await readFile(path, "utf8");
    expect(parseYaml(raw)).toEqual({ events: [{ x: 1 }] });
  });

  it("loadProgressLog throws on malformed YAML", async () => {
    await writeFile(progressPath(cwd), "events: [not-valid", "utf8");
    await expect(loadProgressLog(cwd)).rejects.toThrow();
  });
});
