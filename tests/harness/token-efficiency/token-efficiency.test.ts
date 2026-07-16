import { beforeAll, describe, it, expect } from "vitest";

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { ensureCliBuilt } from "../../helpers/cli.ts";
import {
  runAllScenarios,
  runFirstPassSuccessScenario,
  runDeferredContextRetrievalScenario,
  createBaseProject,
  cleanupPreservingPrimaryError,
  checkDefaultOutputCompatibility,
  SUCCESS_VERIFY_COMMAND,
  type ScenarioMeasurement,
  type TokenEfficiencyHarnessSummary,
} from "./harness.ts";

type Summary = TokenEfficiencyHarnessSummary;

const SCENARIO_NAMES = [
  "first_pass_success",
  "failure_repair_success",
  "repeated_failure_success",
  "deferred_context_retrieval",
  "evidence_retrieval",
] as const;

function assertScenarioShape(s: ScenarioMeasurement): void {
  expect([...SCENARIO_NAMES]).toContain(s.scenario);
  expect(s.total_code_pact_stdout_bytes).toBeGreaterThan(0);
  expect(s.command_count).toBe(s.invocations.length);
  expect(s.verification_count).toBe(
    s.invocations.filter(i => i.category === "task_complete").length,
  );
  expect(s.failure_count).toBe(
    s.invocations.filter(i => i.exit_code !== 0).length,
  );
  expect(s.context_retrieval_count).toBe(
    s.invocations.filter(i => i.category === "context_retrieval").length,
  );
  expect(s.evidence_retrieval_count).toBe(
    s.invocations.filter(i => i.category === "evidence_retrieval").length,
  );
  expect(s.prior_signal_count).toBeGreaterThanOrEqual(0);
  for (const inv of s.invocations) {
    expect(inv.stdout_bytes).toBeGreaterThanOrEqual(0);
    expect(inv.exit_code).toBeGreaterThanOrEqual(-1);
  }
}

function findScenario(summary: Summary, name: string): ScenarioMeasurement {
  const scenario = summary.scenarios.find(s => s.scenario === name);
  expect(scenario).toBeDefined();
  return scenario!;
}

describe("token-efficiency closed harness", () => {
  let summary: Summary;

  beforeAll(async () => {
    ensureCliBuilt();
    summary = await runAllScenarios();
  }, 180_000);

  it("produces a complete summary across all scenarios", () => {
    expect(summary.schema_version).toBe(1);
    expect(summary.scenarios).toHaveLength(5);
    for (const scenario of summary.scenarios) {
      assertScenarioShape(scenario);
    }

    expect(summary.signal_field_incremental_bytes).toBeGreaterThan(0);
    expect(summary.repeated_failure_envelope_bytes).toBeGreaterThan(0);
    expect(summary.first_failure_signal_omitted).toBe(true);
    expect(summary.repeat_failure_signal_present).toBe(true);
    expect(summary.default_output_compatible).toBe(true);
  });

  it("records exact scenario counts", () => {
    const firstPass = findScenario(summary, "first_pass_success");
    expect(firstPass.command_count).toBe(2);
    expect(firstPass.verification_count).toBe(1);
    expect(firstPass.failure_count).toBe(0);

    const failureRepair = findScenario(summary, "failure_repair_success");
    expect(failureRepair.command_count).toBe(3);
    expect(failureRepair.verification_count).toBe(2);
    expect(failureRepair.failure_count).toBe(1);

    const repeatedFailure = findScenario(summary, "repeated_failure_success");
    expect(repeatedFailure.command_count).toBe(4);
    expect(repeatedFailure.verification_count).toBe(3);
    expect(repeatedFailure.failure_count).toBe(2);
    expect(repeatedFailure.prior_signal_count).toBe(1);

    const deferredContext = findScenario(summary, "deferred_context_retrieval");
    expect(deferredContext.command_count).toBe(3);
    expect(deferredContext.verification_count).toBe(0);
    expect(deferredContext.failure_count).toBe(0);
    expect(deferredContext.context_retrieval_count).toBe(2);

    const evidence = findScenario(summary, "evidence_retrieval");
    expect(evidence.command_count).toBe(3);
    expect(evidence.verification_count).toBe(1);
    expect(evidence.failure_count).toBe(1);
    expect(evidence.evidence_retrieval_count).toBe(1);
  });

  it("reports consistent shape across reruns of the first-pass scenario", async () => {
    const expected = findScenario(summary, "first_pass_success");
    const rerun = await runFirstPassSuccessScenario();
    expect(rerun.command_count).toBe(expected.command_count);
    expect(rerun.verification_count).toBe(expected.verification_count);
    expect(rerun.failure_count).toBe(expected.failure_count);
    expect(rerun.context_retrieval_count).toBe(
      expected.context_retrieval_count,
    );
    expect(rerun.evidence_retrieval_count).toBe(
      expected.evidence_retrieval_count,
    );
    expect(rerun.prior_signal_count).toBe(expected.prior_signal_count);
    expect(rerun.invocations.map(i => i.category)).toEqual(
      expected.invocations.map(i => i.category),
    );
  }, 30_000);

  it("summary never includes raw stdout, stderr, or absolute paths", () => {
    const json = JSON.stringify(summary);
    expect(json).not.toContain("raw_stdout");
    expect(json).not.toContain("raw_stderr");
    expect(json).not.toContain("/private/tmp");
    expect(json).not.toContain("/var/folders");
  });

  it("default output compatibility rejects non-error JSON", () => {
    expect(() =>
      checkDefaultOutputCompatibility(JSON.stringify({ ok: true })),
    ).toThrow();
  });

  it("default output compatibility rejects invalid JSON", () => {
    expect(() => checkDefaultOutputCompatibility("not json")).toThrow();
  });

  it("default output compatibility rejects an unexpected error envelope", () => {
    expect(() =>
      checkDefaultOutputCompatibility(
        JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR" } }),
      ),
    ).toThrow();
  });

  it("default output compatibility rejects prior_local_signal", () => {
    expect(() =>
      checkDefaultOutputCompatibility(
        JSON.stringify({
          ok: false,
          error: { code: "VERIFICATION_FAILED" },
          data: { prior_local_signal: { task_id: "P1-T1" } },
        }),
      ),
    ).toThrow();
  });

  it("rejects an unexpected error envelope even when data exists", () => {
    expect(() =>
      checkDefaultOutputCompatibility(
        JSON.stringify({
          ok: false,
          error: { code: "CONFIG_ERROR" },
          data: {},
        }),
      ),
    ).toThrow();
  });

  it("accepts a verification failure without prior_local_signal", () => {
    expect(
      checkDefaultOutputCompatibility(
        JSON.stringify({
          ok: false,
          error: { code: "VERIFICATION_FAILED" },
          data: {},
        }),
      ),
    ).toBe(true);
  });

  it("preserves the setup error when cleanup also fails", async () => {
    const primary = new Error("primary setup failure");

    await expect(
      cleanupPreservingPrimaryError(primary, async () => {
        throw new Error("cleanup failure");
      }),
    ).rejects.toBe(primary);
  });

  it("cleans up the temp project when createBaseProject setup fails", async () => {
    let capturedDir = "";
    await expect(
      createBaseProject("code-pact-harness-cleanup-", SUCCESS_VERIFY_COMMAND, {
        beforeReturn: async phasePath => {
          capturedDir = dirname(dirname(phasePath));
          throw new Error("injected setup failure");
        },
      }),
    ).rejects.toThrow("injected setup failure");
    expect(existsSync(capturedDir)).toBe(false);
  });

  it("cleans up the temp project when forceTaskBudgetDeferral fails", async () => {
    let capturedDir = "";
    await expect(
      runDeferredContextRetrievalScenario({
        onProjectCreated: dir => {
          capturedDir = dir;
        },
        deferralError: new Error("injected deferral failure"),
      }),
    ).rejects.toThrow("injected deferral failure");
    expect(existsSync(capturedDir)).toBe(false);
  }, 30_000);
});
