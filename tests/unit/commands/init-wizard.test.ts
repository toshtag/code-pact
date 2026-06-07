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

function makePrompter(lines: readonly string[]): {
  prompter: Prompter;
  reader: ScriptedReader;
  output: PassThrough;
  getOutput: () => string;
} {
  const reader = new ScriptedReader(lines);
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });
  output.resume(); // drop writes silently
  return { prompter: new Prompter(reader, output), reader, output, getOutput: () => written };
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

// v1.15: the wizard no longer prompts for the sample phase. The prompt
// sequence is: locale, agents, [default_agent], adapters, verify.
// Sample-phase creation is opt-in only via `samplePhaseOverride` (the
// `--sample-phase` CLI flag).

describe("runInitWizard — locale", () => {
  it("writes ja-JP into project.yaml when option 2 is chosen", async () => {
    const { prompter } = makePrompter([
      "2", // locale: 日本語
      "1", // agents: Claude Code
      "n", // generate adapters: no
      "1", // verify: preset pnpm test
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
      "1", // verify: preset pnpm test
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
      "1", // verify: preset pnpm test
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const project = await readProjectYaml();
    expect(project.default_agent).toBe("claude-code");
    expect(project.agents).toHaveLength(1);
    // 4 prompts total: locale, agents, adapters, verify.
    expect(reader.prompts).toHaveLength(4);
  });

  it("asks default_agent when multiple agents are selected", async () => {
    const { prompter, reader } = makePrompter([
      "1", // locale: en-US
      "1,2", // agents: Claude Code + Codex
      "2", // default_agent: Codex (second in selection)
      "n", // adapters
      "1", // verify: preset pnpm test
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const project = await readProjectYaml();
    expect(project.default_agent).toBe("codex");
    expect(project.agents.map((a) => a.name)).toEqual(["claude-code", "codex"]);
    expect(reader.prompts).toHaveLength(5);
  });
});

describe("runInitWizard — verify command", () => {
  it("uses the pnpm test preset when the first option is chosen", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1", // agents
      "n", // adapters
      "1", // verify: preset pnpm test
    ]);
    // samplePhaseOverride forces creation so we can inspect the verify
    // command baked into the sample phase (the wizard no longer prompts).
    await runInitWizard({
      cwd: tmpDir,
      force: false,
      json: false,
      samplePhaseOverride: true,
      prompter,
    });
    const phase = await readFile(
      join(tmpDir, "design", "phases", "TUTORIAL-walkthrough.yaml"),
      "utf8",
    );
    expect(phase).toContain("pnpm test");
  });

  it("uses a typed command when the custom option is chosen", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1", // agents
      "n", // adapters
      "4", // verify: custom option (last entry)
      "vitest run", // verify: typed custom command
    ]);
    await runInitWizard({
      cwd: tmpDir,
      force: false,
      json: false,
      samplePhaseOverride: true,
      prompter,
    });
    const phase = await readFile(
      join(tmpDir, "design", "phases", "TUTORIAL-walkthrough.yaml"),
      "utf8",
    );
    expect(phase).toContain("vitest run");
  });
});

describe("runInitWizard — output routing", () => {
  it("writes next steps and the tutorial/sample-phase hints to the output", async () => {
    const { prompter, getOutput } = makePrompter([
      "1", // locale
      "1", // agents
      "n", // adapters
      "1", // verify: preset pnpm test
    ]);
    await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const out = getOutput();
    expect(out).toContain("Next steps");
    // The removed sample-phase prompt is replaced by discoverable footer
    // hints pointing at the two opt-in paths.
    expect(out).toContain("code-pact tutorial");
    expect(out).toContain("init --sample-phase");
  });
});

describe("runInitWizard — sample phase", () => {
  it("creates the sample phase when samplePhaseOverride is set", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1", // agents
      "n", // adapters
      "1", // verify: preset pnpm test
    ]);
    const result = await runInitWizard({
      cwd: tmpDir,
      force: false,
      json: false,
      samplePhaseOverride: true,
      prompter,
    });
    const phaseCreated = result.created.some((p) => p.includes("TUTORIAL-walkthrough.yaml"));
    expect(phaseCreated).toBe(true);
  });

  it("bakes no version/phase-provenance history noise into the generated YAML", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1", // agents
      "n", // adapters
      "1", // verify: preset pnpm test
    ]);
    await runInitWizard({
      cwd: tmpDir,
      force: false,
      json: false,
      samplePhaseOverride: true,
      prompter,
    });
    const phase = await readFile(
      join(tmpDir, "design", "phases", "TUTORIAL-walkthrough.yaml"),
      "utf8",
    );
    // The sample phase is user-facing output written into the user's design/
    // tree. It must not leak internal phase-provenance ids (e.g. P10/P12/P14)
    // or version tags (e.g. v1.5) — that is exactly the history noise the
    // P1-16 cleanup stripped from this artifact's prose. Guarding the
    // generator stops the doc example and the real output drifting back apart.
    expect(phase).not.toMatch(/\bP\d{1,2}\b/);
    expect(phase).not.toMatch(/\bv\d+\.\d+/);
  });

  it("does not create the sample phase by default (no prompt, no override)", async () => {
    const { prompter, reader } = makePrompter([
      "1", // locale
      "1", // agents
      "n", // adapters
      "1", // verify: preset pnpm test
    ]);
    const result = await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const phaseCreated = result.created.some((p) => p.includes("TUTORIAL-walkthrough.yaml"));
    expect(phaseCreated).toBe(false);
    // No sample-phase prompt is ever shown.
    expect(reader.prompts).toHaveLength(4);
  });
});

describe("runInitWizard — adapter generation", () => {
  it("generates adapter files when answered yes", async () => {
    const { prompter } = makePrompter([
      "1", // locale
      "1", // agents: claude-code
      "y", // adapters: yes
      "1", // verify: preset pnpm test
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
      "1", // verify: preset pnpm test
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
      "1", // verify: preset pnpm test
    ]);
    const result = await runInitWizard({ cwd: tmpDir, force: false, json: false, prompter });
    const hasClaude = result.created.some((p) => p.endsWith("CLAUDE.md"));
    const hasGeneric = result.created.some((p) => p.endsWith("agent-instructions.md"));
    expect(hasClaude).toBe(true);
    expect(hasGeneric).toBe(true);
  });
});
