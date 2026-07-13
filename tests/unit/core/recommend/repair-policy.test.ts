import { describe, expect, it } from "vitest";
import {
  recommendRepairPolicy,
  formatRepairPolicySummary,
} from "../../../../src/core/recommend/repair-policy.ts";
import { RecommendResultV2 } from "../../../../src/core/schemas/recommend-result.ts";
import type { LifecycleMode, RepairPolicy } from "../../../../src/core/schemas/recommend-result.ts";
import type { Task } from "../../../../src/core/schemas/task.ts";

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

const BOUNDED_POLICY: RepairPolicy = {
  mode: "bounded",
  maxRepairAttempts: 1,
  retryableFailureKinds: ["command_failed"],
  nonRetryableFailureKinds: [
    "timed_out",
    "aborted",
    "decision_required",
    "unsafe_write",
    "invalid_state",
    "unknown",
  ],
  retryContext: "failure_delta",
  firstRetry: "same_model_same_effort_same_context",
  stopOnRepeatedFingerprint: true,
  afterExhaustion: "use_allowed_escalation",
};

function policy(
  overrides: Partial<Task> = {},
  lifecycleMode: LifecycleMode = "full_loop",
): RepairPolicy {
  return recommendRepairPolicy({ ...BASE_TASK, ...overrides }, lifecycleMode);
}

function validResult(repairPolicy: unknown = BOUNDED_POLICY): Record<string, unknown> {
  return {
    phaseId: "P1",
    taskId: "T1",
    agentName: "claude-code",
    tier: "balanced_coding",
    effort: "medium",
    modelId: "claude-sonnet-4-6",
    reasons: ["default tier"],
    contextProfile: "small",
    verificationProfile: "strong",
    planningRequired: false,
    ambiguityAction: "proceed",
    allowedEscalation: ["increase_context"],
    preflight: [],
    budgetProfile: {
      toolCalls: "low",
      contextFiles: "few",
      verificationCommands: "standard",
    },
    structuredReasons: [
      { factor: "defaults", value: "standard", effect: "tier=balanced_coding" },
    ],
    lifecycleMode: "full_loop",
    repairPolicy,
  };
}

describe("recommendRepairPolicy — direct branches", () => {
  it("decision_loop -> disabled / decision_loop", () => {
    expect(policy({}, "decision_loop")).toEqual({
      mode: "disabled",
      reasonCode: "decision_loop",
    });
  });

  it("record_only -> disabled / record_only", () => {
    expect(policy({}, "record_only")).toEqual({
      mode: "disabled",
      reasonCode: "record_only",
    });
  });

  it("architecture -> disabled / architecture", () => {
    expect(policy({ type: "architecture" })).toEqual({
      mode: "disabled",
      reasonCode: "architecture",
    });
  });

  it("high ambiguity -> disabled / high_ambiguity", () => {
    expect(policy({ ambiguity: "high" })).toEqual({
      mode: "disabled",
      reasonCode: "high_ambiguity",
    });
  });

  it("high risk -> disabled / high_risk", () => {
    expect(policy({ risk: "high" })).toEqual({
      mode: "disabled",
      reasonCode: "high_risk",
    });
  });

  it("high write surface -> disabled / high_write_surface", () => {
    expect(policy({ write_surface: "high" })).toEqual({
      mode: "disabled",
      reasonCode: "high_write_surface",
    });
  });

  it("weak verification -> disabled / weak_verification", () => {
    expect(policy({ verification_strength: "weak" })).toEqual({
      mode: "disabled",
      reasonCode: "weak_verification",
    });
  });

  it("eligible task -> exact bounded policy", () => {
    expect(policy()).toEqual(BOUNDED_POLICY);
  });

  it("does not mutate the input task", () => {
    const task = { ...BASE_TASK };
    const before = structuredClone(task);
    recommendRepairPolicy(task, "full_loop");
    expect(task).toEqual(before);
  });
});

describe("recommendRepairPolicy — priority", () => {
  it("decision_loop + architecture + high ambiguity -> decision_loop", () => {
    expect(policy({ type: "architecture", ambiguity: "high" }, "decision_loop")).toEqual({
      mode: "disabled",
      reasonCode: "decision_loop",
    });
  });

  it("record_only + architecture -> record_only", () => {
    expect(policy({ type: "architecture" }, "record_only")).toEqual({
      mode: "disabled",
      reasonCode: "record_only",
    });
  });

  it("architecture + high ambiguity + high risk -> architecture", () => {
    expect(policy({ type: "architecture", ambiguity: "high", risk: "high" })).toEqual({
      mode: "disabled",
      reasonCode: "architecture",
    });
  });

  it("high ambiguity + high risk + high write surface -> high_ambiguity", () => {
    expect(policy({ ambiguity: "high", risk: "high", write_surface: "high" })).toEqual({
      mode: "disabled",
      reasonCode: "high_ambiguity",
    });
  });

  it("high risk + high write surface + weak verification -> high_risk", () => {
    expect(policy({ risk: "high", write_surface: "high", verification_strength: "weak" })).toEqual({
      mode: "disabled",
      reasonCode: "high_risk",
    });
  });

  it("high write surface + weak verification -> high_write_surface", () => {
    expect(policy({ write_surface: "high", verification_strength: "weak" })).toEqual({
      mode: "disabled",
      reasonCode: "high_write_surface",
    });
  });
});

describe("RepairPolicy schema rejection", () => {
  it("rejects maxRepairAttempts: 2", () => {
    expect(() =>
      RecommendResultV2.parse(validResult({ ...BOUNDED_POLICY, maxRepairAttempts: 2 })),
    ).toThrow();
  });

  it("rejects unknown failure kind", () => {
    expect(() =>
      RecommendResultV2.parse(
        validResult({
          ...BOUNDED_POLICY,
          retryableFailureKinds: ["command_failed", "timed_out"],
        }),
      ),
    ).toThrow();
  });

  it("rejects bounded field mixed into disabled branch", () => {
    expect(() =>
      RecommendResultV2.parse(
        validResult({
          mode: "disabled",
          reasonCode: "architecture",
          maxRepairAttempts: 1,
        }),
      ),
    ).toThrow();
  });

  it("rejects reasonCode mixed into bounded branch", () => {
    expect(() =>
      RecommendResultV2.parse(
        validResult({
          ...BOUNDED_POLICY,
          reasonCode: "architecture",
        }),
      ),
    ).toThrow();
  });

  it("rejects unknown top-level field", () => {
    expect(() =>
      RecommendResultV2.parse({
        ...validResult(),
        repair_policy: BOUNDED_POLICY,
      }),
    ).toThrow();
  });

  it("rejects missing nonretryable kind", () => {
    expect(() =>
      RecommendResultV2.parse(
        validResult({
          ...BOUNDED_POLICY,
          nonRetryableFailureKinds: [
            "timed_out",
            "aborted",
            "decision_required",
            "unsafe_write",
            "invalid_state",
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects reordered nonretryable kinds", () => {
    expect(() =>
      RecommendResultV2.parse(
        validResult({
          ...BOUNDED_POLICY,
          nonRetryableFailureKinds: [
            "aborted",
            "timed_out",
            "decision_required",
            "unsafe_write",
            "invalid_state",
            "unknown",
          ],
        }),
      ),
    ).toThrow();
  });
});

describe("formatRepairPolicySummary", () => {
  it("formats disabled policy", () => {
    expect(formatRepairPolicySummary({ mode: "disabled", reasonCode: "high_risk" })).toBe(
      "disabled (high_risk)",
    );
  });

  it("formats bounded policy", () => {
    expect(formatRepairPolicySummary(BOUNDED_POLICY)).toBe(
      "bounded (max 1; command_failed only; same model/effort/context)",
    );
  });
});
