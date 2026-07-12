#!/usr/bin/env node
// Change-aware verification scope classifier.
//
// Used by both local `pnpm verify:local` and the GitHub Actions classify job.
// No external dependencies — only Node.js built-ins and `git`.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();

// --- path classification sets ---

const DOCS_ONLY_EXACT = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "LICENSE",
  ".github/pull_request_template.md",
];

const DOCS_ONLY_PREFIXES = ["docs/", ".github/ISSUE_TEMPLATE/"];

const DOCS_GENERATOR_PREFIXES = [
  "src/cli/spec/",
  "src/contracts/",
  "scripts/gen-cli-reference.ts",
  "scripts/gen-doc-blocks.ts",
  "scripts/check-doc-",
  "scripts/check-public-md-links.ts",
  "scripts/check-history-noise.mjs",
  "scripts/changelog-archive.mjs",
];

const TOOLCHAIN_EXACT = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsup.config.ts",
  "vitest.config.ts",
  "vitest.integration.config.ts",
  "vitest.integration.smoke.config.ts",
  "scripts/check-supply-chain-invariants.mjs",
  "scripts/check-toolchain-binaries.mjs",
  "tests/unit/scripts/check-supply-chain-invariants.test.ts",
];

const TOOLCHAIN_PREFIXES = [".github/workflows/"];

const PROCESS_CONTROL_EXACT = [
  "src/lib/timeout.ts",
  "src/commands/verify.ts",
  "src/commands/task-complete.ts",
  "tests/unit/commands/verify-process.test.ts",
  "tests/integration/verify-timeout-abort.test.ts",
  "tests/unit/core/project-fs-authority-resolvers.test.ts",
];

const PROCESS_CONTROL_PREFIXES = ["src/core/process/"];

// --- pure classification helpers ---

function startsWithAny(file, prefixes) {
  return prefixes.some(prefix => file.startsWith(prefix));
}

function isDocsOnly(file) {
  if (DOCS_ONLY_EXACT.includes(file)) return true;
  return DOCS_ONLY_PREFIXES.some(
    prefix => file.startsWith(prefix) || file === prefix.replace(/\/$/, ""),
  );
}

function isDocsGenerator(file) {
  return startsWithAny(file, DOCS_GENERATOR_PREFIXES);
}

function isDocs(file) {
  return isDocsOnly(file) || isDocsGenerator(file);
}

function isToolchain(file) {
  if (TOOLCHAIN_EXACT.includes(file)) return true;
  return startsWithAny(file, TOOLCHAIN_PREFIXES);
}

function isProcessControl(file) {
  if (PROCESS_CONTROL_EXACT.includes(file)) return true;
  return startsWithAny(file, PROCESS_CONTROL_PREFIXES);
}

function isGenericCode(file) {
  return !isDocsOnly(file) && !isToolchain(file) && !isProcessControl(file);
}

export function classifyChangedFiles(files) {
  const changedFiles = [...new Set(files)];
  const docs = changedFiles.some(isDocs);
  const standard = changedFiles.length > 0 && !changedFiles.every(isDocsOnly);
  const toolchain = changedFiles.some(isToolchain);
  const processControl = changedFiles.some(isProcessControl);
  const generic = changedFiles.some(isGenericCode);

  const reasons = [];
  if (processControl) reasons.push("process-control");
  if (toolchain) reasons.push("toolchain");
  if (docs) reasons.push("docs");
  if (standard && !processControl && !toolchain) reasons.push("standard");

  const reason =
    changedFiles.length === 0 ? "no tracked changes" : reasons.join("+");

  return {
    changedFiles,
    docs,
    standard,
    toolchain,
    processControl,
    generic,
    reason,
  };
}

// --- git helpers ---

function runGit(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", data => {
      stdout += data;
    });
    child.stderr?.on("data", data => {
      stderr += data;
    });

    child.on("error", err => {
      reject(err);
    });

    child.on("close", code => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

async function resolveMergeBase(baseRef) {
  const result = await runGit(["merge-base", baseRef, "HEAD"]);
  if (result.code !== 0) return null;
  const sha = result.stdout.trim();
  if (!sha || /^0+$/.test(sha)) return null;
  return sha;
}

async function diffNames(baseOrRef) {
  const args = ["diff", "--name-only", "--diff-filter=ACMR"];
  if (baseOrRef) args.push(baseOrRef);
  const result = await runGit(args);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
}

async function mergeBaseDiffNames(baseRef) {
  const mergeBase = await resolveMergeBase(baseRef);
  if (!mergeBase) return { files: [], mergeBase: null };
  const files = await diffNames(`${mergeBase}...HEAD`);
  return { files, mergeBase };
}

async function collectLocalChangedFiles() {
  const files = new Set();
  let mergeBase = null;

  // Try to find a sensible base for branch changes.
  for (const baseRef of ["origin/main", "main"]) {
    try {
      const { files: baseFiles, mergeBase: mb } =
        await mergeBaseDiffNames(baseRef);
      if (mb) {
        for (const f of baseFiles) files.add(f);
        mergeBase = mb;
        break;
      }
    } catch {
      // continue to next base candidate
    }
  }

  // Always add staged, unstaged, and untracked (non-ignored) working-tree changes.
  const unstaged = await diffNames("");
  for (const f of unstaged) files.add(f);

  const staged = await runGit([
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMR",
  ]);
  if (staged.code === 0) {
    for (const f of staged.stdout
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean)) {
      files.add(f);
    }
  }

  const untracked = await runGit([
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  if (untracked.code === 0) {
    for (const f of untracked.stdout
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean)) {
      files.add(f);
    }
  }

  return { files: [...files], mergeBase };
}

async function collectBaseChangedFiles(baseRef) {
  const { files, mergeBase } = await mergeBaseDiffNames(baseRef);
  return { files, mergeBase };
}

// --- command execution ---

function runCommand(file, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", data => {
      stdout += data;
    });
    child.stderr?.on("data", data => {
      stderr += data;
    });

    child.on("error", err => {
      reject(err);
    });

    child.on("close", code => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function commandLabel(command) {
  return [command[0], ...command[1]].join(" ");
}

async function runCommands(commands) {
  for (const [index, command] of commands.entries()) {
    const [program, args] = command;
    const result = await runCommand(program, args);
    if (result.code !== 0) {
      console.error(`verify:local: '${commandLabel(command)}' failed`);
      if (result.stdout.trim()) {
        console.error(result.stdout);
      }
      if (result.stderr.trim()) {
        console.error(result.stderr);
      }
      process.exit(result.code ?? 1);
    }
  }
}

function buildLocalCommands(scope, mergeBase) {
  const commands = [];

  if (scope.docs) {
    commands.push(["pnpm", ["check:docs"]]);
  }

  if (scope.toolchain) {
    commands.push(["pnpm", ["check:supply-chain"]]);
  }

  if (scope.standard) {
    commands.push(["pnpm", ["typecheck"]]);
  }

  if (scope.processControl) {
    commands.push(["pnpm", ["build"]]);
  }

  if (scope.generic) {
    const vitestArgs = [
      "exec",
      "vitest",
      "run",
      "--changed",
      mergeBase ?? "HEAD",
      "--reporter=agent",
      "--passWithNoTests",
    ];
    commands.push(["pnpm", vitestArgs]);
  }

  if (scope.toolchain) {
    commands.push([
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "tests/unit/scripts/check-supply-chain-invariants.test.ts",
        "--reporter=agent",
      ],
    ]);
  }

  if (scope.processControl && !scope.generic) {
    commands.push([
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "tests/unit/core/project-fs-authority-resolvers.test.ts",
        "tests/unit/commands/verify-process.test.ts",
        "--reporter=agent",
      ],
    ]);
  }

  if (scope.processControl) {
    commands.push([
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.integration.config.ts",
        "tests/integration/verify-timeout-abort.test.ts",
        "--reporter=agent",
      ],
    ]);
  }

  return commands;
}

async function runLocalVerification() {
  const { files, mergeBase } = await collectLocalChangedFiles();
  const scope = classifyChangedFiles(files);

  if (files.length === 0) {
    console.log("verify:local: no tracked changes");
    process.exit(0);
  }

  console.log(`verify:local: scope=${scope.reason}`);

  const commands = buildLocalCommands(scope, mergeBase);

  // No base could be determined but we have working-tree changes; fall back to
  // full unit test run instead of `--changed` so local verification still works.
  if (mergeBase === null && scope.generic) {
    const vitestIndex = commands.findIndex(cmd => cmd[1].includes("--changed"));
    if (vitestIndex !== -1) {
      commands[vitestIndex] = [
        "pnpm",
        ["exec", "vitest", "run", "--reporter=agent"],
      ];
    }
  }

  if (commands.length === 0) {
    console.log("verify:local: 0 checks passed");
    process.exit(0);
  }

  await runCommands(commands);

  console.log(
    `verify:local: ${commands.length} check${commands.length === 1 ? "" : "s"} passed`,
  );
}

// --- output formatters ---

function outputGitHub(scope) {
  const env = process.env.GITHUB_OUTPUT;
  const lines = [`docs=${scope.docs}`, `standard=${scope.standard}`];

  if (env) {
    try {
      writeFileSync(env, `${lines.join("\n")}\n`, { flag: "a" });
    } catch {
      // fall back to stdout
    }
  }

  console.log(lines.join("\n"));
}

// --- CLI ---

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      format: { type: "string", default: "json" },
      local: { type: "boolean", default: false },
      run: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.run && !values.local) {
    console.error("verify:local: --run requires --local");
    process.exit(2);
  }

  if (values.run && values.local) {
    await runLocalVerification();
    return;
  }

  let files;
  let mergeBase;

  if (values.local) {
    const collected = await collectLocalChangedFiles();
    files = collected.files;
    mergeBase = collected.mergeBase;
  } else if (values.base) {
    const collected = await collectBaseChangedFiles(values.base);
    files = collected.files;
    mergeBase = collected.mergeBase;
  } else {
    console.error("verify:local: pass --local or --base <ref>");
    process.exit(2);
  }

  const scope = classifyChangedFiles(files);

  if (mergeBase === null && values.base) {
    // If base cannot be resolved, fail-safe to standard scope.
    scope.standard = true;
    scope.reason = "standard";
    if (scope.docs) scope.reason = "docs+standard";
  }

  if (values.format === "github") {
    outputGitHub(scope);
  } else {
    console.log(JSON.stringify(scope, null, 2));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
