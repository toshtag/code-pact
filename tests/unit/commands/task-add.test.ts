import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { Prompter, type LineReader } from "../../../src/lib/prompt.ts";
import { runInit } from "../../../src/commands/init.ts";
import { runPhaseNew } from "../../../src/commands/phase-new.ts";
import { runTaskAdd } from "../../../src/commands/task-add.ts";

class ScriptedReader implements LineReader {
  private idx = 0;
  constructor(private readonly lines: readonly string[]) {}
  async question(_prompt: string): Promise<string> {
    if (this.idx >= this.lines.length) {
      throw new Error(`ScriptedReader exhausted at index ${this.idx}`);
    }
    return this.lines[this.idx++]!;
  }
  close(): void {}
}

function makePrompter(lines: readonly string[]): Prompter {
  const output = new PassThrough();
  output.resume();
  return new Prompter(new ScriptedReader(lines), output);
}

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-task-add-"));
  await runInit({ cwd, locale: "en-US", agents: ["claude-code"], force: false, json: false });
  // Seed a phase to add tasks to
  const phasePrompter = makePrompter([
    "P1",
    "Foundation",
    "",   // weight default
    "Build the foundation",
    "2",  // confidence: medium
    "2",  // risk: medium
    "",   // verify default
    "",   // done default
  ]);
  await runPhaseNew({ cwd, locale: "en-US", prompter: phasePrompter });
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("runTaskAdd — happy path", () => {
  it("appends a task with auto-generated id", async () => {
    const prompter = makePrompter([
      "Implement login form", // description
      "2",                   // type: feature (index 1, value = feature)
    ]);
    const result = await runTaskAdd({ cwd, phaseId: "P1", locale: "en-US", prompter });

    expect(result.taskId).toBe("P1-T1");
    expect(result.phaseId).toBe("P1");
    expect(result.phasePath).toMatch(/P1-/);

    const phase = parseYaml(await readFile(join(cwd, result.phasePath), "utf8")) as {
      tasks: Array<{ id: string; type: string; description: string; status: string }>;
    };
    expect(phase.tasks).toHaveLength(1);
    expect(phase.tasks[0]!.id).toBe("P1-T1");
    expect(phase.tasks[0]!.type).toBe("feature");
    expect(phase.tasks[0]!.description).toBe("Implement login form");
    expect(phase.tasks[0]!.status).toBe("planned");
  });

  it("uses explicit id when provided", async () => {
    const prompter = makePrompter([
      "Auth service",
      "1", // architecture
    ]);
    const result = await runTaskAdd({
      cwd,
      phaseId: "P1",
      locale: "en-US",
      id: "P1-AUTH",
      prompter,
    });
    expect(result.taskId).toBe("P1-AUTH");
  });

  it("auto-increments id for second task", async () => {
    const p1 = makePrompter(["First task", "2"]);
    await runTaskAdd({ cwd, phaseId: "P1", locale: "en-US", prompter: p1 });

    const p2 = makePrompter(["Second task", "2"]);
    const result = await runTaskAdd({ cwd, phaseId: "P1", locale: "en-US", prompter: p2 });
    expect(result.taskId).toBe("P1-T2");

    const phase = parseYaml(
      await readFile(join(cwd, result.phasePath), "utf8"),
    ) as { tasks: Array<{ id: string }> };
    expect(phase.tasks).toHaveLength(2);
  });
});

describe("runTaskAdd — error cases", () => {
  it("throws PHASE_NOT_FOUND for unknown phase id", async () => {
    const prompter = makePrompter(["irrelevant", "2"]);
    await expect(
      runTaskAdd({ cwd, phaseId: "P999", locale: "en-US", prompter }),
    ).rejects.toMatchObject({ code: "PHASE_NOT_FOUND" });
  });

  it("throws DUPLICATE_TASK_ID when explicit id collides", async () => {
    const p1 = makePrompter(["First task", "2"]);
    await runTaskAdd({ cwd, phaseId: "P1", locale: "en-US", id: "P1-T1", prompter: p1 });

    const p2 = makePrompter(["Another task", "2"]);
    await expect(
      runTaskAdd({ cwd, phaseId: "P1", locale: "en-US", id: "P1-T1", prompter: p2 }),
    ).rejects.toMatchObject({ code: "DUPLICATE_TASK_ID" });
  });
});
