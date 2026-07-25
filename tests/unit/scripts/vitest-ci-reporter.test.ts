import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import VitestCiReporter from "../../../scripts/vitest-ci-reporter.mjs";

describe("VitestCiReporter", () => {
  let logs: string[];
  let errors: string[];

  function rel(moduleId: string) {
    return join(process.cwd(), moduleId);
  }

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });
    vi.spyOn(console, "error").mockImplementation((msg: string) => {
      errors.push(msg);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints total and per-file start/done lines", () => {
    const reporter = new VitestCiReporter();
    reporter.onTestRunStart([{}, {}, {}]);
    reporter.onTestModuleStart({ moduleId: rel("tests/a.test.ts") });
    reporter.onTestModuleEnd({
      moduleId: rel("tests/a.test.ts"),
      state: "pass",
      result: { state: "pass", duration: 1234 },
    });

    expect(logs).toContain("[vitest:total] 3");
    expect(logs).toContain("[vitest:start] tests/a.test.ts");
    expect(
      logs.some(line => line.includes("[vitest:done] tests/a.test.ts")),
    ).toBe(true);
  });

  it("emits concise error diagnostics for failed modules", () => {
    const reporter = new VitestCiReporter();
    reporter.onTestModuleEnd({
      moduleId: rel("tests/b.test.ts"),
      state: "fail",
      result: {
        state: "fail",
        duration: 50,
        errors: [{ message: "assertion failed" }],
      },
    });

    expect(errors).toContain(
      "[vitest:failed] tests/b.test.ts: assertion failed",
    );
  });

  it("emits a failure line even when no error message is present", () => {
    const reporter = new VitestCiReporter();
    reporter.onTestModuleEnd({
      moduleId: rel("tests/c.test.ts"),
      state: "fail",
      result: { state: "fail", duration: 10 },
    });

    expect(errors).toContain("[vitest:failed] tests/c.test.ts");
  });

  it("prints the slowest test files at the end", () => {
    const reporter = new VitestCiReporter();
    reporter.onTestModuleEnd({
      moduleId: rel("tests/slow.test.ts"),
      state: "pass",
      result: { state: "pass", duration: 5000 },
    });
    reporter.onTestModuleEnd({
      moduleId: rel("tests/fast.test.ts"),
      state: "pass",
      result: { state: "pass", duration: 10 },
    });
    reporter.onTestRunEnd([], [], "passed");

    const slowestIndex = logs.findIndex(line =>
      line.includes("Slowest test files:"),
    );
    expect(slowestIndex).toBeGreaterThanOrEqual(0);
    expect(logs[slowestIndex + 1]).toContain("tests/slow.test.ts");
    expect(logs[slowestIndex + 2]).toContain("tests/fast.test.ts");
  });
});
