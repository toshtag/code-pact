import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, "scripts", "benchmark-low-capability.mjs");
const codePactCliPath = join(repoRoot, "dist", "cli.js");

function runScript(
  args: string[],
  env?: Record<string, string>,
): { code: number; stdout: string; stderr: string; data?: unknown } {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 20 * 1024 * 1024,
  });
  const code = res.status ?? 1;
  const stdout = res.stdout || "";
  const stderr = res.stderr || "";
  let data: unknown;
  if (args.includes("--json")) {
    try {
      data = JSON.parse(stdout.trim());
    } catch {
      data = undefined;
    }
  }
  return { code, stdout, stderr, data };
}

function jsonOk(result: ReturnType<typeof runScript>) {
  if (result.code !== 0) {
    // eslint-disable-next-line no-console
    console.error("runScript failed:", result.stderr, result.stdout);
  }
  expect(result.code).toBe(0);
  expect(result.data).toBeDefined();
  const envelope = result.data as { ok: boolean; data: unknown };
  expect(envelope.ok).toBe(true);
  return envelope.data;
}

async function prepareRun(
  caseId: string,
  variant: string,
  executorId: string,
  replicate: number,
  outputRoot: string,
  env?: Record<string, string>,
) {
  const res = runScript(
    [
      "--json",
      "prepare",
      "--case",
      caseId,
      "--variant",
      variant,
      "--executor-id",
      executorId,
      "--replicate",
      String(replicate),
      "--output",
      outputRoot,
    ],
    env,
  );
  const data = jsonOk(res) as { run_id: string; run_dir: string };
  return data;
}

async function evaluateRun(runDir: string, round: number) {
  const res = runScript([
    "--json",
    "evaluate",
    "--run",
    runDir,
    "--round",
    String(round),
  ]);
  return jsonOk(res) as { result: Record<string, unknown> };
}

describe("benchmark-low-capability", () => {
  let tempRoot = "";
  const tmp = (name?: string) => join(tempRoot, name ?? randomUUID());

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bench-low-cap-"));
  });

  afterAll(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it("corpus-check reports the corpus is valid", () => {
    const res = runScript(["--json", "corpus-check"]);
    const data = jsonOk(res) as { valid: boolean; issues: unknown[] };
    expect(data.valid).toBe(true);
    expect(data.issues).toHaveLength(0);
  });

  it("prepare creates a baseline run directory with manifest, workspace, and git base", async () => {
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      tmp(),
    );
    expect(info.run_id).toBeTruthy();
    expect(info.run_dir).toContain(info.run_id);
    const manifest = JSON.parse(
      await readFile(join(info.run_dir, "run-manifest.json"), "utf8"),
    );
    expect(manifest.schema_version).toBe(1);
    expect(manifest.case_id).toBe("bounded-feature");
    expect(manifest.variant).toBe("baseline");
    expect(existsSync(join(info.run_dir, "workspace", "src", "range.js"))).toBe(
      true,
    );
    expect(existsSync(join(info.run_dir, "workspace", ".git"))).toBe(true);
    expect(existsSync(join(info.run_dir, "instruction.md"))).toBe(true);
  });

  it("baseline evaluate reports verified_success after a correct implementation", async () => {
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      tmp(),
    );
    await writeFile(
      join(info.run_dir, "workspace", "src", "range.js"),
      `export function range(start, end, step = 1) {\n  const result = [];\n  if (step > 0) {\n    for (let i = start; i < end; i += step) result.push(i);\n  } else {\n    for (let i = start; i > end; i += step) result.push(i);\n  }\n  return result;\n}\n`,
      "utf8",
    );
    const { result } = await evaluateRun(info.run_dir, 1);
    expect(result.status).toBe("verified_success");
    expect(result.first_pass_success).toBe(true);
    expect(result.repair_rounds).toBe(0);
    expect(result.scope_violation_count).toBe(0);
    expect(result.exit_code).toBe(0);
    expect(result.changed_paths).toContain("src/range.js");
  });

  it("baseline evaluate reports verification_failed and a failure fingerprint on a broken implementation", async () => {
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      tmp(),
    );
    const { result } = await evaluateRun(info.run_dir, 1);
    expect(result.status).toBe("verification_failed");
    expect(result.first_pass_success).toBe(false);
    expect(result.exit_code).not.toBe(0);
    expect(typeof result.failure_fingerprint).toBe("string");
    expect(result.failure_fingerprint).toHaveLength(64);
    expect(result.bounded_output).toBeTruthy();
  });

  it("stops on a repeated failure fingerprint", async () => {
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      tmp(),
    );
    const r1 = await evaluateRun(info.run_dir, 1);
    expect(r1.result.status).toBe("verification_failed");
    const r2 = await evaluateRun(info.run_dir, 2);
    expect(r2.result.status).toBe("stop_repeated_failure");
    expect(r2.result.same_fingerprint_repeat_count).toBeGreaterThan(0);
  });

  it("detects scope violations outside the allowed write list", async () => {
    const info = await prepareRun("scope-boundary", "baseline", "E1", 1, tmp());
    await writeFile(
      join(info.run_dir, "workspace", "src", "config.js"),
      `export const language = "en";\n`,
      "utf8",
    );
    const { result } = await evaluateRun(info.run_dir, 1);
    expect(result.status).toBe("verification_failed");
    expect(result.scope_violation_count).toBeGreaterThan(0);
    expect(result.scope_violations).toContain("src/config.js");
  });

  it("reports expected_stop_success for the decision-stop baseline", async () => {
    const info = await prepareRun("decision-stop", "baseline", "E1", 1, tmp());
    const { result } = await evaluateRun(info.run_dir, 1);
    expect(result.status).toBe("expected_stop_success");
    expect(result.first_pass_success).toBe(true);
    expect(result.changed_paths).toHaveLength(0);
  });

  it("finalizes telemetry and validates the result", async () => {
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      tmp(),
    );
    await writeFile(
      join(info.run_dir, "workspace", "src", "range.js"),
      `export function range(start, end, step = 1) {\n  const result = [];\n  if (step > 0) {\n    for (let i = start; i < end; i += step) result.push(i);\n  } else {\n    for (let i = start; i > end; i += step) result.push(i);\n  }\n  return result;\n}\n`,
      "utf8",
    );
    await evaluateRun(info.run_dir, 1);
    const telemetryPath = join(info.run_dir, "telemetry.json");
    await writeFile(
      telemetryPath,
      JSON.stringify({
        schema_version: 1,
        input_tokens: 100,
        output_tokens: 50,
        billed_amount: 0.001,
        currency: "USD",
        manual_intervention_count: 0,
      }),
      "utf8",
    );
    const fin = runScript([
      "--json",
      "finalize",
      "--run",
      info.run_dir,
      "--telemetry",
      telemetryPath,
    ]);
    const finData = jsonOk(fin) as { result: Record<string, unknown> };
    expect(finData.result.input_tokens).toBe(100);
    expect(finData.result.output_tokens).toBe(50);
    expect(finData.result.total_tokens).toBe(150);
    expect(finData.result.billed_amount).toBe(0.001);

    const val = runScript([
      "--json",
      "validate-result",
      "--file",
      join(info.run_dir, "result.json"),
    ]);
    const valData = jsonOk(val) as { schema_version: number };
    expect(valData.schema_version).toBe(1);
  });

  it("rejects telemetry with manual intervention", async () => {
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      tmp(),
    );
    await writeFile(
      join(info.run_dir, "workspace", "src", "range.js"),
      `export function range(start, end, step = 1) {\n  return [];\n}\n`,
      "utf8",
    );
    await evaluateRun(info.run_dir, 1);
    const telemetryPath = join(info.run_dir, "bad-telemetry.json");
    await writeFile(
      telemetryPath,
      JSON.stringify({
        schema_version: 1,
        input_tokens: 100,
        output_tokens: 50,
        manual_intervention_count: 1,
      }),
      "utf8",
    );
    const fin = runScript([
      "--json",
      "finalize",
      "--run",
      info.run_dir,
      "--telemetry",
      telemetryPath,
    ]);
    expect(fin.code).not.toBe(0);
    const envelope = fin.data as { ok: boolean };
    expect(envelope.ok).toBe(false);
  });

  it("scores paired baseline and code_pact results", async () => {
    const resultRoot = tmp("score-pair");
    const base = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      resultRoot,
    );
    const codePact = await prepareRun(
      "bounded-feature",
      "code_pact",
      "E1",
      1,
      resultRoot,
    );
    for (const run of [base.run_dir, codePact.run_dir]) {
      await writeFile(
        join(run, "workspace", "src", "range.js"),
        `export function range(start, end, step = 1) {\n  const result = [];\n  if (step > 0) {\n    for (let i = start; i < end; i += step) result.push(i);\n  } else {\n    for (let i = start; i > end; i += step) result.push(i);\n  }\n  return result;\n}\n`,
        "utf8",
      );
      await evaluateRun(run, 1);
    }
    const score = runScript(["--json", "score", "--results", resultRoot]);
    const data = jsonOk(score) as { summary: { paired_count: number } };
    expect(data.summary.paired_count).toBe(1);
    const summary = JSON.parse(
      await readFile(join(resultRoot, "score-summary.json"), "utf8"),
    );
    expect(summary.schema_version).toBe(1);
    expect(summary.totals.baseline_runs).toBe(1);
    expect(summary.totals.code_pact_runs).toBe(1);
  });

  it("prepare-pilot generates the full pilot manifest set", async () => {
    const pilotRoot = tmp("pilot");
    const res = runScript([
      "--json",
      "prepare-pilot",
      "--executors",
      "E1",
      "--replicates",
      "1",
      "--output",
      pilotRoot,
    ]);
    const data = jsonOk(res) as { manifest_count: number };
    expect(data.manifest_count).toBe(10);
    expect(existsSync(join(pilotRoot, "pilot-plan.json"))).toBe(true);
  }, 15000);

  describe.skipIf(!existsSync(codePactCliPath))("code-pact variant", () => {
    it("prepares a code_pact run and records context_retrieval_count", async () => {
      const info = await prepareRun(
        "explicit-context",
        "code_pact",
        "E1",
        1,
        tmp(),
      );
      const manifest = JSON.parse(
        await readFile(join(info.run_dir, "run-manifest.json"), "utf8"),
      );
      expect(manifest.context_retrieval_count).toBe(2);
      expect(existsSync(join(info.run_dir, "code-pact-prepare.json"))).toBe(
        true,
      );
      expect(existsSync(join(info.run_dir, "code-pact-runbook.json"))).toBe(
        true,
      );
    });

    it("code_pact evaluate reports verified_success after a correct implementation", async () => {
      const info = await prepareRun(
        "bounded-feature",
        "code_pact",
        "E1",
        1,
        tmp(),
      );
      await writeFile(
        join(info.run_dir, "workspace", "src", "range.js"),
        `export function range(start, end, step = 1) {\n  const result = [];\n  if (step > 0) {\n    for (let i = start; i < end; i += step) result.push(i);\n  } else {\n    for (let i = start; i > end; i += step) result.push(i);\n  }\n  return result;\n}\n`,
        "utf8",
      );
      const { result } = await evaluateRun(info.run_dir, 1);
      expect(result.status).toBe("verified_success");
      expect(result.first_pass_success).toBe(true);
      expect(result.code_pact_stdout_bytes).toBeGreaterThan(0);
    });

    it("code_pact evaluate reports expected_stop_success for the decision-stop case", async () => {
      const info = await prepareRun(
        "decision-stop",
        "code_pact",
        "E1",
        1,
        tmp(),
      );
      const { result } = await evaluateRun(info.run_dir, 1);
      expect(result.status).toBe("expected_stop_success");
      expect(result.next_action).toBe("expected_stop");
      expect(result.changed_paths).toHaveLength(0);
    });

    it("code_pact evaluate reports verification_failed on a broken implementation", async () => {
      const info = await prepareRun(
        "bounded-feature",
        "code_pact",
        "E1",
        1,
        tmp(),
      );
      const { result } = await evaluateRun(info.run_dir, 1);
      expect(result.status).toBe("verification_failed");
      expect(result.first_pass_success).toBe(false);
      expect(result.code_pact_stdout_bytes).toBeGreaterThan(0);
    });
  });
});
