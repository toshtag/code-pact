#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "dist", "cli.js");

function run(cwd, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `init smoke failed: node dist/cli.js ${args.join(" ")} exited ${result.status ?? "unknown"}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
    );
  }
}

const dir = await mkdtemp(join(tmpdir(), "code-pact-init-smoke-"));

try {
  run(dir, [
    "init",
    "--non-interactive",
    "--locale",
    "en-US",
    "--agent",
    "claude-code",
    "--json",
  ]);
  run(dir, ["validate", "--json"]);
  run(dir, ["doctor", "--json"]);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("init-smoke: OK");
