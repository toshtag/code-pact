import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { Prompter, type LineReader } from "../../../src/lib/prompt.ts";
import { runInit } from "../../../src/commands/init.ts";
import { runPhaseNew } from "../../../src/commands/phase-new.ts";

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
  cwd = await mkdtemp(join(tmpdir(), "code-pact-phase-new-"));
  await runInit({ cwd, locale: "en-US", agents: ["claude-code"], force: false, json: false });
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("runPhaseNew — happy path", () => {
  it("creates a phase with all interactive answers", async () => {
    const prompter = makePrompter([
      "P10", // id
      "Billing flow", // name
      "8", // weight
      "Add billing feature", // objective
      "2", // confidence: medium
      "1", // risk: low
      "pnpm test, pnpm typecheck", // verify commands
      "Billing form renders, payment succeeds", // done criteria
    ]);
    const result = await runPhaseNew({ cwd, locale: "en-US", prompter });
    expect(result.ref.id).toBe("P10");
    expect(result.ref.weight).toBe(8);
    expect(result.path).toBe("design/phases/P10-billing-flow.yaml");

    const phase = parseYaml(await readFile(join(cwd, result.path), "utf8")) as {
      confidence: string;
      risk: string;
      verification: { commands: string[] };
      definition_of_done: string[];
    };
    expect(phase.confidence).toBe("medium");
    expect(phase.risk).toBe("low");
    expect(phase.verification.commands).toEqual(["pnpm test", "pnpm typecheck"]);
    expect(phase.definition_of_done).toEqual([
      "Billing form renders",
      "payment succeeds",
    ]);
  });

  it("uses defaults when verify and done are blank", async () => {
    const prompter = makePrompter([
      "P11",
      "Defaults",
      "5",
      "Try defaults",
      "2", // confidence
      "2", // risk
      "", // verify -> default
      "", // done -> default
    ]);
    const result = await runPhaseNew({ cwd, locale: "en-US", prompter });
    const phase = parseYaml(await readFile(join(cwd, result.path), "utf8")) as {
      verification: { commands: string[] };
      definition_of_done: string[];
    };
    expect(phase.verification.commands).toEqual(["pnpm test"]);
    expect(phase.definition_of_done).toEqual(["All tasks are done"]);
  });

  it("re-prompts when weight is blank or invalid", async () => {
    const prompter = makePrompter([
      "P12",
      "Weight retry",
      "abc", // invalid
      "0", // out of range
      "7", // valid
      "Try weight retry",
      "2", // confidence
      "2", // risk
      "",
      "",
    ]);
    const result = await runPhaseNew({ cwd, locale: "en-US", prompter });
    expect(result.ref.weight).toBe(7);
  });
});

describe("runPhaseNew — positional name", () => {
  it("skips the name prompt when initialName is provided", async () => {
    const prompter = makePrompter([
      "P13",
      // no name prompt
      "5",
      "Positional name flow",
      "2",
      "2",
      "",
      "",
    ]);
    const result = await runPhaseNew({
      cwd,
      locale: "en-US",
      initialName: "Provided Name",
      prompter,
    });
    expect(result.path).toContain("P13-provided-name.yaml");
  });
});

describe("runPhaseNew — collision", () => {
  it("throws DUPLICATE_PHASE_ID when id already exists", async () => {
    // Seed an existing phase first.
    const first = makePrompter([
      "P14",
      "First",
      "5",
      "Set up",
      "2",
      "2",
      "",
      "",
    ]);
    await runPhaseNew({ cwd, locale: "en-US", prompter: first });

    const second = makePrompter([
      "P14",
      "Second",
      "5",
      "Duplicate",
      "2",
      "2",
      "",
      "",
    ]);
    await expect(
      runPhaseNew({ cwd, locale: "en-US", prompter: second }),
    ).rejects.toMatchObject({ code: "DUPLICATE_PHASE_ID" });
  });
});
