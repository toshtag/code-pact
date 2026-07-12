import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function commandLabels(commands: Array<[string, string[]]>) {
  return commands.map(([file, args]) => `${file} ${args.join(" ")}`);
}

function vitestCommands(commands: Array<[string, string[]]>) {
  return commands.filter(
    ([file, args]) => file === "pnpm" && args.includes("vitest"),
  );
}

function changedVitestCommands(commands: Array<[string, string[]]>) {
  return vitestCommands(commands).filter(([, args]) =>
    args.includes("--changed"),
  );
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
    const labels = commandLabels(commands);
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

  it("runs all unit tests when mergeBase is unknown", () => {
    const scope = classifyChangedFiles(["src/commands/init.ts"]);
    const commands = buildLocalCommands(scope, null);
    expect(commands[1]).toEqual([
      "pnpm",
      ["exec", "vitest", "run", "--reporter=agent"],
    ]);
  });

  it("uses valueless --changed for unstaged source changes", () => {
    const scope = classifyChangedFiles(["src/commands/init.ts"]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: [],
      workingTreeFiles: ["src/commands/init.ts"],
      untrackedFiles: [],
    });
    expect(commands[1]).toEqual([
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--changed",
        "--reporter=agent",
        "--passWithNoTests",
      ],
    ]);
  });

  it("uses valueless --changed for staged test file changes", () => {
    const scope = classifyChangedFiles(["tests/unit/commands/init.test.ts"]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: [],
      workingTreeFiles: ["tests/unit/commands/init.test.ts"],
      untrackedFiles: [],
    });
    expect(commands[1]).toEqual([
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--changed",
        "--reporter=agent",
        "--passWithNoTests",
      ],
    ]);
  });

  it("runs all unit tests for untracked source changes", () => {
    const scope = classifyChangedFiles(["src/new-feature.ts"]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: [],
      workingTreeFiles: ["src/new-feature.ts"],
      untrackedFiles: ["src/new-feature.ts"],
    });
    expect(commands[1]).toEqual([
      "pnpm",
      ["exec", "vitest", "run", "--reporter=agent"],
    ]);
    const unitCommand = commands[1] as [string, string[]];
    expect(unitCommand[1]).not.toContain("--passWithNoTests");
  });

  it("runs all unit tests when an untracked generic file is present alongside tracked changes", () => {
    const scope = classifyChangedFiles([
      "src/commands/init.ts",
      "src/commands/task-start.ts",
    ]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: ["src/commands/init.ts"],
      workingTreeFiles: ["src/commands/task-start.ts"],
      untrackedFiles: ["src/commands/task-start.ts"],
    });
    expect(vitestCommands(commands)).toEqual([
      ["pnpm", ["exec", "vitest", "run", "--reporter=agent"]],
    ]);
  });

  it("runs all unit tests for untracked test file changes", () => {
    const scope = classifyChangedFiles(["tests/unit/new-feature.test.ts"]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: [],
      workingTreeFiles: ["tests/unit/new-feature.test.ts"],
      untrackedFiles: ["tests/unit/new-feature.test.ts"],
    });
    expect(commands[1]).toEqual([
      "pnpm",
      ["exec", "vitest", "run", "--reporter=agent"],
    ]);
  });

  it("keeps --changed mergeBase for committed source changes only", () => {
    const scope = classifyChangedFiles(["src/commands/init.ts"]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: ["src/commands/init.ts"],
      workingTreeFiles: [],
      untrackedFiles: [],
    });
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

  it("plans committed and working-tree source checks separately", () => {
    const scope = classifyChangedFiles([
      "src/commands/init.ts",
      "src/commands/task-start.ts",
    ]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: ["src/commands/init.ts"],
      workingTreeFiles: ["src/commands/task-start.ts"],
      untrackedFiles: [],
    });
    expect(commands).toContainEqual([
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
    expect(commands).toContainEqual([
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--changed",
        "--reporter=agent",
        "--passWithNoTests",
      ],
    ]);
  });

  it("deduplicates changed Vitest when base and working tree contain the same generic file", () => {
    const scope = classifyChangedFiles(["src/commands/init.ts"]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: ["src/commands/init.ts"],
      workingTreeFiles: ["src/commands/init.ts"],
      untrackedFiles: [],
    });
    expect(changedVitestCommands(commands)).toEqual([
      [
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "--changed",
          "--reporter=agent",
          "--passWithNoTests",
        ],
      ],
    ]);
  });

  it("uses valueless changed Vitest when working tree generic files contain base generic files", () => {
    const scope = classifyChangedFiles([
      "src/commands/init.ts",
      "src/commands/task-start.ts",
    ]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: ["src/commands/init.ts"],
      workingTreeFiles: ["src/commands/init.ts", "src/commands/task-start.ts"],
      untrackedFiles: [],
    });
    expect(changedVitestCommands(commands)).toEqual([
      [
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "--changed",
          "--reporter=agent",
          "--passWithNoTests",
        ],
      ],
    ]);
  });

  it("uses merge-base changed Vitest when base generic files contain working tree generic files", () => {
    const scope = classifyChangedFiles([
      "src/commands/init.ts",
      "src/commands/task-start.ts",
    ]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: ["src/commands/init.ts", "src/commands/task-start.ts"],
      workingTreeFiles: ["src/commands/init.ts"],
      untrackedFiles: [],
    });
    expect(changedVitestCommands(commands)).toEqual([
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

  it("keeps both changed Vitest commands for disjoint generic files", () => {
    const scope = classifyChangedFiles([
      "src/commands/init.ts",
      "src/commands/task-start.ts",
    ]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: ["src/commands/init.ts"],
      workingTreeFiles: ["src/commands/task-start.ts"],
      untrackedFiles: [],
    });
    expect(changedVitestCommands(commands)).toEqual([
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
      [
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "--changed",
          "--reporter=agent",
          "--passWithNoTests",
        ],
      ],
    ]);
  });

  it("keeps both changed Vitest commands when generic files only partially overlap", () => {
    const scope = classifyChangedFiles([
      "src/commands/init.ts",
      "src/commands/task-start.ts",
      "src/commands/status.ts",
    ]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: ["src/commands/init.ts", "src/commands/task-start.ts"],
      workingTreeFiles: ["src/commands/task-start.ts", "src/commands/status.ts"],
      untrackedFiles: [],
    });
    expect(changedVitestCommands(commands)).toHaveLength(2);
  });

  it("does not use vitest related for partial overlap", () => {
    const scope = classifyChangedFiles([
      "src/commands/init.ts",
      "src/commands/task-start.ts",
      "src/commands/status.ts",
    ]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: ["src/commands/init.ts", "src/commands/task-start.ts"],
      workingTreeFiles: ["src/commands/task-start.ts", "src/commands/status.ts"],
      untrackedFiles: [],
    });
    expect(JSON.stringify(commands)).not.toContain("related");
  });

  it("runs all unit tests when local git state is indeterminate", () => {
    const scope = classifyChangedFiles(["src/commands/init.ts"]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: ["src/commands/init.ts"],
      workingTreeFiles: [],
      untrackedFiles: [],
      indeterminate: true,
    });
    expect(commands[1]).toEqual([
      "pnpm",
      ["exec", "vitest", "run", "--reporter=agent"],
    ]);
  });

  it("keeps targeted process-control and toolchain commands when optimizing generic Vitest", () => {
    const scope = classifyChangedFiles([
      "src/lib/timeout.ts",
      "package.json",
      "src/commands/init.ts",
    ]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: ["src/commands/init.ts"],
      workingTreeFiles: ["src/commands/init.ts"],
      untrackedFiles: [],
    });
    expect(
      commands.some(cmd =>
        cmd[1].some(arg =>
          arg.includes("check-supply-chain-invariants.test.ts"),
        ),
      ),
    ).toBe(true);
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
    expect(changedVitestCommands(commands)).toHaveLength(1);
  });

  it("does not plan duplicate command labels", () => {
    const scope = classifyChangedFiles([
      "src/lib/timeout.ts",
      "package.json",
      "src/commands/init.ts",
    ]);
    const commands = buildLocalCommands(scope, "abc", {
      baseFiles: ["src/commands/init.ts"],
      workingTreeFiles: ["src/commands/init.ts"],
      untrackedFiles: [],
    });
    const labels = commandLabels(commands);
    expect(new Set(labels).size).toBe(labels.length);
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
  function fakeGit(config: {
    mergeBase?: string;
    base?: string[];
    unstaged?: string[];
    staged?: string[];
    untracked?: string[];
    stagedFail?: boolean;
    untrackedFail?: boolean;
  }) {
    return async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "merge-base") {
        return config.mergeBase
          ? { code: 0, stdout: `${config.mergeBase}\n`, stderr: "" }
          : { code: 1, stdout: "", stderr: "no merge base" };
      }
      if (cmd === "diff" && args.some(arg => arg.endsWith("...HEAD"))) {
        return {
          code: 0,
          stdout: `${(config.base ?? []).join("\n")}\n`,
          stderr: "",
        };
      }
      if (cmd === "diff" && args.includes("--cached")) {
        if (config.stagedFail) {
          return { code: 1, stdout: "", stderr: "fake staged error" };
        }
        return {
          code: 0,
          stdout: `${(config.staged ?? []).join("\n")}\n`,
          stderr: "",
        };
      }
      if (cmd === "diff") {
        return {
          code: 0,
          stdout: `${(config.unstaged ?? []).join("\n")}\n`,
          stderr: "",
        };
      }
      if (cmd === "ls-files" && args.includes("--others")) {
        if (config.untrackedFail) {
          return { code: 1, stdout: "", stderr: "fake untracked error" };
        }
        return {
          code: 0,
          stdout: `${(config.untracked ?? []).join("\n")}\n`,
          stderr: "",
        };
      }
      return {
        code: 1,
        stdout: "",
        stderr: `fake git: unsupported ${args.join(" ")}`,
      };
    };
  }

  it("marks the result indeterminate when git diff --cached fails", async () => {
    const result = await collectLocalChangedFiles({
      runGitImpl: fakeGit({ unstaged: ["README.md"], stagedFail: true }),
    });
    expect(result.files).toEqual(["README.md"]);
    expect(result.workingTreeFiles).toEqual(["README.md"]);
    expect(result.indeterminate).toBe(true);
  });

  it("marks the result indeterminate when git ls-files --others fails", async () => {
    const result = await collectLocalChangedFiles({
      runGitImpl: fakeGit({ unstaged: ["README.md"], untrackedFail: true }),
    });
    expect(result.files).toEqual(["README.md"]);
    expect(result.workingTreeFiles).toEqual(["README.md"]);
    expect(result.indeterminate).toBe(true);
  });

  it("preserves base files when a later git query fails", async () => {
    const result = await collectLocalChangedFiles({
      runGitImpl: fakeGit({
        mergeBase: "abc123",
        base: ["package.json"],
        stagedFail: true,
      }),
    });
    expect(result.files).toEqual(["package.json"]);
    expect(result.baseFiles).toEqual(["package.json"]);
    expect(result.workingTreeFiles).toEqual([]);
    expect(result.mergeBase).toBe("abc123");
    expect(result.baseResolved).toBe(true);
    expect(result.indeterminate).toBe(true);
  });

  it("returns baseResolved false when main/origin/main is missing and working tree has README.md", async () => {
    const result = await collectLocalChangedFiles({
      runGitImpl: fakeGit({ unstaged: ["README.md"] }),
    });
    expect(result.files).toEqual(["README.md"]);
    expect(result.baseFiles).toEqual([]);
    expect(result.workingTreeFiles).toEqual(["README.md"]);
    expect(result.unstagedFiles).toEqual(["README.md"]);
    expect(result.stagedFiles).toEqual([]);
    expect(result.untrackedFiles).toEqual([]);
    expect(result.mergeBase).toBeNull();
    expect(result.baseResolved).toBe(false);
    expect(result.indeterminate).toBe(false);
  });

  it("returns empty files and baseResolved false when no base and no working tree changes", async () => {
    const result = await collectLocalChangedFiles({ runGitImpl: fakeGit({}) });
    expect(result.files).toEqual([]);
    expect(result.baseFiles).toEqual([]);
    expect(result.workingTreeFiles).toEqual([]);
    expect(result.mergeBase).toBeNull();
    expect(result.baseResolved).toBe(false);
    expect(result.indeterminate).toBe(false);
  });
});

describe("local verification integration", () => {
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
  let repoDir: string;
  let toolsDir: string;

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

  function initRepoWithoutMain(cwd: string) {
    execFileSync("git", ["init", "--initial-branch=feature"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    writeFileSync(join(cwd, ".initial"), "initial\n");
    execFileSync("git", ["add", ".initial"], { cwd });
    execFileSync("git", ["commit", "-m", "initial"], { cwd });
  }

  function initRepoWithMainAndFeature(cwd: string) {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, ".initial"), "initial\n");
    writeFileSync(join(cwd, "src", "existing.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", ".initial"], { cwd });
    execFileSync("git", ["add", "src/existing.ts"], { cwd });
    execFileSync("git", ["commit", "-m", "initial"], { cwd });
    execFileSync("git", ["switch", "-c", "feature"], { cwd });
  }

  function runLocalWithPnpmLog() {
    const pnpmPath = join(toolsDir, "pnpm.cjs");
    const pnpmLogPath = join(toolsDir, "pnpm.log");
    const out = runScript(repoDir, ["--local", "--run"], {
      FAKE_PNPM_LOG: pnpmLogPath,
      npm_execpath: pnpmPath,
    });
    const pnpmLog = readFileSync(pnpmLogPath, "utf8");
    return { out, pnpmLog };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "verify-local-"));
    repoDir = join(tempDir, "repo");
    toolsDir = join(tempDir, "tools");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(toolsDir, { recursive: true });
    initRepoWithoutMain(repoDir);
    const pnpmPath = join(toolsDir, "pnpm.cjs");
    writeFileSync(pnpmPath, fakePnpmScript);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports fail-safe scope when base cannot be resolved and only README.md changed", () => {
    writeFileSync(join(repoDir, "README.md"), "# test");
    const out = runScript(repoDir, ["--local", "--format", "json"]);
    const scope = JSON.parse(out);
    expect(scope.docs).toBe(true);
    expect(scope.standard).toBe(true);
    expect(scope.generic).toBe(true);
    expect(scope.reason).toBe("fail-safe");
  });

  it("preserves toolchain scope when base cannot be resolved", () => {
    writeFileSync(join(repoDir, "package.json"), "{}");
    const out = runScript(repoDir, ["--local", "--format", "json"]);
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
    mkdirSync(join(repoDir, "src", "lib"), { recursive: true });
    writeFileSync(join(repoDir, "src", "lib", "timeout.ts"), "export {};\n");
    const out = runScript(repoDir, ["--local", "--format", "json"]);
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
    const out = runScript(repoDir, ["--local", "--format", "json"]);
    const scope = JSON.parse(out);
    expect(scope.reason).toBe("fail-safe");
    expect(out).not.toContain("no tracked changes");
  });

  it("runs fail-safe checks when base is unknown and tree is empty", () => {
    const pnpmPath = join(toolsDir, "pnpm.cjs");
    const out = runScript(repoDir, ["--local", "--run"], {
      npm_execpath: pnpmPath,
    });
    expect(out).toContain("verify:local: scope=fail-safe");
    expect(out).toContain("verify:local: 3 checks passed");
    expect(out).not.toContain("no tracked changes");
  });

  it("runs toolchain checks when base is unknown and package.json changed", () => {
    const pnpmPath = join(toolsDir, "pnpm.cjs");
    const pnpmLogPath = join(toolsDir, "pnpm.log");
    writeFileSync(join(repoDir, "package.json"), "{}");
    const out = runScript(repoDir, ["--local", "--run"], {
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
    mkdirSync(join(repoDir, "src", "lib"), { recursive: true });
    writeFileSync(join(repoDir, "src", "lib", "timeout.ts"), "export {};\n");
    const { out, pnpmLog } = runLocalWithPnpmLog();
    expect(out).toContain("verify:local: scope=fail-safe");
    expect(pnpmLog).toContain("build");
    expect(pnpmLog).toContain(
      "tests/unit/core/project-fs-authority-resolvers.test.ts",
    );
    expect(pnpmLog).toContain("tests/unit/commands/verify-process.test.ts");
    expect(pnpmLog).toContain("tests/integration/verify-timeout-abort.test.ts");
  });

  it("uses valueless --changed for unstaged source changes when base resolves", () => {
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });
    initRepoWithMainAndFeature(repoDir);
    writeFileSync(join(repoDir, "src", "existing.ts"), "export const a = 2;\n");

    const { pnpmLog } = runLocalWithPnpmLog();
    expect(pnpmLog).toContain(
      "exec vitest run --changed --reporter=agent --passWithNoTests",
    );
    expect(pnpmLog).not.toMatch(/--changed [0-9a-f]{40}/);
  });

  it("uses valueless --changed for staged test file changes when base resolves", () => {
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });
    initRepoWithMainAndFeature(repoDir);
    mkdirSync(join(repoDir, "tests", "unit"), { recursive: true });
    writeFileSync(
      join(repoDir, "tests", "unit", "a.test.ts"),
      "it('a', () => {});\n",
    );
    execFileSync("git", ["add", "tests/unit/a.test.ts"], { cwd: repoDir });

    const { pnpmLog } = runLocalWithPnpmLog();
    expect(pnpmLog).toContain(
      "exec vitest run --changed --reporter=agent --passWithNoTests",
    );
  });

  it("runs all unit tests for untracked source changes when base resolves", () => {
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });
    initRepoWithMainAndFeature(repoDir);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "untracked.ts"), "export {};\n");

    const { pnpmLog } = runLocalWithPnpmLog();
    expect(pnpmLog).toContain("exec vitest run --reporter=agent");
    expect(pnpmLog).not.toContain("--passWithNoTests");
  });

  it("keeps merge-base --changed for committed source changes only", () => {
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });
    initRepoWithMainAndFeature(repoDir);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "committed.ts"), "export {};\n");
    execFileSync("git", ["add", "src/committed.ts"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: repoDir });

    const { pnpmLog } = runLocalWithPnpmLog();
    expect(pnpmLog).toMatch(
      /exec vitest run --changed [0-9a-f]{40} --reporter=agent --passWithNoTests/,
    );
  });

  it("checks both committed and working-tree source changes", () => {
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });
    initRepoWithMainAndFeature(repoDir);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "committed.ts"), "export {};\n");
    execFileSync("git", ["add", "src/committed.ts"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: repoDir });
    writeFileSync(join(repoDir, "src", "existing.ts"), "export const a = 2;\n");

    const { pnpmLog } = runLocalWithPnpmLog();
    expect(pnpmLog).toMatch(
      /exec vitest run --changed [0-9a-f]{40} --reporter=agent --passWithNoTests/,
    );
    expect(pnpmLog).toContain(
      "exec vitest run --changed --reporter=agent --passWithNoTests",
    );
  });
});
