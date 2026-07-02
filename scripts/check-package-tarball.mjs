#!/usr/bin/env node
// npm tarball content inspection.
//
// Verifies that the `npm pack` tarball contains only expected files,
// rejects source/tests/scripts/secrets/sourcemaps/symlinks, and checks
// package metadata (name, version, bin, shebang, runtime dependencies).
//
// Usage:
//   node scripts/check-package-tarball.mjs --pack-json pack.json
//
// The --pack-json argument is the path to `npm pack --json` output.

import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Parse CLI arguments.
 * @returns {{packJson: string}}
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pack-json" && i + 1 < argv.length) {
      args.packJson = argv[++i];
    }
  }
  return args;
}

/**
 * Promisified execFile.
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function execFileAsync(file, args, opts) {
  return new Promise((resolveP, rejectP) => {
    execFile(file, args, opts, (err, stdout, stderr) => {
      if (err) rejectP(err);
      else resolveP({ stdout, stderr });
    });
  });
}

/**
 * Allowed file patterns in the tarball.
 * Everything else is rejected.
 */
const ALLOWED_PATTERNS = [
  /^package\/package\.json$/,
  /^package\/README\.md$/,
  /^package\/LICENSE$/,
  /^package\/dist\//,
];

/**
 * Explicitly rejected patterns.
 */
const REJECTED_PATTERNS = [
  { pattern: /^package\/src\//, label: "src/**" },
  { pattern: /^package\/tests\//, label: "tests/**" },
  { pattern: /^package\/scripts\//, label: "scripts/**" },
  { pattern: /^package\/\.github\//, label: ".github/**" },
  { pattern: /^package\/design\//, label: "design/**" },
  { pattern: /^package\/docs\//, label: "docs/**" },
  { pattern: /^package\/\.env$/, label: ".env" },
  { pattern: /^package\/\.env\./, label: ".env.*" },
  { pattern: /\.map$/, label: "*.map" },
  { pattern: /^package\/node_modules\//, label: "node_modules/**" },
];

/**
 * Core tarball verification logic, separated for testability.
 *
 * @param {object} opts
 * @param {string} opts.tarballPath - path to the .tgz file
 * @param {object} opts.repoPkg - parsed repository package.json
 * @param {function} [opts.tarRunner] - injectable tar command runner
 * @param {function} [opts.tempDirMaker] - injectable temp dir creator
 * @param {function} [opts.tempDirRemover] - injectable temp dir remover
 * @param {function} [opts.fileReader] - injectable file reader
 * @returns {Promise<{ok: boolean, problems: string[]}>}
 */
export async function checkPackageTarball(opts) {
  const {
    tarballPath,
    repoPkg,
    tarRunner = (args, cwd) => execFileAsync("tar", args, { cwd }),
    tempDirMaker = prefix => mkdtemp(join(tmpdir(), prefix)),
    tempDirRemover = dir => rm(dir, { recursive: true, force: true }),
    fileReader = path => readFile(path, "utf8"),
  } = opts;

  const problems = [];

  // 1. List tarball entries
  let listResult;
  try {
    listResult = await tarRunner(["-tzf", tarballPath]);
  } catch (err) {
    return { ok: false, problems: [`failed to list tarball: ${err.message}`] };
  }

  const entries = listResult.stdout
    .split("\n")
    .map(e => e.trim())
    .filter(e => e.length > 0)
    .filter(e => !e.endsWith("/"));

  // 2. Check for symlinks and hard links via tar verbose listing
  let verboseResult;
  try {
    verboseResult = await tarRunner(["-tzvf", tarballPath]);
  } catch (err) {
    return {
      ok: false,
      problems: [`failed to list tarball (verbose): ${err.message}`],
    };
  }

  const verboseLines = verboseResult.stdout
    .split("\n")
    .map(e => e.trim())
    .filter(e => e.length > 0);

  for (const line of verboseLines) {
    // tar verbose format: permissions owner group size date path
    // Symlink: starts with 'l', hard link: starts with 'h'
    const permChar = line.charAt(0);
    if (permChar === "l") {
      const parts = line.split(/\s+/);
      const path = parts[parts.length - 1].split(" -> ")[0];
      problems.push(`symlink found in tarball: ${path}`);
    }
    if (permChar === "h") {
      const parts = line.split(/\s+/);
      const path = parts[parts.length - 1];
      problems.push(`hard link found in tarball: ${path}`);
    }
  }

  // 3. Check each entry against allowed/rejected patterns
  for (const entry of entries) {
    // Normalize: tarball entries should start with "package/"
    const normalized = entry.startsWith("./") ? entry.slice(2) : entry;

    // Check for absolute paths
    if (normalized.startsWith("/")) {
      problems.push(`absolute path in tarball: ${entry}`);
      continue;
    }

    // Check for ../ traversal
    if (normalized.includes("../") || normalized === "..") {
      problems.push(`../ traversal in tarball entry: ${entry}`);
      continue;
    }

    // Check rejected patterns
    for (const { pattern, label } of REJECTED_PATTERNS) {
      if (pattern.test(normalized)) {
        problems.push(`forbidden content in tarball (${label}): ${entry}`);
        break;
      }
    }

    // Check allowed patterns
    const allowed = ALLOWED_PATTERNS.some(p => p.test(normalized));
    if (!allowed) {
      problems.push(`unexpected entry in tarball: ${entry}`);
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  // 4. Extract tarball to temp dir and inspect contents
  const tempDir = await tempDirMaker("tarball-check-");
  try {
    await tarRunner(["-xzf", tarballPath, "-C", tempDir]);

    const pkgDir = join(tempDir, "package");

    // 5. Verify package.json
    let tarballPkg;
    try {
      tarballPkg = JSON.parse(await fileReader(join(pkgDir, "package.json")));
    } catch (err) {
      return {
        ok: false,
        problems: [`failed to read package.json from tarball: ${err.message}`],
      };
    }

    if (tarballPkg.name !== "code-pact") {
      problems.push(
        `tarball package.json name is "${tarballPkg.name}", expected "code-pact"`,
      );
    }

    if (tarballPkg.version !== repoPkg.version) {
      problems.push(
        `tarball package.json version "${tarballPkg.version}" != repository "${repoPkg.version}"`,
      );
    }

    if (tarballPkg.bin?.["code-pact"] !== "dist/cli.js") {
      problems.push(
        `tarball bin["code-pact"] is "${tarballPkg.bin?.["code-pact"]}", expected "dist/cli.js"`,
      );
    }

    // 6. Verify runtime dependencies match
    const repoDeps = repoPkg.dependencies ?? {};
    const tarballDeps = tarballPkg.dependencies ?? {};
    const repoDepKeys = Object.keys(repoDeps).sort();
    const tarballDepKeys = Object.keys(tarballDeps).sort();

    if (repoDepKeys.length !== tarballDepKeys.length) {
      problems.push(
        `dependency count mismatch: repository has ${repoDepKeys.length}, tarball has ${tarballDepKeys.length}`,
      );
    } else {
      for (const key of repoDepKeys) {
        if (tarballDeps[key] !== repoDeps[key]) {
          problems.push(
            `dependency "${key}" version mismatch: repository "${repoDeps[key]}", tarball "${tarballDeps[key]}"`,
          );
        }
      }
      for (const key of tarballDepKeys) {
        if (!(key in repoDeps)) {
          problems.push(
            `tarball has extra dependency "${key}" not in repository package.json`,
          );
        }
      }
    }

    // 7. Verify dist/cli.js exists and has shebang
    try {
      const cliContent = await fileReader(join(pkgDir, "dist", "cli.js"));
      if (!cliContent.startsWith("#!/usr/bin/env node")) {
        problems.push(
          "dist/cli.js does not start with #!/usr/bin/env node shebang",
        );
      }
    } catch (err) {
      problems.push(`dist/cli.js not found in tarball: ${err.message}`);
    }
  } finally {
    await tempDirRemover(tempDir);
  }

  return { ok: problems.length === 0, problems };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.packJson) {
    console.error("check-package-tarball: --pack-json is required");
    process.exit(1);
  }

  const packData = JSON.parse(await readFile(args.packJson, "utf8"));
  const tarballName = packData[0]?.filename;
  if (!tarballName) {
    console.error("check-package-tarball: no tarball filename in pack JSON");
    process.exit(1);
  }

  const repoPkg = JSON.parse(
    await readFile(resolve(repoRoot, "package.json"), "utf8"),
  );

  const result = await checkPackageTarball({
    tarballPath: resolve(repoRoot, tarballName),
    repoPkg,
  });

  if (!result.ok) {
    console.error(
      `check-package-tarball: ${result.problems.length} problem(s):`,
    );
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(
    `check-package-tarball: OK — tarball ${tarballName} passed all checks`,
  );
}

const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(err => {
    console.error(`check-package-tarball: unexpected error: ${err.message}`);
    process.exit(1);
  });
}
