#!/usr/bin/env node
// Verify that a published npm package version has a cryptographically valid
// provenance attestation.
//
// Two independent checks are performed:
//
// 1. Registry probe: fetch the package manifest and confirm
//    `dist.attestations.provenance` is present and points at a valid URL (or
//    is `true` for older registry responses).
//
// 2. Cryptographic verification: create a temporary project with the package as
//    its only dependency and run `npm audit signatures --json
//    --include-attestations`. npm verifies the registry signatures and the
//    Sigstore provenance bundle. This script then checks the bundle's
//    `predicateType` is a recognised SLSA provenance URI.
//
// Both checks must pass. A missing attestation, an invalid signature, an
// unrecognised provenance schema, or a network/registry error is a non-zero exit.

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_RETRIES = 6;
const DEFAULT_INTERVAL_MS = 5000;
const NPM_REGISTRY = "https://registry.npmjs.org";

// npm registry package URLs encode the scoped slash but leave the leading "@"
// untouched (e.g. @scope/pkg -> @scope%2Fpkg).
function encodeNpmPackageName(name) {
  return name.replace(/\//g, "%2F");
}

const SLSA_PROVENANCE_PREDICATE_TYPES = new Set([
  "https://slsa.dev/provenance/v0.2",
  "https://slsa.dev/provenance/v1",
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Default exec implementation used to run `npm` in the temporary project.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode?: number}>}
 */
async function defaultExec(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync("npm", args, { cwd });
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.code,
    };
  }
}

/**
 * Fetch the package manifest from the registry with bounded retries.
 *
 * @param {object} opts
 * @param {string} opts.packageName
 * @param {string} opts.version
 * @param {string} [opts.registry=https://registry.npmjs.org]
 * @param {typeof globalThis.fetch} [opts.fetchImpl=globalThis.fetch]
 * @param {number} [opts.retries=6]
 * @param {number} [opts.intervalMs=5000]
 * @returns {Promise<{ok: boolean, data?: any, code: string, message: string}>}
 */
async function fetchRegistryManifest(opts) {
  const {
    packageName,
    version,
    registry = NPM_REGISTRY,
    fetchImpl = globalThis.fetch,
    retries = DEFAULT_RETRIES,
    intervalMs = DEFAULT_INTERVAL_MS,
  } = opts;

  const target = `${registry.replace(/\/$/, "")}/${encodeNpmPackageName(packageName)}/${encodeURIComponent(version)}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    let response;
    try {
      response = await fetchImpl(target, {
        headers: { accept: "application/json" },
      });
    } catch (err) {
      if (attempt === retries - 1) {
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

    return { ok: true, data, code: "OK", message: "" };
  }

  return {
    ok: false,
    code: "RETRIES_EXHAUSTED",
    message: `Registry fetch exhausted ${retries} attempts for ${packageName}@${version}`,
  };
}

/**
 * Validate the provenance attestation shape returned from the registry probe.
 *
 * Real npm provenance manifests set `dist.attestations.provenance` to either
 * the attestation URL (string) or `true`. The bundle URL is returned so it can
 * be surfaced in verification output.
 *
 * @param {any} manifest
 * @param {string} [registry=https://registry.npmjs.org]
 * @returns {{ok: boolean, code: string, message: string, url?: string}}
 */
function validateManifestAttestation(
  manifest,
  packageName,
  version,
  registry = NPM_REGISTRY,
) {
  const attestation = manifest.dist?.attestations?.provenance;
  if (!attestation) {
    return {
      ok: false,
      code: "PROVENANCE_MISSING",
      message: `Version ${packageName}@${version} has no provenance attestation in registry manifest`,
    };
  }

  // Older manifests set `provenance: true` without a URL. Newer manifests set
  // the bundle URL. Both are acceptable from the registry probe; the bundle
  // itself is validated cryptographically by `npm audit signatures`.
  let url;
  if (typeof attestation === "string") {
    url = attestation;
  } else {
    const base = registry.replace(/\/$/, "");
    url = `${base}/-/attestations/${encodeNpmPackageName(packageName)}/${encodeURIComponent(version)}`;
  }
  return {
    ok: true,
    code: "PROVENANCE_MANIFEST_OK",
    message: `Version ${packageName}@${version} advertises provenance in registry manifest`,
    url,
  };
}

/**
 * Run `npm audit signatures --json --include-attestations` in a temporary
 * project that depends on the published package.
 *
 * npm verifies the registry signatures and Sigstore provenance bundle. This
 * function then validates that the returned attestation bundle has a
 * recognised SLSA provenance predicate type.
 *
 * @param {object} opts
 * @param {string} opts.packageName
 * @param {string} opts.version
 * @param {string} [opts.cwd]
 * @param {typeof defaultExec} [opts.execImpl=defaultExec]
 * @returns {Promise<{ok: boolean, code: string, message: string}>}
 */
async function runNpmAuditSignatures(opts) {
  const { packageName, version, execImpl = defaultExec, cwd = tmpdir() } = opts;

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

    const install = await execImpl(scratch, ["install", "--ignore-scripts"]);
    if (!install.ok) {
      return {
        ok: false,
        code: "NPM_INSTALL_FAILED",
        message: `npm install failed for ${packageName}@${version}: ${install.stderr || install.stdout}`,
      };
    }

    const audit = await execImpl(scratch, [
      "audit",
      "signatures",
      "--json",
      "--include-attestations",
    ]);

    let parsed;
    try {
      parsed = JSON.parse(audit.stdout || "{}");
    } catch {
      return {
        ok: false,
        code: "NPM_AUDIT_JSON_PARSE_FAILED",
        message: `npm audit signatures produced invalid JSON for ${packageName}@${version}: ${audit.stderr || audit.stdout}`,
      };
    }

    // npm audit signatures can exit 0 with an `invalid`/`missing` list, or
    // exit non-zero with the same JSON on stdout. We treat non-empty invalid or
    // missing arrays as a verification failure regardless of exit code.
    if (Array.isArray(parsed.invalid) && parsed.invalid.length > 0) {
      const invalid = parsed.invalid
        .filter(e => e.name === packageName && e.version === version)
        .map(e => `${e.name}@${e.version}: ${e.reason || "invalid signature"}`);
      if (invalid.length > 0) {
        return {
          ok: false,
          code: "PROVENANCE_SIGNATURE_INVALID",
          message: invalid.join("; "),
        };
      }
    }

    if (Array.isArray(parsed.missing) && parsed.missing.length > 0) {
      const missing = parsed.missing
        .filter(e => e.name === packageName && e.version === version)
        .map(e => `${e.name}@${e.version}: ${e.reason || "missing signature"}`);
      if (missing.length > 0) {
        return {
          ok: false,
          code: "PROVENANCE_SIGNATURE_MISSING",
          message: missing.join("; "),
        };
      }
    }

    const verified = Array.isArray(parsed.verified) ? parsed.verified : [];
    const entry = verified.find(
      v => v.name === packageName && v.version === version,
    );
    if (!entry) {
      return {
        ok: false,
        code: "PROVENANCE_NOT_AUDITED",
        message: `npm audit signatures did not report an audited entry for ${packageName}@${version}`,
      };
    }

    const predicateType =
      entry.attestations?.provenance?.predicateType ??
      entry.attestationBundles?.[0]?.predicateType;

    if (!predicateType) {
      return {
        ok: false,
        code: "PROVENANCE_PREDICATE_TYPE_MISSING",
        message: `Attestation for ${packageName}@${version} has no recognised predicateType`,
      };
    }

    if (!SLSA_PROVENANCE_PREDICATE_TYPES.has(predicateType)) {
      return {
        ok: false,
        code: "PROVENANCE_PREDICATE_TYPE_UNSUPPORTED",
        message: `Attestation for ${packageName}@${version} has unsupported predicateType ${predicateType}`,
      };
    }

    return {
      ok: true,
      code: "PROVENANCE_AUDIT_OK",
      message: `npm audit signatures verified ${packageName}@${version} provenance (${predicateType})`,
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
 * @param {typeof defaultExec} [opts.execImpl=defaultExec]
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
    execImpl = defaultExec,
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

  const manifestCheck = validateManifestAttestation(
    manifestResult.data,
    packageName,
    version,
    registry,
  );
  if (!manifestCheck.ok) {
    return manifestCheck;
  }

  const auditResult = await runNpmAuditSignatures({
    packageName,
    version,
    execImpl,
    cwd: scratchDir,
  });
  if (!auditResult.ok) {
    return auditResult;
  }

  return {
    ok: true,
    code: "PROVENANCE_VERIFIED",
    message: `${manifestCheck.message}; ${auditResult.message}`,
    url: manifestCheck.url,
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
