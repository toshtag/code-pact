// P49 (Context Fit, layer c) — integration tests for the additive explain
// metrics on `task context --explain --json`.
//
// Proves the new byte metrics appear beside the unchanged P21 explain fields,
// that `budget_bytes` is omitted with no budget and present (equal to the
// resolved value) under --budget-bytes / --context-budget, that the two budget
// spellings produce equivalent metrics, and that the successful explain floor
// equals the CONTEXT_OVER_BUDGET error floor for the same task (the principal
// Context Fit invariant) — all observed through the real CLI envelope.
//
// Test policy mirrors task-context-budget.test.ts: deterministic verify command
// (node --version), single temp project per scenario, no network, no sleeps.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  createTempProject,
  ensureCliBuilt,
  expectJsonOk,
  expectJsonErr,
} from "../helpers/cli.ts";

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

type ExplainData = {
  total_bytes: number;
  context_pack_bytes: number;
  sections: unknown[];
  excluded: unknown[];
  natural_bytes: number;
  final_bytes: number;
  budget_bytes?: number;
  saved_bytes: number;
  saved_ratio: number;
  minimum_achievable_bytes: number;
  elided_sections: Array<{ name: string; bytes: number }>;
};

/** Add phase P1 (deterministic verify) + a single planned task P1-T1. */
async function setupTask(
  project: Awaited<ReturnType<typeof createTempProject>>,
): Promise<void> {
  expectJsonOk(
    project.run([
      "phase", "add",
      "--id", "P1",
      "--name", "Foundation",
      "--objective", "Foundation phase for the explain-metrics test",
      "--weight", "10",
      "--verify-command", "node --version",
      "--json",
    ]),
  );
  const phasePath = join(project.dir, "design", "phases", "P1-foundation.yaml");
  const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<string, unknown>;
  doc.tasks = [
    {
      id: "P1-T1",
      type: "feature",
      ambiguity: "low",
      risk: "low",
      context_size: "small",
      write_surface: "low",
      verification_strength: "weak",
      expected_duration: "short",
      status: "planned",
      description: "explain-metrics test task",
    },
  ];
  await writeFile(phasePath, stringifyYaml(doc), "utf8");
}

describe("task context --explain --json metrics (P49)", () => {
  let project: Awaited<ReturnType<typeof createTempProject>>;

  beforeEach(async () => {
    project = await createTempProject({ prefix: "code-pact-explain-metrics-" });
    await setupTask(project);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it("adds the new metrics beside the unchanged P21 fields with no budget", () => {
    const env = expectJsonOk<ExplainData>(
      project.run([
        "task", "context", "P1-T1", "--agent", "claude-code", "--explain", "--json",
      ]),
    );
    const d = env.data;
    // Existing P21 explain fields remain.
    expect(typeof d.total_bytes).toBe("number");
    expect(typeof d.context_pack_bytes).toBe("number");
    expect(Array.isArray(d.sections)).toBe(true);
    expect(Array.isArray(d.excluded)).toBe(true);
    // New P49 fields.
    expect(typeof d.natural_bytes).toBe("number");
    expect(typeof d.final_bytes).toBe("number");
    expect(typeof d.minimum_achievable_bytes).toBe("number");
    // final_bytes === total_bytes === context_pack_bytes.
    expect(d.final_bytes).toBe(d.total_bytes);
    expect(d.final_bytes).toBe(d.context_pack_bytes);
    // No budget → zero savings, no budget_bytes, empty elided.
    expect(d.natural_bytes).toBe(d.final_bytes);
    expect(d.saved_bytes).toBe(0);
    expect(d.saved_ratio).toBe(0);
    expect(d.elided_sections).toEqual([]);
    expect(d.budget_bytes).toBeUndefined();
    expect("budget_bytes" in d).toBe(false);
  });

  it("does not add metrics to non-explain JSON output", () => {
    const env = expectJsonOk<Record<string, unknown>>(
      project.run(["task", "context", "P1-T1", "--agent", "claude-code", "--json"]),
    );
    expect("natural_bytes" in env.data).toBe(false);
    expect("final_bytes" in env.data).toBe(false);
    expect("minimum_achievable_bytes" in env.data).toBe(false);
    expect("saved_bytes" in env.data).toBe(false);
  });

  it("--budget-bytes <N> that fits reports budget_bytes == N and zero savings", () => {
    const env = expectJsonOk<ExplainData>(
      project.run([
        "task", "context", "P1-T1", "--agent", "claude-code",
        "--explain", "--budget-bytes", "60000", "--json",
      ]),
    );
    const d = env.data;
    expect(d.budget_bytes).toBe(60000);
    expect(d.natural_bytes).toBe(d.final_bytes);
    expect(d.saved_bytes).toBe(0);
    expect(d.saved_ratio).toBe(0);
  });

  it("--context-budget balanced yields the same metrics as --budget-bytes 60000", () => {
    const byProfile = expectJsonOk<ExplainData>(
      project.run([
        "task", "context", "P1-T1", "--agent", "claude-code",
        "--explain", "--context-budget", "balanced", "--json",
      ]),
    );
    const byBytes = expectJsonOk<ExplainData>(
      project.run([
        "task", "context", "P1-T1", "--agent", "claude-code",
        "--explain", "--budget-bytes", "60000", "--json",
      ]),
    );
    expect(byProfile.data.budget_bytes).toBe(60000);
    expect(byProfile.data.budget_bytes).toBe(byBytes.data.budget_bytes);
    expect(byProfile.data.natural_bytes).toBe(byBytes.data.natural_bytes);
    expect(byProfile.data.final_bytes).toBe(byBytes.data.final_bytes);
    expect(byProfile.data.saved_bytes).toBe(byBytes.data.saved_bytes);
    expect(byProfile.data.minimum_achievable_bytes).toBe(
      byBytes.data.minimum_achievable_bytes,
    );
  });

  it("the successful explain floor equals the CONTEXT_OVER_BUDGET floor for the same task", () => {
    const explained = expectJsonOk<ExplainData>(
      project.run([
        "task", "context", "P1-T1", "--agent", "claude-code", "--explain", "--json",
      ]),
    );
    const floor = explained.data.minimum_achievable_bytes;

    const res = project.run([
      "task", "context", "P1-T1", "--agent", "claude-code",
      "--budget-bytes", "1", "--json",
    ]);
    const env = expectJsonErr(res, "CONTEXT_OVER_BUDGET");
    expect(res.code).toBe(2);
    const errData = (env as { data?: { minimum_achievable_bytes?: number } }).data;
    expect(errData?.minimum_achievable_bytes).toBe(floor);
  });
});
