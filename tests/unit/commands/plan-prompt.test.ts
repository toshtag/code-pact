import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generatePlanningPrompt, runPlanPrompt } from "../../../src/commands/plan-prompt.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-prompt-test-"));
  await mkdir(join(tmpDir, "design"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// generatePlanningPrompt — unit
// ---------------------------------------------------------------------------

describe("generatePlanningPrompt — en-US", () => {
  it("includes the brief content when provided", () => {
    const prompt = generatePlanningPrompt("A CLI tool for developers", null, "en-US");
    expect(prompt).toContain("A CLI tool for developers");
    expect(prompt).toContain("Project Brief");
  });

  it("shows noBriefNotice when brief is null", () => {
    const prompt = generatePlanningPrompt(null, null, "en-US");
    expect(prompt).toContain("design/brief.md");
    expect(prompt).not.toContain("Project Brief\n\nA ");
  });

  it("includes constitution content when provided", () => {
    const prompt = generatePlanningPrompt(null, "Write for the reader.", "en-US");
    expect(prompt).toContain("Project Constitution");
    expect(prompt).toContain("Write for the reader.");
  });

  it("omits constitution section when not provided", () => {
    const prompt = generatePlanningPrompt("brief text", null, "en-US");
    expect(prompt).not.toContain("Project Constitution");
  });

  it("includes YAML format example", () => {
    const prompt = generatePlanningPrompt(null, null, "en-US");
    expect(prompt).toContain("phases:");
    expect(prompt).toContain("definition_of_done:");
    expect(prompt).toContain("verify_commands:");
    expect(prompt).toContain("tasks:");
  });

  it("uses the phase-import schema shape (verify_commands, NOT verification.commands)", () => {
    // Regression guard for the v1.x schema mismatch: the example must use
    // the flat `verify_commands` key that `phase import` actually reads,
    // not the nested `verification:` block (the full Phase shape). When the
    // two diverge, AI-generated YAML silently loses its verify commands.
    const prompt = generatePlanningPrompt(null, null, "en-US");
    expect(prompt).toContain("verify_commands:");
    expect(prompt).not.toContain("verification:");
  });

  it("shows the full 8-value task type enum and lenient-default fields", () => {
    const prompt = generatePlanningPrompt(null, null, "en-US");
    // The actual TaskType enum has 8 values — the example must not under-list.
    expect(prompt).toContain("mechanical_refactor");
    expect(prompt).toContain("other");
    // expected_duration / status are accepted by TaskImport; advertise them.
    expect(prompt).toContain("expected_duration:");
    expect(prompt).toContain("status:");
  });

  it("asks for the six per-task attributes recommend/lint run on", () => {
    const prompt = generatePlanningPrompt(null, null, "en-US");
    expect(prompt).toContain("ambiguity:");
    expect(prompt).toContain("context_size:");
    expect(prompt).toContain("write_surface:");
    expect(prompt).toContain("verification_strength:");
    expect(prompt).toContain("requires_decision:");
  });

  it("includes guidelines section with the uncertainty-marker guidance", () => {
    const prompt = generatePlanningPrompt(null, null, "en-US");
    expect(prompt).toContain("Guidelines");
    expect(prompt).toContain("3–7 phases");
    expect(prompt).toContain("confidence: low");
    expect(prompt).toContain("one task = one PR");
  });

  it("ends with a newline", () => {
    const prompt = generatePlanningPrompt(null, null, "en-US");
    expect(prompt.endsWith("\n")).toBe(true);
  });
});

describe("generatePlanningPrompt — ja-JP", () => {
  it("uses Japanese section headers", () => {
    const prompt = generatePlanningPrompt("CLI ツール", null, "ja-JP");
    expect(prompt).toContain("以下のプロジェクト情報を読んで");
    expect(prompt).toContain("プロジェクト概要");
    expect(prompt).toContain("出力形式");
    expect(prompt).toContain("出力の指針");
  });

  it("shows Japanese noBriefNotice when brief is null", () => {
    const prompt = generatePlanningPrompt(null, null, "ja-JP");
    expect(prompt).toContain("design/brief.md が見つかりません");
  });

  it("includes constitution under Japanese header", () => {
    const prompt = generatePlanningPrompt(null, "原則: 明示より暗示", "ja-JP");
    expect(prompt).toContain("プロジェクト方針");
    expect(prompt).toContain("原則: 明示より暗示");
  });

  it("asks for per-task attributes and the uncertainty-marker guidance", () => {
    const prompt = generatePlanningPrompt(null, null, "ja-JP");
    expect(prompt).toContain("write_surface:");
    expect(prompt).toContain("requires_decision:");
    expect(prompt).toContain("confidence: low");
    expect(prompt).toContain("1 タスク = 1 PR");
  });
});

// ---------------------------------------------------------------------------
// runPlanPrompt — integration (reads files from tmpDir)
// ---------------------------------------------------------------------------

describe("runPlanPrompt", () => {
  it("returns hasBrief:false and hasConstitution:false when files absent", async () => {
    const result = await runPlanPrompt({ cwd: tmpDir, locale: "en-US", clipboard: false });
    expect(result.hasBrief).toBe(false);
    expect(result.hasConstitution).toBe(false);
    expect(result.clipboardCopied).toBe(false);
    expect(result.prompt).toContain("design/brief.md");
  });

  it("includes brief content when design/brief.md exists", async () => {
    await writeFile(join(tmpDir, "design", "brief.md"), "# Project Brief\n\nA great tool.", "utf8");
    const result = await runPlanPrompt({ cwd: tmpDir, locale: "en-US", clipboard: false });
    expect(result.hasBrief).toBe(true);
    expect(result.prompt).toContain("A great tool.");
  });

  it("includes constitution content when design/constitution.md exists", async () => {
    await writeFile(
      join(tmpDir, "design", "constitution.md"),
      "# Constitution\n\nWrite for the reader.",
      "utf8",
    );
    const result = await runPlanPrompt({ cwd: tmpDir, locale: "en-US", clipboard: false });
    expect(result.hasConstitution).toBe(true);
    expect(result.prompt).toContain("Write for the reader.");
  });

  it("produces ja-JP prompt when locale is ja-JP", async () => {
    const result = await runPlanPrompt({ cwd: tmpDir, locale: "ja-JP", clipboard: false });
    expect(result.prompt).toContain("以下のプロジェクト情報を読んで");
  });
});

// ---------------------------------------------------------------------------
// v1.4 P13-T4: suggested_next_steps additive field
// ---------------------------------------------------------------------------

describe("runPlanPrompt — suggested_next_steps (P13-T4)", () => {
  it("is always present (field-presence-fixed) even when no brief/constitution", async () => {
    const result = await runPlanPrompt({ cwd: tmpDir, locale: "en-US", clipboard: false });
    expect(Array.isArray(result.suggested_next_steps)).toBe(true);
    expect(result.suggested_next_steps.length).toBeGreaterThan(0);
  });

  it("prepends a brief/constitution hint when both are absent", async () => {
    const result = await runPlanPrompt({ cwd: tmpDir, locale: "en-US", clipboard: false });
    expect(result.suggested_next_steps[0]).toMatch(/plan brief/);
    expect(result.suggested_next_steps[0]).toMatch(/plan constitution/);
  });

  it("prepends the brief/constitution hint when only one is absent", async () => {
    await writeFile(join(tmpDir, "design", "brief.md"), "# Brief\n", "utf8");
    const result = await runPlanPrompt({ cwd: tmpDir, locale: "en-US", clipboard: false });
    expect(result.suggested_next_steps[0]).toMatch(/plan brief|plan constitution/);
  });

  it("omits the brief/constitution hint when both are present", async () => {
    await writeFile(join(tmpDir, "design", "brief.md"), "# Brief\n", "utf8");
    await writeFile(join(tmpDir, "design", "constitution.md"), "# Constitution\n", "utf8");
    const result = await runPlanPrompt({ cwd: tmpDir, locale: "en-US", clipboard: false });
    // First step is the AI-prompt step, not the brief/constitution hint.
    expect(result.suggested_next_steps[0]).toMatch(/AI agent/);
  });

  it("always includes the canonical AI-assisted planning sequence", async () => {
    const result = await runPlanPrompt({ cwd: tmpDir, locale: "en-US", clipboard: false });
    const joined = result.suggested_next_steps.join("\n");
    expect(joined).toMatch(/AI agent/);
    expect(joined).toMatch(/phase import/);
    expect(joined).toMatch(/plan lint/);
    expect(joined).toMatch(/phase runbook/);
  });

  it("wires clarify-advisory resolution before the runbook step", async () => {
    const result = await runPlanPrompt({ cwd: tmpDir, locale: "en-US", clipboard: false });
    const joined = result.suggested_next_steps.join("\n");
    expect(joined).toMatch(/clarify advisor(?:y|ies)/);
    expect(joined).toContain("TASK_DECISION_UNRESOLVED");
    // lint is invoked with --include-quality so the advisories actually surface.
    expect(joined).toContain("plan lint --include-quality");
  });
});
