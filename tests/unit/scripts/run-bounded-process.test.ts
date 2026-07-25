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
        "import { writeSync } from 'node:fs';",
        "import process from 'node:process';",
        "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 100000)'], { stdio: 'ignore' });",
        "child.unref();",
        "writeSync(1, 'parent ' + process.pid + '\\n');",
        "writeSync(1, 'child ' + child.pid + '\\n');",
        "setInterval(()=>{}, 100000);",
      ].join("\n"),
    );

    try {
      const result = await runBoundedProcess({
        command: process.execPath,
        args: [fixture],
        timeoutMs: 500,
        termGraceMs: 100,
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

  it("calls onProgress on output chunks and exposes the child pid", async () => {
    const progressSnapshots: Array<{ ok: boolean; elapsedMs: number }> = [];
    const result = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "console.log('hello'); console.error('world');"],
      timeoutMs: 5_000,
      heartbeatIntervalMs: 25,
      onProgress: (snapshot: { ok: boolean; elapsedMs: number }) => {
        progressSnapshots.push({
          ok: snapshot.ok,
          elapsedMs: snapshot.elapsedMs,
        });
      },
    });

    expect(result.ok).toBe(true);
    expect(typeof result.pid).toBe("number");
    expect(result.pid).toBeGreaterThan(0);
    expect(progressSnapshots.length).toBeGreaterThan(0);
    const last = progressSnapshots[progressSnapshots.length - 1]!;
    expect(last.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("emits periodic heartbeats even when the child is silent", async () => {
    const progressSnapshots: Array<number> = [];
    await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => console.log('done'), 120)"],
      timeoutMs: 5_000,
      heartbeatIntervalMs: 30,
      onProgress: (snapshot: { elapsedMs: number }) => {
        progressSnapshots.push(snapshot.elapsedMs);
      },
    });

    const gaps: number[] = [];
    for (let i = 1; i < progressSnapshots.length; i++) {
      gaps.push(progressSnapshots[i]! - progressSnapshots[i - 1]!);
    }

    const medianGap =
      gaps.length > 0 ? (gaps[Math.floor(gaps.length / 2)] ?? 0) : 0;
    expect(medianGap).toBeGreaterThanOrEqual(25);
    expect(medianGap).toBeLessThan(200);
  });
});
