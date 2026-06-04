import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRoadmap } from "../../../src/core/plan/roadmap.ts";

// Unit coverage for the shared strict roadmap loader (PR0). It must keep the
// throw-on-invalid contract the eight extracted per-command copies relied on.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-load-roadmap-test-"));
  await mkdir(join(dir, "design"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeRoadmap(content: string): Promise<void> {
  await writeFile(join(dir, "design", "roadmap.yaml"), content, "utf8");
}

describe("loadRoadmap (strict)", () => {
  it("parses a valid roadmap.yaml into a Roadmap", async () => {
    await writeRoadmap(
      [
        "phases:",
        "  - id: P1",
        "    path: design/phases/P1-foundations.yaml",
        "    weight: 20",
      ].join("\n") + "\n",
    );
    const roadmap = await loadRoadmap(dir);
    expect(roadmap.phases).toHaveLength(1);
    expect(roadmap.phases[0]).toMatchObject({ id: "P1", weight: 20 });
  });

  it("throws when design/roadmap.yaml is missing", async () => {
    await expect(loadRoadmap(dir)).rejects.toThrow();
  });

  it("throws on a schema-invalid roadmap (phase missing required fields)", async () => {
    await writeRoadmap(["phases:", "  - id: P1"].join("\n") + "\n");
    await expect(loadRoadmap(dir)).rejects.toThrow();
  });

  it("throws on malformed YAML", async () => {
    await writeRoadmap("phases: [unclosed\n");
    await expect(loadRoadmap(dir)).rejects.toThrow();
  });
});
