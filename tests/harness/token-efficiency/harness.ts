import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  run,
  createTempProject,
  ensureCliBuilt,
  expectJsonOk,
  type RunResult,
} from "../../helpers/cli.ts";

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertTrue(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertDefined<T>(
  value: T | undefined,
  message: string,
): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
}

export type InvocationCategory =
  | "task_start"
  | "task_complete"
  | "task_prepare"
  | "context_retrieval"
  | "evidence_retrieval";

export type InvocationMeasurement = {
  category: InvocationCategory;
  exit_code: number;
  stdout_bytes: number;
};

export type ScenarioMeasurement = {
  scenario: string;
  total_code_pact_stdout_bytes: number;
  command_count: number;
  verification_count: number;
  failure_count: number;
  context_retrieval_count: number;
  evidence_retrieval_count: number;
  prior_signal_count: number;
  invocations: InvocationMeasurement[];
};

export type TokenEfficiencyHarnessSummary = {
  schema_version: 1;
  scenarios: ScenarioMeasurement[];
  signal_field_incremental_bytes: number;
  repeated_failure_envelope_bytes: number;
  first_failure_signal_omitted: boolean;
  repeat_failure_signal_present: boolean;
  default_output_compatible: boolean;
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

const REPAIR_MARKER = ".code-pact-harness-repaired";

const MARKER_VERIFY_COMMAND = `node -e "const fs=require('node:fs');process.exit(fs.existsSync('${REPAIR_MARKER}')?0:1)"`;

export const SUCCESS_VERIFY_COMMAND = `node -e "process.exit(0)"`;

const AGENT = "claude-code";

function runGit(dir: string, ...args: string[]): void {
  const res = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  }
}

function runMeasured(
  dir: string,
  args: string[],
  category: InvocationCategory,
): { result: RunResult; measurement: InvocationMeasurement } {
  const result = run(dir, args);
  const measurement: InvocationMeasurement = {
    category,
    exit_code: result.code,
    stdout_bytes: byteLength(result.stdout),
  };
  return { result, measurement };
}

export async function createBaseProject(
  prefix: string,
  verifyCommand: string,
  testOptions?: {
    beforeReturn?: (phasePath: string) => Promise<void>;
  },
): Promise<{ dir: string; cleanup: () => Promise<void>; phasePath: string }> {
  ensureCliBuilt();
  const { dir, cleanup } = await createTempProject({ prefix, init: true });

  try {
    const designDir = join(dir, "design");
    await mkdir(join(designDir, "phases"), { recursive: true });
    const phasePath = join(designDir, "phases", "P1-foundation.yaml");

    const phaseYaml = `id: P1\nname: Harness Phase\nweight: 1\nconfidence: high\nrisk: low\nstatus: planned\nobjective: Harness fixture phase.\ndefinition_of_done:\n  - placeholder\nverification:\n  commands:\n    - ${verifyCommand}\ntasks:\n  - id: P1-T1\n    type: feature\n    ambiguity: low\n    risk: low\n    context_size: small\n    write_surface: low\n    verification_strength: strong\n    expected_duration: short\n    status: planned\n    description: Placeholder harness task.\n`;
    await writeFile(phasePath, phaseYaml, "utf8");

    const roadmapYaml = `phases:\n  - id: P1\n    name: Harness Phase\n    path: design/phases/P1-foundation.yaml\n    weight: 1\n`;
    await writeFile(join(designDir, "roadmap.yaml"), roadmapYaml, "utf8");

    runGit(dir, "init", "--quiet");
    runGit(dir, "add", ".");
    runGit(dir, "commit", "-m", "init", "--quiet");

    if (testOptions?.beforeReturn) {
      await testOptions.beforeReturn(phasePath);
    }

    return { dir, cleanup, phasePath };
  } catch (error) {
    return cleanupPreservingPrimaryError(error, cleanup);
  }
}

export async function cleanupPreservingPrimaryError(
  primaryError: unknown,
  cleanup: () => Promise<void>,
): Promise<never> {
  try {
    await cleanup();
  } catch {
    // Cleanup is best effort here. The setup error is the primary failure.
  }

  throw primaryError;
}

export async function forceTaskBudgetDeferral(
  dir: string,
  phasePath: string,
): Promise<void> {
  const content = await readFile(phasePath, "utf8");
  const parsed = parseYaml(content);

  const largeReads: string[] = [];
  for (let i = 0; i < 900; i += 1) {
    largeReads.push(`tests/fixtures/token-efficiency/${i}.txt`);
  }

  parsed.tasks[0].reads = largeReads;
  parsed.tasks[0].status = "in_progress";
  await writeFile(phasePath, stringifyYaml(parsed), "utf8");

  for (let i = 0; i < 900; i += 1) {
    const fixturePath = join(
      dir,
      "tests",
      "fixtures",
      "token-efficiency",
      `${i}.txt`,
    );
    await mkdir(join(fixturePath, ".."), { recursive: true });
    await writeFile(
      fixturePath,
      `fixture content line ${i}\n`.repeat(50),
      "utf8",
    );
  }

  runGit(dir, "add", ".");
  runGit(dir, "commit", "-m", "defer context", "--quiet");
}

async function writeRepairMarker(dir: string): Promise<void> {
  await writeFile(join(dir, REPAIR_MARKER), "repaired\n", "utf8");
}

export async function runFirstPassSuccessScenario(): Promise<ScenarioMeasurement> {
  const { dir, cleanup } = await createBaseProject(
    "code-pact-harness-first-pass-",
    SUCCESS_VERIFY_COMMAND,
  );

  const invocations: InvocationMeasurement[] = [];
  let total = 0;
  let commandCount = 0;
  let verificationCount = 0;
  let failureCount = 0;

  try {
    const start = runMeasured(
      dir,
      ["task", "start", "P1-T1", "--agent", AGENT, "--json"],
      "task_start",
    );
    invocations.push(start.measurement);
    total += start.measurement.stdout_bytes;
    commandCount += 1;
    assertEqual(start.result.code, 0, "first-pass task start exit code");
    expectJsonOk(start.result);

    const complete = runMeasured(
      dir,
      ["task", "complete", "P1-T1", "--agent", AGENT, "--json"],
      "task_complete",
    );
    invocations.push(complete.measurement);
    total += complete.measurement.stdout_bytes;
    commandCount += 1;
    verificationCount += 1;
    if (complete.result.code !== 0) failureCount += 1;

    assertEqual(complete.result.code, 0, "first-pass complete exit code");
    expectJsonOk(complete.result);
  } finally {
    await cleanup();
  }

  return {
    scenario: "first_pass_success",
    total_code_pact_stdout_bytes: total,
    command_count: commandCount,
    verification_count: verificationCount,
    failure_count: failureCount,
    context_retrieval_count: 0,
    evidence_retrieval_count: 0,
    prior_signal_count: 0,
    invocations,
  };
}

export async function runFailureRepairSuccessScenario(): Promise<ScenarioMeasurement> {
  const { dir, cleanup } = await createBaseProject(
    "code-pact-harness-failure-repair-",
    MARKER_VERIFY_COMMAND,
  );

  const invocations: InvocationMeasurement[] = [];
  let total = 0;
  let commandCount = 0;
  let verificationCount = 0;
  let failureCount = 0;

  try {
    const start = runMeasured(
      dir,
      ["task", "start", "P1-T1", "--agent", AGENT, "--json"],
      "task_start",
    );
    invocations.push(start.measurement);
    total += start.measurement.stdout_bytes;
    commandCount += 1;
    assertEqual(start.result.code, 0, "failure-repair task start exit code");
    expectJsonOk(start.result);

    const firstComplete = runMeasured(
      dir,
      ["task", "complete", "P1-T1", "--agent", AGENT, "--json"],
      "task_complete",
    );
    invocations.push(firstComplete.measurement);
    total += firstComplete.measurement.stdout_bytes;
    commandCount += 1;
    verificationCount += 1;
    if (firstComplete.result.code !== 0) failureCount += 1;

    assertEqual(
      firstComplete.result.code,
      1,
      "failure-repair first complete exit code",
    );

    await writeRepairMarker(dir);

    const secondComplete = runMeasured(
      dir,
      ["task", "complete", "P1-T1", "--agent", AGENT, "--json"],
      "task_complete",
    );
    invocations.push(secondComplete.measurement);
    total += secondComplete.measurement.stdout_bytes;
    commandCount += 1;
    verificationCount += 1;
    if (secondComplete.result.code !== 0) failureCount += 1;

    assertEqual(
      secondComplete.result.code,
      0,
      "failure-repair second complete exit code",
    );
    expectJsonOk(secondComplete.result);
  } finally {
    await cleanup();
  }

  return {
    scenario: "failure_repair_success",
    total_code_pact_stdout_bytes: total,
    command_count: commandCount,
    verification_count: verificationCount,
    failure_count: failureCount,
    context_retrieval_count: 0,
    evidence_retrieval_count: 0,
    prior_signal_count: 0,
    invocations,
  };
}

type RepeatedFailureScenarioResult = {
  measurement: ScenarioMeasurement;
  signalFieldIncrementalBytes: number;
  repeatedFailureEnvelopeBytes: number;
  firstFailureSignalOmitted: boolean;
  repeatFailureSignalPresent: boolean;
  defaultOutputCompatible: boolean;
};

export async function runRepeatedFailureSuccessScenario(
  defaultOutputCompatible: boolean,
): Promise<RepeatedFailureScenarioResult> {
  const { dir, cleanup } = await createBaseProject(
    "code-pact-harness-repeated-failure-",
    MARKER_VERIFY_COMMAND,
  );

  const invocations: InvocationMeasurement[] = [];
  let total = 0;
  let commandCount = 0;
  let verificationCount = 0;
  let failureCount = 0;
  let priorSignalCount = 0;

  let signalFieldIncrementalBytes = 0;
  let repeatedFailureEnvelopeBytes = 0;
  let firstFailureSignalOmitted = false;
  let repeatFailureSignalPresent = false;

  try {
    const start = runMeasured(
      dir,
      ["task", "start", "P1-T1", "--agent", AGENT, "--json"],
      "task_start",
    );
    invocations.push(start.measurement);
    total += start.measurement.stdout_bytes;
    commandCount += 1;
    assertEqual(start.result.code, 0, "repeated-failure task start exit code");
    expectJsonOk(start.result);

    const firstComplete = runMeasured(
      dir,
      [
        "task",
        "complete",
        "P1-T1",
        "--agent",
        AGENT,
        "--json",
        "--detail",
        "agent",
      ],
      "task_complete",
    );
    invocations.push(firstComplete.measurement);
    total += firstComplete.measurement.stdout_bytes;
    commandCount += 1;
    verificationCount += 1;
    if (firstComplete.result.code !== 0) failureCount += 1;

    assertEqual(
      firstComplete.result.code,
      1,
      "repeated-failure first complete exit code",
    );
    const firstJson = JSON.parse(firstComplete.result.stdout) as {
      ok: false;
      data: { prior_local_signal?: unknown };
    };
    firstFailureSignalOmitted = firstJson.data.prior_local_signal === undefined;

    const secondComplete = runMeasured(
      dir,
      [
        "task",
        "complete",
        "P1-T1",
        "--agent",
        AGENT,
        "--json",
        "--detail",
        "agent",
      ],
      "task_complete",
    );
    invocations.push(secondComplete.measurement);
    total += secondComplete.measurement.stdout_bytes;
    commandCount += 1;
    verificationCount += 1;
    if (secondComplete.result.code !== 0) failureCount += 1;

    assertEqual(
      secondComplete.result.code,
      1,
      "repeated-failure second complete exit code",
    );
    const secondJson = JSON.parse(secondComplete.result.stdout) as {
      ok: false;
      data: {
        prior_local_signal?: {
          schema_version: number;
          exact_match_count: number;
          last_observed_at: string;
        };
        projection_truncated?: boolean;
      };
    };

    repeatFailureSignalPresent =
      secondJson.data.prior_local_signal !== undefined;
    if (repeatFailureSignalPresent) {
      priorSignalCount += 1;
    }

    const signal = secondJson.data.prior_local_signal;
    assertTrue(
      signal?.schema_version === 1 && signal?.exact_match_count === 1,
      "prior_local_signal schema_version/exact_match_count",
    );
    assertTrue(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        signal?.last_observed_at ?? "",
      ),
      "prior_local_signal last_observed_at timestamp",
    );
    assertTrue(
      secondJson.data.projection_truncated !== true,
      "projection_truncated must not be true",
    );

    const withSignal = structuredClone(secondJson);
    const withoutSignal = structuredClone(withSignal);
    delete withoutSignal.data.prior_local_signal;
    const withSignalBytes = byteLength(`${JSON.stringify(withSignal)}\n`);
    const withoutSignalBytes = byteLength(`${JSON.stringify(withoutSignal)}\n`);
    signalFieldIncrementalBytes = withSignalBytes - withoutSignalBytes;
    repeatedFailureEnvelopeBytes = byteLength(secondComplete.result.stdout);
    const signalObjectBytes = signal ? byteLength(JSON.stringify(signal)) : 0;
    assertTrue(
      signalObjectBytes <= 1024,
      "signal object bytes must be <= 1 KiB",
    );
    assertTrue(
      signalFieldIncrementalBytes > 0,
      "signal incremental bytes must be positive",
    );

    await writeRepairMarker(dir);

    const successComplete = runMeasured(
      dir,
      [
        "task",
        "complete",
        "P1-T1",
        "--agent",
        AGENT,
        "--json",
        "--detail",
        "agent",
      ],
      "task_complete",
    );
    invocations.push(successComplete.measurement);
    total += successComplete.measurement.stdout_bytes;
    commandCount += 1;
    verificationCount += 1;
    if (successComplete.result.code !== 0) failureCount += 1;

    assertEqual(
      successComplete.result.code,
      0,
      "repeated-failure success complete exit code",
    );
    expectJsonOk(successComplete.result);
  } finally {
    await cleanup();
  }

  const measurement: ScenarioMeasurement = {
    scenario: "repeated_failure_success",
    total_code_pact_stdout_bytes: total,
    command_count: commandCount,
    verification_count: verificationCount,
    failure_count: failureCount,
    context_retrieval_count: 0,
    evidence_retrieval_count: 0,
    prior_signal_count: priorSignalCount,
    invocations,
  };

  return {
    measurement,
    signalFieldIncrementalBytes,
    repeatedFailureEnvelopeBytes,
    firstFailureSignalOmitted,
    repeatFailureSignalPresent,
    defaultOutputCompatible,
  };
}

export function checkDefaultOutputCompatibility(stdout: string): boolean {
  let parsed: {
    ok: boolean;
    error?: { code?: string };
    data?: { prior_local_signal?: unknown };
  };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch (cause) {
    throw new Error("default-compat stdout is not valid JSON", { cause });
  }

  assertEqual(parsed.ok, false, "default output must be an error envelope");
  assertEqual(
    parsed.error?.code,
    "VERIFICATION_FAILED",
    "default output must be a verification-failure envelope",
  );
  assertTrue(
    parsed.data?.prior_local_signal === undefined,
    "default output must omit prior_local_signal",
  );

  return true;
}

async function runDefaultOutputCompatibilityCheck(): Promise<boolean> {
  const { dir, cleanup } = await createBaseProject(
    "code-pact-harness-default-compat-",
    MARKER_VERIFY_COMMAND,
  );

  try {
    const start = runMeasured(
      dir,
      ["task", "start", "P1-T1", "--agent", AGENT, "--json"],
      "task_start",
    );
    assertEqual(start.result.code, 0, "default-compat task start exit code");
    expectJsonOk(start.result);

    const first = runMeasured(
      dir,
      [
        "task",
        "complete",
        "P1-T1",
        "--agent",
        AGENT,
        "--json",
        "--detail",
        "agent",
      ],
      "task_complete",
    );
    assertEqual(
      first.result.code,
      1,
      "default-compat first complete exit code",
    );

    const second = runMeasured(
      dir,
      ["task", "complete", "P1-T1", "--agent", AGENT, "--json"],
      "task_complete",
    );
    assertEqual(
      second.result.code,
      1,
      "default-compat second complete exit code",
    );

    return checkDefaultOutputCompatibility(second.result.stdout);
  } finally {
    await cleanup();
  }
}

export async function runDeferredContextRetrievalScenario(testOptions?: {
  onProjectCreated?: (dir: string) => void;
  deferralError?: Error;
}): Promise<ScenarioMeasurement> {
  const { dir, cleanup, phasePath } = await createBaseProject(
    "code-pact-harness-deferred-context-",
    SUCCESS_VERIFY_COMMAND,
  );

  testOptions?.onProjectCreated?.(dir);

  const invocations: InvocationMeasurement[] = [];
  let total = 0;
  let commandCount = 0;
  let contextRetrievalCount = 0;

  try {
    await forceTaskBudgetDeferral(dir, phasePath);
    if (testOptions?.deferralError) {
      throw testOptions.deferralError;
    }
    const prepareRes = runMeasured(
      dir,
      [
        "task",
        "prepare",
        "P1-T1",
        "--agent",
        AGENT,
        "--recommended-context-budget",
        "--json",
      ],
      "task_prepare",
    );
    invocations.push(prepareRes.measurement);
    total += prepareRes.measurement.stdout_bytes;
    commandCount += 1;

    assertEqual(
      prepareRes.result.code,
      0,
      "deferred context task prepare exit code",
    );
    const prepareJson = expectJsonOk<{
      deferred_context?: { manifest_ref: string };
    }>(prepareRes.result);
    const manifestRef = prepareJson.data.deferred_context?.manifest_ref;
    assertDefined(manifestRef, "deferred context manifest_ref must be defined");

    const listRes = runMeasured(
      dir,
      ["context", "show", manifestRef, "--list", "--json"],
      "context_retrieval",
    );
    invocations.push(listRes.measurement);
    total += listRes.measurement.stdout_bytes;
    commandCount += 1;
    contextRetrievalCount += 1;
    assertEqual(listRes.result.code, 0, "context show --list exit code");

    const sectionRes = runMeasured(
      dir,
      ["context", "show", manifestRef, "--section", "reads"],
      "context_retrieval",
    );
    invocations.push(sectionRes.measurement);
    total += sectionRes.measurement.stdout_bytes;
    commandCount += 1;
    contextRetrievalCount += 1;
    assertEqual(sectionRes.result.code, 0, "context show --section exit code");
  } finally {
    await cleanup();
  }

  return {
    scenario: "deferred_context_retrieval",
    total_code_pact_stdout_bytes: total,
    command_count: commandCount,
    verification_count: 0,
    failure_count: 0,
    context_retrieval_count: contextRetrievalCount,
    evidence_retrieval_count: 0,
    prior_signal_count: 0,
    invocations,
  };
}

export async function runEvidenceRetrievalScenario(): Promise<ScenarioMeasurement> {
  const verifyCommand =
    "node -e \"console.log('x'.repeat(5000)); console.error('y'.repeat(5000)); process.exit(1)\"";
  const { dir, cleanup } = await createBaseProject(
    "code-pact-harness-evidence-",
    verifyCommand,
  );

  const invocations: InvocationMeasurement[] = [];
  let total = 0;
  let commandCount = 0;
  let verificationCount = 0;
  let failureCount = 0;
  let evidenceRetrievalCount = 0;

  try {
    const start = runMeasured(
      dir,
      ["task", "start", "P1-T1", "--agent", AGENT, "--json"],
      "task_start",
    );
    invocations.push(start.measurement);
    total += start.measurement.stdout_bytes;
    commandCount += 1;
    assertEqual(
      start.result.code,
      0,
      "evidence retrieval task start exit code",
    );
    expectJsonOk(start.result);

    const completeRes = runMeasured(
      dir,
      [
        "task",
        "complete",
        "P1-T1",
        "--agent",
        AGENT,
        "--json",
        "--detail",
        "agent",
      ],
      "task_complete",
    );
    invocations.push(completeRes.measurement);
    total += completeRes.measurement.stdout_bytes;
    commandCount += 1;
    verificationCount += 1;
    if (completeRes.result.code !== 0) failureCount += 1;

    assertEqual(
      completeRes.result.code,
      1,
      "evidence retrieval complete exit code",
    );

    const failureJson = JSON.parse(completeRes.result.stdout) as {
      ok: false;
      data: { failure?: { evidence_ref?: string } };
    };
    const evidenceRef = failureJson.data.failure?.evidence_ref;
    assertDefined(evidenceRef, "evidence_ref must be defined");

    const evidenceRes = runMeasured(
      dir,
      ["evidence", "show", evidenceRef, "--json"],
      "evidence_retrieval",
    );
    invocations.push(evidenceRes.measurement);
    total += evidenceRes.measurement.stdout_bytes;
    commandCount += 1;
    evidenceRetrievalCount += 1;
    assertEqual(evidenceRes.result.code, 0, "evidence show exit code");
    expectJsonOk(evidenceRes.result);
  } finally {
    await cleanup();
  }

  return {
    scenario: "evidence_retrieval",
    total_code_pact_stdout_bytes: total,
    command_count: commandCount,
    verification_count: verificationCount,
    failure_count: failureCount,
    context_retrieval_count: 0,
    evidence_retrieval_count: evidenceRetrievalCount,
    prior_signal_count: 0,
    invocations,
  };
}

export async function runAllScenarios(): Promise<TokenEfficiencyHarnessSummary> {
  const defaultOutputCompatible = await runDefaultOutputCompatibilityCheck();

  const firstPass = await runFirstPassSuccessScenario();
  const failureRepair = await runFailureRepairSuccessScenario();
  const repeatedFailure = await runRepeatedFailureSuccessScenario(
    defaultOutputCompatible,
  );
  const deferredContext = await runDeferredContextRetrievalScenario();
  const evidenceRetrieval = await runEvidenceRetrievalScenario();

  return {
    schema_version: 1,
    scenarios: [
      firstPass,
      failureRepair,
      repeatedFailure.measurement,
      deferredContext,
      evidenceRetrieval,
    ],
    signal_field_incremental_bytes: repeatedFailure.signalFieldIncrementalBytes,
    repeated_failure_envelope_bytes:
      repeatedFailure.repeatedFailureEnvelopeBytes,
    first_failure_signal_omitted: repeatedFailure.firstFailureSignalOmitted,
    repeat_failure_signal_present: repeatedFailure.repeatFailureSignalPresent,
    default_output_compatible: repeatedFailure.defaultOutputCompatible,
  };
}
