import { describe, it, expect } from "vitest";

import {
  AppliedContextBudget,
  resolveAppliedContextBudget,
} from "../../../../src/core/context-fit/applied-context-budget.ts";
import type { ContextBudgetConfig } from "../../../../src/core/context-fit/resolve-budget-profile.ts";
import type { ContextFitRecommendation } from "../../../../src/core/schemas/recommend-result.ts";

const contextFit: ContextFitRecommendation = {
  recommendedProfile: "balanced",
  recommendedBudgetBytes: 60000,
  reason: "test recommendation",
};

describe("resolveAppliedContextBudget", () => {
  it("keeps no selection unbudgeted in manual mode", () => {
    expect(
      resolveAppliedContextBudget({
        selection: { kind: "none" },
        agentName: "test-agent",
        contextBudget: {
          application_mode: "manual",
          profiles: { custom: { max_bytes: 42000 } },
        },
        recommendation: { contextFit },
      }),
    ).toEqual({ source: "none" });
  });

  it("applies the recommendation for profile recommended mode", () => {
    expect(
      resolveAppliedContextBudget({
        selection: { kind: "none" },
        agentName: "test-agent",
        contextBudget: { application_mode: "recommended" },
        recommendation: { contextFit },
      }),
    ).toEqual({
      source: "recommended_agent_profile",
      profile: "balanced",
      budget_bytes: 60000,
    });
  });

  it("keeps explicit bytes explicit", () => {
    expect(
      resolveAppliedContextBudget({
        selection: { kind: "explicit_bytes", budgetBytes: 12345 },
        agentName: "test-agent",
        recommendation: { contextFit },
      }),
    ).toEqual({ source: "explicit_bytes", budget_bytes: 12345 });
  });

  it("resolves an explicit standard profile", () => {
    expect(
      resolveAppliedContextBudget({
        selection: { kind: "explicit_profile", profileName: "tight" },
        agentName: "test-agent",
        recommendation: { contextFit },
      }),
    ).toEqual({
      source: "explicit_profile",
      profile: "tight",
      budget_bytes: 30000,
    });
  });

  it("resolves an explicit custom profile", () => {
    const contextBudget: ContextBudgetConfig = {
      application_mode: "manual",
      profiles: { review: { max_bytes: 45000 } },
    };
    expect(
      resolveAppliedContextBudget({
        selection: { kind: "explicit_profile", profileName: "review" },
        agentName: "test-agent",
        contextBudget,
        recommendation: { contextFit },
      }),
    ).toEqual({
      source: "explicit_profile",
      profile: "review",
      budget_bytes: 45000,
    });
  });

  it("applies an explicit recommended CLI selection", () => {
    expect(
      resolveAppliedContextBudget({
        selection: { kind: "recommended_cli" },
        agentName: "test-agent",
        recommendation: { contextFit },
      }),
    ).toEqual({
      source: "recommended_cli",
      profile: "balanced",
      budget_bytes: 60000,
    });
  });

  it("uses the supplied contextFit values without recomputing them", () => {
    const supplied: ContextFitRecommendation = {
      recommendedProfile: "wide",
      recommendedBudgetBytes: 120000,
      reason: "caller supplied",
    };
    expect(
      resolveAppliedContextBudget({
        selection: { kind: "recommended_cli" },
        agentName: "test-agent",
        recommendation: { contextFit: supplied },
      }),
    ).toEqual({
      source: "recommended_cli",
      profile: "wide",
      budget_bytes: 120000,
    });
  });

  it("rejects recommended application when contextFit is missing", () => {
    expect(() =>
      resolveAppliedContextBudget({
        selection: { kind: "recommended_cli" },
        agentName: "test-agent",
        recommendation: {},
      }),
    ).toThrow(/missing contextFit/);
  });
});

describe("AppliedContextBudget schema", () => {
  it("accepts valid resolver outputs", () => {
    const resolved = [
      { source: "none" },
      { source: "explicit_bytes", budget_bytes: 1 },
      { source: "explicit_profile", profile: "review", budget_bytes: 45000 },
      { source: "recommended_cli", profile: "balanced", budget_bytes: 60000 },
      {
        source: "recommended_agent_profile",
        profile: "tight",
        budget_bytes: 30000,
      },
    ];

    for (const value of resolved) {
      expect(AppliedContextBudget.safeParse(value).success).toBe(true);
    }
  });

  it("rejects inconsistent field combinations", () => {
    expect(
      AppliedContextBudget.safeParse({
        source: "explicit_bytes",
        profile: "tight",
        budget_bytes: 30000,
      }).success,
    ).toBe(false);
    expect(
      AppliedContextBudget.safeParse({
        source: "explicit_profile",
        budget_bytes: 30000,
      }).success,
    ).toBe(false);
  });

  it("rejects extra budget fields on source none", () => {
    expect(
      AppliedContextBudget.safeParse({
        source: "none",
        budget_bytes: 30000,
      }).success,
    ).toBe(false);
  });

  it("rejects custom profiles for recommended sources", () => {
    expect(
      AppliedContextBudget.safeParse({
        source: "recommended_cli",
        profile: "review",
        budget_bytes: 45000,
      }).success,
    ).toBe(false);
    expect(
      AppliedContextBudget.safeParse({
        source: "recommended_agent_profile",
        profile: "review",
        budget_bytes: 45000,
      }).success,
    ).toBe(false);
  });

  it.each([0, -1, 1.5])("rejects invalid byte value %s", budgetBytes => {
    expect(
      AppliedContextBudget.safeParse({
        source: "explicit_bytes",
        budget_bytes: budgetBytes,
      }).success,
    ).toBe(false);
  });
});
