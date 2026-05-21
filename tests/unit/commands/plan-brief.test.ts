import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Prompter, type LineReader } from "../../../src/lib/prompt.ts";
import { Readable } from "node:stream";
import {
  BriefFileSchema,
  PlanBriefFromFileError,
  PlanBriefFromStdinError,
  generateBriefMd,
  loadBriefFromFile,
  loadBriefFromStdin,
  runPlanBrief,
} from "../../../src/commands/plan-brief.ts";

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

// ---------------------------------------------------------------------------
// v1.6 P17-T1: --from-file path
// ---------------------------------------------------------------------------

async function writeRelative(rel: string, content: string): Promise<void> {
  const abs = join(tmpDir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

describe("BriefFileSchema (v1.6 P17-T1)", () => {
  it("accepts the minimal valid record (what + who)", () => {
    const r = BriefFileSchema.safeParse({ what: "x", who: "y" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.what).toBe("x");
      expect(r.data.who).toBe("y");
      expect(r.data.differentiator).toBe(""); // default
    }
  });

  it("accepts all three fields", () => {
    const r = BriefFileSchema.safeParse({
      what: "x",
      who: "y",
      differentiator: "z",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.differentiator).toBe("z");
  });

  it("rejects missing `what`", () => {
    const r = BriefFileSchema.safeParse({ who: "y" });
    expect(r.success).toBe(false);
  });

  it("rejects missing `who`", () => {
    const r = BriefFileSchema.safeParse({ what: "x" });
    expect(r.success).toBe(false);
  });

  it("rejects empty `what`", () => {
    const r = BriefFileSchema.safeParse({ what: "", who: "y" });
    expect(r.success).toBe(false);
  });

  it("rejects empty `who`", () => {
    const r = BriefFileSchema.safeParse({ what: "x", who: "" });
    expect(r.success).toBe(false);
  });

  it("rejects wrong type on `what`", () => {
    const r = BriefFileSchema.safeParse({ what: 123, who: "y" });
    expect(r.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const r = BriefFileSchema.safeParse({
      what: "x",
      who: "y",
      bogus: "z",
    });
    expect(r.success).toBe(false);
  });
});

describe("loadBriefFromFile (v1.6 P17-T1)", () => {
  it("returns BriefAnswers when the file is valid YAML matching the schema", async () => {
    await writeRelative(
      "input/brief.yaml",
      [
        "what: A control plane for AI coding agents.",
        "who: Software teams using AI coding agents.",
        "differentiator: Vendor-neutral, deterministic CLI.",
        "",
      ].join("\n"),
    );
    const answers = await loadBriefFromFile(tmpDir, "input/brief.yaml");
    expect(answers).toEqual({
      what: "A control plane for AI coding agents.",
      who: "Software teams using AI coding agents.",
      differentiator: "Vendor-neutral, deterministic CLI.",
    });
  });

  it("defaults differentiator to empty string when omitted", async () => {
    await writeRelative(
      "input/brief.yaml",
      ["what: x", "who: y", ""].join("\n"),
    );
    const answers = await loadBriefFromFile(tmpDir, "input/brief.yaml");
    expect(answers).toEqual({ what: "x", who: "y", differentiator: "" });
  });

  it("throws PlanBriefFromFileError on unsafe path (absolute)", async () => {
    await expect(
      loadBriefFromFile(tmpDir, "/etc/passwd"),
    ).rejects.toMatchObject({
      name: "PlanBriefFromFileError",
      code: "CONFIG_ERROR",
      detail: "unsafe_path",
    });
  });

  it("throws PlanBriefFromFileError on unsafe path (..)", async () => {
    await expect(
      loadBriefFromFile(tmpDir, "../outside.yaml"),
    ).rejects.toMatchObject({
      name: "PlanBriefFromFileError",
      detail: "unsafe_path",
    });
  });

  it("throws PlanBriefFromFileError on missing file", async () => {
    await expect(
      loadBriefFromFile(tmpDir, "missing.yaml"),
    ).rejects.toMatchObject({
      name: "PlanBriefFromFileError",
      detail: "unreadable",
      path: "missing.yaml",
    });
  });

  it("throws PlanBriefFromFileError on malformed YAML", async () => {
    await writeRelative("input/bad.yaml", "what: [unclosed\n");
    await expect(
      loadBriefFromFile(tmpDir, "input/bad.yaml"),
    ).rejects.toMatchObject({
      name: "PlanBriefFromFileError",
      detail: "invalid_yaml",
    });
  });

  it("throws PlanBriefFromFileError on schema mismatch (missing required field)", async () => {
    await writeRelative("input/partial.yaml", "what: only-what\n");
    await expect(
      loadBriefFromFile(tmpDir, "input/partial.yaml"),
    ).rejects.toMatchObject({
      name: "PlanBriefFromFileError",
      detail: "schema_invalid",
    });
  });

  it("throws PlanBriefFromFileError on schema mismatch (unknown key)", async () => {
    await writeRelative(
      "input/extra.yaml",
      "what: x\nwho: y\nbogus: 1\n",
    );
    await expect(
      loadBriefFromFile(tmpDir, "input/extra.yaml"),
    ).rejects.toMatchObject({
      name: "PlanBriefFromFileError",
      detail: "schema_invalid",
    });
  });

  it("PlanBriefFromFileError carries the user-supplied path verbatim", async () => {
    try {
      await loadBriefFromFile(tmpDir, "missing.yaml");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanBriefFromFileError);
      if (err instanceof PlanBriefFromFileError) {
        expect(err.path).toBe("missing.yaml");
      }
    }
  });
});

describe("runPlanBrief({ answers }) — wizard bypass (v1.6 P17-T1)", () => {
  it("bypasses the wizard and writes design/brief.md from supplied answers", async () => {
    const result = await runPlanBrief({
      cwd: tmpDir,
      locale: "en-US",
      force: false,
      answers: {
        what: "A control plane for AI coding agents.",
        who: "Software teams using AI coding agents.",
        differentiator: "Vendor-neutral, deterministic CLI.",
      },
    });
    expect(result.skipped).toBe(false);
    const written = await readFile(result.path, "utf8");
    expect(written).toContain("A control plane for AI coding agents.");
    expect(written).toContain("Software teams using AI coding agents.");
    expect(written).toContain("Vendor-neutral, deterministic CLI.");
  });

  it("respects the file-exists short-circuit (skipped=true, no overwrite)", async () => {
    await mkdir(join(tmpDir, "design"), { recursive: true });
    await writeFile(join(tmpDir, "design/brief.md"), "existing\n", "utf8");
    const result = await runPlanBrief({
      cwd: tmpDir,
      locale: "en-US",
      force: false,
      answers: { what: "x", who: "y", differentiator: "z" },
    });
    expect(result.skipped).toBe(true);
    const after = await readFile(join(tmpDir, "design/brief.md"), "utf8");
    expect(after).toBe("existing\n"); // untouched
  });

  it("--force overrides the file-exists short-circuit when answers are provided", async () => {
    await mkdir(join(tmpDir, "design"), { recursive: true });
    await writeFile(join(tmpDir, "design/brief.md"), "stale\n", "utf8");
    const result = await runPlanBrief({
      cwd: tmpDir,
      locale: "en-US",
      force: true,
      answers: { what: "new-what", who: "new-who", differentiator: "" },
    });
    expect(result.skipped).toBe(false);
    const after = await readFile(join(tmpDir, "design/brief.md"), "utf8");
    expect(after).toContain("new-what");
    expect(after).not.toContain("stale");
  });

  it("answers path produces the same brief.md as the wizard for equivalent input", async () => {
    // Wizard path
    const wizardDir = await mkdtemp(join(tmpdir(), "code-pact-plan-brief-wiz-"));
    try {
      const prompter = makePrompter(["x-what", "y-who", "z-diff"]);
      const wizResult = await runPlanBrief({
        cwd: wizardDir,
        locale: "en-US",
        force: false,
        prompter,
      });
      const wizContent = await readFile(wizResult.path, "utf8");

      // Answers path (in fresh tmpDir)
      const ansResult = await runPlanBrief({
        cwd: tmpDir,
        locale: "en-US",
        force: false,
        answers: { what: "x-what", who: "y-who", differentiator: "z-diff" },
      });
      const ansContent = await readFile(ansResult.path, "utf8");

      expect(ansContent).toBe(wizContent);
    } finally {
      await rm(wizardDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// v1.6 P17-T2: --stdin path
// ---------------------------------------------------------------------------

function streamOf(text: string): NodeJS.ReadableStream {
  return Readable.from([text]);
}

describe("loadBriefFromStdin (v1.6 P17-T2)", () => {
  it("returns BriefAnswers when stdin is valid YAML matching the schema", async () => {
    const stream = streamOf(
      [
        "what: A control plane for AI coding agents.",
        "who: Software teams using AI coding agents.",
        "differentiator: Vendor-neutral, deterministic CLI.",
        "",
      ].join("\n"),
    );
    const answers = await loadBriefFromStdin(stream);
    expect(answers).toEqual({
      what: "A control plane for AI coding agents.",
      who: "Software teams using AI coding agents.",
      differentiator: "Vendor-neutral, deterministic CLI.",
    });
  });

  it("defaults differentiator to empty string when omitted", async () => {
    const stream = streamOf("what: x\nwho: y\n");
    const answers = await loadBriefFromStdin(stream);
    expect(answers).toEqual({ what: "x", who: "y", differentiator: "" });
  });

  it("concatenates multiple chunks before parsing (large-pipe safety)", async () => {
    // Simulate a real pipe that delivers the YAML in pieces.
    const stream = Readable.from([
      "what: piece-one\n",
      "who: piece-two\n",
      "differentiator: piece-three\n",
    ]);
    const answers = await loadBriefFromStdin(stream);
    expect(answers).toEqual({
      what: "piece-one",
      who: "piece-two",
      differentiator: "piece-three",
    });
  });

  it("throws PlanBriefFromStdinError on malformed YAML", async () => {
    const stream = streamOf("what: [unclosed\n");
    await expect(loadBriefFromStdin(stream)).rejects.toMatchObject({
      name: "PlanBriefFromStdinError",
      code: "CONFIG_ERROR",
      detail: "invalid_yaml",
    });
  });

  it("throws PlanBriefFromStdinError on schema mismatch (missing required field)", async () => {
    const stream = streamOf("what: only-what\n");
    await expect(loadBriefFromStdin(stream)).rejects.toMatchObject({
      name: "PlanBriefFromStdinError",
      detail: "schema_invalid",
    });
  });

  it("throws PlanBriefFromStdinError on schema mismatch (unknown key)", async () => {
    const stream = streamOf("what: x\nwho: y\nbogus: 1\n");
    await expect(loadBriefFromStdin(stream)).rejects.toMatchObject({
      name: "PlanBriefFromStdinError",
      detail: "schema_invalid",
    });
  });

  it("error messages mention `--stdin` and `<stdin>` so users can disambiguate", async () => {
    const stream = streamOf("what: [unclosed\n");
    try {
      await loadBriefFromStdin(stream);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanBriefFromStdinError);
      if (err instanceof PlanBriefFromStdinError) {
        expect(err.message).toContain("--stdin");
        expect(err.message).toContain("<stdin>");
      }
    }
  });

  it("loadBriefFromStdin and loadBriefFromFile produce identical answers for identical content", async () => {
    const yaml = "what: A\nwho: B\ndifferentiator: C\n";

    // Stdin path
    const fromStdin = await loadBriefFromStdin(streamOf(yaml));

    // File path
    const dir = await mkdtemp(join(tmpdir(), "code-pact-brief-parity-"));
    try {
      await writeFile(join(dir, "brief.yaml"), yaml, "utf8");
      const fromFile = await loadBriefFromFile(dir, "brief.yaml");
      expect(fromStdin).toEqual(fromFile);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
