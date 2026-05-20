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
      "n", // generate adapters: no
      "", // verify command: default
      "n", // create sample phase: no
      "n", // collect brief: no
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const project = await readProjectYaml();
    expect(project.locale).toBe("ja-JP");
  });

  it("writes en-US when option 1 is chosen", async () => {
    const { prompter } = makePrompter([
      "1", // locale: English
      "1", // agents: Claude Code
      "n", // adapters
      "", // verify
      "n", // sample
      "n", // brief
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
      "n", // adapters
      "", // verify
      "n", // sample
      "n", // brief
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const project = await readProjectYaml();
    expect(project.default_agent).toBe("claude-code");
    expect(project.agents).toHaveLength(1);
    // 6 prompts total: locale, agents, adapters, verify, sample, brief.
    expect(reader.prompts).toHaveLength(6);
  });

  it("asks default_agent when multiple agents are selected", async () => {
    const { prompter, reader } = makePrompter([
      "1", // locale: en-US
      "1,2", // agents: Claude Code + Codex
      "2", // default_agent: Codex (second in selection)
      "n", // adapters
      "", // verify
      "n", // sample
      "n", // brief
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const project = await readProjectYaml();
    expect(project.default_agent).toBe("codex");
    expect(project.agents.map((a) => a.name)).toEqual(["claude-code", "codex"]);
    expect(reader.prompts).toHaveLength(7);
  });
});

describe("runInitWizard — verify command", () => {
  it("uses the default verify command when input is empty", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1", // agents
      "n", // adapters
      "", // verify: blank
      "y", // sample yes
      "n", // brief
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const phase = await readFile(
      join(tmpDir, "design", "phases", "TUTORIAL-walkthrough.yaml"),
      "utf8",
    );
    expect(phase).toContain("pnpm test");
  });

  it("uses the typed verify command when provided", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1", // agents
      "n", // adapters
      "vitest run", // verify
      "y", // sample yes
      "n", // brief
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const phase = await readFile(
      join(tmpDir, "design", "phases", "TUTORIAL-walkthrough.yaml"),
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
      "n", // adapters
      "", // verify
      "y", // sample yes
      "n", // brief
    ]);
    const result = await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const phaseCreated = result.created.some((p) => p.includes("TUTORIAL-walkthrough.yaml"));
    expect(phaseCreated).toBe(true);
  });

  it("skips the sample phase when answered no", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1", // agents
      "n", // adapters
      "", // verify
      "n", // sample no
      "n", // brief
    ]);
    const result = await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const phaseCreated = result.created.some((p) => p.includes("TUTORIAL-walkthrough.yaml"));
    expect(phaseCreated).toBe(false);
  });
});

describe("runInitWizard — adapter generation", () => {
  it("generates adapter files when answered yes", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1", // agents: claude-code
      "y", // adapters: yes
      "", // verify
      "n", // sample
      "n", // brief
    ]);
    const result = await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const claudeMdCreated = result.created.some((p) => p.endsWith("CLAUDE.md"));
    expect(claudeMdCreated).toBe(true);
  });

  it("does NOT generate adapter files when answered no", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1", // agents
      "n", // adapters: no
      "", // verify
      "n", // sample
      "n", // brief
    ]);
    const result = await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const claudeMdCreated = result.created.some((p) => p.endsWith("CLAUDE.md"));
    expect(claudeMdCreated).toBe(false);
  });

  it("generates one adapter per enabled agent when answered yes for multi-select", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1,3", // agents: claude-code + generic
      "1", // default_agent: claude-code
      "y", // adapters: yes
      "", // verify
      "n", // sample
      "n", // brief
    ]);
    const result = await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const hasClaude = result.created.some((p) => p.endsWith("CLAUDE.md"));
    const hasGeneric = result.created.some((p) => p.endsWith("agent-instructions.md"));
    expect(hasClaude).toBe(true);
    expect(hasGeneric).toBe(true);
  });
});

describe("runInitWizard — project brief", () => {
  it("creates design/brief.md when answered yes with content", async () => {
    const { prompter } = makePrompter([
      "1", // locale: en-US
      "1", // agents: claude-code
      "n", // adapters
      "", // verify
      "n", // sample
      "y", // brief: yes
      "A task management CLI", // what
      "Developers", // who
      "Integrates with AI agents", // differentiator
    ]);
    const result = await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const briefCreated = result.created.some((p) => p.endsWith("brief.md"));
    expect(briefCreated).toBe(true);

    const content = await readFile(join(tmpDir, "design", "brief.md"), "utf8");
    expect(content).toContain("Project Brief");
    expect(content).toContain("A task management CLI");
    expect(content).toContain("Developers");
    expect(content).toContain("Integrates with AI agents");
  });

  it("brief.md uses ja-JP locale when ja-JP is selected", async () => {
    const { prompter } = makePrompter([
      "2", // locale: 日本語
      "1", // agents
      "n", // adapters
      "", // verify
      "n", // sample
      "y", // brief: yes
      "タスク管理 CLI", // what
      "開発者", // who
      "", // differentiator: skip
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const content = await readFile(join(tmpDir, "design", "brief.md"), "utf8");
    expect(content).toContain("プロジェクト概要");
    expect(content).toContain("タスク管理 CLI");
    expect(content).toContain("(未記入)");
  });

  it("does not create design/brief.md when answered no", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1", // agents
      "n", // adapters
      "", // verify
      "n", // sample
      "n", // brief: no
    ]);
    const result = await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const briefCreated = result.created.some((p) => p.endsWith("brief.md"));
    expect(briefCreated).toBe(false);
  });
});
