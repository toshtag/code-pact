import { describe, it, expect } from "vitest";
import type { Task } from "../../../src/core/schemas/task.ts";
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
