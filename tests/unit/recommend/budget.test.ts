import { describe, it, expect } from "vitest";
import { recommendBudgetProfile } from "../../../src/core/recommend/budget.ts";
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

describe("recommendBudgetProfile — toolCalls", () => {
  it("write_surface=high → high (any duration)", () => {
    expect(
      recommendBudgetProfile({ ...BASE_TASK, write_surface: "high", expected_duration: "short" })
        .toolCalls,
    ).toBe("high");
  });

  it("expected_duration=long → high (any write_surface)", () => {
    expect(
      recommendBudgetProfile({ ...BASE_TASK, write_surface: "low", expected_duration: "long" })
        .toolCalls,
    ).toBe("high");
  });

  it("write_surface=high AND expected_duration=long → high", () => {
    expect(
      recommendBudgetProfile({ ...BASE_TASK, write_surface: "high", expected_duration: "long" })
        .toolCalls,
    ).toBe("high");
  });

  it("write_surface=low AND expected_duration=short → low", () => {
    expect(
      recommendBudgetProfile({ ...BASE_TASK, write_surface: "low", expected_duration: "short" })
        .toolCalls,
    ).toBe("low");
  });

  it("write_surface=low AND expected_duration=medium → low", () => {
    expect(
      recommendBudgetProfile({ ...BASE_TASK, write_surface: "low", expected_duration: "medium" })
        .toolCalls,
    ).toBe("low");
  });

  it("write_surface=medium AND expected_duration=short → medium", () => {
    expect(
      recommendBudgetProfile({ ...BASE_TASK, write_surface: "medium", expected_duration: "short" })
        .toolCalls,
    ).toBe("medium");
  });

  it("write_surface=medium AND expected_duration=medium → medium", () => {
    expect(
      recommendBudgetProfile({
        ...BASE_TASK,
        write_surface: "medium",
        expected_duration: "medium",
      }).toolCalls,
    ).toBe("medium");
  });
});

describe("recommendBudgetProfile — contextFiles", () => {
  it("context_size=small → few", () => {
    expect(recommendBudgetProfile({ ...BASE_TASK, context_size: "small" }).contextFiles).toBe(
      "few",
    );
  });

  it("context_size=medium → several", () => {
    expect(recommendBudgetProfile({ ...BASE_TASK, context_size: "medium" }).contextFiles).toBe(
      "several",
    );
  });

  it("context_size=large → many", () => {
    expect(recommendBudgetProfile({ ...BASE_TASK, context_size: "large" }).contextFiles).toBe(
      "many",
    );
  });
});

describe("recommendBudgetProfile — verificationCommands", () => {
  it("verification_strength=weak → minimal", () => {
    expect(
      recommendBudgetProfile({ ...BASE_TASK, verification_strength: "weak" }).verificationCommands,
    ).toBe("minimal");
  });

  it("verification_strength=medium → standard", () => {
    expect(
      recommendBudgetProfile({ ...BASE_TASK, verification_strength: "medium" })
        .verificationCommands,
    ).toBe("standard");
  });

  it("verification_strength=strong → full", () => {
    expect(
      recommendBudgetProfile({ ...BASE_TASK, verification_strength: "strong" })
        .verificationCommands,
    ).toBe("full");
  });
});

describe("recommendBudgetProfile — composition", () => {
  it("returns all three fields in a single profile", () => {
    const profile = recommendBudgetProfile({
      ...BASE_TASK,
      write_surface: "high",
      expected_duration: "long",
      context_size: "large",
      verification_strength: "weak",
    });
    expect(profile).toEqual({
      toolCalls: "high",
      contextFiles: "many",
      verificationCommands: "minimal",
    });
  });
});
