import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  classifyChangedFiles,
  buildLocalCommands,
} from "../../../scripts/verification-scope.mjs";

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
  const scriptPath = fileURLToPath(
    new URL("../../../scripts/verification-scope.mjs", import.meta.url),
  );

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

  it("falls back to docs+standard when base ref cannot be resolved", () => {
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
    expect(scope.docs).toBe(true);
    expect(scope.standard).toBe(true);
    expect(scope.reason).toBe("docs+standard");
  });
});
