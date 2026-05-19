#!/usr/bin/env node
// Runs from `prepublishOnly`. Fails the publish if any of the package
// metadata that we promised in `docs/cli-contract.md`, README, or the
// LICENSE is missing or inconsistent.
//
// The intent is to catch the v0.1 incident class: "release-prep PR
// noticed `repository` / `LICENSE` were missing only at npm pack time".

import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const pkgPath = resolve(repoRoot, "package.json");
const distEntry = resolve(repoRoot, "dist", "cli.js");

const errors = [];

function fail(msg) {
  errors.push(msg);
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const raw = await readFile(pkgPath, "utf8");
const pkg = JSON.parse(raw);

if (pkg.name !== "code-pact") {
  fail(`name must be "code-pact" (got: ${JSON.stringify(pkg.name)})`);
}

// v0.x: X.Y.Z-(alpha|beta|rc).N
// v1.0+: plain X.Y.Z for stable; prereleases retain the suffix form.
const versionRegex = /^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/;
if (typeof pkg.version !== "string" || !versionRegex.test(pkg.version)) {
  fail(
    `version must match X.Y.Z or X.Y.Z-(alpha|beta|rc).N (got: ${JSON.stringify(pkg.version)})`,
  );
}

if (pkg.private === true) {
  fail(`"private": true would block publish — remove it before releasing`);
}

if (pkg.bin?.["code-pact"] !== "dist/cli.js") {
  fail(
    `bin["code-pact"] must be "dist/cli.js" (got: ${JSON.stringify(pkg.bin)})`,
  );
}

if (!Array.isArray(pkg.files) || !pkg.files.includes("dist")) {
  fail(`files must include "dist" (got: ${JSON.stringify(pkg.files)})`);
}

for (const field of ["author", "license", "homepage"]) {
  const v = pkg[field];
  if (typeof v !== "string" || v.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
}

if (
  !pkg.repository ||
  typeof pkg.repository !== "object" ||
  typeof pkg.repository.url !== "string" ||
  pkg.repository.url.trim().length === 0
) {
  fail(`repository.url must be a non-empty string`);
}

if (
  !pkg.bugs ||
  typeof pkg.bugs !== "object" ||
  typeof pkg.bugs.url !== "string" ||
  pkg.bugs.url.trim().length === 0
) {
  fail(`bugs.url must be a non-empty string`);
}

if (!(await exists(distEntry))) {
  fail(`dist/cli.js does not exist — run \`pnpm build\` before publish`);
} else {
  const head = await readFile(distEntry, "utf8");
  if (!head.startsWith("#!/usr/bin/env node")) {
    fail(`dist/cli.js must start with \`#!/usr/bin/env node\` shebang`);
  }
}

const licensePath = resolve(repoRoot, "LICENSE");
if (!(await exists(licensePath))) {
  fail(`LICENSE file is missing at repo root`);
}

if (errors.length > 0) {
  console.error(`prepublishOnly: ${errors.length} metadata check(s) failed:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`prepublishOnly: all metadata checks passed for ${pkg.name}@${pkg.version}`);
