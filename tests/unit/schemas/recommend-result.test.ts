import { describe, it, expect } from "vitest";
import {
  RecommendResultV2,
  PreflightEntry,
  BudgetProfile,
  StructuredReason,
  AmbiguityAction,
  EscalationStep,
  ContextProfile,
  VerificationProfile,
} from "../../../src/core/schemas/recommend-result.ts";

const VALID_PREFLIGHT: unknown = {
  id: "plan_lint",
  command: "plan lint",
  argv: ["plan", "lint", "--json"],
  displayCommand: "code-pact plan lint --json",
  reason: "planning_required",
  required: false,
};

const VALID_REASON: unknown = {
  factor: "ambiguity",
  value: "high",
  effect: "planning_required",
};

const VALID_BUDGET: unknown = {
  toolCalls: "medium",
  contextFiles: "many",
  verificationCommands: "full",
};

const VALID_RESULT: unknown = {
  phaseId: "P6",
  taskId: "P6-T1",
  agentName: "claude-code",
  tier: "highest_reasoning",
  effort: "high",
  modelId: "claude-opus-4-7",
  reasons: ["ambiguity is high"],

  contextProfile: "large",
  verificationProfile: "strong",
  planningRequired: true,
  ambiguityAction: "clarify_before_implementation",
  allowedEscalation: ["increase_context", "ask_human"],
  preflight: [VALID_PREFLIGHT],
  budgetProfile: VALID_BUDGET,
  structuredReasons: [VALID_REASON],
  lifecycleMode: "full_loop",
};

describe("RecommendResultV2 — happy path", () => {
  it("accepts a valid hand-written fixture", () => {
    const r = RecommendResultV2.parse(VALID_RESULT);
    expect(r.phaseId).toBe("P6");
    expect(r.tier).toBe("highest_reasoning");
    expect(r.planningRequired).toBe(true);
    expect(r.preflight).toHaveLength(1);
  });

  it("accepts empty preflight array (no triggers fired)", () => {
    const r = RecommendResultV2.parse({ ...(VALID_RESULT as object), preflight: [] });
    expect(r.preflight).toEqual([]);
  });
});

describe("RecommendResultV2 — required fields", () => {
  it("rejects missing phaseId", () => {
    const { phaseId, ...rest } = VALID_RESULT as Record<string, unknown>;
    void phaseId;
    expect(() => RecommendResultV2.parse(rest)).toThrow();
  });

  it("rejects missing structuredReasons", () => {
    const { structuredReasons, ...rest } = VALID_RESULT as Record<string, unknown>;
    void structuredReasons;
    expect(() => RecommendResultV2.parse(rest)).toThrow();
  });

  it("rejects empty reasons array", () => {
    expect(() => RecommendResultV2.parse({ ...(VALID_RESULT as object), reasons: [] })).toThrow();
  });

  it("rejects empty allowedEscalation array", () => {
    expect(() =>
      RecommendResultV2.parse({ ...(VALID_RESULT as object), allowedEscalation: [] }),
    ).toThrow();
  });

  it("rejects empty structuredReasons array", () => {
    expect(() =>
      RecommendResultV2.parse({ ...(VALID_RESULT as object), structuredReasons: [] }),
    ).toThrow();
  });
});

describe("RecommendResultV2 — enum guards", () => {
  it("rejects invalid tier value", () => {
    expect(() => RecommendResultV2.parse({ ...(VALID_RESULT as object), tier: "godmode" })).toThrow();
  });

  it("rejects invalid ambiguityAction value", () => {
    expect(() =>
      RecommendResultV2.parse({ ...(VALID_RESULT as object), ambiguityAction: "ignore" }),
    ).toThrow();
  });

  it("rejects invalid contextProfile value", () => {
    expect(() =>
      RecommendResultV2.parse({ ...(VALID_RESULT as object), contextProfile: "xl" }),
    ).toThrow();
  });

  it("rejects invalid escalation step", () => {
    expect(() =>
      RecommendResultV2.parse({
        ...(VALID_RESULT as object),
        allowedEscalation: ["increase_context", "pray"],
      }),
    ).toThrow();
  });
});

describe("RecommendResultV2 — strict mode (camelCase contract guard)", () => {
  it("rejects snake_case top-level field (drift guard)", () => {
    expect(() =>
      RecommendResultV2.parse({ ...(VALID_RESULT as object), planning_required: true }),
    ).toThrow();
  });

  it("rejects unknown top-level field", () => {
    expect(() =>
      RecommendResultV2.parse({ ...(VALID_RESULT as object), extraField: 42 }),
    ).toThrow();
  });

  it("rejects unknown field inside a preflight entry", () => {
    const badPreflight = { ...(VALID_PREFLIGHT as object), shellCommand: "rm -rf /" };
    expect(() =>
      RecommendResultV2.parse({ ...(VALID_RESULT as object), preflight: [badPreflight] }),
    ).toThrow();
  });

  it("rejects unknown field inside budgetProfile", () => {
    const badBudget = { ...(VALID_BUDGET as object), tokens: 1234 };
    expect(() =>
      RecommendResultV2.parse({ ...(VALID_RESULT as object), budgetProfile: badBudget }),
    ).toThrow();
  });
});

describe("RecommendResultV2 — preflight cap", () => {
  it("accepts exactly 3 preflight entries", () => {
    const three = [VALID_PREFLIGHT, VALID_PREFLIGHT, VALID_PREFLIGHT];
    const r = RecommendResultV2.parse({ ...(VALID_RESULT as object), preflight: three });
    expect(r.preflight).toHaveLength(3);
  });

  it("rejects 4 preflight entries", () => {
    const four = [VALID_PREFLIGHT, VALID_PREFLIGHT, VALID_PREFLIGHT, VALID_PREFLIGHT];
    expect(() =>
      RecommendResultV2.parse({ ...(VALID_RESULT as object), preflight: four }),
    ).toThrow();
  });
});

describe("PreflightEntry — inner shape", () => {
  it("accepts a valid entry", () => {
    const p = PreflightEntry.parse(VALID_PREFLIGHT);
    expect(p.id).toBe("plan_lint");
    expect(p.argv).toEqual(["plan", "lint", "--json"]);
  });

  it("rejects empty argv", () => {
    expect(() => PreflightEntry.parse({ ...(VALID_PREFLIGHT as object), argv: [] })).toThrow();
  });

  it("rejects non-boolean required field", () => {
    expect(() =>
      PreflightEntry.parse({ ...(VALID_PREFLIGHT as object), required: "yes" }),
    ).toThrow();
  });
});

describe("BudgetProfile — inner shape", () => {
  it("accepts a valid budget profile", () => {
    const b = BudgetProfile.parse(VALID_BUDGET);
    expect(b.toolCalls).toBe("medium");
  });

  it("rejects invalid toolCalls value", () => {
    expect(() => BudgetProfile.parse({ ...(VALID_BUDGET as object), toolCalls: "huge" })).toThrow();
  });

  it("rejects invalid contextFiles value", () => {
    expect(() =>
      BudgetProfile.parse({ ...(VALID_BUDGET as object), contextFiles: "lots" }),
    ).toThrow();
  });

  it("rejects invalid verificationCommands value", () => {
    expect(() =>
      BudgetProfile.parse({ ...(VALID_BUDGET as object), verificationCommands: "max" }),
    ).toThrow();
  });
});

describe("StructuredReason — inner shape", () => {
  it("accepts a valid structured reason", () => {
    const s = StructuredReason.parse(VALID_REASON);
    expect(s.factor).toBe("ambiguity");
    expect(s.effect).toBe("planning_required");
  });

  it("rejects empty factor", () => {
    expect(() => StructuredReason.parse({ ...(VALID_REASON as object), factor: "" })).toThrow();
  });
});

describe("Standalone enum schemas", () => {
  it("AmbiguityAction accepts all three values", () => {
    expect(AmbiguityAction.parse("proceed")).toBe("proceed");
    expect(AmbiguityAction.parse("clarify_before_implementation")).toBe(
      "clarify_before_implementation",
    );
    expect(AmbiguityAction.parse("split_recommended")).toBe("split_recommended");
  });

  it("EscalationStep accepts all four values", () => {
    expect(EscalationStep.parse("increase_context")).toBe("increase_context");
    expect(EscalationStep.parse("increase_effort")).toBe("increase_effort");
    expect(EscalationStep.parse("escalate_tier")).toBe("escalate_tier");
    expect(EscalationStep.parse("ask_human")).toBe("ask_human");
  });

  it("ContextProfile accepts all three values", () => {
    expect(ContextProfile.parse("small")).toBe("small");
    expect(ContextProfile.parse("medium")).toBe("medium");
    expect(ContextProfile.parse("large")).toBe("large");
  });

  it("VerificationProfile accepts all three values", () => {
    expect(VerificationProfile.parse("weak")).toBe("weak");
    expect(VerificationProfile.parse("medium")).toBe("medium");
    expect(VerificationProfile.parse("strong")).toBe("strong");
  });
});
