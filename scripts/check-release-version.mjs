#!/usr/bin/env node
// Release version consistency (P38-T2).
//
// The 1.26.0 release prep had to reconcile the version by hand across several
// places: package.json, the CHANGELOG section, docs `code-pact@x.y.z` install
// examples, the recommendation-consumption gate threshold, and the committed
// measurements snapshot. This makes that a single deterministic check so it
// is not re-verified by eye each release.
//
// Run directly (`node scripts/check-release-version.mjs`) or via
// `pnpm release:check`. Exits non-zero on any mismatch.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Parse a leading `X.Y.Z` into [major, minor, patch], or null. */
export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when semver `a` <= `b` (both `X.Y.Z`). False if either is unparseable. */
export function semverLte(a, b) {
  const A = parseSemver(a);
  const B = parseSemver(b);
  if (!A || !B) return false;
  for (let i = 0; i < 3; i++) {
    if (A[i] !== B[i]) return A[i] < B[i];
  }
  return true;
}

/** First released `## [X.Y.Z]` heading (skips `## [Unreleased]`), or null. */
export function firstReleasedVersion(changelog) {
  const m = /^##\s*\[(\d+\.\d+\.\d+)\]/m.exec(changelog);
  return m ? m[1] : null;
}

/** Every `.md` file under `dir` (recursive), repo-relative. */
function markdownFiles(absDir, relDir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) out.push(...markdownFiles(join(absDir, e.name), join(relDir, e.name)));
    else if (e.name.endsWith(".md")) out.push(join(relDir, e.name));
  }
  return out;
}

/**
 * Returns a list of human-readable problem strings (empty == consistent).
 * Pure over the filesystem rooted at `root` so it is unit-testable.
 */
export function checkReleaseVersion(root) {
  const read = (rel) => readFileSync(resolve(root, rel), "utf8");
  const problems = [];

  const pkgVersion = JSON.parse(read("package.json")).version;

  // 1. CHANGELOG: the first released section must be the package version.
  const changelogVersion = firstReleasedVersion(read("CHANGELOG.md"));
  if (changelogVersion === null) {
    problems.push("CHANGELOG.md: no released `## [X.Y.Z]` section found");
  } else if (changelogVersion !== pkgVersion) {
    problems.push(
      `CHANGELOG.md: first released section [${changelogVersion}] != package.json "${pkgVersion}" — cut the [Unreleased] section to [${pkgVersion}]`,
    );
  }

  // 2. Measurements snapshot version (also guarded by check-doc-invariants;
  //    bundled here so `release:check` is self-contained).
  const summaryVersion = JSON.parse(read("docs/maintainers/measurements/summary.json")).code_pact_cli_version;
  if (summaryVersion !== pkgVersion) {
    problems.push(
      `docs/maintainers/measurements/summary.json: code_pact_cli_version "${summaryVersion}" != package.json "${pkgVersion}" — run \`pnpm harness --corpus . --write\``,
    );
  }
  // The manifest is written by the same harness run as summary.json; check it too
  // so "measurements agree" covers BOTH files, not just the summary.
  const manifestVersion = JSON.parse(read("docs/maintainers/measurements/measurements.manifest.json")).code_pact_cli_version;
  if (manifestVersion !== pkgVersion) {
    problems.push(
      `docs/maintainers/measurements/measurements.manifest.json: code_pact_cli_version "${manifestVersion}" != package.json "${pkgVersion}" — run \`pnpm harness --corpus . --write\``,
    );
  }

  // 3. docs `code-pact@X.Y.Z` install/usage examples must match the package
  //    version (a stale example tells users to install an old release).
  const docFiles = ["README.md", ...markdownFiles(resolve(root, "docs"), "docs")];
  for (const rel of docFiles) {
    let text;
    try {
      text = read(rel);
    } catch {
      continue;
    }
    for (const m of text.matchAll(/code-pact@(\d+\.\d+\.\d+)/g)) {
      if (m[1] !== pkgVersion) {
        problems.push(
          `${rel}: example "code-pact@${m[1]}" != package.json "${pkgVersion}"`,
        );
      }
    }
  }

  // 4. The recommendation-consumption gate threshold must reference a released
  //    (or current) version, never a future one.
  const specSrc = read("src/core/adapters/conformance-spec.ts");
  const threshM = /RECOMMENDATION_CONSUMPTION_FROM_VERSION\s*=\s*"([^"]+)"/.exec(specSrc);
  if (!threshM) {
    problems.push("src/core/adapters/conformance-spec.ts: RECOMMENDATION_CONSUMPTION_FROM_VERSION not found");
  } else if (!semverLte(threshM[1], pkgVersion)) {
    problems.push(
      `src/core/adapters/conformance-spec.ts: RECOMMENDATION_CONSUMPTION_FROM_VERSION "${threshM[1]}" is ahead of package.json "${pkgVersion}" (a gate cannot reference a future version)`,
    );
  }

  return problems;
}

// Run when invoked directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const problems = checkReleaseVersion(repoRoot);
  if (problems.length > 0) {
    console.error(`check-release-version: ${problems.length} issue(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("check-release-version: OK — release version is consistent across surfaces.");
}
