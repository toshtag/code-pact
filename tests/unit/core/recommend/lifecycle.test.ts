import { describe, expect, it } from "vitest";
import { recommendLifecycleMode } from "../../../../src/core/recommend/lifecycle.ts";
import type { Task } from "../../../../src/core/schemas/task.ts";

// A task that satisfies the record_only gate; override per-test.
function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "P1-T1",
    type: "docs",
    ambiguity: "low",
    risk: "low",
    context_size: "small",
    write_surface: "low",
    verification_strength: "strong",
    expected_duration: "short",
    status: "planned",
    ...overrides,
  };
}

const noDecision = { phaseRequiresDecision: false };

describe("recommendLifecycleMode", () => {
  it("decision_loop when the task requires a decision", () => {
    expect(
      recommendLifecycleMode(task({ requires_decision: true }), noDecision),
    ).toBe("decision_loop");
  });

  it("decision_loop when the phase requires a decision", () => {
    expect(
      recommendLifecycleMode(task(), { phaseRequiresDecision: true }),
    ).toBe("decision_loop");
  });

  it("decision wins even for an otherwise record_only-shaped task", () => {
    // docs+low+low+strong would be record_only, but requires_decision overrides.
    expect(
      recommendLifecycleMode(task({ requires_decision: true }), noDecision),
    ).toBe("decision_loop");
  });

  it("record_only for a small strongly-verified docs change", () => {
    expect(recommendLifecycleMode(task({ type: "docs" }), noDecision)).toBe(
      "record_only",
    );
  });

  it("record_only for a small strongly-verified test change", () => {
    expect(recommendLifecycleMode(task({ type: "test" }), noDecision)).toBe(
      "record_only",
    );
  });

  it("full_loop when type is not docs/test (refactor not in the light lane)", () => {
    expect(recommendLifecycleMode(task({ type: "refactor" }), noDecision)).toBe(
      "full_loop",
    );
    expect(recommendLifecycleMode(task({ type: "feature" }), noDecision)).toBe(
      "full_loop",
    );
  });

  it("full_loop when architecture (not auto-decision, and not record_only)", () => {
    expect(
      recommendLifecycleMode(task({ type: "architecture" }), noDecision),
    ).toBe("full_loop");
  });

  it("full_loop when ambiguity is not low", () => {
    expect(
      recommendLifecycleMode(task({ ambiguity: "medium" }), noDecision),
    ).toBe("full_loop");
  });

  it("full_loop when risk is not low", () => {
    expect(recommendLifecycleMode(task({ risk: "high" }), noDecision)).toBe(
      "full_loop",
    );
  });

  it("full_loop when verification_strength is not strong", () => {
    expect(
      recommendLifecycleMode(task({ verification_strength: "medium" }), noDecision),
    ).toBe("full_loop");
    expect(
      recommendLifecycleMode(task({ verification_strength: "weak" }), noDecision),
    ).toBe("full_loop");
  });
});
