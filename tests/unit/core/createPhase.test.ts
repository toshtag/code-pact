import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { runInit } from "../../../src/commands/init.ts";
import { createPhase } from "../../../src/core/services/createPhase.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-create-phase-"));
  await runInit({
    cwd,
    locale: "en-US",
    agents: ["claude-code"],
    force: false,
    json: false,
  });
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("createPhase", () => {
  it("writes a phase file under design/phases/<id>-<slug>.yaml", async () => {
    const result = await createPhase({
      cwd,
      id: "P10",
      name: "Implement billing",
      weight: 8,
      objective: "Add billing flow",
    });
    expect(result.path).toBe("design/phases/P10-implement-billing.yaml");

    const raw = await readFile(join(cwd, result.path), "utf8");
    const phase = parseYaml(raw) as Record<string, unknown>;
    expect(phase.id).toBe("P10");
    expect(phase.name).toBe("Implement billing");
    expect(phase.weight).toBe(8);
    expect(phase.objective).toBe("Add billing flow");
  });

  it("applies sensible defaults for confidence, risk, verify, done", async () => {
    await createPhase({
      cwd,
      id: "P11",
      name: "Defaults",
      weight: 1,
      objective: "Verify defaults",
    });
    const raw = await readFile(join(cwd, "design/phases/P11-defaults.yaml"), "utf8");
    const phase = parseYaml(raw) as Record<string, unknown> & {
      verification: { commands: string[] };
      definition_of_done: string[];
    };
    expect(phase.confidence).toBe("medium");
    expect(phase.risk).toBe("medium");
    expect(phase.verification.commands).toEqual(["pnpm test"]);
    expect(phase.definition_of_done).toEqual(["All tasks are done"]);
  });

  it("appends the new phase ref to roadmap.yaml", async () => {
    await createPhase({
      cwd,
      id: "P12",
      name: "Roadmap append",
      weight: 3,
      objective: "Append",
    });
    const raw = await readFile(join(cwd, "design", "roadmap.yaml"), "utf8");
    const roadmap = parseYaml(raw) as { phases: { id: string }[] };
    expect(roadmap.phases.map((p) => p.id)).toContain("P12");
  });

  it("throws DUPLICATE_PHASE_ID on collision", async () => {
    await createPhase({
      cwd,
      id: "P13",
      name: "first",
      weight: 1,
      objective: "x",
    });
    await expect(
      createPhase({ cwd, id: "P13", name: "second", weight: 1, objective: "y" }),
    ).rejects.toMatchObject({ code: "DUPLICATE_PHASE_ID" });
  });

  it("slugifies names with spaces and punctuation", async () => {
    const result = await createPhase({
      cwd,
      id: "P14",
      name: "Hello, World!  Spaces & Symbols",
      weight: 1,
      objective: "slug test",
    });
    // \s+ collapses to a single hyphen first; then [^a-z0-9-] strips the
    // commas, exclamations, ampersands. The leftover `-&-` ends up as `--`.
    expect(result.path).toBe("design/phases/P14-hello-world-spaces--symbols.yaml");
  });
});
