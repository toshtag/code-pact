import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildContextPack,
  ContextOverBudgetError,
} from "../../../../src/core/pack/index.ts";
import { applyBudgetElision } from "../../../../src/core/pack/budget.ts";
import {
  ELISION_ORDER,
  type ContextProjectionCandidate,
  type RenderedSection,
} from "../../../../src/core/pack/formatters/markdown.ts";

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

function syntheticSection(name: string, marker: string, repeat: number): RenderedSection {
  return {
    name,
    lines: [`## ${name}`, marker.repeat(repeat), ""],
  };
}

function bytes(section: RenderedSection): number {
  return Buffer.byteLength(section.lines.join("\n"), "utf8");
}

function projectionCandidate(
  sectionName: "reads" | "related_decisions",
  original: RenderedSection,
  projected: RenderedSection,
): ContextProjectionCandidate {
  return {
    sectionName,
    kind:
      sectionName === "reads"
        ? "read_directory_counts"
        : "decision_implementation_commitments",
    original,
    projected,
    originalBytes: bytes(original),
    projectedBytes: bytes(projected),
  };
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
      budgetBytes: baseline.explainMetrics!.minimumAchievableBytes,
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
      budgetBytes: baseline.explainMetrics!.minimumAchievableBytes,
    });
    const elided = (pack.excluded ?? [])
      .filter((x) => x.reason_code === "budget_reserved_for_later")
      .map((x) => x.name);
    expect(elided).toContain("rules");
  });
});

// P49 (Context Fit, layer c): the additive `explainMetrics` byte projection.
// These exercise the SAME applyBudgetElision path the budget tests above use,
// but assert the observable metrics rather than the elision side effects. The
// floor invariant (success vs CONTEXT_OVER_BUDGET) is the principal property.
describe("buildContextPack — explain metrics (P49)", () => {
  it("with no budget: natural == final, zero savings, no budget_bytes, empty elided", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    const m = pack.explainMetrics;
    expect(m).toBeDefined();
    expect(m!.naturalBytes).toBe(m!.finalBytes);
    expect(m!.savedBytes).toBe(0);
    expect(m!.deferredBytes).toBe(0);
    expect(m!.savedRatio).toBe(0);
    expect(m!.elidedSections).toEqual([]);
    expect(m!.budgetBytes).toBeUndefined();
    // The floor is computed even with no budget (it is a property of the task,
    // not of any particular budget) and never exceeds the natural size.
    expect(m!.minimumAchievableBytes).toBeGreaterThan(0);
    expect(m!.minimumAchievableBytes).toBeLessThanOrEqual(m!.naturalBytes);
  });

  it("final_bytes equals the result's totalBytes (== context_pack_bytes)", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    expect(pack.explainMetrics!.finalBytes).toBe(pack.totalBytes);
  });

  it("explain metadata does not change the rendered content (byte-identical)", async () => {
    const plain = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const explained = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    expect(explained.content).toBe(plain.content);
  });

  it("with a budget that fits without elision: natural == final, savings zero, budget_bytes present", async () => {
    const baseline = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const generous = baseline.totalBytes + 10000;
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
      budgetBytes: generous,
    });
    const m = pack.explainMetrics!;
    expect(m.naturalBytes).toBe(m.finalBytes);
    expect(m.savedBytes).toBe(0);
    expect(m.deferredBytes).toBe(0);
    expect(m.savedRatio).toBe(0);
    expect(m.elidedSections).toEqual([]);
    expect(m.budgetBytes).toBe(generous);
  });

  it("with a budget that triggers deferral: saved == natural - final and elided sections follow ELISION_ORDER", async () => {
    // large + high so the full eligible set genuinely applies.
    await setTaskReadiness(workDir, { contextSize: "large", writeSurface: "high" });
    const baseline = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    const floor = baseline.explainMetrics!.minimumAchievableBytes;
    // A budget strictly between the floor and the natural size forces at least
    // one elision while remaining achievable.
    const budget = Math.floor((floor + baseline.totalBytes) / 2);
    expect(budget).toBeGreaterThan(floor);
    expect(budget).toBeLessThan(baseline.totalBytes);

    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
      budgetBytes: budget,
    });
    const m = pack.explainMetrics!;
    expect(m.naturalBytes).toBe(baseline.totalBytes);
    expect(m.naturalBytes).toBeGreaterThan(m.finalBytes);
    expect(m.finalBytes).toBe(pack.totalBytes);
    expect(m.savedBytes).toBe(m.naturalBytes - m.finalBytes);
    expect(m.deferredBytes).toBe(
      m.elidedSections.reduce((sum, section) => sum + section.bytes, 0),
    );
    expect(m.savedRatio).toBe(m.savedBytes / m.naturalBytes);
    expect(m.elidedSections.length).toBeGreaterThan(0);

    // elided_sections is in actual elision order (a subsequence of the eligible
    // ELISION_ORDER) and mirrors the budget_reserved_for_later excluded subset.
    const elidedNames = m.elidedSections.map((e) => e.name);
    const orderIndex = elidedNames.map((n) => ELISION_ORDER.indexOf(n));
    expect(orderIndex).toEqual([...orderIndex].sort((a, b) => a - b));
    expect(orderIndex.every((i) => i >= 0)).toBe(true);
    const budgetExcluded = (pack.excluded ?? []).filter(
      (x) => x.reason_code === "budget_reserved_for_later",
    );
    expect(elidedNames).toEqual(budgetExcluded.map((x) => x.name));
    // Each elided section carries its own byte size (the per-section bytes, not
    // counting the inter-section newline) and that value mirrors the matching
    // excluded[].details.section_bytes — the documented projection guarantee.
    for (const e of m.elidedSections) {
      expect(e.bytes).toBeGreaterThan(0);
      const ex = budgetExcluded.find((x) => x.name === e.name);
      expect(ex?.details?.section_bytes).toBe(e.bytes);
    }
  });

  it("counts the Deferred Context guidance section inside the requested budget", async () => {
    await setTaskReadiness(workDir, { contextSize: "large", writeSurface: "high" });
    const baseline = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    const firstPresentEligible = ELISION_ORDER.map(name =>
      (baseline.sections ?? []).find(section => section.name === name),
    ).find(Boolean)!;

    // Old elision accepted this exact budget after dropping only the first
    // eligible section. P52 must include the guidance overhead, so it needs at
    // least one additional deferred section.
    const budget = baseline.totalBytes - firstPresentEligible.bytes;
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
      budgetBytes: budget,
    });

    expect(pack.totalBytes).toBeLessThanOrEqual(budget);
    expect(pack.content).toContain("## Deferred Context");
    expect(pack.content).toContain(
      "The following sections were withheld to satisfy the context byte budget:",
    );
    expect(pack.deferredContext).toBeDefined();
    expect(pack.deferredContext!.manifest_ref).toMatch(
      /^context:sha256:[0-9a-f]{64}$/,
    );
    expect(pack.deferredContext!.sections.length).toBeGreaterThan(1);
    expect(pack.explainMetrics!.deferredBytes).toBe(
      pack.explainMetrics!.elidedSections.reduce(
        (sum, section) => sum + section.bytes,
        0,
      ),
    );
    expect(pack.explainMetrics!.savedBytes).not.toBe(
      pack.explainMetrics!.deferredBytes,
    );
  });

  it("FLOOR INVARIANT: the explain minimum_achievable_bytes equals the CONTEXT_OVER_BUDGET floor for the same task", async () => {
    // The single most delicate Context Fit property: the success-path floor and
    // the error-path floor must agree. Same task, same eligibility state.
    await setTaskReadiness(workDir, { contextSize: "large", writeSurface: "high" });
    const explained = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    const floorFromExplain = explained.explainMetrics!.minimumAchievableBytes;

    let caught: ContextOverBudgetError | null = null;
    try {
      await buildContextPack({
        cwd: workDir,
        phaseId: "P2",
        taskId: "P2-E1-T1",
        agentName: "claude-code",
        budgetBytes: 1, // unachievable → forces the error floor
      });
    } catch (err) {
      if (err instanceof ContextOverBudgetError) caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught!.minimum_achievable_bytes).toBe(floorFromExplain);

    // And a budget exactly at the floor succeeds at exactly that size.
    const atFloor = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
      budgetBytes: floorFromExplain,
    });
    expect(atFloor.totalBytes).toBe(floorFromExplain);
    expect(atFloor.explainMetrics!.finalBytes).toBe(floorFromExplain);
  });

  it("floor eligibility: related_decisions counts toward the floor only when context_size: large", async () => {
    // medium → related_decisions is the task-id-matched (unelidable) subset, so
    // it stays in the floor; large → it is the elidable "all decisions"
    // expansion, so the floor drops by at least its bytes.
    const mediumFloor = (
      await buildContextPack({
        cwd: workDir,
        phaseId: "P2",
        taskId: "P2-E1-T1",
        agentName: "claude-code",
        explain: true,
      })
    ).explainMetrics!.minimumAchievableBytes;

    const relatedBytes = await sectionBytesByName("P2-E1-T1", "related_decisions");
    expect(relatedBytes, "precondition: related_decisions present").not.toBeNull();

    await setTaskReadiness(workDir, { contextSize: "large" });
    const largeFloor = (
      await buildContextPack({
        cwd: workDir,
        phaseId: "P2",
        taskId: "P2-E1-T1",
        agentName: "claude-code",
        explain: true,
      })
    ).explainMetrics!.minimumAchievableBytes;

    // The large floor excludes related_decisions; the medium floor keeps it.
    expect(largeFloor).toBeLessThan(mediumFloor);
  });

  it("floor eligibility: rules count toward the floor only when write_surface: high", async () => {
    const mediumFloor = (
      await buildContextPack({
        cwd: workDir,
        phaseId: "P2",
        taskId: "P2-E1-T1",
        agentName: "claude-code",
        explain: true,
      })
    ).explainMetrics!.minimumAchievableBytes;

    const rulesBytes = await sectionBytesByName("P2-E1-T1", "rules");
    expect(rulesBytes, "precondition: rules present").not.toBeNull();

    await setTaskReadiness(workDir, { writeSurface: "high" });
    const highFloor = (
      await buildContextPack({
        cwd: workDir,
        phaseId: "P2",
        taskId: "P2-E1-T1",
        agentName: "claude-code",
        explain: true,
      })
    ).explainMetrics!.minimumAchievableBytes;

    // write_surface: high makes `rules` (the all-rules expansion) elidable, so
    // the floor drops; at write_surface: medium the applies-to subset stays.
    expect(highFloor).toBeLessThan(mediumFloor);
  });
});

describe("applyBudgetElision — structural projection planning (P54)", () => {
  it("keeps evaluating a projection that becomes beneficial after shared deferral overhead", () => {
    const readsOriginal = syntheticSection("reads", "r", 1100);
    const readsProjected = syntheticSection("reads", "p", 940);
    const rendered: RenderedSection[] = [
      syntheticSection("header", "h", 40),
      syntheticSection("task_definition", "t", 40),
      syntheticSection("completed_tasks", "c", 520),
      syntheticSection("constitution", "k", 520),
      readsOriginal,
      syntheticSection("verification_commands", "v", 40),
    ];
    const candidate = projectionCandidate("reads", readsOriginal, readsProjected);
    const eligibility = { isLarge: false, isLargeWriteSurface: false };
    const natural = applyBudgetElision(rendered, undefined, eligibility).metrics
      .naturalBytes;

    let chosen:
      | { budget: number; result: ReturnType<typeof applyBudgetElision> }
      | undefined;
    for (let budget = 1; budget < natural; budget += 1) {
      try {
        const result = applyBudgetElision(rendered, budget, eligibility, [candidate]);
        if (
          result.elidedNames.length === 1 &&
          result.elidedNames[0] === "completed_tasks" &&
          result.pendingContextManifest?.manifest.sections.some(
            section => section.name === "reads",
          )
        ) {
          chosen = { budget, result };
          break;
        }
      } catch {
        // Keep scanning for the narrow budget window this regression exercises.
      }
    }

    expect(chosen, "precondition: regression budget exists").toBeDefined();
    expect(chosen!.result.metrics.finalBytes).toBeLessThanOrEqual(chosen!.budget);
    expect(chosen!.result.elidedNames).toEqual(["completed_tasks"]);
    expect(chosen!.result.sections.some(section => section.name === "reads")).toBe(true);
    expect(chosen!.result.pendingContextManifest?.manifest.sections.map(section => section.name))
      .toEqual(["reads", "completed_tasks"]);
    expect(chosen!.result.metrics.elidedSections.map(section => section.name))
      .not.toContain("reads");
    expect(chosen!.result.metrics.deferredBytes).toBe(
      chosen!.result.pendingContextManifest!.manifest.sections.reduce(
        (sum, section) => sum + section.bytes,
        0,
      ),
    );
    const content = chosen!.result.sections.flatMap(section => section.lines).join("\n");
    expect(content.match(/Manifest reference:/g)).toHaveLength(1);
    expect(content).toContain("- reads — projected inline; exact original represented after materialization");
    expect(content).toContain("- completed_tasks — deferred from the inline pack");

    const noProjection = applyBudgetElision(rendered, chosen!.budget, eligibility);
    expect(noProjection.elidedNames).toEqual(["completed_tasks", "constitution"]);
  });

  it("does not add a second projection when one projection reaches the same elision count", () => {
    const readsOriginal = syntheticSection("reads", "r", 1500);
    const readsProjected = syntheticSection("reads", "p", 100);
    const relatedOriginal = syntheticSection("related_decisions", "d", 1500);
    const relatedProjected = syntheticSection("related_decisions", "q", 100);
    const rendered: RenderedSection[] = [
      syntheticSection("header", "h", 40),
      syntheticSection("task_definition", "t", 40),
      readsOriginal,
      relatedOriginal,
      syntheticSection("verification_commands", "v", 40),
    ];
    const candidates = [
      projectionCandidate("reads", readsOriginal, readsProjected),
      projectionCandidate("related_decisions", relatedOriginal, relatedProjected),
    ];
    const eligibility = { isLarge: true, isLargeWriteSurface: false };
    const natural = applyBudgetElision(rendered, undefined, eligibility).metrics
      .naturalBytes;
    const budget = natural - 800;

    const result = applyBudgetElision(rendered, budget, eligibility, candidates);

    expect(result.elidedNames).toEqual([]);
    expect(result.metrics.finalBytes).toBeLessThanOrEqual(budget);
    expect(result.pendingContextManifest?.manifest.sections.map(section => section.name))
      .toEqual(["reads"]);
    const content = result.sections.flatMap(section => section.lines).join("\n");
    expect(content).toContain("d".repeat(1500));
    expect(content).not.toContain("r".repeat(1500));
  });

  it("selects both projections when only the combined projected plan avoids full deferral", () => {
    const readsOriginal = syntheticSection("reads", "r", 3000);
    const readsProjected = syntheticSection("reads", "p", 1200);
    const relatedOriginal = syntheticSection("related_decisions", "d", 3000);
    const relatedProjected = syntheticSection("related_decisions", "q", 1200);
    const rendered: RenderedSection[] = [
      syntheticSection("header", "h", 40),
      syntheticSection("task_definition", "t", 40),
      readsOriginal,
      relatedOriginal,
      syntheticSection("verification_commands", "v", 40),
    ];
    const candidates = [
      projectionCandidate("reads", readsOriginal, readsProjected),
      projectionCandidate("related_decisions", relatedOriginal, relatedProjected),
    ];
    const eligibility = { isLarge: true, isLargeWriteSurface: false };
    const budget = 4713;

    const result = applyBudgetElision(rendered, budget, eligibility, candidates);
    const readsOnly = applyBudgetElision(rendered, budget, eligibility, [
      candidates[0]!,
    ]);
    const relatedOnly = applyBudgetElision(rendered, budget, eligibility, [
      candidates[1]!,
    ]);

    expect(result.elidedNames).toEqual([]);
    expect(result.metrics.finalBytes).toBeLessThanOrEqual(budget);
    expect(result.pendingContextManifest?.manifest.sections.map(section => section.name))
      .toEqual(["reads", "related_decisions"]);
    expect(readsOnly.elidedNames.length).toBeGreaterThan(0);
    expect(relatedOnly.elidedNames.length).toBeGreaterThan(0);

    const content = result.sections.flatMap(section => section.lines).join("\n");
    expect(content.match(/Manifest reference:/g)).toHaveLength(1);
    expect(content).toContain("p".repeat(1200));
    expect(content).toContain("q".repeat(1200));
    expect(content).not.toContain("r".repeat(3000));
    expect(content).not.toContain("d".repeat(3000));
  });

  it("rejects projections that are never smaller than the same-stage comparison plan", () => {
    const readsOriginal = syntheticSection("reads", "r", 1100);
    const readsProjected = syntheticSection("reads", "p", 1080);
    const rendered: RenderedSection[] = [
      syntheticSection("header", "h", 40),
      syntheticSection("task_definition", "t", 40),
      syntheticSection("completed_tasks", "c", 520),
      syntheticSection("constitution", "k", 520),
      readsOriginal,
      syntheticSection("verification_commands", "v", 40),
    ];
    const candidate = projectionCandidate("reads", readsOriginal, readsProjected);
    const eligibility = { isLarge: false, isLargeWriteSurface: false };
    const budget = 2368;

    expect(candidate.projectedBytes).toBeLessThan(candidate.originalBytes);
    const result = applyBudgetElision(rendered, budget, eligibility, [candidate]);

    expect(result.elidedNames).toEqual(["completed_tasks"]);
    expect(result.pendingContextManifest?.manifest.sections.map(section => section.name))
      .toEqual(["completed_tasks"]);
    expect(result.sections.some(section => section.details?.projection_kind)).toBe(false);
    expect(result.sections.flatMap(section => section.lines).join("\n"))
      .toContain("r".repeat(1100));
  });

  it("orders mixed projected originals before fully deferred sections in one manifest", () => {
    const readsOriginal = syntheticSection("reads", "r", 3000);
    const readsProjected = syntheticSection("reads", "p", 1200);
    const relatedOriginal = syntheticSection("related_decisions", "d", 3000);
    const relatedProjected = syntheticSection("related_decisions", "q", 1200);
    const rendered: RenderedSection[] = [
      syntheticSection("header", "h", 40),
      syntheticSection("task_definition", "t", 40),
      syntheticSection("completed_tasks", "c", 900),
      relatedOriginal,
      syntheticSection("constitution", "k", 900),
      readsOriginal,
      syntheticSection("verification_commands", "v", 40),
    ];
    const candidates = [
      projectionCandidate("reads", readsOriginal, readsProjected),
      projectionCandidate("related_decisions", relatedOriginal, relatedProjected),
    ];
    const eligibility = { isLarge: false, isLargeWriteSurface: false };
    const budget = 4052;

    const result = applyBudgetElision(rendered, budget, eligibility, candidates);
    const manifestSections = result.pendingContextManifest!.manifest.sections;

    expect(result.elidedNames).toEqual(["completed_tasks", "constitution"]);
    expect(manifestSections.map(section => section.name)).toEqual([
      "reads",
      "related_decisions",
      "completed_tasks",
      "constitution",
    ]);
    expect(new Set(manifestSections.map(section => section.name)).size)
      .toBe(manifestSections.length);
    expect(result.metrics.deferredBytes).toBe(
      manifestSections.reduce((sum, section) => sum + section.bytes, 0),
    );
    expect(result.metrics.finalBytes).toBeLessThanOrEqual(budget);
    expect(result.metrics.naturalBytes - result.metrics.finalBytes)
      .toBeGreaterThan(0);
    expect(result.metrics.elidedSections.map(section => section.name))
      .toEqual(["completed_tasks", "constitution"]);
  });
});
