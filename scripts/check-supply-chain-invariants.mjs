#!/usr/bin/env node
// Supply-chain invariant checker for GitHub Actions workflow files.
//
// Uses YAML parsing to structurally verify:
//   - All `uses:` in .github/workflows/**/*.yml reference full 40-char commit SHAs
//   - publish.yml has top-level `permissions: {}`
//   - publish.yml has exactly 4 jobs: prepare, publish, verify, github-release
//   - Only the publish job has `id-token: write` and `environment: npm-publish`
//   - Only the github-release job has `contents: write`
//   - publish job has no checkout, pnpm, repository scripts, release:check, npm pack
//   - github-release job has no checkout, repository scripts, pnpm
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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;

function fail(name, detail) {
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  failures++;
}

function pass(name) {
  console.log(`  ✓ ${name}`);
}

function read(rel) {
  return readFileSync(join(repoRoot, rel), "utf8");
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

const ACTION_REF = /^[^@\s]+@[0-9a-f]{40}$/;

/**
 * Check all `uses:` references are pinned to exact 40-char commit SHAs.
 * Rejects tag refs, branch refs, SHA+suffix, SHA+subpath, short/long SHAs.
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
    const steps = job.get("steps");
    if (!steps || !steps.items) continue;

    for (let i = 0; i < steps.items.length; i++) {
      const step = steps.items[i];
      const uses = step.get("uses");
      if (typeof uses !== "string") continue;
      if (uses.startsWith("./")) continue; // local actions allowed
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

/**
 * Run all supply-chain invariant checks.
 * @param {string} root - repo root path
 * @returns {{failures: number}}
 */
export function checkSupplyChainInvariants(root) {
  const _read = rel => readFileSync(join(root, rel), "utf8");
  const workflowDir = join(root, ".github", "workflows");
  const ymlFiles = walkYml(workflowDir);

  console.log("Supply-chain invariants:");

  // 1. All uses: are exact 40-char SHAs (across all workflow files)
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

      // Only publish job has id-token: write
      for (const jobName of expectedJobs) {
        const perms = getJobPermissions(doc, jobName);
        const hasIdToken = perms && perms["id-token"] === "write";
        if (jobName === "publish") {
          if (hasIdToken) {
            pass(`publish.yml: publish job has id-token: write`);
          } else {
            fail("publish.yml: publish job must have id-token: write");
          }
        } else {
          if (hasIdToken) {
            fail(`publish.yml: ${jobName} job must NOT have id-token: write`);
          } else {
            pass(`publish.yml: ${jobName} job does not have id-token: write`);
          }
        }
      }

      // Only github-release job has contents: write
      for (const jobName of expectedJobs) {
        const perms = getJobPermissions(doc, jobName);
        const hasContentsWrite = perms && perms["contents"] === "write";
        if (jobName === "github-release") {
          if (hasContentsWrite) {
            pass(`publish.yml: github-release job has contents: write`);
          } else {
            fail("publish.yml: github-release job must have contents: write");
          }
        } else {
          if (hasContentsWrite) {
            fail(`publish.yml: ${jobName} job must NOT have contents: write`);
          } else {
            pass(`publish.yml: ${jobName} job does not have contents: write`);
          }
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

      // publish job runs npm publish with --ignore-scripts
      const hasIgnoreScripts = publishScripts.some(s =>
        /npm publish.*--ignore-scripts/.test(s),
      );
      if (hasIgnoreScripts) {
        pass("publish.yml: publish job uses --ignore-scripts");
      } else {
        fail("publish.yml: publish job must use --ignore-scripts");
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
        "github-release": ["verify", "prepare"],
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

  // 3. Check ci.yml for token secrets and checkout persist-credentials
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
      const ciJobs = ciDoc.get("jobs");
      let ciCheckoutOk = true;
      if (ciJobs && ciJobs.items) {
        for (const jobPair of ciJobs.items) {
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
                ciCheckoutOk = false;
                fail(
                  `ci.yml: checkout in job "${jobPair.key.value ?? jobPair.key}" missing persist-credentials: false`,
                );
              }
            }
          }
        }
      }
      if (ciCheckoutOk) {
        pass("ci.yml: all checkout steps have persist-credentials: false");
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

  // 4. Check SECURITY.md does not reference "built locally"
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
