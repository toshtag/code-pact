import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  classifyChangedFiles,
  buildLocalCommands,
  collectLocalChangedFiles,
} from "../../../scripts/verification-scope.mjs";

const scriptPath = fileURLToPath(
  new URL("../../../scripts/verification-scope.mjs", import.meta.url),
);

function writeFakeExecutable(
  directory: string,
  commandName: string,
  scriptName: string,
  nodeScript: string,
) {
  const scriptPath = join(directory, scriptName);
  writeFileSync(scriptPath, nodeScript);

  if (process.platform === "win32") {
    const commandPath = join(directory, `${commandName}.cmd`);
    writeFileSync(
      commandPath,
      `@echo off\r\n"${process.execPath}" "%~dp0${scriptName}" %*\r\n`,
    );
    return commandPath;
  }

  const commandPath = join(directory, commandName);
  writeFileSync(commandPath, nodeScript, { mode: 0o755 });
  chmodSync(commandPath, 0o755);
  return commandPath;
}

describe("classifyChangedFiles", () => {
  it("returns empty scope for no changed files", () => {
    expect(classifyChangedFiles([])).toEqual({
      changedFiles: [],
      docs: false,
      standard: false,
      toolchain: false,
      processControl: false,
      generic: false,
      reason: "no tracked changes",
    });
  });

  it("classifies README.md as docs-only", () => {
    const result = classifyChangedFiles(["README.md"]);
    expect(result.docs).toBe(true);
    expect(result.standard).toBe(false);
    expect(result.toolchain).toBe(false);
    expect(result.processControl).toBe(false);
    expect(result.generic).toBe(false);
    expect(result.reason).toBe("docs");
  });

  it("classifies docs/ file as docs-only", () => {
    const result = classifyChangedFiles(["docs/usage.md"]);
    expect(result.docs).toBe(true);
    expect(result.standard).toBe(false);
    expect(result.processControl).toBe(false);
  });

  it("classifies .github/ISSUE_TEMPLATE/ as docs-only", () => {
    const result = classifyChangedFiles([".github/ISSUE_TEMPLATE/bug.md"]);
    expect(result.docs).toBe(true);
    expect(result.standard).toBe(false);
  });

  it("classifies .github/pull_request_template.md as docs-only", () => {
    const result = classifyChangedFiles([".github/pull_request_template.md"]);
    expect(result.docs).toBe(true);
    expect(result.standard).toBe(false);
  });

  it("classifies src/cli/spec/ files as docs and standard", () => {
    const result = classifyChangedFiles(["src/cli/spec/task.ts"]);
    expect(result.docs).toBe(true);
    expect(result.standard).toBe(true);
    expect(result.toolchain).toBe(false);
    expect(result.processControl).toBe(false);
    expect(result.generic).toBe(true);
    expect(result.reason).toBe("docs+standard");
  });

  it("classifies src/contracts/ files as docs and standard", () => {
    const result = classifyChangedFiles([
      "src/contracts/plan-capture-details.ts",
    ]);
    expect(result.docs).toBe(true);
    expect(result.standard).toBe(true);
  });

  it("classifies doc link scripts as docs and standard", () => {
    const result = classifyChangedFiles(["scripts/check-doc-links.ts"]);
    expect(result.docs).toBe(true);
    expect(result.standard).toBe(true);
  });

  it("classifies gen-doc-blocks as docs and standard", () => {
    const result = classifyChangedFiles(["scripts/gen-doc-blocks.ts"]);
    expect(result.docs).toBe(true);
    expect(result.standard).toBe(true);
  });

  it("classifies package.json as toolchain and standard", () => {
    const result = classifyChangedFiles(["package.json"]);
    expect(result.docs).toBe(false);
    expect(result.standard).toBe(true);
    expect(result.toolchain).toBe(true);
    expect(result.processControl).toBe(false);
    expect(result.generic).toBe(false);
    expect(result.reason).toBe("toolchain");
  });

  it("classifies workflow files as toolchain and standard", () => {
    const result = classifyChangedFiles([".github/workflows/ci.yml"]);
    expect(result.toolchain).toBe(true);
    expect(result.standard).toBe(true);
    expect(result.generic).toBe(false);
  });

  it("classifies vitest config as toolchain and standard", () => {
    const result = classifyChangedFiles(["vitest.config.ts"]);
    expect(result.toolchain).toBe(true);
    expect(result.standard).toBe(true);
  });

  it("classifies src/lib/timeout.ts as process-control and standard", () => {
    const result = classifyChangedFiles(["src/lib/timeout.ts"]);
    expect(result.docs).toBe(false);
    expect(result.standard).toBe(true);
    expect(result.toolchain).toBe(false);
    expect(result.processControl).toBe(true);
    expect(result.generic).toBe(false);
    expect(result.reason).toBe("process-control");
  });

  it("classifies src/commands/verify.ts as process-control and standard", () => {
    const result = classifyChangedFiles(["src/commands/verify.ts"]);
    expect(result.processControl).toBe(true);
    expect(result.standard).toBe(true);
  });

  it("classifies src/core/process/ files as process-control and standard", () => {
    const result = classifyChangedFiles([
      "src/core/process/bounded-command.ts",
    ]);
    expect(result.processControl).toBe(true);
    expect(result.standard).toBe(true);
  });

  it("classifies process-control test files as process-control and standard", () => {
    const result = classifyChangedFiles([
      "tests/unit/commands/verify-process.test.ts",
      "tests/integration/verify-timeout-abort.test.ts",
      "tests/unit/core/project-fs-authority-resolvers.test.ts",
    ]);
    expect(result.processControl).toBe(true);
    expect(result.standard).toBe(true);
  });

  it("classifies src/commands/init.ts as standard only", () => {
    const result = classifyChangedFiles(["src/commands/init.ts"]);
    expect(result.docs).toBe(false);
    expect(result.standard).toBe(true);
    expect(result.toolchain).toBe(false);
    expect(result.processControl).toBe(false);
    expect(result.generic).toBe(true);
    expect(result.reason).toBe("standard");
  });

  it("classifies unknown files as standard (fail-safe)", () => {
    const result = classifyChangedFiles(["src/future/unknown.ts"]);
    expect(result.standard).toBe(true);
    expect(result.docs).toBe(false);
    expect(result.toolchain).toBe(false);
    expect(result.processControl).toBe(false);
  });

  it("classifies deleted or renamed paths by their provided path", () => {
    const result = classifyChangedFiles(["src/commands/renamed.ts"]);
    expect(result.standard).toBe(true);
  });

  it("combines docs and standard with docs first in reason", () => {
    const result = classifyChangedFiles([
      "docs/usage.md",
      "src/commands/init.ts",
    ]);
    expect(result.docs).toBe(true);
    expect(result.standard).toBe(true);
    expect(result.reason).toBe("docs+standard");
  });

  it("combines toolchain and standard without duplicating standard in reason", () => {
    const result = classifyChangedFiles([
      "package.json",
      "src/commands/init.ts",
    ]);
    expect(result.toolchain).toBe(true);
    expect(result.standard).toBe(true);
    expect(result.reason).toBe("toolchain");
  });

  it("combines process-control and standard without duplicating standard in reason", () => {
    const result = classifyChangedFiles([
      "src/lib/timeout.ts",
      "src/commands/init.ts",
    ]);
    expect(result.processControl).toBe(true);
    expect(result.standard).toBe(true);
    expect(result.reason).toBe("process-control");
  });

  it("combines process-control and toolchain in reason", () => {
    const result = classifyChangedFiles(["package.json", "src/lib/timeout.ts"]);
    expect(result.toolchain).toBe(true);
    expect(result.processControl).toBe(true);
    expect(result.reason).toBe("process-control+toolchain");
  });

  it("deduplicates changed files in the returned list", () => {
    const result = classifyChangedFiles([
      "src/commands/init.ts",
      "src/commands/init.ts",
    ]);
    expect(result.changedFiles).toEqual(["src/commands/init.ts"]);
  });
});

describe("buildLocalCommands", () => {
  it("plans docs-only checks", () => {
    const scope = classifyChangedFiles(["README.md"]);
    expect(buildLocalCommands(scope, "abc")).toEqual([
      ["pnpm", ["check:docs"]],
    ]);
  });

  it("plans standard source checks", () => {
    const scope = classifyChangedFiles(["src/commands/init.ts"]);
    const commands = buildLocalCommands(scope, "abc");
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(["pnpm", ["typecheck"]]);
    expect(commands[1]).toEqual([
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--changed",
        "abc",
        "--reporter=agent",
        "--passWithNoTests",
      ],
    ]);
  });

  it("plans toolchain checks", () => {
    const scope = classifyChangedFiles(["package.json"]);
    const commands = buildLocalCommands(scope, "abc");
    expect(commands).toEqual([
      ["pnpm", ["check:supply-chain"]],
      ["pnpm", ["typecheck"]],
      [
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "tests/unit/scripts/check-supply-chain-invariants.test.ts",
          "--reporter=agent",
        ],
      ],
    ]);
  });

  it("plans process-control checks", () => {
    const scope = classifyChangedFiles(["src/lib/timeout.ts"]);
    const commands = buildLocalCommands(scope, "abc");
    expect(commands).toEqual([
      ["pnpm", ["typecheck"]],
      ["pnpm", ["build"]],
      [
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "tests/unit/core/project-fs-authority-resolvers.test.ts",
          "tests/unit/commands/verify-process.test.ts",
          "--reporter=agent",
        ],
      ],
      [
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
      ],
    ]);
  });

  it("plans docs + source checks without duplication", () => {
    const scope = classifyChangedFiles([
      "docs/usage.md",
      "src/commands/init.ts",
    ]);
    const commands = buildLocalCommands(scope, "abc");
    expect(commands).toEqual([
      ["pnpm", ["check:docs"]],
      ["pnpm", ["typecheck"]],
      [
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "--changed",
          "abc",
          "--reporter=agent",
          "--passWithNoTests",
        ],
      ],
    ]);
  });

  it("plans process-control + source checks with targeted unit tests", () => {
    const scope = classifyChangedFiles([
      "src/lib/timeout.ts",
      "src/commands/init.ts",
    ]);
    const commands = buildLocalCommands(scope, "abc");
    const labels = commands.map(([file, args]) => `${file} ${args.join(" ")}`);
    expect(new Set(labels).size).toBe(labels.length);
    expect(
      commands.some(cmd =>
        cmd[1].some(arg =>
          arg.includes("project-fs-authority-resolvers.test.ts"),
        ),
      ),
    ).toBe(true);
    expect(
      commands.some(cmd =>
        cmd[1].some(arg => arg.includes("verify-process.test.ts")),
      ),
    ).toBe(true);
    expect(
      commands.some(cmd =>
        cmd[1].some(arg => arg.includes("verify-timeout-abort.test.ts")),
      ),
    ).toBe(true);
    expect(commands.some(cmd => cmd[1].includes("--changed"))).toBe(true);
    expect(commands.filter(cmd => cmd[1].includes("typecheck"))).toHaveLength(
      1,
    );
  });

  it("falls back to HEAD when mergeBase is unknown", () => {
    const scope = classifyChangedFiles(["src/commands/init.ts"]);
    const commands = buildLocalCommands(scope, null);
    expect(commands[1]).toEqual([
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--changed",
        "HEAD",
        "--reporter=agent",
        "--passWithNoTests",
      ],
    ]);
  });

  it("does not include full CI commands", () => {
    const scopes = [
      classifyChangedFiles(["README.md"]),
      classifyChangedFiles(["package.json"]),
      classifyChangedFiles(["src/lib/timeout.ts"]),
      classifyChangedFiles(["docs/usage.md", "src/commands/init.ts"]),
    ];
    for (const scope of scopes) {
      const commands = buildLocalCommands(scope, "abc");
      const flat = JSON.stringify(commands);
      expect(flat).not.toContain("test:ci");
      expect(flat).not.toContain("test:ci:deep");
      expect(flat).not.toContain("release:check");
    }
  });
});

describe("git diff integration", () => {
  function runInRepo(cwd: string, args: string[]) {
    return execFileSync(process.execPath, [scriptPath, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: "" },
    }).trim();
  }

  function initRepo(cwd: string) {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
  }

  function commitAll(cwd: string, message: string) {
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", message], { cwd });
  }

  function commitSha(cwd: string, ref = "HEAD") {
    return execFileSync("git", ["rev-parse", ref], {
      cwd,
      encoding: "utf8",
    }).trim();
  }

  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "verify-scope-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("detects deleted files as standard changes", () => {
    initRepo(tempDir);
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "a.ts"), "export default 1;");
    commitAll(tempDir, "base");
    const base = commitSha(tempDir);

    execFileSync("git", ["rm", "src/a.ts"], { cwd: tempDir });
    commitAll(tempDir, "delete");

    const out = runInRepo(tempDir, ["--base", base, "--format", "json"]);
    const scope = JSON.parse(out);
    expect(scope.changedFiles).toContain("src/a.ts");
    expect(scope.standard).toBe(true);
    expect(scope.docs).toBe(false);
  });

  it("detects renamed files as both deletion and addition", () => {
    initRepo(tempDir);
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "a.ts"), "export default 1;");
    commitAll(tempDir, "base");
    const base = commitSha(tempDir);

    mkdirSync(join(tempDir, "docs"), { recursive: true });
    execFileSync("git", ["mv", "src/a.ts", "docs/a.md"], { cwd: tempDir });
    commitAll(tempDir, "rename");

    const out = runInRepo(tempDir, ["--base", base, "--format", "json"]);
    const scope = JSON.parse(out);
    expect(scope.changedFiles).toContain("src/a.ts");
    expect(scope.changedFiles).toContain("docs/a.md");
    expect(scope.standard).toBe(true);
    expect(scope.docs).toBe(true);
    expect(scope.reason).toBe("docs+standard");
  });

  it("falls back to consistent fail-safe scope when base ref cannot be resolved", () => {
    initRepo(tempDir);
    writeFileSync(join(tempDir, "README.md"), "# test");
    commitAll(tempDir, "base");

    const out = runInRepo(tempDir, [
      "--base",
      "nonexistent-ref",
      "--format",
      "json",
    ]);
    const scope = JSON.parse(out);
    expect(scope.changedFiles).toEqual([]);
    expect(scope.docs).toBe(true);
    expect(scope.standard).toBe(true);
    expect(scope.generic).toBe(true);
    expect(scope.toolchain).toBe(false);
    expect(scope.processControl).toBe(false);
    expect(scope.reason).toBe("fail-safe");
  });
});

describe("collectLocalChangedFiles", () => {
  const fakeGitNodeScript = `#!/usr/bin/env node
import fs from "node:fs";
const config = JSON.parse(fs.readFileSync(process.env.FAKE_GIT_CONFIG, "utf8"));
const [, , ...args] = process.argv;
const cmd = args[0];
if (cmd === "merge-base") {
  process.exit(1);
}
if (cmd === "diff" && args.includes("--cached")) {
  if (config.stagedFail) {
    console.error("fake staged error");
    process.exit(1);
  }
  for (const f of config.staged || []) console.log(f);
  process.exit(0);
}
if (cmd === "diff") {
  for (const f of config.unstaged || []) console.log(f);
  process.exit(0);
}
if (cmd === "ls-files" && args.includes("--others")) {
  if (config.untrackedFail) {
    console.error("fake untracked error");
    process.exit(1);
  }
  for (const f of config.untracked || []) console.log(f);
  process.exit(0);
}
console.error("fake git: unsupported " + args.join(" "));
process.exit(1);
`;

  let tempDir: string;
  let configPath: string;
  let originalPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fake-git-"));
    configPath = join(tempDir, "config.json");
    writeFakeExecutable(tempDir, "git", "fake-git.mjs", fakeGitNodeScript);
    originalPath = process.env.PATH ?? "";
    process.env.PATH = `${tempDir}${delimiter}${originalPath}`;
    process.env.FAKE_GIT_CONFIG = configPath;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env.PATH = originalPath;
    delete process.env.FAKE_GIT_CONFIG;
  });

  it("throws when git diff --cached fails", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ unstaged: ["README.md"], stagedFail: true }),
    );
    await expect(collectLocalChangedFiles()).rejects.toThrow(
      "git diff --no-renames --cached --name-only failed",
    );
  });

  it("throws when git ls-files --others fails", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ unstaged: ["README.md"], untrackedFail: true }),
    );
    await expect(collectLocalChangedFiles()).rejects.toThrow(
      "git ls-files --others --exclude-standard failed",
    );
  });

  it("returns baseResolved false when main/origin/main is missing and working tree has README.md", async () => {
    writeFileSync(configPath, JSON.stringify({ unstaged: ["README.md"] }));
    const result = await collectLocalChangedFiles();
    expect(result.files).toEqual(["README.md"]);
    expect(result.mergeBase).toBeNull();
    expect(result.baseResolved).toBe(false);
  });

  it("returns empty files and baseResolved false when no base and no working tree changes", async () => {
    writeFileSync(configPath, JSON.stringify({}));
    const result = await collectLocalChangedFiles();
    expect(result.files).toEqual([]);
    expect(result.mergeBase).toBeNull();
    expect(result.baseResolved).toBe(false);
  });
});

describe("local verification integration", () => {
  const fakeGitNodeScript = `#!/usr/bin/env node
import fs from "node:fs";
const config = JSON.parse(fs.readFileSync(process.env.FAKE_GIT_CONFIG, "utf8"));
const [, , ...args] = process.argv;
const cmd = args[0];
if (cmd === "merge-base") {
  process.exit(1);
}
if (cmd === "diff" && args.includes("--cached")) {
  for (const f of config.staged || []) console.log(f);
  process.exit(0);
}
if (cmd === "diff") {
  for (const f of config.unstaged || []) console.log(f);
  process.exit(0);
}
if (cmd === "ls-files" && args.includes("--others")) {
  for (const f of config.untracked || []) console.log(f);
  process.exit(0);
}
console.error("fake git: unsupported " + args.join(" "));
process.exit(1);
`;

  const fakePnpmScript = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.FAKE_PNPM_LOG) {
  fs.appendFileSync(
    process.env.FAKE_PNPM_LOG,
    process.argv.slice(2).join(" ") + "\\n",
  );
}
process.exit(0);
`;

  let tempDir: string;
  let originalPath: string;

  function runScript(
    cwd: string,
    args: string[],
    env: Record<string, string> = {},
  ) {
    return execFileSync(process.execPath, [scriptPath, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
    }).trim();
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "verify-local-"));
    const pnpmPath = join(tempDir, "pnpm.cjs");
    writeFakeExecutable(tempDir, "git", "fake-git.mjs", fakeGitNodeScript);
    writeFileSync(pnpmPath, fakePnpmScript);
    originalPath = process.env.PATH ?? "";
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env.PATH = originalPath;
  });

  it("reports fail-safe scope when base cannot be resolved and only README.md changed", () => {
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ unstaged: ["README.md"] }));
    const out = runScript(process.cwd(), ["--local", "--format", "json"], {
      PATH: `${tempDir}${delimiter}${originalPath}`,
      FAKE_GIT_CONFIG: configPath,
    });
    const scope = JSON.parse(out);
    expect(scope.docs).toBe(true);
    expect(scope.standard).toBe(true);
    expect(scope.generic).toBe(true);
    expect(scope.reason).toBe("fail-safe");
  });

  it("preserves toolchain scope when base cannot be resolved", () => {
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ unstaged: ["package.json"] }));
    const out = runScript(process.cwd(), ["--local", "--format", "json"], {
      PATH: `${tempDir}${delimiter}${originalPath}`,
      FAKE_GIT_CONFIG: configPath,
    });
    const scope = JSON.parse(out);
    expect(scope.changedFiles).toEqual(["package.json"]);
    expect(scope.docs).toBe(true);
    expect(scope.standard).toBe(true);
    expect(scope.toolchain).toBe(true);
    expect(scope.processControl).toBe(false);
    expect(scope.generic).toBe(true);
    expect(scope.reason).toBe("fail-safe");
  });

  it("preserves process-control scope when base cannot be resolved", () => {
    const configPath = join(tempDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ unstaged: ["src/lib/timeout.ts"] }),
    );
    const out = runScript(process.cwd(), ["--local", "--format", "json"], {
      PATH: `${tempDir}${delimiter}${originalPath}`,
      FAKE_GIT_CONFIG: configPath,
    });
    const scope = JSON.parse(out);
    expect(scope.changedFiles).toEqual(["src/lib/timeout.ts"]);
    expect(scope.docs).toBe(true);
    expect(scope.standard).toBe(true);
    expect(scope.toolchain).toBe(false);
    expect(scope.processControl).toBe(true);
    expect(scope.generic).toBe(true);
    expect(scope.reason).toBe("fail-safe");
  });

  it("does not report no tracked changes when base is unknown and tree is empty", () => {
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({}));
    const out = runScript(process.cwd(), ["--local", "--format", "json"], {
      PATH: `${tempDir}${delimiter}${originalPath}`,
      FAKE_GIT_CONFIG: configPath,
    });
    const scope = JSON.parse(out);
    expect(scope.reason).toBe("fail-safe");
    expect(out).not.toContain("no tracked changes");
  });

  it("runs fail-safe checks when base is unknown and tree is empty", () => {
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({}));
    const pnpmPath = join(tempDir, "pnpm.cjs");
    const out = runScript(process.cwd(), ["--local", "--run"], {
      PATH: `${tempDir}${delimiter}${originalPath}`,
      FAKE_GIT_CONFIG: configPath,
      npm_execpath: pnpmPath,
    });
    expect(out).toContain("verify:local: scope=fail-safe");
    expect(out).toContain("verify:local: 3 checks passed");
    expect(out).not.toContain("no tracked changes");
  });

  it("runs toolchain checks when base is unknown and package.json changed", () => {
    const configPath = join(tempDir, "config.json");
    const pnpmPath = join(tempDir, "pnpm.cjs");
    const pnpmLogPath = join(tempDir, "pnpm.log");
    writeFileSync(configPath, JSON.stringify({ unstaged: ["package.json"] }));
    const out = runScript(process.cwd(), ["--local", "--run"], {
      PATH: `${tempDir}${delimiter}${originalPath}`,
      FAKE_GIT_CONFIG: configPath,
      FAKE_PNPM_LOG: pnpmLogPath,
      npm_execpath: pnpmPath,
    });
    const pnpmLog = readFileSync(pnpmLogPath, "utf8");
    expect(out).toContain("verify:local: scope=fail-safe");
    expect(pnpmLog).toContain("check:supply-chain");
    expect(pnpmLog).toContain(
      "tests/unit/scripts/check-supply-chain-invariants.test.ts",
    );
  });

  it("runs process-control checks when base is unknown and timeout changed", () => {
    const configPath = join(tempDir, "config.json");
    const pnpmPath = join(tempDir, "pnpm.cjs");
    const pnpmLogPath = join(tempDir, "pnpm.log");
    writeFileSync(
      configPath,
      JSON.stringify({ unstaged: ["src/lib/timeout.ts"] }),
    );
    const out = runScript(process.cwd(), ["--local", "--run"], {
      PATH: `${tempDir}${delimiter}${originalPath}`,
      FAKE_GIT_CONFIG: configPath,
      FAKE_PNPM_LOG: pnpmLogPath,
      npm_execpath: pnpmPath,
    });
    const pnpmLog = readFileSync(pnpmLogPath, "utf8");
    expect(out).toContain("verify:local: scope=fail-safe");
    expect(pnpmLog).toContain("build");
    expect(pnpmLog).toContain(
      "tests/unit/core/project-fs-authority-resolvers.test.ts",
    );
    expect(pnpmLog).toContain("tests/unit/commands/verify-process.test.ts");
    expect(pnpmLog).toContain("tests/integration/verify-timeout-abort.test.ts");
  });
});
