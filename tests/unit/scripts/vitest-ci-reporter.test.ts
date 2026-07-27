import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import VitestCiReporter from "../../../scripts/vitest-ci-reporter.mjs";
import type { TestErrorLike } from "../../../scripts/vitest-ci-reporter.mjs";

// prefix + bounded context + bounded value, with room for the separator.
const MAX_DIAGNOSTIC_LINE_BYTES = 3072;
// Lifetime and output caps for the nested Vitest child, so a child that hangs
// or floods cannot hold the CI job.
const NESTED_VITEST_TIMEOUT_MS = 60_000;
const NESTED_VITEST_MAX_OUTPUT_BYTES = 1024 * 1024;
const ANSI_CONTROL = /[\u001B\u009B]/;

describe("VitestCiReporter", () => {
  let logs: string[];
  let errors: string[];

  function rel(moduleId: string) {
    return join(process.cwd(), moduleId);
  }

  function failedCase(
    file: string,
    fullName: string,
    caseErrors: TestErrorLike[] = [],
    state = "failed",
  ) {
    return {
      module: { moduleId: rel(file) },
      fullName,
      result: () => ({ state, errors: caseErrors }),
    };
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
      state: "passed",
      result: { state: "passed", duration: 1234 },
    });

    expect(logs).toContain("[vitest:total] 3");
    expect(logs).toContain("[vitest:start] tests/a.test.ts");
    expect(
      logs.some(line => line.includes("[vitest:done] tests/a.test.ts")),
    ).toBe(true);
    expect(errors).toEqual([]);
  });

  it("reports the failed test case, assertion, expected, and actual", () => {
    const reporter = new VitestCiReporter();
    const file = "tests/unit/reporter-repro.test.ts";
    const fullName = "repro > a failing assertion inside a test case";
    reporter.onTestCaseResult(
      failedCase(file, fullName, [
        { message: "expected 2 to be 3", expected: "3", actual: "2" },
      ]),
    );

    const context = `${file} > ${fullName}`;
    expect(errors).toEqual([
      `[vitest:failed] ${context}`,
      `[vitest:assertion] ${context}: expected 2 to be 3`,
      `[vitest:expected] ${context}: 3`,
      `[vitest:actual] ${context}: 2`,
    ]);
  });

  it("keeps the file as the first token of the failed line", () => {
    const reporter = new VitestCiReporter();
    reporter.onTestCaseResult(
      failedCase("tests/unit/a.test.ts", "suite > failed test", [
        { message: "expected 2 to be 3" },
      ]),
    );

    const failedLine = errors.find(line => line.startsWith("[vitest:failed] "));
    expect(failedLine).toBeDefined();
    expect(failedLine?.split(/\s+/)[1]).toBe("tests/unit/a.test.ts");
  });

  it("does not repeat a bare fallback for a module that reported a failed case", () => {
    const reporter = new VitestCiReporter();
    const file = "tests/unit/a.test.ts";
    const fullName = "suite > failed test";
    reporter.onTestCaseResult(
      failedCase(file, fullName, [{ message: "expected 2 to be 3" }]),
    );
    reporter.onTestModuleEnd({
      moduleId: rel(file),
      state: "failed",
      errors: () => [],
      result: { state: "failed", duration: 12 },
    });

    const failedLines = errors.filter(line =>
      line.startsWith("[vitest:failed] "),
    );
    expect(failedLines).toEqual([`[vitest:failed] ${file} > ${fullName}`]);
    expect(errors).not.toContain(`[vitest:failed] ${file}`);
  });

  it("names every failed test case in the same module", () => {
    const reporter = new VitestCiReporter();
    const file = "tests/unit/a.test.ts";
    reporter.onTestCaseResult(
      failedCase(file, "suite > first failure", [{ message: "first" }]),
    );
    reporter.onTestCaseResult(
      failedCase(file, "suite > second failure", [{ message: "second" }]),
    );
    reporter.onTestModuleEnd({
      moduleId: rel(file),
      state: "failed",
      errors: () => [],
      result: { state: "failed", duration: 12 },
    });

    expect(errors).toContain(`[vitest:failed] ${file} > suite > first failure`);
    expect(errors).toContain(`[vitest:failed] ${file} > suite > second failure`);
  });

  it("emits module collection errors when no test case ran", () => {
    const reporter = new VitestCiReporter();
    reporter.onTestModuleEnd({
      moduleId: rel("tests/b.test.ts"),
      state: "failed",
      errors: () => [{ message: "Cannot find module './missing'" }],
      result: { state: "failed", duration: 50 },
    });

    expect(errors).toContain(
      "[vitest:failed] tests/b.test.ts: Cannot find module './missing'",
    );
  });

  it("reads module errors from the legacy result shape and failure state", () => {
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

  it("emits a bare failure line when neither a case nor a module error exists", () => {
    const reporter = new VitestCiReporter();
    reporter.onTestModuleEnd({
      moduleId: rel("tests/c.test.ts"),
      state: "failed",
      errors: () => [],
      result: { state: "failed", duration: 10 },
    });

    expect(errors).toEqual(["[vitest:failed] tests/c.test.ts"]);
  });

  it("ignores retained errors on a passed test case", () => {
    const reporter = new VitestCiReporter();
    reporter.onTestCaseResult(
      failedCase(
        "tests/unit/a.test.ts",
        "suite > flaky test",
        [{ message: "expected 2 to be 3" }],
        "passed",
      ),
    );

    expect(errors).toEqual([]);
  });

  it("reports comparison properties whose value is undefined", () => {
    const reporter = new VitestCiReporter();
    const file = "tests/unit/undefined.test.ts";
    const fullName = "suite > undefined comparison";
    reporter.onTestCaseResult(
      failedCase(file, fullName, [
        {
          message: "expected undefined to be defined",
          expected: "defined",
          actual: undefined,
        },
      ]),
    );

    const context = `${file} > ${fullName}`;
    expect(errors).toContain(`[vitest:expected] ${context}: defined`);
    expect(errors).toContain(`[vitest:actual] ${context}: undefined`);
  });

  it("omits comparison lines when the property is absent", () => {
    const reporter = new VitestCiReporter();
    reporter.onTestCaseResult(
      failedCase("tests/unit/a.test.ts", "suite > plain failure", [
        { message: "plain error" },
      ]),
    );

    expect(errors).toEqual([
      "[vitest:failed] tests/unit/a.test.ts > suite > plain failure",
      "[vitest:assertion] tests/unit/a.test.ts > suite > plain failure: plain error",
    ]);
  });

  it("survives a comparison accessor that throws", () => {
    const reporter = new VitestCiReporter();
    const file = "tests/unit/a.test.ts";
    const fullName = "suite > throwing accessor";
    const error = {
      message: "comparison getter failed",
      get actual() {
        throw new Error("do not propagate");
      },
    };

    expect(() =>
      reporter.onTestCaseResult(failedCase(file, fullName, [error])),
    ).not.toThrow();

    expect(errors).toContain(
      `[vitest:actual] ${file} > ${fullName}: <unreadable value>`,
    );
  });

  it("bounds diagnostics to single lines without control sequences", () => {
    const reporter = new VitestCiReporter();
    const circular: Record<string, unknown> = { name: "cycle" };
    circular.self = circular;
    const deep = { a: { b: { c: { d: { e: { f: "too deep" } } } } } };

    expect(() =>
      reporter.onTestCaseResult(
        failedCase("tests/unit/a.test.ts", "suite > noisy failure", [
          {
            message: `\u001B[31mexpected\u001B[0m\nsecond line\twith tab`,
            expected: Array.from({ length: 500 }, (_, i) => i),
            actual: circular,
          },
          { message: "x".repeat(10_000), expected: deep, actual: null },
          { message: "third", expected: 1, actual: 2 },
          { message: "fourth" },
          { message: "fifth" },
        ]),
      ),
    ).not.toThrow();

    for (const line of errors) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(
        MAX_DIAGNOSTIC_LINE_BYTES,
      );
      expect(line).not.toMatch(/[\r\n]/);
      expect(line).not.toMatch(ANSI_CONTROL);
    }
    expect(
      errors.some(line => line.includes("expected\\nsecond line\\twith tab")),
    ).toBe(true);
    expect(errors).toContain(
      "[vitest:truncated] tests/unit/a.test.ts > suite > noisy failure: 2 additional errors omitted",
    );
  });

  it("prints the slowest test files at the end", () => {
    const reporter = new VitestCiReporter();
    reporter.onTestModuleEnd({
      moduleId: rel("tests/slow.test.ts"),
      state: "passed",
      result: { state: "passed", duration: 5000 },
    });
    reporter.onTestModuleEnd({
      moduleId: rel("tests/fast.test.ts"),
      state: "passed",
      result: { state: "passed", duration: 10 },
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

describe("VitestCiReporter against a real Vitest run", () => {
  function resolveVitestBin() {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve("vitest/package.json");
    const packageJson = require("vitest/package.json") as {
      bin?: string | Record<string, string>;
    };
    const bin =
      typeof packageJson.bin === "string"
        ? packageJson.bin
        : packageJson.bin?.vitest;
    if (!bin) throw new Error("vitest package declares no bin entry");
    return resolve(dirname(packagePath), bin);
  }

  it("reports the failing assertion of a real test case", () => {
    const reporterPath = fileURLToPath(
      new URL("../../../scripts/vitest-ci-reporter.mjs", import.meta.url),
    );
    const workDir = mkdtempSync(join(tmpdir(), "vitest-ci-reporter-"));
    try {
      writeFileSync(
        join(workDir, "reporter-repro.test.ts"),
        [
          'describe("repro", () => {',
          '  it("a failing assertion inside a test case", () => {',
          "    expect(1 + 1).toBe(3);",
          "  });",
          '  it("reports undefined as the actual value", () => {',
          '    expect(undefined).toBe("defined");',
          "  });",
          "});",
          "",
        ].join("\n"),
      );

      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith("VITEST")) delete env[key];
      }

      const result = spawnSync(
        process.execPath,
        [
          resolveVitestBin(),
          "run",
          "--root",
          workDir,
          "--globals",
          "reporter-repro.test.ts",
          `--reporter=${reporterPath}`,
        ],
        {
          encoding: "utf8",
          env,
          // spawnSync blocks the event loop, so the surrounding Vitest timeout
          // cannot interrupt a child that never exits. These caps are the
          // hang-safety boundary for that child — not a speed assertion.
          timeout: NESTED_VITEST_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: NESTED_VITEST_MAX_OUTPUT_BYTES,
          windowsHide: true,
        },
      );

      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).not.toBe(0);
      expect(output).toMatch(/\[vitest:done\] .*failed/);
      expect(output).toMatch(
        /\[vitest:failed\] \S*reporter-repro\.test\.ts > repro > a failing assertion inside a test case/,
      );
      expect(output).toMatch(
        /\[vitest:assertion\] \S*reporter-repro\.test\.ts > repro > a failing assertion inside a test case: expected 2 to be 3/,
      );
      expect(output).toMatch(/\[vitest:expected\] .*: 3$/m);
      expect(output).toMatch(/\[vitest:actual\] .*: 2$/m);

      const undefinedCase =
        /reporter-repro\.test\.ts > repro > reports undefined as the actual value/;
      expect(output).toMatch(
        new RegExp(`\\[vitest:failed\\] \\S*${undefinedCase.source}`),
      );
      expect(output).toMatch(
        new RegExp(`\\[vitest:assertion\\] \\S*${undefinedCase.source}:`),
      );
      expect(output).toMatch(
        new RegExp(`\\[vitest:expected\\] \\S*${undefinedCase.source}: .*defined`),
      );
      expect(output).toMatch(
        new RegExp(`\\[vitest:actual\\] \\S*${undefinedCase.source}: undefined$`, "m"),
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 120_000);
});
