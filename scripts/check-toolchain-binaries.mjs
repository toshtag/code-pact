#!/usr/bin/env node

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { transformSync, version as esbuildVersion } from "esbuild";

const require = createRequire(import.meta.url);
const { packageManager } = require("../package.json");
const { version: viteVersion } = require("vite/package.json");

const EXPECTED_PNPM_VERSION = "10.34.2";
const EXPECTED_VITE_VERSION = "8.1.4";
const EXPECTED_ESBUILD_VERSION = "0.28.1";

if (packageManager !== `pnpm@${EXPECTED_PNPM_VERSION}`) {
  console.error(
    `check-toolchain-binaries: expected packageManager pnpm@${EXPECTED_PNPM_VERSION}, got ${JSON.stringify(packageManager)}`,
  );
  process.exit(1);
}

const pnpmCommand = "pnpm";
const pnpm = spawnSync(pnpmCommand, ["--version"], {
  encoding: "utf8",
  windowsHide: true,
  // Windows cannot execute .cmd shims through execFile/spawn directly. A
  // fixed command and fixed argument are safe to resolve through cmd.exe.
  shell: process.platform === "win32",
});
if (pnpm.error || pnpm.status !== 0) {
  console.error(
    `check-toolchain-binaries: unable to execute ${pnpmCommand} --version: ${pnpm.error?.message ?? pnpm.stderr.trim()}`,
  );
  process.exit(1);
}
const pnpmVersion = pnpm.stdout.trim();
if (pnpmVersion !== EXPECTED_PNPM_VERSION) {
  console.error(
    `check-toolchain-binaries: expected pnpm ${EXPECTED_PNPM_VERSION}, got ${pnpmVersion}`,
  );
  process.exit(1);
}

if (viteVersion !== EXPECTED_VITE_VERSION) {
  console.error(
    `check-toolchain-binaries: expected Vite ${EXPECTED_VITE_VERSION}, got ${viteVersion}`,
  );
  process.exit(1);
}

if (esbuildVersion !== EXPECTED_ESBUILD_VERSION) {
  console.error(
    `check-toolchain-binaries: expected esbuild ${EXPECTED_ESBUILD_VERSION}, got ${esbuildVersion}`,
  );
  process.exit(1);
}

const transformed = transformSync("const value: number = 1;", {
  loader: "ts",
  format: "esm",
  target: "es2022",
});
if (!transformed.code.includes("const value = 1")) {
  console.error("check-toolchain-binaries: esbuild transform smoke test failed");
  process.exit(1);
}

console.log(
  `check-toolchain-binaries: pnpm ${pnpmVersion}, Vite ${viteVersion}, and esbuild ${esbuildVersion} are operational`,
);
