import { describe, it, expect } from "vitest";
import {
  isPlanningRequired,
  recommendAmbiguityAction,
} from "../../../src/core/recommend/planning.ts";
import type { Task } from "../../../src/core/schemas/task.ts";

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

describe("isPlanningRequired — true triggers", () => {
  it("type=architecture → true", () => {
    expect(isPlanningRequired({ ...BASE_TASK, type: "architecture" })).toBe(true);
  });

  it("ambiguity=medium → true", () => {
    expect(isPlanningRequired({ ...BASE_TASK, ambiguity: "medium" })).toBe(true);
  });

  it("ambiguity=high → true", () => {
    expect(isPlanningRequired({ ...BASE_TASK, ambiguity: "high" })).toBe(true);
  });

  it("risk=high → true", () => {
    expect(isPlanningRequired({ ...BASE_TASK, risk: "high" })).toBe(true);
  });

  it("requires_decision=true → true", () => {
    expect(isPlanningRequired({ ...BASE_TASK, requires_decision: true })).toBe(true);
  });
});

describe("isPlanningRequired — false default", () => {
  it("low ambiguity, low risk, feature type, no decision → false", () => {
    expect(isPlanningRequired(BASE_TASK)).toBe(false);
  });

  it("requires_decision=false → false (when nothing else triggers)", () => {
    expect(isPlanningRequired({ ...BASE_TASK, requires_decision: false })).toBe(false);
  });

  it("requires_decision undefined → false (when nothing else triggers)", () => {
    expect(isPlanningRequired(BASE_TASK)).toBe(false);
  });
});

describe("recommendAmbiguityAction — clarify_before_implementation triggers", () => {
  it("requires_decision=true → clarify (highest priority)", () => {
    expect(
      recommendAmbiguityAction({ ...BASE_TASK, requires_decision: true, ambiguity: "low" }),
    ).toBe("clarify_before_implementation");
  });

  it("ambiguity=high → clarify", () => {
    expect(recommendAmbiguityAction({ ...BASE_TASK, ambiguity: "high" })).toBe(
      "clarify_before_implementation",
    );
  });

  it("ambiguity=medium AND risk=high → clarify", () => {
    expect(
      recommendAmbiguityAction({ ...BASE_TASK, ambiguity: "medium", risk: "high" }),
    ).toBe("clarify_before_implementation");
  });
});

describe("recommendAmbiguityAction — split_recommended trigger", () => {
  it("duration=long AND write_surface=high AND ambiguity=medium AND risk!=high → split", () => {
    expect(
      recommendAmbiguityAction({
        ...BASE_TASK,
        expected_duration: "long",
        write_surface: "high",
        ambiguity: "medium",
        risk: "low",
      }),
    ).toBe("split_recommended");
  });

  it("duration=long AND write_surface=high AND ambiguity=high → clarify (clarify wins over split)", () => {
    expect(
      recommendAmbiguityAction({
        ...BASE_TASK,
        expected_duration: "long",
        write_surface: "high",
        ambiguity: "high",
      }),
    ).toBe("clarify_before_implementation");
  });

  it("duration=long AND write_surface=high AND ambiguity=low → proceed (split needs non-low ambiguity)", () => {
    expect(
      recommendAmbiguityAction({
        ...BASE_TASK,
        expected_duration: "long",
        write_surface: "high",
        ambiguity: "low",
      }),
    ).toBe("proceed");
  });
});

describe("recommendAmbiguityAction — proceed defaults", () => {
  it("ambiguity=medium AND risk=low → proceed (not clarify, not split)", () => {
    expect(
      recommendAmbiguityAction({ ...BASE_TASK, ambiguity: "medium", risk: "low" }),
    ).toBe("proceed");
  });

  it("ambiguity=low → proceed", () => {
    expect(recommendAmbiguityAction(BASE_TASK)).toBe("proceed");
  });

  it("ambiguity=medium AND risk=medium → proceed", () => {
    expect(
      recommendAmbiguityAction({ ...BASE_TASK, ambiguity: "medium", risk: "medium" }),
    ).toBe("proceed");
  });
});
