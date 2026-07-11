import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { buildAgentDetailMeasurements } from "../../../scripts/measure-agent-detail.ts";

describe("agent detail measurement fixture", () => {
  it("keeps the committed P51 byte measurements reproducible", async () => {
    const actual = await buildAgentDetailMeasurements();
    const expected = JSON.parse(
      await readFile("docs/maintainers/measurements/agent-detail-evidence.json", "utf8"),
    ) as typeof actual;

    expect(actual).toEqual(expected);
    expect(actual.measurements.map(row => row.name)).toEqual([
      "vitest_failure",
      "typescript_error",
      "eslint_error",
      "build_failure",
      "large_stdout",
      "large_stderr",
      "json_escape_worst_case",
      "mixed_utf8",
      "command_not_found",
      "timeout",
      "abort",
    ]);
    for (const row of actual.measurements) {
      expect(row.raw_result_bytes).toBeGreaterThan(0);
      expect(row.full_json_bytes).toBeGreaterThan(0);
      expect(row.agent_json_bytes).toBeGreaterThan(0);
      expect(row.reduction_ratio).toBeLessThan(1);
      expect(row.evidence_bytes).toBeGreaterThan(0);
    }
  });
});
