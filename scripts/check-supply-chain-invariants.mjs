#!/usr/bin/env node
// Supply-chain invariant checker for GitHub Actions workflow files.
//
// Uses YAML parsing to structurally verify:
//   - All `uses:` (step-level and job-level) reference full 40-char commit SHAs
//   - publish.yml has top-level `permissions: {}`
//   - publish.yml has exactly 4 jobs: prepare, publish, verify, github-release
//   - Each job's permission map exactly matches the expected set (no extra permissions)
//   - Only the publish job has `id-token: write` and `environment: npm-publish`
//   - Only the github-release job has `contents: write`
//   - Privileged jobs (publish, github-release) use an exact action allowlist
//   - Privileged job run scripts are pinned by SHA-256 hash
//   - Privileged job step count and step names are fixed
//   - publish job has no checkout, pnpm, repository scripts, release:check, npm pack
//   - github-release job has no checkout, repository scripts, pnpm
//   - verify job has checkout (required for repository script execution)
//   - No NPM_TOKEN or NODE_AUTH_TOKEN secret references
//   - checkout steps have `persist-credentials: false`
//   - publish workflow only triggers on tags (push.tags, no branches, no workflow_dispatch)
//   - npm publish is preceded by release:check and tarball inspection (in prepare job)
//   - post-publish tarball verification exists (in verify job)
//   - SECURITY.md does not reference "built locally"
//
// Usage:
//   node scripts/check-supply-chain-invariants.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { createHash } from "node:crypto";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ACTION_REF = /^[^@\s]+@[0-9a-f]{40}$/;

const EXPECTED_JOB_PERMISSIONS = {
  prepare: { contents: "read" },
  publish: { contents: "read", "id-token": "write" },
  verify: { contents: "read" },
  "github-release": { contents: "write" },
};

// --- Canonical privileged job structures (source of truth) ---
// run: blocks are replaced with run-sha256 hashes for stability.

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortKeysDeep(child)]),
    );
  }
  return value;
}

function hashRun(run) {
  return createHash("sha256")
    .update(run.replace(/\r\n/g, "\n").trimEnd() + "\n")
    .digest("hex");
}

export const PUBLISH_RUN_HASH =
  "d74f5355bb7463a2fc41f009f127545b46280d482875d1fa08d989f516c7fa2e";
export const GITHUB_RELEASE_RUN_HASH =
  "fca11320656640fbea0fadfd233d548ad40ac0754bbb6be3c0e2a9193fac66cc";

export const EXPECTED_CANONICAL_JOBS = {
  publish: sortKeysDeep({
    name: "Publish to npm via Trusted Publishing",
    "runs-on": "ubuntu-latest",
    needs: "prepare",
    environment: "npm-publish",
    permissions: { contents: "read", "id-token": "write" },
    outputs: {
      published_now: "${{ steps.publish.outputs.published_now }}",
    },
    steps: [
      {
        name: "Download release artifact",
        uses: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
        with: { name: "release-artifact", path: "release-artifact" },
      },
      {
        name: "Set up Node",
        uses: "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
        with: {
          "node-version": 24,
          "package-manager-cache": false,
        },
      },
      {
        name: "Verify manifest and publish",
        id: "publish",
        env: {
          EXPECTED_TAG: "${{ github.ref_name }}",
          EXPECTED_COMMIT: "${{ github.sha }}",
          NPM_CONFIG_PROVENANCE: "true",
        },
        "run-sha256": PUBLISH_RUN_HASH,
      },
    ],
  }),
  "github-release": sortKeysDeep({
    name: "Create verified GitHub Release",
    "runs-on": "ubuntu-latest",
    needs: ["verify", "prepare", "publish"],
    permissions: { contents: "write" },
    steps: [
      {
        name: "Download release artifact",
        uses: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
        with: { name: "release-artifact", path: "release-artifact" },
      },
      {
        name: "Download integrity artifact",
        uses: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
        with: { name: "release-integrity", path: "release-integrity" },
      },
      {
        name: "Create or reconcile GitHub Release",
        env: {
          GH_TOKEN: "${{ github.token }}",
          GH_REPO: "${{ github.repository }}",
          TAG: "${{ github.ref_name }}",
          PUBLISHED_NOW: "${{ needs.publish.outputs.published_now }}",
        },
        "run-sha256": GITHUB_RELEASE_RUN_HASH,
      },
    ],
  }),
};

// Helper to canonicalize a parsed YAML job node for comparison
function canonicalizePrivilegedJob(jobNode) {
  const job = jobNode.toJSON();
  if (job.steps) {
    job.steps = job.steps.map(step => {
      if (typeof step.run === "string") {
        const { run, ...rest } = step;
        return { ...rest, "run-sha256": hashRun(run) };
      }
      return step;
    });
  }
  return sortKeysDeep(job);
}

// --- Workflow envelope canonical structure (top-level keys except jobs) ---

export const EXPECTED_WORKFLOW_ENVELOPE = sortKeysDeep({
  name: "Publish",
  on: {
    push: {
      tags: ["v*"],
    },
  },
  permissions: {},
  concurrency: {
    group: "npm-publish-${{ github.ref }}",
    "cancel-in-progress": false,
  },
});

function canonicalizeWorkflowEnvelope(doc) {
  const workflow = doc.toJSON();
  const { jobs: _jobs, ...envelope } = workflow;
  return sortKeysDeep(envelope);
}

function walkYml(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walkYml(full));
    else if (entry.endsWith(".yml") || entry.endsWith(".yaml")) out.push(full);
  }
  return out;
}

/**
 * Check all `uses:` references (step-level and job-level) are pinned to
 * exact 40-char commit SHAs. Rejects tag refs, branch refs, SHA+suffix,
 * SHA+subpath, short/long SHAs. Also checks job-level reusable workflow refs.
 * @param {string} content - workflow file content
 * @returns {string[]} list of violations
 */
export function checkActionShaPins(content) {
  const violations = [];
  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    violations.push(`YAML parse error: ${doc.errors[0].message}`);
    return violations;
  }

  const jobs = doc.get("jobs");
  if (!jobs || !jobs.items) return violations;

  for (const jobPair of jobs.items) {
    const jobKey = String(jobPair.key.value ?? jobPair.key);
    const job = jobPair.value;
    if (!job) continue;

    // Check job-level reusable workflow uses:
    const jobUses = job.get("uses");
    if (typeof jobUses === "string") {
      if (jobUses.startsWith("./")) {
        // local reusable workflow — allowed
      } else if (!ACTION_REF.test(jobUses)) {
        violations.push(
          `job "${jobKey}" job-level uses: ${jobUses} — must be pinned to exact 40-char commit SHA`,
        );
      }
    }

    // Check step-level uses:
    const steps = job.get("steps");
    if (!steps || !steps.items) continue;

    for (let i = 0; i < steps.items.length; i++) {
      const step = steps.items[i];
      const uses = step.get("uses");
      if (typeof uses !== "string") continue;
      if (uses.startsWith("./")) continue;
      if (!ACTION_REF.test(uses)) {
        violations.push(
          `job "${jobKey}" step ${i + 1}: ${uses} — must be pinned to exact 40-char commit SHA (no tags, branches, suffixes, or subpaths)`,
        );
      }
    }
  }

  return violations;
}

/**
 * Check that no NPM_TOKEN or NODE_AUTH_TOKEN references exist in content.
 * @param {string} content
 * @returns {string[]}
 */
export function checkNoTokenSecrets(content) {
  const violations = [];
  if (/NPM_TOKEN/.test(content)) {
    violations.push("NPM_TOKEN secret reference found");
  }
  if (/NODE_AUTH_TOKEN/.test(content)) {
    violations.push("NODE_AUTH_TOKEN secret reference found");
  }
  return violations;
}

/**
 * Collect all `uses:` action references from a workflow YAML content.
 * @param {string} content
 * @returns {string[]} list of action references
 */
export function collectActionRefs(content) {
  const refs = [];
  const doc = parseDocument(content);
  if (doc.errors.length > 0) return refs;

  const jobs = doc.get("jobs");
  if (!jobs || !jobs.items) return refs;

  for (const jobPair of jobs.items) {
    const job = jobPair.value;
    if (!job) continue;
    const steps = job.get("steps");
    if (!steps || !steps.items) continue;
    for (const step of steps.items) {
      const uses = step.get("uses");
      if (typeof uses === "string") refs.push(uses);
    }
  }
  return refs;
}

/**
 * Collect all `run:` script contents from a specific job in a workflow.
 * @param {object} doc - parsed YAML document
 * @param {string} jobName
 * @returns {string[]} list of run script contents
 */
function collectRunScripts(doc, jobName) {
  const scripts = [];
  const jobs = doc.get("jobs");
  if (!jobs || !jobs.items) return scripts;

  for (const jobPair of jobs.items) {
    const key = String(jobPair.key.value ?? jobPair.key);
    if (key !== jobName) continue;
    const job = jobPair.value;
    if (!job) continue;
    const steps = job.get("steps");
    if (!steps || !steps.items) continue;
    for (const step of steps.items) {
      const run = step.get("run");
      if (typeof run === "string") scripts.push(run);
    }
  }
  return scripts;
}

/**
 * Check if a job contains a checkout step.
 * @param {object} doc - parsed YAML document
 * @param {string} jobName
 * @returns {boolean}
 */
function jobHasCheckout(doc, jobName) {
  const refs = collectActionRefsForJob(doc, jobName);
  return refs.some(r => r.startsWith("actions/checkout"));
}

/**
 * Collect all `uses:` action references from a specific job.
 * @param {object} doc - parsed YAML document
 * @param {string} jobName
 * @returns {string[]}
 */
function collectActionRefsForJob(doc, jobName) {
  const refs = [];
  const jobs = doc.get("jobs");
  if (!jobs || !jobs.items) return refs;

  for (const jobPair of jobs.items) {
    const key = String(jobPair.key.value ?? jobPair.key);
    if (key !== jobName) continue;
    const job = jobPair.value;
    if (!job) continue;
    const steps = job.get("steps");
    if (!steps || !steps.items) continue;
    for (const step of steps.items) {
      const uses = step.get("uses");
      if (typeof uses === "string") refs.push(uses);
    }
  }
  return refs;
}

/**
 * Get the permissions object for a specific job.
 * @param {object} doc
 * @param {string} jobName
 * @returns {object|null}
 */
function getJobPermissions(doc, jobName) {
  const jobs = doc.get("jobs");
  if (!jobs || !jobs.items) return null;

  for (const jobPair of jobs.items) {
    const key = String(jobPair.key.value ?? jobPair.key);
    if (key !== jobName) continue;
    const job = jobPair.value;
    if (!job) return null;
    const perms = job.get("permissions");
    if (!perms) return null;
    if (typeof perms === "string") return perms;
    const result = {};
    if (perms.items) {
      for (const pair of perms.items) {
        const k = String(pair.key.value ?? pair.key);
        const v = String(pair.value.value ?? pair.value);
        result[k] = v;
      }
    }
    return result;
  }
  return null;
}

function stableEntries(value) {
  return Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b));
}

function actionName(ref) {
  const idx = ref.lastIndexOf("@");
  return idx > 0 ? ref.slice(0, idx) : ref;
}

function normalizeRun(value) {
  return value.replace(/\r\n/g, "\n").trimEnd() + "\n";
}

function getJobSteps(doc, jobName) {
  const jobs = doc.get("jobs");
  if (!jobs || !jobs.items) return [];
  for (const jobPair of jobs.items) {
    const key = String(jobPair.key.value ?? jobPair.key);
    if (key !== jobName) continue;
    const job = jobPair.value;
    if (!job) return [];
    const steps = job.get("steps");
    if (!steps || !steps.items) return [];
    return steps.items;
  }
  return [];
}

function getWorkflowJobs(doc) {
  const jobs = doc.get("jobs");
  return jobs?.items ?? [];
}

function getJobNode(doc, jobName) {
  for (const jobPair of getWorkflowJobs(doc)) {
    const key = String(jobPair.key.value ?? jobPair.key);
    if (key === jobName) return jobPair.value;
  }
  return null;
}

function getWorkflowJobNames(doc) {
  return getWorkflowJobs(doc).map(jobPair =>
    String(jobPair.key.value ?? jobPair.key),
  );
}

function workflowCheckoutCredentialsViolations(doc, rel) {
  const violations = [];
  for (const jobPair of getWorkflowJobs(doc)) {
    const job = jobPair.value;
    if (!job) continue;
    const steps = job.get("steps");
    if (!steps || !steps.items) continue;
    for (const step of steps.items) {
      const uses = step.get("uses");
      if (typeof uses !== "string" || !uses.startsWith("actions/checkout")) {
        continue;
      }
      const withBlock = step.get("with");
      if (!withBlock || withBlock.get("persist-credentials") !== false) {
        violations.push(
          `${rel}: checkout in job "${jobPair.key.value ?? jobPair.key}" missing persist-credentials: false`,
        );
      }
    }
  }
  return violations;
}

function workflowHasPushMainAndPullRequest(doc) {
  const on = doc.get("on") ?? doc.get(true);
  if (!on || typeof on !== "object") return false;
  const onKeys = on.items ? on.items.map(p => String(p.key.value ?? p.key)) : [];
  if (!onKeys.includes("pull_request") || !onKeys.includes("push")) return false;
  const push = on.get("push");
  const branches = push?.get("branches");
  if (!branches?.items) return false;
  return branches.items.some(item => String(item.value ?? item) === "main");
}

function jobRunsOn(job, expected) {
  return job?.get("runs-on") === expected;
}

function jobSetupNodeVersion(doc, jobName) {
  for (const step of getJobSteps(doc, jobName)) {
    const uses = step.get("uses");
    if (typeof uses !== "string" || !uses.startsWith("actions/setup-node")) {
      continue;
    }
    const withBlock = step.get("with");
    const value = withBlock?.get("node-version");
    return String(value);
  }
  return null;
}

function checkFastCiWorkflow(ciDoc, ciContent) {
  const violations = [];
  const jobNames = getWorkflowJobNames(ciDoc);
  const expectedJobs = ["fast", "ci-status"];
  const hasOnlyExpectedJobs =
    expectedJobs.every(job => jobNames.includes(job)) &&
    jobNames.every(job => expectedJobs.includes(job));
  if (!hasOnlyExpectedJobs) {
    violations.push(
      `ci.yml: required PR CI must contain only fast and ci-status jobs (found: ${jobNames.join(", ")})`,
    );
  }

  if (!workflowHasPushMainAndPullRequest(ciDoc)) {
    violations.push("ci.yml: must run on pull_request and push to main");
  }

  const fastJob = getJobNode(ciDoc, "fast");
  if (!fastJob) {
    violations.push("ci.yml: missing fast job");
    return violations;
  }

  if (!jobRunsOn(fastJob, "ubuntu-latest")) {
    violations.push("ci.yml: fast job must run on ubuntu-latest");
  }
  if (jobSetupNodeVersion(ciDoc, "fast") !== "22") {
    violations.push("ci.yml: fast job must use Node 22");
  }

  const fastScripts = collectRunScripts(ciDoc, "fast");
  if (!fastScripts.some(script => script.trim() === "pnpm install --frozen-lockfile")) {
    violations.push("ci.yml: fast job must install with pnpm install --frozen-lockfile");
  }
  if (!fastScripts.some(script => script.trim() === "pnpm test:ci")) {
    violations.push("ci.yml: fast job must run pnpm test:ci");
  }

  const forbiddenFastPatterns = [
    ["full integration", /vitest\s+run\s+--config\s+vitest\.integration\.config\.ts|test:integration:full|pnpm\s+test:integration(?!:smoke)/],
    ["docs checks", /pnpm\s+check:docs/],
    ["filesystem containment checks", /pnpm\s+check:fs-containment/],
    ["filesystem authority checks", /pnpm\s+check:fs-authority/],
    ["security hardening checks", /pnpm\s+check:security-hardening/],
    ["plan lint", /plan\s+lint\s+--include-quality\s+--strict\s+--json/],
    ["plan analyze", /plan\s+analyze\s+--strict\s+--json/],
    ["initialized-project smoke", /init\s+--non-interactive|doctor\s+--json/],
  ];
  for (const [label, pattern] of forbiddenFastPatterns) {
    if (fastScripts.some(script => pattern.test(script))) {
      violations.push(`ci.yml: fast job must not run ${label}`);
    }
  }

  if (/windows-latest/.test(ciContent)) {
    violations.push("ci.yml: required PR CI must not run Windows jobs");
  }
  if (/node-version:\s*(?:\$\{\{\s*matrix\.node-version\s*\}\}|24)\b/.test(ciContent)) {
    violations.push("ci.yml: required PR CI must not run Node 24 or a Node version matrix");
  }
  if (/matrix:/.test(ciContent)) {
    violations.push("ci.yml: required PR CI must not use a matrix");
  }

  return violations;
}

function findWindowsProcessControlWorkflow(workflowDocs, cancellationCoverageViolations) {
  for (const { rel, doc } of workflowDocs) {
    for (const jobPair of getWorkflowJobs(doc)) {
      const jobName = String(jobPair.key.value ?? jobPair.key);
      const job = jobPair.value;
      if (!jobRunsOn(job, "windows-latest")) continue;

      const scripts = collectRunScripts(doc, jobName);
      const hasCoverage =
        scripts.some(script => script.trim() === "pnpm check:toolchain-binaries") &&
        scripts.some(script => script.trim() === "pnpm build") &&
        scripts.some(script => /\btests\/unit\/commands\/verify-process\.test\.ts\b/.test(script)) &&
        scripts.some(
          script =>
            script.trim() ===
            "pnpm exec vitest run --config vitest.integration.config.ts tests/integration/verify-timeout-abort.test.ts",
        ) &&
        !scripts.some(script => /(?:^|\s)-t\s+|--testNamePattern\b/.test(script)) &&
        cancellationCoverageViolations.length === 0;
      if (hasCoverage) {
        return { rel, jobName };
      }
    }
  }
  return null;
}

export function checkCancellationCoverage(testContent) {
  const violations = [];
  if (!/if \(process\.platform !== "win32"\)/.test(testContent)) {
    violations.push(
      "verify-timeout-abort.test.ts: POSIX CLI signal cancellation must be explicitly POSIX-gated",
    );
  }
  if (!/it\.each\(\["SIGINT", "SIGTERM"\] as const\)/.test(testContent)) {
    violations.push(
      "verify-timeout-abort.test.ts: POSIX SIGINT/SIGTERM cancellation cases are missing",
    );
  }
  if (!/cancels task complete on %s, removes descendants, and records no event/.test(testContent)) {
    violations.push(
      "verify-timeout-abort.test.ts: task complete signal cancellation test is missing",
    );
  }
  if (!/cause_code:\s*"ABORTED"/.test(testContent)) {
    violations.push(
      "verify-timeout-abort.test.ts: cancellation test must assert cause_code ABORTED",
    );
  }
  if (!/loadMergedProgress\(dir\)\)\.log\.events\)\.toHaveLength\(0\)/.test(testContent)) {
    violations.push(
      "verify-timeout-abort.test.ts: cancellation test must assert no done event is recorded",
    );
  }
  if (
    !/describe\.runIf\(process\.platform === "win32"\)\("Windows bounded-command cancellation contract"/.test(
      testContent,
    )
  ) {
    violations.push(
      "verify-timeout-abort.test.ts: Windows bounded-command cancellation coverage is missing",
    );
  }
  if (!/runBoundedCommand\("node long-parent\.mjs", dir,/.test(testContent)) {
    violations.push(
      "verify-timeout-abort.test.ts: Windows coverage must exercise runBoundedCommand directly",
    );
  }
  if (!/timedOut:\s*true/.test(testContent) || !/aborted:\s*true/.test(testContent)) {
    violations.push(
      "verify-timeout-abort.test.ts: Windows coverage must assert timeout and AbortSignal cancellation",
    );
  }
  if (!/strategy:\s*"taskkill"/.test(testContent)) {
    violations.push("verify-timeout-abort.test.ts: Windows coverage must assert taskkill cleanup");
  }
  return violations;
}

// Backward-compatible export name for existing tests/imports. The invariant is
// intentionally no longer Windows-signal-specific: Windows synthetic SIGINT from
// ChildProcess.kill() is not a reliable contract. Windows CI verifies timeout,
// AbortSignal, taskkill, and process-tree cleanup; POSIX CI verifies CLI signal
// translation.
export const checkWindowsCancellationCoverage = checkCancellationCoverage;


/**
 * Verify the reviewed pnpm/Vite/esbuild versions and the explicit lifecycle-script
 * policy in package.json, pnpm-workspace.yaml, and pnpm-lock.yaml.
 */
export function checkToolchainPins(packageContent, workspaceContent, lockContent) {
  const violations = [];
  let pkg;
  try {
    pkg = JSON.parse(packageContent);
  } catch (error) {
    return [
      `package.json parse error: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }

  if (pkg.packageManager !== "pnpm@10.34.2") {
    violations.push('package.json: packageManager must be exactly "pnpm@10.34.2"');
  }
  if (pkg.devDependencies?.vite !== "^6.4.3") {
    violations.push('package.json: devDependencies.vite must be "^6.4.3"');
  }
  if (pkg.devDependencies?.esbuild !== "0.28.1") {
    violations.push('package.json: devDependencies.esbuild must be exactly "0.28.1"');
  }

  const workspace = parseDocument(workspaceContent);
  if (workspace.errors.length > 0) {
    violations.push(`pnpm-workspace.yaml parse error: ${workspace.errors[0].message}`);
  } else {
    if (workspace.getIn(["overrides", "esbuild"]) !== "0.28.1") {
      violations.push('pnpm-workspace.yaml: overrides.esbuild must be exactly "0.28.1"');
    }
    if (workspace.getIn(["allowBuilds", "esbuild"]) !== false) {
      violations.push("pnpm-workspace.yaml: allowBuilds.esbuild must be false");
    }
  }

  const lock = parseDocument(lockContent);
  if (lock.errors.length > 0) {
    violations.push(`pnpm-lock.yaml parse error: ${lock.errors[0].message}`);
    return violations;
  }
  const lockObject = lock.toJSON();
  const importer = lockObject?.importers?.["."]?.devDependencies ?? {};
  const baseVersion = value => String(value ?? "").split("(", 1)[0];
  if (
    importer.vite?.specifier !== "^6.4.3" ||
    baseVersion(importer.vite?.version) !== "6.4.3"
  ) {
    violations.push("pnpm-lock.yaml: root importer must resolve vite 6.4.3 from ^6.4.3");
  }
  if (
    importer.esbuild?.specifier !== "0.28.1" ||
    baseVersion(importer.esbuild?.version) !== "0.28.1"
  ) {
    violations.push("pnpm-lock.yaml: root importer must resolve esbuild 0.28.1 exactly");
  }

  const lockKeys = [
    ...Object.keys(lockObject?.packages ?? {}),
    ...Object.keys(lockObject?.snapshots ?? {}),
  ];
  const viteVersions = lockKeys
    .map(key => /^vite@([^()]+)(?:\(|$)/.exec(key)?.[1])
    .filter(Boolean);
  const esbuildVersions = lockKeys
    .map(key => /^esbuild@([^()]+)(?:\(|$)/.exec(key)?.[1])
    .filter(Boolean);
  if (viteVersions.length === 0 || viteVersions.some(version => version !== "6.4.3")) {
    violations.push(
      `pnpm-lock.yaml: every vite package must be 6.4.3 (found: ${viteVersions.join(", ") || "none"})`,
    );
  }
  if (
    esbuildVersions.length === 0 ||
    esbuildVersions.some(version => version !== "0.28.1")
  ) {
    violations.push(
      `pnpm-lock.yaml: every esbuild package must be 0.28.1 (found: ${esbuildVersions.join(", ") || "none"})`,
    );
  }

  return violations;
}

/**
 * Run all supply-chain invariant checks.
 * @param {string} root - repo root path
 * @returns {{failures: number}}
 */
export function checkSupplyChainInvariants(root) {
  let failures = 0;

  function fail(name, detail) {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }

  function pass(name) {
    console.log(`  ✓ ${name}`);
  }

  const _read = rel => readFileSync(join(root, rel), "utf8");
  const workflowDir = join(root, ".github", "workflows");
  const ymlFiles = walkYml(workflowDir);

  console.log("Supply-chain invariants:");

  // 1. All uses: are exact 40-char SHAs (across all workflow files, including job-level)
  let allShaPinned = true;
  for (const file of ymlFiles) {
    const rel = file.replace(`${root}/`, "");
    const content = _read(rel);
    const violations = checkActionShaPins(content);
    if (violations.length > 0) {
      allShaPinned = false;
      for (const v of violations) {
        fail(`${rel}: ${v}`);
      }
    }
  }
  if (allShaPinned && ymlFiles.length > 0) {
    pass("All workflow Action references are exact 40-char SHA pinned");
  }

  // 2. Check publish.yml structural invariants
  let publishContent;
  try {
    publishContent = _read(".github/workflows/publish.yml");
  } catch {
    fail("publish.yml: file not found");
    publishContent = null;
  }

  if (publishContent) {
    const doc = parseDocument(publishContent);
    if (doc.errors.length > 0) {
      fail("publish.yml: YAML parse error", doc.errors[0].message);
    } else {
      // Top-level permissions: {}
      const topLevelPerms = doc.get("permissions");
      if (
        topLevelPerms &&
        (typeof topLevelPerms === "string"
          ? topLevelPerms === "{}"
          : Object.keys(topLevelPerms.toJSON?.() ?? {}).length === 0)
      ) {
        pass("publish.yml: top-level permissions: {}");
      } else {
        fail("publish.yml: missing top-level permissions: {}");
      }

      // Trigger: only push.tags, no branches, no workflow_dispatch
      const on = doc.get("on") ?? doc.get(true); // `on` may be parsed as boolean true
      let triggerOk = false;
      if (on && typeof on === "object") {
        const onKeys = on.items
          ? on.items.map(p => String(p.key.value ?? p.key))
          : [];
        const hasPush = onKeys.includes("push");
        const hasOther = onKeys.some(
          k => k !== "push" && k !== "true" && k !== "on",
        );
        if (hasPush && !hasOther) {
          const push = on.get("push");
          if (push) {
            const hasTags = push.get("tags");
            const hasBranches = push.get("branches");
            if (hasTags && !hasBranches) {
              triggerOk = true;
            }
          }
        }
      }
      if (triggerOk) {
        pass(
          "publish.yml: triggers only on push.tags (no branches, no workflow_dispatch)",
        );
      } else {
        fail(
          "publish.yml: should trigger only on push.tags (no branches, no workflow_dispatch)",
        );
      }

      // Workflow envelope canonical exact match (top-level keys except jobs)
      const actualEnvelope = canonicalizeWorkflowEnvelope(doc);
      const expectedEnvelope = EXPECTED_WORKFLOW_ENVELOPE;
      const actualEnvelopeStr = JSON.stringify(actualEnvelope);
      const expectedEnvelopeStr = JSON.stringify(expectedEnvelope);
      if (actualEnvelopeStr === expectedEnvelopeStr) {
        pass("publish.yml: workflow envelope canonical exact match");
      } else {
        const actualKeys = Object.keys(actualEnvelope);
        const expectedKeys = Object.keys(expectedEnvelope);
        const extraKeys = actualKeys.filter(k => !expectedKeys.includes(k));
        const missingKeys = expectedKeys.filter(k => !actualKeys.includes(k));
        let detail;
        if (extraKeys.length > 0) {
          detail = `unexpected top-level keys: ${extraKeys.join(", ")}`;
        } else if (missingKeys.length > 0) {
          detail = `missing top-level keys: ${missingKeys.join(", ")}`;
        } else {
          for (const key of expectedKeys) {
            if (
              JSON.stringify(actualEnvelope[key]) !==
              JSON.stringify(expectedEnvelope[key])
            ) {
              detail = `key "${key}" mismatch: expected ${JSON.stringify(expectedEnvelope[key]).slice(0, 200)}, found ${JSON.stringify(actualEnvelope[key]).slice(0, 200)}`;
              break;
            }
          }
          if (!detail) detail = "structure mismatch";
        }
        fail("publish.yml: workflow envelope canonical mismatch", detail);
      }

      // Job structure: exactly prepare, publish, verify, github-release
      const jobs = doc.get("jobs");
      const jobNames =
        jobs && jobs.items
          ? jobs.items.map(p => String(p.key.value ?? p.key))
          : [];
      const expectedJobs = ["prepare", "publish", "verify", "github-release"];
      const hasAllJobs = expectedJobs.every(j => jobNames.includes(j));
      const hasExtraJobs = jobNames.some(j => !expectedJobs.includes(j));
      if (hasAllJobs && !hasExtraJobs) {
        pass(
          "publish.yml: has exactly 4 jobs (prepare, publish, verify, github-release)",
        );
      } else {
        fail(
          "publish.yml: job structure must be exactly prepare, publish, verify, github-release",
          `found: ${jobNames.join(", ")}`,
        );
      }

      // Permission map exact match for each job
      for (const jobName of expectedJobs) {
        const actual = getJobPermissions(doc, jobName);
        const expected = EXPECTED_JOB_PERMISSIONS[jobName];
        const actualStr = JSON.stringify(stableEntries(actual));
        const expectedStr = JSON.stringify(stableEntries(expected));
        if (actualStr === expectedStr) {
          pass(`publish.yml: ${jobName} job permission map exact match`);
        } else {
          fail(
            `publish.yml: ${jobName} job permission map mismatch`,
            `expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
          );
        }
      }

      // publish job has environment: npm-publish
      let publishHasEnv = false;
      if (jobs && jobs.items) {
        for (const jobPair of jobs.items) {
          const key = String(jobPair.key.value ?? jobPair.key);
          if (key === "publish") {
            const env = jobPair.value?.get("environment");
            publishHasEnv = env === "npm-publish";
          }
        }
      }
      if (publishHasEnv) {
        pass("publish.yml: publish job has environment: npm-publish");
      } else {
        fail("publish.yml: publish job must have environment: npm-publish");
      }

      // Privileged job checks: canonical structure exact match (source of truth)
      for (const jobName of ["publish", "github-release"]) {
        let actualJobNode = null;
        if (jobs && jobs.items) {
          for (const jobPair of jobs.items) {
            const key = String(jobPair.key.value ?? jobPair.key);
            if (key === jobName) {
              actualJobNode = jobPair.value;
              break;
            }
          }
        }
        if (!actualJobNode) {
          fail(`publish.yml: ${jobName} job not found`);
          continue;
        }

        const actualCanonical = canonicalizePrivilegedJob(actualJobNode);
        const expectedCanonical = EXPECTED_CANONICAL_JOBS[jobName];
        const actualStr = JSON.stringify(actualCanonical);
        const expectedStr = JSON.stringify(expectedCanonical);

        if (actualStr === expectedStr) {
          pass(`publish.yml: ${jobName} job canonical structure exact match`);
        } else {
          // Find the first differing key for a helpful error message
          const actualKeys = Object.keys(actualCanonical);
          const expectedKeys = Object.keys(expectedCanonical);
          const extraKeys = actualKeys.filter(k => !expectedKeys.includes(k));
          const missingKeys = expectedKeys.filter(k => !actualKeys.includes(k));
          let detail;
          if (extraKeys.length > 0) {
            detail = `unexpected keys: ${extraKeys.join(", ")}`;
          } else if (missingKeys.length > 0) {
            detail = `missing keys: ${missingKeys.join(", ")}`;
          } else {
            // Find first value mismatch
            for (const key of expectedKeys) {
              if (
                JSON.stringify(actualCanonical[key]) !==
                JSON.stringify(expectedCanonical[key])
              ) {
                detail = `key "${key}" mismatch: expected ${JSON.stringify(expectedCanonical[key]).slice(0, 200)}, found ${JSON.stringify(actualCanonical[key]).slice(0, 200)}`;
                break;
              }
            }
            if (!detail) detail = "structure mismatch";
          }
          fail(
            `publish.yml: ${jobName} job canonical structure mismatch`,
            detail,
          );
        }
      }

      // publish job must NOT have checkout, pnpm, repository scripts, release:check, npm pack
      const publishActionRefs = collectActionRefsForJob(doc, "publish");
      const publishHasCheckout = publishActionRefs.some(r =>
        r.startsWith("actions/checkout"),
      );
      const publishHasPnpm = publishActionRefs.some(r => r.startsWith("pnpm/"));
      const publishScripts = collectRunScripts(doc, "publish");
      const publishHasRepoScript = publishScripts.some(s =>
        /scripts\//.test(s),
      );
      const publishHasReleaseCheck = publishScripts.some(s =>
        /release:check/.test(s),
      );
      const publishHasNpmPack = publishScripts.some(s => /npm pack/.test(s));
      const publishHasPnpmInstall = publishScripts.some(s =>
        /pnpm install/.test(s),
      );

      if (!publishHasCheckout) {
        pass("publish.yml: publish job has no checkout");
      } else {
        fail("publish.yml: publish job must NOT have checkout");
      }
      if (!publishHasPnpm) {
        pass("publish.yml: publish job has no pnpm action");
      } else {
        fail("publish.yml: publish job must NOT have pnpm action");
      }
      if (!publishHasRepoScript) {
        pass("publish.yml: publish job has no repository scripts");
      } else {
        fail("publish.yml: publish job must NOT run repository scripts");
      }
      if (!publishHasReleaseCheck) {
        pass("publish.yml: publish job has no release:check");
      } else {
        fail("publish.yml: publish job must NOT run release:check");
      }
      if (!publishHasNpmPack) {
        pass("publish.yml: publish job has no npm pack");
      } else {
        fail("publish.yml: publish job must NOT run npm pack");
      }
      if (!publishHasPnpmInstall) {
        pass("publish.yml: publish job has no pnpm install");
      } else {
        fail("publish.yml: publish job must NOT run pnpm install");
      }

      // github-release job must NOT have checkout, repository scripts, pnpm
      const ghReleaseRefs = collectActionRefsForJob(doc, "github-release");
      const ghReleaseHasCheckout = ghReleaseRefs.some(r =>
        r.startsWith("actions/checkout"),
      );
      const ghReleaseScripts = collectRunScripts(doc, "github-release");
      const ghReleaseHasRepoScript = ghReleaseScripts.some(s =>
        /scripts\//.test(s),
      );
      const ghReleaseHasPnpm = ghReleaseRefs.some(r => r.startsWith("pnpm/"));

      if (!ghReleaseHasCheckout) {
        pass("publish.yml: github-release job has no checkout");
      } else {
        fail("publish.yml: github-release job must NOT have checkout");
      }
      if (!ghReleaseHasRepoScript) {
        pass("publish.yml: github-release job has no repository scripts");
      } else {
        fail("publish.yml: github-release job must NOT run repository scripts");
      }
      if (!ghReleaseHasPnpm) {
        pass("publish.yml: github-release job has no pnpm action");
      } else {
        fail("publish.yml: github-release job must NOT have pnpm action");
      }

      // prepare job has release:check and tarball inspection
      const prepareScripts = collectRunScripts(doc, "prepare");
      const hasReleaseCheck = prepareScripts.some(s => /release:check/.test(s));
      const hasTarballCheck = prepareScripts.some(s =>
        /check-package-tarball/.test(s),
      );
      if (hasReleaseCheck) {
        pass("publish.yml: prepare job runs release:check");
      } else {
        fail("publish.yml: prepare job must run release:check");
      }
      if (hasTarballCheck) {
        pass("publish.yml: prepare job runs tarball inspection");
      } else {
        fail("publish.yml: prepare job must run tarball inspection");
      }

      // verify job has post-publish tarball verification
      const verifyScripts = collectRunScripts(doc, "verify");
      const hasVerify = verifyScripts.some(s =>
        /verify-published-tarball/.test(s),
      );
      if (hasVerify) {
        pass("publish.yml: verify job runs post-publish tarball verification");
      } else {
        fail(
          "publish.yml: verify job must run post-publish tarball verification",
        );
      }

      // verify job must have checkout (required for repository script execution)
      const verifyRefs = collectActionRefsForJob(doc, "verify");
      const verifyHasCheckout = verifyRefs.some(r =>
        r.startsWith("actions/checkout"),
      );
      if (verifyHasCheckout) {
        pass("publish.yml: verify job has checkout (required for scripts)");
      } else {
        fail(
          "publish.yml: verify job must have checkout (runs repository scripts)",
        );
      }

      // publish job runs npm publish with --ignore-scripts
      const hasIgnoreScripts = publishScripts.some(s =>
        /npm publish.*--ignore-scripts/.test(s),
      );
      if (hasIgnoreScripts) {
        pass("publish.yml: publish job uses --ignore-scripts");
      } else {
        fail("publish.yml: publish job must use --ignore-scripts");
      }

      // OIDC invariant: setup-node must NOT have registry-url
      let setupNodeHasRegistryUrl = false;
      if (jobs && jobs.items) {
        for (const jobPair of jobs.items) {
          const key = String(jobPair.key.value ?? jobPair.key);
          if (key !== "publish") continue;
          const steps = jobPair.value?.get("steps");
          if (!steps || !steps.items) continue;
          for (const step of steps.items) {
            const uses = step.get("uses");
            if (
              typeof uses === "string" &&
              uses.startsWith("actions/setup-node")
            ) {
              const withBlock = step.get("with");
              if (withBlock && withBlock.get("registry-url") !== undefined) {
                setupNodeHasRegistryUrl = true;
              }
            }
          }
        }
      }
      if (!setupNodeHasRegistryUrl) {
        pass("publish.yml: setup-node has no registry-url (OIDC safe)");
      } else {
        fail(
          "publish.yml: setup-node must NOT have registry-url (generates empty NODE_AUTH_TOKEN .npmrc that blocks OIDC)",
        );
      }

      // OIDC invariant: npm view and npm publish must use --registry flag
      const hasViewRegistry = publishScripts.some(s =>
        /npm view.*--registry=/.test(s),
      );
      const hasPublishRegistry = publishScripts.some(s =>
        /npm publish.*--registry=/.test(s),
      );
      if (hasViewRegistry) {
        pass("publish.yml: npm view uses --registry flag");
      } else {
        fail(
          "publish.yml: npm view must use --registry flag to prevent env override",
        );
      }
      if (hasPublishRegistry) {
        pass("publish.yml: npm publish uses --registry flag");
      } else {
        fail(
          "publish.yml: npm publish must use --registry flag to prevent env override",
        );
      }

      // No NPM_TOKEN or NODE_AUTH_TOKEN
      const tokenViolations = checkNoTokenSecrets(publishContent);
      if (tokenViolations.length === 0) {
        pass("publish.yml: no NPM_TOKEN or NODE_AUTH_TOKEN references");
      } else {
        for (const v of tokenViolations) fail(`publish.yml: ${v}`);
      }

      // All checkout steps have persist-credentials: false
      if (jobs && jobs.items) {
        let checkoutOk = true;
        for (const jobPair of jobs.items) {
          const job = jobPair.value;
          if (!job) continue;
          const steps = job.get("steps");
          if (!steps || !steps.items) continue;
          for (const step of steps.items) {
            const uses = step.get("uses");
            if (
              typeof uses === "string" &&
              uses.startsWith("actions/checkout")
            ) {
              const withBlock = step.get("with");
              if (
                !withBlock ||
                withBlock.get("persist-credentials") !== false
              ) {
                checkoutOk = false;
                fail(
                  `publish.yml: checkout in job "${jobPair.key.value ?? jobPair.key}" missing persist-credentials: false`,
                );
              }
            }
          }
        }
        if (checkoutOk) {
          pass(
            "publish.yml: all checkout steps have persist-credentials: false",
          );
        }
      }

      // Job dependencies
      const expectedNeeds = {
        publish: ["prepare"],
        verify: ["publish", "prepare"],
        "github-release": ["verify", "prepare", "publish"],
      };
      for (const [jobName, expectedDeps] of Object.entries(expectedNeeds)) {
        if (jobs && jobs.items) {
          for (const jobPair of jobs.items) {
            const key = String(jobPair.key.value ?? jobPair.key);
            if (key !== jobName) continue;
            const needs = jobPair.value?.get("needs");
            let actualDeps = [];
            if (typeof needs === "string") {
              actualDeps = [needs];
            } else if (needs && needs.items) {
              actualDeps = needs.items.map(n => String(n.value ?? n));
            }
            const sortedActual = [...actualDeps].sort();
            const sortedExpected = [...expectedDeps].sort();
            if (
              JSON.stringify(sortedActual) === JSON.stringify(sortedExpected)
            ) {
              pass(
                `publish.yml: ${jobName} job needs [${sortedExpected.join(", ")}]`,
              );
            } else {
              fail(
                `publish.yml: ${jobName} job must need [${sortedExpected.join(", ")}]`,
                `found: [${sortedActual.join(", ")}]`,
              );
            }
          }
        }
      }
    }
  }

  // 3. Check CI workflow policy: fast required PR gate in ci.yml, deeper
  // confidence gates outside required PR CI.
  const workflowDocs = [];
  for (const file of ymlFiles) {
    const rel = file.replace(`${root}/`, "");
    const content = _read(rel);
    const doc = parseDocument(content);
    if (doc.errors.length === 0) {
      workflowDocs.push({ rel, content, doc });
    }
  }

  let ciContent;
  try {
    ciContent = _read(".github/workflows/ci.yml");
    const ciTokenViolations = checkNoTokenSecrets(ciContent);
    if (ciTokenViolations.length === 0) {
      pass("ci.yml: no NPM_TOKEN or NODE_AUTH_TOKEN references");
    } else {
      for (const v of ciTokenViolations) fail(`ci.yml: ${v}`);
    }

    // Check ci.yml checkout persist-credentials via YAML
    const ciDoc = parseDocument(ciContent);
    if (ciDoc.errors.length === 0) {
      const ciCheckoutViolations = workflowCheckoutCredentialsViolations(
        ciDoc,
        "ci.yml",
      );
      if (ciCheckoutViolations.length === 0) {
        pass("ci.yml: all checkout steps have persist-credentials: false");
      } else {
        for (const violation of ciCheckoutViolations) fail(violation);
      }

      const fastCiViolations = checkFastCiWorkflow(ciDoc, ciContent);
      if (fastCiViolations.length === 0) {
        pass("ci.yml: required PR CI is a single Ubuntu Node 22 fast gate with stable ci-status");
      } else {
        for (const violation of fastCiViolations) fail(violation);
      }

      const fastScripts = collectRunScripts(ciDoc, "fast");
      if (fastScripts.some(script => script.trim() === "pnpm test:ci")) {
        pass("ci.yml: fast gate delegates to pnpm test:ci");
      } else {
        fail("ci.yml: fast gate must delegate to pnpm test:ci");
      }
    }

    // Also check SHA pins in ci.yml
    const ciShaViolations = checkActionShaPins(ciContent);
    if (ciShaViolations.length > 0) {
      for (const v of ciShaViolations) fail(`ci.yml: ${v}`);
    }
  } catch {
    // ci.yml might not exist in some test contexts
  }

  for (const { rel, content, doc } of workflowDocs) {
    const tokenViolations = checkNoTokenSecrets(content);
    for (const violation of tokenViolations) fail(`${rel}: ${violation}`);

    const checkoutViolations = workflowCheckoutCredentialsViolations(doc, rel);
    for (const violation of checkoutViolations) fail(violation);
  }

  const cancellationCoverageViolations = (() => {
    try {
      return checkCancellationCoverage(
        _read("tests/integration/verify-timeout-abort.test.ts"),
      );
    } catch {
      return ["verify-timeout-abort.test.ts: file not found"];
    }
  })();
  const windowsCoverage = findWindowsProcessControlWorkflow(
    workflowDocs,
    cancellationCoverageViolations,
  );
  if (windowsCoverage) {
    pass(
      `${windowsCoverage.rel}: ${windowsCoverage.jobName} verifies toolchain, build, and concrete process-control tests without name filters`,
    );
  } else {
    fail(
      "workflows: a windows-latest job must verify toolchain, build, and concrete process-control tests without name filters",
    );
    for (const violation of cancellationCoverageViolations) fail(violation);
  }

  // 4. Pin the reviewed development toolchain and lifecycle-script policy.
  try {
    const violations = checkToolchainPins(
      _read("package.json"),
      _read("pnpm-workspace.yaml"),
      _read("pnpm-lock.yaml"),
    );
    if (violations.length === 0) {
      pass("pnpm/Vite/esbuild versions and esbuild build-script policy are pinned");
    } else {
      for (const violation of violations) fail(violation);
    }
  } catch (error) {
    fail(
      "toolchain pin files must exist",
      error instanceof Error ? error.message : String(error),
    );
  }

  // 5. Check SECURITY.md does not reference "built locally"
  let securityContent;
  try {
    securityContent = _read("SECURITY.md");
    if (/Releases are built locally/.test(securityContent)) {
      fail("SECURITY.md: still references 'built locally'");
    } else {
      pass("SECURITY.md: no 'built locally' reference");
    }
  } catch {
    // might not exist in test context
  }

  return { failures };
}

// Run when invoked directly
const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { failures } = checkSupplyChainInvariants(repoRoot);
  if (failures > 0) {
    console.error(
      `\ncheck-supply-chain-invariants: ${failures} invariant(s) violated`,
    );
    process.exit(1);
  }
  console.log("\ncheck-supply-chain-invariants: all invariants satisfied");
}
