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

async function makeAttestation(
  manifest: {
    run_id: string;
    executor_id: string;
    input_bundle_sha256: string;
    tool_permission_class: string;
  },
  round: number,
  action: "implemented" | "stopped_decision" | "failed_to_execute",
  opts?: {
    sessionId?: string;
    fresh?: boolean;
    contextRetrieval?: number;
    manualIntervention?: number;
  },
) {
  const sessionId = opts?.sessionId ?? `session-${randomUUID()}`;
  const path = join(tempRoot, `att-${randomUUID()}.json`);
  const att = {
    schema_version: 1,
    run_id: manifest.run_id,
    round,
    executor_id: manifest.executor_id,
    session_id: sessionId,
    fresh_session_started: opts?.fresh !== undefined ? opts.fresh : round === 1,
    tool_permission_class: manifest.tool_permission_class,
    action,
    input_bundle_sha256: manifest.input_bundle_sha256,
    manual_intervention_count: opts?.manualIntervention ?? 0,
    context_retrieval_count: opts?.contextRetrieval ?? 0,
  };
  await writeFile(path, JSON.stringify(att), "utf8");
  return { path, sessionId };
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
  const data = jsonOk(res) as {
    run_id: string;
    run_dir: string;
    manifest_path: string;
    workspace_path: string;
    rounds_path: string;
  };
  const manifest = JSON.parse(await readFile(data.manifest_path, "utf8"));
  return { ...data, manifest };
}

async function evaluateRun(
  runDir: string,
  round: number,
  attestationPath: string,
) {
  const res = runScript([
    "--json",
    "evaluate",
    "--run",
    runDir,
    "--round",
    String(round),
    "--attestation",
    attestationPath,
  ]);
  return jsonOk(res) as { result: Record<string, unknown> };
}

async function finalizeRun(
  runDir: string,
  overrides: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    billed_amount?: number | null;
    currency?: string | null;
    manual_intervention_count?: number;
    session_id?: string;
  } = {},
) {
  const result = JSON.parse(
    await readFile(join(runDir, "result.json"), "utf8"),
  ) as { session_id: string };
  const manifest = JSON.parse(
    await readFile(join(runDir, "run-manifest.json"), "utf8"),
  ) as {
    run_id: string;
    executor_id: string;
    variant: string;
    replicate: number;
    tool_permission_class: string;
  };
  const billedAmount =
    overrides.billed_amount !== undefined ? overrides.billed_amount : 0.001;
  const telemetry = {
    schema_version: 1,
    run_id: manifest.run_id,
    executor_id: manifest.executor_id,
    variant: manifest.variant,
    replicate: manifest.replicate,
    session_id: overrides.session_id ?? result.session_id,
    tool_permission_class: manifest.tool_permission_class,
    input_tokens:
      overrides.input_tokens !== undefined ? overrides.input_tokens : 100,
    output_tokens:
      overrides.output_tokens !== undefined ? overrides.output_tokens : 50,
    billed_amount: billedAmount,
    currency:
      overrides.currency !== undefined
        ? overrides.currency
        : billedAmount !== null
          ? "USD"
          : null,
    manual_intervention_count: overrides.manual_intervention_count ?? 0,
  };
  const telemetryPath = join(tempRoot, `tel-${randomUUID()}.json`);
  await writeFile(telemetryPath, JSON.stringify(telemetry), "utf8");
  const res = runScript([
    "--json",
    "finalize",
    "--run",
    runDir,
    "--telemetry",
    telemetryPath,
  ]);
  return jsonOk(res) as { result: Record<string, unknown> };
}

let tempRoot = "";
const tmp = (name?: string) => join(tempRoot, name ?? randomUUID());

describe("benchmark-low-capability", () => {
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

  it("prepare creates a baseline run directory with all manifest binding fields", async () => {
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      tmp(),
    );
    expect(info.run_id).toBeTruthy();
    expect(info.run_dir).toContain(info.run_id);
    const manifest = info.manifest;
    expect(manifest.schema_version).toBe(1);
    expect(manifest.case_id).toBe("bounded-feature");
    expect(manifest.variant).toBe("baseline");
    expect(manifest.executor_id).toBe("E1");
    expect(manifest.base_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.tool_permission_class).toBe("workspace-read-write-shell");
    expect(manifest.fresh_session_required).toBe(true);
    expect(manifest.input_bundle_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.task_contract_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(info.run_dir, "workspace", "src", "range.js"))).toBe(
      true,
    );
    expect(existsSync(join(info.run_dir, "workspace", ".git"))).toBe(true);
    expect(
      existsSync(join(info.run_dir, "executor-input", "instruction.md")),
    ).toBe(true);
    expect(
      existsSync(join(info.run_dir, "executor-input", "input-manifest.json")),
    ).toBe(true);
  });

  it("prepare rejects duplicate runs", async () => {
    const out = tmp("dup");
    await prepareRun("bounded-feature", "baseline", "E1", 1, out);
    const res = runScript([
      "--json",
      "prepare",
      "--case",
      "bounded-feature",
      "--variant",
      "baseline",
      "--executor-id",
      "E1",
      "--replicate",
      "1",
      "--output",
      out,
    ]);
    expect(res.code).not.toBe(0);
    const envelope = res.data as { ok: boolean; error?: { message: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.message).toContain("RUN_ALREADY_EXISTS");
  });

  it("prepare rejects invalid executor ids", async () => {
    const res = runScript([
      "--json",
      "prepare",
      "--case",
      "bounded-feature",
      "--variant",
      "baseline",
      "--executor-id",
      "../evil",
      "--replicate",
      "1",
      "--output",
      tmp(),
    ]);
    expect(res.code).not.toBe(0);
    const envelope = res.data as { ok: boolean };
    expect(envelope.ok).toBe(false);
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
      join(info.workspace_path, "src", "range.js"),
      `export function range(start, end, step = 1) {\n  const result = [];\n  if (step > 0) {\n    for (let i = start; i < end; i += step) result.push(i);\n  } else {\n    for (let i = start; i > end; i += step) result.push(i);\n  }\n  return result;\n}\n`,
      "utf8",
    );
    const { path: attPath } = await makeAttestation(
      info.manifest,
      1,
      "implemented",
    );
    const { result } = await evaluateRun(info.run_dir, 1, attPath);
    expect(result.status).toBe("verified_success");
    expect(result.first_pass_success).toBe(true);
    expect(result.repair_rounds).toBe(0);
    expect(result.scope_violation_count).toBe(0);
    expect(result.exit_code).toBe(0);
    expect(result.changed_paths).toContain("src/range.js");
    expect(result.session_id).toBeTruthy();
    expect(result.manifest_sha256).toBe(info.manifest.manifest_sha256);
  });

  it("baseline evaluate reports verification_failed on a broken implementation", async () => {
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      tmp(),
    );
    const { path: attPath } = await makeAttestation(
      info.manifest,
      1,
      "implemented",
    );
    const { result } = await evaluateRun(info.run_dir, 1, attPath);
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
    const { path: att1 } = await makeAttestation(
      info.manifest,
      1,
      "implemented",
    );
    const r1 = await evaluateRun(info.run_dir, 1, att1);
    expect(r1.result.status).toBe("verification_failed");

    const { path: att2 } = await makeAttestation(
      info.manifest,
      2,
      "implemented",
      {
        sessionId: (r1.result.session_id as string) ?? undefined,
        fresh: false,
      },
    );
    const r2 = await evaluateRun(info.run_dir, 2, att2);
    expect(r2.result.status).toBe("stop_repeated_failure");
    expect(r2.result.same_fingerprint_repeat_count).toBeGreaterThan(0);
    expect(r2.result.repair_rounds).toBe(1);
  });

  it("detects scope violations including untracked files", async () => {
    const info = await prepareRun("scope-boundary", "baseline", "E1", 1, tmp());
    await writeFile(
      join(info.workspace_path, "src", "config.js"),
      `export const language = "en";\n`,
      "utf8",
    );
    const { path: attPath } = await makeAttestation(
      info.manifest,
      1,
      "implemented",
    );
    const { result } = await evaluateRun(info.run_dir, 1, attPath);
    expect(result.status).toBe("verification_failed");
    expect(result.scope_violation_count).toBeGreaterThan(0);
    expect(result.scope_violations).toContain("src/config.js");
  });

  it("correct scope-boundary fix does not violate scope", async () => {
    const info = await prepareRun("scope-boundary", "baseline", "E1", 1, tmp());
    await writeFile(
      join(info.workspace_path, "src", "main.js"),
      `export function greet(name) {\n  return \`Hello, \${name}!\`;\n}\n`,
      "utf8",
    );
    const { path: attPath } = await makeAttestation(
      info.manifest,
      1,
      "implemented",
    );
    const { result } = await evaluateRun(info.run_dir, 1, attPath);
    expect(result.status).toBe("verified_success");
    expect(result.scope_violation_count).toBe(0);
    expect(result.changed_paths).toContain("src/main.js");
  });

  it("decision-stop baseline requires explicit stopped_decision action", async () => {
    const info = await prepareRun("decision-stop", "baseline", "E1", 1, tmp());
    const { path: stopped } = await makeAttestation(
      info.manifest,
      1,
      "stopped_decision",
    );
    const { result: okResult } = await evaluateRun(info.run_dir, 1, stopped);
    expect(okResult.status).toBe("expected_stop_success");
    expect(okResult.first_pass_success).toBe(true);
    expect(okResult.changed_paths).toHaveLength(0);

    const info2 = await prepareRun("decision-stop", "baseline", "E1", 1, tmp());
    const { path: bad } = await makeAttestation(
      info2.manifest,
      1,
      "implemented",
    );
    const { result: badResult } = await evaluateRun(info2.run_dir, 1, bad);
    expect(badResult.status).not.toBe("expected_stop_success");
  });

  it("round state machine rejects out-of-sequence and repeated rounds", async () => {
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      tmp(),
    );
    const { path: att2 } = await makeAttestation(
      info.manifest,
      2,
      "implemented",
    );
    const skip = runScript([
      "--json",
      "evaluate",
      "--run",
      info.run_dir,
      "--round",
      "2",
      "--attestation",
      att2,
    ]);
    expect(skip.code).not.toBe(0);
    const skipEnvelope = skip.data as {
      ok: boolean;
      error?: { message: string };
    };
    expect(skipEnvelope.ok).toBe(false);
    expect(skipEnvelope.error?.message).toContain("ROUND_SEQUENCE_ERROR");

    await writeFile(
      join(info.workspace_path, "src", "range.js"),
      `export function range(start, end, step = 1) {\n  const result = [];\n  if (step > 0) {\n    for (let i = start; i < end; i += step) result.push(i);\n  } else {\n    for (let i = start; i > end; i += step) result.push(i);\n  }\n  return result;\n}\n`,
      "utf8",
    );
    const { path: att1 } = await makeAttestation(
      info.manifest,
      1,
      "implemented",
    );
    await evaluateRun(info.run_dir, 1, att1);

    const dup = runScript([
      "--json",
      "evaluate",
      "--run",
      info.run_dir,
      "--round",
      "1",
      "--attestation",
      att1,
    ]);
    expect(dup.code).not.toBe(0);
    const dupEnvelope = dup.data as {
      ok: boolean;
      error?: { message: string };
    };
    expect(dupEnvelope.ok).toBe(false);
    expect(dupEnvelope.error?.message).toContain("ROUND_ALREADY_EVALUATED");

    const over = runScript([
      "--json",
      "evaluate",
      "--run",
      info.run_dir,
      "--round",
      "4",
      "--attestation",
      att1,
    ]);
    expect(over.code).not.toBe(0);
    const overEnvelope = over.data as {
      ok: boolean;
      error?: { message: string };
    };
    expect(overEnvelope.ok).toBe(false);
    expect(overEnvelope.error?.message).toContain("ROUND_OUT_OF_RANGE");
  });

  it("round 3 failure is terminal stop_max_rounds", async () => {
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      tmp(),
    );
    const { path: att1, sessionId: s1 } = await makeAttestation(
      info.manifest,
      1,
      "implemented",
    );
    await evaluateRun(info.run_dir, 1, att1);

    await writeFile(
      join(info.workspace_path, "src", "range.js"),
      `export function range() { throw new Error("broken round 2"); }\n`,
      "utf8",
    );
    const { path: att2 } = await makeAttestation(
      info.manifest,
      2,
      "implemented",
      { sessionId: s1, fresh: false },
    );
    await evaluateRun(info.run_dir, 2, att2);

    await writeFile(
      join(info.workspace_path, "src", "range.js"),
      `export function range() { throw new Error("broken round 3"); }\n`,
      "utf8",
    );
    const { path: att3 } = await makeAttestation(
      info.manifest,
      3,
      "implemented",
      { sessionId: s1, fresh: false },
    );
    const { result } = await evaluateRun(info.run_dir, 3, att3);
    expect(result.status).toBe("stop_max_rounds");
  });

  it("finalize imports telemetry and computes total_tokens", async () => {
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      tmp(),
    );
    await writeFile(
      join(info.workspace_path, "src", "range.js"),
      `export function range(start, end, step = 1) {\n  const result = [];\n  if (step > 0) {\n    for (let i = start; i < end; i += step) result.push(i);\n  } else {\n    for (let i = start; i > end; i += step) result.push(i);\n  }\n  return result;\n}\n`,
      "utf8",
    );
    const { path: att1 } = await makeAttestation(
      info.manifest,
      1,
      "implemented",
    );
    await evaluateRun(info.run_dir, 1, att1);

    const { result } = await finalizeRun(info.run_dir);
    expect(result.input_tokens).toBe(100);
    expect(result.output_tokens).toBe(50);
    expect(result.total_tokens).toBe(150);
    expect(result.billed_amount).toBe(0.001);

    const val = runScript([
      "--json",
      "validate-result",
      "--file",
      join(info.run_dir, "result.json"),
    ]);
    const valData = jsonOk(val) as { schema_version: number };
    expect(valData.schema_version).toBe(1);
  });

  it("finalize rejects non-terminal results", async () => {
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      tmp(),
    );
    const { path: att1 } = await makeAttestation(
      info.manifest,
      1,
      "implemented",
    );
    await evaluateRun(info.run_dir, 1, att1);
    const telemetryPath = join(tempRoot, `tel-${randomUUID()}.json`);
    await writeFile(
      telemetryPath,
      JSON.stringify({
        schema_version: 1,
        run_id: info.manifest.run_id,
        executor_id: info.manifest.executor_id,
        variant: "baseline",
        replicate: 1,
        session_id: "session-test",
        tool_permission_class: info.manifest.tool_permission_class,
        input_tokens: 0,
        output_tokens: 0,
        billed_amount: null,
        currency: null,
        manual_intervention_count: 0,
      }),
      "utf8",
    );
    const res = runScript([
      "--json",
      "finalize",
      "--run",
      info.run_dir,
      "--telemetry",
      telemetryPath,
    ]);
    expect(res.code).not.toBe(0);
    const finEnvelope = res.data as {
      ok: boolean;
      error?: { message: string };
    };
    expect(finEnvelope.ok).toBe(false);
    expect(finEnvelope.error?.message).toContain("non-terminal");
  });

  it("finalize handles zero tokens as total 0", async () => {
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      tmp(),
    );
    await writeFile(
      join(info.workspace_path, "src", "range.js"),
      `export function range(start, end, step = 1) {\n  const result = [];\n  if (step > 0) {\n    for (let i = start; i < end; i += step) result.push(i);\n  } else {\n    for (let i = start; i > end; i += step) result.push(i);\n  }\n  return result;\n}\n`,
      "utf8",
    );
    const { path: att1 } = await makeAttestation(
      info.manifest,
      1,
      "implemented",
    );
    await evaluateRun(info.run_dir, 1, att1);
    const { result } = await finalizeRun(info.run_dir, {
      input_tokens: 0,
      output_tokens: 0,
      billed_amount: null,
      currency: null,
    });
    expect(result.total_tokens).toBe(0);
  });

  it("finalize rejects malformed telemetry", async () => {
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      tmp(),
    );
    await writeFile(
      join(info.workspace_path, "src", "range.js"),
      `export function range(start, end, step = 1) {\n  const result = [];\n  if (step > 0) {\n    for (let i = start; i < end; i += step) result.push(i);\n  } else {\n    for (let i = start; i > end; i += step) result.push(i);\n  }\n  return result;\n}\n`,
      "utf8",
    );
    const { path: att1 } = await makeAttestation(
      info.manifest,
      1,
      "implemented",
    );
    await evaluateRun(info.run_dir, 1, att1);
    const telemetryPath = join(tempRoot, `tel-${randomUUID()}.json`);
    await writeFile(
      telemetryPath,
      JSON.stringify({
        schema_version: 1,
        run_id: info.manifest.run_id,
        executor_id: info.manifest.executor_id,
        variant: "baseline",
        replicate: 1,
        session_id: "session-test",
        tool_permission_class: info.manifest.tool_permission_class,
        input_tokens: "100",
        output_tokens: 50,
        billed_amount: null,
        currency: null,
        manual_intervention_count: 0,
      }),
      "utf8",
    );
    const res = runScript([
      "--json",
      "finalize",
      "--run",
      info.run_dir,
      "--telemetry",
      telemetryPath,
    ]);
    expect(res.code).not.toBe(0);
  });

  it("finalize marks manual intervention as stop_manual_intervention", async () => {
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      tmp(),
    );
    await writeFile(
      join(info.workspace_path, "src", "range.js"),
      `export function range(start, end, step = 1) {\n  const result = [];\n  if (step > 0) {\n    for (let i = start; i < end; i += step) result.push(i);\n  } else {\n    for (let i = start; i > end; i += step) result.push(i);\n  }\n  return result;\n}\n`,
      "utf8",
    );
    const { path: att1 } = await makeAttestation(
      info.manifest,
      1,
      "implemented",
    );
    await evaluateRun(info.run_dir, 1, att1);
    const { result } = await finalizeRun(info.run_dir, {
      manual_intervention_count: 1,
    });
    expect(result.status).toBe("stop_manual_intervention");
    expect(result.manual_intervention_count).toBe(1);
  });

  it("score fails on unpaired baseline run", async () => {
    const resultRoot = tmp("score-unpaired");
    const info = await prepareRun(
      "bounded-feature",
      "baseline",
      "E1",
      1,
      resultRoot,
    );
    await writeFile(
      join(info.workspace_path, "src", "range.js"),
      `export function range(start, end, step = 1) {\n  const result = [];\n  if (step > 0) {\n    for (let i = start; i < end; i += step) result.push(i);\n  } else {\n    for (let i = start; i > end; i += step) result.push(i);\n  }\n  return result;\n}\n`,
      "utf8",
    );
    const { path: att1 } = await makeAttestation(
      info.manifest,
      1,
      "implemented",
    );
    await evaluateRun(info.run_dir, 1, att1);
    await finalizeRun(info.run_dir);

    const score = runScript(["--json", "score", "--results", resultRoot]);
    expect(score.code).not.toBe(0);
    const envelope = score.data as { ok: boolean };
    expect(envelope.ok).toBe(false);
  });

  describe.skipIf(!existsSync(codePactCliPath))(
    "code_pact variant",
    () => {
      it("prepares a code_pact run and records an input bundle", async () => {
        const info = await prepareRun(
          "explicit-context",
          "code_pact",
          "E1",
          1,
          tmp(),
        );
        expect(
          existsSync(join(info.run_dir, "executor-input", "context-pack.md")),
        ).toBe(true);
        expect(
          existsSync(
            join(info.run_dir, "executor-input", "code-pact-prepare.json"),
          ),
        ).toBe(true);
        expect(
          existsSync(
            join(info.run_dir, "executor-input", "code-pact-runbook.json"),
          ),
        ).toBe(true);
      });

      it("scores paired baseline and code_pact results with different context retrieval counts", async () => {
        const resultRoot = tmp("score-pair");
        const base = await prepareRun(
          "explicit-context",
          "baseline",
          "E1",
          1,
          resultRoot,
        );
        const codePact = await prepareRun(
          "explicit-context",
          "code_pact",
          "E1",
          1,
          resultRoot,
        );

        for (const run of [base, codePact]) {
          await writeFile(
            join(run.workspace_path, "src", "formatter.js"),
            `export function format(s) {\n  const t = s.trim();\n  const m = t.match(/[a-zA-Z]/);\n  if (!m) return t;\n  const idx = t.indexOf(m[0]);\n  return t.slice(0, idx) + m[0].toUpperCase() + t.slice(idx + 1);\n}\n`,
            "utf8",
          );
        }

        const { path: baseAtt } = await makeAttestation(
          base.manifest,
          1,
          "implemented",
          { contextRetrieval: 0 },
        );
        const { result: baseResult } = await evaluateRun(
          base.run_dir,
          1,
          baseAtt,
        );
        expect(baseResult.status).toBe("verified_success");

        const { path: cpAtt } = await makeAttestation(
          codePact.manifest,
          1,
          "implemented",
          { contextRetrieval: 2 },
        );
        const { result: cpResult } = await evaluateRun(
          codePact.run_dir,
          1,
          cpAtt,
        );
        expect(cpResult.status).toBe("verified_success");

        for (const run of [base, codePact]) {
          await finalizeRun(run.run_dir, {
            input_tokens: run === base ? 100 : 80,
            output_tokens: run === base ? 50 : 40,
          });
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
        expect(summary.totals.safety_gate).toBe("pass");
        expect(summary.totals.stage_b_allowed).toBe(true);
      });

      it("prepare-pilot stage a creates baseline and code_pact manifests", async () => {
        const pilotRoot = tmp("pilot");
        const res = runScript([
          "--json",
          "prepare-pilot",
          "--stage",
          "a",
          "--executors",
          "E1",
          "--replicates",
          "1",
          "--output",
          pilotRoot,
        ]);
        const data = jsonOk(res) as {
          manifest_count: number;
          cli_built: boolean;
        };
        expect(data.manifest_count).toBe(data.cli_built ? 10 : 5);
        expect(existsSync(join(pilotRoot, "pilot-plan.json"))).toBe(true);
      }, 30000);
    },
    30000,
  );
});
