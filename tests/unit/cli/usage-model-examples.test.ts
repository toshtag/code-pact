import { describe, it, expect } from "vitest";
import { allLeafUsages } from "../../../src/cli/usage.ts";
import { normalizeModelVersion } from "../../../src/core/schemas/agent-profile.ts";

// Regression guard for the v1.28 drift bug: the `adapter install` help
// advertised `--model claude-opus-4-8`, but the validator only accepted
// opus-4.6/4.7 + sonnet-4.6, so the documented command failed with
// CONFIG_ERROR. This test mechanically prevents that class of mismatch:
// every concrete `--model <value>` shown in a help EXAMPLE must be a value the
// validator actually accepts.
//
// It scans only example command lines (those starting with `code-pact`), so the
// Options-row placeholder `--model <version>` is never picked up.
describe("usage help — every --model example validates", () => {
  const MODEL_ON_COMMAND = /--model\s+(\S+)/g;

  function modelExampleValues(): string[] {
    const values: string[] = [];
    for (const usage of allLeafUsages()) {
      for (const line of usage.split("\n")) {
        const trimmed = line.trim();
        // Only real example invocations — excludes the `--model <version>`
        // Options/synopsis rows entirely.
        if (!trimmed.startsWith("code-pact ")) continue;
        for (const m of trimmed.matchAll(MODEL_ON_COMMAND)) {
          const value = m[1]!;
          if (value.startsWith("<")) continue; // defensive: skip placeholders
          values.push(value);
        }
      }
    }
    return values;
  }

  it("finds at least one concrete --model example (test is not vacuous)", () => {
    expect(modelExampleValues().length).toBeGreaterThan(0);
  });

  it("accepts every concrete --model example value via normalizeModelVersion", () => {
    for (const value of modelExampleValues()) {
      expect(
        normalizeModelVersion(value),
        `help example "--model ${value}" is not accepted by normalizeModelVersion`,
      ).not.toBeNull();
    }
  });
});
