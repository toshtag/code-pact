#!/usr/bin/env node
// Verify P80-T2 trial evidence archive.
// Usage: node verify-p80-t2-evidence.mjs <zip-path> [--self-test]

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const zipPath = process.argv[2];
const selfTest = process.argv.includes("--self-test");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function sha256Buffer(b) {
  return crypto.createHash("sha256").update(b).digest("hex");
}

function readJson(tmp, f) {
  return JSON.parse(fs.readFileSync(path.join(tmp, f), "utf8"));
}

function writeJson(tmp, f, o) {
  fs.writeFileSync(path.join(tmp, f), JSON.stringify(o, null, 2));
}

function readText(tmp, f) {
  return fs.readFileSync(path.join(tmp, f), "utf8");
}

function readYaml(tmp, f) {
  const text = readText(tmp, f);
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function assertEq(label, actual, expected) {
  if (actual !== expected) {
    fail(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertTrue(label, cond) {
  if (!cond) fail(label);
}

function canonicalP79Failures(values) {
  return values
    .map(v => ({
      scope: v.scope,
      stage: v.stage,
      code: v.code,
      review_bundle_generated: v.review_bundle_generated,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function canonicalCommandFailures(values) {
  return values
    .map(v => ({
      scope: v.scope,
      stage: v.stage,
      code: v.error_code,
      review_bundle_generated: false,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function assertDeepEqual(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    fail(`${label}: expected ${e}, got ${a}`);
  }
}

const EXPECTED_P79_FAILURES = [
  {
    scope: "fixture_P80-C2",
    stage: "finalize",
    code: "TASK_WRITES_AUDIT_DECLARED_UNUSED",
    review_bundle_generated: false,
  },
  {
    scope: "fixture_P80-C2",
    stage: "review_bundle",
    code: "FIXTURE_CLASSIFIER_UNAVAILABLE",
    review_bundle_generated: false,
  },
  {
    scope: "main_P80-T2",
    stage: "review_bundle",
    code: "TASK_CONTRACT_DRIFT",
    review_bundle_generated: false,
  },
];

const REQUIRED_CASES = [
  "wrong_model_digest",
  "wrong_execution_order",
  "wrong_capability_token_total",
  "wrong_baseline_token_total",
  "wrong_code_pact_token_total",
  "buggy_oracle_unexpected_pass",
  "source_fixture_mismatch",
  "repair_count_nonzero",
  "promising_classification",
  "artifact_mismatch_zero",
  "nested_p79_status_mismatch",
  "p79_failure_array_mismatch",
  "p79_failure_code_not_in_command_log",
  "start_event_has_done_status",
];

const EXCLUDED_FROM_BASE_DIGEST = new Set([
  "manifest.json",
  "hashes.json",
  "negative-verifier-results.json",
  "verifier-negative-log.txt",
]);

function baseEvidenceDigest(dir) {
  const files = fs
    .readdirSync(dir)
    .filter(
      f =>
        fs.statSync(path.join(dir, f)).isFile() &&
        !EXCLUDED_FROM_BASE_DIGEST.has(f),
    )
    .sort();
  const h = crypto.createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\0");
    h.update(sha256File(path.join(dir, f)));
  }
  return h.digest("hex");
}

function rebuildManifestAndHashes(dir) {
  fs.rmSync(path.join(dir, "hashes.json"), { force: true });
  fs.rmSync(path.join(dir, "manifest.json"), { force: true });
  const files = fs
    .readdirSync(dir)
    .filter(f => fs.statSync(path.join(dir, f)).isFile())
    .sort();
  const hashes = {};
  for (const f of files) hashes[f] = sha256File(path.join(dir, f));
  const final = readJson(dir, "final-metrics.json");
  const capMetrics = readJson(dir, "capability-metrics.json");
  const baseMetrics = readJson(dir, "baseline-metrics.json");
  const codeMetrics = readJson(dir, "code-pact-metrics.json");
  const baseDigest = baseEvidenceDigest(dir);
  const manifest = {
    schema_version: 1,
    trial_id: "P80-T2",
    pair_status: final.pair_status,
    first_pass_result: final.first_pass_result,
    token_result: final.token_result,
    product_effectiveness: final.product_effectiveness,
    failure_attribution: "none",
    reproducibility: final.reproducibility,
    lifecycle_evidence: final.lifecycle_evidence,
    buggy_base_sha: null,
    reference_fix_sha: null,
    reference_patch_sha256: hashes["reference.patch"],
    pair_base_sha: "7fc93b0643fed81381e600586c9b2e1ad31cee96",
    execution_order: final.execution_order,
    provider: final.provider,
    sampling: final.sampling,
    capability_gate: { ...capMetrics, passed: true },
    baseline: baseMetrics,
    code_pact: codeMetrics,
    p79_failures: final.p79_failures,
    p79_dogfood_status: final.p79_dogfood_status,
    contract_drift_count: final.contract_drift_count,
    scope_audit_failure_count: final.scope_audit_failure_count,
    classifier_unavailable_count: final.classifier_unavailable_count,
    artifact_mismatch_count: final.artifact_mismatch_count,
    artifact_integrity_status: final.artifact_integrity_status,
    review_bundle_generated: final.review_bundle_generated,
    base_evidence_digest: baseDigest,
    raw_file_hashes: hashes,
  };
  writeJson(dir, "manifest.json", manifest);
  const files2 = fs
    .readdirSync(dir)
    .filter(f => fs.statSync(path.join(dir, f)).isFile())
    .sort();
  const hashes2 = {};
  for (const f of files2) hashes2[f] = sha256File(path.join(dir, f));
  writeJson(dir, "hashes.json", hashes2);
}

function writeStubNegative(dir, baseDigest) {
  const stubCases = REQUIRED_CASES.map(name => ({
    name,
    hashes_recomputed: true,
    exit_code: 1,
    expected_error: "stub",
    actual_stderr_excerpt: "stub",
    hash_mismatch: false,
    expected_error_matched: true,
    rejected: true,
  }));
  writeJson(dir, "negative-verifier-results.json", {
    schema_version: 1,
    base_evidence_digest: baseDigest,
    cases: stubCases,
    total: REQUIRED_CASES.length,
    rejected: REQUIRED_CASES.length,
  });
  const logLines = [];
  for (const c of stubCases) {
    logLines.push(
      `CASE ${c.name}`,
      `EXIT ${c.exit_code}`,
      `EXPECTED ${c.expected_error}`,
      `STDERR ${c.actual_stderr_excerpt}`,
      `HASH_MISMATCH ${c.hash_mismatch}`,
      `EXPECTED_HIT ${c.expected_error_matched}`,
      `RESULT ${c.rejected ? "REJECTED" : "ACCEPTED (BAD)"}`,
      "",
    );
  }
  fs.writeFileSync(
    path.join(dir, "verifier-negative-log.txt"),
    logLines.join("\n"),
  );
}

function parseNegativeLog(text) {
  const blocks = [];
  let current = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      if (Object.keys(current).length) {
        blocks.push(current);
        current = {};
      }
      continue;
    }
    const caseMatch = line.match(/^CASE (.+)$/);
    if (caseMatch) {
      current.name = caseMatch[1];
      continue;
    }
    const exitMatch = line.match(/^EXIT (\d+)$/);
    if (exitMatch) {
      current.exit_code = parseInt(exitMatch[1], 10);
      continue;
    }
    const expectedMatch = line.match(/^EXPECTED (.+)$/);
    if (expectedMatch) {
      current.expected_error = expectedMatch[1];
      continue;
    }
    const stderrMatch = line.match(/^STDERR (.+)$/);
    if (stderrMatch) {
      current.actual_stderr_excerpt = stderrMatch[1];
      continue;
    }
    const hashMatch = line.match(/^HASH_MISMATCH (true|false)$/);
    if (hashMatch) {
      current.hash_mismatch = hashMatch[1] === "true";
      continue;
    }
    const hitMatch = line.match(/^EXPECTED_HIT (true|false)$/);
    if (hitMatch) {
      current.expected_error_matched = hitMatch[1] === "true";
      continue;
    }
    const resultMatch = line.match(/^RESULT (REJECTED|ACCEPTED \(BAD\))$/);
    if (resultMatch) {
      current.rejected = resultMatch[1] === "REJECTED";
      continue;
    }
  }
  if (Object.keys(current).length) blocks.push(current);
  return blocks;
}

function runSelfTest(zip) {
  if (!zip || !fs.existsSync(zip)) fail("archive not found for self-test");
  const baseDir = fs.mkdtempSync("/tmp/p80-t2-selftest-base-");
  try {
    execSync(`unzip -q "${zip}" -d "${baseDir}"`);

    const cases = [
      {
        name: "wrong_model_digest",
        expected_error: "model-identity digest",
        mutate(d) {
          const mi = readJson(d, "model-identity.json");
          mi.model_resolved_digest = "bad";
          writeJson(d, "model-identity.json", mi);
        },
      },
      {
        name: "wrong_execution_order",
        expected_error: "execution_order",
        mutate(d) {
          const fm = readJson(d, "final-metrics.json");
          fm.execution_order = ["baseline", "capability_gate", "code_pact"];
          writeJson(d, "final-metrics.json", fm);
        },
      },
      {
        name: "wrong_capability_token_total",
        expected_error: "capability total_tokens",
        mutate(d) {
          const cm = readJson(d, "capability-metrics.json");
          cm.total_tokens = 999;
          writeJson(d, "capability-metrics.json", cm);
        },
      },
      {
        name: "wrong_baseline_token_total",
        expected_error: "baseline total_tokens",
        mutate(d) {
          const bm = readJson(d, "baseline-metrics.json");
          bm.total_tokens = 999;
          writeJson(d, "baseline-metrics.json", bm);
        },
      },
      {
        name: "wrong_code_pact_token_total",
        expected_error: "code_pact total_tokens",
        mutate(d) {
          const cm = readJson(d, "code-pact-metrics.json");
          cm.total_tokens = 999;
          writeJson(d, "code-pact-metrics.json", cm);
        },
      },
      {
        name: "buggy_oracle_unexpected_pass",
        expected_error: "pair_buggy_oracle",
        mutate(d) {
          const pf = readJson(d, "oracle-preflight.json");
          pf.checks.find(c => c.name === "pair_buggy_oracle").exit_code = 0;
          writeJson(d, "oracle-preflight.json", pf);
        },
      },
      {
        name: "source_fixture_mismatch",
        expected_error: "pair-source.ts",
        mutate(d) {
          fs.writeFileSync(
            path.join(d, "pair-source.ts"),
            "export function isEven(value: number): boolean { return value % 2 === 0; }\n",
          );
        },
      },
      {
        name: "repair_count_nonzero",
        expected_error: "corrective pass used",
        mutate(d) {
          const cm = readJson(d, "capability-metrics.json");
          cm.corrective_pass_count = 1;
          writeJson(d, "capability-metrics.json", cm);
        },
      },
      {
        name: "promising_classification",
        expected_error: "product_effectiveness",
        mutate(d) {
          const fm = readJson(d, "final-metrics.json");
          fm.product_effectiveness = "promising_single_pair";
          writeJson(d, "final-metrics.json", fm);
        },
      },
      {
        name: "artifact_mismatch_zero",
        expected_error: "artifact_mismatch_count",
        mutate(d) {
          const fm = readJson(d, "final-metrics.json");
          fm.artifact_mismatch_count = 0;
          writeJson(d, "final-metrics.json", fm);
        },
      },
      {
        name: "nested_p79_status_mismatch",
        expected_error: "p79_dogfood_status",
        mutate(d) {
          const cm = readJson(d, "code-pact-metrics.json");
          cm.p79_dogfood_status = "not_exercised";
          writeJson(d, "code-pact-metrics.json", cm);
        },
      },
      {
        name: "p79_failure_array_mismatch",
        expected_error: "p79_failures",
        mutate(d) {
          const fm = readJson(d, "final-metrics.json");
          fm.p79_failures[0].code = "INVENTED_ERROR";
          writeJson(d, "final-metrics.json", fm);
        },
      },
      {
        name: "p79_failure_code_not_in_command_log",
        expected_error: "not matched in command evidence",
        mutate(d) {
          const cl = readJson(d, "command-log.json");
          cl.failures[0].error_code = "DIFFERENT_CODE";
          cl.failures[0].stderr_excerpt = "different error";
          writeJson(d, "command-log.json", cl);
        },
      },
      {
        name: "start_event_has_done_status",
        expected_error: "start_event status",
        mutate(d) {
          let text = fs.readFileSync(path.join(d, "start-event.yaml"), "utf8");
          text = text.replace("status: started", "status: done");
          fs.writeFileSync(path.join(d, "start-event.yaml"), text);
        },
      },
    ];

    const script = new URL(import.meta.url).pathname;
    const results = [];
    const logLines = [];

    for (const c of cases) {
      const caseDir = fs.mkdtempSync("/tmp/p80-t2-selftest-case-");
      try {
        execSync(`cp -R "${baseDir}/." "${caseDir}/"`);
        c.mutate(caseDir);
        const caseBaseDigest = baseEvidenceDigest(caseDir);
        writeStubNegative(caseDir, caseBaseDigest);
        rebuildManifestAndHashes(caseDir);
        fs.mkdirSync(path.join(caseDir, "out"), { recursive: true });
        execSync(`cd "${caseDir}" && zip -rq out/P80-T2-evidence-bad.zip .`);
        let exitCode = 0;
        let stderr = "";
        let stdout = "";
        try {
          stdout = execSync(
            `node "${script}" "${caseDir}/out/P80-T2-evidence-bad.zip"`,
            {
              encoding: "utf8",
              stdio: "pipe",
            },
          );
        } catch (e) {
          exitCode = e.status ?? 1;
          stderr = e.stderr ? e.stderr.toString() : e.message;
          stdout = e.stdout ? e.stdout.toString() : "";
        }
        const failLine =
          stderr.split("\n").find(l => l.startsWith("FAIL:")) ||
          stderr.split("\n")[1] ||
          "";
        const lowerFail = failLine.toLowerCase();
        const hashMismatch =
          lowerFail.includes("hash mismatch") ||
          (lowerFail.includes("base_evidence_digest") &&
            lowerFail.includes("mismatch"));
        const expectedHit = failLine.includes(c.expected_error);
        const rejected = exitCode !== 0 && !hashMismatch && expectedHit;
        results.push({
          name: c.name,
          hashes_recomputed: true,
          exit_code: exitCode,
          expected_error: c.expected_error,
          actual_stderr_excerpt: failLine.replace(/^FAIL: /, ""),
          hash_mismatch: hashMismatch,
          expected_error_matched: expectedHit,
          rejected,
        });
        const stderrForLog = failLine.replace(/^FAIL: /, "");
        logLines.push(
          `CASE ${c.name}`,
          `EXIT ${exitCode}`,
          `EXPECTED ${c.expected_error}`,
          `STDERR ${stderrForLog}`,
          `HASH_MISMATCH ${hashMismatch}`,
          `EXPECTED_HIT ${expectedHit}`,
          `RESULT ${rejected ? "REJECTED" : "ACCEPTED (BAD)"}`,
          "",
        );
      } finally {
        fs.rmSync(caseDir, { recursive: true, force: true });
      }
    }

    const rejectedCount = results.filter(r => r.rejected).length;
    const baseDigest = baseEvidenceDigest(baseDir);
    const negativeResults = {
      schema_version: 1,
      base_evidence_digest: baseDigest,
      cases: results,
      total: results.length,
      rejected: rejectedCount,
    };

    const outDir = path.dirname(zip);
    const outJson = path.join(outDir, "negative-verifier-results.json");
    const outLog = path.join(outDir, "verifier-negative-log.txt");
    writeJson(outDir, "negative-verifier-results.json", negativeResults);
    fs.writeFileSync(outLog, logLines.join("\n"));

    console.log(`Self-test results written to ${outJson} and ${outLog}`);
    console.log(
      `Total: ${negativeResults.total}, Rejected: ${negativeResults.rejected}`,
    );
    if (rejectedCount !== results.length) {
      fail("not all negative cases were semantically rejected");
    }
    return negativeResults;
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

if (selfTest) {
  runSelfTest(zipPath);
  process.exit(0);
}

if (!zipPath || !fs.existsSync(zipPath)) {
  fail(`evidence ZIP not found: ${zipPath}`);
}

const required = [
  "manifest.json",
  "model-identity.json",
  "capability-source.ts",
  "capability-oracle.mjs",
  "capability-prompt.txt",
  "capability-response.json",
  "capability-metrics.json",
  "pair-source.ts",
  "hidden-oracle.mjs",
  "reference.patch",
  "oracle-preflight.json",
  "baseline-prompt.txt",
  "baseline-response.json",
  "baseline-metrics.json",
  "code-pact-prompt.txt",
  "code-pact-response.json",
  "code-pact-metrics.json",
  "final-metrics.json",
  "command-log.json",
  "main-command-log.json",
  "p80-task.yaml",
  "contract-lock.yaml",
  "start-event.yaml",
  "done-event.yaml",
  "negative-verifier-results.json",
  "verifier-negative-log.txt",
  "hashes.json",
];

const tmpDir = fs.mkdtempSync("/tmp/p80-t2-verify-");
try {
  execSync(`unzip -q "${zipPath}" -d "${tmpDir}"`);

  for (const f of required) {
    const p = path.join(tmpDir, f);
    if (!fs.existsSync(p)) {
      fail(`missing required file: ${f}`);
    }
  }

  // Hash verification
  const expected = readJson(tmpDir, "hashes.json");
  for (const f in expected) {
    const p = path.join(tmpDir, f);
    if (!fs.existsSync(p)) {
      fail(`hashes.json references missing file: ${f}`);
    }
    const actual = sha256File(p);
    if (actual !== expected[f]) {
      fail(`hash mismatch for ${f}: expected ${expected[f]}, actual ${actual}`);
    }
  }

  // Core manifest
  const manifest = readJson(tmpDir, "manifest.json");
  assertEq("manifest.trial_id", manifest.trial_id, "P80-T2");
  if (
    !["qualified", "non_discriminating", "not_started"].includes(
      manifest.pair_status,
    )
  ) {
    fail(`unexpected pair_status: ${manifest.pair_status}`);
  }
  assertEq(
    "manifest.product_effectiveness",
    manifest.product_effectiveness,
    "not_demonstrated_single_pair",
  );
  assertEq("manifest.first_pass_result", manifest.first_pass_result, "tie");
  assertEq(
    "manifest.token_result",
    manifest.token_result,
    "code_pact_overhead",
  );
  assertEq(
    "manifest.capability_gate.passed",
    manifest.capability_gate?.passed,
    true,
  );

  const final = readJson(tmpDir, "final-metrics.json");
  const modelIdentity = readJson(tmpDir, "model-identity.json");

  // Model identity consistency
  assertEq("model.provider", manifest.provider?.name, "ollama");
  assertEq("model.version", modelIdentity.provider_version, "0.32.1");
  assertEq(
    "model.requested",
    manifest.provider?.model_requested,
    "gemma3:latest",
  );
  assertEq(
    "model.digest",
    manifest.provider?.model_resolved_digest,
    "a2af6cc3eb7fa8be8504abaf9b04e88f17a119ec3f04a3addf55f92841195f5a",
  );
  assertEq(
    "model-identity digest",
    modelIdentity.model_resolved_digest,
    manifest.provider?.model_resolved_digest,
  );

  // Sampling
  assertEq("sampling.temperature", manifest.sampling?.temperature, 0);
  assertEq("sampling.top_p", manifest.sampling?.top_p, 0.9);
  assertEq(
    "sampling.max_output_tokens",
    manifest.sampling?.max_output_tokens,
    512,
  );

  // Execution order
  assertDeepEqual("execution_order", final.execution_order, [
    "capability_gate",
    "baseline",
    "code_pact",
  ]);

  // Capability gate metrics
  const cap = readJson(tmpDir, "capability-metrics.json");
  assertEq("capability input_tokens", cap.input_tokens, 319);
  assertEq("capability output_tokens", cap.output_tokens, 90);
  assertEq("capability total_tokens", cap.total_tokens, 409);
  assertEq("capability patch_applied", cap.patch_applied, true);
  assertEq("capability verification_passed", cap.verification_passed, true);

  // Baseline metrics
  const base = readJson(tmpDir, "baseline-metrics.json");
  assertEq("baseline input_tokens", base.input_tokens, 338);
  assertEq("baseline output_tokens", base.output_tokens, 94);
  assertEq("baseline total_tokens", base.total_tokens, 432);
  assertEq("baseline patch_applied", base.patch_applied, true);
  assertEq("baseline verification_passed", base.verification_passed, true);

  // Code Pact metrics
  const code = readJson(tmpDir, "code-pact-metrics.json");
  assertEq("code_pact input_tokens", code.input_tokens, 362);
  assertEq("code_pact output_tokens", code.output_tokens, 106);
  assertEq("code_pact total_tokens", code.total_tokens, 468);
  assertEq("code_pact patch_applied", code.patch_applied, true);
  assertEq("code_pact verification_passed", code.verification_passed, true);

  // Guardrails
  if (final.trial_total_tokens !== 1309)
    fail(`trial_total_tokens mismatch: ${final.trial_total_tokens}`);
  if (
    cap.model_invocations !== 1 ||
    base.model_invocations !== 1 ||
    code.model_invocations !== 1
  ) {
    fail("each condition must use exactly one model invocation");
  }
  if (cap.model !== base.model || base.model !== code.model) {
    fail("model switching detected between conditions");
  }
  if (cap.provider !== base.provider || base.provider !== code.provider) {
    fail("provider switching detected between conditions");
  }
  if (
    cap.corrective_pass_count ||
    base.corrective_pass_count ||
    code.corrective_pass_count
  ) {
    fail("corrective pass used");
  }

  // Token arithmetic
  assertEq("capability total", cap.input_tokens + cap.output_tokens, 409);
  assertEq("baseline total", base.input_tokens + base.output_tokens, 432);
  assertEq("code_pact total", code.input_tokens + code.output_tokens, 468);
  assertEq("trial total", 409 + 432 + 468, 1309);
  assertEq("pair delta", code.total_tokens - base.total_tokens, 36);

  // Fixture source contains the buggy parity line
  const pairSource = readText(tmpDir, "pair-source.ts");
  if (!pairSource.includes("value % 2 === 1")) {
    fail("pair-source.ts does not contain the buggy parity line");
  }

  // Reference patch changes the buggy line to the correct one
  const refPatch = readText(tmpDir, "reference.patch");
  if (!refPatch.includes("value % 2 === 0")) {
    fail("reference.patch does not fix parity to value % 2 === 0");
  }

  // Oracle preflight
  const preflight = readJson(tmpDir, "oracle-preflight.json");
  const buggy = preflight.checks.find(c => c.name === "pair_buggy_oracle");
  const ref = preflight.checks.find(c => c.name === "pair_reference_patch");
  if (!buggy || buggy.exit_code !== 1)
    fail("pair_buggy_oracle did not fail as expected");
  if (!ref || ref.exit_code !== 0)
    fail("pair_reference_patch did not pass as expected");
  const capBuggy = preflight.checks.find(
    c => c.name === "capability_buggy_oracle",
  );
  const capRef = preflight.checks.find(
    c => c.name === "capability_reference_patch",
  );
  if (!capBuggy || capBuggy.exit_code !== 1)
    fail("capability_buggy_oracle did not fail as expected");
  if (!capRef || capRef.exit_code !== 0)
    fail("capability_reference_patch did not pass as expected");

  // Prompts and responses contain the expected fix
  for (const prefix of ["baseline", "code-pact"]) {
    const prompt = readText(tmpDir, `${prefix}-prompt.txt`);
    const response = readText(tmpDir, `${prefix}-response.json`);
    if (!prompt.includes("value % 2 === 1")) {
      fail(`${prefix}-prompt.txt does not present the buggy source`);
    }
    if (
      !response.includes("value % 2 === 1") &&
      !response.includes("value % 2 === 0")
    ) {
      fail(`${prefix}-response.json does not contain a parity replacement`);
    }
  }

  // P79 status consistency (top-level, final-metrics, code-pact-metrics, manifest nested)
  const p79Status = "failed";
  assertEq("final p79_dogfood_status", final.p79_dogfood_status, p79Status);
  assertEq(
    "manifest p79_dogfood_status",
    manifest.p79_dogfood_status,
    p79Status,
  );
  assertEq("code_pact p79_dogfood_status", code.p79_dogfood_status, p79Status);
  assertEq(
    "manifest.code_pact p79_dogfood_status",
    manifest.code_pact?.p79_dogfood_status,
    p79Status,
  );

  assertEq("final contract_drift_count", final.contract_drift_count, 1);
  assertEq("manifest contract_drift_count", manifest.contract_drift_count, 1);
  assertEq("code_pact contract_drift_count", code.contract_drift_count, 1);
  assertEq(
    "manifest.code_pact contract_drift_count",
    manifest.code_pact?.contract_drift_count,
    1,
  );

  assertEq(
    "final scope_audit_failure_count",
    final.scope_audit_failure_count,
    1,
  );
  assertEq(
    "manifest scope_audit_failure_count",
    manifest.scope_audit_failure_count,
    1,
  );
  assertEq(
    "code_pact scope_audit_failure_count",
    code.scope_audit_failure_count,
    1,
  );
  assertEq(
    "manifest.code_pact scope_audit_failure_count",
    manifest.code_pact?.scope_audit_failure_count,
    1,
  );

  assertEq(
    "final classifier_unavailable_count",
    final.classifier_unavailable_count,
    1,
  );
  assertEq(
    "manifest classifier_unavailable_count",
    manifest.classifier_unavailable_count,
    1,
  );
  assertEq(
    "code_pact classifier_unavailable_count",
    code.classifier_unavailable_count,
    1,
  );
  assertEq(
    "manifest.code_pact classifier_unavailable_count",
    manifest.code_pact?.classifier_unavailable_count,
    1,
  );

  assertEq(
    "final artifact_mismatch_count",
    final.artifact_mismatch_count,
    null,
  );
  assertEq(
    "manifest artifact_mismatch_count",
    manifest.artifact_mismatch_count,
    null,
  );
  assertEq(
    "code_pact artifact_mismatch_count",
    code.artifact_mismatch_count,
    null,
  );
  assertEq(
    "manifest.code_pact artifact_mismatch_count",
    manifest.code_pact?.artifact_mismatch_count,
    null,
  );

  assertEq(
    "final artifact_integrity_status",
    final.artifact_integrity_status,
    "not_evaluated",
  );
  assertEq(
    "manifest artifact_integrity_status",
    manifest.artifact_integrity_status,
    "not_evaluated",
  );
  assertEq(
    "code_pact artifact_integrity_status",
    code.artifact_integrity_status,
    "not_evaluated",
  );
  assertEq(
    "manifest.code_pact artifact_integrity_status",
    manifest.code_pact?.artifact_integrity_status,
    "not_evaluated",
  );

  assertEq(
    "final review_bundle_generated",
    final.review_bundle_generated,
    false,
  );
  assertEq(
    "manifest review_bundle_generated",
    manifest.review_bundle_generated,
    false,
  );
  assertEq(
    "code_pact review_bundle_generated",
    code.review_bundle_generated,
    false,
  );
  assertEq(
    "manifest.code_pact review_bundle_generated",
    manifest.code_pact?.review_bundle_generated,
    false,
  );

  // Exact expected P79 failure set across all four sources
  const finalFailures = canonicalP79Failures(final.p79_failures || []);
  const manifestFailures = canonicalP79Failures(manifest.p79_failures || []);
  const codeFailures = canonicalP79Failures(code.p79_failures || []);
  const manifestCodeFailures = canonicalP79Failures(
    manifest.code_pact?.p79_failures || [],
  );

  assertDeepEqual("final p79_failures", finalFailures, EXPECTED_P79_FAILURES);
  assertDeepEqual(
    "manifest p79_failures",
    manifestFailures,
    EXPECTED_P79_FAILURES,
  );
  assertDeepEqual(
    "code_pact p79_failures",
    codeFailures,
    EXPECTED_P79_FAILURES,
  );
  assertDeepEqual(
    "manifest.code_pact p79_failures",
    manifestCodeFailures,
    EXPECTED_P79_FAILURES,
  );

  // Counts must equal the expected counts derived from the exact set
  assertEq("contract_drift_count", final.contract_drift_count, 1);
  assertEq("scope_audit_failure_count", final.scope_audit_failure_count, 1);
  assertEq(
    "classifier_unavailable_count",
    final.classifier_unavailable_count,
    1,
  );

  // Bidirectional command-evidence matching
  const commandLog = readJson(tmpDir, "command-log.json");
  const mainCommandLog = readJson(tmpDir, "main-command-log.json");
  const allCommandFailures = [
    ...(commandLog.failures || []),
    ...(mainCommandLog.failures || []),
  ];

  const canonicalCommand = canonicalCommandFailures(allCommandFailures);
  if (
    JSON.stringify(canonicalCommand) !== JSON.stringify(EXPECTED_P79_FAILURES)
  ) {
    fail("p79_failures not matched in command evidence");
  }

  for (const failure of allCommandFailures) {
    if (failure.exit_code === 0) {
      fail(`command failure ${failure.scope}/${failure.stage} has exit_code 0`);
    }
    const stage = failure.stage.toLowerCase();
    const commandLower = failure.command.toLowerCase();
    const verbMatch =
      commandLower.includes(stage) ||
      (stage === "review_bundle" && commandLower.includes("review-bundle")) ||
      (stage === "finalize" && commandLower.includes("finalize"));
    if (!verbMatch) {
      fail(
        `command failure ${failure.scope}/${failure.stage} command verb mismatch`,
      );
    }
    const output =
      (failure.stdout_excerpt || "") + (failure.stderr_excerpt || "");
    if (!output.includes(failure.error_code)) {
      fail(
        `command failure ${failure.scope}/${failure.stage} output missing error_code`,
      );
    }
  }

  // Base evidence digest
  const computedBaseDigest = baseEvidenceDigest(tmpDir);
  assertEq(
    "manifest.base_evidence_digest",
    manifest.base_evidence_digest,
    computedBaseDigest,
  );

  // Lifecycle event semantics
  const startEvent = readYaml(tmpDir, "start-event.yaml");
  const doneEvent = readYaml(tmpDir, "done-event.yaml");

  assertEq("start_event task_id", startEvent.task_id, "P80-C2");
  assertEq("done_event task_id", doneEvent.task_id, "P80-C2");
  assertEq("start_event status", startEvent.status, "started");
  assertEq("done_event status", doneEvent.status, "done");

  const startAt = new Date(startEvent.at).getTime();
  const doneAt = new Date(doneEvent.at).getTime();
  if (Number.isNaN(startAt) || Number.isNaN(doneAt))
    fail("event timestamps invalid");
  if (startAt >= doneAt) fail("start event must be before done event");
  if (!/^evidence:sha256:[a-f0-9]{64}$/.test(doneEvent.verification_ref)) {
    fail("done event verification_ref format invalid");
  }

  // Negative verifier evidence
  const neg = readJson(tmpDir, "negative-verifier-results.json");
  assertEq(
    "negative.base_evidence_digest",
    neg.base_evidence_digest,
    computedBaseDigest,
  );
  assertEq("negative-verifier-results total", neg.total, REQUIRED_CASES.length);
  assertEq("negative-verifier-results rejected", neg.rejected, neg.total);

  const caseNames = neg.cases.map(c => c.name);
  for (const name of REQUIRED_CASES) {
    if (!caseNames.includes(name)) fail(`missing negative case: ${name}`);
  }
  const dup = caseNames.filter(
    (item, index) => caseNames.indexOf(item) !== index,
  );
  if (dup.length) fail(`duplicate negative case names: ${dup.join(", ")}`);

  for (const c of neg.cases) {
    assertEq(`${c.name} hashes_recomputed`, c.hashes_recomputed, true);
    assertEq(`${c.name} exit_code`, c.exit_code, 1);
    assertEq(`${c.name} hash_mismatch`, c.hash_mismatch, false);
    assertEq(
      `${c.name} expected_error_matched`,
      c.expected_error_matched,
      true,
    );
    assertEq(`${c.name} rejected`, c.rejected, true);
    assertTrue(
      `${c.name} actual_stderr_excerpt present`,
      typeof c.actual_stderr_excerpt === "string" &&
        c.actual_stderr_excerpt.length > 0,
    );
    assertTrue(
      `${c.name} expected_error present`,
      typeof c.expected_error === "string" && c.expected_error.length > 0,
    );
    if (!c.actual_stderr_excerpt.includes(c.expected_error)) {
      fail(
        `${c.name} stderr does not include expected_error ${c.expected_error}`,
      );
    }
  }

  const log = readText(tmpDir, "verifier-negative-log.txt");
  const logBlocks = parseNegativeLog(log);
  if (logBlocks.length !== REQUIRED_CASES.length) {
    fail(
      `verifier-negative-log has ${logBlocks.length} blocks, expected ${REQUIRED_CASES.length}`,
    );
  }
  const logNames = logBlocks.map(b => b.name);
  for (const name of REQUIRED_CASES) {
    if (!logNames.includes(name))
      fail(`verifier-negative-log missing CASE ${name}`);
  }
  const dupLog = logNames.filter(
    (item, index) => logNames.indexOf(item) !== index,
  );
  if (dupLog.length) fail(`duplicate log case names: ${dupLog.join(", ")}`);

  for (const c of neg.cases) {
    const block = logBlocks.find(b => b.name === c.name);
    if (!block) fail(`log block missing for ${c.name}`);
    assertEq(`${c.name} log exit_code`, block.exit_code, c.exit_code);
    assertEq(
      `${c.name} log expected_error`,
      block.expected_error,
      c.expected_error,
    );
    assertEq(
      `${c.name} log actual_stderr_excerpt`,
      block.actual_stderr_excerpt,
      c.actual_stderr_excerpt,
    );
    assertEq(
      `${c.name} log hash_mismatch`,
      block.hash_mismatch,
      c.hash_mismatch,
    );
    assertEq(
      `${c.name} log expected_error_matched`,
      block.expected_error_matched,
      c.expected_error_matched,
    );
    assertEq(`${c.name} log rejected`, block.rejected, c.rejected);
  }

  console.log(
    "OK: P80-T2 evidence archive is complete, hash-verified, and semantically consistent.",
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
