#!/usr/bin/env node
// npm tarball content inspection.
//
// Verifies that the `npm pack` tarball contains only expected files,
// rejects source/tests/scripts/secrets/sourcemaps/symlinks, and checks
// package metadata (name, version, bin, shebang, runtime dependencies).
//
// Usage:
//   node scripts/check-package-tarball.mjs --pack-json pack.json
//   node scripts/check-package-tarball.mjs --pack-json pack.json \
//     --tarball-dir /path/to/packed --metadata-out checked-pack.json
//
// The --pack-json argument is the path to `npm pack --json` output, read in
// whichever shape the running npm emits (see scripts/npm-pack-json.mjs).
// --tarball-dir locates the tarball when `npm pack --pack-destination` put it
// somewhere other than the repository root. --metadata-out writes the verified
// name/version/filename, and is written only after the tarball passes, so a
// consumer reading it never has to re-parse the raw npm payload itself. On a
// failed inspection nothing is written and the exit code is non-zero.

import { readFile, mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { extractPackRecord } from "./npm-pack-json.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Parse CLI arguments.
 * @returns {{packJson?: string, tarballDir?: string, metadataOut?: string}}
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pack-json" && i + 1 < argv.length) {
      args.packJson = argv[++i];
    } else if (argv[i] === "--tarball-dir" && i + 1 < argv.length) {
      args.tarballDir = argv[++i];
    } else if (argv[i] === "--metadata-out" && i + 1 < argv.length) {
      args.metadataOut = argv[++i];
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

    // 6. Verify no forbidden lifecycle scripts in tarball package.json
    const FORBIDDEN_LIFECYCLE_SCRIPTS = new Set([
      "preinstall",
      "install",
      "postinstall",
      "prepublish",
      "prepare",
      "prepublishOnly",
      "prepack",
      "postpack",
      "publish",
      "postpublish",
    ]);

    const tarballScripts = tarballPkg.scripts ?? {};
    for (const name of FORBIDDEN_LIFECYCLE_SCRIPTS) {
      if (Object.prototype.hasOwnProperty.call(tarballScripts, name)) {
        problems.push(`forbidden lifecycle script in tarball: scripts.${name}`);
      }
    }

    // 7. Verify runtime dependencies match exactly
    function assertExactMap(label, repositoryValue, tarballValue) {
      const expected = repositoryValue ?? {};
      const actual = tarballValue ?? {};
      const expectedEntries = Object.entries(expected).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      const actualEntries = Object.entries(actual).sort(([a], [b]) =>
        a.localeCompare(b),
      );

      if (JSON.stringify(expectedEntries) !== JSON.stringify(actualEntries)) {
        problems.push(`${label} does not match repository package.json`);
      }
    }

    assertExactMap(
      "dependencies",
      repoPkg.dependencies,
      tarballPkg.dependencies,
    );
    assertExactMap(
      "optionalDependencies",
      repoPkg.optionalDependencies,
      tarballPkg.optionalDependencies,
    );
    assertExactMap(
      "peerDependencies",
      repoPkg.peerDependencies,
      tarballPkg.peerDependencies,
    );
    assertExactMap(
      "peerDependenciesMeta",
      repoPkg.peerDependenciesMeta,
      tarballPkg.peerDependenciesMeta,
    );

    // bundledDependencies and bundleDependencies must be empty/undefined in both
    for (const key of ["bundledDependencies", "bundleDependencies"]) {
      const repoVal = repoPkg[key] ?? [];
      const tarballVal = tarballPkg[key] ?? [];
      if (JSON.stringify(repoVal) !== JSON.stringify(tarballVal)) {
        problems.push(`${key} does not match repository package.json`);
      }
      if (tarballVal.length > 0) {
        problems.push(`${key} must be empty in tarball`);
      }
    }

    // 8. Verify dist/cli.js exists and has shebang
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

/**
 * Write the verified pack metadata atomically.
 *
 * The temp name is unpredictable and created exclusively (`wx`), so a
 * pre-planted symlink at the temp path is refused rather than written through.
 *
 * @param {string} targetPath - destination for the canonical metadata
 * @param {{name: string, version: string, filename: string}} record
 * @returns {Promise<string>} the resolved destination path
 */
export async function writePackMetadata(targetPath, record) {
  const target = resolve(targetPath);
  const tempPath = join(
    dirname(target),
    `.${basename(target)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const body = `${JSON.stringify(
    { name: record.name, version: record.version, filename: record.filename },
    null,
    2,
  )}\n`;
  await writeFile(tempPath, body, { encoding: "utf8", flag: "wx" });
  await rename(tempPath, target);
  return target;
}

/**
 * Read the pack record, inspect the tarball it names, and — only when the
 * inspection passes — publish the canonical metadata.
 *
 * Separated from `main` for testability; the ordering is the point. A failed
 * inspection publishes no new verified metadata and does not replace an
 * existing file — it does not delete one either, and it does not need to: the
 * checker exits non-zero and the workflow stops before any consumer reads it.
 *
 * @param {object} opts
 * @param {unknown} opts.payload - parsed `npm pack --json` output
 * @param {object} opts.repoPkg - parsed repository package.json
 * @param {string} [opts.tarballDir] - directory holding the packed tarball
 * @param {string} [opts.metadataOut] - where to write verified metadata
 * @param {function} [opts.checker] - injectable tarball inspector
 * @param {function} [opts.metadataWriter] - injectable metadata writer
 * @returns {Promise<{ok: boolean, problems: string[], record: object, metadataPath: string|null}>}
 */
export async function inspectPackedTarball(opts) {
  const {
    payload,
    repoPkg,
    tarballDir,
    metadataOut,
    checker = checkPackageTarball,
    metadataWriter = writePackMetadata,
  } = opts;

  const record = extractPackRecord(payload, {
    expectedName: repoPkg.name,
    expectedVersion: repoPkg.version,
  });

  const baseDir = tarballDir ? resolve(tarballDir) : repoRoot;
  const result = await checker({
    tarballPath: resolve(baseDir, record.filename),
    repoPkg,
  });

  if (!result.ok) {
    return { ...result, record, metadataPath: null };
  }

  const metadataPath = metadataOut
    ? await metadataWriter(metadataOut, record)
    : null;

  return { ...result, record, metadataPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.packJson) {
    console.error("check-package-tarball: --pack-json is required");
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(await readFile(args.packJson, "utf8"));
  } catch (err) {
    console.error(
      `check-package-tarball: cannot read pack JSON at ${args.packJson}: ${err.message}`,
    );
    process.exit(1);
  }

  const repoPkg = JSON.parse(
    await readFile(resolve(repoRoot, "package.json"), "utf8"),
  );

  let result;
  try {
    result = await inspectPackedTarball({
      payload,
      repoPkg,
      tarballDir: args.tarballDir,
      metadataOut: args.metadataOut,
    });
  } catch (err) {
    console.error(`check-package-tarball: ${err.message}`);
    process.exit(1);
  }

  if (!result.ok) {
    console.error(
      `check-package-tarball: ${result.problems.length} problem(s):`,
    );
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(
    `check-package-tarball: OK — tarball ${result.record.filename} passed all checks`,
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
