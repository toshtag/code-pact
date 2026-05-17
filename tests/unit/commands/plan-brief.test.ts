import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Prompter, type LineReader } from "../../../src/lib/prompt.ts";
import { runPlanBrief, generateBriefMd } from "../../../src/commands/plan-brief.ts";

class ScriptedReader implements LineReader {
  private idx = 0;
  constructor(private readonly lines: readonly string[]) {}
  async question(_prompt: string): Promise<string> {
    if (this.idx >= this.lines.length) {
      throw new Error(`ScriptedReader exhausted at prompt ${this.idx}`);
    }
    return this.lines[this.idx++]!;
  }
  close(): void {}
}

function makePrompter(lines: readonly string[]): Prompter {
  const reader = new ScriptedReader(lines);
  const output = new PassThrough();
  output.resume();
  return new Prompter(reader, output);
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-brief-test-"));
  // design/ must exist (runInitCore normally creates it)
  await mkdir(join(tmpDir, "design"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// generateBriefMd — unit
// ---------------------------------------------------------------------------

describe("generateBriefMd — en-US", () => {
  it("includes all three answers", () => {
    const md = generateBriefMd(
      { what: "A CLI tool", who: "Developers", differentiator: "AI-native" },
      "en-US",
    );
    expect(md).toContain("Project Brief");
    expect(md).toContain("What we're building");
    expect(md).toContain("A CLI tool");
    expect(md).toContain("Who it's for");
    expect(md).toContain("Developers");
    expect(md).toContain("What makes it different");
    expect(md).toContain("AI-native");
  });

  it("uses placeholder when differentiator is empty", () => {
    const md = generateBriefMd(
      { what: "A CLI tool", who: "Developers", differentiator: "" },
      "en-US",
    );
    expect(md).toContain("(not specified)");
    expect(md).not.toContain("AI-native");
  });

  it("includes regeneration footer", () => {
    const md = generateBriefMd(
      { what: "x", who: "y", differentiator: "" },
      "en-US",
    );
    expect(md).toContain("code-pact plan brief");
  });
});

describe("generateBriefMd — ja-JP", () => {
  it("uses Japanese headers", () => {
    const md = generateBriefMd(
      { what: "CLI ツール", who: "開発者", differentiator: "" },
      "ja-JP",
    );
    expect(md).toContain("プロジェクト概要");
    expect(md).toContain("何を作るか");
    expect(md).toContain("誰のためか");
    expect(md).toContain("(未記入)");
  });
});

// ---------------------------------------------------------------------------
// runPlanBrief — integration
// ---------------------------------------------------------------------------

describe("runPlanBrief", () => {
  it("creates design/brief.md and returns path", async () => {
    const prompter = makePrompter([
      "A task management CLI", // what
      "Developers",            // who
      "AI-native workflow",    // differentiator
    ]);
    const result = await runPlanBrief({ cwd: tmpDir, locale: "en-US", force: false, prompter });
    expect(result.skipped).toBe(false);
    expect(result.path).toContain("brief.md");

    const content = await readFile(result.path, "utf8");
    expect(content).toContain("A task management CLI");
    expect(content).toContain("Developers");
    expect(content).toContain("AI-native workflow");
  });

  it("returns skipped:true when file exists and force is false", async () => {
    await writeFile(join(tmpDir, "design", "brief.md"), "existing", "utf8");
    const prompter = makePrompter([]);
    const result = await runPlanBrief({ cwd: tmpDir, locale: "en-US", force: false, prompter });
    expect(result.skipped).toBe(true);
  });

  it("overwrites when force is true", async () => {
    await writeFile(join(tmpDir, "design", "brief.md"), "old content", "utf8");
    const prompter = makePrompter([
      "New project", // what
      "New users",   // who
      "",            // differentiator: empty
    ]);
    const result = await runPlanBrief({ cwd: tmpDir, locale: "en-US", force: true, prompter });
    expect(result.skipped).toBe(false);

    const content = await readFile(result.path, "utf8");
    expect(content).toContain("New project");
    expect(content).not.toContain("old content");
  });

  it("writes Japanese content when locale is ja-JP", async () => {
    const prompter = makePrompter([
      "タスク管理 CLI", // what
      "開発者",         // who
      "",               // differentiator: skip
    ]);
    const result = await runPlanBrief({ cwd: tmpDir, locale: "ja-JP", force: false, prompter });
    const content = await readFile(result.path, "utf8");
    expect(content).toContain("プロジェクト概要");
    expect(content).toContain("タスク管理 CLI");
    expect(content).toContain("(未記入)");
  });

  it("creates design/ directory if it does not exist", async () => {
    await rm(join(tmpDir, "design"), { recursive: true, force: true });
    const prompter = makePrompter(["x", "y", ""]);
    const result = await runPlanBrief({ cwd: tmpDir, locale: "en-US", force: false, prompter });
    expect(result.skipped).toBe(false);
    const content = await readFile(result.path, "utf8");
    expect(content).toContain("Project Brief");
  });
});
