import { describe, expect, it } from "vitest";
import { resolveRecommendation } from "../../../../src/core/recommend/index.ts";
import type { AgentProfile } from "../../../../src/core/schemas/agent-profile.ts";
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

const AGENT_PROFILE: AgentProfile = {
  name: "claude-code",
  instruction_filename: "CLAUDE.md",
  context_dir: ".context/claude-code",
  model_map: {
    cheap_mechanical: "claude-haiku-4-5",
    balanced_coding: "claude-sonnet-4-6",
    highest_reasoning: "claude-opus-4-7",
  },
};

describe("resolveRecommendation — pure function", () => {
  it("returns a v2 envelope for a docs task (cheap_mechanical tier)", () => {
    const result = resolveRecommendation({
      phaseId: "P1",
      taskId: "T1",
      task: { ...BASE_TASK, type: "docs" },
      agentName: "claude-code",
      agentProfile: AGENT_PROFILE,
    });

    expect(result.phaseId).toBe("P1");
    expect(result.taskId).toBe("T1");
    expect(result.agentName).toBe("claude-code");
    expect(result.tier).toBe("cheap_mechanical");
    expect(result.modelId).toBe("claude-haiku-4-5");
    expect(result.effort).toBe("low");
  });

  it("returns highest_reasoning for an architecture task", () => {
    const result = resolveRecommendation({
      phaseId: "P21",
      taskId: "P21-T0",
      task: { ...BASE_TASK, type: "architecture" },
      agentName: "claude-code",
      agentProfile: AGENT_PROFILE,
    });

    expect(result.tier).toBe("highest_reasoning");
    expect(result.modelId).toBe("claude-opus-4-7");
  });

  it("returns balanced_coding for a default feature task", () => {
    const result = resolveRecommendation({
      phaseId: "P1",
      taskId: "T1",
      task: BASE_TASK,
      agentName: "claude-code",
      agentProfile: AGENT_PROFILE,
    });

    expect(result.tier).toBe("balanced_coding");
    expect(result.modelId).toBe("claude-sonnet-4-6");
  });

  it("falls back to the tier name when the agent profile lacks a model_map entry", () => {
    const profileWithoutMap: AgentProfile = {
      ...AGENT_PROFILE,
      model_map: {},
    };

    const result = resolveRecommendation({
      phaseId: "P1",
      taskId: "T1",
      task: BASE_TASK,
      agentName: "claude-code",
      agentProfile: profileWithoutMap,
    });

    expect(result.modelId).toBe(result.tier);
  });

  it("emits a structuredReasons array with at least one entry", () => {
    const result = resolveRecommendation({
      phaseId: "P1",
      taskId: "T1",
      task: BASE_TASK,
      agentName: "claude-code",
      agentProfile: AGENT_PROFILE,
    });

    expect(result.structuredReasons.length).toBeGreaterThan(0);
  });

  it("derives planningRequired=true for medium ambiguity", () => {
    const result = resolveRecommendation({
      phaseId: "P1",
      taskId: "T1",
      task: { ...BASE_TASK, ambiguity: "medium" },
      agentName: "claude-code",
      agentProfile: AGENT_PROFILE,
    });

    expect(result.planningRequired).toBe(true);
  });

  it("derives ambiguityAction=clarify_before_implementation when requires_decision is true", () => {
    const result = resolveRecommendation({
      phaseId: "P1",
      taskId: "T1",
      task: { ...BASE_TASK, requires_decision: true },
      agentName: "claude-code",
      agentProfile: AGENT_PROFILE,
    });

    expect(result.ambiguityAction).toBe("clarify_before_implementation");
    expect(
      result.structuredReasons.some(
        (r) =>
          r.factor === "requires_decision" &&
          r.effect === "ambiguity_action=clarify_before_implementation",
      ),
    ).toBe(true);
  });

  it("emits split_recommended for long+high_surface+medium_ambiguity+non-high_risk", () => {
    const result = resolveRecommendation({
      phaseId: "P1",
      taskId: "T1",
      task: {
        ...BASE_TASK,
        expected_duration: "long",
        write_surface: "high",
        ambiguity: "medium",
        risk: "low",
      },
      agentName: "claude-code",
      agentProfile: AGENT_PROFILE,
    });

    expect(result.ambiguityAction).toBe("split_recommended");
    expect(
      result.structuredReasons.some(
        (r) =>
          r.factor === "duration+write_surface" &&
          r.effect === "ambiguity_action=split_recommended",
      ),
    ).toBe(true);
  });

  it("validates against the v2 schema (RecommendResultV2.parse)", () => {
    // resolveRecommendation calls .parse() internally; if the constructed
    // object diverges from the schema, the call throws. This test asserts
    // that a representative input produces a parse-clean result.
    expect(() =>
      resolveRecommendation({
        phaseId: "P21",
        taskId: "P21-T3",
        task: {
          ...BASE_TASK,
          type: "feature",
          ambiguity: "medium",
          risk: "low",
          context_size: "medium",
          write_surface: "high",
          verification_strength: "strong",
          expected_duration: "medium",
        },
        agentName: "claude-code",
        agentProfile: AGENT_PROFILE,
      }),
    ).not.toThrow();
  });
});

describe("resolveRecommendation — envelope shape invariant", () => {
  it("includes every v2 field on a minimal input", () => {
    const result = resolveRecommendation({
      phaseId: "P1",
      taskId: "T1",
      task: BASE_TASK,
      agentName: "claude-code",
      agentProfile: AGENT_PROFILE,
    });

    // Spread the keys we care about; the schema parse in
    // resolveRecommendation rejects unknowns, so any drift here surfaces
    // as a failure in the call above.
    const required = [
      "phaseId",
      "taskId",
      "agentName",
      "tier",
      "effort",
      "modelId",
      "reasons",
      "contextProfile",
      "verificationProfile",
      "planningRequired",
      "ambiguityAction",
      "allowedEscalation",
      "preflight",
      "budgetProfile",
      "structuredReasons",
    ] as const;
    for (const key of required) {
      expect(result).toHaveProperty(key);
    }
  });
});
