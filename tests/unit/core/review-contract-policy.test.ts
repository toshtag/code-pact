import { describe, it, expect } from "vitest";
import { Project } from "../../../src/core/schemas/project.ts";
import type { Task } from "../../../src/core/schemas/task.ts";
import {
  effectiveReviewContractPolicy,
  assertReviewContractPolicySatisfied,
} from "../../../src/core/review-contract-policy.ts";
import { validReviewContractFor } from "../../helpers/review-contract.ts";

// The rollout policy has exactly one job: decide whether a MISSING review
// contract blocks a new lock. The two directions it must get right are opposite
// failures — a project that never carried the field must keep working (or the
// upgrade strands every planned task), and a project that asked for the gate
// must never get it silently switched off by a typo.

function project(overrides: Record<string, unknown> = {}): Project {
  return Project.parse({
    name: "test",
    version: "0.1.0",
    locale: "en-US",
    default_agent: "claude-code",
    agents: [
      { name: "claude-code", profile: "agent-profiles/claude-code.yaml" },
    ],
    ...overrides,
  });
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "P1-T1",
    type: "feature",
    ambiguity: "medium",
    risk: "medium",
    context_size: "medium",
    write_surface: "medium",
    verification_strength: "strong",
    expected_duration: "medium",
    status: "planned",
    reads: ["src/example.ts"],
    writes: ["src/example.ts"],
    ...overrides,
  };
}

describe("project schema — review_contract_policy", () => {
  it("accepts advisory", () => {
    expect(
      project({ review_contract_policy: "advisory" }).review_contract_policy,
    ).toBe("advisory");
  });

  it("accepts required", () => {
    expect(
      project({ review_contract_policy: "required" }).review_contract_policy,
    ).toBe("required");
  });

  it("parses a project that omits the field", () => {
    expect(project().review_contract_policy).toBeUndefined();
  });

  it("does not inject a default on parse", () => {
    // Absence has to survive a round trip. If the schema materialized
    // `advisory`, normalizing an existing project.yaml would grow a field its
    // maintainer never wrote, and the historical "never heard of contracts"
    // state would become indistinguishable from a deliberate opt-out.
    expect(
      Object.prototype.hasOwnProperty.call(project(), "review_contract_policy"),
    ).toBe(false);
  });

  it("rejects an unknown value", () => {
    expect(() => project({ review_contract_policy: "require" })).toThrow();
  });

  it("rejects a present-but-empty value", () => {
    expect(() => project({ review_contract_policy: null })).toThrow();
  });
});

describe("effectiveReviewContractPolicy", () => {
  it("reads an absent field as advisory", () => {
    expect(effectiveReviewContractPolicy(project())).toBe("advisory");
  });

  it("honours a declared advisory", () => {
    expect(
      effectiveReviewContractPolicy(
        project({ review_contract_policy: "advisory" }),
      ),
    ).toBe("advisory");
  });

  it("honours a declared required", () => {
    expect(
      effectiveReviewContractPolicy(
        project({ review_contract_policy: "required" }),
      ),
    ).toBe("required");
  });
});

describe("assertReviewContractPolicySatisfied", () => {
  it("passes a missing contract under advisory", () => {
    expect(() =>
      assertReviewContractPolicySatisfied(task(), "advisory"),
    ).not.toThrow();
  });

  it("refuses a missing contract under required", () => {
    expect(() =>
      assertReviewContractPolicySatisfied(task(), "required"),
    ).toThrow(/review_contract_policy: required/);
  });

  it("carries the task id and the policy on the error", () => {
    try {
      assertReviewContractPolicySatisfied(task(), "required");
      expect.unreachable("expected a refusal");
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        task_id?: string;
        review_contract_policy?: string;
      };
      expect(e.code).toBe("TASK_REVIEW_CONTRACT_REQUIRED");
      expect(e.task_id).toBe("P1-T1");
      expect(e.review_contract_policy).toBe("required");
    }
  });

  it("passes a declared contract under required", () => {
    const subject = task();
    expect(() =>
      assertReviewContractPolicySatisfied(
        { ...subject, review_contract: validReviewContractFor(subject) },
        "required",
      ),
    ).not.toThrow();
  });

  it("says nothing about whether a declared contract holds", () => {
    // Semantic validity is the other check's job, and it runs first. This one
    // only asks whether a contract is present, so a deliberately wrong contract
    // still passes here — and keeps its own, more specific error code.
    const subject = task();
    expect(() =>
      assertReviewContractPolicySatisfied(
        {
          ...subject,
          review_contract: { version: 1, mode: "minimal" },
        },
        "required",
      ),
    ).not.toThrow();
  });
});
