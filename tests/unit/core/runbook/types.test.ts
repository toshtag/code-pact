import { describe, expect, it } from "vitest";
import {
  assertStepInvariant,
  type RunbookStep,
} from "../../../../src/core/runbook/types.ts";

const baseStep: RunbookStep = {
  command: null,
  manual_action: null,
  reason: "test",
  blocking: false,
  safety_note: null,
  expected_result: null,
};

describe("assertStepInvariant", () => {
  it("accepts a command-only step", () => {
    expect(() =>
      assertStepInvariant({ ...baseStep, command: "code-pact task status X" }),
    ).not.toThrow();
  });

  it("accepts a manual_action-only step", () => {
    expect(() =>
      assertStepInvariant({ ...baseStep, manual_action: "Resolve blocker" }),
    ).not.toThrow();
  });

  it("rejects a step with both command and manual_action set", () => {
    expect(() =>
      assertStepInvariant({
        ...baseStep,
        command: "code-pact task status X",
        manual_action: "Also do this",
      }),
    ).toThrow(/exactly one of command \/ manual_action/);
  });

  it("rejects a step with neither command nor manual_action set", () => {
    expect(() => assertStepInvariant(baseStep)).toThrow(
      /exactly one of command \/ manual_action/,
    );
  });
});
