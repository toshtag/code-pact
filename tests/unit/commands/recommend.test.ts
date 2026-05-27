import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInit } from "../../../src/commands/init.ts";
import { runPhaseAdd } from "../../../src/commands/phase.ts";
import { runRecommend } from "../../../src/commands/recommend.ts";
import { recommendTier } from "../../../src/core/recommend/tier.ts";
import type { Task } from "../../../src/core/schemas/task.ts";

// ---------------------------------------------------------------------------
// Unit tests for the pure recommendTier() function
// ---------------------------------------------------------------------------

const BASE_TASK: Task = {
  id: "T1",
  type: "feature",
  ambiguity: "low",
  risk: "low",
  context_size: "small",
  write_surface: "low",
  verification_strength: "strong",
  expected_duration: "short",
  status: "planned",
};

describe("recommendTier — highest_reasoning triggers", () => {
  it("architecture type → highest_reasoning", () => {
    const rec = recommendTier({ ...BASE_TASK, type: "architecture" });
    expect(rec.tier).toBe("highest_reasoning");
    expect(rec.reasons.some((r) => r.includes("architecture"))).toBe(true);
  });

  it("high ambiguity → highest_reasoning", () => {
    const rec = recommendTier({ ...BASE_TASK, ambiguity: "high" });
    expect(rec.tier).toBe("highest_reasoning");
    expect(rec.reasons.some((r) => r.includes("ambiguity"))).toBe(true);
  });

  it("weak verification alone does NOT escalate the tier", () => {
    // A standard feature with weak verification stays balanced_coding — weak
    // checks should not punish the author into the most expensive tier.
    const rec = recommendTier({ ...BASE_TASK, type: "feature", verification_strength: "weak" });
    expect(rec.tier).toBe("balanced_coding");
    expect(rec.reasons.some((r) => r.includes("weak"))).toBe(false);
  });

  it("high risk + medium ambiguity → highest_reasoning", () => {
    const rec = recommendTier({ ...BASE_TASK, risk: "high", ambiguity: "medium" });
    expect(rec.tier).toBe("highest_reasoning");
  });
});

describe("recommendTier — cheap_mechanical triggers", () => {
  it("docs, low ambiguity, low risk → cheap_mechanical", () => {
    const rec = recommendTier({
      ...BASE_TASK,
      type: "docs",
      ambiguity: "low",
      risk: "low",
      verification_strength: "strong",
    });
    expect(rec.tier).toBe("cheap_mechanical");
    expect(rec.effort).toBe("low");
  });

  it("mechanical_refactor, low ambiguity, low risk → cheap_mechanical", () => {
    const rec = recommendTier({
      ...BASE_TASK,
      type: "mechanical_refactor",
      ambiguity: "low",
      risk: "low",
      verification_strength: "medium",
    });
    expect(rec.tier).toBe("cheap_mechanical");
  });

  it("small docs with weak verification → cheap_mechanical (weak no longer blocks)", () => {
    // BASE_TASK is low write_surface + small context; weak verification on a
    // small, low-risk docs edit stays cheap.
    const rec = recommendTier({
      ...BASE_TASK,
      type: "docs",
      ambiguity: "low",
      risk: "low",
      write_surface: "low",
      context_size: "small",
      verification_strength: "weak",
    });
    expect(rec.tier).toBe("cheap_mechanical");
    expect(rec.effort).toBe("low");
  });

  it("broad docs (high write_surface) is NOT cheap despite type=docs", () => {
    const rec = recommendTier({
      ...BASE_TASK,
      type: "docs",
      ambiguity: "low",
      risk: "low",
      write_surface: "high",
      context_size: "small",
    });
    expect(rec.tier).not.toBe("cheap_mechanical");
  });

  it("large-context docs is NOT cheap despite type=docs", () => {
    const rec = recommendTier({
      ...BASE_TASK,
      type: "docs",
      ambiguity: "low",
      risk: "low",
      write_surface: "low",
      context_size: "large",
    });
    expect(rec.tier).not.toBe("cheap_mechanical");
  });
});

describe("recommendTier — balanced_coding default", () => {
  it("standard feature → balanced_coding", () => {
    const rec = recommendTier({ ...BASE_TASK, type: "feature" });
    expect(rec.tier).toBe("balanced_coding");
  });

  it("refactor → balanced_coding", () => {
    const rec = recommendTier({ ...BASE_TASK, type: "refactor" });
    expect(rec.tier).toBe("balanced_coding");
  });

  it("long duration → effort high", () => {
    const rec = recommendTier({ ...BASE_TASK, type: "feature", expected_duration: "long" });
    expect(rec.tier).toBe("balanced_coding");
    expect(rec.effort).toBe("high");
  });

  it("short duration, low write surface → effort low", () => {
    const rec = recommendTier({
      ...BASE_TASK,
      type: "feature",
      expected_duration: "short",
      write_surface: "low",
    });
    expect(rec.tier).toBe("balanced_coding");
    expect(rec.effort).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Integration: runRecommend against a tmpdir project
// ---------------------------------------------------------------------------

describe("runRecommend — integration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-recommend-test-"));
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
    await runPhaseAdd({
      cwd: dir,
      id: "P1",
      name: "Foundation",
      weight: 10,
      objective: "Establish foundation.",
      confidence: "high",
      risk: "low",
      verifyCommands: ["echo ok"],
      definitionOfDone: ["Done"],
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves concrete modelId from agent profile", async () => {
    // P1 has no inline tasks, so we must use the fixture instead
    const fixtureDir = new URL("../../../tests/fixtures/project-a", import.meta.url).pathname;
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    // P2-E1-T1 is type: feature, ambiguity: medium, risk: medium → balanced_coding
    expect(result.tier).toBe("balanced_coding");
    expect(result.modelId).toBe("claude-sonnet-4-6");
    expect(result.agentName).toBe("claude-code");
  });

  it("throws PHASE_NOT_FOUND for unknown phase", async () => {
    await expect(
      runRecommend({ cwd: dir, phaseId: "NOPE", taskId: "T1", agentName: "claude-code" }),
    ).rejects.toMatchObject({ code: "PHASE_NOT_FOUND" });
  });

  it("throws TASK_NOT_FOUND for unknown task", async () => {
    const fixtureDir = new URL("../../../tests/fixtures/project-a", import.meta.url).pathname;
    await expect(
      runRecommend({ cwd: fixtureDir, phaseId: "P2", taskId: "NOPE", agentName: "claude-code" }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("throws AGENT_NOT_FOUND for missing agent profile", async () => {
    const fixtureDir = new URL("../../../tests/fixtures/project-a", import.meta.url).pathname;
    await expect(
      runRecommend({ cwd: fixtureDir, phaseId: "P2", taskId: "P2-E1-T1", agentName: "gemini" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });
});
