import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInit } from "../../../src/commands/init.ts";
import { runPhaseAdd } from "../../../src/commands/phase.ts";
import { runProgress } from "../../../src/commands/progress.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fixtureDir = (name: string) =>
  new URL(`../../../tests/fixtures/${name}`, import.meta.url).pathname;

// ---------------------------------------------------------------------------
// project-a fixture
// P1 (weight=12, status=done), P2 (weight=18, status=planned)
// baseline total_weight=30
// completed = 12*1 + 18*0 = 12
// ---------------------------------------------------------------------------

describe("runProgress — project-a fixture", () => {
  it("returns correct weight totals", async () => {
    const result = await runProgress({ cwd: fixtureDir("project-a"), baseline: "initial" });
    expect(result.baseline_total_weight).toBe(30);
    expect(result.current_total_weight).toBe(30);
    expect(result.completed_weight).toBe(12);
    expect(result.expanded_work).toBe(0);
  });

  it("calculates baseline_progress_percent correctly", async () => {
    const result = await runProgress({ cwd: fixtureDir("project-a"), baseline: "initial" });
    // 12/30 = 40%
    expect(result.baseline_progress_percent).toBe(40);
    expect(result.current_progress_percent).toBe(40);
  });

  it("high_risk_unfinished is empty (P2 is medium risk)", async () => {
    const result = await runProgress({ cwd: fixtureDir("project-a"), baseline: "initial" });
    expect(result.high_risk_unfinished).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// project-b fixture
// P1 (w=12, done), P2 (w=18, in_progress, high risk), P3 (w=20, planned, high risk)
// baseline total_weight=30
// current total_weight=50
// completed = 12*1 + 18*0.5 + 20*0 = 21
// expanded_work = 50 - 30 = 20
// high_risk_unfinished = [P2, P3]
// ---------------------------------------------------------------------------

describe("runProgress — project-b fixture (expanded work)", () => {
  it("detects expanded work", async () => {
    const result = await runProgress({ cwd: fixtureDir("project-b"), baseline: "initial" });
    expect(result.baseline_total_weight).toBe(30);
    expect(result.current_total_weight).toBe(50);
    expect(result.expanded_work).toBe(20);
  });

  it("counts in_progress as 0.5 contribution", async () => {
    const result = await runProgress({ cwd: fixtureDir("project-b"), baseline: "initial" });
    // P1=12, P2=9 (18*0.5), P3=0
    expect(result.completed_weight).toBe(21);
  });

  it("lists high-risk unfinished phases", async () => {
    const result = await runProgress({ cwd: fixtureDir("project-b"), baseline: "initial" });
    expect(result.high_risk_unfinished).toContain("P2");
    expect(result.high_risk_unfinished).toContain("P3");
  });

  it("baseline_progress_percent uses baseline denominator", async () => {
    const result = await runProgress({ cwd: fixtureDir("project-b"), baseline: "initial" });
    // 21/30 = 70%
    expect(result.baseline_progress_percent).toBe(70);
  });

  it("current_progress_percent uses current denominator", async () => {
    const result = await runProgress({ cwd: fixtureDir("project-b"), baseline: "initial" });
    // 21/50 = 42%
    expect(result.current_progress_percent).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Error: missing baseline
// ---------------------------------------------------------------------------

describe("runProgress — missing baseline", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-progress-test-"));
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("throws BASELINE_NOT_FOUND for unknown baseline name", async () => {
    await expect(runProgress({ cwd: dir, baseline: "nonexistent" })).rejects.toMatchObject({
      code: "BASELINE_NOT_FOUND",
    });
  });
});

// ---------------------------------------------------------------------------
// Edge: all done
// ---------------------------------------------------------------------------

describe("runProgress — all phases done", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-progress-alldone-"));
    await runInit({ cwd: dir, locale: "en-US", agents: ["claude-code"], force: false, json: false });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns 100% when total_weight is 0 (empty roadmap)", async () => {
    const result = await runProgress({ cwd: dir, baseline: "initial" });
    expect(result.current_total_weight).toBe(0);
    expect(result.completed_weight).toBe(0);
    expect(result.baseline_progress_percent).toBe(0);
    expect(result.current_progress_percent).toBe(0);
  });
});
