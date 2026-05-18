import { describe, it, expect } from "vitest";
import { recommendPreflight } from "../../../src/core/recommend/preflight.ts";
import { PreflightEntry } from "../../../src/core/schemas/recommend-result.ts";
import type { Task } from "../../../src/core/schemas/task.ts";

// BASE_TASK is intentionally "boring" — no triggers fire.
const BASE_TASK: Task = {
  id: "P1-T1",
  type: "feature",
  ambiguity: "low",
  risk: "low",
  context_size: "small",
  write_surface: "low",
  verification_strength: "strong",
  expected_duration: "short",
  status: "planned",
};

describe("recommendPreflight — no triggers", () => {
  it("boring task → empty array", () => {
    expect(recommendPreflight(BASE_TASK)).toEqual([]);
  });

  it("planned status alone does not trigger task_status", () => {
    const out = recommendPreflight({ ...BASE_TASK, status: "planned" });
    expect(out.some((e) => e.id === "task_status")).toBe(false);
  });

  it("done status does not trigger task_status", () => {
    const out = recommendPreflight({ ...BASE_TASK, status: "done" });
    expect(out.some((e) => e.id === "task_status")).toBe(false);
  });

  it("cancelled status does not trigger task_status", () => {
    const out = recommendPreflight({ ...BASE_TASK, status: "cancelled" });
    expect(out.some((e) => e.id === "task_status")).toBe(false);
  });
});

describe("recommendPreflight — planning triggers", () => {
  it("planningRequired (architecture) → plan_lint + plan_analyze", () => {
    const out = recommendPreflight({ ...BASE_TASK, type: "architecture" });
    expect(out.map((e) => e.id)).toEqual(["plan_lint", "plan_analyze"]);
  });

  it("planningRequired (high ambiguity) → plan_lint + plan_analyze", () => {
    const out = recommendPreflight({ ...BASE_TASK, ambiguity: "high" });
    expect(out.map((e) => e.id)).toEqual(["plan_lint", "plan_analyze"]);
  });

  it("planningRequired (high risk) → plan_lint + plan_analyze", () => {
    const out = recommendPreflight({ ...BASE_TASK, risk: "high" });
    expect(out.map((e) => e.id)).toEqual(["plan_lint", "plan_analyze"]);
  });

  it("planningRequired (requires_decision) → plan_lint + plan_analyze", () => {
    const out = recommendPreflight({ ...BASE_TASK, requires_decision: true });
    expect(out.map((e) => e.id)).toEqual(["plan_lint", "plan_analyze"]);
  });

  it("plan_lint entry has the expected argv and displayCommand", () => {
    const out = recommendPreflight({ ...BASE_TASK, ambiguity: "high" });
    const planLint = out.find((e) => e.id === "plan_lint");
    expect(planLint).toMatchObject({
      command: "plan lint",
      argv: ["plan", "lint", "--json"],
      displayCommand: "code-pact plan lint --json",
      reason: "planning_required",
      required: false,
    });
  });

  it("plan_analyze entry has the expected argv and displayCommand", () => {
    const out = recommendPreflight({ ...BASE_TASK, ambiguity: "high" });
    const planAnalyze = out.find((e) => e.id === "plan_analyze");
    expect(planAnalyze).toMatchObject({
      command: "plan analyze",
      argv: ["plan", "analyze", "--json"],
      displayCommand: "code-pact plan analyze --json",
      reason: "planning_required",
      required: false,
    });
  });
});

describe("recommendPreflight — task_status trigger", () => {
  it("in_progress status alone → task_status only", () => {
    const out = recommendPreflight({ ...BASE_TASK, status: "in_progress" });
    expect(out.map((e) => e.id)).toEqual(["task_status"]);
  });

  it("task_status entry interpolates task.id into argv and displayCommand", () => {
    const out = recommendPreflight({ ...BASE_TASK, id: "P6-T3", status: "in_progress" });
    const taskStatus = out.find((e) => e.id === "task_status");
    expect(taskStatus).toMatchObject({
      command: "task status",
      argv: ["task", "status", "P6-T3", "--json"],
      displayCommand: "code-pact task status P6-T3 --json",
      reason: "task_in_progress",
      required: false,
    });
  });
});

describe("recommendPreflight — combined triggers", () => {
  it("planningRequired AND in_progress → all 3 entries in order", () => {
    const out = recommendPreflight({
      ...BASE_TASK,
      ambiguity: "high",
      status: "in_progress",
    });
    expect(out.map((e) => e.id)).toEqual(["plan_lint", "plan_analyze", "task_status"]);
  });

  it("stays within the 3-item cap even with all triggers firing", () => {
    const out = recommendPreflight({
      ...BASE_TASK,
      type: "architecture",
      ambiguity: "high",
      risk: "high",
      requires_decision: true,
      status: "in_progress",
    });
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out.map((e) => e.id)).toEqual(["plan_lint", "plan_analyze", "task_status"]);
  });
});

describe("recommendPreflight — schema conformance", () => {
  it("every entry validates against PreflightEntry zod schema", () => {
    const out = recommendPreflight({
      ...BASE_TASK,
      ambiguity: "high",
      status: "in_progress",
    });
    for (const entry of out) {
      expect(() => PreflightEntry.parse(entry)).not.toThrow();
    }
  });

  it("returns a fresh array each call (no shared mutable state)", () => {
    const a = recommendPreflight({ ...BASE_TASK, ambiguity: "high" });
    a.push({
      id: "stub",
      command: "stub",
      argv: ["stub"],
      displayCommand: "stub",
      reason: "stub",
      required: false,
    });
    const b = recommendPreflight({ ...BASE_TASK, ambiguity: "high" });
    expect(b.map((e) => e.id)).toEqual(["plan_lint", "plan_analyze"]);
  });
});
