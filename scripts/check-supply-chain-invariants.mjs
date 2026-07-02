#!/usr/bin/env node
// Supply-chain invariant checker for GitHub Actions workflow files.
//
// Statically verifies that:
//   - All `uses:` in .github/workflows/**/*.yml reference full 40-char commit SHAs
//   - publish.yml has top-level `permissions: {}`
//   - publish job has `id-token: write` and `environment: npm-publish`
//   - GitHub Release job does NOT have `id-token: write`
//   - No NPM_TOKEN or NODE_AUTH_TOKEN secret references
//   - checkout steps have `persist-credentials: false`
//   - publish workflow only triggers on tags
//   - npm publish is preceded by release:check and tarball inspection
//   - post-publish tarball verification exists
//
// Usage:
//   node scripts/check-supply-chain-invariants.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

const SHA_REGEX = /^@([0-9a-f]{40})$/;

/**
 * Check all `uses:` references are pinned to 40-char SHAs.
 * @param {string} content - workflow file content
 * @param {string} file - file path for reporting
 * @returns {string[]} list of violations
 */
export function checkActionShaPins(content) {
  const violations = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^\s*(-\s+)?uses:\s+(\S+)/.exec(line);
    if (!match) continue;
    const ref = match[2];
    // Check if it's already a 40-char SHA
    if (SHA_REGEX.test(ref)) continue;
    // Check for tag or branch references (not SHA-pinned)
    if (/@v[\d.]/.test(ref) || /@main/.test(ref) || /@master/.test(ref)) {
      violations.push(
        `line ${i + 1}: ${ref} — must be pinned to 40-char commit SHA`,
      );
    } else if (!/@[0-9a-f]{40}/.test(ref)) {
      violations.push(
        `line ${i + 1}: ${ref} — must be pinned to 40-char commit SHA`,
      );
    }
  }
  return violations;
}

/**
 * Check that no NPM_TOKEN or NODE_AUTH_TOKEN references exist.
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
 * Check that checkout steps have persist-credentials: false.
 * @param {string} content
 * @returns {string[]}
 */
export function checkCheckoutPersistCredentials(content) {
  const violations = [];
  // Find all `uses: actions/checkout@...` blocks and check for persist-credentials
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(-\s+)?uses:\s+actions\/checkout@\S+/.exec(lines[i]);
    if (!match) continue;
    // Look ahead for the `with:` block (up to 10 lines)
    let hasWith = false;
    let hasPersistFalse = false;
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const nextLine = lines[j];
      // If we hit another step (`- uses:` or `- run:`) at same indent, stop
      if (/^\s*-\s+(uses:|run:|env:)/.test(nextLine)) break;
      if (/^\s*with:/.test(nextLine)) hasWith = true;
      if (/persist-credentials:\s*false/.test(nextLine)) hasPersistFalse = true;
    }
    if (!hasPersistFalse) {
      violations.push(
        `line ${i + 1}: checkout missing persist-credentials: false`,
      );
    }
  }
  return violations;
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

  // 1. All uses: are 40-char SHAs
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
    pass("All workflow Action references are 40-char SHA pinned");
  }

  // 2. Check publish.yml specific invariants
  let publishContent;
  try {
    publishContent = _read(".github/workflows/publish.yml");
  } catch {
    fail("publish.yml: file not found");
    publishContent = null;
  }

  if (publishContent) {
    // permissions: {} at top level
    if (
      /^permissions:\s*\{\s*$/m.test(publishContent) ||
      /^permissions:\s*\{\}/m.test(publishContent)
    ) {
      pass("publish.yml: top-level permissions: {}");
    } else {
      fail("publish.yml: missing top-level permissions: {}");
    }

    // publish job has id-token: write
    if (/id-token:\s*write/.test(publishContent)) {
      pass("publish.yml: id-token: write present");
    } else {
      fail("publish.yml: missing id-token: write permission");
    }

    // environment: npm-publish
    if (/environment:\s*npm-publish/.test(publishContent)) {
      pass("publish.yml: environment: npm-publish");
    } else {
      fail("publish.yml: missing environment: npm-publish");
    }

    // Trigger only on tags
    if (
      /on:\s*\n\s*push:\s*\n\s*tags:/.test(publishContent) &&
      !/branches:/.test(publishContent.split("on:")[1]?.split("\n\n")[0] ?? "")
    ) {
      pass("publish.yml: triggers only on tags");
    } else {
      fail("publish.yml: should trigger only on tags (push.tags, no branches)");
    }

    // release:check before npm publish
    if (
      /pnpm release:check/.test(publishContent) &&
      /npm publish/.test(publishContent)
    ) {
      const releaseCheckIdx = publishContent.indexOf("pnpm release:check");
      const npmPublishIdx = publishContent.indexOf("npm publish");
      if (
        releaseCheckIdx >= 0 &&
        npmPublishIdx >= 0 &&
        releaseCheckIdx < npmPublishIdx
      ) {
        pass("publish.yml: release:check runs before npm publish");
      } else {
        fail("publish.yml: release:check must run before npm publish");
      }
    } else {
      fail("publish.yml: missing release:check or npm publish step");
    }

    // tarball inspection before publish
    if (/check-package-tarball/.test(publishContent)) {
      const tarballCheckIdx = publishContent.indexOf("check-package-tarball");
      const npmPublishIdx = publishContent.indexOf("npm publish");
      if (
        tarballCheckIdx >= 0 &&
        npmPublishIdx >= 0 &&
        tarballCheckIdx < npmPublishIdx
      ) {
        pass("publish.yml: tarball inspection before npm publish");
      } else {
        fail("publish.yml: tarball inspection must run before npm publish");
      }
    } else {
      fail("publish.yml: missing tarball inspection step");
    }

    // post-publish tarball verification
    if (/verify-published-tarball/.test(publishContent)) {
      const verifyIdx = publishContent.indexOf("verify-published-tarball");
      const npmPublishIdx = publishContent.indexOf("npm publish");
      if (verifyIdx >= 0 && npmPublishIdx >= 0 && verifyIdx > npmPublishIdx) {
        pass("publish.yml: post-publish tarball verification");
      } else {
        fail("publish.yml: tarball verification must run after npm publish");
      }
    } else {
      fail("publish.yml: missing post-publish tarball verification");
    }

    // No NPM_TOKEN or NODE_AUTH_TOKEN
    const tokenViolations = checkNoTokenSecrets(publishContent);
    if (tokenViolations.length === 0) {
      pass("publish.yml: no NPM_TOKEN or NODE_AUTH_TOKEN references");
    } else {
      for (const v of tokenViolations) fail(`publish.yml: ${v}`);
    }

    // checkout persist-credentials: false
    const checkoutViolations = checkCheckoutPersistCredentials(publishContent);
    if (checkoutViolations.length === 0) {
      pass("publish.yml: all checkout steps have persist-credentials: false");
    } else {
      for (const v of checkoutViolations) fail(`publish.yml: ${v}`);
    }

    // GitHub Release job should NOT have id-token: write
    // Find the github-release job section
    const releaseJobMatch = /github-release:[\s\S]*?(?=\n  [a-z]|\Z)/m.exec(
      publishContent,
    );
    if (releaseJobMatch) {
      const releaseJobContent = releaseJobMatch[0];
      if (/id-token:\s*write/.test(releaseJobContent)) {
        fail("publish.yml: github-release job should NOT have id-token: write");
      } else {
        pass("publish.yml: github-release job does not have id-token: write");
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

    const ciCheckoutViolations = checkCheckoutPersistCredentials(ciContent);
    if (ciCheckoutViolations.length === 0) {
      pass("ci.yml: all checkout steps have persist-credentials: false");
    } else {
      for (const v of ciCheckoutViolations) fail(`ci.yml: ${v}`);
    }
  } catch {
    // ci.yml might not exist in some test contexts
  }

  // 4. Check SECURITY.md and docs don't reference local npm publish as normal procedure
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
