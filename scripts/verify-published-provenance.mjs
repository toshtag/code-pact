#!/usr/bin/env node
// Verify that a published npm package version has a provenance attestation.
//
// Fetches the package manifest from the registry with bounded retries and
// checks `dist.attestations.provenance`. A missing attestation or network
// failure is a non-zero exit. The fetch implementation is injectable for tests.

const DEFAULT_RETRIES = 6;
const DEFAULT_INTERVAL_MS = 5000;
const NPM_REGISTRY = "https://registry.npmjs.org";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verify provenance attestation for a published package version.
 *
 * @param {object} opts
 * @param {string} opts.packageName
 * @param {string} opts.version
 * @param {string} [opts.registry=https://registry.npmjs.org]
 * @param {function} [opts.fetchImpl=globalThis.fetch]
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
    retries = DEFAULT_RETRIES,
    intervalMs = DEFAULT_INTERVAL_MS,
  } = opts;

  const target = `${registry.replace(/\/$/, "")}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    let response;
    try {
      response = await fetchImpl(target);
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

    const attestations = data.dist?.attestations;
    if (!attestations || attestations.provenance !== true) {
      return {
        ok: false,
        code: "PROVENANCE_MISSING",
        message: `Version ${packageName}@${version} has no provenance attestation`,
      };
    }

    return {
      ok: true,
      code: "PROVENANCE_FOUND",
      message: `Version ${packageName}@${version} has a provenance attestation`,
      url: attestations.url,
    };
  }

  return {
    ok: false,
    code: "RETRIES_EXHAUSTED",
    message: `Provenance verification exhausted ${retries} attempts for ${packageName}@${version}`,
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
  const { packageName, version, registry, json } = parseArgs(process.argv.slice(2));

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
  main().catch((err) => {
    console.error(`verify-published-provenance: unexpected error: ${err.message}`);
    process.exit(1);
  });
}
