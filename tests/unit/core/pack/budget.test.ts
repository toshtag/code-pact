import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

// P28: project-a's only P2 task (P2-E1-T1) is context_size: medium /
// write_surface: medium with a task-id-matched decision and
// applies_to-matched rules — exactly the "not the large/high expansion"
// case the RFC marks unelidable. These helpers rewrite the copied
// fixture's readiness fields so the same task can also exercise the
// large / high expansions that ARE elidable. P2-core.yaml holds a single
// task, so the first match is unambiguous.
async function setTaskReadiness(
  dir: string,
  changes: { contextSize?: string; writeSurface?: string },
): Promise<void> {
  const p = join(dir, "design/phases/P2-core.yaml");
  let yaml = await readFile(p, "utf8");
  if (changes.contextSize !== undefined) {
    yaml = yaml.replace(/context_size: \w+/, `context_size: ${changes.contextSize}`);
  }
  if (changes.writeSurface !== undefined) {
    yaml = yaml.replace(/write_surface: \w+/, `write_surface: ${changes.writeSurface}`);
  }
  await writeFile(p, yaml, "utf8");
}

async function sectionBytesByName(
  taskId: string,
  name: string,
): Promise<number | null> {
  const pack = await buildContextPack({
    cwd: workDir,
    phaseId: "P2",
    taskId,
    agentName: "claude-code",
    explain: true,
  });
  const section = (pack.sections ?? []).find((s) => s.name === name);
  return section ? section.bytes : null;
}

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
    // P28: exercise the large + high expansion so the full elidable set
    // genuinely applies — related_decisions / rules are only elidable
    // as the large-context / high-write-surface expansions.
    await setTaskReadiness(workDir, { contextSize: "large", writeSurface: "high" });
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

// P28: these names quote the load-bearing context-budget-rfc.md clauses
// so a future regression renames itself in the test report. The previous
// budget test hard-coded the unconditional ELISION_ORDER set and asserted
// elision *happens*; it validated the bug. These pin eligibility instead.
describe("buildContextPack — conditional elision eligibility (P28, context-budget-rfc.md)", () => {
  // RFC: "rules (when write_surface: high — the 'all rules' path; never
  // elides when rules are the default applies-to-matched subset)".
  it("does not elide default applies-to-matched rules under budget pressure (write_surface != high)", async () => {
    // P2-E1-T1 is write_surface: medium → `rules` is the applies_to-matched
    // subset, which must survive maximal elision.
    const baseline = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    expect(
      (baseline.sections ?? []).some((s) => s.name === "rules"),
      "fixture precondition: rules section present",
    ).toBe(true);

    let caught: ContextOverBudgetError | null = null;
    try {
      await buildContextPack({
        cwd: workDir,
        phaseId: "P2",
        taskId: "P2-E1-T1",
        agentName: "claude-code",
        budgetBytes: 100, // far below any achievable size → forces maximal elision
      });
    } catch (err) {
      if (err instanceof ContextOverBudgetError) caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught!.unelidable_sections).toContain("rules");
  });

  // RFC: "related_decisions when context_size: large (the 'all decisions'
  // path; declared decisions via decision_refs stay)".
  it("does not elide task-related decisions under budget pressure unless context_size: large", async () => {
    // P2-E1-T1 is context_size: medium → `related_decisions` is the
    // task-id-matched decision, not the large expansion.
    const baseline = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    expect(
      (baseline.sections ?? []).some((s) => s.name === "related_decisions"),
      "fixture precondition: related_decisions section present",
    ).toBe(true);

    let caught: ContextOverBudgetError | null = null;
    try {
      await buildContextPack({
        cwd: workDir,
        phaseId: "P2",
        taskId: "P2-E1-T1",
        agentName: "claude-code",
        budgetBytes: 100,
      });
    } catch (err) {
      if (err instanceof ContextOverBudgetError) caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught!.unelidable_sections).toContain("related_decisions");
  });

  // RFC: the context_size: large "all decisions" expansion IS the elidable path.
  it("elides expanded decisions under budget pressure when context_size: large", async () => {
    await setTaskReadiness(workDir, { contextSize: "large" });
    const relatedBytes = await sectionBytesByName("P2-E1-T1", "related_decisions");
    expect(relatedBytes, "precondition: related_decisions present").not.toBeNull();

    const baseline = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
      budgetBytes: baseline.totalBytes - relatedBytes!,
    });
    const elided = (pack.excluded ?? [])
      .filter((x) => x.reason_code === "budget_reserved_for_later")
      .map((x) => x.name);
    expect(elided).toContain("related_decisions");
  });

  // RFC: the write_surface: high "all rules" expansion IS the elidable path.
  it("elides expanded rules under budget pressure when write_surface: high", async () => {
    await setTaskReadiness(workDir, { writeSurface: "high" });
    const rulesBytes = await sectionBytesByName("P2-E1-T1", "rules");
    expect(rulesBytes, "precondition: rules present").not.toBeNull();

    const baseline = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
      budgetBytes: baseline.totalBytes - rulesBytes!,
    });
    const elided = (pack.excluded ?? [])
      .filter((x) => x.reason_code === "budget_reserved_for_later")
      .map((x) => x.name);
    expect(elided).toContain("rules");
  });
});
