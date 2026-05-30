import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
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

  it.each(["P1/T1", "P1-T1; echo owned", "../evil"])(
    "rejects an unsafe explicit --id %j with CONFIG_ERROR and leaves the phase unchanged",
    async (badId) => {
      const phasesDir = join(cwd, "design", "phases");
      const fileName = (await readdir(phasesDir)).find((f) => f.startsWith("P1-"))!;
      const before = await readFile(join(phasesDir, fileName), "utf8");
      const prompter = makePrompter(["unused", "2"]);
      await expect(
        runTaskAdd({ cwd, phaseId: "P1", locale: "en-US", id: badId, prompter }),
      ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
      expect(await readFile(join(phasesDir, fileName), "utf8")).toBe(before);
    },
  );
});

// ---------------------------------------------------------------------------
// v1.4 P13-T3: non-interactive path (no prompter required)
// ---------------------------------------------------------------------------

describe("runTaskAdd — non-interactive path (P13-T3)", () => {
  it("appends a task with required-only spec; defaults all readiness fields to medium", async () => {
    const result = await runTaskAdd({
      cwd,
      phaseId: "P1",
      locale: "en-US",
      nonInteractive: {
        description: "Non-interactive add",
        type: "feature",
      },
    });
    expect(result.taskId).toBe("P1-T1");

    const phase = parseYaml(await readFile(join(cwd, result.phasePath), "utf8")) as {
      tasks: Array<{
        id: string;
        type: string;
        description: string;
        ambiguity: string;
        risk: string;
        context_size: string;
        write_surface: string;
        verification_strength: string;
        expected_duration: string;
        status: string;
      }>;
    };
    const t = phase.tasks[0]!;
    expect(t.id).toBe("P1-T1");
    expect(t.type).toBe("feature");
    expect(t.description).toBe("Non-interactive add");
    expect(t.status).toBe("planned");
    expect(t.ambiguity).toBe("medium");
    expect(t.risk).toBe("medium");
    expect(t.context_size).toBe("medium");
    expect(t.write_surface).toBe("medium");
    expect(t.verification_strength).toBe("medium");
    expect(t.expected_duration).toBe("medium");
  });

  it("respects explicit readiness overrides", async () => {
    const result = await runTaskAdd({
      cwd,
      phaseId: "P1",
      locale: "en-US",
      nonInteractive: {
        description: "High-risk refactor",
        type: "refactor",
        ambiguity: "high",
        risk: "high",
        context_size: "large",
        write_surface: "high",
        verification_strength: "strong",
        expected_duration: "long",
      },
    });
    const phase = parseYaml(await readFile(join(cwd, result.phasePath), "utf8")) as {
      tasks: Array<{
        ambiguity: string;
        risk: string;
        context_size: string;
        write_surface: string;
        verification_strength: string;
        expected_duration: string;
      }>;
    };
    const t = phase.tasks[0]!;
    expect(t.ambiguity).toBe("high");
    expect(t.risk).toBe("high");
    expect(t.context_size).toBe("large");
    expect(t.write_surface).toBe("high");
    expect(t.verification_strength).toBe("strong");
    expect(t.expected_duration).toBe("long");
  });

  it("stores P10 optional fields verbatim (no lint here; lint is plan lint's responsibility)", async () => {
    const result = await runTaskAdd({
      cwd,
      phaseId: "P1",
      locale: "en-US",
      nonInteractive: {
        description: "Task with P10 declarations",
        type: "feature",
        depends_on: ["P1-T0"],
        decision_refs: ["design/decisions/foo.md"],
        reads: ["src/foo.ts", "src/bar.ts"],
        writes: ["src/baz.ts"],
        acceptance_refs: ["docs/acceptance/foo.md"],
      },
    });
    const phase = parseYaml(await readFile(join(cwd, result.phasePath), "utf8")) as {
      tasks: Array<{
        depends_on?: string[];
        decision_refs?: string[];
        reads?: string[];
        writes?: string[];
        acceptance_refs?: string[];
      }>;
    };
    const t = phase.tasks[0]!;
    expect(t.depends_on).toEqual(["P1-T0"]);
    expect(t.decision_refs).toEqual(["design/decisions/foo.md"]);
    expect(t.reads).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(t.writes).toEqual(["src/baz.ts"]);
    expect(t.acceptance_refs).toEqual(["docs/acceptance/foo.md"]);
  });

  it("omits P10 fields when arrays are empty (no schema-noise from blank arrays)", async () => {
    const result = await runTaskAdd({
      cwd,
      phaseId: "P1",
      locale: "en-US",
      nonInteractive: {
        description: "Task without P10 fields",
        type: "docs",
        depends_on: [],
        reads: [],
      },
    });
    const phase = parseYaml(await readFile(join(cwd, result.phasePath), "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
    const t = phase.tasks[0]!;
    expect(t).not.toHaveProperty("depends_on");
    expect(t).not.toHaveProperty("reads");
  });

  it("always writes status: planned regardless of input (--status is intentionally not part of the spec)", async () => {
    const result = await runTaskAdd({
      cwd,
      phaseId: "P1",
      locale: "en-US",
      nonInteractive: {
        description: "Sanity check",
        type: "feature",
      },
    });
    const phase = parseYaml(await readFile(join(cwd, result.phasePath), "utf8")) as {
      tasks: Array<{ status: string }>;
    };
    expect(phase.tasks[0]!.status).toBe("planned");
  });

  it("non-interactive path does not open a prompter (no TTY required)", async () => {
    // No prompter, no scripted reader — if the implementation tries to
    // open one, Prompter.fromIO() will be called and the test will hang
    // waiting for stdin in non-TTY test environment. Reaching the assertion
    // proves the prompter was not opened.
    const result = await runTaskAdd({
      cwd,
      phaseId: "P1",
      locale: "en-US",
      nonInteractive: { description: "No prompter", type: "test" },
    });
    expect(result.taskId).toBe("P1-T1");
  });

  it("throws DUPLICATE_TASK_ID on explicit id collision in non-interactive mode", async () => {
    await runTaskAdd({
      cwd,
      phaseId: "P1",
      locale: "en-US",
      id: "P1-T1",
      nonInteractive: { description: "First", type: "feature" },
    });
    await expect(
      runTaskAdd({
        cwd,
        phaseId: "P1",
        locale: "en-US",
        id: "P1-T1",
        nonInteractive: { description: "Second", type: "feature" },
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_TASK_ID" });
  });

  it("throws PHASE_NOT_FOUND in non-interactive mode for unknown phase", async () => {
    await expect(
      runTaskAdd({
        cwd,
        phaseId: "P999",
        locale: "en-US",
        nonInteractive: { description: "irrelevant", type: "feature" },
      }),
    ).rejects.toMatchObject({ code: "PHASE_NOT_FOUND" });
  });
});
