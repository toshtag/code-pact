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
  realpath,
} from "node:fs/promises";
import { existsSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  dirname,
  join,
  resolve,
  relative,
  isAbsolute,
  normalize,
} from "node:path";
import { parse as parseYaml } from "yaml";

const CORPUSS_REL = "benchmarks/low-capability/corpus.json";
const EXCLUDED_FIXTURE_DIRS = new Set([
  ".git",
  "node_modules",
  ".local",
  ".context",
  ".DS_Store",
]);
const HIDDEN_SOURCE_DIRS = new Set([
  ".git",
  "node_modules",
  ".local",
  ".DS_Store",
]);
const BENCHMARK_GENERATED_PREFIXES = [
  ".context/",
  ".code-pact/state/events/",
  ".code-pact/cache/",
];
const TOOL_PERMISSION_CLASS = "workspace-read-write-shell";
const VALID_ACTIONS = new Set([
  "implemented",
  "stopped_decision",
  "failed_to_execute",
]);
const EXECUTOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TERMINAL_STATUSES = new Set([
  "verified_success",
  "expected_stop_success",
  "stop_repeated_failure",
  "stop_max_rounds",
  "stop_manual_intervention",
  "invalid",
]);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function canonicalJson(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(v => canonicalJson(v)).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter(k => value[k] !== undefined)
    .sort();
  const pairs = keys.map(
    k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`,
  );
  return `{${pairs.join(",")}}`;
}

function sha256(input) {
  const data =
    typeof input === "string"
      ? input
      : Buffer.from(canonicalJson(input), "utf8");
  return createHash("sha256").update(data).digest("hex");
}

async function fileSha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
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

function validateExecutorId(id) {
  if (!EXECUTOR_ID_RE.test(id)) {
    throw new Error(
      `invalid executor_id ${id}: must match ${EXECUTOR_ID_RE.source}`,
    );
  }
}

function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}

function isJson(args) {
  return args.includes("--json") || args.values?.json === true;
}

async function safeRealpath(p) {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

async function assertContained(parent, child, label) {
  const parentReal = await safeRealpath(parent);
  const childReal = await safeRealpath(child);
  const rel = relative(parentReal, childReal);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} is not contained within run directory`);
  }
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
      } else if (ent.isFile() || ent.isSymbolicLink()) {
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
      case_id: caseObj.id,
      objective: caseObj.objective,
      task_id: caseObj.task_id,
      expected_outcome: caseObj.expected_outcome,
      allowed_writes: caseObj.allowed_writes,
      verification: caseObj.verification,
      requires_explicit_stop: caseObj.requires_explicit_stop,
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
  return readJson(resolve(repoRoot, CORPUSS_REL));
}

async function runFixtureVerification(fixtureRel, commands) {
  const fixturePath = resolve(repoRoot, fixtureRel);
  let overallExit = 0;
  for (const command of commands) {
    const r = runShell(fixturePath, command);
    if (r.code !== 0) overallExit = r.code || 1;
  }
  return overallExit;
}

async function validateCorpus(corpus) {
  const issues = [];
  if (corpus.schema_version !== 1) issues.push("schema_version must be 1");
  if (
    typeof corpus.corpus_version !== "string" ||
    corpus.corpus_version.length === 0
  ) {
    issues.push("corpus_version must be a non-empty string");
  }
  if (Number(corpus.max_rounds) !== 3) issues.push("max_rounds must be 3");
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
    if (!c.id || typeof c.id !== "string") {
      issues.push("case id missing");
      continue;
    }
    if (ids.has(c.id)) issues.push(`duplicate case id: ${c.id}`);
    else ids.add(c.id);
    if (
      !c.objective ||
      typeof c.objective !== "string" ||
      c.objective.trim().length === 0
    ) {
      issues.push(`${c.id}: objective must be a non-empty string`);
    }
    if (!c.task_id || typeof c.task_id !== "string") {
      issues.push(`${c.id}: task_id missing`);
    } else {
      if (taskIds.has(c.task_id))
        issues.push(`duplicate task_id: ${c.task_id}`);
      taskIds.add(c.task_id);
    }
    if (
      !["verified_success", "expected_stop_success"].includes(
        c.expected_outcome,
      )
    ) {
      issues.push(`${c.id}: unexpected expected_outcome`);
    }
    if (typeof c.requires_explicit_stop !== "boolean") {
      issues.push(`${c.id}: requires_explicit_stop must be a boolean`);
    } else if (
      c.requires_explicit_stop &&
      c.expected_outcome !== "expected_stop_success"
    ) {
      issues.push(
        `${c.id}: requires_explicit_stop requires expected_stop_success`,
      );
    }
    if (!Array.isArray(c.allowed_writes)) {
      issues.push(`${c.id}: allowed_writes must be an array`);
    } else {
      const seen = new Set();
      for (const w of c.allowed_writes) {
        if (typeof w !== "string") {
          issues.push(`${c.id}: allowed_writes must contain strings`);
          continue;
        }
        if (seen.has(w)) issues.push(`${c.id}: duplicate allowed_write ${w}`);
        seen.add(w);
        const norm = normalize(w)
          .replace(/\\/g, "/")
          .replace(/\/{2,}/g, "/")
          .replace(/\/$/, "");
        if (
          isAbsolute(norm) ||
          norm.startsWith("../") ||
          norm.includes("/../") ||
          norm === ".." ||
          norm.split("/").some(s => s === "..") ||
          norm.startsWith("/") ||
          norm.trim() === ""
        ) {
          issues.push(
            `${c.id}: allowed_write must be a relative POSIX path: ${w}`,
          );
        }
      }
    }
    if (!Array.isArray(c.verification) || c.verification.length === 0) {
      issues.push(`${c.id}: verification commands missing`);
    }
    const fixturePath = resolve(repoRoot, c.fixture);
    if (!existsSync(fixturePath)) {
      issues.push(`${c.id}: fixture path missing: ${c.fixture}`);
      continue;
    }
    try {
      await fixtureDigest(fixturePath);
    } catch (e) {
      issues.push(`${c.id}: fixture digest error: ${e.message}`);
      continue;
    }
    try {
      const initialExit = await runFixtureVerification(
        c.fixture,
        c.verification,
      );
      if (c.expected_outcome === "verified_success" && initialExit === 0) {
        issues.push(`${c.id}: verified_success fixture must initially fail`);
      }
      if (c.expected_outcome === "expected_stop_success" && initialExit !== 0) {
        issues.push(
          `${c.id}: expected_stop_success fixture must initially pass`,
        );
      }
      if (c.expected_outcome === "expected_stop_success") {
        const phaseFiles = await readdir(
          resolve(fixturePath, "design", "phases"),
        ).catch(() => []);
        let hasRequiresDecision = false;
        for (const f of phaseFiles) {
          if (!f.endsWith(".yaml")) continue;
          try {
            const yaml = parseYaml(
              await readFile(join(fixturePath, "design", "phases", f), "utf8"),
            );
            if (yaml.requires_decision) hasRequiresDecision = true;
          } catch {}
        }
        if (!hasRequiresDecision) {
          issues.push(
            `${c.id}: expected_stop_success fixture phase must require a decision`,
          );
        }
      }
    } catch (e) {
      issues.push(`${c.id}: initial verification error: ${e.message}`);
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
    } else if (ent.isSymbolicLink()) {
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
  let commit = runSync(
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
  const rev = runSync(workspace, "git", ["rev-parse", "HEAD"], gitEnv);
  if (rev.code !== 0 || !rev.stdout.trim())
    throw new Error("git rev-parse failed");
  return rev.stdout.trim();
}

function gitStatusChangedPaths(workspace) {
  const res = runSync(workspace, "git", [
    "status",
    "--porcelain=1",
    "--untracked-files=all",
  ]);
  if (res.code !== 0) throw new Error(`git status failed: ${res.stderr}`);
  const lines = res.stdout.split("\n").filter(Boolean);
  const paths = [];
  for (const line of lines) {
    const status = line.slice(0, 2);
    const rest = line.slice(3);
    if (status[0] === "R" || status[0] === "C") {
      const arrow = rest.indexOf(" -> ");
      if (arrow !== -1) {
        paths.push(rest.slice(0, arrow), rest.slice(arrow + 4));
      } else {
        paths.push(rest);
      }
    } else {
      paths.push(rest);
    }
  }
  return paths;
}

function isBenchmarkGeneratedPath(p) {
  for (const prefix of BENCHMARK_GENERATED_PREFIXES) {
    if (p === prefix || p.startsWith(prefix)) return true;
  }
  return false;
}

function sourceChangedPaths(changedPaths) {
  return changedPaths.filter(p => {
    const first = p.split("/")[0];
    return !HIDDEN_SOURCE_DIRS.has(first) && !isBenchmarkGeneratedPath(p);
  });
}

function computeScopeViolations(changedPaths, allowedWrites) {
  const violations = [];
  for (const p of changedPaths) {
    const allowed = allowedWrites.some(aw => {
      if (p === aw) return true;
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
    .replace(/\(\d+(?:\.\d+)?(?:ms|µs|us)\)/g, "(Xms)")
    .replace(/ℹ duration_ms \d+(?:\.\d+)?/g, "ℹ duration_ms X")
    .replace(/# duration_ms \d+(?:\.\d+)?/g, "# duration_ms X");
}

function stableFailureSignature(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj.error) {
        return `error:${obj.error.code}:${obj.error.cause_code || ""}:${obj.error.message || ""}`;
      }
      const failure = obj.data?.failure;
      if (failure) {
        return `failure:${failure.kind}:${failure.check}:${failure.command || ""}:${failure.exit_code ?? ""}:${failure.reason || ""}`;
      }
      if (obj.data?.verify?.ok === false) {
        const checks = obj.data.verify.checks
          .filter(c => !c.ok)
          .map(c => `${c.name}:${c.reason}`)
          .join("|");
        return `verify:${checks}`;
      }
    } catch {
      // fall through
    }
  }
  const lines = combined.split("\n");
  const failures = [];
  const seen = new Set();
  const push = s => {
    const normalized = s
      .replace(/\d+(?:\.\d+)?(?:ms|µs|us)/g, "X")
      .replace(/\s+/g, " ")
      .trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      failures.push(normalized);
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("✖ ")) {
      push(line.replace(/\d+(?:\.\d+)?/g, "X"));
    } else if (
      line.startsWith("Error:") ||
      line.startsWith("AssertionError") ||
      line.startsWith("TypeError") ||
      line.startsWith("RangeError")
    ) {
      push(line);
    } else if (line.startsWith("error:")) {
      const rawValue = line.slice("error:".length).trim();
      const value = rawValue.replace(/^['"]|['"]$/g, "").trim();
      if (value) push(`error:${value}`);
    } else if (
      /^test at /.test(line) ||
      /^not ok /.test(line) ||
      /^# fail\b/.test(line)
    ) {
      push(line.replace(/\d+(?:\.\d+)?/g, "X"));
    }
  }
  if (failures.length > 0) {
    failures.sort();
    return failures.join("\n");
  }
  return normalizeForFingerprint(combined).slice(-2048);
}

function computeFailureFingerprint(verificationResults) {
  const key = verificationResults.map(r => ({
    command: r.command,
    exit_code: r.exit_code,
    signature: stableFailureSignature(r.stdout, r.stderr),
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
  let start = 0;
  while (
    start < tail.length &&
    (tail.charCodeAt(start) & 0b1100_0000) === 0b1000_0000
  ) {
    start++;
  }
  return tail.slice(start);
}

function buildTaskContract(
  caseObj,
  corpus,
  variant,
  baseCommit,
  toolPermissionClass,
  runId,
) {
  const lines = [
    `# Task Contract: ${caseObj.id} (${variant})`,
    "",
    `run_id: ${runId}`,
    `corpus_version: ${corpus.corpus_version}`,
    `max_rounds: ${corpus.max_rounds}`,
    `expected_outcome: ${caseObj.expected_outcome}`,
    `requires_explicit_stop: ${caseObj.requires_explicit_stop}`,
    `tool_permission_class: ${toolPermissionClass}`,
    `base_commit: ${baseCommit}`,
    "",
    "## Objective",
    caseObj.objective,
    "",
    "## Allowed writes",
    ...caseObj.allowed_writes.map(w => `- ${w}`),
    "",
    "## Verification commands",
    ...caseObj.verification.map(c => `- ${c}`),
  ];
  return lines.join("\n") + "\n";
}

function buildInstruction(
  caseObj,
  corpus,
  variant,
  codePactPrepare,
  codePactRunbook,
  contextPackContent,
) {
  const lines = [
    `# Benchmark Task: ${caseObj.id} (${variant})`,
    "",
    "## Objective",
    caseObj.objective,
    "",
    "## Allowed writes",
    ...caseObj.allowed_writes.map(w => `- ${w}`),
    "",
    "## Verification commands",
    ...caseObj.verification.map(c => `- ${c}`),
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
        lines.push(`- ${k}: ${v}`);
      }
    }
    if (contextPackContent) {
      lines.push(
        "",
        "### Code Pact context pack",
        "",
        "```",
        contextPackContent,
        "```",
      );
    }
    if (codePactRunbook?.ok && codePactRunbook.data?.next_steps) {
      lines.push("", "### Code Pact runbook");
      for (const step of codePactRunbook.data.next_steps) {
        lines.push(`- ${step.reason || ""}`);
        if (step.command) lines.push(`  command: ${step.command}`);
        if (step.manual_action)
          lines.push(`  manual_action: ${step.manual_action}`);
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

async function generateExecutorInput({
  runDir,
  caseObj,
  corpus,
  variant,
  codePactPrepare,
  codePactRunbook,
  contextPackContent,
  baseCommit,
  toolPermissionClass,
  runId,
  executorId,
  replicate,
}) {
  const dir = join(runDir, "executor-input");
  await mkdir(dir, { recursive: true });
  const taskContract = buildTaskContract(
    caseObj,
    corpus,
    variant,
    baseCommit,
    toolPermissionClass,
    runId,
  );
  const instruction = buildInstruction(
    caseObj,
    corpus,
    variant,
    codePactPrepare,
    codePactRunbook,
    contextPackContent,
  );
  const files = [
    { rel: "task-contract.md", content: taskContract },
    { rel: "instruction.md", content: instruction },
  ];
  if (variant === "code_pact" && codePactPrepare) {
    const cpJson = JSON.stringify(codePactPrepare, null, 2) + "\n";
    files.push({ rel: "code-pact-prepare.json", content: cpJson });
  }
  if (variant === "code_pact" && codePactRunbook) {
    const rbJson = JSON.stringify(codePactRunbook, null, 2) + "\n";
    files.push({ rel: "code-pact-runbook.json", content: rbJson });
  }
  if (variant === "code_pact" && contextPackContent !== undefined) {
    files.push({ rel: "context-pack.md", content: contextPackContent });
  }
  for (const f of files) {
    await writeFile(join(dir, f.rel), f.content, "utf8");
  }
  const fileEntries = files
    .map(f => ({
      path: f.rel,
      sha256: sha256(f.content),
      bytes: Buffer.byteLength(f.content, "utf8"),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const bundle = {
    schema_version: 1,
    files: fileEntries,
    bundle_sha256: sha256(
      canonicalJson(
        fileEntries.map(f => ({
          path: f.path,
          sha256: f.sha256,
          bytes: f.bytes,
        })),
      ),
    ),
  };
  await writeFile(
    join(dir, "input-manifest.json"),
    JSON.stringify(bundle, null, 2) + "\n",
    "utf8",
  );
  return { dir, bundleSha256: bundle.bundle_sha256 };
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
  validateExecutorId(executorId);

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

  await mkdir(outputRoot, { recursive: true });
  const runDir = resolve(outputRoot, runId);
  if (existsSync(runDir)) {
    throw new Error(`RUN_ALREADY_EXISTS: ${runId}`);
  }

  const workspacePath = resolve(runDir, "workspace");
  const roundsPath = resolve(runDir, "rounds");
  const executorInputPath = resolve(runDir, "executor-input");
  await mkdir(runDir);
  await mkdir(workspacePath);
  await mkdir(roundsPath);
  await mkdir(executorInputPath);

  let codePactPrepare = null;
  let codePactRunbook = null;
  let contextPackContent = "";
  let initialCodePactStdoutBytes = 0;

  try {
    await copyFixture(fixturePath, workspacePath);
    const baseCommit = await initGitWorkspace(workspacePath);

    if (variant === "code_pact") {
      const cliPath = resolve(repoRoot, "dist", "cli.js");
      if (!existsSync(cliPath)) {
        throw new Error("code-pact CLI not built; run `pnpm build`");
      }
      const prepareRes = runCodePactCli(workspacePath, [
        "task",
        "prepare",
        caseObj.task_id,
        "--agent",
        "generic",
        "--json",
      ]);
      initialCodePactStdoutBytes += byteLength(prepareRes.stdout);
      if (prepareRes.code !== 0) {
        throw new Error(
          `code-pact task prepare failed: ${prepareRes.stderr || prepareRes.stdout}`,
        );
      }
      codePactPrepare = JSON.parse(
        prepareRes.stdout.trim().split("\n").pop() || "{}",
      );

      const startRes = runCodePactCli(workspacePath, [
        "task",
        "start",
        caseObj.task_id,
        "--agent",
        "generic",
        "--json",
      ]);
      initialCodePactStdoutBytes += byteLength(startRes.stdout);
      if (startRes.code !== 0) {
        throw new Error(
          `code-pact task start failed: ${startRes.stderr || startRes.stdout}`,
        );
      }

      const runbookRes = runCodePactCli(workspacePath, [
        "task",
        "runbook",
        caseObj.task_id,
        "--json",
      ]);
      initialCodePactStdoutBytes += byteLength(runbookRes.stdout);
      if (runbookRes.code !== 0) {
        throw new Error(
          `code-pact task runbook failed: ${runbookRes.stderr || runbookRes.stdout}`,
        );
      }
      codePactRunbook = JSON.parse(
        runbookRes.stdout.trim().split("\n").pop() || "{}",
      );

      if (
        codePactPrepare?.ok &&
        codePactPrepare.data?.context_pack_path &&
        existsSync(codePactPrepare.data.context_pack_path)
      ) {
        contextPackContent = await readFile(
          codePactPrepare.data.context_pack_path,
          "utf8",
        );
      }
    }

    const input = await generateExecutorInput({
      runDir,
      caseObj,
      corpus,
      variant,
      codePactPrepare,
      codePactRunbook,
      contextPackContent,
      baseCommit,
      toolPermissionClass: TOOL_PERMISSION_CLASS,
      runId,
      executorId,
      replicate,
    });

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
      task_contract_sha256: contractDigest,
      max_rounds: corpus.max_rounds,
      base_commit: baseCommit,
      tool_permission_class: TOOL_PERMISSION_CLASS,
      fresh_session_required: true,
      input_bundle_sha256: input.bundleSha256,
      initial_code_pact_stdout_bytes: initialCodePactStdoutBytes,
      workspace_path: workspacePath,
      rounds_path: roundsPath,
      executor_input_path: executorInputPath,
      instruction_path: resolve(runDir, "executor-input", "instruction.md"),
      created_at: new Date().toISOString(),
      ...(stage !== null ? { stage } : {}),
    };

    const identity = {
      schema_version: manifest.schema_version,
      run_id: manifest.run_id,
      corpus_version: manifest.corpus_version,
      case_id: manifest.case_id,
      variant: manifest.variant,
      executor_id: manifest.executor_id,
      replicate: manifest.replicate,
      fixture_digest: manifest.fixture_digest,
      task_contract_digest: manifest.task_contract_digest,
      max_rounds: manifest.max_rounds,
      base_commit: manifest.base_commit,
      tool_permission_class: manifest.tool_permission_class,
      fresh_session_required: manifest.fresh_session_required,
      input_bundle_sha256: manifest.input_bundle_sha256,
      task_contract_sha256: manifest.task_contract_sha256,
    };
    manifest.manifest_sha256 = sha256(canonicalJson(identity));

    await writeJson(join(runDir, "run-manifest.json"), manifest);
    return {
      ok: true,
      run_id: runId,
      run_dir: runDir,
      manifest_path: join(runDir, "run-manifest.json"),
      workspace_path: workspacePath,
      rounds_path: roundsPath,
      executor_input_path: executorInputPath,
      instruction_path: manifest.instruction_path,
    };
  } catch (err) {
    try {
      await rm(runDir, { recursive: true, force: true });
    } catch {}
    throw err;
  }
}

async function loadAndValidateManifest(runDir) {
  const manifestPath = join(runDir, "run-manifest.json");
  if (!existsSync(manifestPath)) throw new Error("manifest not found");
  const manifest = await readJson(manifestPath);
  const corpus = await loadCorpus();
  const caseObj = findCase(corpus, manifest.case_id);
  const fixDigest = await fixtureDigest(resolve(repoRoot, caseObj.fixture));
  const contractDigest = taskContractDigest(manifest.corpus_version, caseObj);
  const expectedRunId = computeRunId(
    manifest.corpus_version,
    caseObj.id,
    manifest.variant,
    manifest.executor_id,
    manifest.replicate,
    fixDigest,
    contractDigest,
  );
  if (manifest.run_id !== expectedRunId) {
    throw new Error(
      `manifest run_id mismatch: expected ${expectedRunId}, got ${manifest.run_id}`,
    );
  }
  await assertContained(runDir, manifest.workspace_path, "workspace_path");
  await assertContained(runDir, manifest.rounds_path, "rounds_path");
  await assertContained(
    runDir,
    manifest.executor_input_path,
    "executor_input_path",
  );
  await assertContained(runDir, manifest.instruction_path, "instruction_path");

  const identity = {
    schema_version: manifest.schema_version,
    run_id: manifest.run_id,
    corpus_version: manifest.corpus_version,
    case_id: manifest.case_id,
    variant: manifest.variant,
    executor_id: manifest.executor_id,
    replicate: manifest.replicate,
    fixture_digest: manifest.fixture_digest,
    task_contract_digest: manifest.task_contract_digest,
    max_rounds: manifest.max_rounds,
    base_commit: manifest.base_commit,
    tool_permission_class: manifest.tool_permission_class,
    fresh_session_required: manifest.fresh_session_required,
    input_bundle_sha256: manifest.input_bundle_sha256,
    task_contract_sha256: manifest.task_contract_sha256,
  };
  const expectedManifestSha = sha256(canonicalJson(identity));
  if (manifest.manifest_sha256 !== expectedManifestSha) {
    throw new Error("manifest manifest_sha256 mismatch");
  }
  return manifest;
}

async function loadRoundResult(roundsPath, round) {
  const path = join(roundsPath, `round-${round}.json`);
  if (!existsSync(path)) return null;
  return readJson(path);
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

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

async function loadAndValidateAttestation(attestationPath, manifest, round) {
  if (!attestationPath) throw new Error("attestation file required");
  const attestation = await readJson(attestationPath);
  const required = [
    "schema_version",
    "run_id",
    "round",
    "executor_id",
    "session_id",
    "fresh_session_started",
    "tool_permission_class",
    "action",
    "input_bundle_sha256",
    "manual_intervention_count",
    "context_retrieval_count",
  ];
  for (const key of required) {
    if (!(key in attestation)) throw new Error(`attestation missing ${key}`);
  }
  if (attestation.schema_version !== 1)
    throw new Error("attestation schema_version must be 1");
  if (attestation.run_id !== manifest.run_id)
    throw new Error("attestation run_id mismatch");
  if (attestation.round !== round)
    throw new Error("attestation round mismatch");
  if (attestation.executor_id !== manifest.executor_id)
    throw new Error("attestation executor_id mismatch");
  if (attestation.input_bundle_sha256 !== manifest.input_bundle_sha256) {
    throw new Error("attestation input_bundle_sha256 mismatch");
  }
  if (attestation.tool_permission_class !== manifest.tool_permission_class) {
    throw new Error("attestation tool_permission_class mismatch");
  }
  if (!VALID_ACTIONS.has(attestation.action)) {
    throw new Error(`attestation invalid action: ${attestation.action}`);
  }
  if (
    typeof attestation.manual_intervention_count !== "number" ||
    attestation.manual_intervention_count < 0 ||
    !Number.isInteger(attestation.manual_intervention_count)
  ) {
    throw new Error(
      "attestation manual_intervention_count must be a non-negative integer",
    );
  }
  if (
    typeof attestation.context_retrieval_count !== "number" ||
    attestation.context_retrieval_count < 0 ||
    !Number.isInteger(attestation.context_retrieval_count)
  ) {
    throw new Error(
      "attestation context_retrieval_count must be a non-negative integer",
    );
  }
  if (
    typeof attestation.session_id !== "string" ||
    attestation.session_id.length === 0
  ) {
    throw new Error("attestation session_id must be a non-empty string");
  }
  if (typeof attestation.fresh_session_started !== "boolean") {
    throw new Error("attestation fresh_session_started must be boolean");
  }
  if (round === 1 && !attestation.fresh_session_started) {
    throw new Error("round 1 requires fresh_session_started");
  }
  if (round > 1) {
    const prev = await loadRoundResult(manifest.rounds_path, round - 1);
    if (prev && prev.session_id !== attestation.session_id) {
      throw new Error("attestation session_id must match previous round");
    }
  }
  return attestation;
}

async function doEvaluate({ runDir, round, attestationPath }) {
  if (round < 1) throw new Error("round must be >= 1");
  const manifest = await loadAndValidateManifest(runDir);
  const corpus = await loadCorpus();
  const caseObj = findCase(corpus, manifest.case_id);

  if (round > manifest.max_rounds) {
    return fail(
      "ROUND_OUT_OF_RANGE",
      `ROUND_OUT_OF_RANGE: round ${round} exceeds max_rounds ${manifest.max_rounds}`,
    );
  }

  const prevResults = await loadRoundResults(manifest.rounds_path);
  for (let r = 1; r < round; r++) {
    const prev = prevResults[r - 1];
    if (!prev) {
      return fail(
        "ROUND_SEQUENCE_ERROR",
        `ROUND_SEQUENCE_ERROR: round ${r} was not evaluated before round ${round}`,
      );
    }
    if (isTerminalStatus(prev.status)) {
      return fail(
        "ROUND_SEQUENCE_ERROR",
        `ROUND_SEQUENCE_ERROR: round ${r} is terminal (${prev.status}); cannot continue`,
      );
    }
  }
  if (prevResults[round - 1]) {
    return fail(
      "ROUND_ALREADY_EVALUATED",
      `ROUND_ALREADY_EVALUATED: round ${round} already evaluated`,
    );
  }

  const attestation = await loadAndValidateAttestation(
    attestationPath,
    manifest,
    round,
  );

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
    codePactStdoutBytes += byteLength(res.stdout);
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
      verificationResults = [
        {
          command: "code-pact task complete",
          exit_code: envelope.error?.code === "VERIFICATION_FAILED" ? 1 : 2,
          stdout: res.stdout,
          stderr: res.stderr,
        },
      ];
      failureKind =
        envelope.data?.failure?.kind || envelope.error?.cause_code || null;
      nextAction = envelope.error?.code || "verification_failed";
    }
  }

  const changedPaths = sourceChangedPaths(
    gitStatusChangedPaths(manifest.workspace_path),
  );
  const scopeViolations = computeScopeViolations(
    changedPaths,
    caseObj.allowed_writes,
  );
  if (scopeViolations.length > 0) {
    verificationOverall = 1;
    verificationResults.push({
      command: "scope-check",
      exit_code: 1,
      stdout: "",
      stderr: `scope violations: ${scopeViolations.join(", ")}`,
    });
  }

  const expectedStop = caseObj.expected_outcome === "expected_stop_success";
  const action = attestation.action;

  if (expectedStop) {
    if (
      action !== "stopped_decision" ||
      changedPaths.length > 0 ||
      scopeViolations.length > 0 ||
      attestation.manual_intervention_count > 0
    ) {
      verificationOverall = 1;
      if (action === "failed_to_execute") failureKind = "failed_to_execute";
      else if (action !== "stopped_decision") failureKind = "unexpected_action";
      else if (attestation.manual_intervention_count > 0)
        failureKind = "manual_intervention";
    } else {
      verificationOverall = 0;
      nextAction = "expected_stop";
    }
  } else {
    if (action !== "implemented" || attestation.manual_intervention_count > 0) {
      verificationOverall = 1;
      failureKind = action;
    }
  }

  const failureFingerprint =
    verificationOverall !== 0
      ? computeFailureFingerprint(verificationResults)
      : null;
  const bounded =
    verificationOverall !== 0
      ? boundedOutput(
          verificationResults,
          corpus.failure_feedback_max_bytes || 2048,
        )
      : null;

  const previousResult = round > 1 ? prevResults[round - 2] : null;
  let status;
  let sameFingerprintRepeatCount = 0;
  let completedRounds = round;
  let repairRounds = Math.max(0, completedRounds - 1);
  let firstPassSuccess = false;

  if (verificationOverall === 0) {
    status = expectedStop ? "expected_stop_success" : "verified_success";
    if (round === 1) firstPassSuccess = true;
  } else {
    const previousFingerprint = previousResult?.failure_fingerprint;
    if (previousFingerprint && previousFingerprint === failureFingerprint) {
      status = "stop_repeated_failure";
      sameFingerprintRepeatCount =
        (previousResult.same_fingerprint_repeat_count || 0) + 1;
    } else if (round === manifest.max_rounds) {
      status = "stop_max_rounds";
    } else {
      status = "verification_failed";
    }
  }

  const previousTotalCodePactStdout =
    previousResult?.code_pact_stdout_bytes_total || 0;
  const inputTokens = previousResult?.input_tokens ?? null;
  const outputTokens = previousResult?.output_tokens ?? null;
  const totalTokens = previousResult?.total_tokens ?? null;

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
    next_action: nextAction || status,
    session_id: attestation.session_id,
    tool_permission_class: attestation.tool_permission_class,
    context_retrieval_count: attestation.context_retrieval_count,
    code_pact_stdout_bytes: codePactStdoutBytes,
    code_pact_stdout_bytes_total:
      previousTotalCodePactStdout + codePactStdoutBytes,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    billed_amount: previousResult?.billed_amount ?? null,
    currency: previousResult?.currency ?? null,
    manual_intervention_count: attestation.manual_intervention_count,
    fixture_digest: manifest.fixture_digest,
    task_contract_digest: manifest.task_contract_digest,
    manifest_sha256: manifest.manifest_sha256,
    input_bundle_sha256: manifest.input_bundle_sha256,
    task_contract_sha256: manifest.task_contract_sha256,
    base_commit: manifest.base_commit,
  };

  await writeJson(join(manifest.rounds_path, `round-${round}.json`), result);
  await writeJson(join(runDir, "result.json"), result);
  return ok({ result });
}

function validateTelemetry(telemetry) {
  if (telemetry.schema_version !== 1)
    throw new Error("telemetry schema_version must be 1");
  const required = [
    "run_id",
    "executor_id",
    "variant",
    "replicate",
    "session_id",
    "tool_permission_class",
    "input_tokens",
    "output_tokens",
    "billed_amount",
    "currency",
    "manual_intervention_count",
  ];
  for (const key of required) {
    if (!(key in telemetry)) throw new Error(`telemetry missing ${key}`);
  }
  if (
    typeof telemetry.input_tokens !== "number" &&
    telemetry.input_tokens !== null
  ) {
    throw new Error("telemetry input_tokens must be an integer or null");
  }
  if (
    typeof telemetry.output_tokens !== "number" &&
    telemetry.output_tokens !== null
  ) {
    throw new Error("telemetry output_tokens must be an integer or null");
  }
  for (const key of ["input_tokens", "output_tokens"]) {
    const v = telemetry[key];
    if (v !== null) {
      if (
        !Number.isInteger(v) ||
        v < 0 ||
        Number.isNaN(v) ||
        !Number.isFinite(v)
      ) {
        throw new Error(
          `telemetry ${key} must be a non-negative integer or null`,
        );
      }
    }
  }
  if (telemetry.billed_amount !== null) {
    if (
      typeof telemetry.billed_amount !== "number" ||
      Number.isNaN(telemetry.billed_amount) ||
      !Number.isFinite(telemetry.billed_amount) ||
      telemetry.billed_amount < 0
    ) {
      throw new Error(
        "telemetry billed_amount must be a non-negative number or null",
      );
    }
    if (
      typeof telemetry.currency !== "string" ||
      telemetry.currency.length === 0
    ) {
      throw new Error(
        "telemetry currency must be a non-empty string when billed_amount is set",
      );
    }
  }
  if (
    telemetry.currency !== null &&
    (typeof telemetry.currency !== "string" || telemetry.currency.length === 0)
  ) {
    throw new Error("telemetry currency must be a non-empty string or null");
  }
  if (
    typeof telemetry.manual_intervention_count !== "number" ||
    !Number.isInteger(telemetry.manual_intervention_count) ||
    telemetry.manual_intervention_count < 0
  ) {
    throw new Error(
      "telemetry manual_intervention_count must be a non-negative integer",
    );
  }
}

async function doFinalize({ runDir, telemetryPath }) {
  const manifest = await loadAndValidateManifest(runDir);
  const resultPath = join(runDir, "result.json");
  if (!existsSync(resultPath))
    throw new Error("result not found; run evaluate first");
  const result = await readJson(resultPath);
  if (!isTerminalStatus(result.status)) {
    throw new Error(`cannot finalize non-terminal result: ${result.status}`);
  }

  const telemetry = await readJson(telemetryPath);
  validateTelemetry(telemetry);
  if (telemetry.run_id !== manifest.run_id)
    throw new Error("telemetry run_id mismatch");
  if (telemetry.executor_id !== manifest.executor_id)
    throw new Error("telemetry executor_id mismatch");
  if (telemetry.variant !== manifest.variant)
    throw new Error("telemetry variant mismatch");
  if (telemetry.replicate !== manifest.replicate)
    throw new Error("telemetry replicate mismatch");
  if (telemetry.session_id !== result.session_id)
    throw new Error("telemetry session_id mismatch");
  if (telemetry.tool_permission_class !== manifest.tool_permission_class)
    throw new Error("telemetry tool_permission_class mismatch");

  const inputTokens = telemetry.input_tokens ?? null;
  const outputTokens = telemetry.output_tokens ?? null;
  let totalTokens = null;
  if (inputTokens !== null && outputTokens !== null) {
    totalTokens = inputTokens + outputTokens;
  }

  const updated = {
    ...result,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    billed_amount: telemetry.billed_amount ?? null,
    currency: telemetry.currency ?? null,
    manual_intervention_count: telemetry.manual_intervention_count,
  };

  if (updated.manual_intervention_count > 0) {
    updated.status = "stop_manual_intervention";
    updated.exit_code = updated.exit_code ?? 1;
  }

  await writeJson(resultPath, updated);
  return ok({ result: updated });
}

async function validateResultIntegrity(result, manifest) {
  const checks = [
    ["run_id", result.run_id === manifest.run_id, "run_id mismatch"],
    ["case_id", result.case_id === manifest.case_id, "case_id mismatch"],
    ["variant", result.variant === manifest.variant, "variant mismatch"],
    [
      "executor_id",
      result.executor_id === manifest.executor_id,
      "executor_id mismatch",
    ],
    [
      "replicate",
      result.replicate === manifest.replicate,
      "replicate mismatch",
    ],
    [
      "fixture_digest",
      result.fixture_digest === manifest.fixture_digest,
      "fixture_digest mismatch",
    ],
    [
      "task_contract_digest",
      result.task_contract_digest === manifest.task_contract_digest,
      "task_contract_digest mismatch",
    ],
    [
      "manifest_sha256",
      result.manifest_sha256 === manifest.manifest_sha256,
      "manifest_sha256 mismatch",
    ],
    [
      "input_bundle_sha256",
      result.input_bundle_sha256 === manifest.input_bundle_sha256,
      "input_bundle_sha256 mismatch",
    ],
    [
      "task_contract_sha256",
      result.task_contract_sha256 === manifest.task_contract_sha256,
      "task_contract_sha256 mismatch",
    ],
    [
      "base_commit",
      result.base_commit === manifest.base_commit,
      "base_commit mismatch",
    ],
    [
      "tool_permission_class",
      result.tool_permission_class === manifest.tool_permission_class,
      "tool_permission_class mismatch",
    ],
    [
      "max_rounds",
      result.completed_rounds <= manifest.max_rounds,
      "completed_rounds exceeds max_rounds",
    ],
    [
      "status",
      TERMINAL_STATUSES.has(result.status),
      `non-terminal or invalid status: ${result.status}`,
    ],
  ];
  for (const [, okValue, message] of checks) {
    if (!okValue) return { ok: false, error: message };
  }
  return { ok: true };
}

async function doValidateResult({ file }) {
  const result = await readJson(file);
  const runDir = dirname(file);
  const manifest = await loadAndValidateManifest(runDir);
  const integrity = await validateResultIntegrity(result, manifest);
  if (!integrity.ok) {
    return fail("VALIDATION_FAILED", integrity.error);
  }
  return ok(result);
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function rate(count, total) {
  return total > 0 ? count / total : null;
}

function tokensPerSuccessfulOutcome(totalTokens, successfulOutcomes) {
  if (successfulOutcomes === 0) return null;
  if (totalTokens === null) return null;
  return totalTokens / successfulOutcomes;
}

function tokenEfficiencyConclusion(
  baselineTpso,
  codePactTpso,
  baselineRepairMean,
  codePactRepairMean,
) {
  if (baselineTpso === null || codePactTpso === null)
    return "insufficient token evidence";
  if (baselineTpso === 0)
    return "baseline token per successful outcome is zero";
  const ratio = codePactTpso / baselineTpso;
  if (ratio <= 0.9)
    return "code_pact tokens per successful outcome at least 10% lower";
  if (
    codePactRepairMean !== null &&
    baselineRepairMean !== null &&
    baselineRepairMean > 0 &&
    codePactRepairMean <= baselineRepairMean * 0.75 &&
    ratio <= 1.05
  ) {
    return "code_pact repair rounds at least 25% lower with tokens within 105%";
  }
  return `code_pact tokens per successful outcome is ${(ratio * 100).toFixed(1)}% of baseline`;
}

function isSuccessfulOutcome(status) {
  return status === "verified_success" || status === "expected_stop_success";
}

async function discoverRunDirs(root) {
  const dirs = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const child = join(dir, ent.name);
      if (
        existsSync(join(child, "run-manifest.json")) &&
        existsSync(join(child, "result.json"))
      ) {
        dirs.push(child);
      } else {
        await walk(child);
      }
    }
  }
  await walk(root);
  return dirs;
}

async function doScore({ resultsRoot }) {
  const runDirs = await discoverRunDirs(resultsRoot);
  const runs = [];
  const errors = [];
  for (const runDir of runDirs) {
    try {
      const manifest = await loadAndValidateManifest(runDir);
      const result = await readJson(join(runDir, "result.json"));
      const integrity = await validateResultIntegrity(result, manifest);
      if (!integrity.ok) {
        errors.push(`${runDir}: ${integrity.error}`);
        continue;
      }
      if (result.manual_intervention_count > 0) {
        errors.push(`${runDir}: manual intervention`);
        continue;
      }
      runs.push({ manifest, result });
    } catch (e) {
      errors.push(`${runDir}: ${e.message}`);
    }
  }

  const pairMap = new Map();
  for (const run of runs) {
    const m = run.manifest;
    const key = [
      m.case_id,
      m.executor_id,
      m.replicate,
      m.fixture_digest,
      m.task_contract_digest,
      m.max_rounds,
      m.tool_permission_class,
    ].join("\0");
    const pair = pairMap.get(key) || { baseline: null, code_pact: null };
    if (pair[m.variant]) {
      errors.push(
        `${run.manifest.run_id}: duplicate ${m.variant} for pairing key`,
      );
      continue;
    }
    pair[m.variant] = run;
    pairMap.set(key, pair);
  }

  const pairs = [];
  for (const [key, pair] of pairMap) {
    if (pair.baseline && pair.code_pact) {
      if (
        pair.baseline.result.session_id === pair.code_pact.result.session_id
      ) {
        errors.push(
          `session_id reuse between baseline and code_pact for key ${key}`,
        );
        continue;
      }
      pairs.push(pair);
    } else {
      const missing = pair.baseline ? "code_pact" : "baseline";
      errors.push(`unpaired ${missing} run for key ${key}`);
    }
  }

  if (errors.length > 0) {
    return fail("SCORE_INTEGRITY_ERROR", errors.join("; "));
  }

  const byExecutor = new Map();
  const byCase = new Map();
  const totals = {
    baseline_runs: 0,
    code_pact_runs: 0,
    baseline_successful_outcomes: 0,
    code_pact_successful_outcomes: 0,
    baseline_verified_success: 0,
    code_pact_verified_success: 0,
    baseline_expected_stop_success: 0,
    code_pact_expected_stop_success: 0,
    baseline_scope_violations: 0,
    code_pact_scope_violations: 0,
    baseline_first_pass: 0,
    code_pact_first_pass: 0,
    baseline_total_tokens: 0,
    code_pact_total_tokens: 0,
    baseline_tokens_available: true,
    code_pact_tokens_available: true,
    baseline_repair_rounds: [],
    code_pact_repair_rounds: [],
    baseline_decision_stop_total: 0,
    code_pact_decision_stop_total: 0,
    baseline_decision_stop_unnecessary: 0,
    code_pact_decision_stop_unnecessary: 0,
  };

  for (const pair of pairs) {
    const b = pair.baseline.result;
    const c = pair.code_pact.result;
    const executorId = pair.baseline.manifest.executor_id;
    const caseId = pair.baseline.manifest.case_id;
    const corpus = await loadCorpus();
    const caseObj = findCase(corpus, caseId);

    if (!byExecutor.has(executorId)) {
      byExecutor.set(executorId, {
        executor_id: executorId,
        baseline_runs: 0,
        code_pact_runs: 0,
        baseline_successful_outcomes: 0,
        code_pact_successful_outcomes: 0,
        baseline_verified_success: 0,
        code_pact_verified_success: 0,
        baseline_expected_stop_success: 0,
        code_pact_expected_stop_success: 0,
        baseline_scope_violations: 0,
        code_pact_scope_violations: 0,
        baseline_first_pass: 0,
        code_pact_first_pass: 0,
        baseline_total_tokens: 0,
        code_pact_total_tokens: 0,
        baseline_tokens_available: true,
        code_pact_tokens_available: true,
        baseline_repair_rounds: [],
        code_pact_repair_rounds: [],
        baseline_decision_stop_total: 0,
        code_pact_decision_stop_total: 0,
        baseline_decision_stop_unnecessary: 0,
        code_pact_decision_stop_unnecessary: 0,
      });
    }
    const e = byExecutor.get(executorId);

    e.baseline_runs++;
    e.code_pact_runs++;
    totals.baseline_runs++;
    totals.code_pact_runs++;

    if (isSuccessfulOutcome(b.status)) e.baseline_successful_outcomes++;
    if (isSuccessfulOutcome(c.status)) e.code_pact_successful_outcomes++;
    if (b.status === "verified_success") e.baseline_verified_success++;
    if (c.status === "verified_success") e.code_pact_verified_success++;
    if (b.status === "expected_stop_success")
      e.baseline_expected_stop_success++;
    if (c.status === "expected_stop_success")
      e.code_pact_expected_stop_success++;
    if (b.first_pass_success) e.baseline_first_pass++;
    if (c.first_pass_success) e.code_pact_first_pass++;
    if (b.scope_violation_count > 0) e.baseline_scope_violations++;
    if (c.scope_violation_count > 0) e.code_pact_scope_violations++;
    e.baseline_repair_rounds.push(b.repair_rounds);
    e.code_pact_repair_rounds.push(c.repair_rounds);

    if (b.total_tokens !== null) {
      e.baseline_total_tokens += b.total_tokens;
      totals.baseline_total_tokens += b.total_tokens;
    } else {
      e.baseline_tokens_available = false;
      totals.baseline_tokens_available = false;
    }
    if (c.total_tokens !== null) {
      e.code_pact_total_tokens += c.total_tokens;
      totals.code_pact_total_tokens += c.total_tokens;
    } else {
      e.code_pact_tokens_available = false;
      totals.code_pact_tokens_available = false;
    }

    if (caseObj.expected_outcome === "expected_stop_success") {
      e.baseline_decision_stop_total++;
      e.code_pact_decision_stop_total++;
      totals.baseline_decision_stop_total++;
      totals.code_pact_decision_stop_total++;
      if (b.status !== "expected_stop_success") {
        e.baseline_decision_stop_unnecessary++;
        totals.baseline_decision_stop_unnecessary++;
      }
      if (c.status !== "expected_stop_success") {
        e.code_pact_decision_stop_unnecessary++;
        totals.code_pact_decision_stop_unnecessary++;
      }
    }

    if (!byCase.has(caseId)) {
      byCase.set(caseId, {
        case_id: caseId,
        paired_count: 0,
        baseline_verified_success: 0,
        code_pact_verified_success: 0,
        baseline_expected_stop_success: 0,
        code_pact_expected_stop_success: 0,
      });
    }
    const cs = byCase.get(caseId);
    cs.paired_count++;
    if (b.status === "verified_success") cs.baseline_verified_success++;
    if (c.status === "verified_success") cs.code_pact_verified_success++;
    if (b.status === "expected_stop_success")
      cs.baseline_expected_stop_success++;
    if (c.status === "expected_stop_success")
      cs.code_pact_expected_stop_success++;
  }

  const executorRows = [];
  let globalSafetyGate = "pass";
  let globalEfficiency = "no_efficiency_signal";
  let allTokensAvailable = true;

  for (const e of byExecutor.values()) {
    const baselineTpso = tokensPerSuccessfulOutcome(
      e.baseline_tokens_available ? e.baseline_total_tokens : null,
      e.baseline_successful_outcomes,
    );
    const codePactTpso = tokensPerSuccessfulOutcome(
      e.code_pact_tokens_available ? e.code_pact_total_tokens : null,
      e.code_pact_successful_outcomes,
    );
    const baseRepairMean = mean(e.baseline_repair_rounds);
    const cpRepairMean = mean(e.code_pact_repair_rounds);

    const baseSuccessRate = rate(
      e.baseline_successful_outcomes,
      e.baseline_runs,
    );
    const cpSuccessRate = rate(
      e.code_pact_successful_outcomes,
      e.code_pact_runs,
    );
    const baseScopeRate = rate(e.baseline_scope_violations, e.baseline_runs);
    const cpScopeRate = rate(e.code_pact_scope_violations, e.code_pact_runs);
    const baseDecisionUnnecessaryRate = rate(
      e.baseline_decision_stop_unnecessary,
      e.baseline_decision_stop_total,
    );
    const cpDecisionUnnecessaryRate = rate(
      e.code_pact_decision_stop_unnecessary,
      e.code_pact_decision_stop_total,
    );

    let safetyGate;
    if (
      baseSuccessRate === null ||
      cpSuccessRate === null ||
      baseScopeRate === null ||
      cpScopeRate === null ||
      (e.baseline_decision_stop_total > 0 &&
        baseDecisionUnnecessaryRate === null) ||
      (e.code_pact_decision_stop_total > 0 &&
        cpDecisionUnnecessaryRate === null)
    ) {
      safetyGate = "insufficient_data";
    } else if (
      cpSuccessRate >= baseSuccessRate &&
      cpScopeRate <= baseScopeRate &&
      (e.code_pact_decision_stop_total === 0 ||
        cpDecisionUnnecessaryRate <= baseDecisionUnnecessaryRate)
    ) {
      safetyGate = "pass";
    } else {
      safetyGate = "fail";
    }

    if (safetyGate === "fail") globalSafetyGate = "fail";
    if (safetyGate === "insufficient_data" && globalSafetyGate === "pass") {
      globalSafetyGate = "insufficient_data";
    }

    const tokenConclusion = tokenEfficiencyConclusion(
      baselineTpso,
      codePactTpso,
      baseRepairMean,
      cpRepairMean,
    );
    let efficiencySignal;
    if (baselineTpso === null || codePactTpso === null) {
      efficiencySignal = "insufficient_token_evidence";
    } else if (baselineTpso > 0 && codePactTpso <= baselineTpso * 0.9) {
      efficiencySignal = "token_efficiency_improved";
    } else if (
      baselineTpso > 0 &&
      codePactTpso <= baselineTpso * 1.05 &&
      baseRepairMean !== null &&
      cpRepairMean !== null &&
      baseRepairMean > 0 &&
      cpRepairMean <= baseRepairMean * 0.75
    ) {
      efficiencySignal = "repair_rounds_improved_with_tokens_within_105";
    } else {
      efficiencySignal = "no_efficiency_signal";
    }

    if (e.baseline_tokens_available && e.code_pact_tokens_available) {
      allTokensAvailable = allTokensAvailable && true;
    } else {
      allTokensAvailable = false;
    }

    executorRows.push({
      executor_id: e.executor_id,
      baseline_runs: e.baseline_runs,
      code_pact_runs: e.code_pact_runs,
      baseline_successful_outcome_rate: baseSuccessRate,
      code_pact_successful_outcome_rate: cpSuccessRate,
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
      baseline_repair_rounds_mean: baseRepairMean,
      code_pact_repair_rounds_mean: cpRepairMean,
      baseline_scope_violation_rate: baseScopeRate,
      code_pact_scope_violation_rate: cpScopeRate,
      baseline_decision_stop_unnecessary_rate: baseDecisionUnnecessaryRate,
      code_pact_decision_stop_unnecessary_rate: cpDecisionUnnecessaryRate,
      baseline_tokens_per_successful_outcome: baselineTpso,
      code_pact_tokens_per_successful_outcome: codePactTpso,
      token_efficiency_conclusion: tokenConclusion,
      safety_gate: safetyGate,
      efficiency_signal: efficiencySignal,
    });

    if (tokenConclusion === "insufficient token evidence") {
      globalEfficiency = "insufficient_token_evidence";
    } else if (
      globalEfficiency === "no_efficiency_signal" &&
      tokenConclusion.startsWith("code_pact")
    ) {
      globalEfficiency = tokenConclusion;
    }
  }

  const totalBaseTpso = tokensPerSuccessfulOutcome(
    totals.baseline_tokens_available ? totals.baseline_total_tokens : null,
    totals.baseline_successful_outcomes,
  );
  const totalCpTpso = tokensPerSuccessfulOutcome(
    totals.code_pact_tokens_available ? totals.code_pact_total_tokens : null,
    totals.code_pact_successful_outcomes,
  );
  const totalBaseRepairMean = mean([]); // not meaningful globally
  const totalCpRepairMean = mean([]);
  const totalTokenConclusion = tokenEfficiencyConclusion(
    totalBaseTpso,
    totalCpTpso,
    null,
    null,
  );

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
      baseline_expected_stop_success_rate: rate(
        cs.baseline_expected_stop_success,
        cs.paired_count,
      ),
      code_pact_expected_stop_success_rate: rate(
        cs.code_pact_expected_stop_success,
        cs.paired_count,
      ),
    });
  }

  const summary = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    corpus_version: (await loadCorpus()).corpus_version,
    max_rounds: 3,
    paired_count: pairs.length,
    by_executor: executorRows,
    by_case: caseRows,
    totals: {
      baseline_runs: totals.baseline_runs,
      code_pact_runs: totals.code_pact_runs,
      baseline_successful_outcomes: totals.baseline_successful_outcomes,
      code_pact_successful_outcomes: totals.code_pact_successful_outcomes,
      baseline_verified_success_count: totals.baseline_verified_success,
      code_pact_verified_success_count: totals.code_pact_verified_success,
      baseline_expected_stop_success_count:
        totals.baseline_expected_stop_success,
      code_pact_expected_stop_success_count:
        totals.code_pact_expected_stop_success,
      baseline_scope_violation_count: totals.baseline_scope_violations,
      code_pact_scope_violation_count: totals.code_pact_scope_violations,
      baseline_first_pass_success_count: totals.baseline_first_pass,
      code_pact_first_pass_success_count: totals.code_pact_first_pass,
      baseline_decision_stop_unnecessary_count:
        totals.baseline_decision_stop_unnecessary,
      code_pact_decision_stop_unnecessary_count:
        totals.code_pact_decision_stop_unnecessary,
      baseline_tokens_per_successful_outcome: totalBaseTpso,
      code_pact_tokens_per_successful_outcome: totalCpTpso,
      token_efficiency_conclusion: totalTokenConclusion,
      safety_gate: globalSafetyGate,
      efficiency_signal: globalEfficiency,
      stage_b_allowed: globalSafetyGate === "pass",
    },
    notes: [],
  };

  const outPath = join(resultsRoot, "score-summary.json");
  await writeJson(outPath, summary);
  return ok({ summary_path: outPath, summary });
}

async function doPreparePilot({
  executors,
  replicates,
  outputRoot,
  stage = "a",
  gateSummaryPath = null,
}) {
  const corpus = await loadCorpus();
  const issues = await validateCorpus(corpus);
  if (issues.length) throw new Error(`corpus invalid: ${issues.join("; ")}`);

  if (executors.length === 0) throw new Error("executors required");
  if (hasDuplicates(executors)) throw new Error("duplicate executor ids");
  for (const e of executors) validateExecutorId(e);
  if (stage !== "a" && stage !== "b") throw new Error("stage must be a or b");

  if (stage === "b") {
    if (!gateSummaryPath) throw new Error("stage b requires --gate-summary");
    const summary = await readJson(gateSummaryPath);
    if (summary.safety_gate !== "pass" || summary.stage_b_allowed !== true) {
      throw new Error("stage b safety gate not passed");
    }
  }

  await mkdir(outputRoot, { recursive: true });
  const plan = {
    schema_version: 1,
    corpus_version: corpus.corpus_version,
    stage,
    cli_built: existsSync(resolve(repoRoot, "dist", "cli.js")),
    executors,
    replicates,
    runs: [],
  };

  const manifests = [];
  const variants = stage === "a" ? ["baseline", "code_pact"] : ["code_pact"];
  const cliBuilt = plan.cli_built;

  for (const executorId of executors) {
    const stageDir = join(outputRoot, `stage-${stage}`, executorId);
    for (const caseObj of corpus.cases) {
      for (const variant of variants) {
        if (variant === "code_pact" && !cliBuilt) {
          if (stage === "b")
            throw new Error(
              "code-pact CLI not built; stage b requires code_pact",
            );
          continue;
        }
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
          plan.runs.push({
            case_id: caseObj.id,
            variant,
            replicate: r,
            run_id: info.run_id,
            executor_id: executorId,
            stage,
          });
        }
      }
    }
  }

  await writeJson(join(outputRoot, "pilot-plan.json"), plan);
  return ok({
    manifest_count: manifests.length,
    cli_built: cliBuilt,
    plan_path: join(outputRoot, "pilot-plan.json"),
  });
}

async function handleCorpusCheck(args) {
  const corpus = await loadCorpus();
  const issues = await validateCorpus(corpus);
  return ok({ valid: issues.length === 0, issues });
}

async function handlePrepare(args) {
  const corpus = await loadCorpus();
  const issues = await validateCorpus(corpus);
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
  const runDir = resolve(args.values.run);
  const attestationPath = args.values.attestation
    ? resolve(args.values.attestation)
    : null;
  const info = await doEvaluate({
    runDir,
    round: Number(args.values.round),
    attestationPath,
  });
  return info;
}

async function handleFinalize(args) {
  const runDir = resolve(args.values.run);
  const telemetryPath = resolve(args.values.telemetry);
  const info = await doFinalize({ runDir, telemetryPath });
  return info;
}

async function handleValidateResult(args) {
  const info = await doValidateResult({ file: resolve(args.values.file) });
  return info.ok
    ? ok(info.data)
    : fail("VALIDATION_FAILED", info.error.message);
}

async function handleScore(args) {
  const info = await doScore({ resultsRoot: resolve(args.values.results) });
  return info;
}

async function handlePreparePilot(args) {
  const executors = args.values.executors
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  if (executors.length === 0) return fail("CONFIG_ERROR", "executors required");
  const replicates = Number(args.values.replicates);
  if (replicates < 1) return fail("CONFIG_ERROR", "replicates must be >= 1");
  const stage = args.values.stage || "a";
  const gateSummaryPath = args.values["gate-summary"]
    ? resolve(args.values["gate-summary"])
    : null;
  const info = await doPreparePilot({
    executors,
    replicates,
    outputRoot: resolveOutputRoot(args.values.output),
    stage,
    gateSummaryPath,
  });
  return info;
}

function usage() {
  return `Usage: benchmark-low-capability.mjs <subcommand> [options]

Subcommands:
  corpus-check
  prepare --case <id> --variant <v> --executor-id <id> --replicate <n> [--output <dir>]
  evaluate --run <dir> --round <n> --attestation <file>
  finalize --run <dir> --telemetry <file>
  validate-result --file <path>
  score --results <dir>
  prepare-pilot --executors E1,E2 --replicates <n> [--output <dir>] [--stage a|b] [--gate-summary <file>]

Global:
  --json    Emit JSON envelopes
`;
}

function parseCommand(argv) {
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
      attestation: { type: "string" },
      telemetry: { type: "string" },
      file: { type: "string" },
      results: { type: "string" },
      executors: { type: "string" },
      replicates: { type: "string" },
      stage: { type: "string" },
      "gate-summary": { type: "string" },
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
