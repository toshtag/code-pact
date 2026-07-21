#!/usr/bin/env node
// Verify P80-T2 trial evidence archive.
// Usage: node scripts/experiments/verify-p80-t2-evidence.mjs <zip-path>

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const zipPath = process.argv[2];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function readJson(tmp, f) {
  return JSON.parse(fs.readFileSync(path.join(tmp, f), "utf8"));
}

function readText(tmp, f) {
  return fs.readFileSync(path.join(tmp, f), "utf8");
}

function assertEq(label, actual, expected) {
  if (actual !== expected) {
    fail(`${label}: expected ${expected}, got ${actual}`);
  }
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
  "p80-task.yaml",
  "contract-lock.yaml",
  "start-event.yaml",
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
    "manifest.capability_gate.passed",
    manifest.capability_gate?.passed,
    true,
  );

  const final = readJson(tmpDir, "final-metrics.json");
  const modelIdentity = readJson(tmpDir, "model-identity.json");

  // Model identity consistency between manifest / model-identity.json / final-metrics
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
  assertEq(
    "execution_order",
    JSON.stringify(final.execution_order),
    JSON.stringify(["capability_gate", "baseline", "code_pact"]),
  );

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

  // P79 lifecycle / artifact integrity fields
  assertEq("p79_dogfood_status", manifest.p79_dogfood_status, "failed");
  assertEq("contract_drift_count", manifest.contract_drift_count, 1);
  assertEq("artifact_mismatch_count", manifest.artifact_mismatch_count, null);
  assertEq(
    "artifact_integrity_status",
    manifest.artifact_integrity_status,
    "not_evaluated",
  );
  assertEq("review_bundle_generated", manifest.review_bundle_generated, false);

  // Classification consistency
  if (manifest.product_effectiveness === "promising_single_pair") {
    fail(
      "product_effectiveness must not be promising_single_pair when both conditions pass and Code Pact uses more tokens",
    );
  }
  assertEq(
    "product_effectiveness",
    manifest.product_effectiveness,
    "not_demonstrated_single_pair",
  );

  console.log(
    "OK: P80-T2 evidence archive is complete, hash-verified, and semantically consistent.",
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
