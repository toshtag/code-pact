import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import {
  ConstitutionFileSchema,
  PlanConstitutionFromStdinError,
  generateConstitutionMd,
  loadConstitutionFromFile,
  loadConstitutionFromStdin,
  runPlanConstitution,
} from "../../../src/commands/plan-constitution.ts";
import { Prompter } from "../../../src/lib/prompt.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-constitution-test-"));
  await mkdir(join(tmpDir, "design"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// generateConstitutionMd — unit
// ---------------------------------------------------------------------------

describe("generateConstitutionMd — en-US", () => {
  it("uses provided description and principles", () => {
    const md = generateConstitutionMd(
      { description: "Custom description.", principles: ["Principle A", "Principle B"] },
      "en-US",
    );
    expect(md).toContain("Custom description.");
    expect(md).toContain("- Principle A");
    expect(md).toContain("- Principle B");
    expect(md).toContain("## Core principles");
  });

  it("falls back to i18n defaults when description is empty", () => {
    const md = generateConstitutionMd({ description: "", principles: [] }, "en-US");
    expect(md).toContain("This file captures the principles");
    expect(md).toContain("Write for the next reader");
  });

  it("falls back to i18n default principles when principles array is empty", () => {
    const md = generateConstitutionMd(
      { description: "My desc.", principles: [] },
      "en-US",
    );
    expect(md).toContain("Write for the next reader");
    expect(md).toContain("Planning decisions must be captured");
  });

  it("starts with # Project Constitution", () => {
    const md = generateConstitutionMd({ description: "d", principles: ["p"] }, "en-US");
    expect(md.startsWith("# Project Constitution")).toBe(true);
  });

  it("ends with a newline", () => {
    const md = generateConstitutionMd({ description: "d", principles: ["p"] }, "en-US");
    expect(md.endsWith("\n")).toBe(true);
  });
});

describe("generateConstitutionMd — ja-JP", () => {
  it("uses Japanese core principles header", () => {
    const md = generateConstitutionMd({ description: "説明", principles: ["原則A"] }, "ja-JP");
    expect(md).toContain("## 基本原則");
    expect(md).toContain("- 原則A");
  });

  it("falls back to Japanese default description", () => {
    const md = generateConstitutionMd({ description: "", principles: [] }, "ja-JP");
    expect(md).toContain("このファイルは");
  });
});

// ---------------------------------------------------------------------------
// runPlanConstitution — integration
// ---------------------------------------------------------------------------

function makePrompter(answers: string[]): { prompter: Prompter; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const reader = {
    question(prompt: string): Promise<string> {
      calls.push(prompt);
      return Promise.resolve(answers[i++] ?? "");
    },
    close() {},
  };
  const prompter = new Prompter(reader, process.stderr);
  return { prompter, calls };
}

describe("runPlanConstitution", () => {
  it("writes constitution.md with wizard answers", async () => {
    const { prompter } = makePrompter([
      "Decisions are made deliberately and documented.",
      "No shortcuts in tests, Write for the reader",
    ]);

    const result = await runPlanConstitution({
      cwd: tmpDir,
      locale: "en-US",
      force: false,
      prompter,
    });

    expect(result.skipped).toBe(false);
    expect(result.path).toBe(join(tmpDir, "design", "constitution.md"));

    const content = await readFile(result.path, "utf8");
    expect(content).toContain("Decisions are made deliberately");
    expect(content).toContain("- No shortcuts in tests");
    expect(content).toContain("- Write for the reader");
  });

  it("uses default principles when principlesPrompt is left empty", async () => {
    const { prompter } = makePrompter([
      "A guiding description.",
      "", // empty → use defaults
    ]);

    const result = await runPlanConstitution({
      cwd: tmpDir,
      locale: "en-US",
      force: false,
      prompter,
    });

    const content = await readFile(result.path, "utf8");
    expect(content).toContain("Write for the next reader");
  });

  it("uses default description when descriptionPrompt is left empty", async () => {
    const { prompter } = makePrompter([
      "", // empty → use i18n default
      "Custom principle",
    ]);

    const result = await runPlanConstitution({
      cwd: tmpDir,
      locale: "en-US",
      force: false,
      prompter,
    });

    const content = await readFile(result.path, "utf8");
    expect(content).toContain("This file captures the principles");
    expect(content).toContain("- Custom principle");
  });

  it("returns skipped:true when file already exists and force is false", async () => {
    await writeFile(
      join(tmpDir, "design", "constitution.md"),
      "# Existing\n",
      "utf8",
    );

    const { prompter } = makePrompter([]);
    const result = await runPlanConstitution({
      cwd: tmpDir,
      locale: "en-US",
      force: false,
      prompter,
    });

    expect(result.skipped).toBe(true);
    // File should be unchanged
    const content = await readFile(join(tmpDir, "design", "constitution.md"), "utf8");
    expect(content).toBe("# Existing\n");
  });

  it("overwrites file when force is true", async () => {
    await writeFile(
      join(tmpDir, "design", "constitution.md"),
      "# Existing\n",
      "utf8",
    );

    const { prompter } = makePrompter(["New description.", "New principle"]);
    const result = await runPlanConstitution({
      cwd: tmpDir,
      locale: "en-US",
      force: true,
      prompter,
    });

    expect(result.skipped).toBe(false);
    const content = await readFile(result.path, "utf8");
    expect(content).toContain("New description.");
    expect(content).toContain("- New principle");
    expect(content).not.toContain("# Existing");
  });

  it("creates design/ directory if missing", async () => {
    await rm(join(tmpDir, "design"), { recursive: true, force: true });

    const { prompter } = makePrompter(["Description.", "Principle one"]);
    const result = await runPlanConstitution({
      cwd: tmpDir,
      locale: "en-US",
      force: false,
      prompter,
    });

    expect(result.skipped).toBe(false);
    const content = await readFile(result.path, "utf8");
    expect(content).toContain("- Principle one");
  });

  it("produces ja-JP output when locale is ja-JP", async () => {
    const { prompter } = makePrompter([
      "プロジェクトの方針を明示する。",
      "品質を妥協しない",
    ]);

    const result = await runPlanConstitution({
      cwd: tmpDir,
      locale: "ja-JP",
      force: false,
      prompter,
    });

    const content = await readFile(result.path, "utf8");
    expect(content).toContain("## 基本原則");
    expect(content).toContain("プロジェクトの方針を明示する。");
    expect(content).toContain("- 品質を妥協しない");
  });
});

// ---------------------------------------------------------------------------
// v1.6 P17-T4: ConstitutionFileSchema + loaders
// ---------------------------------------------------------------------------

function streamOf(text: string): NodeJS.ReadableStream {
  return Readable.from([text]);
}

describe("ConstitutionFileSchema (v1.6 P17-T4)", () => {
  it("accepts an empty object — both fields default to empty", () => {
    const r = ConstitutionFileSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.description).toBe("");
      expect(r.data.principles).toEqual([]);
    }
  });

  it("accepts both fields populated", () => {
    const r = ConstitutionFileSchema.safeParse({
      description: "d",
      principles: ["a", "b"],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.description).toBe("d");
      expect(r.data.principles).toEqual(["a", "b"]);
    }
  });

  it("accepts description only (principles defaults to [])", () => {
    const r = ConstitutionFileSchema.safeParse({ description: "d" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.principles).toEqual([]);
  });

  it("accepts principles only (description defaults to \"\")", () => {
    const r = ConstitutionFileSchema.safeParse({ principles: ["a"] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.description).toBe("");
  });

  it("rejects wrong type on description", () => {
    const r = ConstitutionFileSchema.safeParse({ description: 123 });
    expect(r.success).toBe(false);
  });

  it("rejects wrong type on principles (string instead of array)", () => {
    const r = ConstitutionFileSchema.safeParse({ principles: "a,b" });
    expect(r.success).toBe(false);
  });

  it("rejects non-string element in principles array", () => {
    const r = ConstitutionFileSchema.safeParse({ principles: ["a", 42] });
    expect(r.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const r = ConstitutionFileSchema.safeParse({
      description: "d",
      bogus: true,
    });
    expect(r.success).toBe(false);
  });
});

async function writeRelativeInTmp(
  dir: string,
  rel: string,
  content: string,
): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

describe("loadConstitutionFromFile (v1.6 P17-T4)", () => {
  it("returns ConstitutionAnswers from a valid YAML file", async () => {
    await writeRelativeInTmp(
      tmpDir,
      "input/c.yaml",
      [
        "description: Project description",
        "principles:",
        "  - First",
        "  - Second",
        "",
      ].join("\n"),
    );
    const answers = await loadConstitutionFromFile(tmpDir, "input/c.yaml");
    expect(answers).toEqual({
      description: "Project description",
      principles: ["First", "Second"],
    });
  });

  it("returns defaults when the file is `{}`", async () => {
    await writeRelativeInTmp(tmpDir, "input/empty.yaml", "{}\n");
    const answers = await loadConstitutionFromFile(tmpDir, "input/empty.yaml");
    expect(answers).toEqual({ description: "", principles: [] });
  });

  it("treats an empty file the same as `{}` (null payload → defaults)", async () => {
    await writeRelativeInTmp(tmpDir, "input/blank.yaml", "");
    const answers = await loadConstitutionFromFile(tmpDir, "input/blank.yaml");
    expect(answers).toEqual({ description: "", principles: [] });
  });

  it("throws PlanConstitutionFromFileError on unsafe path (absolute)", async () => {
    await expect(
      loadConstitutionFromFile(tmpDir, "/etc/passwd"),
    ).rejects.toMatchObject({
      name: "PlanConstitutionFromFileError",
      code: "CONFIG_ERROR",
      detail: "unsafe_path",
    });
  });

  it("throws PlanConstitutionFromFileError on missing file", async () => {
    await expect(
      loadConstitutionFromFile(tmpDir, "missing.yaml"),
    ).rejects.toMatchObject({
      name: "PlanConstitutionFromFileError",
      detail: "unreadable",
      path: "missing.yaml",
    });
  });

  it("throws PlanConstitutionFromFileError on malformed YAML", async () => {
    await writeRelativeInTmp(tmpDir, "input/bad.yaml", "description: [unclosed\n");
    await expect(
      loadConstitutionFromFile(tmpDir, "input/bad.yaml"),
    ).rejects.toMatchObject({
      name: "PlanConstitutionFromFileError",
      detail: "invalid_yaml",
    });
  });

  it("throws PlanConstitutionFromFileError on schema mismatch (unknown key)", async () => {
    await writeRelativeInTmp(
      tmpDir,
      "input/extra.yaml",
      "description: d\nbogus: 1\n",
    );
    await expect(
      loadConstitutionFromFile(tmpDir, "input/extra.yaml"),
    ).rejects.toMatchObject({
      name: "PlanConstitutionFromFileError",
      detail: "schema_invalid",
    });
  });
});

describe("loadConstitutionFromStdin (v1.6 P17-T4)", () => {
  it("returns ConstitutionAnswers from valid YAML on stdin", async () => {
    const answers = await loadConstitutionFromStdin(
      streamOf("description: d\nprinciples:\n  - p1\n"),
    );
    expect(answers).toEqual({ description: "d", principles: ["p1"] });
  });

  it("returns defaults when stdin contains `{}`", async () => {
    const answers = await loadConstitutionFromStdin(streamOf("{}\n"));
    expect(answers).toEqual({ description: "", principles: [] });
  });

  it("returns defaults when stdin is empty (null payload)", async () => {
    const answers = await loadConstitutionFromStdin(streamOf(""));
    expect(answers).toEqual({ description: "", principles: [] });
  });

  it("concatenates multiple chunks before parsing", async () => {
    const stream = Readable.from([
      "description: chunk-one\n",
      "principles:\n",
      "  - chunk-two\n",
      "  - chunk-three\n",
    ]);
    const answers = await loadConstitutionFromStdin(stream);
    expect(answers).toEqual({
      description: "chunk-one",
      principles: ["chunk-two", "chunk-three"],
    });
  });

  it("throws PlanConstitutionFromStdinError on malformed YAML", async () => {
    await expect(
      loadConstitutionFromStdin(streamOf("description: [unclosed\n")),
    ).rejects.toMatchObject({
      name: "PlanConstitutionFromStdinError",
      detail: "invalid_yaml",
    });
  });

  it("throws PlanConstitutionFromStdinError on schema mismatch", async () => {
    await expect(
      loadConstitutionFromStdin(streamOf("bogus: 1\n")),
    ).rejects.toMatchObject({
      name: "PlanConstitutionFromStdinError",
      detail: "schema_invalid",
    });
  });

  it("error messages mention `--stdin` and `<stdin>`", async () => {
    try {
      await loadConstitutionFromStdin(streamOf("description: [unclosed\n"));
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanConstitutionFromStdinError);
      if (err instanceof PlanConstitutionFromStdinError) {
        expect(err.message).toContain("--stdin");
        expect(err.message).toContain("<stdin>");
      }
    }
  });

  it("file and stdin loaders produce identical answers for identical content", async () => {
    const yaml = "description: D\nprinciples:\n  - P1\n  - P2\n";
    const fromStdin = await loadConstitutionFromStdin(streamOf(yaml));
    await writeRelativeInTmp(tmpDir, "c.yaml", yaml);
    const fromFile = await loadConstitutionFromFile(tmpDir, "c.yaml");
    expect(fromStdin).toEqual(fromFile);
  });
});

describe("runPlanConstitution({ answers }) — wizard bypass (v1.6 P17-T4)", () => {
  it("bypasses the wizard and writes design/constitution.md", async () => {
    const result = await runPlanConstitution({
      cwd: tmpDir,
      locale: "en-US",
      force: false,
      answers: { description: "Provided", principles: ["A", "B"] },
    });
    expect(result.skipped).toBe(false);
    const written = await readFile(join(tmpDir, "design/constitution.md"), "utf8");
    expect(written).toContain("Provided");
    expect(written).toContain("- A");
    expect(written).toContain("- B");
  });

  it("respects the file-exists short-circuit when answers are provided", async () => {
    await writeFile(join(tmpDir, "design/constitution.md"), "existing\n", "utf8");
    const result = await runPlanConstitution({
      cwd: tmpDir,
      locale: "en-US",
      force: false,
      answers: { description: "x", principles: ["y"] },
    });
    expect(result.skipped).toBe(true);
    const after = await readFile(join(tmpDir, "design/constitution.md"), "utf8");
    expect(after).toBe("existing\n");
  });

  it("--force overrides the file-exists short-circuit when answers are provided", async () => {
    await writeFile(join(tmpDir, "design/constitution.md"), "stale\n", "utf8");
    const result = await runPlanConstitution({
      cwd: tmpDir,
      locale: "en-US",
      force: true,
      answers: { description: "fresh", principles: ["new"] },
    });
    expect(result.skipped).toBe(false);
    const after = await readFile(join(tmpDir, "design/constitution.md"), "utf8");
    expect(after).toContain("fresh");
    expect(after).toContain("- new");
    expect(after).not.toContain("stale");
  });

  it("empty answers fall back to locale defaults (parity with wizard empty input)", async () => {
    const result = await runPlanConstitution({
      cwd: tmpDir,
      locale: "en-US",
      force: false,
      answers: { description: "", principles: [] },
    });
    expect(result.skipped).toBe(false);
    const after = await readFile(join(tmpDir, "design/constitution.md"), "utf8");
    // Locale defaults from `messages.en-US.templates.constitution`
    expect(after).toContain("Core principles");
    expect(after).toContain("Write for the next reader");
  });
});
