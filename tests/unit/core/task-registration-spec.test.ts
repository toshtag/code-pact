import { describe, it, expect } from "vitest";
import type { Task } from "../../../src/core/schemas/task.ts";
import type { ReviewContract } from "../../../src/core/schemas/review-contract.ts";
import {
  canonicalTaskRegistration,
  taskRegistrationDigest,
  lockTimeRegistrationChangedFields,
  postLockRegistrationChangedFields,
} from "../../../src/core/task-registration-spec.ts";

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "P1-T1",
    type: "feature",
    ambiguity: "low",
    risk: "medium",
    context_size: "medium",
    write_surface: "medium",
    verification_strength: "medium",
    expected_duration: "short",
    status: "planned",
    description: "A task",
    requires_decision: false,
    depends_on: [],
    decision_refs: [],
    reads: [],
    writes: [],
    acceptance_refs: [],
    ...overrides,
  };
}

function reviewContract(): ReviewContract {
  return {
    version: 1,
    mode: "boundary",
    stages: [
      {
        stage: "producer",
        disposition: "in_scope",
        claim: "The producer emits a stable envelope.",
        refs: ["src/a.ts"],
      },
      {
        stage: "consumer",
        disposition: "in_scope",
        claim: "The consumer validates the envelope.",
        refs: ["src/a.ts"],
      },
      {
        stage: "runner",
        disposition: "not_applicable",
        rationale: "No process is launched.",
      },
      {
        stage: "os",
        disposition: "not_applicable",
        rationale: "No OS-specific behavior changes.",
      },
      {
        stage: "security",
        disposition: "not_applicable",
        rationale: "No authority boundary is touched.",
      },
    ],
    platforms: [
      {
        platform: "linux",
        disposition: "required",
        level: "integration",
        refs: ["src/a.ts"],
      },
      {
        platform: "macos",
        disposition: "not_required",
        rationale: "No macOS-specific behavior changes.",
      },
      {
        platform: "windows",
        disposition: "not_required",
        rationale: "No Windows-specific behavior changes.",
      },
    ],
    evidence: [
      {
        id: "envelope-contract",
        claim: "Producer and consumer agree on the envelope.",
        level: "integration",
        refs: ["src/a.ts"],
      },
    ],
  };
}

describe("lockTimeRegistrationChangedFields", () => {
  it("reports no diff for identical tasks", () => {
    const task = baseTask();
    expect(lockTimeRegistrationChangedFields(task, task)).toEqual([]);
  });

  it("reports status mismatch at lock time", () => {
    const expected = baseTask({ status: "planned" });
    const actual = baseTask({ status: "in_progress" });
    expect(lockTimeRegistrationChangedFields(expected, actual)).toContain(
      "status",
    );
  });

  it("treats requires_decision false and undefined as different", () => {
    const expected = baseTask({ requires_decision: false });
    const actual = baseTask({ requires_decision: undefined });
    expect(lockTimeRegistrationChangedFields(expected, actual)).toContain(
      "requires_decision",
    );
  });

  it("detects missing depends_on", () => {
    const expected = baseTask({ depends_on: ["P1-T0"] });
    const actual = baseTask({ depends_on: undefined });
    expect(lockTimeRegistrationChangedFields(expected, actual)).toContain(
      "depends_on",
    );
  });

  it("detects empty depends_on vs omitted depends_on", () => {
    const expected = baseTask({ depends_on: [] });
    const actual = baseTask({ depends_on: undefined });
    expect(lockTimeRegistrationChangedFields(expected, actual)).toContain(
      "depends_on",
    );
  });

  it("preserves depends_on order", () => {
    const expected = baseTask({ depends_on: ["P1-T2", "P1-T1"] });
    const actual = baseTask({ depends_on: ["P1-T1", "P1-T2"] });
    expect(lockTimeRegistrationChangedFields(expected, actual)).toContain(
      "depends_on",
    );
  });
});

describe("postLockRegistrationChangedFields", () => {
  it("ignores status drift after lock", () => {
    const expected = baseTask({ status: "planned" });
    const actual = baseTask({ status: "done" });
    expect(postLockRegistrationChangedFields(expected, actual)).not.toContain(
      "status",
    );
    expect(postLockRegistrationChangedFields(expected, actual)).toEqual([]);
  });

  it("detects requires_decision removal after lock", () => {
    const expected = baseTask({ requires_decision: false });
    const actual = baseTask({ requires_decision: undefined });
    expect(postLockRegistrationChangedFields(expected, actual)).toContain(
      "requires_decision",
    );
  });

  it("detects depends_on order change after lock", () => {
    const expected = baseTask({ depends_on: ["P1-T2", "P1-T1"] });
    const actual = baseTask({ depends_on: ["P1-T1", "P1-T2"] });
    expect(postLockRegistrationChangedFields(expected, actual)).toContain(
      "depends_on",
    );
  });

  it("detects description change after lock", () => {
    const expected = baseTask({ description: "Original" });
    const actual = baseTask({ description: "Changed" });
    expect(postLockRegistrationChangedFields(expected, actual)).toContain(
      "description",
    );
  });
});

describe("canonicalTaskRegistration", () => {
  it("includes status in the canonical JSON", () => {
    const task = baseTask({ status: "planned" });
    const json = canonicalTaskRegistration("P1", task);
    expect(JSON.parse(json).task.status).toBe("planned");
  });

  it("preserves requires_decision false explicitly", () => {
    const task = baseTask({ requires_decision: false });
    const json = canonicalTaskRegistration("P1", task);
    expect(JSON.parse(json).task.requires_decision).toBe(false);
  });

  it("omits missing requires_decision", () => {
    const task = baseTask({ requires_decision: undefined });
    const json = canonicalTaskRegistration("P1", task);
    expect(JSON.parse(json).task.requires_decision).toBeUndefined();
  });

  it("makes false and undefined digests differ", () => {
    const withFalse = baseTask({ requires_decision: false });
    const without = baseTask({ requires_decision: undefined });
    expect(taskRegistrationDigest("P1", withFalse)).not.toBe(
      taskRegistrationDigest("P1", without),
    );
  });

  it("makes empty and omitted arrays differ", () => {
    const withEmpty = baseTask({ depends_on: [] });
    const omitted = baseTask({ depends_on: undefined });
    expect(taskRegistrationDigest("P1", withEmpty)).not.toBe(
      taskRegistrationDigest("P1", omitted),
    );
  });
});

describe("review_contract in the task registration contract", () => {
  it("includes review_contract in the canonical JSON", () => {
    const task = baseTask({ review_contract: reviewContract() });
    const parsed = JSON.parse(canonicalTaskRegistration("P1", task)) as {
      task: { review_contract?: ReviewContract };
    };
    expect(parsed.task.review_contract?.mode).toBe("boundary");
    expect(parsed.task.review_contract?.stages).toHaveLength(5);
  });

  it("omits review_contract when the task declares none", () => {
    const parsed = JSON.parse(canonicalTaskRegistration("P1", baseTask())) as {
      task: { review_contract?: ReviewContract };
    };
    expect(parsed.task.review_contract).toBeUndefined();
  });

  it("makes presence and absence of review_contract change the digest", () => {
    const withContract = baseTask({ review_contract: reviewContract() });
    const without = baseTask();
    expect(taskRegistrationDigest("P1", withContract)).not.toBe(
      taskRegistrationDigest("P1", without),
    );
  });

  it("makes a stage order change change the digest", () => {
    const original = reviewContract();
    const reordered = reviewContract();
    reordered.stages = [
      original.stages![1]!,
      original.stages![0]!,
      ...original.stages!.slice(2),
    ];
    expect(
      taskRegistrationDigest("P1", baseTask({ review_contract: original })),
    ).not.toBe(
      taskRegistrationDigest("P1", baseTask({ review_contract: reordered })),
    );
  });

  it("detects a platform disposition change at lock time", () => {
    const expected = baseTask({ review_contract: reviewContract() });
    const mutated = reviewContract();
    mutated.platforms![1] = {
      platform: "macos",
      disposition: "required",
      level: "integration",
      refs: ["src/a.ts"],
    };
    const actual = baseTask({ review_contract: mutated });
    expect(lockTimeRegistrationChangedFields(expected, actual)).toContain(
      "review_contract",
    );
  });

  it("detects an evidence change after lock", () => {
    const expected = baseTask({ review_contract: reviewContract() });
    const mutated = reviewContract();
    mutated.evidence![0]!.claim = "Something else entirely.";
    const actual = baseTask({ review_contract: mutated });
    expect(postLockRegistrationChangedFields(expected, actual)).toContain(
      "review_contract",
    );
  });

  it("keeps a post-lock status-only change free of review_contract drift", () => {
    const expected = baseTask({
      status: "planned",
      review_contract: reviewContract(),
    });
    const actual = baseTask({
      status: "done",
      review_contract: reviewContract(),
    });
    expect(postLockRegistrationChangedFields(expected, actual)).toEqual([]);
  });
});
