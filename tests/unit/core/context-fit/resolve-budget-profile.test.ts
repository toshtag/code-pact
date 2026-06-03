// P47 (Context Fit, layer a) — resolver unit tests.
//
// resolveContextBudgetProfile turns a NAME into a byte BUDGET. Order:
// agent-profile override → standard built-in fallback → CONFIG_ERROR.

import { describe, it, expect } from "vitest";
import {
  resolveContextBudgetProfile,
  ContextBudgetProfileError,
} from "../../../../src/core/context-fit/resolve-budget-profile.ts";
import { STANDARD_CONTEXT_BUDGET_PROFILES } from "../../../../src/core/context-fit/budget-profiles.ts";

describe("resolveContextBudgetProfile (P47)", () => {
  it("the constant mirrors the accepted RFC values", () => {
    expect(STANDARD_CONTEXT_BUDGET_PROFILES).toEqual({
      tight: 30000,
      balanced: 60000,
      wide: 120000,
    });
  });

  it("tight resolves to 30000 with no agent profile override", () => {
    expect(resolveContextBudgetProfile({ profileName: "tight" })).toBe(30000);
  });

  it("balanced resolves to 60000 agent-less", () => {
    expect(resolveContextBudgetProfile({ profileName: "balanced" })).toBe(60000);
  });

  it("wide resolves to 120000 agent-less", () => {
    expect(resolveContextBudgetProfile({ profileName: "wide" })).toBe(120000);
  });

  it("an agent profile override wins for a standard profile", () => {
    expect(
      resolveContextBudgetProfile({
        profileName: "tight",
        contextBudget: { profiles: { tight: { max_bytes: 25000 } } },
      }),
    ).toBe(25000);
  });

  it("a custom profile resolves when declared in the agent profile", () => {
    expect(
      resolveContextBudgetProfile({
        profileName: "review",
        contextBudget: { profiles: { review: { max_bytes: 45000 } } },
      }),
    ).toBe(45000);
  });

  it("a standard name still falls back when the agent profile omits it", () => {
    // contextBudget present but only declares a custom profile → standard name
    // still resolves to its built-in value.
    expect(
      resolveContextBudgetProfile({
        profileName: "balanced",
        contextBudget: { profiles: { review: { max_bytes: 45000 } } },
      }),
    ).toBe(60000);
  });

  it("an unknown profile throws ContextBudgetProfileError (code CONFIG_ERROR)", () => {
    expect(() =>
      resolveContextBudgetProfile({ profileName: "tiny", agentName: "claude-code" }),
    ).toThrow(ContextBudgetProfileError);
    try {
      resolveContextBudgetProfile({ profileName: "tiny", agentName: "claude-code" });
    } catch (err) {
      expect((err as ContextBudgetProfileError).code).toBe("CONFIG_ERROR");
      expect((err as Error).message).toContain('"tiny"');
      expect((err as Error).message).toContain("claude-code");
    }
  });

  it("the unknown-profile message lists custom names when the agent declares them", () => {
    try {
      resolveContextBudgetProfile({
        profileName: "tiny",
        contextBudget: { profiles: { review: { max_bytes: 45000 } } },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toContain("review");
    }
  });
});
