#!/usr/bin/env node
// Release tag verification for the publish workflow.
//
// Verifies that the workflow was triggered by a GitHub-verified signed
// annotated tag whose name matches `v${package.json.version}`, that the
// tag points at GITHUB_SHA, that the commit is on origin/main, and that
// the CHANGELOG's first released version matches package.json.
//
// If the version already exists on the npm registry, the release is a
// tag/version collision and must fail. The publish step never re-runs an
// existing version.
//
// Usage (inside GitHub Actions):
//   node scripts/check-release-tag.mjs
//
// For testability, GitHub API access and git execution are injectable
// via the exported `checkReleaseTag` function.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { checkNpmVersionAvailability } from "./check-npm-version-availability.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Fetch a GitHub API endpoint and return the JSON response.
 * @param {string} repo - "owner/name"
 * @param {string} path - API path after `repos/{repo}/`
 * @param {string} token - GitHub token
 */
async function githubFetch(repo, path, token) {
  const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} returned ${response.status}`);
  }
  return response.json();
}

/**
 * Extract the first released version from CHANGELOG.md content.
 * Skips `## [Unreleased]` and returns the first `## [X.Y.Z]` version.
 */
export function firstReleasedVersion(changelog) {
  const m = /^##\s*\[(\d+\.\d+\.\d+)\]/m.exec(changelog);
  return m ? m[1] : null;
}

/**
 * Core verification logic, separated for testability.
 *
 * @param {object} opts
 * @param {string} opts.refType - GITHUB_REF_TYPE
 * @param {string} opts.refName - GITHUB_REF_NAME
 * @param {string} opts.sha - GITHUB_SHA
 * @param {string} opts.repository - GITHUB_REPOSITORY
 * @param {string} opts.token - GITHUB_TOKEN
 * @param {object} opts.pkg - parsed package.json
 * @param {string} opts.changelog - CHANGELOG.md content
 * @param {function} [opts.githubApi] - injectable GitHub API fetcher
 * @param {function} [opts.gitRunner] - injectable git command runner
 * @param {function} [opts.registryCheck] - injectable npm registry checker; should resolve to {state: "exists" | "absent" | "error", status?: number, message: string}
 * @returns {Promise<{ok: boolean, message: string, versionExists: boolean, registryState: "exists" | "absent" | "error"}>}
 */
export async function checkReleaseTag(opts) {
  const {
    refType,
    refName,
    sha,
    repository,
    token,
    pkg,
    changelog,
    githubApi = githubFetch,
    gitRunner = args =>
      execFileSync("git", args, { stdio: "pipe", cwd: repoRoot }),
    registryCheck = checkNpmVersionAvailability,
  } = opts;

  if (refType !== "tag") {
    return {
      ok: false,
      message: "workflow was not triggered by a tag",
      versionExists: false,
      registryState: "unknown",
    };
  }

  if (!refName || !sha || !repository || !token) {
    return {
      ok: false,
      message: "required GitHub environment is missing",
      versionExists: false,
      registryState: "unknown",
    };
  }

  const expectedTag = `v${pkg.version}`;
  if (refName !== expectedTag) {
    return {
      ok: false,
      message: `tag ${refName} does not match package version ${expectedTag}`,
      versionExists: false,
      registryState: "unknown",
    };
  }

  // CHANGELOG first released version must match package.json
  const changelogVersion = firstReleasedVersion(changelog);
  if (changelogVersion === null) {
    return {
      ok: false,
      message: "CHANGELOG.md: no released section found",
      versionExists: false,
      registryState: "unknown",
    };
  }
  if (changelogVersion !== pkg.version) {
    return {
      ok: false,
      message: `CHANGELOG first released version [${changelogVersion}] != package.json ${pkg.version}`,
      versionExists: false,
      registryState: "unknown",
    };
  }

  // Fetch the tag ref from GitHub API
  let ref;
  try {
    ref = await githubApi(
      repository,
      `git/ref/tags/${encodeURIComponent(refName)}`,
      token,
    );
  } catch (err) {
    return {
      ok: false,
      message: `GitHub API error: ${err.message}`,
      versionExists: false,
      registryState: "unknown",
    };
  }

  if (ref.object?.type !== "tag") {
    return {
      ok: false,
      message:
        "release tag must be an annotated signed tag, not a lightweight tag",
      versionExists: false,
      registryState: "unknown",
    };
  }

  // Fetch the annotated tag object to verify signature and target commit
  let tagObject;
  try {
    tagObject = await githubApi(
      repository,
      `git/tags/${ref.object.sha}`,
      token,
    );
  } catch (err) {
    return {
      ok: false,
      message: `GitHub API error: ${err.message}`,
      versionExists: false,
      registryState: "unknown",
    };
  }

  if (tagObject.verification?.verified !== true) {
    return {
      ok: false,
      message: `tag signature is not verified: ${tagObject.verification?.reason ?? "unknown"}`,
      versionExists: false,
      registryState: "unknown",
    };
  }

  if (tagObject.object?.sha !== sha) {
    return {
      ok: false,
      message: "verified tag does not point at GITHUB_SHA",
      versionExists: false,
      registryState: "unknown",
    };
  }

  // Verify the commit is on origin/main
  try {
    gitRunner(["merge-base", "--is-ancestor", sha, "origin/main"]);
  } catch {
    return {
      ok: false,
      message: "tag commit is not an ancestor of origin/main",
      versionExists: false,
      registryState: "unknown",
    };
  }

  // A normal release must publish a new version. If the version already
  // exists on npm, this is a tag/version collision, not a success.
  const registryResult = await registryCheck(pkg.name, pkg.version);
  if (registryResult.state === "exists") {
    return {
      ok: false,
      message: `RELEASE_VERSION_ALREADY_EXISTS: ${pkg.version} is already published to npm`,
      versionExists: true,
      registryState: "exists",
    };
  }

  if (registryResult.state === "error") {
    return {
      ok: false,
      message: `REGISTRY_PROBE_ERROR: could not determine if ${pkg.version} is already published`,
      versionExists: false,
      registryState: "error",
    };
  }

  return {
    ok: true,
    message: `verified ${refName} at ${sha}`,
    versionExists: false,
    registryState: registryResult.state,
  };
}

async function main() {
  const {
    GITHUB_REF_TYPE,
    GITHUB_REF_NAME,
    GITHUB_SHA,
    GITHUB_REPOSITORY,
    GITHUB_TOKEN,
  } = process.env;

  const pkg = JSON.parse(
    await readFile(resolve(repoRoot, "package.json"), "utf8"),
  );

  const changelog = await readFile(resolve(repoRoot, "CHANGELOG.md"), "utf8");

  const result = await checkReleaseTag({
    refType: GITHUB_REF_TYPE,
    refName: GITHUB_REF_NAME,
    sha: GITHUB_SHA,
    repository: GITHUB_REPOSITORY,
    token: GITHUB_TOKEN,
    pkg,
    changelog,
  });

  if (!result.ok) {
    console.error(`check-release-tag: ${result.message}`);
    process.exit(1);
  }

  console.log(`check-release-tag: ${result.message}`);
}

const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(err => {
    console.error(`check-release-tag: unexpected error: ${err.message}`);
    process.exit(1);
  });
}
