import { describe, it, expect } from "vitest";
import { recommendContextProfile } from "../../../src/core/recommend/context-profile.ts";
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

describe("recommendContextProfile — context_size=large", () => {
  it("large + low ambiguity → large", () => {
    expect(recommendContextProfile({ ...BASE_TASK, context_size: "large", ambiguity: "low" })).toBe(
      "large",
    );
  });

  it("large + medium ambiguity → large", () => {
    expect(
      recommendContextProfile({ ...BASE_TASK, context_size: "large", ambiguity: "medium" }),
    ).toBe("large");
  });

  it("large + high ambiguity → large", () => {
    expect(
      recommendContextProfile({ ...BASE_TASK, context_size: "large", ambiguity: "high" }),
    ).toBe("large");
  });
});

describe("recommendContextProfile — context_size=medium", () => {
  it("medium + low ambiguity → medium", () => {
    expect(
      recommendContextProfile({ ...BASE_TASK, context_size: "medium", ambiguity: "low" }),
    ).toBe("medium");
  });

  it("medium + medium ambiguity → medium", () => {
    expect(
      recommendContextProfile({ ...BASE_TASK, context_size: "medium", ambiguity: "medium" }),
    ).toBe("medium");
  });

  it("medium + high ambiguity → large (bumped up)", () => {
    expect(
      recommendContextProfile({ ...BASE_TASK, context_size: "medium", ambiguity: "high" }),
    ).toBe("large");
  });
});

describe("recommendContextProfile — context_size=small", () => {
  it("small + low ambiguity → small", () => {
    expect(recommendContextProfile({ ...BASE_TASK, context_size: "small", ambiguity: "low" })).toBe(
      "small",
    );
  });

  it("small + medium ambiguity → small", () => {
    expect(
      recommendContextProfile({ ...BASE_TASK, context_size: "small", ambiguity: "medium" }),
    ).toBe("small");
  });

  it("small + high ambiguity → medium (bumped up)", () => {
    expect(
      recommendContextProfile({ ...BASE_TASK, context_size: "small", ambiguity: "high" }),
    ).toBe("medium");
  });
});
