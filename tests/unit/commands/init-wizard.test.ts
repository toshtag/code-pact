import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { Prompter, type LineReader } from "../../../src/lib/prompt.ts";
import { runInitWizard } from "../../../src/commands/init-wizard.ts";

class ScriptedReader implements LineReader {
  private idx = 0;
  public readonly prompts: string[] = [];
  constructor(private readonly lines: readonly string[]) {}
  async question(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    if (this.idx >= this.lines.length) {
      throw new Error(
        `ScriptedReader exhausted after ${this.idx} prompts; last prompt was:\n${prompt}`,
      );
    }
    return this.lines[this.idx++]!;
  }
  close(): void {}
}

function makePrompter(lines: readonly string[]): { prompter: Prompter; reader: ScriptedReader; output: PassThrough } {
  const reader = new ScriptedReader(lines);
  const output = new PassThrough();
  output.resume(); // drop writes silently
  return { prompter: new Prompter(reader, output), reader, output };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-wizard-test-"));
});

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

async function readProjectYaml(): Promise<{
  locale: string | { default: string };
  default_agent: string;
  agents: { name: string; profile: string; enabled?: boolean }[];
}> {
  const raw = await readFile(join(tmpDir, ".code-pact", "project.yaml"), "utf8");
  return parseYaml(raw) as ReturnType<typeof readProjectYaml> extends Promise<infer T> ? T : never;
}

describe("runInitWizard — locale", () => {
  it("writes ja-JP into project.yaml when option 2 is chosen", async () => {
    const { prompter } = makePrompter([
      "2", // locale: 日本語
      "1", // agents: Claude Code
      "", // verify command: default
      "n", // create sample phase: no
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const project = await readProjectYaml();
    expect(project.locale).toBe("ja-JP");
  });

  it("writes en-US when option 1 is chosen", async () => {
    const { prompter } = makePrompter([
      "1", // locale: English
      "1", // agents: Claude Code
      "", // verify
      "n", // sample
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const project = await readProjectYaml();
    expect(project.locale).toBe("en-US");
  });
});

describe("runInitWizard — default_agent", () => {
  it("skips the default_agent question when only one agent is selected", async () => {
    const { prompter, reader } = makePrompter([
      "1", // locale
      "1", // agents: just Claude Code
      "", // verify
      "n", // sample
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const project = await readProjectYaml();
    expect(project.default_agent).toBe("claude-code");
    expect(project.agents).toHaveLength(1);
    // 4 prompts total: locale, agents, verify, sample. No default_agent question.
    expect(reader.prompts).toHaveLength(4);
  });

  it("asks default_agent when multiple agents are selected", async () => {
    const { prompter, reader } = makePrompter([
      "1", // locale: en-US
      "1,2", // agents: Claude Code + Codex
      "2", // default_agent: Codex (second in selection)
      "", // verify
      "n", // sample
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const project = await readProjectYaml();
    expect(project.default_agent).toBe("codex");
    expect(project.agents.map((a) => a.name)).toEqual(["claude-code", "codex"]);
    expect(reader.prompts).toHaveLength(5);
  });
});

describe("runInitWizard — verify command", () => {
  it("uses the default verify command when input is empty", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1", // agents
      "", // verify: blank
      "y", // sample yes
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const phase = await readFile(
      join(tmpDir, "design", "phases", "P1-welcome.yaml"),
      "utf8",
    );
    expect(phase).toContain("pnpm test");
  });

  it("uses the typed verify command when provided", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1", // agents
      "vitest run", // verify
      "y", // sample yes
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const phase = await readFile(
      join(tmpDir, "design", "phases", "P1-welcome.yaml"),
      "utf8",
    );
    expect(phase).toContain("vitest run");
  });
});

describe("runInitWizard — sample phase", () => {
  it("creates the sample phase when answered yes", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1", // agents
      "", // verify
      "y", // sample yes
    ]);
    const result = await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const phaseCreated = result.created.some((p) => p.includes("P1-welcome.yaml"));
    expect(phaseCreated).toBe(true);
  });

  it("skips the sample phase when answered no", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1", // agents
      "", // verify
      "n", // sample no
    ]);
    const result = await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const phaseCreated = result.created.some((p) => p.includes("P1-welcome.yaml"));
    expect(phaseCreated).toBe(false);
  });
});

describe("runInitWizard — adapter generation (Phase 4 scope)", () => {
  it("does NOT ask about adapter generation in Phase 2", async () => {
    const { prompter, reader } = makePrompter([
      "1", // locale
      "1,2,3", // agents: all three
      "1", // default_agent
      "", // verify
      "n", // sample
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    // 5 prompts: locale, agents, default_agent, verify, sample.
    // No 6th prompt for adapter generation.
    expect(reader.prompts).toHaveLength(5);
    const adapterMentions = reader.prompts.filter((p) =>
      /adapter/i.test(p),
    );
    expect(adapterMentions).toEqual([]);
  });
});
