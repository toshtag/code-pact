import { describe, it, expect } from "vitest";
import { classifyChangedFiles } from "../../../scripts/verification-scope.mjs";

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
    const result = classifyChangedFiles(["src/contracts/plan-capture-details.ts"]);
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
    const result = classifyChangedFiles(["src/core/process/bounded-command.ts"]);
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
    const result = classifyChangedFiles(["docs/usage.md", "src/commands/init.ts"]);
    expect(result.docs).toBe(true);
    expect(result.standard).toBe(true);
    expect(result.reason).toBe("docs+standard");
  });

  it("combines toolchain and standard without duplicating standard in reason", () => {
    const result = classifyChangedFiles(["package.json", "src/commands/init.ts"]);
    expect(result.toolchain).toBe(true);
    expect(result.standard).toBe(true);
    expect(result.reason).toBe("toolchain");
  });

  it("combines process-control and standard without duplicating standard in reason", () => {
    const result = classifyChangedFiles(["src/lib/timeout.ts", "src/commands/init.ts"]);
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
    const result = classifyChangedFiles(["src/commands/init.ts", "src/commands/init.ts"]);
    expect(result.changedFiles).toEqual(["src/commands/init.ts", "src/commands/init.ts"]);
  });
});
