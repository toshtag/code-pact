#!/usr/bin/env node
// Post-publish registry tarball verification.
//
// Downloads the published tarball from the npm registry and verifies:
//   - download bytes SHA-1 == dist.shasum
//   - download bytes SHA-512 SRI == dist.integrity
//   - download bytes == local tarball bytes
//   - registry package version == requested version
//
// On success, writes a JSON integrity report to the --output path.
// Uses exponential backoff (2s, 4s, 8s, 16s, 32s) for registry propagation delay.
// HTTP 404 triggers retry; other HTTP errors fail immediately.
//
// Usage:
//   node scripts/verify-published-tarball.mjs \
//     --package code-pact \
//     --version 2.0.1 \
//     --local code-pact-2.0.1.tgz \
//     --output release-integrity.json

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BACKOFF_DELAYS = [2000, 4000, 8000, 16000, 32000];

/**
 * Parse CLI arguments.
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--package" && i + 1 < argv.length) args.package = argv[++i];
    else if (argv[i] === "--version" && i + 1 < argv.length) args.version = argv[++i];
    else if (argv[i] === "--local" && i + 1 < argv.length) args.local = argv[++i];
    else if (argv[i] === "--output" && i + 1 < argv.length) args.output = argv[++i];
  }
  return args;
}

/**
 * Fetch registry metadata for a specific version.
 * Retries with exponential backoff on 404.
 *
 * @param {string} packageName
 * @param {string} version
 * @param {function} [fetcher] - injectable fetch function
 * @param {function} [sleeper] - injectable sleep function
 * @returns {Promise<object>} - registry version metadata with dist field
 */
export async function fetchRegistryMetadata(packageName, version, fetcher, sleeper) {
  const _fetch = fetcher ?? (async (url) => fetch(url));
  const _sleep = sleeper ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;

  let lastError;
  for (let attempt = 0; attempt < BACKOFF_DELAYS.length; attempt++) {
    const response = await _fetch(url);
    if (response.ok) {
      return response.json();
    }
    if (response.status === 404) {
      lastError = new Error(`registry returned 404 for ${packageName}@${version} (attempt ${attempt + 1}/${BACKOFF_DELAYS.length})`);
      if (attempt < BACKOFF_DELAYS.length - 1) {
        await _sleep(BACKOFF_DELAYS[attempt]);
        continue;
      }
    } else {
      throw new Error(`registry returned ${response.status} for ${packageName}@${version}`);
    }
  }
  throw lastError ?? new Error("registry metadata fetch failed");
}

/**
 * Compute SHA-1 hex digest.
 */
export function sha1hex(bytes) {
  return createHash("sha1").update(bytes).digest("hex");
}

/**
 * Compute SHA-512 SRI (subresource integrity) string.
 */
export function sha512sri(bytes) {
  const hash = createHash("sha512").update(bytes).digest("base64");
  return `sha512-${hash}`;
}

/**
 * Compute SHA-256 hex digest.
 */
export function sha256hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Core verification logic, separated for testability.
 *
 * @param {object} opts
 * @param {string} opts.packageName
 * @param {string} opts.version
 * @param {string} opts.localTarballPath
 * @param {function} [opts.metadataFetcher]
 * @param {function} [opts.tarballFetcher]
 * @param {function} [opts.sleeper]
 * @param {function} [opts.fileReader]
 * @returns {Promise<{ok: boolean, problems: string[], report?: object}>}
 */
export async function verifyPublishedTarball(opts) {
  const {
    packageName,
    version,
    localTarballPath,
    metadataFetcher = fetchRegistryMetadata,
    tarballFetcher = async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`tarball download failed: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    sleeper,
    fileReader = (path) => readFile(path),
  } = opts;

  const problems = [];

  // 1. Fetch registry metadata
  let metadata;
  try {
    metadata = await metadataFetcher(packageName, version, undefined, sleeper);
  } catch (err) {
    return { ok: false, problems: [`failed to fetch registry metadata: ${err.message}`] };
  }

  // 2. Verify registry version matches requested version
  if (metadata.version !== version) {
    problems.push(
      `registry version "${metadata.version}" != requested "${version}"`,
    );
  }

  const dist = metadata.dist;
  if (!dist) {
    return { ok: false, problems: ["registry metadata missing dist field"] };
  }

  // 3. Download registry tarball
  let registryBytes;
  try {
    registryBytes = await tarballFetcher(dist.tarball);
  } catch (err) {
    return { ok: false, problems: [`failed to download registry tarball: ${err.message}`] };
  }

  // 4. Verify SHA-1
  const registrySha1 = sha1hex(registryBytes);
  if (registrySha1 !== dist.shasum) {
    problems.push(
      `registry tarball SHA-1 "${registrySha1}" != dist.shasum "${dist.shasum}"`,
    );
  }

  // 5. Verify SHA-512 SRI
  const registrySri = sha512sri(registryBytes);
  if (registrySri !== dist.integrity) {
    problems.push(
      `registry tarball SRI "${registrySri}" != dist.integrity "${dist.integrity}"`,
    );
  }

  // 6. Compare with local tarball
  let localBytes;
  try {
    localBytes = await fileReader(localTarballPath);
  } catch (err) {
    return { ok: false, problems: [`failed to read local tarball: ${err.message}`] };
  }

  // Convert to Uint8Array for comparison if needed
  const localU8 = localBytes instanceof Uint8Array ? localBytes : new Uint8Array(localBytes);

  if (localU8.length !== registryBytes.length) {
    problems.push(
      `local tarball size ${localU8.length} != registry tarball size ${registryBytes.length}`,
    );
  } else {
    let match = true;
    for (let i = 0; i < localU8.length; i++) {
      if (localU8[i] !== registryBytes[i]) {
        match = false;
        break;
      }
    }
    if (!match) {
      problems.push("local tarball bytes != registry tarball bytes");
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  const report = {
    package: packageName,
    version,
    tarball: dist.tarball,
    shasum: dist.shasum,
    integrity: dist.integrity,
    local_sha256: sha256hex(localU8),
  };

  return { ok: true, problems: [], report };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.package || !args.version || !args.local || !args.output) {
    console.error(
      "verify-published-tarball: --package, --version, --local, and --output are required",
    );
    process.exit(1);
  }

  const result = await verifyPublishedTarball({
    packageName: args.package,
    version: args.version,
    localTarballPath: resolve(repoRoot, args.local),
  });

  if (!result.ok) {
    console.error(`verify-published-tarball: ${result.problems.length} problem(s):`);
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  await writeFile(args.output, JSON.stringify(result.report, null, 2) + "\n", "utf8");
  console.log(`verify-published-tarball: OK — integrity report written to ${args.output}`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`verify-published-tarball: unexpected error: ${err.message}`);
    process.exit(1);
  });
}
