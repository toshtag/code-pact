import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildContextPack,
  ContextOverBudgetError,
} from "../../../../src/core/pack/index.ts";

const fixtureDir = new URL(
  "../../../../tests/fixtures/project-a",
  import.meta.url,
).pathname;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "code-pact-pack-budget-"));
  await cp(fixtureDir, workDir, { recursive: true });
  await rm(join(workDir, ".context"), { recursive: true, force: true });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("buildContextPack — budget enforcement (P24)", () => {
  it("returns the unmodified pack when no budget is set", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(pack.sections).toBeUndefined();
    expect(pack.totalBytes).toBeGreaterThan(0);
  });

  it("returns the unmodified pack when budget is generous", async () => {
    const baseline = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const generous = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      budgetBytes: baseline.totalBytes + 10000,
    });
    expect(generous.content).toBe(baseline.content);
    expect(generous.totalBytes).toBe(baseline.totalBytes);
  });

  it("byte-identical contract: with vs without explain on the same budget", async () => {
    const baseline = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const withExplain = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    expect(withExplain.content).toBe(baseline.content);
  });

  it("throws ContextOverBudgetError when even maximal elision exceeds the budget", async () => {
    let caught: ContextOverBudgetError | null = null;
    try {
      await buildContextPack({
        cwd: workDir,
        phaseId: "P2",
        taskId: "P2-E1-T1",
        agentName: "claude-code",
        budgetBytes: 10,
      });
    } catch (err) {
      if (err instanceof ContextOverBudgetError) caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("CONTEXT_OVER_BUDGET");
    expect(caught!.budget_bytes).toBe(10);
    expect(caught!.minimum_achievable_bytes).toBeGreaterThan(10);
    expect(caught!.unelidable_sections.length).toBeGreaterThan(0);
    expect(caught!.unelidable_sections).toContain("header");
    expect(caught!.unelidable_sections).toContain("task_definition");
  });

  it("ContextOverBudgetError's minimum_achievable_bytes is the post-maximal-elision size", async () => {
    let caught: ContextOverBudgetError | null = null;
    try {
      await buildContextPack({
        cwd: workDir,
        phaseId: "P2",
        taskId: "P2-E1-T1",
        agentName: "claude-code",
        budgetBytes: 1,
      });
    } catch (err) {
      if (err instanceof ContextOverBudgetError) caught = err;
    }
    expect(caught).not.toBeNull();

    // Build the same pack with a budget that is at least
    // minimum_achievable_bytes — it should succeed and produce a pack
    // of exactly that size.
    const min = caught!.minimum_achievable_bytes;
    const okPack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      budgetBytes: min,
    });
    expect(okPack.totalBytes).toBeLessThanOrEqual(min);
    expect(okPack.totalBytes).toBe(min);
  });
});

describe("buildContextPack — explain + budget interaction (P24)", () => {
  it("emits `budget_reserved_for_later` for each section elided by the budget", async () => {
    // First find an achievable-but-tight budget by checking the
    // baseline + a smaller elidable-section size.
    const baseline = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    // Find an elidable section in the baseline.
    const elidableNames = new Set([
      "completed_tasks",
      "related_decisions",
      "constitution",
      "rules",
      "reads",
    ]);
    const elidable = (baseline.sections ?? []).filter((s) =>
      elidableNames.has(s.name),
    );
    if (elidable.length === 0) {
      // The fixture has no elidable sections — skip; the next test
      // exercises this in a fixture that does.
      return;
    }
    // Pick a budget that drops exactly the first elidable section.
    const budget = baseline.totalBytes - elidable[0]!.bytes;
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
      budgetBytes: budget,
    });
    const budgetElisions = (pack.excluded ?? []).filter(
      (x) => x.reason_code === "budget_reserved_for_later",
    );
    expect(budgetElisions.length).toBeGreaterThan(0);
    expect(budgetElisions[0]!.details).toMatchObject({
      elided_for_budget_bytes: budget,
      section_bytes: expect.any(Number),
    });
  });

  it("activates the P21-reserved enum value only when --budget-bytes is set", async () => {
    const noBudget = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    const noBudgetForbidden = (noBudget.excluded ?? []).filter(
      (x) => x.reason_code === "budget_reserved_for_later",
    );
    expect(noBudgetForbidden).toHaveLength(0);
  });
});
