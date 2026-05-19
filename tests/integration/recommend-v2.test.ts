import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRecommend, formatRecommend } from "../../src/commands/recommend.ts";
import { RecommendResultV2 } from "../../src/core/schemas/recommend-result.ts";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const cliPath = join(repoRoot, "dist", "cli.js");
const fixtureDir = join(repoRoot, "tests", "fixtures", "project-a");

beforeAll(() => {
  // Build once so the CLI-envelope test below sees the wired-up runRecommend.
  const res = spawnSync("pnpm", ["build"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (res.status !== 0 || !existsSync(cliPath)) {
    throw new Error(
      `Failed to build CLI for tests. exit=${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  }
}, 60_000);

afterAll(() => {
  // Nothing to clean — we use the committed fixture in read-only mode.
});

describe("recommend v0.8 — back-compat regression guard", () => {
  it("v0.7 fields are byte-identical for P2-E1-T1 fixture", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });

    expect(result.phaseId).toBe("P2");
    expect(result.taskId).toBe("P2-E1-T1");
    expect(result.agentName).toBe("claude-code");
    expect(result.tier).toBe("balanced_coding");
    expect(result.effort).toBe("medium");
    expect(result.modelId).toBe("claude-sonnet-4-6");
    expect(result.reasons).toEqual(["default tier for standard feature/refactor/bugfix work"]);
  });
});

describe("recommend v0.8 — new field coverage", () => {
  it("returned shape passes RecommendResultV2 zod validation", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(() => RecommendResultV2.parse(result)).not.toThrow();
  });

  it("balanced_coding task has the full balanced_coding escalation order", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(result.allowedEscalation).toEqual([
      "increase_context",
      "increase_effort",
      "escalate_tier",
      "ask_human",
    ]);
  });

  it("medium ambiguity task triggers plan_lint + plan_analyze preflight", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(result.planningRequired).toBe(true);
    expect(result.preflight.map((p) => p.id)).toEqual(["plan_lint", "plan_analyze"]);
  });

  it("contextProfile reflects medium context_size with medium ambiguity", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(result.contextProfile).toBe("medium");
  });

  it("verificationProfile is a passthrough of verification_strength", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(result.verificationProfile).toBe("strong");
  });

  it("budgetProfile reflects medium context_size + medium write_surface", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(result.budgetProfile).toEqual({
      toolCalls: "medium",
      contextFiles: "several",
      verificationCommands: "full",
    });
  });

  it("structuredReasons is non-empty and zod-valid", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(result.structuredReasons.length).toBeGreaterThanOrEqual(1);
    for (const r of result.structuredReasons) {
      expect(typeof r.factor).toBe("string");
      expect(typeof r.value).toBe("string");
      expect(typeof r.effect).toBe("string");
    }
  });
});

describe("recommend v0.8 — different tiers produce different envelopes", () => {
  it("architecture task (P1-T1) → highest_reasoning + preflight fires", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P1",
      taskId: "P1-T1",
      agentName: "claude-code",
    });
    expect(result.tier).toBe("highest_reasoning");
    expect(result.planningRequired).toBe(true);
    expect(result.allowedEscalation).toEqual(["increase_context", "ask_human"]);
    expect(result.preflight.map((p) => p.id)).toEqual(["plan_lint", "plan_analyze"]);
  });

  it("in_progress task (P1-T2) triggers task_status preflight in addition to planning", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P1",
      taskId: "P1-T2",
      agentName: "claude-code",
    });
    expect(result.preflight.map((p) => p.id)).toEqual([
      "plan_lint",
      "plan_analyze",
      "task_status",
    ]);
    const taskStatus = result.preflight.find((p) => p.id === "task_status");
    expect(taskStatus?.argv).toEqual(["task", "status", "P1-T2", "--json"]);
    expect(taskStatus?.displayCommand).toBe("code-pact task status P1-T2 --json");
  });
});

describe("recommend v0.8 — human formatter", () => {
  it("renders the 5-line v0.7 summary at the top", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const out = formatRecommend(result);
    expect(out).toContain("Task:    P2 / P2-E1-T1");
    expect(out).toContain("Agent:   claude-code");
    expect(out).toContain("Tier:    balanced_coding");
    expect(out).toContain("Model:   claude-sonnet-4-6");
    expect(out).toContain("Effort:  medium");
  });

  it("includes Reasons section with bullets", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const out = formatRecommend(result);
    expect(out).toContain("Reasons:");
    expect(out).toContain("  - default tier for standard feature/refactor/bugfix work");
  });

  it("includes Planning section with all four fields", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const out = formatRecommend(result);
    expect(out).toContain("Planning:");
    expect(out).toContain("Required:");
    expect(out).toContain("Ambiguity action:");
    expect(out).toContain("Context profile:");
    expect(out).toContain("Verification:");
  });

  it("includes numbered Escalation section", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const out = formatRecommend(result);
    expect(out).toContain("Escalation:");
    expect(out).toContain("  1. increase_context");
    expect(out).toContain("  2. increase_effort");
  });

  it("renders Preflight: (none) when no triggers fire", async () => {
    // Find a totally calm task — use a fixture where preflight is empty
    // by using P5-T4 from the actual repo design (status: done, low ambiguity)
    const result = await runRecommend({
      cwd: repoRoot,
      phaseId: "P5",
      taskId: "P5-T4",
      agentName: "claude-code",
    });
    expect(result.preflight).toEqual([]);
    const out = formatRecommend(result);
    expect(out).toContain("Preflight: (none)");
  });

  it("renders Preflight entries with displayCommand + reason when triggers fire", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const out = formatRecommend(result);
    expect(out).toContain("Preflight:");
    expect(out).toContain("- code-pact plan lint --json");
    expect(out).toContain("(reason: planning_required)");
  });

  it("includes Budget section with all three categorical fields", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const out = formatRecommend(result);
    expect(out).toContain("Budget:");
    expect(out).toContain("Tool calls:");
    expect(out).toContain("Context files:");
    expect(out).toContain("Verification commands:");
  });
});

describe("recommend v0.8 — CLI envelope (subprocess)", () => {
  it("--json wraps the v0.8 result in {ok:true, data:...} envelope", () => {
    const res = spawnSync(
      process.execPath,
      [cliPath, "recommend", "--phase", "P2", "--task", "P2-E1-T1", "--json"],
      { cwd: fixtureDir, encoding: "utf8", env: process.env },
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBeDefined();
    expect(parsed.data.phaseId).toBe("P2");
    expect(parsed.data.taskId).toBe("P2-E1-T1");
    // v0.8 fields propagate through the envelope verbatim
    expect(parsed.data.planningRequired).toBe(true);
    expect(parsed.data.contextProfile).toBe("medium");
    expect(parsed.data.budgetProfile).toBeDefined();
    expect(Array.isArray(parsed.data.preflight)).toBe(true);
    // schema-validate the envelope payload
    expect(() => RecommendResultV2.parse(parsed.data)).not.toThrow();
  });
});
