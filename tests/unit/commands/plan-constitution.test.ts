import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateConstitutionMd,
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
