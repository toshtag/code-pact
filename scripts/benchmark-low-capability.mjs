#!/usr/bin/env node
// Provider-neutral benchmark harness for low-capability execution evidence.
//
// No model API is called. The harness prepares paired run workspaces, evaluates
// externally-executed rounds, imports executor telemetry, validates results, and
// scores paired baseline / Code Pact runs.

import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  copyFile,
  rm,
} from "node:fs/promises";
import { existsSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const EXCLUDED_FIXTURE_DIRS = new Set([
  ".git",
  "node_modules",
  ".local",
  ".context",
  ".DS_Store",
]);
const HIDDEN_SOURCE_DIRS = new Set([".code-pact", ".context", ".git"]);
const CORPUSS_REL = "benchmarks/low-capability/corpus.json";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function canonicalJson(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(v => canonicalJson(v)).join(",")}]`;
  }
  const record = value;
  const keys = Object.keys(record)
    .filter(k => record[k] !== undefined)
    .sort();
  const pairs = keys.map(
    k => `${JSON.stringify(k)}:${canonicalJson(record[k])}`,
  );
  return `{${pairs.join(",")}}`;
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function jsonOut(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ok(data) {
  return { ok: true, data };
}

function fail(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

function isJson(args) {
  return args.includes("--json") || args.values?.json === true;
}

function byteLength(str) {
  return Buffer.byteLength(str, "utf8");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, jsonOut(value), "utf8");
}

async function fixtureDigest(fixturePath) {
  const record = {};
  async function walk(dir, prefix) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (EXCLUDED_FIXTURE_DIRS.has(ent.name)) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(join(dir, ent.name), rel);
      } else if (ent.isFile()) {
        const content = await readFile(join(dir, ent.name), "utf8");
        record[rel] = content;
      }
    }
  }
  await walk(fixturePath, "");
  return sha256(canonicalJson(record));
}

function taskContractDigest(corpusVersion, caseObj) {
  return sha256(
    canonicalJson({
      corpus_version: corpusVersion,
      ...caseObj,
    }),
  );
}

function computeRunId(
  corpusVersion,
  caseId,
  variant,
  executorId,
  replicate,
  fixtureDigest,
  taskContractDigest,
) {
  return sha256(
    canonicalJson({
      corpus_version: corpusVersion,
      case_id: caseId,
      variant,
      executor_id: executorId,
      replicate,
      fixture_digest: fixtureDigest,
      task_contract_digest: taskContractDigest,
    }),
  );
}

async function loadCorpus() {
  const path = resolve(repoRoot, CORPUSS_REL);
  const corpus = await readJson(path);
  return corpus;
}

function validateCorpus(corpus, repoRoot) {
  const issues = [];
  if (corpus.schema_version !== 1) issues.push("schema_version must be 1");
  if (
    typeof corpus.corpus_version !== "string" ||
    corpus.corpus_version.length === 0
  ) {
    issues.push("corpus_version must be a non-empty string");
  }
  if (corpus.max_rounds !== 3) issues.push("max_rounds must be 3");
  if (
    typeof corpus.failure_feedback_max_bytes !== "number" ||
    corpus.failure_feedback_max_bytes <= 0
  ) {
    issues.push("failure_feedback_max_bytes must be a positive number");
  }
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    issues.push("cases must be a non-empty array");
    return issues;
  }
  const ids = new Set();
  const taskIds = new Set();
  for (const c of corpus.cases) {
    if (!c.id || typeof c.id !== "string") issues.push("case id missing");
    if (ids.has(c.id)) issues.push(`duplicate case id: ${c.id}`);
    ids.add(c.id);
    if (!c.task_id || typeof c.task_id !== "string")
      issues.push(`${c.id}: task_id missing`);
    if (taskIds.has(c.task_id)) issues.push(`duplicate task_id: ${c.task_id}`);
    taskIds.add(c.task_id);
    if (
      !["verified_success", "expected_stop_success"].includes(
        c.expected_outcome,
      )
    ) {
      issues.push(`${c.id}: unexpected expected_outcome`);
    }
    if (!Array.isArray(c.allowed_writes))
      issues.push(`${c.id}: allowed_writes must be an array`);
    if (!Array.isArray(c.verification) || c.verification.length === 0) {
      issues.push(`${c.id}: verification commands missing`);
    }
    const fixturePath = resolve(repoRoot, c.fixture);
    if (!existsSync(fixturePath)) {
      issues.push(`${c.id}: fixture path missing: ${c.fixture}`);
    } else {
      try {
        fixtureDigest(fixturePath);
      } catch (e) {
        issues.push(`${c.id}: fixture digest error: ${e.message}`);
      }
    }
  }
  return issues;
}

function findCase(corpus, caseId) {
  const c = corpus.cases.find(x => x.id === caseId);
  if (!c) throw new Error(`case not found: ${caseId}`);
  return c;
}

function resolveOutputRoot(output) {
  if (output) return resolve(output);
  return resolve(repoRoot, ".local", "benchmarks", "low-capability");
}

async function copyFixture(src, dst) {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    if (EXCLUDED_FIXTURE_DIRS.has(ent.name)) continue;
    const s = join(src, ent.name);
    const d = join(dst, ent.name);
    if (ent.isDirectory()) {
      await copyFixture(s, d);
    } else if (ent.isFile()) {
      await copyFile(s, d);
    }
  }
}

function runSync(cwd, command, args = [], env = {}) {
  const res = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (res.error) {
    return {
      code: 1,
      stdout: res.stdout || "",
      stderr: res.stderr || String(res.error),
    };
  }
  return {
    code: res.status ?? 1,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

function runShell(cwd, command, env = {}) {
  const res = spawnSync(command, [], {
    cwd,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    code: res.status ?? 1,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

function runCodePactCli(cwd, args, env = {}) {
  const cliPath = resolve(repoRoot, "dist", "cli.js");
  if (!existsSync(cliPath)) {
    throw new Error("code-pact CLI not built; run `pnpm build`");
  }
  return runSync(cwd, process.execPath, [cliPath, ...args], env);
}

async function initGitWorkspace(workspace) {
  const gitEnv = {
    GIT_AUTHOR_NAME: "bench",
    GIT_AUTHOR_EMAIL: "bench@example.com",
    GIT_COMMITTER_NAME: "bench",
    GIT_COMMITTER_EMAIL: "bench@example.com",
  };
  let step = runSync(workspace, "git", ["init", "-q"], gitEnv);
  if (step.code !== 0) throw new Error(`git init failed: ${step.stderr}`);
  step = runSync(
    workspace,
    "git",
    ["config", "user.email", "bench@example.com"],
    gitEnv,
  );
  if (step.code !== 0)
    throw new Error(`git config user.email failed: ${step.stderr}`);
  step = runSync(workspace, "git", ["config", "user.name", "bench"], gitEnv);
  if (step.code !== 0)
    throw new Error(`git config user.name failed: ${step.stderr}`);
  step = runSync(workspace, "git", ["add", "."], gitEnv);
  if (step.code !== 0) throw new Error(`git add failed: ${step.stderr}`);
  const commit = runSync(
    workspace,
    "git",
    ["commit", "-q", "-m", "base"],
    gitEnv,
  );
  if (commit.code !== 0) {
    const empty = runSync(
      workspace,
      "git",
      ["diff", "--cached", "--quiet"],
      gitEnv,
    );
    if (empty.code !== 0) {
      throw new Error(`git commit failed: ${commit.stderr}`);
    }
  }
}

function gitChangedPaths(workspace) {
  const res = runSync(workspace, "git", [
    "diff",
    "--no-color",
    "--name-only",
    "HEAD",
  ]);
  if (res.code !== 0) return [];
  return res.stdout
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);
}

function sourceChangedPaths(changedPaths) {
  return changedPaths.filter(p => {
    const first = p.split("/")[0];
    return !HIDDEN_SOURCE_DIRS.has(first) && !p.startsWith("rounds/");
  });
}

function computeScopeViolations(changedPaths, allowedWrites) {
  const violations = [];
  for (const p of changedPaths) {
    const allowed = allowedWrites.some(aw => {
      if (p === aw) return true;
      // allow a directory prefix if allowed write ends with /
      if (aw.endsWith("/") && p.startsWith(aw)) return true;
      return false;
    });
    if (!allowed) violations.push(p);
  }
  return violations;
}

function computeVerificationResults(commands, workspace) {
  const results = [];
  let overallExit = 0;
  for (const command of commands) {
    const r = runShell(workspace, command);
    results.push({
      command,
      exit_code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
    });
    if (overallExit === 0 && r.code !== 0) overallExit = r.code;
  }
  return { overallExit, results };
}

function normalizeForFingerprint(str) {
  return str
    .replace(/"elapsed_ms":\d+/g, '"elapsed_ms":0')
    .replace(/"duration_ms":\d+(?:\.\d+)?/g, '"duration_ms":0')
    .replace(/\(\d+(?:\.\d+)?ms\)/g, "(Xms)")
    .replace(/ℹ duration_ms \d+(?:\.\d+)?/g, "ℹ duration_ms X");
}

function computeFailureFingerprint(verificationResults) {
  const key = verificationResults.map(r => ({
    command: r.command,
    exit_code: r.exit_code,
    stdout_tail: normalizeForFingerprint(r.stdout).slice(-2048),
    stderr_tail: normalizeForFingerprint(r.stderr).slice(-2048),
  }));
  return sha256(canonicalJson(key));
}

function boundedOutput(verificationResults, maxBytes) {
  const combined = verificationResults
    .map(r => `${r.command}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
    .join("\n---\n");
  if (byteLength(combined) <= maxBytes) return combined;
  const buf = Buffer.from(combined, "utf8");
  const tail = buf.subarray(buf.length - maxBytes).toString("utf8");
  // drop broken leading UTF-8 continuation byte
  let start = 0;
  while (
    start < tail.length &&
    (tail.charCodeAt(start) & 0b1100_0000) === 0b1000_0000
  ) {
    start++;
  }
  return tail.slice(start);
}

async function loadWorkspaceTaskReads(workspace, taskId) {
  try {
    const roadmapPath = join(workspace, "design", "roadmap.yaml");
    const roadmap = parseYaml(await readFile(roadmapPath, "utf8"));
    const phasePathRel = roadmap.phases?.[0]?.path;
    if (!phasePathRel) return 0;
    const phasePath = join(workspace, phasePathRel);
    const phase = parseYaml(await readFile(phasePath, "utf8"));
    const task = phase.tasks?.find(t => t.id === taskId);
    return Array.isArray(task?.reads) ? task.reads.length : 0;
  } catch {
    return 0;
  }
}

async function doPrepare({
  corpus,
  caseObj,
  variant,
  executorId,
  replicate,
  outputRoot,
  stage = null,
}) {
  if (!["baseline", "code_pact"].includes(variant)) {
    throw new Error(`invalid variant: ${variant}`);
  }
  if (replicate < 1) throw new Error("replicate must be >= 1");

  const fixturePath = resolve(repoRoot, caseObj.fixture);
  if (!existsSync(fixturePath))
    throw new Error(`fixture missing: ${caseObj.fixture}`);

  const fixDigest = await fixtureDigest(fixturePath);
  const contractDigest = taskContractDigest(corpus.corpus_version, caseObj);
  const runId = computeRunId(
    corpus.corpus_version,
    caseObj.id,
    variant,
    executorId,
    replicate,
    fixDigest,
    contractDigest,
  );

  const runDir = resolve(outputRoot, runId);
  const workspacePath = resolve(runDir, "workspace");
  const roundsPath = resolve(runDir, "rounds");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(roundsPath, { recursive: true });

  await copyFixture(fixturePath, workspacePath);
  await initGitWorkspace(workspacePath);

  let codePactPrepare = null;
  let codePactRunbook = null;
  let contextRetrievalCount = 0;

  if (variant === "code_pact") {
    const prepareRes = runCodePactCli(workspacePath, [
      "task",
      "prepare",
      caseObj.task_id,
      "--agent",
      "generic",
      "--json",
    ]);
    if (prepareRes.code !== 0) {
      throw new Error(
        `code-pact task prepare failed: ${prepareRes.stderr || prepareRes.stdout}`,
      );
    }
    codePactPrepare = JSON.parse(
      prepareRes.stdout.trim().split("\n").pop() || "{}",
    );

    const runbookRes = runCodePactCli(workspacePath, [
      "task",
      "runbook",
      caseObj.task_id,
      "--json",
    ]);
    if (runbookRes.code !== 0) {
      throw new Error(
        `code-pact task runbook failed: ${runbookRes.stderr || runbookRes.stdout}`,
      );
    }
    codePactRunbook = JSON.parse(
      runbookRes.stdout.trim().split("\n").pop() || "{}",
    );

    contextRetrievalCount = await loadWorkspaceTaskReads(
      workspacePath,
      caseObj.task_id,
    );

    await writeJson(join(runDir, "code-pact-prepare.json"), codePactPrepare);
    await writeJson(join(runDir, "code-pact-runbook.json"), codePactRunbook);
  }

  const instructionPath = resolve(runDir, "instruction.md");
  await writeFile(
    instructionPath,
    buildInstruction(caseObj, variant, corpus, codePactPrepare),
    "utf8",
  );

  const manifest = {
    schema_version: 1,
    run_id: runId,
    corpus_version: corpus.corpus_version,
    case_id: caseObj.id,
    variant,
    executor_id: executorId,
    replicate,
    fixture_digest: fixDigest,
    task_contract_digest: contractDigest,
    max_rounds: corpus.max_rounds,
    workspace_path: workspacePath,
    rounds_path: roundsPath,
    created_at: new Date().toISOString(),
    instruction_path: instructionPath,
    ...(stage ? { stage } : {}),
    ...(contextRetrievalCount > 0
      ? { context_retrieval_count: contextRetrievalCount }
      : {}),
  };

  await writeJson(join(runDir, "run-manifest.json"), manifest);
  return { ok: true, run_id: runId, run_dir: runDir };
}

function buildInstruction(caseObj, variant, corpus, codePactPrepare) {
  const lines = [
    `# Benchmark Task: ${caseObj.id} (${variant})`,
    "",
    "## Objective",
    caseObj.expected_outcome === "expected_stop_success"
      ? "Stop without source changes."
      : `Implement the change described in the fixture for case "${caseObj.id}".`,
    "",
    "## Allowed writes",
    ...caseObj.allowed_writes.map(w => `- ${w}`),
    "",
    "## Verification commands",
    ...caseObj.verification.map(c => `- \`${c}\``),
    "",
    "## Maximum rounds",
    `${corpus.max_rounds}`,
    "",
    "## Expected outcome",
    `- ${caseObj.expected_outcome}`,
    "",
    "## Decision state",
    caseObj.requires_explicit_stop
      ? "- An unresolved decision exists. Do not implement source changes; stop and report."
      : "- No unresolved decision.",
  ];

  if (variant === "code_pact" && codePactPrepare?.ok && codePactPrepare.data) {
    const d = codePactPrepare.data;
    lines.push(
      "",
      "## Code Pact guidance",
      `- task_id: ${d.task_id || caseObj.task_id}`,
      `- phase_id: ${d.phase_id || ""}`,
      `- next_action: ${d.next_action?.type || ""}`,
      `- message: ${d.next_action?.message || ""}`,
      `- context_pack_bytes: ${d.context_pack_bytes || 0}`,
    );
    if (d.commands) {
      lines.push("", "### Code Pact commands");
      for (const [k, v] of Object.entries(d.commands)) {
        lines.push(`- ${k}: \`${v}\``);
      }
    }
  }

  lines.push(
    "",
    "## Failure feedback",
    "If verification fails, the harness will provide a bounded failure fingerprint and output excerpt. " +
      "Use only the allowed writes and do not exceed the maximum round count.",
  );

  return lines.join("\n") + "\n";
}

async function loadRoundResults(roundsPath) {
  const results = [];
  if (!existsSync(roundsPath)) return results;
  const files = await readdir(roundsPath).catch(() => []);
  for (const f of files) {
    const m = f.match(/^round-(\d+)\.json$/);
    if (!m) continue;
    const r = await readJson(join(roundsPath, f));
    results[Number(m[1]) - 1] = r;
  }
  return results;
}

function isSourcePath(p) {
  const first = p.split("/")[0];
  return !HIDDEN_SOURCE_DIRS.has(first) && !p.startsWith("rounds/");
}

async function doEvaluate({ manifest, round }) {
  if (round < 1) throw new Error("round must be >= 1");
  if (round > manifest.max_rounds) {
    const result = {
      schema_version: 1,
      run_id: manifest.run_id,
      case_id: manifest.case_id,
      variant: manifest.variant,
      executor_id: manifest.executor_id,
      replicate: manifest.replicate,
      status: "stop_max_rounds",
      completed_rounds: round - 1,
      first_pass_success: false,
      repair_rounds: round - 1,
      scope_violation_count: 0,
      same_fingerprint_repeat_count: 0,
      exit_code: null,
      failure_fingerprint: null,
      bounded_output: null,
      changed_paths: [],
      scope_violations: [],
      verification_command_results: [],
      next_action: null,
      context_retrieval_count: manifest.context_retrieval_count || 0,
      code_pact_stdout_bytes: 0,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      billed_amount: null,
      currency: null,
      manual_intervention_count: 0,
    };
    await writeJson(join(manifest.rounds_path, `round-${round}.json`), result);
    await writeJson(join(dirname(manifest.rounds_path), "result.json"), result);
    return { ok: true, result };
  }

  const corpus = await loadCorpus();
  const caseObj = corpus.cases.find(c => c.id === manifest.case_id);
  if (!caseObj) throw new Error(`case not found: ${manifest.case_id}`);

  let verificationOverall = 0;
  let verificationResults = [];
  let codePactStdoutBytes = 0;
  let nextAction = null;
  let failureKind = null;

  if (manifest.variant === "baseline") {
    const v = computeVerificationResults(
      caseObj.verification,
      manifest.workspace_path,
    );
    verificationOverall = v.overallExit;
    verificationResults = v.results;
  } else {
    const res = runCodePactCli(manifest.workspace_path, [
      "task",
      "complete",
      caseObj.task_id,
      "--agent",
      "generic",
      "--json",
      "--detail",
      "agent",
    ]);
    codePactStdoutBytes = byteLength(res.stdout);
    let envelope;
    try {
      envelope = JSON.parse(res.stdout.trim().split("\n").pop() || "{}");
    } catch {
      envelope = {
        ok: false,
        error: { code: "PARSE_ERROR", message: res.stdout },
      };
    }

    if (envelope.ok) {
      verificationOverall = 0;
      const projection = envelope.data?.verify || { ok: true, checks: [] };
      verificationResults = [
        {
          command: "code-pact task complete",
          exit_code: 0,
          stdout: res.stdout,
          stderr: "",
        },
      ];
      nextAction = envelope.data?.event?.status || "done";
    } else {
      verificationOverall = 1;
      const projection = envelope.data?.verify || { ok: false, checks: [] };
      verificationResults = [
        {
          command: "code-pact task complete",
          exit_code: envelope.error?.code === "VERIFICATION_FAILED" ? 1 : 2,
          stdout: res.stdout,
          stderr: res.stderr,
        },
      ];
      const capsule = envelope.data?.failure;
      if (capsule) {
        failureKind = capsule.kind;
        if (capsule.fingerprint) {
          verificationResults[0].fingerprint = capsule.fingerprint;
        }
      }
      nextAction = envelope.error?.code || "verification_failed";
    }
  }

  const changedPaths = sourceChangedPaths(
    gitChangedPaths(manifest.workspace_path),
  );
  const scopeViolations = computeScopeViolations(
    changedPaths,
    caseObj.allowed_writes,
  );

  // A Code Pact run that correctly stops before implementation when the case
  // requires an explicit stop (unresolved decision) should be recorded as
  // expected_stop_success rather than verification_failed.
  if (
    manifest.variant === "code_pact" &&
    caseObj.expected_outcome === "expected_stop_success" &&
    failureKind === "decision_required" &&
    changedPaths.length === 0 &&
    scopeViolations.length === 0
  ) {
    verificationOverall = 0;
    nextAction = "expected_stop";
    if (verificationResults[0]) verificationResults[0].exit_code = 0;
  }

  // Any change outside the allowed write list is a verification failure.
  if (scopeViolations.length > 0) {
    verificationOverall = 1;
    verificationResults.push({
      command: "scope-check",
      exit_code: 1,
      stdout: "",
      stderr: `scope violations: ${scopeViolations.join(", ")}`,
    });
  }

  const failureFingerprint = computeFailureFingerprint(verificationResults);
  const bounded =
    verificationOverall !== 0
      ? boundedOutput(
          verificationResults,
          corpus.failure_feedback_max_bytes || 2048,
        )
      : null;

  const prevResults = await loadRoundResults(manifest.rounds_path);
  let status;
  let sameFingerprintRepeatCount = 0;
  let completedRounds = round;
  let repairRounds = 0;
  let firstPassSuccess = false;

  if (verificationOverall === 0) {
    status =
      caseObj.expected_outcome === "expected_stop_success"
        ? "expected_stop_success"
        : "verified_success";
    if (round === 1) firstPassSuccess = true;
    repairRounds = round - 1;
  } else {
    const previousFingerprint = prevResults[round - 2]?.failure_fingerprint;
    if (previousFingerprint && previousFingerprint === failureFingerprint) {
      status = "stop_repeated_failure";
      sameFingerprintRepeatCount =
        (prevResults[round - 2]?.same_fingerprint_repeat_count || 0) + 1;
      completedRounds = round;
      repairRounds = round;
    } else {
      status = "verification_failed";
      completedRounds = round;
      repairRounds = round;
      if (previousFingerprint) {
        sameFingerprintRepeatCount =
          prevResults[round - 2]?.same_fingerprint_repeat_count || 0;
      }
    }
  }

  const result = {
    schema_version: 1,
    run_id: manifest.run_id,
    case_id: manifest.case_id,
    variant: manifest.variant,
    executor_id: manifest.executor_id,
    replicate: manifest.replicate,
    status,
    completed_rounds: completedRounds,
    first_pass_success: firstPassSuccess,
    repair_rounds: repairRounds,
    scope_violation_count: scopeViolations.length,
    same_fingerprint_repeat_count: sameFingerprintRepeatCount,
    exit_code: verificationOverall,
    failure_fingerprint: failureFingerprint,
    bounded_output: bounded,
    changed_paths: changedPaths,
    scope_violations: scopeViolations,
    verification_command_results: verificationResults,
    next_action: nextAction,
    context_retrieval_count: manifest.context_retrieval_count || 0,
    code_pact_stdout_bytes: codePactStdoutBytes,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    billed_amount: null,
    currency: null,
    manual_intervention_count: 0,
  };

  await writeJson(join(manifest.rounds_path, `round-${round}.json`), result);
  await writeJson(join(dirname(manifest.rounds_path), "result.json"), result);
  return { ok: true, result };
}

async function doFinalize({ manifest, telemetryPath }) {
  const telemetry = await readJson(telemetryPath);
  if (telemetry.schema_version !== 1)
    throw new Error("telemetry schema_version must be 1");
  if (
    telemetry.manual_intervention_count &&
    telemetry.manual_intervention_count > 0
  ) {
    throw new Error(
      "manual_intervention_count > 0; run is excluded from comparison",
    );
  }
  const resultPath = join(dirname(manifest.rounds_path), "result.json");
  const result = existsSync(resultPath) ? await readJson(resultPath) : {};
  const updated = {
    ...result,
    input_tokens: telemetry.input_tokens ?? null,
    output_tokens: telemetry.output_tokens ?? null,
    total_tokens:
      (telemetry.input_tokens ?? 0) + (telemetry.output_tokens ?? 0) || null,
    billed_amount: telemetry.billed_amount ?? null,
    currency: telemetry.currency ?? null,
    manual_intervention_count: telemetry.manual_intervention_count ?? 0,
  };
  if (
    updated.total_tokens !== null &&
    (updated.input_tokens === null || updated.output_tokens === null)
  ) {
    updated.total_tokens = null;
  }
  await writeJson(resultPath, updated);
  return { ok: true, result: updated };
}

function isResultValid(result) {
  const required = [
    "schema_version",
    "run_id",
    "case_id",
    "variant",
    "executor_id",
    "replicate",
    "status",
    "completed_rounds",
    "changed_paths",
    "scope_violations",
    "verification_command_results",
    "context_retrieval_count",
    "code_pact_stdout_bytes",
  ];
  for (const key of required) {
    if (!(key in result)) return { ok: false, error: `missing field: ${key}` };
  }
  if (result.schema_version !== 1)
    return { ok: false, error: "schema_version must be 1" };
  if (!["baseline", "code_pact"].includes(result.variant)) {
    return { ok: false, error: "variant must be baseline or code_pact" };
  }
  if (result.input_tokens !== null && result.input_tokens < 0) {
    return { ok: false, error: "input_tokens cannot be negative" };
  }
  if (result.output_tokens !== null && result.output_tokens < 0) {
    return { ok: false, error: "output_tokens cannot be negative" };
  }
  return { ok: true };
}

async function doValidateResult({ file }) {
  const result = await readJson(file);
  const valid = isResultValid(result);
  if (!valid.ok)
    return {
      ok: false,
      error: { code: "VALIDATION_FAILED", message: valid.error },
    };
  return { ok: true, result };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function rate(count, total) {
  return total > 0 ? count / total : null;
}

function tokenEfficiencyConclusion(baselineMedian, codePactMedian) {
  if (baselineMedian === null || codePactMedian === null)
    return "insufficient token evidence";
  if (baselineMedian === 0) return "baseline median is zero";
  const ratio = codePactMedian / baselineMedian;
  if (ratio <= 0.9) return "code_pact median total tokens at least 10% lower";
  return `code_pact median total tokens is ${(ratio * 100).toFixed(1)}% of baseline`;
}

async function doScore({ resultsRoot }) {
  const runs = [];
  const entries = await readdir(resultsRoot, { withFileTypes: true }).catch(
    () => [],
  );
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const runDir = join(resultsRoot, ent.name);
    const manifestPath = join(runDir, "run-manifest.json");
    const resultPath = join(runDir, "result.json");
    if (!existsSync(manifestPath) || !existsSync(resultPath)) continue;
    try {
      const manifest = await readJson(manifestPath);
      const result = await readJson(resultPath);
      const valid = isResultValid(result);
      if (!valid.ok) continue;
      runs.push({ manifest, result });
    } catch {
      // skip malformed run directories
    }
  }

  // pair baseline and code_pact runs
  const pairMap = new Map();
  const notes = [];
  for (const run of runs) {
    const m = run.manifest;
    const r = run.result;
    if (r.manual_intervention_count && r.manual_intervention_count > 0) {
      notes.push(`excluded ${m.variant} run ${m.run_id}: manual intervention`);
      continue;
    }
    const key = [
      m.case_id,
      m.executor_id,
      m.replicate,
      m.fixture_digest,
      m.task_contract_digest,
      m.max_rounds,
      m.context_retrieval_count || 0,
    ].join("\0");
    const pair = pairMap.get(key) || { baseline: null, code_pact: null };
    if (pair[m.variant]) {
      notes.push(
        `duplicate ${m.variant} run for pairing key; skipping ${m.run_id}`,
      );
      continue;
    }
    pair[m.variant] = run;
    pairMap.set(key, pair);
  }

  const pairs = [];
  for (const [key, pair] of pairMap) {
    if (pair.baseline && pair.code_pact) {
      pairs.push(pair);
    } else {
      const missing = pair.baseline ? "code_pact" : "baseline";
      notes.push(`unpaired ${missing} run for key`);
    }
  }

  const byExecutor = new Map();
  const byCase = new Map();
  let totalBaselineRuns = 0;
  let totalCodePactRuns = 0;
  const totals = {
    baseline_verified_success_count: 0,
    code_pact_verified_success_count: 0,
    baseline_expected_stop_success_count: 0,
    code_pact_expected_stop_success_count: 0,
    baseline_scope_violation_count: 0,
    code_pact_scope_violation_count: 0,
    baseline_first_pass_success_count: 0,
    code_pact_first_pass_success_count: 0,
    baseline_completed_tokens: [],
    code_pact_completed_tokens: [],
  };

  for (const pair of pairs) {
    const b = pair.baseline.result;
    const c = pair.code_pact.result;
    const executorId = pair.baseline.manifest.executor_id;
    if (!byExecutor.has(executorId)) {
      byExecutor.set(executorId, {
        executor_id: executorId,
        baseline_runs: 0,
        code_pact_runs: 0,
        baseline_verified_success: 0,
        code_pact_verified_success: 0,
        baseline_expected_stop_success: 0,
        code_pact_expected_stop_success: 0,
        baseline_first_pass: 0,
        code_pact_first_pass: 0,
        baseline_repair_rounds: [],
        code_pact_repair_rounds: [],
        baseline_scope_violations: 0,
        code_pact_scope_violations: 0,
        baseline_completed_tokens: [],
        code_pact_completed_tokens: [],
      });
    }
    const e = byExecutor.get(executorId);
    e.baseline_runs++;
    e.code_pact_runs++;
    totalBaselineRuns++;
    totalCodePactRuns++;

    if (b.status === "verified_success") e.baseline_verified_success++;
    if (c.status === "verified_success") e.code_pact_verified_success++;
    if (b.status === "expected_stop_success")
      e.baseline_expected_stop_success++;
    if (c.status === "expected_stop_success")
      e.code_pact_expected_stop_success++;
    if (b.first_pass_success) e.baseline_first_pass++;
    if (c.first_pass_success) e.code_pact_first_pass++;

    e.baseline_repair_rounds.push(b.repair_rounds);
    e.code_pact_repair_rounds.push(c.repair_rounds);

    if (b.scope_violation_count > 0) e.baseline_scope_violations++;
    if (c.scope_violation_count > 0) e.code_pact_scope_violations++;

    if (
      (b.status === "verified_success" ||
        b.status === "expected_stop_success") &&
      b.total_tokens !== null
    ) {
      e.baseline_completed_tokens.push(b.total_tokens);
      totals.baseline_completed_tokens.push(b.total_tokens);
    }
    if (
      (c.status === "verified_success" ||
        c.status === "expected_stop_success") &&
      c.total_tokens !== null
    ) {
      e.code_pact_completed_tokens.push(c.total_tokens);
      totals.code_pact_completed_tokens.push(c.total_tokens);
    }

    const caseId = pair.baseline.manifest.case_id;
    if (!byCase.has(caseId)) {
      byCase.set(caseId, {
        case_id: caseId,
        paired_count: 0,
        baseline_verified_success: 0,
        code_pact_verified_success: 0,
      });
    }
    const cs = byCase.get(caseId);
    cs.paired_count++;
    if (b.status === "verified_success") cs.baseline_verified_success++;
    if (c.status === "verified_success") cs.code_pact_verified_success++;

    // totals
    if (b.status === "verified_success")
      totals.baseline_verified_success_count++;
    if (c.status === "verified_success")
      totals.code_pact_verified_success_count++;
    if (b.status === "expected_stop_success")
      totals.baseline_expected_stop_success_count++;
    if (c.status === "expected_stop_success")
      totals.code_pact_expected_stop_success_count++;
    if (b.scope_violation_count > 0) totals.baseline_scope_violation_count++;
    if (c.scope_violation_count > 0) totals.code_pact_scope_violation_count++;
    if (b.first_pass_success) totals.baseline_first_pass_success_count++;
    if (c.first_pass_success) totals.code_pact_first_pass_success_count++;
  }

  const executorRows = [];
  for (const e of byExecutor.values()) {
    const baseMedTokens = median(e.baseline_completed_tokens);
    const cpMedTokens = median(e.code_pact_completed_tokens);
    executorRows.push({
      executor_id: e.executor_id,
      baseline_runs: e.baseline_runs,
      code_pact_runs: e.code_pact_runs,
      baseline_verified_success_rate: rate(
        e.baseline_verified_success,
        e.baseline_runs,
      ),
      code_pact_verified_success_rate: rate(
        e.code_pact_verified_success,
        e.code_pact_runs,
      ),
      baseline_expected_stop_success_rate: rate(
        e.baseline_expected_stop_success,
        e.baseline_runs,
      ),
      code_pact_expected_stop_success_rate: rate(
        e.code_pact_expected_stop_success,
        e.code_pact_runs,
      ),
      baseline_first_pass_success_rate: rate(
        e.baseline_first_pass,
        e.baseline_runs,
      ),
      code_pact_first_pass_success_rate: rate(
        e.code_pact_first_pass,
        e.code_pact_runs,
      ),
      baseline_repair_rounds_median: median(e.baseline_repair_rounds),
      code_pact_repair_rounds_median: median(e.code_pact_repair_rounds),
      baseline_scope_violation_rate: rate(
        e.baseline_scope_violations,
        e.baseline_runs,
      ),
      code_pact_scope_violation_rate: rate(
        e.code_pact_scope_violations,
        e.code_pact_runs,
      ),
      baseline_median_total_tokens_per_completed_task: baseMedTokens,
      code_pact_median_total_tokens_per_completed_task: cpMedTokens,
      token_efficiency_conclusion: tokenEfficiencyConclusion(
        baseMedTokens,
        cpMedTokens,
      ),
    });
  }

  const caseRows = [];
  for (const cs of byCase.values()) {
    caseRows.push({
      case_id: cs.case_id,
      paired_count: cs.paired_count,
      baseline_verified_success_rate: rate(
        cs.baseline_verified_success,
        cs.paired_count,
      ),
      code_pact_verified_success_rate: rate(
        cs.code_pact_verified_success,
        cs.paired_count,
      ),
    });
  }

  const totalBaseMed = median(totals.baseline_completed_tokens);
  const totalCpMed = median(totals.code_pact_completed_tokens);
  const summary = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    corpus_version: (await loadCorpus()).corpus_version,
    max_rounds: 3,
    paired_count: pairs.length,
    by_executor: executorRows,
    by_case: caseRows,
    totals: {
      baseline_runs: totalBaselineRuns,
      code_pact_runs: totalCodePactRuns,
      baseline_verified_success_count: totals.baseline_verified_success_count,
      code_pact_verified_success_count: totals.code_pact_verified_success_count,
      baseline_expected_stop_success_count:
        totals.baseline_expected_stop_success_count,
      code_pact_expected_stop_success_count:
        totals.code_pact_expected_stop_success_count,
      baseline_scope_violation_count: totals.baseline_scope_violation_count,
      code_pact_scope_violation_count: totals.code_pact_scope_violation_count,
      baseline_first_pass_success_count:
        totals.baseline_first_pass_success_count,
      code_pact_first_pass_success_count:
        totals.code_pact_first_pass_success_count,
      baseline_median_total_tokens_per_completed_task: totalBaseMed,
      code_pact_median_total_tokens_per_completed_task: totalCpMed,
      token_efficiency_conclusion: tokenEfficiencyConclusion(
        totalBaseMed,
        totalCpMed,
      ),
    },
    notes,
  };

  const outPath = join(resultsRoot, "score-summary.json");
  await writeJson(outPath, summary);
  return { ok: true, summary_path: outPath, summary };
}

async function doPreparePilot({ executors, replicates, outputRoot }) {
  const corpus = await loadCorpus();
  const issues = validateCorpus(corpus, repoRoot);
  if (issues.length) throw new Error(`corpus invalid: ${issues.join("; ")}`);

  const plan = {
    schema_version: 1,
    corpus_version: corpus.corpus_version,
    stages: [],
  };

  const manifests = [];
  for (let i = 0; i < executors.length; i++) {
    const executorId = executors[i];
    const stage = i === 0 ? "a" : "b";
    const stageDir = join(outputRoot, `stage-${stage}`, executorId);
    const stageEntry = { executor_id: executorId, stage, runs: [] };

    for (const caseObj of corpus.cases) {
      for (const variant of ["baseline", "code_pact"]) {
        for (let r = 1; r <= replicates; r++) {
          const info = await doPrepare({
            corpus,
            caseObj,
            variant,
            executorId,
            replicate: r,
            outputRoot: stageDir,
            stage,
          });
          manifests.push(info);
          stageEntry.runs.push({
            case_id: caseObj.id,
            variant,
            replicate: r,
            run_id: info.run_id,
          });
        }
      }
    }
    plan.stages.push(stageEntry);
  }

  await writeJson(join(outputRoot, "pilot-plan.json"), plan);
  return {
    ok: true,
    manifest_count: manifests.length,
    plan_path: join(outputRoot, "pilot-plan.json"),
  };
}

async function handleCorpusCheck(args) {
  const corpus = await loadCorpus();
  const issues = validateCorpus(corpus, repoRoot);
  const data = { valid: issues.length === 0, issues };
  return ok(data);
}

async function handlePrepare(args) {
  const corpus = await loadCorpus();
  const issues = validateCorpus(corpus, repoRoot);
  if (issues.length) {
    return fail("CORPUS_INVALID", `corpus invalid: ${issues.join("; ")}`);
  }
  const caseObj = findCase(corpus, args.values.case);
  const info = await doPrepare({
    corpus,
    caseObj,
    variant: args.values.variant,
    executorId: args.values["executor-id"],
    replicate: Number(args.values.replicate),
    outputRoot: resolveOutputRoot(args.values.output),
  });
  return ok(info);
}

async function handleEvaluate(args) {
  const manifestPath = resolve(args.values.run, "run-manifest.json");
  if (!existsSync(manifestPath)) {
    return fail("MANIFEST_NOT_FOUND", `manifest not found: ${manifestPath}`);
  }
  const manifest = await readJson(manifestPath);
  const info = await doEvaluate({ manifest, round: Number(args.values.round) });
  return ok(info);
}

async function handleFinalize(args) {
  const manifestPath = resolve(args.values.run, "run-manifest.json");
  if (!existsSync(manifestPath)) {
    return fail("MANIFEST_NOT_FOUND", `manifest not found: ${manifestPath}`);
  }
  const manifest = await readJson(manifestPath);
  const info = await doFinalize({
    manifest,
    telemetryPath: resolve(args.values.telemetry),
  });
  return ok(info);
}

async function handleValidateResult(args) {
  const info = await doValidateResult({ file: resolve(args.values.file) });
  return info.ok ? ok(info.result) : fail("VALIDATION_FAILED", info.error);
}

async function handleScore(args) {
  const info = await doScore({ resultsRoot: resolve(args.values.results) });
  return ok(info);
}

async function handlePreparePilot(args) {
  const executors = args.values.executors
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  if (executors.length === 0) return fail("CONFIG_ERROR", "executors required");
  const replicates = Number(args.values.replicates);
  if (replicates < 1) return fail("CONFIG_ERROR", "replicates must be >= 1");
  const info = await doPreparePilot({
    executors,
    replicates,
    outputRoot: resolveOutputRoot(args.values.output),
  });
  return ok(info);
}

function usage() {
  return `Usage: benchmark-low-capability.mjs <subcommand> [options]

Subcommands:
  corpus-check                              Validate corpus and fixtures
  prepare --case <id> --variant <v> --executor-id <id> --replicate <n> [--output <dir>]
  evaluate --run <dir> --round <n>
  finalize --run <dir> --telemetry <file>
  validate-result --file <path>
  score --results <dir>
  prepare-pilot --executors E1,E2 --replicates <n> [--output <dir>]

Global:
  --json    Emit JSON envelopes
`;
}

function parseCommand(argv) {
  const known = [
    "case",
    "variant",
    "executor-id",
    "replicate",
    "output",
    "run",
    "round",
    "telemetry",
    "file",
    "results",
    "executors",
    "json",
  ];
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      case: { type: "string" },
      variant: { type: "string" },
      "executor-id": { type: "string" },
      replicate: { type: "string" },
      output: { type: "string" },
      run: { type: "string" },
      round: { type: "string" },
      telemetry: { type: "string" },
      file: { type: "string" },
      results: { type: "string" },
      executors: { type: "string" },
      json: { type: "boolean" },
    },
    strict: false,
  });
}

async function main(argv) {
  const args = parseCommand(argv);
  const subcommand = args.positionals[0];
  const json = args.values.json === true;
  const send = value => {
    if (json) {
      writeSync(1, Buffer.from(jsonOut(value), "utf8"));
    } else if (value.ok) {
      writeSync(
        1,
        Buffer.from(`${JSON.stringify(value.data, null, 2)}\n`, "utf8"),
      );
    } else {
      writeSync(
        2,
        Buffer.from(`${value.error.code}: ${value.error.message}\n`, "utf8"),
      );
    }
    return value.ok ? 0 : 1;
  };

  try {
    let result;
    switch (subcommand) {
      case "corpus-check":
        result = await handleCorpusCheck(args);
        break;
      case "prepare":
        result = await handlePrepare(args);
        break;
      case "evaluate":
        result = await handleEvaluate(args);
        break;
      case "finalize":
        result = await handleFinalize(args);
        break;
      case "validate-result":
        result = await handleValidateResult(args);
        break;
      case "score":
        result = await handleScore(args);
        break;
      case "prepare-pilot":
        result = await handlePreparePilot(args);
        break;
      case undefined:
      case "help":
      case "--help":
        writeSync(1, Buffer.from(usage(), "utf8"));
        return 0;
      default:
        result = fail(
          "UNKNOWN_SUBCOMMAND",
          `unknown subcommand: ${subcommand}`,
        );
    }
    return send(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return send(fail("ERROR", message));
  }
}

main(process.argv.slice(2)).then(code => {
  process.exitCode = code;
});
