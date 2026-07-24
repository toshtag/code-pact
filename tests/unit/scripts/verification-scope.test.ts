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
  collectLocalChangedFiles,
  buildVerificationPlan,
} from "../../../scripts/verification-scope.mjs";

const scriptPath = fileURLToPath(
  new URL("../../../scripts/verification-scope.mjs", import.meta.url),
);

function stepLabels(plan: { steps: Array<{ command: string[] }> }) {
  return plan.steps.map(s => s.command.join(" "));
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
      workflow: false,
      releaseScript: false,
      sharedTestInfra: false,
      unknown: false,
      highRisk: false,
      fallbackFull: false,
      mode: "focused",
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
    expect(result.highRisk).toBe(true);
    expect(result.fallbackFull).toBe(true);
    expect(result.reason).toBe("high-risk+toolchain");
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
    expect(result.highRisk).toBe(true);
    expect(result.reason).toBe("high-risk+toolchain");
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
    expect(result.highRisk).toBe(true);
    expect(result.reason).toBe("high-risk+process-control+toolchain");
  });

  it("deduplicates changed files in the returned list", () => {
    const result = classifyChangedFiles([
      "src/commands/init.ts",
      "src/commands/init.ts",
    ]);
    expect(result.changedFiles).toEqual(["src/commands/init.ts"]);
  });
});

describe("plan command extraction", () => {
  function planFor(files: string[], mergeBase: string | null = "abc123") {
    const scope = classifyChangedFiles(files);
    return buildVerificationPlan({
      scope,
      changeSet: {
        baseFiles: files,
        workingTreeFiles: [],
        untrackedFiles: [],
        indeterminate: false,
      },
      mergeBase,
      baseSha: mergeBase,
      headSha: "def456",
    });
  }

  it("docs-only plan has only docs check", () => {
    const plan = planFor(["README.md"]);
    expect(plan.steps.map(s => s.id)).toEqual(["docs"]);
    expect(plan.steps[0]?.command).toEqual(["pnpm", "check:docs"]);
  });

  it("unit-test-only runs the changed file directly without build or integration", () => {
    const plan = planFor(["tests/unit/scripts/verification-scope.test.ts"]);
    expect(plan.steps.map(s => s.id)).toEqual(["typecheck", "unit-direct"]);
    const unit = plan.steps.find(s => s.id === "unit-direct");
    expect(unit?.command.join(" ")).toContain(
      "tests/unit/scripts/verification-scope.test.ts",
    );
    expect(stepLabels(plan).some(l => l.includes(" build"))).toBe(false);
    expect(stepLabels(plan).some(l => l.includes("integration"))).toBe(false);
  });

  it("integration-test-only runs the changed file directly with build", () => {
    const plan = planFor(["tests/integration/task-registration-spec.test.ts"]);
    expect(plan.steps.map(s => s.id)).toEqual([
      "typecheck",
      "build",
      "integration-direct",
    ]);
    const int = plan.steps.find(s => s.id === "integration-direct");
    expect(int?.command.join(" ")).toContain("task-registration-spec.test.ts");
    expect(int?.command.join(" ")).toContain("vitest.integration.config.ts");
  });

  it("source changes run --changed authority and integration smoke with build", () => {
    const plan = planFor(["src/commands/init.ts"]);
    expect(plan.steps.map(s => s.id)).toEqual([
      "typecheck",
      "unit-base",
      "build",
      "integration-smoke",
    ]);
    const unit = plan.steps.find(s => s.id === "unit-base");
    expect(unit?.command).toContain("--changed");
    expect(unit?.command).toContain("abc123");
    expect(unit?.command).toContain("--passWithNoTests");
  });

  it("workflow changes run mapped workflow tests without build", () => {
    const plan = planFor([".github/workflows/ci.yml"]);
    expect(plan.steps.map(s => s.id)).toEqual([
      "supply-chain",
      "typecheck",
      "workflow-tests",
    ]);
    const wf = plan.steps.find(s => s.id === "workflow-tests");
    expect(wf?.command.join(" ")).toContain("ci-workflow.test.ts");
    expect(wf?.command.join(" ")).toContain(
      "check-supply-chain-invariants.test.ts",
    );
    expect(stepLabels(plan).some(l => l.includes(" build"))).toBe(false);
  });

  it("mapped release script changes run targeted release tests without build", () => {
    const plan = planFor(["scripts/check-release-tag.mjs"]);
    expect(plan.steps.map(s => s.id)).toEqual(["typecheck", "release-tests"]);
    const rel = plan.steps.find(s => s.id === "release-tests");
    expect(rel?.command.join(" ")).toContain("check-release-tag.test.ts");
    expect(rel?.command.join(" ")).toContain("publish-workflow.test.ts");
    expect(rel?.command.join(" ")).toContain(
      "check-supply-chain-invariants.test.ts",
    );
    expect(stepLabels(plan).some(l => l.includes(" build"))).toBe(false);
  });

  it("process-control changes run targeted unit and integration tests", () => {
    const plan = planFor(["src/lib/timeout.ts"]);
    expect(plan.steps.map(s => s.id)).toEqual([
      "typecheck",
      "process-control-unit",
      "build",
      "integration-process-control",
    ]);
  });

  it("source + unit test uses --changed and does not double-run unit-direct", () => {
    const plan = planFor([
      "src/commands/init.ts",
      "tests/unit/commands/init.test.ts",
    ]);
    expect(plan.steps.some(s => s.id === "unit-base")).toBe(true);
    expect(plan.steps.some(s => s.id === "unit-direct")).toBe(false);
  });

  it("source + integration test runs integration-direct and no smoke", () => {
    const plan = planFor([
      "src/commands/init.ts",
      "tests/integration/foo.test.ts",
    ]);
    expect(plan.steps.some(s => s.id === "integration-direct")).toBe(true);
    expect(plan.steps.some(s => s.id === "integration-smoke")).toBe(false);
  });

  it("untracked source falls back to full unit tests", () => {
    const plan = buildVerificationPlan({
      scope: classifyChangedFiles(["src/commands/init.ts"]),
      changeSet: {
        baseFiles: [],
        workingTreeFiles: ["src/commands/init.ts"],
        untrackedFiles: ["src/commands/init.ts"],
        indeterminate: false,
      },
      mergeBase: "abc123",
      baseSha: "abc123",
      headSha: "def456",
    });
    expect(plan.mode).toBe("full");
    expect(plan.steps.some(s => s.id === "unit")).toBe(true);
    expect(plan.steps.some(s => s.id === "integration-full")).toBe(true);
  });

  it("does not include full CI scripts", () => {
    const scopes = [
      classifyChangedFiles(["README.md"]),
      classifyChangedFiles(["package.json"]),
      classifyChangedFiles(["src/lib/timeout.ts"]),
      classifyChangedFiles(["docs/usage.md", "src/commands/init.ts"]),
    ];
    for (const scope of scopes) {
      const plan = buildVerificationPlan({
        scope,
        changeSet: {
          baseFiles: scope.changedFiles,
          workingTreeFiles: [],
          untrackedFiles: [],
          indeterminate: false,
        },
        mergeBase: "abc123",
        baseSha: "abc123",
        headSha: "def456",
      });
      const flat = JSON.stringify(plan.steps);
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

  const fakeCliScript = `const args = process.argv.slice(2);
if (args.includes("--json")) {
  console.log(JSON.stringify({ version: "0.0.0" }));
} else {
  console.log("0.0.0");
}
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
    mkdirSync(join(cwd, "dist"), { recursive: true });
    writeFileSync(join(cwd, "dist", "cli.js"), fakeCliScript);
    execFileSync("git", ["add", ".initial", "dist/cli.js"], { cwd });
    execFileSync("git", ["commit", "-m", "initial"], { cwd });
  }

  function initRepoWithMainAndFeature(cwd: string) {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, ".initial"), "initial\n");
    writeFileSync(join(cwd, "src", "existing.ts"), "export const a = 1;\n");
    mkdirSync(join(cwd, "dist"), { recursive: true });
    writeFileSync(join(cwd, "dist", "cli.js"), fakeCliScript);
    execFileSync("git", ["add", ".initial", "src/existing.ts", "dist/cli.js"], {
      cwd,
    });
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
    expect(out).toContain("verify:local: 8 checks passed");
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
    expect(pnpmLog).toContain("exec vitest run");
  });

  it("runs process-control checks when base is unknown and timeout changed", () => {
    mkdirSync(join(repoDir, "src", "lib"), { recursive: true });
    writeFileSync(join(repoDir, "src", "lib", "timeout.ts"), "export {};\n");
    const { out, pnpmLog } = runLocalWithPnpmLog();
    expect(out).toContain("verify:local: scope=fail-safe");
    expect(pnpmLog).toContain("build");
    expect(pnpmLog).toContain("exec vitest run");
    expect(pnpmLog).toContain(
      "exec vitest run --config vitest.integration.config.ts",
    );
  });

  it("uses valueless --changed for unstaged source changes when base resolves", () => {
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });
    initRepoWithMainAndFeature(repoDir);
    writeFileSync(join(repoDir, "src", "existing.ts"), "export const a = 2;\n");

    const { pnpmLog } = runLocalWithPnpmLog();
    expect(pnpmLog).toContain("exec vitest run --changed --passWithNoTests");
    expect(pnpmLog).not.toMatch(/exec vitest run --changed [0-9a-f]{40}/);
  });

  it("runs the changed unit test directly when a test file changes", () => {
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
    expect(pnpmLog).toContain("tests/unit/a.test.ts");
    expect(pnpmLog).not.toContain("exec vitest run --changed");
  });

  it("runs full unit tests for untracked source changes when base resolves", () => {
    rmSync(repoDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });
    initRepoWithMainAndFeature(repoDir);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "untracked.ts"), "export {};\n");

    const { pnpmLog } = runLocalWithPnpmLog();
    const unitLines = pnpmLog
      .split("\n")
      .filter(l => l.startsWith("exec vitest run") && !l.includes("--config"));
    expect(unitLines.length).toBeGreaterThanOrEqual(1);
    expect(unitLines[0]).toMatch(/exec vitest run --reporter=/);
    expect(unitLines[0]).not.toContain("--passWithNoTests");
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
      /exec vitest run --changed [0-9a-f]{40} --passWithNoTests/,
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
      /exec vitest run --changed [0-9a-f]{40} --passWithNoTests/,
    );
    expect(pnpmLog).toContain("exec vitest run --changed --passWithNoTests");
  });
});

describe("buildVerificationPlan selection regression matrix", () => {
  function buildPlanFor(files: string[], mergeBase = "abc123") {
    const scope = classifyChangedFiles(files);
    return buildVerificationPlan({
      scope,
      changeSet: {
        baseFiles: files,
        workingTreeFiles: [],
        untrackedFiles: [],
        indeterminate: false,
      },
      mergeBase,
      baseSha: mergeBase,
      headSha: "def456",
    });
  }

  function stepIds(plan: ReturnType<typeof buildPlanFor>) {
    return plan.steps.map(s => s.id);
  }

  it("docs-only plan stays focused and only checks docs", () => {
    const plan = buildPlanFor(["docs/usage.md"]);
    expect(plan.mode).toBe("focused");
    expect(stepIds(plan)).toEqual(["docs"]);
  });

  it("unknown file falls back to the full suite", () => {
    const plan = buildPlanFor(["foo.bar"]);
    expect(plan.mode).toBe("full");
    expect(stepIds(plan)).toContain("unit");
    expect(stepIds(plan)).toContain("integration-full");
    expect(stepIds(plan)).toContain("version-human");
    expect(stepIds(plan)).toContain("version-json");
  });

  it("shared test infrastructure triggers full suite fallback", () => {
    const plan = buildPlanFor(["tests/helpers/git-repository.ts"]);
    expect(plan.mode).toBe("full");
    expect(stepIds(plan)).toContain("unit");
    expect(stepIds(plan)).toContain("integration-full");
  });

  it("package.json triggers full suite fallback", () => {
    const plan = buildPlanFor(["package.json"]);
    expect(plan.mode).toBe("full");
    expect(stepIds(plan)).toContain("unit");
    expect(stepIds(plan)).toContain("integration-full");
  });

  it("workflow changes run targeted workflow tests without build or integration", () => {
    const plan = buildPlanFor([".github/workflows/ci.yml"]);
    expect(plan.mode).toBe("focused");
    expect(stepIds(plan)).toEqual([
      "supply-chain",
      "typecheck",
      "workflow-tests",
    ]);
    const wf = plan.steps.find(s => s.id === "workflow-tests");
    expect(wf?.command.join(" ")).toContain("ci-workflow.test.ts");
    expect(wf?.command.join(" ")).toContain(
      "check-supply-chain-invariants.test.ts",
    );
  });

  it("process-control changes run targeted unit and integration tests", () => {
    const plan = buildPlanFor(["src/lib/timeout.ts"]);
    expect(plan.mode).toBe("focused");
    expect(stepIds(plan)).toEqual([
      "typecheck",
      "process-control-unit",
      "build",
      "integration-process-control",
    ]);
  });

  it("standard source changes run changed unit tests plus integration smoke", () => {
    const plan = buildPlanFor(["src/commands/init.ts"]);
    expect(plan.mode).toBe("focused");
    expect(stepIds(plan)).toEqual([
      "typecheck",
      "unit-base",
      "build",
      "integration-smoke",
    ]);
  });

  it("single changed integration test runs that file directly", () => {
    const plan = buildPlanFor([
      "tests/integration/task-registration-spec.test.ts",
    ]);
    expect(stepIds(plan)).toEqual(["typecheck", "build", "integration-direct"]);
    const int = plan.steps.find(s => s.id === "integration-direct");
    expect(int?.command.join(" ")).toContain(
      "tests/integration/task-registration-spec.test.ts",
    );
    expect(stepIds(plan)).not.toContain("integration-smoke");
  });

  it("single changed unit test runs that file directly", () => {
    const plan = buildPlanFor([
      "tests/unit/scripts/verification-scope.test.ts",
    ]);
    expect(stepIds(plan)).toEqual(["typecheck", "unit-direct"]);
    const unit = plan.steps.find(s => s.id === "unit-direct");
    expect(unit?.command.join(" ")).toContain(
      "tests/unit/scripts/verification-scope.test.ts",
    );
    expect(stepIds(plan)).not.toContain("build");
    expect(stepIds(plan)).not.toContain("integration-smoke");
  });

  it("vitest integration config change triggers full suite fallback", () => {
    const plan = buildPlanFor(["vitest.integration.config.ts"]);
    expect(plan.mode).toBe("full");
    expect(stepIds(plan)).toContain("integration-full");
  });

  it("pnpm-lock.yaml change triggers full suite fallback", () => {
    const plan = buildPlanFor(["pnpm-lock.yaml"]);
    expect(plan.mode).toBe("full");
    expect(stepIds(plan)).toContain("integration-full");
  });

  it("workflow change runs targeted workflow tests without build", () => {
    const plan = buildPlanFor([".github/workflows/publish.yml"]);
    expect(stepIds(plan)).toEqual([
      "supply-chain",
      "typecheck",
      "workflow-tests",
    ]);
    const wf = plan.steps.find(s => s.id === "workflow-tests");
    expect(wf?.command.join(" ")).toContain("publish-workflow.test.ts");
    expect(wf?.command.join(" ")).toContain(
      "check-supply-chain-invariants.test.ts",
    );
  });
});
