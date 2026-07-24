#!/usr/bin/env node
// Verify that a published npm package version advertises provenance metadata
// and that `npm audit signatures` cryptographically verifies it.
//
// Two independent checks are performed:
//
// 1. Registry probe: fetch the package manifest and confirm
//    `dist.attestations.provenance` is present. This is retried for
//    propagation delays (404, missing attestation, 429, 5xx, network timeouts).
//
// 2. Cryptographic verification: create a temporary project with the package as
//    its only dependency and run `npm audit signatures --json`. npm is the
//    authority for signature and provenance verification; this script treats
//    any non-zero exit as a failure.
//
// All network and subprocess operations are bounded by timeouts and process
// cleanup. A missing attestation, an invalid signature, or a network/registry
// error is a non-zero exit.

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_RETRIES = 6;
const DEFAULT_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 10_000;
const NPM_INSTALL_TIMEOUT_MS = 120_000;
const NPM_AUDIT_TIMEOUT_MS = 120_000;
const OVERALL_TIMEOUT_MS = 2 * 60 * 1000;
const NPM_REGISTRY = "https://registry.npmjs.org";

// npm registry package URLs encode the scoped slash but leave the leading "@"
// untouched (e.g. @scope/pkg -> @scope%2Fpkg).
function encodeNpmPackageName(name) {
  return name.replace(/\//g, "%2F");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run `npm` with a hard timeout and process-tree cleanup.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @param {string} [registry]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode?: number}>}
 */
async function runNpm(cwd, args, timeoutMs, registry) {
  const fullArgs = registry ? [...args, `--registry=${registry}`] : args;
  return new Promise((resolve, reject) => {
    const child = spawn("npm", fullArgs, { cwd });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);

    child.stdout?.on("data", data => {
      stdout += String(data);
    });
    child.stderr?.on("data", data => {
      stderr += String(data);
    });

    child.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", exitCode => {
      clearTimeout(timer);
      resolve({
        ok: exitCode === 0 && !killed,
        stdout,
        stderr,
        exitCode: killed ? -1 : exitCode,
      });
    });
  });
}

/**
 * Fetch the package manifest from the registry with bounded retries.
 *
 * Retryable:
 * - HTTP 404 (version not yet propagated)
 * - HTTP 429 / 5xx
 * - manifest 200 but provenance metadata not yet reflected
 * - temporary network errors and request timeouts
 *
 * Immediately failing:
 * - HTTP 401 / 403
 * - invalid JSON
 * - package/version mismatch
 * - overall upper bound exceeded
 *
 * @param {object} opts
 * @param {string} opts.packageName
 * @param {string} opts.version
 * @param {string} [opts.registry=https://registry.npmjs.org]
 * @param {typeof globalThis.fetch} [opts.fetchImpl=globalThis.fetch]
 * @param {number} [opts.retries=6]
 * @param {number} [opts.intervalMs=5000]
 * @param {number} [opts.requestTimeoutMs=10000]
 * @returns {Promise<{ok: boolean, data?: any, code: string, message: string, url?: string}>}
 */
async function fetchRegistryManifest(opts) {
  const {
    packageName,
    version,
    registry = NPM_REGISTRY,
    fetchImpl = globalThis.fetch,
    retries = DEFAULT_RETRIES,
    intervalMs = DEFAULT_INTERVAL_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
  } = opts;

  const base = registry.replace(/\/$/, "");
  const target = `${base}/${encodeNpmPackageName(packageName)}/${encodeURIComponent(version)}`;
  const overallDeadline = Date.now() + OVERALL_TIMEOUT_MS;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (Date.now() > overallDeadline) {
      return {
        ok: false,
        code: "REGISTRY_RETRIES_EXHAUSTED",
        message: `Registry fetch exceeded overall bound of ${OVERALL_TIMEOUT_MS}ms for ${packageName}@${version}`,
      };
    }

    let response;
    try {
      response = await fetchImpl(target, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      if (err.name === "AbortError" || err.code === "ABORT_ERR") {
        if (attempt === retries - 1) {
          return {
            ok: false,
            code: "REGISTRY_TIMEOUT",
            message: `Request timeout after ${requestTimeoutMs}ms fetching ${target}`,
          };
        }
      } else if (attempt === retries - 1) {
        return {
          ok: false,
          code: "REGISTRY_FETCH_FAILED",
          message: `Network error fetching ${target}: ${err.message}`,
        };
      }
      await sleep(intervalMs);
      continue;
    }

    if (!response.ok) {
      if (response.status === 404) {
        if (attempt === retries - 1) {
          return {
            ok: false,
            code: "VERSION_NOT_FOUND",
            message: `Version ${packageName}@${version} not found in registry after ${retries} attempts`,
          };
        }
        await sleep(intervalMs);
        continue;
      }

      if (
        response.status === 429 ||
        (response.status >= 500 && response.status < 600)
      ) {
        if (attempt === retries - 1) {
          return {
            ok: false,
            code: "REGISTRY_ERROR",
            message: `Registry returned ${response.status} for ${target} after ${retries} attempts`,
          };
        }
        await sleep(intervalMs);
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          code: "REGISTRY_AUTH_ERROR",
          message: `Registry returned ${response.status} for ${target}`,
        };
      }

      return {
        ok: false,
        code: "REGISTRY_ERROR",
        message: `Registry returned ${response.status} for ${target}`,
      };
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      return {
        ok: false,
        code: "REGISTRY_JSON_PARSE_FAILED",
        message: `Failed to parse registry response for ${target}: ${err.message}`,
      };
    }

    if (data.name !== packageName || data.version !== version) {
      return {
        ok: false,
        code: "REGISTRY_PACKAGE_MISMATCH",
        message: `Registry manifest ${data.name}@${data.version} does not match requested ${packageName}@${version}`,
      };
    }

    const attestation = data.dist?.attestations?.provenance;
    if (!attestation) {
      if (attempt === retries - 1) {
        return {
          ok: false,
          code: "PROVENANCE_MISSING",
          message: `Version ${packageName}@${version} has no provenance attestation in registry manifest`,
        };
      }
      await sleep(intervalMs);
      continue;
    }

    let url;
    if (typeof attestation === "string") {
      url = attestation;
    } else {
      url = `${base}/-/attestations/${encodeNpmPackageName(packageName)}/${encodeURIComponent(version)}`;
    }

    return {
      ok: true,
      data,
      code: "OK",
      message: `Version ${packageName}@${version} advertises provenance in registry manifest`,
      url,
    };
  }

  return {
    ok: false,
    code: "REGISTRY_RETRIES_EXHAUSTED",
    message: `Registry fetch exhausted ${retries} attempts for ${packageName}@${version}`,
  };
}

/**
 * Run `npm install` and `npm audit signatures --json` in a temporary project
 * that depends on the published package.
 *
 * npm is the authority for cryptographic signature and provenance verification.
 * Any non-zero exit from `npm audit signatures` is treated as a failure.
 * Both commands run with hard timeouts and an explicit registry.
 *
 * @param {object} opts
 * @param {string} opts.packageName
 * @param {string} opts.version
 * @param {string} [opts.cwd]
 * @param {string} [opts.registry=https://registry.npmjs.org]
 * @param {function} [opts.execImpl] - (cwd, args) => Promise<{ok, stdout, stderr, exitCode?}> for tests
 * @returns {Promise<{ok: boolean, code: string, message: string}>}
 */
async function runNpmAuditSignatures(opts) {
  const {
    packageName,
    version,
    cwd = tmpdir(),
    registry = NPM_REGISTRY,
    execImpl,
  } = opts;

  const scratch = await mkdtemp(join(cwd, "code-pact-prov-"));
  try {
    await writeFile(
      join(scratch, "package.json"),
      JSON.stringify(
        {
          name: "provenance-check",
          version: "0.0.0",
          dependencies: { [packageName]: version },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const installArgs = [
      "install",
      "--ignore-scripts",
      `--registry=${registry}`,
    ];
    const install = await (execImpl
      ? execImpl(scratch, installArgs)
      : runNpm(scratch, installArgs, NPM_INSTALL_TIMEOUT_MS));
    if (!install.ok) {
      return {
        ok: false,
        code: "NPM_INSTALL_FAILED",
        message: `npm install failed for ${packageName}@${version}: exit ${install.exitCode ?? "unknown"}; ${install.stderr || install.stdout}`,
      };
    }

    const auditArgs = [
      "audit",
      "signatures",
      "--json",
      `--registry=${registry}`,
    ];
    const audit = await (execImpl
      ? execImpl(scratch, auditArgs)
      : runNpm(scratch, auditArgs, NPM_AUDIT_TIMEOUT_MS));
    if (!audit.ok) {
      return {
        ok: false,
        code: "PROVENANCE_AUDIT_FAILED",
        message: `npm audit signatures failed for ${packageName}@${version}: exit ${audit.exitCode ?? "unknown"}; ${audit.stderr || audit.stdout}`,
      };
    }

    return {
      ok: true,
      code: "PROVENANCE_AUDIT_OK",
      message: `npm audit signatures verified ${packageName}@${version}`,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Verify provenance attestation for a published package version.
 *
 * @param {object} opts
 * @param {string} opts.packageName
 * @param {string} opts.version
 * @param {string} [opts.registry=https://registry.npmjs.org]
 * @param {typeof globalThis.fetch} [opts.fetchImpl=globalThis.fetch]
 * @param {function} [opts.execImpl] - (cwd, args) => Promise<{ok, stdout, stderr, exitCode?}> for tests
 * @param {string} [opts.scratchDir=tmpdir()]
 * @param {number} [opts.retries=6]
 * @param {number} [opts.intervalMs=5000]
 * @returns {Promise<{ok: boolean, code: string, message: string, url?: string}>}
 */
export async function verifyPublishedProvenance(opts) {
  const {
    packageName,
    version,
    registry = NPM_REGISTRY,
    fetchImpl = globalThis.fetch,
    execImpl,
    scratchDir = tmpdir(),
    retries = DEFAULT_RETRIES,
    intervalMs = DEFAULT_INTERVAL_MS,
  } = opts;

  const manifestResult = await fetchRegistryManifest({
    packageName,
    version,
    registry,
    fetchImpl,
    retries,
    intervalMs,
  });
  if (!manifestResult.ok) {
    return manifestResult;
  }

  const auditResult = await runNpmAuditSignatures({
    packageName,
    version,
    cwd: scratchDir,
    registry,
    execImpl,
  });
  if (!auditResult.ok) {
    return auditResult;
  }

  return {
    ok: true,
    code: "PROVENANCE_VERIFIED",
    message: `${manifestResult.message}; ${auditResult.message}`,
    url: manifestResult.url,
  };
}

function parseArgs(argv) {
  let packageName = process.env.PACKAGE_NAME;
  let version = process.env.PACKAGE_VERSION;
  let registry = NPM_REGISTRY;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--package":
        packageName = argv[++i];
        break;
      case "--version":
        version = argv[++i];
        break;
      case "--registry":
        registry = argv[++i];
        break;
      case "--json":
        json = true;
        break;
    }
  }

  return { packageName, version, registry, json };
}

async function main() {
  const { packageName, version, registry, json } = parseArgs(
    process.argv.slice(2),
  );

  if (!packageName || !version) {
    const message =
      "Usage: verify-published-provenance.mjs --package <name> --version <version> [--registry <url>] [--json]";
    if (json) {
      console.error(
        JSON.stringify({ ok: false, code: "USAGE_ERROR", message }),
      );
    } else {
      console.error(message);
    }
    process.exit(2);
  }

  const result = await verifyPublishedProvenance({
    packageName,
    version,
    registry,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(result.message);
  } else {
    console.error(result.message);
  }

  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] &&
  (await import("node:path")).resolve(process.argv[1]) ===
    (await import("node:url")).fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch(err => {
    console.error(
      `verify-published-provenance: unexpected error: ${err.message}`,
    );
    process.exit(1);
  });
}
