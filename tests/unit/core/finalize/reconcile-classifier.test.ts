import { describe, expect, it } from "vitest";
import { classifyReconcile } from "../../../../src/core/finalize/reconcile-classifier.ts";

describe("classifyReconcile", () => {
  it("returns flip when derived done and design not done", () => {
    expect(classifyReconcile("planned", "done")).toEqual({
      action: "flip",
      reason: null,
    });
    expect(classifyReconcile("in_progress", "done")).toEqual({
      action: "flip",
      reason: null,
    });
  });

  it("returns skip when design already done", () => {
    expect(classifyReconcile("done", "done")).toEqual({
      action: "skip",
      reason: "design status already done",
    });
    // Even if derived is something stale, design=done is the dominant rule.
    expect(classifyReconcile("done", "planned")).toEqual({
      action: "skip",
      reason: "design status already done",
    });
  });

  it("returns skip when derived planned (no events)", () => {
    expect(classifyReconcile("planned", "planned")).toEqual({
      action: "skip",
      reason: "not yet done (no events recorded)",
    });
  });

  it("returns skip when derived started or resumed (work in progress)", () => {
    expect(classifyReconcile("planned", "started")).toEqual({
      action: "skip",
      reason: "work in progress (derived state: started)",
    });
    expect(classifyReconcile("in_progress", "resumed")).toEqual({
      action: "skip",
      reason: "work in progress (derived state: resumed)",
    });
  });

  it("returns manual_review when derived blocked or failed", () => {
    expect(classifyReconcile("planned", "blocked").action).toBe("manual_review");
    expect(classifyReconcile("planned", "failed").action).toBe("manual_review");
    expect(classifyReconcile("planned", "blocked").reason).toContain(
      "plan analyze",
    );
  });

  it("flip takes precedence over design=done when derived=done (it cannot — design=done implies skip)", () => {
    // This is a sanity test for the rule ordering: flip = derived done AND
    // design != done; the rule fires before the design=done skip rule
    // because the conditions are mutually exclusive when derived=done.
    expect(classifyReconcile("planned", "done").action).toBe("flip");
    expect(classifyReconcile("done", "done").action).toBe("skip");
  });
});
