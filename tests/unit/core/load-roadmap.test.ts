import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, symlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRoadmap } from "../../../src/core/plan/roadmap.ts";
import { loadPhase } from "../../../src/core/plan/load-phase.ts";

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

  // SECURITY (CWE-59): the roadmap + phases are MANDATORY control-plane inputs
  // rendered into the agent-facing context pack and into generated Claude skills.
  // A symlinked `design/roadmap.yaml` / `design/phases/*` (or a `..` phase ref)
  // must not pull an out-of-project file in — fail closed with CONFIG_ERROR.
  it("loadRoadmap refuses a design/roadmap.yaml symlinked outside the project (CONFIG_ERROR)", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "code-pact-roadmap-out-")));
    try {
      await writeFile(join(outside, "roadmap.yaml"), "phases:\n  - id: P9\n    path: design/phases/x.yaml\n    weight: 1\n", "utf8");
      await rm(join(dir, "design", "roadmap.yaml"), { force: true });
      await symlink(join(outside, "roadmap.yaml"), join(dir, "design", "roadmap.yaml"));
      await expect(loadRoadmap(dir)).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("loadPhase refuses a phase path symlinked outside the project (CONFIG_ERROR)", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "code-pact-phase-out-")));
    try {
      await writeFile(join(outside, "secret.yaml"), "id: P9\nname: leak\n", "utf8");
      await mkdir(join(dir, "design", "phases"), { recursive: true });
      await symlink(join(outside, "secret.yaml"), join(dir, "design", "phases", "P9.yaml"));
      await expect(
        loadPhase(dir, "design/phases/P9.yaml"),
      ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("loadPhase refuses a `..` phase path (CONFIG_ERROR, not a lexical out-of-project read)", async () => {
    await expect(
      loadPhase(dir, "../outside/phase.yaml"),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});
