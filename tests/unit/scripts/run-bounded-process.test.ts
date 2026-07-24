import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error .mjs scripts are not included in tsconfig and are imported as untyped modules across the test suite.
import { runBoundedProcess } from "../../../scripts/lib/run-bounded-process.mjs";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runBoundedProcess", () => {
  it("succeeds when the command exits 0", async () => {
    const result = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "console.log('ok')"],
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("ok");
    expect(result.signal).toBeNull();
  });

  it("fails and reports the exit code when the command exits non-zero", async () => {
    const result = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "console.error('err'); process.exit(42)"],
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("err");
  });

  it("times out and kills the entire process tree", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rbp-tree-test-"));
    const fixture = join(tmpDir, "fixture.mjs");
    writeFileSync(
      fixture,
      [
        "import { spawn } from 'node:child_process';",
        "import process from 'node:process';",
        "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 100000)'], { stdio: 'ignore' });",
        "child.unref();",
        "console.log('parent ' + process.pid);",
        "console.log('child ' + child.pid);",
        "setInterval(()=>{}, 100000);",
      ].join("\n"),
    );

    try {
      const result = await runBoundedProcess({
        command: process.execPath,
        args: [fixture],
        timeoutMs: 100,
        termGraceMs: 50,
      });

      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(["SIGTERM", "SIGKILL"]).toContain(result.signal);

      const parentMatch = /parent (\d+)/.exec(result.stdout);
      const childMatch = /child (\d+)/.exec(result.stdout);
      expect(parentMatch).not.toBeNull();
      expect(childMatch).not.toBeNull();

      const parentPid = Number(parentMatch![1]);
      const childPid = Number(childMatch![1]);
      expect(isProcessAlive(parentPid)).toBe(false);
      expect(isProcessAlive(childPid)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("enforces the stdout/stderr size limit and reports output exceeded", async () => {
    const result = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('a'.repeat(2 * 1024 * 1024))"],
      timeoutMs: 5_000,
      maxOutputBytes: 1_000,
    });

    expect(result.ok).toBe(false);
    expect(result.stdout.length).toBeLessThanOrEqual(1_000);
    expect(result.stderr).toContain("max output exceeded");
  });
});
