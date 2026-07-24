#!/usr/bin/env node
// Probe the npm registry for the existence of a specific package version.
//
// Exits:
//   0  version exists (registry returned 200)
//   1  version does not exist (registry returned 404)
//   2  registry error or usage error (any other status, network failure, etc.)
//
// The caller decides how to treat each state. The fail-closed contract is:
//   exists -> do not publish (collision)
//   absent -> safe to publish
//   error  -> stop and surface the registry failure, do not assume absence.

const NPM_REGISTRY = "https://registry.npmjs.org";

// npm registry package URLs encode the scoped slash but leave the leading "@"
// untouched (e.g. @scope/pkg -> @scope%2Fpkg).
function encodeNpmPackageName(name) {
  return name.replace(/\//g, "%2F");
}

/**
 * Probe the npm registry for a single package version.
 *
 * @param {string} packageName
 * @param {string} version
 * @param {object} [opts]
 * @param {string} [opts.registry=https://registry.npmjs.org]
 * @param {typeof globalThis.fetch} [opts.fetchImpl=globalThis.fetch]
 * @returns {Promise<{state: "exists" | "absent" | "error", status?: number, message: string}>}
 */
export async function checkNpmVersionAvailability(
  packageName,
  version,
  opts = {},
) {
  const registry = (opts.registry ?? NPM_REGISTRY).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const target = `${registry}/${encodeNpmPackageName(packageName)}/${encodeURIComponent(version)}`;

  let response;
  try {
    response = await fetchImpl(target, {
      headers: { accept: "application/json" },
    });
  } catch (err) {
    return {
      state: "error",
      message: `network error fetching ${target}: ${err.message}`,
    };
  }

  if (response.status === 200) {
    return {
      state: "exists",
      status: 200,
      message: `version ${packageName}@${version} already exists in registry`,
    };
  }

  if (response.status === 404) {
    return {
      state: "absent",
      status: 404,
      message: `version ${packageName}@${version} is not published yet`,
    };
  }

  return {
    state: "error",
    status: response.status,
    message: `registry returned unexpected status ${response.status} for ${target}`,
  };
}

function parseArgs(argv) {
  let packageName = process.env.PACKAGE_NAME;
  let version = process.env.PACKAGE_VERSION;
  let registry = NPM_REGISTRY;

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
    }
  }

  return { packageName, version, registry };
}

async function main() {
  const { packageName, version, registry } = parseArgs(process.argv.slice(2));

  if (!packageName || !version) {
    console.error(
      "Usage: check-npm-version-availability.mjs --package <name> --version <version> [--registry <url>]",
    );
    process.exit(2);
  }

  const result = await checkNpmVersionAvailability(packageName, version, {
    registry,
  });

  if (result.state === "exists") {
    console.error(result.message);
    process.exit(0);
  }

  if (result.state === "absent") {
    console.log(result.message);
    process.exit(1);
  }

  console.error(result.message);
  process.exit(2);
}

const invokedDirectly =
  process.argv[1] &&
  (await import("node:path")).resolve(process.argv[1]) ===
    (await import("node:url")).fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch(err => {
    console.error(
      `check-npm-version-availability: unexpected error: ${err.message}`,
    );
    process.exit(2);
  });
}
